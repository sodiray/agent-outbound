/**
 * Phase 5 scoring / priority / treatment / readiness isolation suite.
 *
 * Drives **shipped** AgentOutbound policy + production apply/guard entry points
 * only (no reimplementation). Mandated coverage:
 * 1. Fit components — commercial only; no HIPAA / walk-in
 * 2. Treatment matrix A / B / C / D / hold
 * 3. Priority ≠ fit mirror
 * 4. Hard readiness when enforce_readiness
 * 5. Golden Ticket identity gate
 *
 * Also traces score → applyOutboundPolicy production contract via pure apply
 * with recomputeFitFromBreakdown (same inputs the scoring runner uses).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateFitScore,
  calculatePriority,
  actionConfidenceAllows,
  assignCandidateTier,
  FIT_ARITHMETIC_RULE_VERSION,
  PRIORITY_RULE_VERSION,
} from '../dist/orchestrator/policy/scoring.js';
import { treasureValleyFitModel } from './fixtures/fit-model.mjs';
import {
  assignTreatmentTier as assignRawTreatmentTier,
  assignTreatmentAndMail as assignRawTreatmentAndMail,
  evaluateGoldenTicket as evaluateRawGoldenTicket,
  evaluateStandardPostcard as evaluateRawStandardPostcard,
  enrichmentBudgetRemaining,
  countStrongTimingSignals,
  CALCULATION_RULE_VERSION as TREATMENT_RULE_VERSION,
} from '../dist/orchestrator/policy/treatment.js';
import {
  treasureValleyCandidateTier,
  treasureValleyEnrichmentBudget,
  treasureValleyGoldenTicket,
  treasureValleyPostcard,
  treasureValleyTreatmentStrategy,
} from './fixtures/treatment-strategy.mjs';

const assignTreatmentTier = (input) => assignRawTreatmentTier({ treatmentStrategy: treasureValleyTreatmentStrategy, ...input });
const assignTreatmentAndMail = (input) => assignRawTreatmentAndMail({
  treatmentStrategy: treasureValleyTreatmentStrategy,
  goldenTicket: treasureValleyGoldenTicket,
  postcard: treasureValleyPostcard,
  ...input,
});
const evaluateGoldenTicket = (input) => evaluateRawGoldenTicket({
  treatmentStrategy: treasureValleyTreatmentStrategy,
  goldenTicket: treasureValleyGoldenTicket,
  ...input,
});
const evaluateStandardPostcard = (input) => evaluateRawStandardPostcard({
  treatmentStrategy: treasureValleyTreatmentStrategy,
  postcard: treasureValleyPostcard,
  ...input,
});
import {
  evaluateOutboundReadiness,
} from '../dist/orchestrator/policy/readiness.js';
import {
  applyOutboundPolicy as applyRawOutboundPolicy,
  guardChannelExecution,
  fitComponentsFromBreakdown,
  deriveFitEvidenceConfidence,
} from '../dist/orchestrator/policy/apply-record.js';
const applyOutboundPolicy = (input) => applyRawOutboundPolicy({
  fitModel: treasureValleyFitModel,
  treatmentStrategy: treasureValleyTreatmentStrategy,
  goldenTicket: treasureValleyGoldenTicket,
  postcard: treasureValleyPostcard,
  ...input,
});
import {
  calculateTimingScore,
  decayStrength,
  evaluateReachability,
  TIMING_RULE_VERSION,
  REACHABILITY_RULE_VERSION,
} from '../dist/orchestrator/policy/timing-reachability.js';
import { derivePhoneConfidence } from '../dist/orchestrator/policy/evidence.js';
import {
  parseCostLedger,
  appendCostEntry,
  withinEnrichmentCeiling,
  COST_LEDGER_VERSION,
} from '../dist/orchestrator/policy/cost-ledger.js';

const ALL_FIT_IDS = [
  'operational_coordination_burden',
  'repetition_and_volume',
  'economic_impact_potential',
  'operating_scale_surface_area',
  'mission_delivery_compatibility',
  'local_buying_autonomy',
];

const fullBreakdown = (grades = {}) =>
  ALL_FIT_IDS.map((id) => ({
    id,
    grade: grades[id] ?? 8,
    reasoning: `evidence for ${id}`,
    // Real source evidence IDs required for non-zero fit_evidence_confidence.
    evidence_ids: [`snap_${id}`, `obs_${id}`],
  }));

const fullComponents = (grades = {}) =>
  ALL_FIT_IDS.map((id) => ({
    id,
    grade: grades[id] ?? 8,
    reasoning: `evidence for ${id}`,
    evidence_ids: [`snap_${id}`, `obs_${id}`],
  }));

// ---------------------------------------------------------------------------
// 1. Fit components — no HIPAA / walk-in
// ---------------------------------------------------------------------------

test('phase-05 fit: pipeline criteria declare the commercial fit model', () => {
  const ids = treasureValleyFitModel.criteria.map((criterion) => criterion.id);
  assert.deepEqual(ids.sort(), [...ALL_FIT_IDS].sort());

  const sum = treasureValleyFitModel.criteria.reduce((total, criterion) => total + criterion.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights must sum to 1, got ${sum}`);

  const banned = [
    'walk_in',
    'walk_in_decision_maker_access',
    'walk_in_access',
    'hipaa',
    'hipaa_exposure',
    'hipaa_penalty',
    'regulatory_exposure',
    'ticket_size',
    'website_presence',
    'contact_availability',
    'email_found',
    'buyer_identified',
    'timing',
    'timing_score',
  ];
  for (const id of banned) {
    assert.equal(ids.includes(id), false, `banned fit component present: ${id}`);
  }
  assert.equal(treasureValleyFitModel.modelVersion, 'tv-fit-v1');
});

test('phase-05 fit: calculateFitScore is deterministic; missing components do not invent grades', () => {
  const components = fullComponents({
    operational_coordination_burden: 8,
    repetition_and_volume: 7,
    economic_impact_potential: 8,
    operating_scale_surface_area: 6,
    mission_delivery_compatibility: 7,
    local_buying_autonomy: 9,
  });
  const a = calculateFitScore(components, treasureValleyFitModel);
  const b = calculateFitScore(components, treasureValleyFitModel);
  assert.equal(a.fit_score, b.fit_score);
  assert.equal(a.fit_score, 74.7);
  assert.equal(a.missing_inputs.length, 0);
  assert.equal(a.calculation_rule_version, FIT_ARITHMETIC_RULE_VERSION);
  assert.equal(a.fit_model_version, 'tv-fit-v1');

  const sparse = calculateFitScore([
    { id: 'operational_coordination_burden', grade: 10 },
  ], treasureValleyFitModel);
  assert.ok(sparse.missing_inputs.includes('repetition_and_volume'));
  assert.ok(sparse.missing_inputs.length >= 5);
  // Only 0.22 * 100 = 22 contribution max from one full component
  assert.equal(sparse.fit_score, 22);
  assert.ok(sparse.fit_score < 30);
});


// ---------------------------------------------------------------------------
// 2. Treatment matrix A / B / C / D / hold
// ---------------------------------------------------------------------------

test('phase-05 treatment: matrix assigns A/B/C/D/enrichment_hold per design', () => {
  const cases = [
    { fit: 85, conf: 90, tier: 'A' },
    { fit: 85, conf: 70, tier: 'B' },
    { fit: 85, conf: 50, tier: 'B' }, // high-fit thin-evidence postcard exception path → B
    { fit: 85, conf: 30, tier: 'enrichment_hold' },
    { fit: 70, conf: 70, tier: 'B' },
    { fit: 70, conf: 90, tier: 'B' },
    { fit: 70, conf: 50, tier: 'C' },
    { fit: 70, conf: 30, tier: 'enrichment_hold' },
    { fit: 55, conf: 70, tier: 'C' },
    { fit: 55, conf: 90, tier: 'C' },
    { fit: 55, conf: 50, tier: 'D' },
    { fit: 40, conf: 90, tier: 'D' },
    { fit: 20, conf: 20, tier: 'D' },
    { fit: null, conf: 90, tier: 'enrichment_hold' },
  ];
  for (const c of cases) {
    const r = assignTreatmentTier({
      fitScore: c.fit,
      fitEvidenceConfidence: c.conf,
    });
    assert.equal(
      r.tier,
      c.tier,
      `fit=${c.fit} conf=${c.conf} expected ${c.tier}, got ${r.tier} (${r.reasons.join(';')})`,
    );
  }
  assert.equal(TREATMENT_RULE_VERSION, 'treatment-calculation-v1');
});

/** Full production GT-passing input (all multi-domain gates). */
const gtPassBase = () => ({
  treatmentTier: 'A',
  fitScore: 90,
  fitEvidenceConfidence: 90,
  identityConfidence: 90,
  classificationConfidence: 90,
  buyerConfidence: 80,
  mailConfidence: 90,
  timingScore: 75,
  strongTimingSignalCount: 0,
  mailAddressReady: true,
  assetReady: true,
  namedBuyerStatus: 'confirmed',
  namedBuyerName: 'Alex Rivera',
  buyerAffiliationStatus: 'confirmed',
  buyingCenterRole: 'owner',
  localBuyingAuthority: 'confirmed',
  cohortCapacityOk: true,
  suppressed: false,
  materialContradiction: false,
  cumulativeEnrichmentCostUsd: 1,
});

