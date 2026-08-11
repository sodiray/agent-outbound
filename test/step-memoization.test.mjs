import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeEnrichmentStepOnRecords } from '../dist/orchestrator/enrichment/runner.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { normalizeConfig } from '../dist/schemas/config.js';

const listDir = () => mkdtempSync(join(tmpdir(), 'agent-outbound-step-memoization-'));

const memoizedStep = (overrides = {}) => ({
  kind: 'enrich',
  id: 'expensive_lookup',
  inputs: {
    lookup_subject: { from: 'website' },
    lookup_mode: { value: 'primary' },
  },
  outputs: {
    lookup_result: { type: 'string', description: 'Settled lookup result.' },
  },
  memoize: {},
  ...overrides,
});

const currentRecord = (db) => db.prepare('SELECT * FROM records WHERE _row_id = ?').get('memoization-record');

const withDb = async (callback) => {
  const root = listDir();
  const db = openListDb({ listDir: root, readonly: false });
  ensureRecordColumns({ db, columns: ['website', 'lookup_result'] });
  upsertRecord({ db, row: { _row_id: 'memoization-record', business_name: 'Memo Inc.', website: 'https://one.example' } });
  try {
    return await callback({ db, root });
  } finally {
    db.close();
  }
};

const execute = ({ db, root, step, executeAction, force = false }) => executeEnrichmentStepOnRecords({
  db,
  listDir: root,
  config: { ai: {} },
  mcp: null,
  toolCatalog: null,
  step,
  rows: [currentRecord(db)],
  executeAction,
  force,
});

test('memoized enrich steps call their provider once and replay identical outputs for unchanged resolved inputs', async () => {
  let providerCalls = 0;
  const executeAction = async ({ record }) => {
    providerCalls += 1;
    return { outputs: { lookup_result: `result:${record.website}` }, usage: {} };
  };

  await withDb(async ({ db, root }) => {
    const step = memoizedStep();
    const first = await execute({ db, root, step, executeAction });
    const firstOutput = currentRecord(db).lookup_result;
    const second = await execute({ db, root, step, executeAction });

    assert.equal(first.processed, 1);
    assert.equal(second.memoization_hits, 1);
    assert.equal(second.non_execution_reasons['memoization-record'], 'memoization_hit');
    assert.equal(providerCalls, 1);
    assert.equal(currentRecord(db).lookup_result, firstOutput);

    const forced = await execute({ db, root, step, executeAction, force: true });
    assert.equal(forced.processed, 1);
    assert.equal(providerCalls, 2, '--force bypasses a memoized result');
  });
});

test('memoized enrich steps invalidate when a declared input changes', async () => {
  let providerCalls = 0;
  const executeAction = async ({ record }) => {
    providerCalls += 1;
    return { outputs: { lookup_result: `result:${record.website}` }, usage: {} };
  };

  await withDb(async ({ db, root }) => {
    const step = memoizedStep();
    await execute({ db, root, step, executeAction });
    upsertRecord({ db, row: { ...currentRecord(db), website: 'https://two.example' } });
    const second = await execute({ db, root, step, executeAction });

    assert.equal(second.processed, 1);
    assert.equal(providerCalls, 2);
    assert.equal(currentRecord(db).lookup_result, 'result:https://two.example');
  });
});

test('memoized enrich steps never cache provider errors', async () => {
  let providerCalls = 0;
  const executeAction = async () => {
    providerCalls += 1;
    throw new Error('temporary provider outage');
  };

  await withDb(async ({ db, root }) => {
    const step = memoizedStep();
    const first = await execute({ db, root, step, executeAction });
    const callsAfterFirstRun = providerCalls;
    const second = await execute({ db, root, step, executeAction });

    assert.equal(first.failed, 1);
    assert.equal(second.failed, 1);
    assert.ok(providerCalls > callsAfterFirstRun, 'the next run must call the provider again');
    assert.equal(db.prepare('SELECT 1 FROM staleness WHERE record_id = ? AND step_id = ?')
      .get('memoization-record', step.id), undefined);
  });
});

test('memoization config rejects unknown keys', () => {
  const valid = normalizeConfig({ pipeline: [memoizedStep({ memoize: { ttl_days: 30 } })] });
  const invalid = normalizeConfig({ pipeline: [memoizedStep({ memoize: { ttl_dyas: 30 } })] });

  assert.deepEqual(valid.errors, []);
  assert.ok(invalid.errors.length > 0);
  assert.match(invalid.error, /ttl_dyas|Unrecognized key/i);
});
