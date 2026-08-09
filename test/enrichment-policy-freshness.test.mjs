import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runPipelineDataflow } from '../dist/orchestrator/pipeline/dataflow.js';
import {
  enrichDependencyHashes,
  executeEnrichmentStepOnRecords,
  executionConfigForEnrichmentStep,
  isEnrichFresh,
} from '../dist/orchestrator/enrichment/runner.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { treasureValleyFitModel } from './fixtures/fit-model.mjs';
import { treasureValleyTreatmentStrategy } from './fixtures/treatment-strategy.mjs';

const listDir = () => mkdtempSync(join(tmpdir(), 'agent-outbound-policy-freshness-'));

const changedBandsStrategy = () => ({
  ...treasureValleyTreatmentStrategy,
  bands: {
    ...treasureValleyTreatmentStrategy.bands,
    fit: [0, 50, 75, 85, 100],
  },
});

const tierOnlyPolicy = (config) => ({
  treatment: {
    bands: config.score?.treatment?.bands,
    matrix: config.score?.treatment?.matrix,
    tiers: config.score?.treatment?.tiers,
    unscored_tier: config.score?.treatment?.unscored_tier,
  },
});

const dataflowPolicyYaml = (strategy) => `
pipeline:
  - kind: enrich
    id: treatment_assignment
    action: policy_apply
    model: openrouter/anthropic/claude-haiku-4.5
    inputs: [fit_score, fit_breakdown_json, fit_reasoning, fit_evidence_confidence, identity_confidence, phone_confidence, buyer_confidence, mail_confidence, timing_score, strong_signal_strength, strong_signal_count, enrichment_cost_usd, treatment_tier, candidate_tier, suppressed, address, phone, email_primary, contact_name, contact_email, contact_title, website, domain, vertical]
    outputs:
      treatment_tier: { type: string, description: Treatment tier. }
score:
  treatment: ${JSON.stringify(strategy)}
`;

test('policy_apply re-tiers cached records and exposes a policy-triggered rerun reason', async () => {
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
      _row_id: 'policy-freshness-1',
      business_name: 'TaxStudio',
      fit_score: 70,
      fit_evidence_confidence: 100,
      fit_breakdown: JSON.stringify(breakdown),
      vertical: null,
      sub_vertical: null,
    },
  });
  const step = {
    id: 'treatment_assignment',
    action: 'policy_apply',
    inputs: ['fit_score', 'fit_evidence_confidence'],
    outputs: { treatment_tier: { type: 'string', description: 'Treatment tier.' } },
  };
  const baseConfig = {
    pipeline: [{
      kind: 'score',
      id: 'score_fit',
      key: 'fit',
      criteria: treasureValleyFitModel.criteria,
    }],
    score: { treatment: treasureValleyTreatmentStrategy },
    policy: { fit_rule_version: treasureValleyFitModel.modelVersion },
  };
  const first = await executeEnrichmentStepOnRecords({
    db, listDir: root, config: baseConfig, mcp: null, toolCatalog: null, step, rows: [db.prepare('SELECT * FROM records').all()[0]],
  });
  assert.equal(first.processed, 1);
  assert.equal(db.prepare('SELECT treatment_tier FROM records WHERE _row_id = ?').get('policy-freshness-1').treatment_tier, 'B');
  const cached = db.prepare('SELECT * FROM staleness WHERE record_id = ? AND step_id = ?').get('policy-freshness-1', 'treatment_assignment');
  assert.ok(cached.input_hash);
  assert.ok(cached.policy_hash);
  await executeEnrichmentStepOnRecords({
    db, listDir: root, config: baseConfig, mcp: null, toolCatalog: null, step, rows: [db.prepare('SELECT * FROM records').all()[0]],
  });
  const unchanged = await executeEnrichmentStepOnRecords({
    db, listDir: root, config: baseConfig, mcp: null, toolCatalog: null, step, rows: [db.prepare('SELECT * FROM records').all()[0]],
  });
  assert.equal(unchanged.skipped_fresh, 1);
  assert.equal(unchanged.non_execution_reasons['policy-freshness-1'], 'skipped:fresh');
  const changed = await executeEnrichmentStepOnRecords({
    db,
    listDir: root,
    config: { ...baseConfig, score: { ...baseConfig.score, treatment: changedBandsStrategy() } },
    mcp: null,
    toolCatalog: null,
    step,
    rows: [db.prepare('SELECT * FROM records').all()[0]],
  });
  assert.equal(changed.processed, 1);
  assert.equal(changed.non_execution_reasons['policy-freshness-1'], 'rerun_policy_changed');
  assert.equal(db.prepare('SELECT treatment_tier FROM records WHERE _row_id = ?').get('policy-freshness-1').treatment_tier, 'C');
  db.close();
});

