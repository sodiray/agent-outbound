/**
 * Canary isolation — pure policy surface.
 *
 * Covers:
 * - off mode allows all (no-op)
 * - canary mode blocks non-allowlisted records
 * - strict mode with empty allowlist blocks all mutations
 * - filterRecordsForCanary scopes rows to allowlisted ids
 * - list gate requires allowlist name or local canary marker
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadCanaryConfig,
  assertCanaryAllowsRecord,
  assertCanaryAllowsList,
  assertListAccessForMutation,
  assertRecordAccessForMutation,
  filterRecordsForCanary,
  hasCanaryMarker,
} from '../dist/orchestrator/policy/canary-isolation.js';
import { AgentOutboundError } from '../dist/orchestrator/runtime/contract.js';

const withEnv = (pairs, fn) => {
  const previous = {};
  for (const key of Object.keys(pairs)) {
    previous[key] = process.env[key];
    const value = pairs[key];
    if (value == null || value === '') delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(pairs)) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
};

const tempList = (name = 'canary-list') => {
  const dir = mkdtempSync(join(tmpdir(), `ao-canary-${name}-`));
  mkdirSync(join(dir, '.outbound'), { recursive: true });
  return dir;
};

test('off mode allows all records and lists (default)', () => {
  withEnv({
    AO_CANARY_MODE: '',
    AO_CANARY_ALLOWLIST: '',
    AO_CANARY_LISTS: '',
    AO_CANARY_NAMESPACE: '',
  }, () => {
    const config = loadCanaryConfig({ env: {} });
    assert.equal(config.mode, 'off');
    assert.deepEqual(config.allowlist_record_ids, []);

    assert.doesNotThrow(() => assertCanaryAllowsRecord({
      config,
      recordId: 'any-record',
    }));
    assert.doesNotThrow(() => assertCanaryAllowsList({
      config,
      listName: 'prod-dirty',
      listDir: '/tmp/does-not-need-to-exist',
    }));

    const rows = [
      { _row_id: 'a' },
      { _row_id: 'b' },
    ];
    assert.deepEqual(filterRecordsForCanary(rows, config), rows);
  });
});

test('canary mode blocks non-allowlisted record', () => {
  const config = loadCanaryConfig({
    env: {
      AO_CANARY_MODE: 'canary',
      AO_CANARY_ALLOWLIST: 'rec_ok,rec_also',
      AO_CANARY_LISTS: '',
    },
  });
  assert.equal(config.mode, 'canary');
  assert.deepEqual(config.allowlist_record_ids, ['rec_ok', 'rec_also']);

  assert.doesNotThrow(() => assertCanaryAllowsRecord({
    config,
    recordId: 'rec_ok',
  }));

  assert.throws(
    () => assertCanaryAllowsRecord({ config, recordId: 'rec_blocked' }),
    (err) => {
      assert.ok(err instanceof AgentOutboundError);
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, /canary isolation blocked record/i);
      assert.equal(err.fields?.record_id, 'rec_blocked');
      return true;
    },
  );
});

test('strict mode with empty allowlist blocks all mutations', () => {
  const config = loadCanaryConfig({
    env: {
      AO_CANARY_MODE: 'strict',
      AO_CANARY_ALLOWLIST: '',
      AO_CANARY_LISTS: 'tv',
    },
  });
  assert.equal(config.mode, 'strict');
  assert.deepEqual(config.allowlist_record_ids, []);

  assert.throws(
    () => assertCanaryAllowsRecord({ config, recordId: 'anything' }),
    (err) => {
      assert.ok(err instanceof AgentOutboundError);
      assert.match(err.message, /strict mode refuses mutations/i);
      return true;
    },
  );

  assert.throws(
    () => assertCanaryAllowsList({
      config,
      listName: 'tv',
      listDir: '/tmp/tv',
    }),
    (err) => {
      assert.ok(err instanceof AgentOutboundError);
      assert.match(err.message, /strict mode refuses mutations/i);
      return true;
    },
  );

  assert.deepEqual(
    filterRecordsForCanary([{ _row_id: 'a' }, { _row_id: 'b' }], config),
    [],
  );
});

test('filterRecordsForCanary keeps only allowlisted ids', () => {
  const config = loadCanaryConfig({
    env: {
      AO_CANARY_MODE: 'canary',
      AO_CANARY_ALLOWLIST: 'keep_1,keep_2',
    },
  });
  const rows = [
    { _row_id: 'keep_1', name: 'A' },
    { id: 'noise', name: 'B' },
    { _row_id: 'keep_2', name: 'C' },
    { _row_id: 'keep_3', name: 'D' },
  ];
  const filtered = filterRecordsForCanary(rows, config);
  assert.equal(filtered.length, 2);
  assert.deepEqual(filtered.map((r) => r._row_id || r.id), ['keep_1', 'keep_2']);
});

test('list access allowed via allowlist list name', () => {
  withEnv({
    AO_CANARY_MODE: 'canary',
    AO_CANARY_ALLOWLIST: 'rec_1',
    AO_CANARY_LISTS: 'canary-tv,sandbox',
    AO_CANARY_NAMESPACE: '',
  }, () => {
    const dir = tempList('named');
    try {
      // Directory basename is random — assert with explicit listName.
      const config = loadCanaryConfig({ listDir: dir });
      assert.doesNotThrow(() => assertCanaryAllowsList({
        config,
        listName: 'canary-tv',
        listDir: dir,
      }));
      assert.throws(
        () => assertCanaryAllowsList({
          config,
          listName: 'prod-dirty',
          listDir: dir,
        }),
        (err) => {
          assert.ok(err instanceof AgentOutboundError);
          assert.match(err.message, /blocked list/i);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('list access allowed via local .outbound/canary.json marker', () => {
  withEnv({
    AO_CANARY_MODE: 'canary',
    AO_CANARY_ALLOWLIST: 'local_rec',
    AO_CANARY_LISTS: '',
    AO_CANARY_NAMESPACE: '',
  }, () => {
    const dir = tempList('local-marker');
    try {
      writeFileSync(
        join(dir, '.outbound', 'canary.json'),
        JSON.stringify({
          mode: 'canary',
          // Env owns allowlist — list-local cannot expand to 'extra'.
          allowlist_record_ids: ['local_rec', 'extra'],
        }),
      );
      assert.equal(hasCanaryMarker(dir), true);
      const config = loadCanaryConfig({ listDir: dir });
      assert.ok(config.allowlist_record_ids.includes('local_rec'));
      assert.ok(
        !config.allowlist_record_ids.includes('extra'),
        'env-owned allowlist must not be expanded by list-local',
      );
      assert.doesNotThrow(() => assertListAccessForMutation(dir));
      assert.doesNotThrow(() => assertRecordAccessForMutation({
        listDir: dir,
        recordId: 'local_rec',
      }));
      assert.throws(
        () => assertRecordAccessForMutation({ listDir: dir, recordId: 'not_listed' }),
        (err) => err instanceof AgentOutboundError,
      );
      assert.throws(
        () => assertRecordAccessForMutation({ listDir: dir, recordId: 'extra' }),
        (err) => err instanceof AgentOutboundError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('list-local canary.yaml cannot expand env allowlist (intersection only)', () => {
  withEnv({
    AO_CANARY_MODE: 'canary',
    AO_CANARY_ALLOWLIST: 'from_env',
    AO_CANARY_LISTS: '',
    AO_CANARY_NAMESPACE: 'canary-ns',
  }, () => {
    const dir = tempList('yaml-merge');
    try {
      writeFileSync(
        join(dir, 'canary.yaml'),
        ['mode: canary', 'allowlist_record_ids:', '  - from_file', '  - from_env', 'namespace: canary-ns'].join('\n'),
      );
      const config = loadCanaryConfig({ listDir: dir });
      assert.equal(config.mode, 'canary');
      assert.ok(config.allowlist_record_ids.includes('from_env'));
      assert.ok(
        !config.allowlist_record_ids.includes('from_file'),
        'list-local cannot add ids outside env allowlist',
      );
      assert.equal(config.namespace, 'canary-ns');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('assertListAccessForMutation is no-op when mode is off', () => {
  withEnv({
    AO_CANARY_MODE: 'off',
    AO_CANARY_ALLOWLIST: '',
    AO_CANARY_LISTS: '',
  }, () => {
    const dir = tempList('off-mode');
    try {
      const config = assertListAccessForMutation(dir);
      assert.equal(config.mode, 'off');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