test('phase-05 treatment: mail_treatment independent; A/B postcard; C/D none by default', () => {
  // Tier A with full GT matrix → golden_ticket
  const tierA = assignTreatmentAndMail({
    fitScore: 90,
    fitEvidenceConfidence: 90,
    identityConfidence: 90,
    classificationConfidence: 90,
    buyerConfidence: 80,
    mailConfidence: 90,
    timingScore: 75,
    mailAddressReady: true,
    namedBuyerStatus: 'confirmed',
    namedBuyerName: 'Alex Rivera',
    buyerAffiliationStatus: 'confirmed',
    buyingCenterRole: 'owner',
    localBuyingAuthority: 'likely',
    cohortCapacityOk: true,
    goldenTicketGates: { assetReady: true, mailReady: true, cohortCapacityOk: true },
    cumulativeEnrichmentCostUsd: 1,
  });
  assert.equal(tierA.treatment_tier, 'A');
  assert.equal(tierA.mail_treatment, 'golden_ticket');

  // Tier A missing named buyer / timing / cohort → postcard still allowed when identity+mail ok
  const tierAPostcard = assignTreatmentAndMail({
    fitScore: 90,
    fitEvidenceConfidence: 90,
    identityConfidence: 90,
    buyerConfidence: 80,
    mailAddressReady: true,
    goldenTicketGates: { assetReady: true, mailReady: true },
    cumulativeEnrichmentCostUsd: 1,
  });
  assert.equal(tierAPostcard.treatment_tier, 'A');
  assert.equal(tierAPostcard.mail_treatment, 'standard_postcard');
  assert.equal(tierAPostcard.high_confidence_mail_program_eligible, false);

  const tierB = assignTreatmentAndMail({
    fitScore: 70,
    fitEvidenceConfidence: 70,
    identityConfidence: 85,
    mailAddressReady: true,
  });
  assert.equal(tierB.treatment_tier, 'B');
  assert.equal(tierB.mail_treatment, 'standard_postcard');

  const tierC = assignTreatmentAndMail({
    fitScore: 55,
    fitEvidenceConfidence: 70,
    identityConfidence: 85,
    mailAddressReady: true,
  });
  assert.equal(tierC.treatment_tier, 'C');
  assert.equal(tierC.mail_treatment, 'none');

  const tierD = assignTreatmentAndMail({
    fitScore: 30,
    fitEvidenceConfidence: 80,
    identityConfidence: 85,
    mailAddressReady: true,
  });
  assert.equal(tierD.treatment_tier, 'D');
  assert.equal(tierD.mail_treatment, 'none');

  const hold = assignTreatmentAndMail({
    fitScore: 85,
    fitEvidenceConfidence: 25,
    identityConfidence: 85,
    mailAddressReady: true,
  });
  assert.equal(hold.treatment_tier, 'enrichment_hold');
  assert.equal(hold.mail_treatment, 'none');
});

test('phase-05 treatment: candidate tier is research-depth only (not outreach treatment)', () => {
  assert.equal(assignCandidateTier(90, treasureValleyCandidateTier).candidate_tier, 'A');
  assert.equal(assignCandidateTier(70, treasureValleyCandidateTier).candidate_tier, 'B');
  assert.equal(assignCandidateTier(55, treasureValleyCandidateTier).candidate_tier, 'C');
  assert.equal(assignCandidateTier(20, treasureValleyCandidateTier).candidate_tier, 'D');
  assert.equal(assignCandidateTier(null, treasureValleyCandidateTier).candidate_tier, 'hold');
  const budget = enrichmentBudgetRemaining({ candidateOrTreatment: 'B', spentUsd: 0.5, enrichmentBudget: treasureValleyEnrichmentBudget });
  assert.equal(budget.ceiling, 1);
  assert.ok(budget.withinBudget);
});

// ---------------------------------------------------------------------------
// 3. Priority ≠ fit mirror
// ---------------------------------------------------------------------------

test('phase-05 priority: not a mirror of fit (lane + rank)', () => {
  const highFitLowTiming = calculatePriority({
    fitScore: 90,
    timingScore: 10,
    treatmentTier: 'A',
  });
  const lowFitReply = calculatePriority({
    fitScore: 40,
    timingScore: 90,
    hasReplyOrInterest: true,
  });
  assert.equal(highFitLowTiming.priority_lane, 'outbound');
  assert.equal(lowFitReply.priority_lane, 'reply_interest');
  assert.ok(lowFitReply.lane_index < highFitLowTiming.lane_index);

  const sameFitDifferentTiming = [
    calculatePriority({ fitScore: 70, timingScore: 10 }),
    calculatePriority({ fitScore: 70, timingScore: 90 }),
  ];
  assert.notEqual(
    sameFitDifferentTiming[0].priority_rank,
    sameFitDifferentTiming[1].priority_rank,
  );
  // Rank formula is timing*0.55 + fit*0.35 + 10 — never equal to fit alone
  assert.notEqual(highFitLowTiming.priority_rank, 90);
  assert.equal(PRIORITY_RULE_VERSION, 'priority-arithmetic-v1');

  const enrich = calculatePriority({
    fitScore: 85,
    timingScore: 50,
    needsEnrichment: true,
    treatmentTier: 'enrichment_hold',
  });
  assert.equal(enrich.priority_lane, 'enrichment');

  const recycle = calculatePriority({
    fitScore: 30,
    timingScore: 10,
    isRecycleOrMonitor: true,
    treatmentTier: 'D',
  });
  assert.equal(recycle.priority_lane, 'recycle_monitoring');
});

