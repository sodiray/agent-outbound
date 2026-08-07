import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runGenerateStep } from '../dist/orchestrator/generate/runner.js';
import { ensureRecordColumns, openListDb } from '../dist/orchestrator/runtime/db.js';

const runnerPath = join(process.cwd(), 'src/orchestrator/generate/runner.ts');

test('generate retains enrichment dependency freshness wiring', () => {
  const source = readFileSync(runnerPath, 'utf8');
  assert.ok(source.includes('dependencyFieldsForStep(stepConfig)'));
  assert.ok(source.includes('isEnrichFresh({ cached, stepConfig, depValues, force })'));
  assert.ok(source.includes('writeStaleness({'));
});

test('diagnostic content freshness includes its sanitized business evidence', () => {
  const source = readFileSync(runnerPath, 'utf8');
  assert.ok(source.includes('diagnostic_business_evidence: buildDiagnosticContentModelContext({ record }).data'));
});

test('generate persists diagnostic preliminary_snapshot through declared output schema', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-generate-output-'));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const fixtureBefore = process.env.AO_STEP_FIXTURE;
  try {
    ensureRecordColumns({ db, columns: [{ name: 'site_text', type: 'TEXT' }] });
    db.prepare(`
      INSERT INTO records (
        _row_id, business_name, site_text, sequence_name, sequence_status,
        _created_at, _updated_at, created_at, updated_at
      ) VALUES ('acct_generate_snapshot', 'Peak HVAC', 'Commercial HVAC maintenance and emergency repair.', 'default', 'idle', ?, ?, ?, ?)
    `).run(now, now, now, now);
    process.env.AO_STEP_FIXTURE = '1';
    const row = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('acct_generate_snapshot');
    const summary = await runGenerateStep({
      db,
      listDir,
      config: { ai: {} },
      stepId: 'diagnostic_content_pack',
      step: {
        id: 'diagnostic_content_pack',
        kind: 'generate',
        outputs: {
          preliminary_snapshot: { type: 'string' },
        },
      },
      rows: [row],
    });
    assert.equal(summary.failed, 0);
    const persisted = db.prepare('SELECT preliminary_snapshot FROM records WHERE _row_id = ?').get('acct_generate_snapshot');
    assert.equal(persisted.preliminary_snapshot, 'fixture_preliminary_snapshot');
  } finally {
    if (fixtureBefore === undefined) delete process.env.AO_STEP_FIXTURE;
    else process.env.AO_STEP_FIXTURE = fixtureBefore;
    db.close();
  }
});

test('diagnostic content refuses records with no business evidence', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-generate-empty-'));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const fixtureBefore = process.env.AO_STEP_FIXTURE;
  try {
    db.prepare(`
      INSERT INTO records (
        _row_id, business_name, sequence_name, sequence_status,
        _created_at, _updated_at, created_at, updated_at
      ) VALUES ('acct_generate_empty', 'Mavericks Property Maintenance', 'default', 'idle', ?, ?, ?, ?)
    `).run(now, now, now, now);
    process.env.AO_STEP_FIXTURE = '1';
    const row = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('acct_generate_empty');
    const summary = await runGenerateStep({
      db,
      listDir,
      config: { ai: {} },
      stepId: 'diagnostic_content_pack',
      step: {
        id: 'diagnostic_content_pack',
        kind: 'generate',
        outputs: {
          preliminary_snapshot: { type: 'string' },
        },
      },
      rows: [row],
    });
    assert.equal(summary.failed, 0);
    const record = db.prepare('SELECT preliminary_snapshot, score_status FROM records WHERE _row_id = ?').get('acct_generate_empty');
    const asset = db.prepare('SELECT status, reason, result FROM assets WHERE row_id = ? AND step_id = ?').get('acct_generate_empty', 'diagnostic_content_pack');
    assert.equal(record.preliminary_snapshot, '');
    assert.equal(record.score_status, 'needs_discovery');
    assert.equal(asset.status, 'empty');
    assert.equal(asset.result, '');
    assert.equal(asset.reason, 'needs_discovery: no_business_evidence');
  } finally {
    if (fixtureBefore === undefined) delete process.env.AO_STEP_FIXTURE;
    else process.env.AO_STEP_FIXTURE = fixtureBefore;
    db.close();
  }
});
