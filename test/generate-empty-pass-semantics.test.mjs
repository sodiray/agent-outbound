import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EMPTY_DECLARED_OUTPUTS_REASON,
  NEEDS_DISCOVERY_NO_BUSINESS_EVIDENCE_REASON,
  runGenerateStep,
} from '../dist/orchestrator/generate/runner.js';
import { runPipelineDataflow } from '../dist/orchestrator/pipeline/dataflow.js';
import {
  declaredOutputWriteFailures,
  executeStepBatch,
} from '../dist/orchestrator/pipeline/step-executor.js';
import {
  ensureRecordColumns,
  hasPassedStep,
  openListDb,
  upsertRecord,
} from '../dist/orchestrator/runtime/db.js';

const writePipeline = (listDir, yamlBody) => {
  writeFileSync(join(listDir, 'outbound.yaml'), yamlBody);
};

const seedActive = (listDir, row) => {
  const db = openListDb({ listDir, readonly: false });
  try {
    upsertRecord({ db, row: { sequence_status: 'active', ...row } });
  } finally {
    db.close();
  }
};

const blankModel = (reason = '') => async () => ({
  outputs: { preliminary_snapshot: '' },
  reason,
  usage: {},
});

const generateStep = ({
  onError = 'empty',
  requiresEvidence = false,
  executeAction,
  outputs = { preliminary_snapshot: { type: 'string' } },
} = {}) => ({
  kind: 'generate',
  id: 'diagnostic_content_pack',
  on_error: onError,
  requires_evidence: requiresEvidence,
  inputs: ['business_name'],
  outputs,
  ...(executeAction ? { __executeAction: executeAction } : {}),
});

const pipelineYaml = ({ onError = 'empty', requiresEvidence = false } = {}) => `
ai:
  default_model: openrouter/anthropic/claude-haiku-4.5
sequences:
  default: { steps: [] }
pipeline:
  - kind: generate
    id: diagnostic_content_pack
    model: openrouter/anthropic/claude-haiku-4.5
    ${requiresEvidence ? 'requires_evidence: true' : ''}
    on_error: ${onError}
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
`;

// --- 1. Model all-blank + on_error empty → recorded non-success ---

test('1. model all-blank + on_error empty is recorded non-success with engine reason', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-gen-empty-1-'));
  const db = openListDb({ listDir, readonly: false });
  const modelProse = 'I cannot invent a grounded snapshot without public evidence.';
  const step = generateStep({ executeAction: blankModel(modelProse) });
  try {
    upsertRecord({ db, row: { _row_id: 'blank-empty', sequence_status: 'active', business_name: 'Acme' } });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('blank-empty');

    const result = await runGenerateStep({
      db,
      listDir,
      config: {},
      step,
      rows: [record],
      executeAction: blankModel(modelProse),
    });
    const outcome = (await executeStepBatch(
      { db, listDir, config: {}, force: true },
      step,
      step.id,
      [record],
    )).get('blank-empty');
    const asset = db.prepare(
      'SELECT status, reason FROM assets WHERE row_id = ? AND step_id = ?',
    ).get('blank-empty', step.id);

    assert.equal(result.failed, 0);
    assert.equal(result.processed, 1);
    assert.equal(result.recorded_non_success['blank-empty'], EMPTY_DECLARED_OUTPUTS_REASON);
    assert.equal(result.non_execution_reasons['blank-empty'], EMPTY_DECLARED_OUTPUTS_REASON);
    assert.equal(outcome.passed, false);
    assert.equal(outcome.errored, false);
    assert.equal(outcome.reason, EMPTY_DECLARED_OUTPUTS_REASON);
    assert.deepEqual(asset, { status: 'empty', reason: modelProse });
    assert.equal(hasPassedStep({ db, recordId: 'blank-empty', stepId: step.id }), false);
  } finally {
    db.close();
  }
});

// --- 2. Same + on_error fail → hard error ---

test('2. all-blank + on_error fail remains a hard error', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-gen-empty-2-'));
  const db = openListDb({ listDir, readonly: false });
  const step = generateStep({
    onError: 'fail',
    executeAction: blankModel('Would need unsupported claims.'),
  });
  try {
    upsertRecord({ db, row: { _row_id: 'strict-blank', sequence_status: 'active', business_name: 'Acme' } });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('strict-blank');

    const result = await runGenerateStep({
      db,
      listDir,
      config: {},
      step,
      rows: [record],
      executeAction: blankModel('Would need unsupported claims.'),
    });
    const outcome = (await executeStepBatch(
      { db, listDir, config: {}, force: true },
      step,
      step.id,
      [record],
    )).get('strict-blank');

    assert.equal(result.failed, 1);
    assert.match(result.errors[0].error, /could not produce declared output/);
    assert.equal(result.recorded_non_success?.['strict-blank'], undefined);
    assert.equal(outcome.passed, false);
    assert.equal(outcome.errored, true);
  } finally {
    db.close();
  }
});