test('phase-05 priority: applyOutboundPolicy does not set priority_rank = fit_score', () => {
  const breakdown = fullBreakdown({
    operational_coordination_burden: 9,
    repetition_and_volume: 9,
    economic_impact_potential: 9,
    operating_scale_surface_area: 9,
    mission_delivery_compatibility: 9,
    local_buying_autonomy: 9,
  });
  const fit = calculateFitScore(fitComponentsFromBreakdown(breakdown, treasureValleyFitModel), treasureValleyFitModel);
  const r = applyOutboundPolicy({
    record: {
      _row_id: 'pri_1',
      fit_score: fit.fit_score,
      score_breakdown: JSON.stringify(breakdown),
      identity_confidence: 90,
      buyer_confidence: 80,
      classification_confidence: 90,
      address_rdi: 'Commercial',
      timing_score: 10,
      named_buyer_status: 'confirmed',
      observed_buyer_name: 'Alex Rivera',
      buyer_affiliation_status: 'confirmed',
      buying_center_role: 'owner',
    },
    recomputeFitFromBreakdown: true,
  });
  assert.ok(Number(r.patch.fit_score) >= 85);
  assert.notEqual(Number(r.priority_rank), Number(r.patch.fit_score));
  assert.equal(r.priority_lane, 'outbound');
  // Same fit, higher timing → higher rank through full apply path
  const r2 = applyOutboundPolicy({
    record: {
      _row_id: 'pri_2',
      fit_score: fit.fit_score,
      score_breakdown: JSON.stringify(breakdown),
      identity_confidence: 90,
      buyer_confidence: 80,
      classification_confidence: 90,
      address_rdi: 'Commercial',
      timing_score: 90,
      named_buyer_status: 'confirmed',
      observed_buyer_name: 'Alex Rivera',
      buyer_affiliation_status: 'confirmed',
      buying_center_role: 'owner',
    },
    recomputeFitFromBreakdown: true,
  });
  assert.ok(r2.priority_rank > r.priority_rank);
});

// ---------------------------------------------------------------------------
// 4. Hard readiness when enforce_readiness
// ---------------------------------------------------------------------------

test('phase-05 readiness: enforce_readiness hard-blocks non-ready send_email', () => {
  const weakIdentity = {
    _row_id: 'ready_1',
    identity_confidence: 40,
    treatment_tier: 'B',
    eligibility_outcome: 'eligible',
    contact_email: 'owner@example.test',
    email_confidence: 90,
    email_verification_confidence: 90,
    fit_evidence_confidence: 70,
    next_action_json: JSON.stringify({ action_id: 'na_1', action_type: 'send_email' }),
    preliminary_snapshot: 'snap',
    claim_audit_passed: 1,
  };

  const hard = guardChannelExecution({
    config: {
      policy: {
        enforce_readiness: true,
        forbidden_channels: ['send_sms', 'visit'],
      },
    },
    record: weakIdentity,
    stepKind: 'send_email',
    intent: 'send',
  });
  assert.equal(hard.allowed, false);
  assert.match(String(hard.reason), /readiness_not_ready/);
  assert.ok(
    (hard.blockers || []).some((b) => String(b).includes('identity_confidence')),
  );

  // Off / soft: same weak record is not hard-blocked by readiness
  const soft = guardChannelExecution({
    config: {
      policy: {
        enforce_readiness: false,
        forbidden_channels: ['send_sms', 'visit'],
      },
    },
    record: weakIdentity,
    stepKind: 'send_email',
    intent: 'send',
  });
  assert.equal(soft.allowed, true);

  // Draft intent exempt even when enforce_readiness true
  const draft = guardChannelExecution({
    config: {
      policy: { enforce_readiness: true, forbidden_channels: [] },
    },
    record: weakIdentity,
    stepKind: 'send_email',
    intent: 'draft',
  });
  assert.equal(draft.allowed, true);

  // dryRun exempt
  const dry = guardChannelExecution({
    config: {
      policy: { enforce_readiness: true, forbidden_channels: [] },
    },
    record: weakIdentity,
    stepKind: 'send_email',
    intent: 'send',
    dryRun: true,
  });
  assert.equal(dry.allowed, true);
});

test('phase-05 safety: empty treatment tier blocks external sends when readiness enforcement is off', () => {
  const config = { policy: { enforce_readiness: false } };
  for (const { stepKind, channel } of [
    { stepKind: 'send_email', channel: 'email' },
    { stepKind: 'linkedin_connect', channel: 'linkedin' },
  ]) {
    const guard = guardChannelExecution({
      config,
      record: { _row_id: `empty-tier-${stepKind}`, treatment_tier: '' },
      stepKind,
      channel,
      intent: 'send',
    });
    assert.equal(guard.allowed, false, stepKind);
    assert.equal(guard.reason, 'treatment_not_configured', stepKind);
    assert.deepEqual(guard.blockers, ['treatment_not_configured'], stepKind);
  }
});

test('phase-05 readiness: declared tier channel policy is enforced', () => {
  const readyRecord = {
    _row_id: 'ready_ok',
    identity_confidence: 90,
    treatment_tier: 'A',
    eligibility_outcome: 'eligible',
    contact_email: 'owner@example.test',
    email_confidence: 90,
    email_verification_confidence: 90,
    fit_evidence_confidence: 90,
    buyer_confidence: 80,
    named_buyer_status: 'confirmed',
    observed_buyer_name: 'Alex Rivera',
    buyer_affiliation_status: 'confirmed',
    buying_center_role: 'owner',
    next_action_json: JSON.stringify({ action_id: 'na_ok', action_type: 'send_email' }),
    preliminary_snapshot: 'snap',
    claim_audit_passed: 1,
  };
  const ok = guardChannelExecution({
    config: {
      policy: { enforce_readiness: true },
      contact_policy: { tiers: { A: { permitted_channels: ['email'] } } },
    },
    record: readyRecord,
    stepKind: 'send_email',
    intent: 'send',
  });
  assert.equal(ok.allowed, true, `expected allow, got ${JSON.stringify(ok)}`);

  const hold = guardChannelExecution({
    config: {
      policy: { enforce_readiness: true },
      contact_policy: { tiers: { enrichment_hold: { permitted_channels: [] } } },
    },
    record: { ...readyRecord, treatment_tier: 'enrichment_hold' },
    stepKind: 'send_email',
    intent: 'send',
  });
  assert.equal(hold.allowed, false);
  assert.ok((hold.blockers || []).includes('tier_channel_not_permitted'));
});