test('policy fingerprints are precise and unchanged policy retains the fresh skip', () => {
  const base = { score: { treatment: treasureValleyTreatmentStrategy } };
  const changedMailPrograms = {
    score: {
      treatment: {
        ...treasureValleyTreatmentStrategy,
        mail_programs: {
          ...treasureValleyTreatmentStrategy.mail_programs,
          standard_postcard: {
            ...treasureValleyTreatmentStrategy.mail_programs.standard_postcard,
            priority: 999,
          },
        },
      },
    },
  };
  const stepConfig = { action: 'policy_apply', inputs: ['fit_score'] };
  const recordInputs = { fit_score: 73.5 };
  const fullPolicy = executionConfigForEnrichmentStep({ stepConfig, config: base });
  const fullChangedPolicy = executionConfigForEnrichmentStep({ stepConfig, config: changedMailPrograms });
  const baseHashes = enrichDependencyHashes({ stepConfig, depValues: recordInputs, executionConfig: fullPolicy });
  const changedHashes = enrichDependencyHashes({ stepConfig, depValues: recordInputs, executionConfig: fullChangedPolicy });
  assert.notEqual(baseHashes.depHash, changedHashes.depHash, 'policy_apply reads mail programs and must re-run when they change');

  const tierOnlyBase = enrichDependencyHashes({
    stepConfig,
    depValues: recordInputs,
    executionConfig: tierOnlyPolicy(base),
  });
  const tierOnlyMailChange = enrichDependencyHashes({
    stepConfig,
    depValues: recordInputs,
    executionConfig: tierOnlyPolicy(changedMailPrograms),
  });
  assert.equal(tierOnlyBase.depHash, tierOnlyMailChange.depHash, 'a tier-only stage does not inherit mail-program invalidation');
  assert.equal(isEnrichFresh({
    cached: { dep_hash: baseHashes.depHash, cache_ttl_seconds: 0 },
    stepConfig,
    depValues: recordInputs,
    executionConfig: fullPolicy,
  }), true);
});

test('dataflow records policy-driven reruns distinctly from unchanged skips', async () => {
  const root = listDir();
  writeFileSync(join(root, 'outbound.yaml'), dataflowPolicyYaml(treasureValleyTreatmentStrategy));
  const db = openListDb({ listDir: root, readonly: false });
  upsertRecord({ db, row: { _row_id: 'policy-event-1', business_name: 'Policy Event' } });
  db.close();

  await runPipelineDataflow({ listDir: root });
  await runPipelineDataflow({ listDir: root });
  writeFileSync(join(root, 'outbound.yaml'), dataflowPolicyYaml(changedBandsStrategy()));
  await runPipelineDataflow({ listDir: root });

  const check = openListDb({ listDir: root, readonly: true });
  const reasons = check.prepare(`
    SELECT reason FROM pipeline_events
    WHERE record_id = ? AND step_id = ?
    ORDER BY occurred_at ASC
  `).all('policy-event-1', 'treatment_assignment').map((row) => row.reason);
  check.close();
  assert.equal(reasons.at(-1), 'rerun_policy_changed', JSON.stringify(reasons));
});
