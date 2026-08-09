import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runGenerateStep } from '../dist/orchestrator/generate/runner.js';
import { runPipelineDataflow } from '../dist/orchestrator/pipeline/dataflow.js';
import { ensureRecordColumns, insertAsset, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { generateDependencyHash } from '../dist/orchestrator/generate/runner.js';
import { writeStaleness } from '../dist/orchestrator/enrichment/runner.js';

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

test('dataflow lets generate invalidate declared inputs and records unchanged skips', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-generate-dataflow-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
ai:
  default_model: openrouter/anthropic/claude-haiku-4.5
pipeline:
  - kind: generate
    id: dependency_freshness
    run_in_pipeline: true
    inputs: [site_text]
    outputs:
      generated_value: { type: string, description: Generated value. }
`);
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: ['site_text', 'generated_value'] });
  upsertRecord({
    db,
    row: {
      _row_id: 'generate-dataflow-1',
      business_name: 'Current State HVAC',
      sequence_status: 'active',
      site_text: 'First source text.',
    },
  });
  db.close();
  const previousFixture = process.env.AO_STEP_FIXTURE;
  process.env.AO_STEP_FIXTURE = '1';
  try {
    await runPipelineDataflow({ listDir, force: false });
    const firstCheck = openListDb({ listDir, readonly: true });
    const firstStaleness = firstCheck.prepare('SELECT * FROM staleness WHERE record_id = ? AND step_id = ?').get('generate-dataflow-1', 'dependency_freshness');
    firstCheck.close();
    assert.ok(firstStaleness, 'generate must persist staleness after its first run');
    assert.equal(Number(firstStaleness.cache_ttl_seconds), 0);
    await runPipelineDataflow({ listDir, force: false });
    const secondCheck = openListDb({ listDir, readonly: true });
    const secondStaleness = secondCheck.prepare('SELECT * FROM staleness WHERE record_id = ? AND step_id = ?').get('generate-dataflow-1', 'dependency_freshness');
    secondCheck.close();
    assert.equal(secondStaleness.dep_hash, firstStaleness.dep_hash, 'unchanged inputs must retain the dependency hash');
    const update = openListDb({ listDir, readonly: false });
    const record = update.prepare('SELECT * FROM records WHERE _row_id = ?').get('generate-dataflow-1');
    upsertRecord({ db: update, row: { ...record, site_text: 'Changed source text.' } });
    update.close();
    await runPipelineDataflow({ listDir, force: false });

    const check = openListDb({ listDir, readonly: true });
    const reasons = check.prepare(`
      SELECT reason FROM pipeline_events
      WHERE record_id = ? AND step_id = ? AND passed = 1
      ORDER BY occurred_at ASC
    `).all('generate-dataflow-1', 'dependency_freshness').map((event) => event.reason);
    check.close();
    assert.deepEqual(reasons, ['', 'skipped_unchanged_inputs', '']);
  } finally {
    if (previousFixture === undefined) delete process.env.AO_STEP_FIXTURE;
    else process.env.AO_STEP_FIXTURE = previousFixture;
  }
});

test('an empty cached generate result is retried instead of being cached forever', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-generate-empty-cache-'));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const step = {
    id: 'diagnostic_content_pack',
    kind: 'generate',
    inputs: ['site_text'],
    outputs: {
      diagnostic_hypotheses_json: { type: 'string' },
      preliminary_snapshot: { type: 'string' },
    },
  };
  const fixtureBefore = process.env.AO_STEP_FIXTURE;
  try {
    ensureRecordColumns({ db, columns: ['site_text', ...Object.keys(step.outputs)] });
    upsertRecord({
      db,
      row: {
        _row_id: 'empty_cached_generate',
        business_name: 'Empty cached generate',
        sequence_status: 'active',
        site_text: 'A complete source record.',
      },
    });
    const staleRecord = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('empty_cached_generate');
    insertAsset({
      db,
      rowId: 'empty_cached_generate',
      stepId: step.id,
      outputsJson: JSON.stringify({
        diagnostic_hypotheses_json: '',
        preliminary_snapshot: '',
      }),
      status: 'empty',
      reason: 'prior model result was unusable',
    });
    writeStaleness({
      db,
      recordId: 'empty_cached_generate',
      stepId: step.id,
      depHash: generateDependencyHash({ step, record: staleRecord }),
      cacheTtl: '',
      cacheTtlSeconds: 0,
    });
    process.env.AO_STEP_FIXTURE = '1';

    const result = await runGenerateStep({
      db,
      listDir,
      config: {},
      step,
      rows: [staleRecord],
    });

    assert.equal(result.skipped_fresh, 0);
    assert.equal(result.processed, 1);
    const repaired = db.prepare(`
      SELECT diagnostic_hypotheses_json, preliminary_snapshot
      FROM records
      WHERE _row_id = ?
    `).get('empty_cached_generate');
    assert.deepEqual(repaired, {
      diagnostic_hypotheses_json: 'fixture_diagnostic_hypotheses_json',
      preliminary_snapshot: 'fixture_preliminary_snapshot',
    });
  } finally {
    if (fixtureBefore === undefined) delete process.env.AO_STEP_FIXTURE;
    else process.env.AO_STEP_FIXTURE = fixtureBefore;
    db.close();
  }
});

test('a generate model result with no usable declared outputs fails without caching', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-generate-empty-model-output-'));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const step = {
    id: 'diagnostic_content_pack',
    kind: 'generate',
    outputs: {
      diagnostic_hypotheses_json: { type: 'string' },
      preliminary_snapshot: { type: 'string' },
    },
  };
  try {
    upsertRecord({
      db,
      row: {
        _row_id: 'empty_model_generate',
        business_name: 'Empty model generate',
        sequence_status: 'active',
        created_at: now,
      },
    });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('empty_model_generate');
    const result = await runGenerateStep({
      db,
      listDir,
      config: {},
      step,
      rows: [record],
      executeAction: async () => ({ outputs: {}, artifacts: {}, usage: {} }),
    });

    assert.equal(result.failed, 1);
    assert.match(
      result.errors[0].error,
      /could not produce declared outputs diagnostic_hypotheses_json, preliminary_snapshot: the model returned no usable output/,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM staleness WHERE record_id = ? AND step_id = ?')
        .get('empty_model_generate', step.id).n,
      0,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM assets WHERE row_id = ? AND step_id = ?')
        .get('empty_model_generate', step.id).n,
      0,
    );
  } finally {
    db.close();
  }
});