test('phase-05 readiness: evaluateOutboundReadiness blocks weak identity and tier-C cold calls', () => {
  const weak = evaluateOutboundReadiness({
    eligible: true,
    suppressed: false,
    identityConfidence: 50,
    materialContradiction: false,
    treatmentTier: 'B',
    channels: { email: { ready: true, confidence: 90 } },
    contentReady: true,
    claimAuditPassed: true,
    withinBudget: true,
    hasNextAction: true,
    proposedAction: { channel: 'email', kind: 'send_email' },
  });
  assert.equal(weak.ready, false);
  assert.ok(weak.blockers.includes('identity_confidence_below_80'));

  const tierCPhone = evaluateOutboundReadiness({
    eligible: true,
    suppressed: false,
    identityConfidence: 90,
    materialContradiction: false,
    treatmentTier: 'C',
    channels: { phone: { ready: true, confidence: 90 } },
    contentReady: true,
    claimAuditPassed: true,
    withinBudget: true,
    hasNextAction: true,
    contactPolicy: { tiers: { C: { permitted_channels: [] } } },
    confidenceProfile: {
      identity_confidence: 90,
      classification_confidence: 80,
      fit_evidence_confidence: 70,
      buyer_confidence: 60,
      timing_confidence: 40,
      phone_confidence: 90,
    },
    proposedAction: { channel: 'phone', kind: 'manual_task' },
  });
  assert.equal(tierCPhone.ready, false);
  assert.ok(tierCPhone.blockers.includes('tier_channel_not_permitted'));
});

// ---------------------------------------------------------------------------
// 5. Golden Ticket — full production multi-domain matrix
// ---------------------------------------------------------------------------

test('phase-05 golden ticket: identity confidence gate is mandatory', () => {
  const base = gtPassBase();

  const weakId = evaluateGoldenTicket({ ...base, identityConfidence: 50 });
  assert.equal(weakId.eligible, false);
  assert.ok(weakId.withheld.includes('identity_confidence_below_90'));

  const strongId = evaluateGoldenTicket({ ...base, identityConfidence: 90 });
  assert.equal(strongId.eligible, true, JSON.stringify(strongId.withheld));

  // Full assignTreatmentAndMail path: weak identity → not golden_ticket
  const fullWeak = assignTreatmentAndMail({
    fitScore: 90,
    fitEvidenceConfidence: 90,
    identityConfidence: 50,
    classificationConfidence: 90,
    buyerConfidence: 80,
    mailConfidence: 90,
    timingScore: 75,
    mailAddressReady: true,
    namedBuyerStatus: 'confirmed',
    namedBuyerName: 'Alex',
    buyerAffiliationStatus: 'confirmed',
    buyingCenterRole: 'owner',
    localBuyingAuthority: 'confirmed',
    cohortCapacityOk: true,
    goldenTicketGates: { assetReady: true, mailReady: true, cohortCapacityOk: true },
    cumulativeEnrichmentCostUsd: 1,
  });
  assert.equal(fullWeak.treatment_tier, 'A');
  assert.notEqual(fullWeak.mail_treatment, 'golden_ticket');
  assert.equal(fullWeak.mail_program_eligible, false);
  assert.ok(
    fullWeak.mail_withheld_reasons.some((w) => w.includes('identity_confidence_below_90')),
  );

  // applyOutboundPolicy surfaces the same gate
  const policyWeak = applyOutboundPolicy({
    record: {
      _row_id: 'gt_weak',
      fit_score: 90,
      fit_evidence_confidence: 90,
      identity_confidence: 50,
      classification_confidence: 90,
      buyer_confidence: 80,
      mail_confidence: 90,
      timing_score: 75,
      address_rdi: 'Commercial',
      mailing_address: '1 Main St',
      golden_ticket_asset_ready: true,
      named_buyer_status: 'confirmed',
      observed_buyer_name: 'Alex',
      buyer_affiliation_status: 'confirmed',
      buying_center_role: 'owner',
      local_buying_authority: 'confirmed',
      golden_ticket_cohort_ok: true,
      score_breakdown: JSON.stringify(fullBreakdown({
        operational_coordination_burden: 9,
        repetition_and_volume: 9,
        economic_impact_potential: 9,
        operating_scale_surface_area: 9,
        mission_delivery_compatibility: 9,
        local_buying_autonomy: 9,
      })),
    },
    recomputeFitFromBreakdown: true,
  });
  assert.equal(policyWeak.treatment_tier, 'A');
  assert.notEqual(policyWeak.mail_treatment, 'golden_ticket');
  assert.equal(policyWeak.patch.mail_program_eligible, 0);
});

test('phase-05 golden ticket: non-A tiers never eligible even with strong gates', () => {
  const g = evaluateGoldenTicket({
    ...gtPassBase(),
    treatmentTier: 'B',
  });
  assert.equal(g.eligible, false);
  assert.ok(g.withheld.includes('tier_not_declared_for_mail_program'));
});

test('phase-05 golden ticket: missing fitScore fails closed with fit_score_missing', () => {
  const g = evaluateGoldenTicket({
    ...gtPassBase(),
    fitScore: null,
  });
  assert.equal(g.eligible, false);
  assert.ok(g.withheld.includes('fit_score_missing'));
  assert.ok(!g.withheld.includes('fit_below_85'), 'null must not coerce into score-band fail');
});

test('phase-05 golden ticket: full production matrix → eligible', () => {
  const g = evaluateGoldenTicket(gtPassBase());
  assert.equal(g.eligible, true, JSON.stringify(g.withheld));
  assert.deepEqual(g.withheld, []);
  assert.ok(g.reasons.includes('tier_allows_mail_program'));
});

test('phase-05 golden ticket: multi-signal path can substitute for timing ≥ 70', () => {
  const g = evaluateGoldenTicket({
    ...gtPassBase(),
    timingScore: 40,
    strongTimingSignalCount: 2,
  });
  assert.equal(g.eligible, true, JSON.stringify(g.withheld));

  const weak = evaluateGoldenTicket({
    ...gtPassBase(),
    timingScore: 40,
    strongTimingSignalCount: 1,
  });
  assert.equal(weak.eligible, false);
  assert.ok(weak.withheld.includes('timing_or_correlated_signals_insufficient'));
});

test('phase-05 golden ticket: suppressed true → withheld', () => {
  const g = evaluateGoldenTicket({
    ...gtPassBase(),
    suppressed: true,
  });
  assert.equal(g.eligible, false);
  assert.ok(g.withheld.includes('suppressed'));
});

/**
 * Parameterized full TV GT matrix — every mandatory domain fails closed when
 * missing or below production threshold; all must pass for eligible.
 */
