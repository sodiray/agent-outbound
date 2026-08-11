import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeEnrichmentStepOnRecords } from '../dist/orchestrator/enrichment/runner.js';
import { runDataflowCore, runPipelineDataflow } from '../dist/orchestrator/pipeline/dataflow.js';
import { executeStepBatch } from '../dist/orchestrator/pipeline/step-executor.js';
import { ensureRecordColumns, insertDraft, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { treasureValleyFitModel } from './fixtures/fit-model.mjs';
import { treasureValleyTreatmentStrategy } from './fixtures/treatment-strategy.mjs';

const listDir = () => mkdtempSync(join(tmpdir(), 'agent-outbound-declared-step-'));

const changedStrategy = () => ({
  ...treasureValleyTreatmentStrategy,
  bands: {
    ...treasureValleyTreatmentStrategy.bands,
    fit: [0, 50, 75, 85, 100],
  },
});

test('dataflow exposes every declared step that was not attempted for a record', async () => {
  const skipped = [];
  const steps = [
    { id: 'already_passed_filter', index: 0, step: {}, kind: 'filter', tier: 0, cost: 0, dropGate: true, deps: [], executable: true },
    { id: 'prior_send', index: 1, step: {}, kind: 'send_email', tier: 3, cost: 0, dropGate: false, deps: ['already_passed_filter'], executable: true },
  ];

  await runDataflowCore({
    records: [{ _row_id: 'visible-record' }],
    steps,
    concurrency: 1,
    initialResolvedByRecord: new Map([['visible-record', new Set(steps.map((step) => step.id))]]),
    isTimeReady: () => true,
    loadStep: async () => {
      throw new Error('pre-resolved step must not execute');
    },
    onStepOutcome: async () => ({}),
    onStepNotAttempted: async (_recordState, step, reason) => {
      skipped.push({ id: step.id, reason });
    },
  });

  assert.deepEqual(skipped, [
    { id: 'already_passed_filter', reason: 'skipped:already_resolved' },
    { id: 'prior_send', reason: 'skipped:already_resolved' },
  ]);
});

test('a true step error blocks only its descendants and preserves the declared-step count', async () => {
  const attempted = [];
  const skipped = [];
  const steps = [
    { id: 'tier_a.email_1', index: 0, step: {}, kind: 'send_email', tier: 3, cost: 0, dropGate: false, deps: [], executable: true },
    { id: 'score_fit', index: 1, step: {}, kind: 'score', tier: 3, cost: 0, dropGate: false, deps: [], executable: true },
    { id: 'compose_email_2', index: 2, step: {}, kind: 'compose', tier: 3, cost: 0, dropGate: false, deps: ['tier_a.email_1'], executable: true },
  ];

  await runDataflowCore({
    records: [{ _row_id: 'dependency-scoped-error' }],
    steps,
    concurrency: 1,
    isTimeReady: () => true,
    loadStep: async (step) => {
      attempted.push(step.id);
      return step.id === 'tier_a.email_1'
        ? { passed: false, errored: true, reason: 'provider_failed' }
        : { passed: true, reason: '' };
    },
    onStepOutcome: async (_recordState, step, outcome) => ({
      resolved: outcome.passed,
      errored: step.id === 'tier_a.email_1',
    }),
    onStepNotAttempted: async (_recordState, step, reason) => {
      skipped.push({ id: step.id, reason });
    },
  });

  assert.deepEqual(attempted, ['tier_a.email_1', 'score_fit']);
  assert.deepEqual(skipped, [{ id: 'compose_email_2', reason: 'skipped:upstream_errored:tier_a.email_1' }]);
  assert.equal(attempted.length + skipped.length, steps.length);
});

test('a normal outbound deferral returns a parked non-error outcome', async () => {
  const root = listDir();
  writeFileSync(join(root, 'outbound.yaml'), 'pipeline: []\n');
  const db = openListDb({ listDir: root, readonly: false });
  upsertRecord({
    db,
    row: {
      _row_id: 'future-email',
      business_name: 'Future Email',
      sequence_name: 'default',
      sequence_status: 'active',
      account_sequence_state: 'active',
      next_action_date: '2099-01-01',
    },
  });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('future-email');
  const outcome = (await executeStepBatch(
    { db, listDir: root, config: { pipeline: [] }, aiConfig: {}, mcp: null, toolCatalog: null },
    { kind: 'send_email', id: 'email_1', side_effecting: true, config: { channel: 'email' } },
    'email_1',
    [record],
  )).get('future-email');
  db.close();

  assert.equal(outcome?.passed, false);
  assert.equal(outcome?.errored, false);
  assert.equal(outcome?.parked, true);
  assert.match(String(outcome?.reason), /^(sequence_outbound_gated:|sequence_unreachable:)/);
});

test('dataflow records a deferred declared generate step', async () => {
  const root = listDir();
  writeFileSync(join(root, 'outbound.yaml'), `
pipeline:
  - kind: generate
    id: deferred_asset
    model: openrouter/anthropic/claude-haiku-4.5
    inputs: [business_name]
    outputs:
      asset_copy: { type: string, description: Optional generated copy. }
`);
  const db = openListDb({ listDir: root, readonly: false });
  upsertRecord({ db, row: { _row_id: 'deferred-record', business_name: 'Deferred' } });
  db.close();

  await runPipelineDataflow({ listDir: root });

  const check = openListDb({ listDir: root, readonly: true });
  const event = check.prepare(`
    SELECT passed, reason
    FROM pipeline_events
    WHERE record_id = ? AND step_id = ?
    ORDER BY rowid DESC
    LIMIT 1
  `).get('deferred-record', 'deferred_asset');
  check.close();

  assert.deepEqual(event, { passed: 0, reason: 'skipped:deferred_generate' });
});

test('pipeline dry-run reports opted-out records removed from its selected set', async () => {
  const root = listDir();
  writeFileSync(join(root, 'outbound.yaml'), 'pipeline: []\n');
  const db = openListDb({ listDir: root, readonly: false });
  upsertRecord({ db, row: { _row_id: 'pipeline-active', business_name: 'Active', sequence_status: 'idle' } });
  upsertRecord({ db, row: { _row_id: 'pipeline-opted-out', business_name: 'Opted Out', sequence_status: 'opted_out' } });
  db.close();

  const result = await runPipelineDataflow({ listDir: root, dryRun: true });

  assert.deepEqual(result.selection, {
    requested: 2,
    selected: 1,
    excluded: [{
      selector: 'opted_out',
      reason: 'sequence_status_opted_out',
      count: 1,
    }],
  });
});

test('a policy change re-applies to a record already active in its sequence', async () => {
  const root = listDir();
  const registryDir = join(root, 'build', 'registries');
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(join(registryDir, 'vertical-taxonomy.json'), JSON.stringify({
    taxonomy_version: 'test-v1',
    verticals: { other_local_smb: { sub_verticals: ['other_local_smb'] } },
    fallback_vertical: 'other_local_smb',
    fallback_sub_vertical: 'other_local_smb',
  }));
  const db = openListDb({ listDir: root, readonly: false });
  ensureRecordColumns({ db, columns: ['fit_evidence_confidence'] });
  const breakdown = treasureValleyFitModel.criteria.map((criterion) => ({
    id: criterion.id,
    grade: 7,
    evidence_ids: ['evidence-1'],
    reasoning: 'Observed operational evidence.',
  }));
  upsertRecord({
    db,
    row: {
      _row_id: 'active-policy-change',
      business_name: 'Active Policy Change',
      fit_score: 70,
      fit_evidence_confidence: 100,
      fit_breakdown: JSON.stringify(breakdown),
      sequence_status: 'active',
      sequence_step: 4,
      next_action_date: '2099-01-01',
    },
  });
  const step = {
    id: 'treatment_assignment',
    action: 'policy_apply',
    inputs: ['fit_score', 'fit_evidence_confidence'],
    outputs: { treatment_tier: { type: 'string', description: 'Treatment tier.' } },
  };
  const config = {
    pipeline: [{ kind: 'score', id: 'score_fit', key: 'fit', criteria: treasureValleyFitModel.criteria }],
    score: { treatment: treasureValleyTreatmentStrategy },
    policy: { fit_rule_version: treasureValleyFitModel.modelVersion },
  };

  await executeEnrichmentStepOnRecords({
    db, listDir: root, config, mcp: null, toolCatalog: null, step,
    rows: [db.prepare('SELECT * FROM records WHERE _row_id = ?').get('active-policy-change')],
  });
  const changed = await executeEnrichmentStepOnRecords({
    db,
    listDir: root,
    config: { ...config, score: { ...config.score, treatment: changedStrategy() } },
    mcp: null,
    toolCatalog: null,
    step,
    rows: [db.prepare('SELECT * FROM records WHERE _row_id = ?').get('active-policy-change')],
  });
  db.close();

  assert.equal(changed.processed, 1);
  assert.equal(changed.non_execution_reasons['active-policy-change'], 'rerun_policy_changed');
});

test('a pending email draft parks only its branch while classification and treatment continue', async () => {
  const root = listDir();
  const registryDir = join(root, 'build', 'registries');
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(join(registryDir, 'vertical-taxonomy.json'), JSON.stringify({
    taxonomy_version: 'test-v1',
    verticals: { other_local_smb: { sub_verticals: ['other_local_smb'] } },
    fallback_vertical: 'other_local_smb',
    fallback_sub_vertical: 'other_local_smb',
  }));
  writeFileSync(join(root, 'outbound.yaml'), JSON.stringify({
    ai: { default_model: 'openrouter/anthropic/claude-haiku-4.5' },
    pipeline: [
      {
        kind: 'send_email',
        id: 'tier_a.email_1',
        side_effecting: true,
        draft_approval_required: true,
        config: { channel: 'email' },
      },
      {
        kind: 'generate',
        id: 'classification',
        run_in_pipeline: true,
        inputs: ['business_name'],
        outputs: {
          classification_confidence: { type: 'number', description: 'Classification confidence.' },
        },
        fixture_outputs: { classification_confidence: 90 },
      },
      {
        kind: 'enrich',
        id: 'treatment_assignment',
        action: 'policy_apply',
        depends_on: ['classification'],
        inputs: [
          'fit_score', 'fit_breakdown', 'fit_breakdown_json', 'fit_reasoning',
          'fit_evidence_confidence', 'identity_confidence', 'classification_confidence', 'phone_confidence',
          'buyer_confidence', 'mail_confidence', 'mail_address_ready', 'timing_score', 'strong_signal_strength',
          'strong_signal_count', 'enrichment_cost_usd', 'treatment_tier', 'candidate_tier',
          'suppressed', 'address', 'phone', 'email_primary', 'contact_name', 'contact_email',
          'contact_title', 'website', 'domain', 'vertical',
        ],
        outputs: { treatment_tier: { type: 'string', description: 'Treatment tier.' } },
      },
    ],
    score: { treatment: treasureValleyTreatmentStrategy },
    policy: { fit_rule_version: treasureValleyFitModel.modelVersion },
  }));
  const db = openListDb({ listDir: root, readonly: false });
  ensureRecordColumns({ db, columns: ['fit_evidence_confidence', 'classification_confidence'] });
  const breakdown = treasureValleyFitModel.criteria.map((criterion) => ({
    id: criterion.id,
    grade: 7,
    evidence_ids: ['evidence-1'],
    reasoning: 'Observed operational evidence.',
  }));
  upsertRecord({
    db,
    row: {
      _row_id: 'pending-draft-policy-change',
      business_name: 'Pending Draft Policy Change',
      sequence_name: 'default',
      sequence_status: 'idle',
      fit_score: 70,
      fit_evidence_confidence: 100,
      fit_breakdown: JSON.stringify(breakdown),
      classification_confidence: 80,
    },
  });
  insertDraft({
    db,
    draft: {
      draft_id: 'pending-draft',
      row_id: 'pending-draft-policy-change',
      sequence_name: 'default',
      step_number: 1,
      step_id: 'tier_a.email_1',
      channel: 'email',
      status: 'pending_approval',
      subject: 'Pending review',
      body: 'A human must approve this draft.',
    },
  });
  db.close();

  const fixtureBefore = process.env.AO_PIPELINE_FIXTURE;
  process.env.AO_PIPELINE_FIXTURE = '1';
  try {
    await runPipelineDataflow({ listDir: root });
  } finally {
    if (fixtureBefore === undefined) delete process.env.AO_PIPELINE_FIXTURE;
    else process.env.AO_PIPELINE_FIXTURE = fixtureBefore;
  }

  const check = openListDb({ listDir: root, readonly: true });
  const events = check.prepare(`
    SELECT step_id, passed, reason
    FROM pipeline_events
    WHERE record_id = ?
    ORDER BY rowid
  `).all('pending-draft-policy-change');
  const record = check.prepare('SELECT * FROM records WHERE _row_id = ?').get('pending-draft-policy-change');
  check.close();

  assert.ok(events.some((event) => event.step_id === 'tier_a.email_1' && event.passed === 0 && /Draft pending approval/i.test(event.reason)));
  assert.ok(events.some((event) => event.step_id === 'classification' && event.passed === 1), JSON.stringify(events));
  assert.ok(events.some((event) => event.step_id === 'treatment_assignment' && event.passed === 1), JSON.stringify(events));
  assert.notEqual(record.treatment_tier, '');
});
