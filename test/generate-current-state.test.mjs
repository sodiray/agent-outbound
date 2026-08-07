import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runGenerateStep } from '../dist/orchestrator/generate/runner.js';
import { ensureRecordColumns, openListDb } from '../dist/orchestrator/runtime/db.js';

const dependencyStep = {
  id: 'dependency_freshness',
  kind: 'generate',
  depends_on: ['vertical'],
  outputs: {
    vertical: { type: 'string' },
  },
};

test('generate refreshes declared dependencies from current record state', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-generate-current-state-'));
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: ['vertical'] });
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, vertical,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, 'Current State HVAC', 'default', 'active', ?, ?, ?, ?, ?)
  `).run('current_state_1', 'fixture_vertical', now, now, now, now);
  const staleRows = db.prepare('SELECT * FROM records WHERE _row_id = ?').all('current_state_1');
  const previousFixture = process.env.AO_STEP_FIXTURE;
  process.env.AO_STEP_FIXTURE = '1';

  try {
    const first = await runGenerateStep({
      db,
      listDir,
      config: {},
      step: dependencyStep,
      rows: staleRows,
    });
    assert.equal(first.processed, 1);
    const firstAsset = db.prepare(
      'SELECT outputs_json FROM assets WHERE row_id = ? AND step_id = ?',
    ).get('current_state_1', 'dependency_freshness');
    assert.equal(JSON.parse(firstAsset.outputs_json).vertical, 'fixture_vertical');

    db.prepare('UPDATE records SET vertical = ? WHERE _row_id = ?').run(
      'trades_field_services',
      'current_state_1',
    );
    const second = await runGenerateStep({
      db,
      listDir,
      config: {},
      step: dependencyStep,
      rows: staleRows,
    });
    assert.equal(second.updated, 1);
    const secondAsset = db.prepare(
      'SELECT outputs_json FROM assets WHERE row_id = ? AND step_id = ?',
    ).get('current_state_1', 'dependency_freshness');
    assert.equal(JSON.parse(secondAsset.outputs_json).vertical, 'trades_field_services');
  } finally {
    if (previousFixture === undefined) delete process.env.AO_STEP_FIXTURE;
    else process.env.AO_STEP_FIXTURE = previousFixture;
    db.close();
  }
});