test('phase-05 golden ticket: full TV matrix table (parameterized fail-closed)', () => {
  const cases = [
    {
      name: 'all_gates_pass',
      patch: {},
      eligible: true,
      withheldAny: [],
    },
    {
      name: 'not_tier_a',
      patch: { treatmentTier: 'B' },
      eligible: false,
      withheldAny: ['not_tier_a'],
    },
    {
      name: 'fit_below_85',
      patch: { fitScore: 84 },
      eligible: false,
      withheldAny: ['fit_below_85'],
    },
    {
      name: 'fit_score_missing',
      patch: { fitScore: null },
      eligible: false,
      withheldAny: ['fit_score_missing'],
    },
    {
      name: 'fit_evidence_missing',
      patch: { fitEvidenceConfidence: null },
      eligible: false,
      withheldAny: ['fit_evidence_missing'],
    },
    {
      name: 'fit_evidence_below_80',
      patch: { fitEvidenceConfidence: 79 },
      eligible: false,
      withheldAny: ['fit_evidence_below_80'],
    },
    {
      name: 'identity_missing',
      patch: { identityConfidence: null },
      eligible: false,
      withheldAny: ['identity_confidence_missing'],
    },
    {
      name: 'identity_below_90',
      patch: { identityConfidence: 89 },
      eligible: false,
      withheldAny: ['identity_confidence_below_90'],
    },
    {
      name: 'classification_missing',
      patch: { classificationConfidence: null },
      eligible: false,
      withheldAny: ['classification_confidence_missing'],
    },
    {
      name: 'classification_below_90',
      patch: { classificationConfidence: 80 },
      eligible: false,
      withheldAny: ['classification_confidence_below_90'],
    },
    {
      name: 'buyer_confidence_missing',
      patch: { buyerConfidence: null },
      eligible: false,
      withheldAny: ['buyer_confidence_missing'],
    },
    {
      name: 'buyer_confidence_below_80',
      patch: { buyerConfidence: 79 },
      eligible: false,
      withheldAny: ['buyer_confidence_below_80'],
    },
    {
      name: 'mail_confidence_missing',
      patch: { mailConfidence: null },
      eligible: false,
      withheldAny: ['mail_confidence_missing'],
    },
    {
      name: 'mail_confidence_below_90',
      patch: { mailConfidence: 80 },
      eligible: false,
      withheldAny: ['mail_confidence_below_90'],
    },
    {
      name: 'mail_address_ready_missing',
      patch: { mailAddressReady: null },
      eligible: false,
      withheldAny: ['mail_address_ready_missing'],
    },
    {
      name: 'mail_address_not_ready',
      patch: { mailAddressReady: false },
      eligible: false,
      withheldAny: ['mail_address_not_ready'],
    },
    {
      name: 'asset_not_ready',
      patch: { assetReady: false },
      eligible: false,
      withheldAny: ['asset_not_ready'],
    },
    {
      name: 'asset_missing',
      patch: { assetReady: null },
      eligible: false,
      withheldAny: ['asset_not_ready'],
    },
    {
      name: 'named_buyer_status_missing',
      patch: { namedBuyerStatus: null },
      eligible: false,
      withheldAny: ['named_buyer_status_missing'],
    },
    {
      name: 'named_buyer_role_only',
      patch: { namedBuyerStatus: 'role_only' },
      eligible: false,
      withheldAny: ['named_buyer_not_confirmed'],
    },
    {
      name: 'named_buyer_name_missing',
      patch: { namedBuyerName: null },
      eligible: false,
      withheldAny: ['named_buyer_name_missing'],
    },
    {
      name: 'local_authority_missing',
      patch: { localBuyingAuthority: null },
      eligible: false,
      withheldAny: ['local_buying_authority_missing'],
    },
    {
      name: 'local_authority_no',
      patch: { localBuyingAuthority: 'no' },
      eligible: false,
      withheldAny: ['local_buying_authority_not_confirmed'],
    },
    {
      name: 'timing_and_signals_missing',
      patch: { timingScore: null, strongTimingSignalCount: null },
      eligible: false,
      withheldAny: ['timing_or_signals_missing'],
    },
    {
      name: 'timing_insufficient_one_signal',
      patch: { timingScore: 40, strongTimingSignalCount: 1 },
      eligible: false,
      withheldAny: ['timing_or_correlated_signals_insufficient'],
    },
    {
      name: 'cohort_missing',
      patch: { cohortCapacityOk: null },
      eligible: false,
      withheldAny: ['cohort_capacity_missing'],
    },
    {
      name: 'cohort_unavailable',
      patch: { cohortCapacityOk: false },
      eligible: false,
      withheldAny: ['cohort_capacity_unavailable'],
    },
    {
      name: 'suppressed',
      patch: { suppressed: true },
      eligible: false,
      withheldAny: ['suppressed'],
    },
    {
      name: 'material_contradiction',
      patch: { materialContradiction: true },
      eligible: false,
      withheldAny: ['material_contradiction'],
    },
    {
      name: 'budget_exceeded',
      patch: { cumulativeEnrichmentCostUsd: 9 },
      eligible: false,
      withheldAny: ['enrichment_budget_usd_exceeded'],
    },
    {
      name: 'multi_signal_ok_without_timing_70',
      patch: { timingScore: 30, strongTimingSignalCount: 2 },
      eligible: true,
      withheldAny: [],
    },
    {
      name: 'named_buyer_likely_ok',
      patch: { namedBuyerStatus: 'likely' },
      eligible: true,
      withheldAny: [],
    },
    {
      name: 'buyer_affiliation_status_missing',
      patch: { buyerAffiliationStatus: null },
      eligible: false,
      withheldAny: ['buyer_affiliation_status_missing'],
    },
    {
      name: 'buyer_affiliation_unresolved',
      patch: { buyerAffiliationStatus: 'unresolved' },
      eligible: false,
      withheldAny: ['buyer_affiliation_unresolved'],
    },
    {
      name: 'buying_center_role_missing',
      patch: { buyingCenterRole: null },
      eligible: false,
      withheldAny: ['buying_center_role_missing'],
    },
  ];

  for (const c of cases) {
    const g = evaluateGoldenTicket({ ...gtPassBase(), ...c.patch });
    assert.equal(
      g.eligible,
      c.eligible,
      `${c.name}: expected eligible=${c.eligible}, got ${g.eligible}; withheld=${JSON.stringify(g.withheld)}`,
    );
    for (const code of c.withheldAny) {
      const genericCode = {
        not_tier_a: 'tier_not_declared_for_mail_program',
        fit_below_85: 'fit_score_below_85',
        fit_evidence_missing: 'fit_evidence_confidence_missing',
        fit_evidence_below_80: 'fit_evidence_confidence_below_80',
        enrichment_budget_exceeded: 'enrichment_budget_usd_exceeded',
      }[code] || code;
      assert.ok(
        g.withheld.includes(genericCode),
        `${c.name}: expected withheld ${code}, got ${JSON.stringify(g.withheld)}`,
      );
    }
  }
});

test('phase-05 golden ticket: countStrongTimingSignals ignores stale_no_signal', () => {
  assert.equal(
    countStrongTimingSignals([
      { id: 'stale_no_signal', decayed_strength: 90 },
      { id: 'hiring_spike', decayed_strength: 70 },
      { id: 'expansion_signal', decayed_strength: 65 },
    ]),
    2,
  );
  assert.equal(
    countStrongTimingSignals([{ id: 'stale_no_signal', strength: 100 }]),
    0,
  );
});

// ---------------------------------------------------------------------------
// Inventable confidence negatives — never invent high/ready without evidence
// ---------------------------------------------------------------------------

test('phase-05 inventable-confidence: missing identity/buyer/classification → 0 not invented defaults', () => {
  const r = applyOutboundPolicy({
    record: {
      _row_id: 'inv_conf_1',
      fit_score: 90,
      fit_evidence_confidence: 90,
      // deliberately omit identity_confidence, buyer_confidence, classification_confidence
      score_breakdown: JSON.stringify(fullBreakdown({
        operational_coordination_burden: 9,
        repetition_and_volume: 9,
        economic_impact_potential: 9,
        operating_scale_surface_area: 9,
        mission_delivery_compatibility: 9,
        local_buying_autonomy: 9,
      })),
      address_rdi: 'Commercial',
      mailing_address: '1 Main',
    },
    recomputeFitFromBreakdown: true,
  });
  const readiness = JSON.parse(String(r.patch.readiness_json));
  // Missing identity must not invent 70 and pass readiness
  assert.ok(readiness.blockers.includes('identity_confidence_below_80'));
  assert.equal(r.readiness?.ready, false);
  // GT must not invent buyer/classification/named buyer
  assert.equal(r.patch.mail_program_eligible, 0);
  assert.notEqual(r.mail_treatment, 'golden_ticket');
});

