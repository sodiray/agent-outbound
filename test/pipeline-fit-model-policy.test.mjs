import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runPipelineDataflow } from '../dist/orchestrator/pipeline/dataflow.js';
import { runScoreStage } from '../dist/orchestrator/scoring/stage-runner.js';
import {
  dependencyValuesForRecord,
  enrichDependencyHashes,
  enrichmentStepConfig,
  executionConfigForEnrichmentStep,
  isEnrichFresh,
  readStaleness,
  writeStaleness,
} from '../dist/orchestrator/enrichment/runner.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { getRecordDetail } from '../dist/viz/data.js';
import { assignTreatmentAndMail } from '../dist/orchestrator/policy/treatment.js';
import { applyOutboundPolicy } from '../dist/orchestrator/policy/apply-record.js';
import { readConfig } from '../dist/orchestrator/lib/config.js';
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

const goldenTicketTreatmentStrategy = {
  bands: {
    fit: [0, 50, 65, 78, 100],
    fit_evidence_confidence: [0, 40, 60, 80, 100],
  },
  matrix: Array.from({ length: 4 }, () => ['A', 'A', 'A', 'A']),
  unscored_tier: 'enrichment_hold',
  tiers: {
    A: {
      route: 'outbound',
      pipeline: 'tier_a',
      requires_high_confidence_buyer: false,
      mail_programs: ['standard_postcard', 'golden_ticket'],
    },
    enrichment_hold: { route: 'enrichment', pipeline: 'enrichment_hold', holding: true },
  },
  mail_programs: {
    standard_postcard: {
      priority: 1,
      minimums: { fit_score: 70 },
    },
    golden_ticket: {
      priority: 2,
      minimums: {
        fit_score: 78,
        fit_evidence_confidence: 80,
        identity_confidence: 80,
        classification_confidence: 85,
      },
      requirements: { mail_address_ready: true },
    },
  },
};

const fitGrades = [8, 8, 7, 7, 8, 8];

const staleScoreBreakdown = JSON.stringify(treasureValleyFitModel.criteria.map((criterion, index) => ({
  id: criterion.id,
  grade: fitGrades[index],
  reasoning: 'Retired scoring output.',
})));

