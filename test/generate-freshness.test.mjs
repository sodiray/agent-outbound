import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { modelContextForStep } from '../dist/orchestrator/actions/execute-step/index.js';
import { runGenerateStep } from '../dist/orchestrator/generate/runner.js';
import { ensureRecordColumns, openListDb } from '../dist/orchestrator/runtime/db.js';
import { normalizeConfig } from '../dist/schemas/config.js';

test('pipeline config rejects the retired business-evidence projection', () => {
  const normalized = normalizeConfig({
    pipeline: [{
      kind: 'generate',
      id: 'market_content',
      inputs: ['site_text'],
      context_projection: 'business_evidence',
      requires_evidence: true,
    }],
  });
  assert.match(normalized.error, /context_projection is replaced by declared inputs/i);
});

test('a model stage receives only its declared evidence context', () => {
  const record = {
    business_name: 'Peak HVAC',
    site_text: 'Commercial HVAC maintenance and emergency repair.',
    fit_score: 88,
  };
  const declared = modelContextForStep({
    record,
    stepConfig: { inputs: ['site_text'] },
  });
  const defaultContext = modelContextForStep({
    record,
    stepConfig: {},
  });

  assert.equal(declared.data.site_text, record.site_text);
  assert.equal(declared.data.fit_score, undefined);
  assert.equal(defaultContext.data.site_text, undefined);
});

test('an arbitrary evidence-gated step persists declared outputs', async () => {
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
      stepId: 'content_for_any_market',
      step: {
        id: 'content_for_any_market',
        kind: 'generate',
        inputs: ['site_text'],
        requires_evidence: true,
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

test('an arbitrary evidence-gated step refuses records with no business evidence', async () => {
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
      stepId: 'content_for_any_market',
      step: {
        id: 'content_for_any_market',
        kind: 'generate',
        requires_evidence: true,
        on_error: 'empty',
        outputs: {
          preliminary_snapshot: { type: 'string' },
        },
      },
      rows: [row],
    });
    assert.equal(summary.failed, 0);
    const record = db.prepare('SELECT preliminary_snapshot, score_status FROM records WHERE _row_id = ?').get('acct_generate_empty');
    const asset = db.prepare('SELECT status, reason, result FROM assets WHERE row_id = ? AND step_id = ?').get('acct_generate_empty', 'content_for_any_market');
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

test('a step without the evidence requirement still runs with no business evidence', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-generate-no-evidence-requirement-'));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const fixtureBefore = process.env.AO_STEP_FIXTURE;
  try {
    db.prepare(`
      INSERT INTO records (
        _row_id, business_name, sequence_name, sequence_status,
        _created_at, _updated_at, created_at, updated_at
      ) VALUES ('acct_generate_unrestricted', 'Mavericks Property Maintenance', 'default', 'idle', ?, ?, ?, ?)
    `).run(now, now, now, now);
    process.env.AO_STEP_FIXTURE = '1';
    const row = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('acct_generate_unrestricted');
    const summary = await runGenerateStep({
      db,
      listDir,
      config: { ai: {} },
      stepId: 'general_content_step',
      step: {
        id: 'general_content_step',
        kind: 'generate',
        outputs: {
          generated_content: { type: 'string' },
        },
      },
      rows: [row],
    });
    const record = db.prepare('SELECT generated_content FROM records WHERE _row_id = ?').get('acct_generate_unrestricted');
    assert.equal(summary.failed, 0);
    assert.equal(summary.processed, 1);
    assert.equal(record.generated_content, 'fixture_generated_content');
  } finally {
    if (fixtureBefore === undefined) delete process.env.AO_STEP_FIXTURE;
    else process.env.AO_STEP_FIXTURE = fixtureBefore;
    db.close();
  }
});