test('phase-05 inventable-confidence: raw address does not invent mail_confidence ≥ 80', () => {
  const r = applyOutboundPolicy({
    record: {
      _row_id: 'inv_mail_1',
      fit_score: 90,
      fit_evidence_confidence: 90,
      identity_confidence: 90,
      buyer_confidence: 80,
      classification_confidence: 90,
      // address present but no mail_confidence field
      address_rdi: 'Commercial',
      mailing_address: '100 Main St, Boise ID',
      score_breakdown: JSON.stringify(fullBreakdown({
        operational_coordination_burden: 9,
        repetition_and_volume: 9,
        economic_impact_potential: 9,
        operating_scale_surface_area: 9,
        mission_delivery_compatibility: 9,
        local_buying_autonomy: 9,
      })),
    },
    recomputeFitFromBreakdown: true,
  });
  const readiness = JSON.parse(String(r.patch.readiness_json));
  // Channel ready may come from address_rdi via reachability, but confidence must not be invented to 80+
  const mailCh = readiness.permitted_channels?.includes('mail');
  // mail_confidence on profile path used for GT
  assert.equal(r.patch.mail_program_eligible, 0);
  // reachability confidence for mail with only rdi should be 0 (not invented 80)
  const reach = JSON.parse(String(r.patch.reachability_json));
  const mail = reach.channels.find((c) => c.channel === 'mail');
  assert.ok(mail);
  assert.equal(mail.confidence, 0, 'must not invent mail confidence from address_rdi');
  void mailCh;
});

test('phase-05 inventable-confidence: actionConfidenceAllows fails closed on missing channel conf', () => {
  const missing = actionConfidenceAllows({
    action: 'email',
    profile: {
      identity_confidence: 90,
      classification_confidence: 90,
      fit_evidence_confidence: 80,
      buyer_confidence: 80,
      timing_confidence: 50,
      // email_confidence omitted
    },
  });
  assert.equal(missing.allowed, false);
  assert.ok(missing.failing.some((f) => f.startsWith('email_confidence')));
  assert.equal(missing.used.email_confidence, 0);
});

test('phase-05 inventable-confidence: raw email without conf/validation is not ready', () => {
  const vector = evaluateReachability({
    contact_email: 'owner@example.test',
    // no email_confidence, no email_validated
  });
  const email = vector.channels.find((c) => c.channel === 'email');
  assert.equal(email.ready, false);
  assert.equal(email.confidence, 0);
  assert.equal(email.state, 'unvalidated');
});

// ---------------------------------------------------------------------------
// Production score → applyOutboundPolicy path (pure contract)
// ---------------------------------------------------------------------------

test('phase-05 production path: same evidence bundle → explainable fit/priority/treatment/readiness', () => {
  // Mirrors scoring/runner.ts post-process: breakdown grades → calculateFitScore
  // → applyOutboundPolicy({ recomputeFitFromBreakdown }) → patch fields.
  const breakdown = fullBreakdown({
    operational_coordination_burden: 8,
    repetition_and_volume: 8,
    economic_impact_potential: 7,
    operating_scale_surface_area: 7,
    mission_delivery_compatibility: 8,
    local_buying_autonomy: 9,
  });
  const fitComponents = fitComponentsFromBreakdown(breakdown, treasureValleyFitModel);
  const fitCalc = calculateFitScore(fitComponents, treasureValleyFitModel);
  const fitEvidence = deriveFitEvidenceConfidence(breakdown, treasureValleyFitModel);
  assert.ok(fitEvidence >= 80, `full reasoned breakdown should yield high fit evidence, got ${fitEvidence}`);

  const prePolicy = {
    _row_id: 'path_hvac_1',
    business_name: 'Boise Peak HVAC',
    fit_score: fitCalc.fit_score,
    score_breakdown: JSON.stringify(breakdown),
    identity_confidence: 90,
    buyer_confidence: 75,
    timing_score: 20,
    address_rdi: 'Commercial',
    contact_email: 'owner@example-hvac.test',
    email_confidence: 85,
    company_resolution: 'resolved',
    is_a_business: 1,
  };

  const policy = applyOutboundPolicy({
    record: prePolicy,
    recomputeFitFromBreakdown: true,
  });

  // Explainable outputs always present
  assert.equal(Number(policy.patch.fit_score), fitCalc.fit_score);
  assert.ok(policy.patch.fit_calculation_json);
  assert.ok(policy.patch.treatment_json);
  assert.ok(policy.patch.priority_json);
  assert.ok(policy.patch.readiness_json);
  assert.ok(policy.patch.evidence_resolution_json);
  assert.ok(policy.patch.next_action_json);
  assert.ok(['A', 'B', 'C', 'D', 'enrichment_hold'].includes(policy.treatment_tier));
  assert.ok(['none', 'standard_postcard', 'golden_ticket'].includes(policy.mail_treatment));
  assert.ok(policy.priority_lane);
  assert.ok(typeof policy.priority_rank === 'number');

  const treatment = JSON.parse(String(policy.patch.treatment_json));
  assert.equal(treatment.calculation_rule_version, 'treatment-calculation-v1');
  assert.ok(Array.isArray(treatment.reasons) && treatment.reasons.length > 0);

  const priority = JSON.parse(String(policy.patch.priority_json));
  assert.equal(priority.calculation_rule_version, 'priority-arithmetic-v1');
  assert.notEqual(priority.priority_rank, fitCalc.fit_score);

  const readiness = policy.readiness;
  assert.ok(readiness);
  // High identity + email present → readiness not blocked solely by missing score permission
  // Score does not fabricate permission: readiness is separate and can still block.
  assert.ok(Array.isArray(readiness.blockers));

  // Score alone never authorizes: weak identity on same commercial grades → not ready
  const weak = applyOutboundPolicy({
    record: { ...prePolicy, identity_confidence: 40 },
    recomputeFitFromBreakdown: true,
  });
  assert.equal(Number(weak.patch.fit_score), fitCalc.fit_score); // same commercial fit
  assert.equal(weak.readiness?.ready, false);
  assert.ok(weak.readiness?.blockers.includes('identity_confidence_below_80'));

  // Action confidence is action-specific — high phone conf does not authorize weak email
  const conf = actionConfidenceAllows({
    action: 'email',
    profile: {
      identity_confidence: 90,
      classification_confidence: 80,
      fit_evidence_confidence: 70,
      buyer_confidence: 60,
      timing_confidence: 50,
      email_confidence: 40,
      phone_confidence: 95,
    },
  });
  assert.equal(conf.allowed, false);
});