const policyStep = {
  kind: 'enrich',
  id: 'treatment_assignment',
  action: 'policy_apply',
  model: 'openrouter/anthropic/claude-haiku-4.5',
  depends_on: ['score_fit'],
  inputs: [
    'fit_score', 'fit_coverage', 'fit_breakdown', 'fit_breakdown_json', 'fit_reasoning',
    'fit_evidence_confidence', 'identity_confidence', 'classification_confidence', 'phone_confidence',
    'buyer_confidence', 'mail_confidence', 'mail_address_ready', 'timing_score', 'strong_signal_strength',
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
  inputs: ['business_name'],
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
  fit_evidence_confidence: 75,
  score_breakdown: staleScoreBreakdown,
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

const goldenTicketRecord = {
  ...readyRecord,
  _row_id: 'liberty-asset-group',
  business_name: 'Liberty Asset Group',
  fit_score: 78,
  classification_confidence: 92,
  fit_evidence_confidence: 100,
  mail_address_ready: 1,
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

const runPolicyPipeline = async ({
  pipeline,
  scoreSamples = 1,
  scoreCriteria = () => treasureValleyFitModel.criteria.map((criterion, index) => ({
    id: criterion.id,
    grade: fitGrades[index],
    assessable: true,
    reasoning: 'Current score-stage evidence assessment.',
    evidence_ids: ['current-score-stage-evidence'],
  })),
  recordInput = readyRecord,
}) => {
  const root = listDir();
  writeTaxonomy(root);
  writeFileSync(join(root, 'outbound.yaml'), JSON.stringify({
    pipeline,
    policy: { fit_rule_version: treasureValleyFitModel.modelVersion },
    score: { samples: scoreSamples, treatment: aTreatmentStrategy },
  }));
  const db = openListDb({ listDir: root, readonly: false });
  ensureRecordColumns({ db, columns: ['fit_evidence_confidence', 'score_breakdown'] });
  upsertRecord({ db, row: recordInput });
  if (pipeline.some((step) => step.kind === 'score' && step.key === 'fit')) {
    await runScoreStage({
      db,
      listDir: root,
      config: { score: { samples: scoreSamples } },
      step: declaredFitStep,
      rows: [recordInput],
      generateObject: async () => ({
        object: {
          criteria: scoreCriteria(),
          summary_reasoning: 'Current fit-stage score.',
        },
        usage: {},
      }),
    });
  }
  db.close();
  await runPipelineDataflow({ listDir: root });
  await runPipelineDataflow({ listDir: root });
  const check = openListDb({ listDir: root, readonly: true });
  const record = check.prepare('SELECT * FROM records WHERE _row_id = ?').get(recordInput._row_id);
  const events = check.prepare('SELECT step_id, reason FROM pipeline_events WHERE record_id = ? ORDER BY occurred_at').all(recordInput._row_id);
  check.close();
  return { root, record, events };
};

test('pipeline policy_apply bands the persisted kind: score fit without reading a stale score_breakdown', async () => {
  const { root, record: first, events } = await runPolicyPipeline({ pipeline: [declaredFitStep, policyStep] });
  assert.equal(first.fit_score, 76.5, JSON.stringify({ events, calculation: first.fit_calculation_json }));
  assert.equal(Number(first.fit_evidence_confidence), 100);
  // Retired score_breakdown must be cleared — policy must band the current
  // score-stage fit, not the stale retired-column payload seeded above.
  assert.equal(first.score_breakdown, '');
  const fitBreakdown = JSON.parse(first.fit_breakdown);
  // Stage-shaped fit_breakdown (criteria + missing_inputs). Extra audit keys
  // (e.g. samples) are allowed; freeze the required shape, not the whole set.
  assert.ok(Array.isArray(fitBreakdown.criteria), 'fit_breakdown.criteria must be present');
  assert.ok(Array.isArray(fitBreakdown.missing_inputs), 'fit_breakdown.missing_inputs must be present');
  assert.equal(fitBreakdown.criteria.length, fitCriteria.length);
  assert.equal(fitBreakdown.criteria[0].grade, fitGrades[0]);
  const detail = getRecordDetail(root, readyRecord._row_id);
  assert.equal(detail.score.criteria[0].grade, fitGrades[0]);
  assert.equal(first.treatment_tier, 'A', JSON.stringify({
    events,
    reasons: first.treatment_reasons,
    identity: first.identity_confidence,
    buyer: first.buyer_confidence,
    namedBuyer: first.named_buyer_status,
    affiliation: first.buyer_affiliation_status,
  }));
});

test('pipeline policy_apply keeps configured fit evidence confidence at zero without evidence ids', async () => {
  const { record } = await runPolicyPipeline({
    pipeline: [declaredFitStep, policyStep],
    recordInput: {
      ...readyRecord,
      _row_id: 'configured-fit-without-evidence-ids',
      fit_evidence_confidence: 100,
    },
    scoreCriteria: () => treasureValleyFitModel.criteria.map((criterion, index) => ({
      id: criterion.id,
      grade: fitGrades[index],
      assessable: true,
      reasoning: 'A grade without source identifiers is not evidence-backed.',
      evidence_ids: [],
    })),
  });
  assert.equal(Number(record.fit_evidence_confidence), 0);
  assert.equal(record.treatment_tier, 'enrichment_hold');
  assert.match(record.treatment_reasons, /fit_evidence_band=below40/);
});

test('legacy score-breakdown evidence confidence semantics remain unchanged', () => {
  const breakdown = treasureValleyFitModel.criteria.map((criterion, index) => ({
    id: criterion.id,
    grade: fitGrades[index],
    reasoning: 'Legacy criterion reasoning.',
    evidence_ids: [`legacy-evidence-${criterion.id}`],
  }));
  const result = applyOutboundPolicy({
    record: {
      _row_id: 'legacy-fit-evidence-confidence',
      fit_score: 76.5,
      score_breakdown: JSON.stringify(breakdown),
    },
    recomputeFitFromBreakdown: true,
    fitModel: treasureValleyFitModel,
  });
  assert.equal(result.patch.fit_evidence_confidence, 100);
});

test('pipeline policy_apply uses full reduced multi-sample fit coverage instead of a stale zero', async () => {
  const { record, events } = await runPolicyPipeline({
    pipeline: [declaredFitStep, policyStep],
    scoreSamples: 3,
    recordInput: { ...readyRecord, _row_id: 'multi-sample-full-coverage', fit_coverage: 0 },
  });
  const breakdown = JSON.parse(record.fit_breakdown);
  assert.equal(breakdown.samples, 3);
  assert.equal(breakdown.sample_scores.length, 3);
  assert.equal(breakdown.criteria.length, 6);
  assert.equal(Math.round(breakdown.criteria.reduce(
    (sum, criterion) => sum + (criterion.assessable ? criterion.weight : 0),
    0,
  ) * 1000) / 1000, 1);
  assert.ok(breakdown.criteria.every((criterion) => criterion.evidence_ids.length > 0));
  assert.equal(Number(record.fit_coverage), 1, JSON.stringify({ events, breakdown, reasons: record.treatment_reasons }));
  assert.notEqual(record.treatment_tier, 'enrichment_hold', record.treatment_reasons);
  assert.doesNotMatch(record.treatment_reasons, /fit_assessable_weight_below_0.5/);
});

test('pipeline policy_apply holds a reduced multi-sample fit below minimum coverage', async () => {
  const { record } = await runPolicyPipeline({
    pipeline: [declaredFitStep, policyStep],
    scoreSamples: 3,
    recordInput: { ...readyRecord, _row_id: 'multi-sample-partial-coverage', fit_coverage: 1 },
    scoreCriteria: () => treasureValleyFitModel.criteria.map((criterion, index) => ({
      id: criterion.id,
      ...(index < 2
        ? {
          grade: 9,
          assessable: true,
          reasoning: 'Evidence supports this criterion.',
          evidence_ids: [`evidence-${criterion.id}`],
        }
        : {
          assessable: false,
          reasoning: 'Evidence does not support this criterion.',
          evidence_ids: [`evidence-${criterion.id}`],
        }),
    })),
  });
  assert.equal(Number(record.fit_coverage), 0.4);
  assert.equal(record.treatment_tier, 'enrichment_hold');
  assert.match(record.treatment_reasons, /fit_assessable_weight_below_0.5/);
});

test('pipeline policy_apply explicitly treats a pipeline without a fit stage as unscored', async () => {
  const noFitPolicyStep = { ...policyStep, depends_on: [] };
  const { record, events } = await runPolicyPipeline({ pipeline: [noFitPolicyStep] });
  assert.equal(record.fit_score, null, JSON.stringify({ events, calculation: record.fit_calculation_json, reasons: record.treatment_reasons }));
  assert.equal(record.treatment_tier, 'enrichment_hold');
  assert.match(record.treatment_reasons, /fit_band=unscored/);
  assert.equal(record.fit_calculation_json, undefined);
});

const runGoldenTicketPolicyPipeline = async (recordInput, { stalePreRuleVersion = false } = {}) => {
  const root = listDir();
  writeTaxonomy(root);
  const dormantFitStep = {
    ...declaredFitStep,
    when: {
      conditions: [{ field: 'skip_fit_stage', operator: 'eq', value: true }],
    },
    inputs: ['business_name', 'skip_fit_stage'],
  };
  const goldenTicketPolicyStep = {
    ...policyStep,
    depends_on: [],
  };
  const config = {
    pipeline: [dormantFitStep, goldenTicketPolicyStep],
    policy: { fit_rule_version: treasureValleyFitModel.modelVersion },
    score: { treatment: goldenTicketTreatmentStrategy },
  };
  writeFileSync(join(root, 'outbound.yaml'), JSON.stringify({ ...config, pipeline: [dormantFitStep] }));
  const db = openListDb({ listDir: root, readonly: false });
  ensureRecordColumns({
    db,
    columns: ['classification_confidence', 'fit_evidence_confidence', 'mail_treatment', 'treatment_tier'],
  });
  upsertRecord({ db, row: { ...recordInput, skip_fit_stage: false } });
  db.close();

  await runPipelineDataflow({ listDir: root });
  writeFileSync(join(root, 'outbound.yaml'), JSON.stringify(config));

  const seededDb = openListDb({ listDir: root, readonly: false });
  if (stalePreRuleVersion) {
    const loaded = readConfig(root).config;
    const step = loaded.pipeline.find((candidate) => candidate.id === 'treatment_assignment');
    const stepConfig = enrichmentStepConfig(step);
    const record = seededDb.prepare('SELECT * FROM records WHERE _row_id = ?').get(recordInput._row_id);
    assert.equal(record.treatment_tier, 'A');
    const executionConfig = executionConfigForEnrichmentStep({ stepConfig, config: loaded, listDir: root });
    const { policy, ...nonPolicyConfig } = executionConfig;
    const { policy_apply_execution_version, ...legacyPolicy } = policy;
    const dependencyHashes = enrichDependencyHashes({
      stepConfig,
      depValues: dependencyValuesForRecord({ stepConfig, record }),
      executionConfig: { policy: legacyPolicy, ...nonPolicyConfig },
    });
    writeStaleness({
      db: seededDb,
      recordId: recordInput._row_id,
      stepId: 'treatment_assignment',
      ...dependencyHashes,
      cacheTtlSeconds: 0,
      cacheTtl: '',
    });
    const cached = readStaleness({ db: seededDb, recordId: recordInput._row_id, stepId: 'treatment_assignment' });
    assert.equal(isEnrichFresh({
      cached,
      stepConfig,
      depValues: dependencyValuesForRecord({ stepConfig, record }),
      executionConfig,
    }), false);
  }
  seededDb.close();

  await runPipelineDataflow({ listDir: root });

  const check = openListDb({ listDir: root, readonly: true });
  const record = check.prepare('SELECT * FROM records WHERE _row_id = ?').get(recordInput._row_id);
  check.close();
  return record;
};

test('pipeline policy_apply selects Golden Ticket from persisted mail readiness and names a failed higher-program minimum', async () => {
  const complete = await runGoldenTicketPolicyPipeline(goldenTicketRecord);
  assert.equal(complete.mail_treatment, 'golden_ticket');

  const classificationBelowMinimum = await runGoldenTicketPolicyPipeline({
    ...goldenTicketRecord,
    _row_id: 'durham-school-services',
    classification_confidence: 84,
  });
  assert.equal(classificationBelowMinimum.mail_treatment, 'standard_postcard');
  assert.match(
    classificationBelowMinimum.treatment_json,
    /mail_program:golden_ticket:classification_confidence_below_85/,
  );
});

test('pipeline policy_apply invalidates a pre-rule-version fresh cache and persists Golden Ticket', async () => {
  const record = await runGoldenTicketPolicyPipeline({
    ...goldenTicketRecord,
    mail_treatment: 'standard_postcard',
    treatment_tier: 'A',
  }, { stalePreRuleVersion: true });
  assert.equal(record.mail_treatment, 'golden_ticket');
  assert.match(record.treatment_json, /mail_program:golden_ticket:tier_allows_mail_program/);
});

test('policy assembly distinguishes an unknown value from an omitted evaluator input', () => {
  const completeInput = {
    policyInputAssembly: 'complete',
    treatmentStrategy: goldenTicketTreatmentStrategy,
    fitScore: 78,
    fitEvidenceConfidence: 100,
    identityConfidence: 100,
    classificationConfidence: null,
    mailAddressReady: true,
  };
  const unknown = assignTreatmentAndMail(completeInput);
  assert.equal(unknown.mail_treatment, 'standard_postcard');
  assert.ok(unknown.mail_withheld_reasons.includes('mail_program:golden_ticket:classification_confidence_missing'));

  const { classificationConfidence, ...callerOmittedInput } = completeInput;
  assert.throws(
    () => assignTreatmentAndMail(callerOmittedInput),
    /policy_treatment_input_not_supplied:golden_ticket:classificationConfidence/,
  );
});