// --- 3. Pre-call requires_evidence, no evidence, on_error empty ---

test('3. pre-call requires_evidence + on_error empty: no model call, passed 0, needs_discovery', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-gen-empty-3-'));
  writePipeline(listDir, pipelineYaml({ onError: 'empty', requiresEvidence: true }));
  seedActive(listDir, { _row_id: 'no-evidence' });

  const pipeline = await runPipelineDataflow({ listDir });
  const check = openListDb({ listDir, readonly: true });
  try {
    const event = check.prepare(`
      SELECT passed, reason FROM pipeline_events
      WHERE record_id = ? AND step_id = ?
      ORDER BY rowid DESC LIMIT 1
    `).get('no-evidence', 'diagnostic_content_pack');
    const downstream = check.prepare(`
      SELECT passed FROM pipeline_events
      WHERE record_id = ? AND step_id = ?
      ORDER BY rowid DESC LIMIT 1
    `).get('no-evidence', 'downstream_assignment');
    const asset = check.prepare(`
      SELECT status, reason FROM assets WHERE row_id = ? AND step_id = ?
    `).get('no-evidence', 'diagnostic_content_pack');

    assert.equal(pipeline.errored, 0);
    assert.deepEqual(event, {
      passed: 0,
      reason: NEEDS_DISCOVERY_NO_BUSINESS_EVIDENCE_REASON,
    });
    assert.equal(downstream.passed, 1);
    assert.deepEqual(asset, {
      status: 'empty',
      reason: NEEDS_DISCOVERY_NO_BUSINESS_EVIDENCE_REASON,
    });
    assert.equal(
      hasPassedStep({ db: check, recordId: 'no-evidence', stepId: 'diagnostic_content_pack' }),
      false,
    );
  } finally {
    check.close();
  }
});

// --- 4. Engine evidence TRUE + model all-blank still non-pass ---

test('4. engine evidence TRUE + model all-blank + on_error empty is still non-pass', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-gen-empty-4-'));
  const db = openListDb({ listDir, readonly: false });
  let calls = 0;
  const executeAction = async () => {
    calls += 1;
    return {
      outputs: {
        preliminary_snapshot: '',
        diagnostic_hypotheses_json: '',
      },
      reason: 'Evidence present but insufficient for a grounded diagnostic pack.',
      usage: {},
    };
  };
  const step = generateStep({
    requiresEvidence: true,
    outputs: {
      preliminary_snapshot: { type: 'string' },
      diagnostic_hypotheses_json: { type: 'string' },
    },
    executeAction,
  });
  try {
    ensureRecordColumns({ db, columns: ['site_text', 'preliminary_snapshot', 'diagnostic_hypotheses_json'] });
    upsertRecord({
      db,
      row: {
        _row_id: 'has-evidence-blank-model',
        sequence_status: 'active',
        business_name: 'Acme HVAC',
        site_text: 'Licensed HVAC contractor serving the valley for 20 years.',
      },
    });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('has-evidence-blank-model');

    const result = await runGenerateStep({
      db,
      listDir,
      config: {},
      step,
      rows: [record],
      executeAction,
    });
    const outcome = (await executeStepBatch(
      { db, listDir, config: {}, force: true },
      step,
      step.id,
      [record],
    )).get('has-evidence-blank-model');

    assert.ok(calls >= 1, 'pre-gate must allow the model call when evidence exists');
    assert.equal(result.failed, 0);
    assert.equal(result.recorded_non_success['has-evidence-blank-model'], EMPTY_DECLARED_OUTPUTS_REASON);
    assert.equal(outcome.passed, false);
    assert.equal(outcome.errored, false);
    assert.equal(outcome.reason, EMPTY_DECLARED_OUTPUTS_REASON);
    assert.equal(
      hasPassedStep({ db, recordId: 'has-evidence-blank-model', stepId: step.id }),
      false,
    );
  } finally {
    db.close();
  }
});

// --- 5. Partial fills still succeed ---

