import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../dist/schemas/config.js';
import { planEnrichmentRepair } from '../dist/orchestrator/policy/enrichment-repair.js';
import { withinEnrichmentCeiling } from '../dist/orchestrator/policy/cost-ledger.js';
import { assignTreatmentAndMail } from '../dist/orchestrator/policy/treatment.js';
import { applyOutboundPolicy } from '../dist/orchestrator/policy/apply-record.js';
import {
  treasureValleyEnrichmentBudget,
  treasureValleyTreatmentStrategy,
} from './fixtures/treatment-strategy.mjs';

const foreignStrategy = {
  bands: {
    fit: [0, 50, 65, 80, 100],
    fit_evidence_confidence: [0, 40, 60, 80, 100],
  },
  matrix: [
    ['bronze', 'bronze', 'bronze', 'bronze'],
    ['bronze', 'bronze', 'gold', 'gold'],
    ['research_queue', 'gold', 'platinum', 'platinum'],
    ['research_queue', 'platinum', 'platinum', 'platinum'],
  ],
  unscored_tier: 'research_queue',
  tiers: {
    platinum: {
      route: 'outbound',
      pipeline: 'platinum_pipeline',
      mail_programs: ['signature_package'],
      requires_high_confidence_buyer: true,
    },
    gold: { route: 'outbound', pipeline: 'gold_pipeline', mail_programs: ['letter_pack'] },
    bronze: { route: 'recycle_monitoring', pipeline: 'bronze_pipeline' },
    research_queue: { route: 'enrichment', pipeline: 'research_pipeline', holding: true },
  },
  mail_programs: {
    letter_pack: {
      priority: 1,
      minimums: { identity_confidence: 80 },
      requirements: { mail_address_ready: true },
      tier_exception: {
        minimums: {
          fit_score: 80,
          fit_evidence_confidence: 40,
          fit_evidence_exclusive_maximum: 60,
        },
      },
    },
    signature_package: {
      priority: 2,
      minimums: {
        fit_score: 85,
        fit_evidence_confidence: 80,
        identity_confidence: 90,
        classification_confidence: 90,
        buyer_confidence: 80,
        mail_confidence: 90,
        timing_score: 70,
        strong_signal_count: 2,
        enrichment_budget_usd: 8,
      },
      requirements: {
        mail_address_ready: true,
        asset_ready: true,
        named_buyer: true,
        buyer_affiliation: true,
        buying_center_role: true,
        local_buying_authority: true,
        cohort_capacity: true,
        unsuppressed: true,
        no_material_contradiction: true,
        timing_or_strong_signals: true,
      },
    },
  },
};

const foreignBudget = {
  ceilings: {
    foundational: 0.15,
    tiers: { platinum: 3, gold: 1, bronze: 0.3, research_queue: 0.3 },
    mail_programs: { signature_package: 8 },
  },
};

const foreignInputs = {
  fitScore: 90,
  fitEvidenceConfidence: 90,
  identityConfidence: 90,
  classificationConfidence: 90,
  buyerConfidence: 80,
  mailConfidence: 90,
  timingScore: 75,
  strongTimingSignalCount: 2,
  mailAddressReady: true,
  suppressed: false,
  materialContradiction: false,
  localBuyingAuthority: 'confirmed',
  namedBuyerStatus: 'confirmed',
  namedBuyerName: 'Taylor Example',
  buyerAffiliationStatus: 'confirmed',
  buyingCenterRole: 'owner',
  mailProgramReadiness: {
    signature_package: { asset_ready: true, cohort_capacity_ok: true },
  },
  cumulativeEnrichmentCostUsd: 1,
  treatmentStrategy: foreignStrategy,
  enrichmentBudget: foreignBudget,
};

