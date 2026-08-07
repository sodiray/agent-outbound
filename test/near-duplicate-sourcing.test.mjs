import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { duplicatesBreakCommand, duplicatesListCommand } from '../dist/commands/index.js';
import { openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import {
  findNearDuplicateMatch,
  nameSimilarity,
} from '../dist/orchestrator/sourcing/near-duplicate.js';
import { processAndInsertRows } from '../dist/orchestrator/sourcing/runner.js';
import { normalizeConfig } from '../dist/schemas/config.js';

const nearDuplicateConfig = {
  enabled: true,
  name_similarity_threshold: 0.9,
  signals: [
    'name_and_address',
    'name_and_domain',
    'shared_phone',
    'shared_domain',
    'person_at_shared_address_or_domain',
  ],
};

test('near duplicate: near-identical names at the same address are flagged', () => {
  const match = findNearDuplicateMatch({
    row: {
      _row_id: 'incoming',
      business_name: 'Resilient Pathways, LLC',
      address: '750 W Ustick Rd Ste 120, Meridian, ID 83646, USA',
    },
    candidates: [{
      _row_id: 'canonical',
      business_name: 'Resilient Pathways',
      address: '750 W Ustick Rd #120, Meridian, ID 83646, USA',
    }],
    config: nearDuplicateConfig,
  });

  assert.equal(match?.candidate._row_id, 'canonical');
  assert.ok(match?.signals.includes('name_and_address'));
  assert.equal(nameSimilarity('Resilient Pathways, LLC', 'Resilient Pathways'), 1);
});

test('near duplicate: separate businesses at one office address are not flagged', () => {
  const match = findNearDuplicateMatch({
    row: {
      _row_id: 'incoming',
      business_name: 'Canopy Behavioral Health',
      address: '750 W Ustick Rd #120, Meridian, ID 83646, USA',
    },
    candidates: [{
      _row_id: 'canonical',
      business_name: 'Rooted Counseling',
      address: '750 W Ustick Rd #120, Meridian, ID 83646, USA',
    }],
    config: nearDuplicateConfig,
  });

  assert.equal(match, null);
});

test('near duplicate: same-name businesses in different cities are not flagged', () => {
  const match = findNearDuplicateMatch({
    row: {
      _row_id: 'incoming',
      business_name: 'Northstar Services LLC',
      address: '10 Main St, Boise, ID 83702, USA',
    },
    candidates: [{
      _row_id: 'canonical',
      business_name: 'Northstar Services',
      address: '10 Main St, Nampa, ID 83651, USA',
    }],
    config: nearDuplicateConfig,
  });

  assert.equal(match, null);
});

test('near duplicate: a named person alongside an organization is flagged only with a shared location', () => {
  const match = findNearDuplicateMatch({
    row: {
      _row_id: 'incoming',
      business_name: 'Borron Brookney R',
      address: '790 W Ustick Rd Ste 110, Meridian, ID 83646, USA',
    },
    candidates: [{
      _row_id: 'canonical',
      business_name: 'Borron Family Medicine PLLC',
      address: '790 W Ustick Rd Ste 110, Meridian, ID 83646, USA',
    }],
    config: nearDuplicateConfig,
  });

  assert.equal(match?.candidate._row_id, 'canonical');
  assert.deepEqual(match?.signals, ['person_at_shared_address_or_domain']);
});

test('near duplicate: flagged records are visible and the existing break command reverses them', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'agent-outbound-near-duplicate-'));
  const db = openListDb({ listDir, readonly: false });
  try {
    upsertRecord({
      db,
      row: {
        _row_id: 'canonical',
        id: 'canonical',
        business_name: 'Resilient Pathways',
        address: '750 W Ustick Rd #120, Meridian, ID 83646, USA',
        phone: '(208) 908-6320',
      },
    });
    const result = await processAndInsertRows({
      db,
      rows: [{
        _row_id: 'incoming',
        id: 'incoming',
        business_name: 'Resilient Pathways, LLC',
        address: '750 W Ustick Rd Ste 120, Meridian, ID 83646, USA',
        phone: '(208) 908-6320',
      }],
      identityFields: ['business_name', 'address'],
      listName: 'near-duplicate-test',
      listDir,
      aiConfig: {},
      nearDuplicate: nearDuplicateConfig,
    });
    assert.deepEqual(result.insertedIds, ['incoming']);
    assert.equal(result.deduped, 1);
  } finally {
    db.close();
  }

  try {
    const queue = duplicatesListCommand({ list: listDir });
    assert.equal(queue.count, 1);
    assert.equal(queue.rows[0].duplicate_of, 'canonical');
    assert.match(queue.rows[0].duplicate_reason, /name_and_address/);

    const broken = duplicatesBreakCommand({ list: listDir, rowId: 'incoming' });
    assert.equal(broken.status, 'unlinked');

    const reopened = openListDb({ listDir, readonly: true });
    try {
      const record = reopened.prepare('SELECT duplicate_of, duplicate_status, duplicate_reason FROM records WHERE _row_id = ?').get('incoming');
      assert.deepEqual(record, { duplicate_of: '', duplicate_status: '', duplicate_reason: '' });
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(listDir, { recursive: true, force: true });
  }
});

test('near duplicate: defaults preserve exact-key-only behavior', () => {
  const noConfig = normalizeConfig({}).config;
  const config = normalizeConfig({ source: { near_duplicate: {} } }).config.source.near_duplicate;
  const match = findNearDuplicateMatch({
    row: {
      _row_id: 'incoming',
      business_name: 'Resilient Pathways, LLC',
      address: '750 W Ustick Rd Ste 120, Meridian, ID 83646, USA',
    },
    candidates: [{
      _row_id: 'canonical',
      business_name: 'Resilient Pathways',
      address: '750 W Ustick Rd #120, Meridian, ID 83646, USA',
    }],
    config,
  });

  assert.deepEqual(config, {
    enabled: false,
    signals: [],
    name_similarity_threshold: 1,
  });
  assert.equal(noConfig.source?.near_duplicate, undefined);
  assert.equal(match, null);
});
