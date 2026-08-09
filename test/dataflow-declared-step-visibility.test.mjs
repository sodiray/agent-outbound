import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeEnrichmentStepOnRecords } from '../dist/orchestrator/enrichment/runner.js';
import { runDataflowCore, runPipelineDataflow } from '../dist/orchestrator/pipeline/dataflow.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';
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
