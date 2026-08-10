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

test('a reasoned generate decline honors explicit on_error empty, runs descendants, and is not cached', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-generate-reasoned-decline-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
ai:
  default_model: openrouter/anthropic/claude-haiku-4.5
sequences:
  default: { steps: [] }
pipeline:
  - kind: generate
    id: diagnostic_content_pack
    model: openrouter/anthropic/claude-haiku-4.5
    requires_evidence: true
    on_error: empty
    inputs: [business_name]
    outputs:
      preliminary_snapshot: { type: string, description: A grounded snapshot. }
  - kind: assign
    id: downstream_assignment
    depends_on: [diagnostic_content_pack]
    inputs: [sequence_status]
    target: sequence_name
    fallback: default
    rules: []
`);
  const db = openListDb({ listDir, readonly: false });
  try {
    upsertRecord({ db, row: { _row_id: 'reasoned-decline', sequence_status: 'active' } });
  } finally {
    db.close();
  }

  const pipeline = await runPipelineDataflow({ listDir });
  const check = openListDb({ listDir, readonly: true });
  try {
    const asset = check.prepare(`
      SELECT status, reason FROM assets
      WHERE row_id = ? AND step_id = ?
    `).get('reasoned-decline', 'diagnostic_content_pack');
    const events = check.prepare(`
      SELECT step_id, passed, reason FROM pipeline_events
      WHERE record_id = ?
      ORDER BY rowid ASC
    `).all('reasoned-decline');
    const staleness = check.prepare(`
      SELECT COUNT(*) AS n FROM staleness
      WHERE record_id = ? AND step_id = ?
    `).get('reasoned-decline', 'diagnostic_content_pack');

    assert.equal(pipeline.errored, 0);
    assert.deepEqual(asset, {
      status: 'empty',
      reason: 'needs_discovery: no_business_evidence',
    });
    // Structural empty under on_error: empty is recorded non-success (passed: 0), not a pass.
    // Descendants still run because the step resolves without errored.
    assert.deepEqual(events.map((event) => ({ step_id: event.step_id, passed: event.passed })), [
      { step_id: 'diagnostic_content_pack', passed: 0 },
      { step_id: 'downstream_assignment', passed: 1 },
    ]);
    assert.equal(events[0].reason, 'needs_discovery: no_business_evidence');
    assert.equal(staleness.n, 0);
  } finally {
    check.close();
  }
});

test('a reasoned generate decline without on_error empty remains a strict failure', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-generate-strict-decline-'));
  const db = openListDb({ listDir, readonly: false });
  const step = {
    id: 'diagnostic_content_pack',
    kind: 'generate',
    on_error: 'fail',
    outputs: {
      preliminary_snapshot: { type: 'string' },
    },
  };
  try {
    upsertRecord({ db, row: { _row_id: 'strict-decline', sequence_status: 'active' } });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('strict-decline');
    const result = await runGenerateStep({
      db,
      listDir,
      config: {},
      step,
      rows: [record],
      executeAction: async () => ({
        outputs: {},
        reason: 'No public evidence supports a grounded snapshot.',
        usage: {},
      }),
    });

    assert.equal(result.failed, 1);
    assert.match(result.errors[0].error, /could not produce declared output preliminary_snapshot/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets WHERE row_id = ?').get('strict-decline').n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM staleness WHERE record_id = ?').get('strict-decline').n, 0);
  } finally {
    db.close();
  }
});

test('a pipeline generate without on_error empty remains strict after config parsing', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-generate-default-strict-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
ai:
  default_model: openrouter/anthropic/claude-haiku-4.5
sequences:
  default: { steps: [] }
pipeline:
  - kind: generate
    id: diagnostic_content_pack
    model: openrouter/anthropic/claude-haiku-4.5
    requires_evidence: true
    inputs: [business_name]
    outputs:
      preliminary_snapshot: { type: string, description: A grounded snapshot. }
  - kind: assign
    id: downstream_assignment
    depends_on: [diagnostic_content_pack]
    inputs: [sequence_status]
    target: sequence_name
    fallback: default
    rules: []
`);
  const db = openListDb({ listDir, readonly: false });
  try {
    upsertRecord({ db, row: { _row_id: 'default-strict', sequence_status: 'active' } });
  } finally {
    db.close();
  }

  const pipeline = await runPipelineDataflow({ listDir });
  const check = openListDb({ listDir, readonly: true });
  try {
    const downstream = check.prepare(`
      SELECT passed, reason FROM pipeline_events
      WHERE record_id = ? AND step_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get('default-strict', 'downstream_assignment');

    assert.equal(pipeline.errored, 1);
    assert.match(pipeline.errors[0].error, /could not produce declared output preliminary_snapshot/);
    assert.deepEqual(downstream, {
      passed: 0,
      reason: 'skipped:upstream_errored:diagnostic_content_pack',
    });
  } finally {
    check.close();
  }
});

test('a model-reasoned generate decline is accepted only by on_error empty and is retried', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-generate-model-decline-'));
  const db = openListDb({ listDir, readonly: false });
  const step = {
    id: 'diagnostic_content_pack',
    kind: 'generate',
    on_error: 'empty',
    outputs: {
      preliminary_snapshot: { type: 'string' },
    },
  };
  let calls = 0;
  const executeAction = async () => {
    calls += 1;
    return {
      outputs: {},
      reason: 'Without public evidence, a grounded preliminary snapshot would require unsupported claims.',
      usage: {},
    };
  };
  try {
    upsertRecord({ db, row: { _row_id: 'model-decline', sequence_status: 'active' } });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('model-decline');
    const first = await runGenerateStep({
      db,
      listDir,
      config: {},
      step,
      rows: [record],
      executeAction,
    });
    const second = await runGenerateStep({
      db,
      listDir,
      config: {},
      step,
      rows: [record],
      executeAction,
    });
    const asset = db.prepare(`
      SELECT status, reason FROM assets
      WHERE row_id = ? AND step_id = ?
    `).get('model-decline', step.id);

    assert.equal(first.failed, 0);
    assert.equal(first.processed, 1);
    assert.equal(second.skipped_fresh, 0);
    assert.equal(calls, 2);
    assert.deepEqual(asset, {
      status: 'empty',
      reason: 'Without public evidence, a grounded preliminary snapshot would require unsupported claims.',
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM staleness WHERE record_id = ?').get('model-decline').n, 0);
  } finally {
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
  let calls = 0;
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
      executeAction: async () => {
        calls += 1;
        return { outputs: {}, artifacts: {}, usage: {} };
      },
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
    const retry = await runGenerateStep({
      db,
      listDir,
      config: {},
      step,
      rows: [record],
      executeAction: async () => {
        calls += 1;
        return { outputs: {}, artifacts: {}, usage: {} };
      },
    });
    assert.equal(retry.failed, 1);
    assert.equal(calls, 2);
  } finally {
    db.close();
  }
});