test('pipeline-declared holding tiers, ceilings, and mail programs do not inject another pipeline vocabulary', () => {
  const parsed = normalizeConfig({ score: { treatment: foreignStrategy, enrichment_budget: foreignBudget } });
  assert.equal(parsed.errors.length, 0);

  const treatment = assignTreatmentAndMail(foreignInputs);
  assert.equal(treatment.treatment_tier, 'platinum');
  assert.equal(treatment.mail_treatment, 'signature_package');
  assert.equal(JSON.stringify(treatment).includes('enrichment_hold'), false);
  assert.equal(JSON.stringify(treatment).includes('golden_ticket'), false);
  assert.equal(JSON.stringify(treatment).includes('"A"'), false);

  const repair = planEnrichmentRepair({
    record: { _row_id: 'foreign', fit_score: 90, treatment_tier: 'research_queue' },
    treatment_tier: 'research_queue',
    candidate_tier: 'platinum',
    treatmentStrategy: foreignStrategy,
    config: { channel_evidence_candidate_tiers: ['platinum'] },
  });
  assert.equal(repair.treatment_tier, 'research_queue');
  assert.equal(JSON.stringify(repair).includes('enrichment_hold'), false);

  const policy = applyOutboundPolicy({
    treatmentStrategy: foreignStrategy,
    enrichmentBudget: foreignBudget,
    record: {
      _row_id: 'foreign-policy',
      fit_score: 90,
      fit_evidence_confidence: 90,
      identity_confidence: 90,
      classification_confidence: 90,
      buyer_confidence: 80,
      mail_confidence: 90,
      timing_score: 75,
      mail_address_ready: true,
      named_buyer_status: 'confirmed',
      observed_buyer_name: 'Taylor Example',
      buyer_affiliation_status: 'confirmed',
      buying_center_role: 'owner',
      local_buying_authority: 'confirmed',
    },
  });
  assert.equal(policy.patch.candidate_tier, '');
  assert.equal(JSON.stringify(policy).includes('enrichment_hold'), false);
  assert.equal(JSON.stringify(policy).includes('golden_ticket'), false);
  assert.equal(JSON.stringify(policy).includes('"A"'), false);

  const ceiling = withinEnrichmentCeiling({
    treatment_tier: 'platinum',
    mail_treatment: 'signature_package',
    enrichment_usd: 5,
    enrichmentBudget: foreignBudget,
  });
  assert.deepEqual(ceiling, { within_budget: true, ceiling: 8 });
});

test('missing tier and mail declarations do not invent a tier or product', () => {
  const treatment = assignTreatmentAndMail({ fitScore: 90, fitEvidenceConfidence: 90 });
  assert.equal(treatment.treatment_tier, '');
  assert.equal(treatment.mail_treatment, '');
  assert.ok(treatment.reasons.includes('treatment_not_configured'));
  assert.ok(treatment.mail_withheld_reasons.includes('mail_programs_not_configured'));

  const repair = planEnrichmentRepair({ record: { _row_id: 'undeclared' } });
  assert.equal(repair.treatment_tier, '');
  assert.equal(repair.candidate_tier, '');
});

test('Treasure Valley keeps its current ceiling, repair-priority, and mail outcomes under equivalent declarations', () => {
  const premium = assignTreatmentAndMail({
    fitScore: 90,
    fitEvidenceConfidence: 90,
    identityConfidence: 90,
    classificationConfidence: 90,
    buyerConfidence: 80,
    mailConfidence: 90,
    timingScore: 75,
    strongTimingSignalCount: 2,
    mailAddressReady: true,
    localBuyingAuthority: 'confirmed',
    namedBuyerStatus: 'confirmed',
    namedBuyerName: 'Taylor Example',
    buyerAffiliationStatus: 'confirmed',
    buyingCenterRole: 'owner',
    mailProgramReadiness: {
      golden_ticket: { asset_ready: true, cohort_capacity_ok: true },
    },
    cumulativeEnrichmentCostUsd: 1,
    treatmentStrategy: treasureValleyTreatmentStrategy,
  });
  assert.deepEqual(
    { tier: premium.treatment_tier, product: premium.mail_treatment },
    { tier: 'A', product: 'golden_ticket' },
  );

  const ceiling = withinEnrichmentCeiling({
    treatment_tier: 'A',
    mail_treatment: 'golden_ticket',
    enrichment_usd: 5,
    enrichmentBudget: treasureValleyEnrichmentBudget,
  });
  assert.deepEqual(ceiling, { within_budget: true, ceiling: 8 });

  const repair = planEnrichmentRepair({
    record: { _row_id: 'tv-equivalent', treatment_tier: 'enrichment_hold', candidate_tier: 'A' },
    treatment_tier: 'enrichment_hold',
    candidate_tier: 'A',
    treatmentStrategy: treasureValleyTreatmentStrategy,
    config: { channel_evidence_candidate_tiers: ['A', 'B'] },
  });
  assert.deepEqual(
    repair.steps.slice(0, 6).map(({ field, depth, priority }) => ({ field, depth, priority })),
    [
      { field: 'company_resolution', depth: 'foundational', priority: 10 },
      { field: 'business_name', depth: 'foundational', priority: 20 },
      { field: 'place_id', depth: 'foundational', priority: 30 },
      { field: 'website', depth: 'foundational', priority: 40 },
      { field: 'address', depth: 'foundational', priority: 50 },
      { field: 'identity_confidence', depth: 'foundational', priority: 60 },
    ],
  );
});