test('phase-05 production path: postcard eligibility still requires mail ready + identity', () => {
  const noMail = evaluateStandardPostcard({
    treatmentTier: 'B',
    fitScore: 70,
    fitEvidenceConfidence: 70,
    mailAddressReady: false,
    identityConfidence: 90,
  });
  assert.equal(noMail.eligible, false);
  assert.ok(noMail.withheld.includes('mail_address_not_ready'));

  const weakId = evaluateStandardPostcard({
    treatmentTier: 'B',
    fitScore: 70,
    fitEvidenceConfidence: 70,
    mailAddressReady: true,
    identityConfidence: 50,
  });
  assert.equal(weakId.eligible, false);
  assert.ok(weakId.withheld.includes('identity_confidence_below_80'));
});

// ---------------------------------------------------------------------------
// Closures: timing-reachability, cost-ledger (explainable on same bundle)
// ---------------------------------------------------------------------------

test('phase-05 timing: signal registry decays; apply writes timing_json (not scalar-only)', () => {
  const asOf = '2026-08-01T00:00:00.000Z';
  const fresh = {
    id: 'hiring_spike',
    strength: 80,
    observed_at: '2026-07-20T00:00:00.000Z',
    half_life_days: 45,
  };
  const old = {
    id: 'hiring_spike',
    strength: 80,
    observed_at: '2025-01-01T00:00:00.000Z',
    half_life_days: 45,
  };
  assert.ok(decayStrength(fresh, asOf) > decayStrength(old, asOf));
  assert.equal(decayStrength({ ...fresh, expires_at: '2026-07-01T00:00:00.000Z' }, asOf), 0);

  const calc = calculateTimingScore(
    {
      timing_signals_json: JSON.stringify([fresh]),
    },
    asOf,
  );
  assert.equal(calc.calculation_rule_version, TIMING_RULE_VERSION);
  assert.ok(calc.timing_score > 0);
  assert.ok(calc.expires_at);
  assert.equal(calc.signals[0].decayed_strength, decayStrength(fresh, asOf));

  const policy = applyOutboundPolicy({
    record: {
      _row_id: 'timing_1',
      fit_score: 70,
      fit_evidence_confidence: 70,
      identity_confidence: 90,
      timing_signals_json: JSON.stringify([fresh]),
      score_breakdown: JSON.stringify(fullBreakdown()),
    },
    recomputeFitFromBreakdown: true,
  });
  assert.ok(policy.patch.timing_json);
  const timing = JSON.parse(String(policy.patch.timing_json));
  assert.equal(timing.calculation_rule_version, 'timing-v1');
  assert.ok(Array.isArray(timing.signals) && timing.signals.length >= 1);
  assert.equal(Number(policy.patch.timing_score), timing.timing_score);
  // Timing feeds priority rank (not fit alone)
  const lowTiming = applyOutboundPolicy({
    record: {
      _row_id: 'timing_2',
      fit_score: 70,
      fit_evidence_confidence: 70,
      identity_confidence: 90,
      timing_score: 5,
      score_breakdown: JSON.stringify(fullBreakdown()),
    },
    recomputeFitFromBreakdown: true,
  });
  assert.ok(policy.priority_rank > lowTiming.priority_rank);
});

test('phase-05 reachability: named channel states; apply writes reachability_json', () => {
  const vector = evaluateReachability({
    contact_email: 'owner@example.test',
    email_verification_status: 'verified',
    email_verification_confidence: 90,
    phone: '+12085551212',
    phone_confidence: 40,
    linkedin_url: 'https://linkedin.com/in/example',
    linkedin_confidence: 70,
  });
  assert.equal(vector.calculation_rule_version, REACHABILITY_RULE_VERSION);
  const byCh = Object.fromEntries(vector.channels.map((c) => [c.channel, c]));
  assert.equal(byCh.email.state, 'named_validated');
  assert.equal(byCh.email.ready, true);
  assert.equal(byCh.phone.state, 'unvalidated');
  assert.equal(byCh.linkedin.state, 'invite_ready');
  assert.equal(byCh.linkedin.ready, true);
  assert.equal(byCh.mail.state, 'missing');

  const opted = evaluateReachability({
    contact_email: 'x@y.test',
    email_opted_out: true,
  });
  assert.equal(opted.channels.find((c) => c.channel === 'email')?.state, 'opted_out');
  assert.equal(opted.channels.find((c) => c.channel === 'email')?.ready, false);

  const policy = applyOutboundPolicy({
    record: {
      _row_id: 'reach_1',
      fit_score: 70,
      fit_evidence_confidence: 70,
      identity_confidence: 90,
      contact_email: 'owner@example.test',
      email_verification_status: 'verified',
      email_verification_confidence: 90,
      score_breakdown: JSON.stringify(fullBreakdown()),
    },
    recomputeFitFromBreakdown: true,
  });
  assert.ok(policy.patch.reachability_json);
  const reach = JSON.parse(String(policy.patch.reachability_json));
  assert.equal(reach.calculation_rule_version, 'reachability-v1');
  const email = reach.channels.find((c) => c.channel === 'email');
  assert.equal(email.state, 'named_validated');
  assert.equal(email.ready, true);
});

test('phone reachability: structured, well-formed source evidence persists a usable channel', () => {
  const sourced = {
    phone: '+12085551212',
    phone_source_kind: 'structured',
  };
  const phoneConfidence = derivePhoneConfidence(sourced);
  assert.equal(phoneConfidence, 85);

  const policy = applyOutboundPolicy({
    record: { _row_id: 'phone_source_1', ...sourced },
  });
  assert.equal(policy.patch.phone_confidence, phoneConfidence);

  const reachability = evaluateReachability({ ...sourced, phone_confidence: phoneConfidence });
  const phone = reachability.channels.find((channel) => channel.channel === 'phone');
  assert.equal(phone?.state, 'named_validated');
  assert.equal(phone?.ready, true);

  const readiness = evaluateOutboundReadiness({
    eligible: true,
    suppressed: false,
    identityConfidence: 90,
    materialContradiction: false,
    treatmentTier: 'B',
    channels: { phone: { ready: phone?.ready === true, confidence: phone?.confidence } },
    contentReady: true,
    withinBudget: true,
    collision: false,
    hasNextAction: true,
  });
  assert.ok(readiness.permitted_channels.includes('phone'));
});

test('phone reachability: absent, malformed, and structurally suppressed phones remain excluded', () => {
  const records = [
    {},
    { phone: 'not a phone', phone_source_kind: 'structured' },
    { phone: '+12085551212', phone_source_kind: 'structured', dne_phone: true },
  ];

  for (const record of records) {
    const phoneConfidence = derivePhoneConfidence(record);
    const reachability = evaluateReachability({ ...record, phone_confidence: phoneConfidence });
    const phone = reachability.channels.find((channel) => channel.channel === 'phone');
    assert.equal(phone?.ready, false);

    const readiness = evaluateOutboundReadiness({
      eligible: true,
      suppressed: false,
      identityConfidence: 90,
      materialContradiction: false,
      treatmentTier: 'B',
      channels: { phone: { ready: phone?.ready === true, confidence: phone?.confidence } },
      contentReady: true,
      withinBudget: true,
      collision: false,
      hasNextAction: true,
    });
    assert.ok(!readiness.permitted_channels.includes('phone'));
  }
});