test('5. partial declared outputs still count as success', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-gen-empty-5-'));
  const db = openListDb({ listDir, readonly: false });
  const executeAction = async () => ({
    outputs: {
      preliminary_snapshot: 'A grounded snapshot of Acme.',
      diagnostic_hypotheses_json: '',
    },
    usage: {},
  });
  const step = generateStep({
    outputs: {
      preliminary_snapshot: { type: 'string' },
      diagnostic_hypotheses_json: { type: 'string' },
    },
    executeAction,
  });
  try {
    upsertRecord({ db, row: { _row_id: 'partial-fill', sequence_status: 'active', business_name: 'Acme' } });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('partial-fill');

    const result = await runGenerateStep({
      db,
      listDir,
      config: {},
      step,
      rows: [record],
      executeAction,
    });
    const outcome = (await executeStepBatch(
      { db, listDir, config: {}, force: true },
      { ...step, __executeAction: executeAction },
      step.id,
      [record],
    )).get('partial-fill');
    const asset = db.prepare(
      'SELECT status FROM assets WHERE row_id = ? AND step_id = ?',
    ).get('partial-fill', step.id);

    assert.equal(result.failed, 0);
    assert.equal(result.processed, 1);
    assert.equal(result.recorded_non_success?.['partial-fill'], undefined);
    // Second batch may skip as fresh if first run wrote staleness — either path is success.
    assert.equal(outcome.passed, true);
    assert.notEqual(outcome.reason, EMPTY_DECLARED_OUTPUTS_REASON);
    assert.equal(asset.status, 'ready');
  } finally {
    db.close();
  }
});

// --- 6. Descendants unlock; hasPassedStep false ---

test('6. descendants unlock after empty non-pass; hasPassedStep is false', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-gen-empty-6-'));
  writePipeline(listDir, pipelineYaml({ onError: 'empty', requiresEvidence: true }));
  seedActive(listDir, { _row_id: 'unlock-deps' });

  const pipeline = await runPipelineDataflow({ listDir });
  const check = openListDb({ listDir, readonly: true });
  try {
    const events = check.prepare(`
      SELECT step_id, passed, reason FROM pipeline_events
      WHERE record_id = ?
      ORDER BY rowid ASC
    `).all('unlock-deps');

    assert.equal(pipeline.errored, 0);
    assert.deepEqual(
      events.map((e) => ({ step_id: e.step_id, passed: e.passed })),
      [
        { step_id: 'diagnostic_content_pack', passed: 0 },
        { step_id: 'downstream_assignment', passed: 1 },
      ],
    );
    assert.equal(events[0].reason, NEEDS_DISCOVERY_NO_BUSINESS_EVIDENCE_REASON);
    assert.equal(
      hasPassedStep({ db: check, recordId: 'unlock-deps', stepId: 'diagnostic_content_pack' }),
      false,
    );
    assert.equal(
      hasPassedStep({ db: check, recordId: 'unlock-deps', stepId: 'downstream_assignment' }),
      true,
    );
  } finally {
    check.close();
  }
});

// --- 7. Guard still allows intentional single-field blank ---

test('7. guard still permits intentional single-field blank when other outputs landed', () => {
  const failures = declaredOutputWriteFailures({
    outputNames: ['franchise_brand', 'ownership_type'],
    record: { franchise_brand: '', ownership_type: 'independent' },
    declaredOutputWrites: {
      franchise_brand: { provided: true, value: '' },
      ownership_type: { provided: true, value: 'independent' },
    },
  });
  assert.deepEqual(failures, []);
});

// --- 8. Empty model reason is enough for soft non-success (decision 3) ---

test('8. all-blank + on_error empty + empty model reason is recorded non-success, not hard fail', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-gen-empty-8-'));
  const db = openListDb({ listDir, readonly: false });
  const step = generateStep({ executeAction: blankModel('') });
  try {
    upsertRecord({ db, row: { _row_id: 'no-model-reason', sequence_status: 'active', business_name: 'Acme' } });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('no-model-reason');

    const result = await runGenerateStep({
      db,
      listDir,
      config: {},
      step,
      rows: [record],
      executeAction: blankModel(''),
    });
    const outcome = (await executeStepBatch(
      { db, listDir, config: {}, force: true },
      step,
      step.id,
      [record],
    )).get('no-model-reason');
    const asset = db.prepare(
      'SELECT status, reason FROM assets WHERE row_id = ? AND step_id = ?',
    ).get('no-model-reason', step.id);

    assert.equal(result.failed, 0, 'empty model reason must not hard-fail under on_error: empty');
    assert.equal(result.processed, 1);
    assert.equal(result.recorded_non_success['no-model-reason'], EMPTY_DECLARED_OUTPUTS_REASON);
    assert.equal(result.non_execution_reasons['no-model-reason'], EMPTY_DECLARED_OUTPUTS_REASON);
    assert.equal(outcome.passed, false);
    assert.equal(outcome.errored, false);
    assert.equal(outcome.reason, EMPTY_DECLARED_OUTPUTS_REASON);
    assert.equal(asset.status, 'empty');
    assert.equal(asset.reason, EMPTY_DECLARED_OUTPUTS_REASON);
  } finally {
    db.close();
  }
});

// Full dataflow: post-model empty via inject is not available through yaml; cover
// pipeline_events.passed via requires_evidence path (tests 3/6) and batch mapping
// via executeStepBatch + __executeAction (tests 1/4/8).
