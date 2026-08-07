import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../dist/schemas/config.js';
import { actionConfidenceAllows, assignCandidateTier } from '../dist/orchestrator/policy/scoring.js';
import { planEnrichmentRepair } from '../dist/orchestrator/policy/enrichment-repair.js';
import { evaluateOutboundReadiness } from '../dist/orchestrator/policy/readiness.js';
import { evaluateReachability } from '../dist/orchestrator/policy/timing-reachability.js';
import { evaluateGoldenTicket, evaluateStandardPostcard } from '../dist/orchestrator/policy/treatment.js';
import { withinEnrichmentCeiling } from '../dist/orchestrator/policy/cost-ledger.js';

const goldenTicketPassInput = () => ({
  treatmentTier: 'A',
  fitScore: 85,
  fitEvidenceConfidence: 80,
  identityConfidence: 90,
  classificationConfidence: 90,
  buyerConfidence: 80,
  mailConfidence: 90,
  timingScore: 70,
  strongTimingSignalCount: 0,
  mailAddressReady: true,
  assetReady: true,
  localBuyingAuthority: 'confirmed',
  namedBuyerStatus: 'confirmed',
  namedBuyerName: 'Taylor Morgan',
  buyerAffiliationStatus: 'confirmed',
  buyingCenterRole: 'owner',
  cohortCapacityOk: true,
});

test('pipeline policy defaults reproduce the existing Golden Ticket, postcard, action, reachability, candidate, repair, and budget values', () => {
  const score = normalizeConfig({ score: {} }).config.score;
  assert.deepEqual(score.golden_ticket.minimums, {
    fit_score: 85,
    fit_evidence_confidence: 80,
    identity_confidence: 90,
    classification_confidence: 90,
    buyer_confidence: 80,
    mail_confidence: 90,
    timing_score: 70,
    strong_signal_strength: 60,
    strong_signal_count: 2,
    enrichment_budget_usd: 8,
  });
  assert.deepEqual(score.action_confidence.minimums, {
    identity: 80, email: 60, phone: 70, linkedin: 60, mail: 80, fit_evidence: 40,
  });
  assert.deepEqual(score.reachability.minimums, {
    email_verification: 70, phone_ready: 60, phone_named_validated: 70, linkedin_invite_ready: 60, mail_ready: 60,
  });
  assert.deepEqual(score.candidate_tier.bands, [0, 50, 65, 80, 100]);
  assert.deepEqual(score.postcard.minimums, {
    identity_confidence: 80, strong_fit: 80, fit_evidence: 40, fit_evidence_exclusive_maximum: 60,
  });
  assert.deepEqual(score.enrichment_repair.minimums, {
    identity_confidence: 80,
    fit_evidence_confidence: 40,
    classification_confidence: 40,
    buyer_confidence: 60,
    strong_fit: 65,
    strong_fit_evidence: 60,
  });
  assert.deepEqual(score.enrichment_repair.channel_evidence_candidate_tiers, ['A', 'B', 'hold']);
  assert.deepEqual(score.enrichment_budget.ceilings, {
    foundational: 0.15, A: 3, B: 1, C: 0.3, D: 0.15, enrichment_hold: 0.3, golden_ticket_total: 8,
  });
});

test('configured pipeline policy thresholds are honored across every moved policy family', () => {
  const score = normalizeConfig({
    score: {
      golden_ticket: { minimums: { buyer_confidence: 81 } },
      action_confidence: { minimums: { identity: 70 } },
      reachability: { minimums: { email_verification: 60 } },
      candidate_tier: { bands: [0, 40, 50, 80, 100] },
      postcard: { minimums: { strong_fit: 85 } },
      enrichment_repair: { minimums: { identity_confidence: 70 } },
      enrichment_budget: { ceilings: { A: 4 } },
    },
  }).config.score;

  assert.ok(!evaluateGoldenTicket({ ...goldenTicketPassInput(), goldenTicket: score.golden_ticket }).eligible);
  assert.equal(actionConfidenceAllows({
    action: 'outbound_baseline',
    profile: { identity_confidence: 70, classification_confidence: 0, fit_evidence_confidence: 0, buyer_confidence: 0, timing_confidence: 0 },
    config: score.action_confidence,
  }).allowed, true);
  assert.equal(evaluateReachability({
    contact_email: 'taylor@example.com',
    email_verification_confidence: 65,
  }, score.reachability).channels[0].ready, true);
  assert.equal(assignCandidateTier(55, score.candidate_tier).candidate_tier, 'B');
  assert.equal(evaluateStandardPostcard({
    treatmentTier: 'C', fitScore: 80, fitEvidenceConfidence: 50, mailAddressReady: true, postcard: score.postcard,
  }).eligible, false);
  assert.ok(!planEnrichmentRepair({
    record: { _row_id: 'repair', company_resolution: 'resolved', business_name: 'Acme', place_id: 'p', website: 'https://acme.example', address: '1 Main', identity_confidence: 75 },
    config: score.enrichment_repair,
  }).steps.some((step) => step.field === 'identity_confidence'));
  assert.equal(withinEnrichmentCeiling({
    candidate_tier: 'A', enrichment_usd: 3.5, enrichmentBudget: score.enrichment_budget,
  }).within_budget, true);
});

test('pipeline policy config rejects malformed thresholds, ladders, and ceiling values', () => {
  const malformed = [
    { score: { golden_ticket: { minimums: { buyer_confidence: 101 } } } },
    { score: { action_confidence: { minimums: { email: -1 } } } },
    { score: { reachability: { minimums: { phone_ready: 80, phone_named_validated: 70 } } } },
    { score: { candidate_tier: { bands: [0, 50, 50, 80, 100] } } },
    { score: { postcard: { minimums: { fit_evidence: 60, fit_evidence_exclusive_maximum: 60 } } } },
    { score: { enrichment_repair: { minimums: { buyer_confidence: 101 } } } },
    { score: { enrichment_budget: { ceilings: { A: -1 } } } },
  ];
  for (const config of malformed) assert.ok(normalizeConfig(config).errors.length > 0);
});

test('pipeline policy remains fail-closed with no configured policy blocks', () => {
  assert.equal(evaluateGoldenTicket({ ...goldenTicketPassInput(), buyerConfidence: undefined }).eligible, false);
  assert.equal(actionConfidenceAllows({
    action: 'email',
    profile: { identity_confidence: 100, classification_confidence: 0, fit_evidence_confidence: 0, buyer_confidence: 0, timing_confidence: 0 },
  }).allowed, false);
  assert.equal(evaluateReachability({ contact_email: 'taylor@example.com' }).channels[0].ready, false);
  assert.equal(assignCandidateTier(null).candidate_tier, 'hold');
  assert.equal(evaluateStandardPostcard({
    treatmentTier: 'A', fitScore: 100, fitEvidenceConfidence: 100, mailAddressReady: false,
  }).eligible, false);
  assert.ok(planEnrichmentRepair({ record: { _row_id: 'missing' } }).steps.length > 0);
  assert.equal(withinEnrichmentCeiling({ candidate_tier: 'A', enrichment_usd: 3.01 }).within_budget, false);
  const readiness = evaluateOutboundReadiness({
    eligible: true,
    suppressed: false,
    identityConfidence: 79,
    materialContradiction: false,
    treatmentTier: 'B',
    channels: {},
    hasNextAction: true,
  });
  assert.ok(readiness.blockers.includes('identity_confidence_below_80'));
});