test('phase-05 cost-ledger: ceilings feed readiness; overspend does not authorize send', () => {
  let ledger = parseCostLedger(null, 'cost_acct');
  ledger = appendCostEntry(ledger, { kind: 'enrichment', amount_usd: 5 });
  assert.equal(ledger.ledger_version, COST_LEDGER_VERSION);
  assert.ok(ledger.enrichment_usd >= 5);

  const overC = withinEnrichmentCeiling({
    enrichmentBudget: treasureValleyEnrichmentBudget,
    treatment_tier: 'C',
    enrichment_usd: ledger.enrichment_usd,
  });
  assert.equal(overC.within_budget, false);

  const policy = applyOutboundPolicy({
    record: {
      _row_id: 'cost_1',
      fit_score: 55,
      fit_evidence_confidence: 70,
      identity_confidence: 90,
      treatment_tier: 'C',
      cost_ledger_json: JSON.stringify(ledger),
      contact_email: 'owner@example.test',
      email_confidence: 90,
      email_verification_confidence: 90,
      score_breakdown: JSON.stringify(
        fullBreakdown({
          operational_coordination_burden: 6,
          repetition_and_volume: 5,
          economic_impact_potential: 6,
          operating_scale_surface_area: 5,
          mission_delivery_compatibility: 6,
          local_buying_autonomy: 5,
        }),
      ),
      preliminary_snapshot: 'snap',
      claim_audit_passed: 1,
      next_action_json: JSON.stringify({ action_id: 'na_cost', action_type: 'send_email' }),
    },
    recomputeFitFromBreakdown: true,
    enrichmentBudget: treasureValleyEnrichmentBudget,
  });
  assert.ok(policy.patch.cost_ledger_json);
  assert.equal(Number(policy.patch.within_enrichment_budget), 0);
  assert.equal(policy.readiness?.ready, false);
  assert.ok(policy.readiness?.blockers.includes('budget_exceeded'));

  // Hard enforce_readiness path uses the same cost ceiling (not a score override)
  const hard = guardChannelExecution({
    config: {
      policy: { enforce_readiness: true, forbidden_channels: [] },
      score: { enrichment_budget: treasureValleyEnrichmentBudget },
    },
    record: {
      _row_id: 'cost_guard',
      identity_confidence: 90,
      treatment_tier: 'C',
      eligibility_outcome: 'eligible',
      contact_email: 'owner@example.test',
      email_confidence: 90,
      email_verification_confidence: 90,
      fit_evidence_confidence: 70,
      cost_ledger_json: JSON.stringify(ledger),
      next_action_json: JSON.stringify({ action_id: 'na_cost2', action_type: 'send_email' }),
      preliminary_snapshot: 'snap',
      claim_audit_passed: 1,
    },
    stepKind: 'send_email',
    intent: 'send',
  });
  assert.equal(hard.allowed, false);
  assert.ok((hard.blockers || []).includes('budget_exceeded'));
});

test('phase-05 complete-when: one evidence bundle → all eight outcomes; score ≠ permission', () => {
  const asOfSignals = [
    {
      id: 'expansion_signal',
      strength: 70,
      observed_at: new Date().toISOString(),
      half_life_days: 60,
      evidence_ids: ['obs_expand_1'],
    },
  ];
  const breakdown = fullBreakdown({
    operational_coordination_burden: 8,
    repetition_and_volume: 7,
    economic_impact_potential: 8,
    operating_scale_surface_area: 7,
    mission_delivery_compatibility: 8,
    local_buying_autonomy: 8,
  });
  const record = {
    _row_id: 'cw_bundle_1',
    business_name: 'Meridian HVAC Co',
    score_breakdown: JSON.stringify(breakdown),
    identity_confidence: 90,
    buyer_confidence: 70,
    timing_signals_json: JSON.stringify(asOfSignals),
    contact_email: 'ops@meridian-hvac.test',
    email_confidence: 85,
    email_validated: true,
    address_rdi: 'Commercial',
    mailing_address: '100 Main St, Boise ID',
    mail_confidence: 80,
    is_a_business: 1,
    company_resolution: 'resolved',
    enrichment_cost_usd: 0.2,
    preliminary_snapshot: 'public site + maps',
    claim_audit_passed: 1,
  };

  const a = applyOutboundPolicy({ record, recomputeFitFromBreakdown: true });
  const b = applyOutboundPolicy({ record, recomputeFitFromBreakdown: true });

  // Deterministic commercial outcomes
  assert.equal(Number(a.patch.fit_score), Number(b.patch.fit_score));
  assert.equal(a.treatment_tier, b.treatment_tier);
  assert.equal(a.mail_treatment, b.mail_treatment);
  assert.equal(a.priority_lane, b.priority_lane);
  assert.equal(a.priority_rank, b.priority_rank);

  // All eight explainability surfaces present
  assert.ok(a.patch.fit_calculation_json); // fit
  assert.ok(a.patch.fit_evidence_confidence != null && a.patch.fit_evidence_confidence !== ''); // confidence
  assert.ok(a.patch.timing_json); // timing
  assert.ok(a.patch.reachability_json); // reachability
  assert.ok(a.patch.priority_json); // priority
  assert.ok(a.patch.treatment_json); // treatment
  assert.ok(['none', 'standard_postcard', 'golden_ticket'].includes(a.mail_treatment)); // mail treatment
  assert.ok(a.patch.readiness_json); // readiness

  const timing = JSON.parse(String(a.patch.timing_json));
  const reach = JSON.parse(String(a.patch.reachability_json));
  const treatment = JSON.parse(String(a.patch.treatment_json));
  const priority = JSON.parse(String(a.patch.priority_json));
  const readiness = JSON.parse(String(a.patch.readiness_json));
  const fitCalc = JSON.parse(String(a.patch.fit_calculation_json));

  assert.equal(fitCalc.calculation_rule_version, FIT_ARITHMETIC_RULE_VERSION);
  assert.equal(timing.calculation_rule_version, 'timing-v1');
  assert.equal(reach.calculation_rule_version, 'reachability-v1');
  assert.equal(treatment.calculation_rule_version, 'treatment-calculation-v1');
  assert.equal(priority.calculation_rule_version, 'priority-arithmetic-v1');
  assert.ok(Array.isArray(treatment.reasons) && treatment.reasons.length > 0);
  assert.ok(Array.isArray(readiness.blockers));
  assert.notEqual(priority.priority_rank, fitCalc.fit_score);

  // Score does not fabricate permission: identical commercial grades, weak identity → not ready
  // and hard guard blocks send even when fit remains high.
  const weak = applyOutboundPolicy({
    record: { ...record, identity_confidence: 35 },
    recomputeFitFromBreakdown: true,
  });
  assert.equal(Number(weak.patch.fit_score), Number(a.patch.fit_score));
  assert.equal(weak.readiness?.ready, false);
  assert.ok(weak.readiness?.blockers.includes('identity_confidence_below_80'));

  const hard = guardChannelExecution({
    config: { policy: { enforce_readiness: true, forbidden_channels: [] } },
    record: {
      ...record,
      ...weak.patch,
      identity_confidence: 35,
      next_action_json: JSON.stringify({ action_id: 'na_cw', action_type: 'send_email' }),
    },
    stepKind: 'send_email',
    intent: 'send',
  });
  assert.equal(hard.allowed, false);
  assert.match(String(hard.reason), /readiness_not_ready/);
});
