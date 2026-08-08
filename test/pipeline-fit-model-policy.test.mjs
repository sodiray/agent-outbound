import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runPipelineDataflow } from '../dist/orchestrator/pipeline/dataflow.js';
import { openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { treasureValleyFitModel } from './fixtures/fit-model.mjs';
import { treasureValleyTreatmentStrategy } from './fixtures/treatment-strategy.mjs';

const listDir = () => mkdtempSync(join(tmpdir(), 'agent-outbound-pipeline-fit-model-'));

const fitCriteria = treasureValleyFitModel.criteria.map((criterion) => ({
  ...criterion,
  description: `Evidence-backed assessment for ${criterion.id}.`,
}));

const aTreatmentStrategy = {
  ...treasureValleyTreatmentStrategy,
  matrix: Array.from({ length: 4 }, () => ['A', 'A', 'A', 'A']),
  tiers: {
    ...treasureValleyTreatmentStrategy.tiers,
    A: {
      ...treasureValleyTreatmentStrategy.tiers.A,
      requires_high_confidence_buyer: false,
      mail_programs: ['standard_postcard'],
    },
  },
  mail_programs: {
    standard_postcard: treasureValleyTreatmentStrategy.mail_programs.standard_postcard,
  },
};

const fitGrades = [8, 8, 7, 7, 8, 8];

const fitBreakdown = JSON.stringify(treasureValleyFitModel.criteria.map((criterion, index) => ({
  id: criterion.id,
  grade: fitGrades[index],
  evidence_ids: [`evidence-${criterion.id}`],
  reasoning: 'Durable evidence supports this assessment.',
})));

const policyStep = {
  kind: 'enrich',
  id: 'treatment_assignment',
  action: 'policy_apply',
  model: 'openrouter/anthropic/claude-haiku-4.5',
  depends_on: ['score_fit'],
  inputs: [
    'fit_score', 'fit_breakdown', 'fit_breakdown_json', 'fit_reasoning',
    'fit_evidence_confidence', 'identity_confidence', 'phone_confidence',
    'buyer_confidence', 'mail_confidence', 'timing_score', 'strong_signal_strength',
    'strong_signal_count', 'enrichment_cost_usd', 'treatment_tier', 'candidate_tier',
    'suppressed', 'address', 'phone', 'email_primary', 'contact_name', 'contact_email',
    'contact_title', 'website', 'domain', 'vertical',
  ],
  outputs: {
    treatment_tier: { type: 'string', description: 'Assigned treatment tier.' },
  },
};

const declaredFitStep = {
  kind: 'score',
  id: 'score_fit',
  key: 'fit',
  inputs: ['__run_score'],
  when: {
    match: 'all',
    conditions: [{ field: '__run_score', operator: 'eq', value: 'yes' }],
  },
  model: 'openrouter/anthropic/claude-haiku-4.5',
  criteria: fitCriteria,
  outputs: {
    fit_score: { type: 'number' },
    fit_breakdown: { type: 'json' },
    fit_reasoning: { type: 'string' },
  },
};

const readyRecord = {
  _row_id: 'a-1-heating',
  business_name: 'A-1 Heating',
  address: '100 Main Street',
  city: 'Boise',
  state: 'ID',
  postal_code: '83702',
  website: 'https://a1-heating.example.test',
  place_id: 'a1-heating-place',
  is_a_business: true,
  company_resolution: 'resolved',
  identity_confidence: 100,
  classification_confidence: 100,
  phone_confidence: 100,
  buyer_confidence: 100,
  mail_confidence: 100,
  named_buyer_status: 'confirmed',
  observed_buyer_name: 'Alex Owner',
  buyer_affiliation_status: 'confirmed',
  buying_center_role: 'Owner',
  local_buying_authority: true,
  fit_score: 76.5,
  fit_evidence_confidence: 100,
  fit_breakdown: fitBreakdown,
  vertical: 'other_local_smb',
  sub_vertical: 'other_local_smb',
  observations_json: JSON.stringify({
    observations: [
      ['website', 'https://a1-heating.example.test'],
      ['observed_buyer_name', 'Alex Owner'],
      ['buying_center_role', 'Owner'],
      ['buyer_affiliation_status', 'confirmed'],
    ].map(([predicate, value]) => ({
      evidence_id: `evidence-${predicate}`,
      predicate,
      value,
      support_status: 'literal_support',
      source_id: `provider-${predicate}`,
      observed_at: '2026-08-08T00:00:00.000Z',
      provisional: false,
    })),
  }),
};

const writeTaxonomy = (root) => {
  const registryDir = join(root, 'build', 'registries');
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(join(registryDir, 'vertical-taxonomy.json'), JSON.stringify({
    taxonomy_version: 'test-v1',
    verticals: { other_local_smb: { sub_verticals: ['other_local_smb'] } },
    fallback_vertical: 'other_local_smb',
    fallback_sub_vertical: 'other_local_smb',
  }));
};

const runPolicyPipeline = async ({ pipeline }) => {
  const root = listDir();
  writeTaxonomy(root);
  writeFileSync(join(root, 'outbound.yaml'), JSON.stringify({
    pipeline,
    policy: { fit_rule_version: treasureValleyFitModel.modelVersion },
    score: { treatment: aTreatmentStrategy },
  }));
  const db = openListDb({ listDir: root, readonly: false });
  upsertRecord({ db, row: readyRecord });
  db.close();
  await runPipelineDataflow({ listDir: root });
  await runPipelineDataflow({ listDir: root });
  const check = openListDb({ listDir: root, readonly: true });
  const record = check.prepare('SELECT * FROM records WHERE _row_id = ?').get(readyRecord._row_id);
  const events = check.prepare('SELECT step_id, reason FROM pipeline_events WHERE record_id = ? ORDER BY occurred_at').all(readyRecord._row_id);
  check.close();
  return { record, events };
};

test('pipeline policy_apply recomputes the declared fit stage and preserves A treatment on rerun', async () => {
  const { record: first, events } = await runPolicyPipeline({ pipeline: [declaredFitStep, policyStep] });
  assert.equal(first.fit_score, 76.5, JSON.stringify({ events, calculation: first.fit_calculation_json }));
  assert.equal(Number(first.fit_evidence_confidence), 100);
  assert.equal(first.treatment_tier, 'A', JSON.stringify({
    events,
    reasons: first.treatment_reasons,
    identity: first.identity_confidence,
    buyer: first.buyer_confidence,
    namedBuyer: first.named_buyer_status,
    affiliation: first.buyer_affiliation_status,
  }));
  assert.equal(JSON.parse(first.fit_calculation_json).fit_model_version, treasureValleyFitModel.modelVersion);
});

test('pipeline policy_apply explicitly treats a pipeline without a fit stage as unscored', async () => {
  const noFitPolicyStep = { ...policyStep, depends_on: [] };
  const { record, events } = await runPolicyPipeline({ pipeline: [noFitPolicyStep] });
  assert.equal(record.fit_score, null, JSON.stringify({ events, calculation: record.fit_calculation_json, reasons: record.treatment_reasons }));
  assert.equal(record.treatment_tier, 'enrichment_hold');
  assert.match(record.treatment_reasons, /fit_band=unscored/);
  assert.equal(JSON.parse(record.fit_calculation_json).reason, 'fit_components_not_configured');
});
