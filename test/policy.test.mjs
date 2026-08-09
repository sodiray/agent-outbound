/**
 * Deterministic policy module tests — drives real shipped functions from dist/.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig } from '../dist/schemas/config.js';
import {
  assignTreatmentAndMail,
  assignTreatmentTier,
  evaluateGoldenTicket,
  enrichmentBudgetRemaining,
} from '../dist/orchestrator/policy/treatment.js';
import {
  treasureValleyGoldenTicket,
  treasureValleyCandidateTier,
  treasureValleyPostcard,
  treasureValleyTreatmentStrategy,
} from './fixtures/treatment-strategy.mjs';
import {
  calculateFitScore,
  calculatePriority,
  actionConfidenceAllows,
  assignCandidateTier,
} from '../dist/orchestrator/policy/scoring.js';
import { treasureValleyFitModel } from './fixtures/fit-model.mjs';
import {
  checkStateIntegrity,
  completeActionAndCreateSuccessor,
  createInitialColdState,
  canTransitionLifecycle,
  assertLifecycleTransition,
} from '../dist/orchestrator/policy/lifecycle.js';
import {
  buildContactPlan,
  rotateContact,
  allocateMail,
  assertActionTarget,
  applyContactRotation,
} from '../dist/orchestrator/policy/contact-campaign.js';
import { calculateEconomicScenario } from '../dist/orchestrator/policy/economics.js';
import {
  evaluateOutboundReadiness,
  classifyEligibility,
} from '../dist/orchestrator/policy/readiness.js';
import { findProhibitedSteps, assertWorkAllowed } from '../dist/orchestrator/policy/pipeline-prohibitions.js';

test('fit score weights come from the pipeline and exclude walk-in/HIPAA components', () => {
  const sum = treasureValleyFitModel.criteria.reduce((total, criterion) => total + criterion.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  const ids = treasureValleyFitModel.criteria.map((criterion) => criterion.id);
  assert.equal(ids.includes('walk_in_decision_maker_access'), false);
  assert.equal(ids.includes('hipaa_exposure'), false);
  assert.equal(ids.includes('ticket_size'), false);
});

test('calculateFitScore is deterministic and reproducible', () => {
  const components = [
    { id: 'operational_coordination_burden', grade: 8, evidence_ids: ['e1'] },
    { id: 'repetition_and_volume', grade: 7 },
    { id: 'economic_impact_potential', grade: 8 },
    { id: 'operating_scale_surface_area', grade: 6 },
    { id: 'mission_delivery_compatibility', grade: 7 },
    { id: 'local_buying_autonomy', grade: 9 },
  ];
  const a = calculateFitScore(components, treasureValleyFitModel);
  const b = calculateFitScore(components, treasureValleyFitModel);
  assert.equal(a.fit_score, b.fit_score);
  assert.ok(a.fit_score >= 70 && a.fit_score <= 85);
  assert.equal(a.missing_inputs.length, 0);
  assert.equal(a.fit_model_version, 'tv-fit-v1');
});

test('missing fit components do not invent values', () => {
  const r = calculateFitScore([
    { id: 'operational_coordination_burden', grade: 10 },
  ], treasureValleyFitModel);
  assert.ok(r.missing_inputs.includes('repetition_and_volume'));
  assert.ok(r.fit_score < 30);
});

test('priority is not a mirror of fit', () => {
  const highFitLowTiming = calculatePriority({
    fitScore: 90,
    timingScore: 10,
    treatmentTier: 'A',
  });
  const lowFitHighTimingReply = calculatePriority({
    fitScore: 40,
    timingScore: 90,
    hasReplyOrInterest: true,
  });
  assert.equal(lowFitHighTimingReply.priority_lane, 'reply_interest');
  assert.equal(highFitLowTiming.priority_lane, 'outbound');
  assert.ok(lowFitHighTimingReply.lane_index < highFitLowTiming.lane_index);
  // Same fit different timing → different rank
  const t1 = calculatePriority({ fitScore: 70, timingScore: 10 });
  const t2 = calculatePriority({ fitScore: 70, timingScore: 90 });
  assert.notEqual(t1.priority_rank, t2.priority_rank);
});

test('declared treatment matrix assigns the pipeline tiers', () => {
  assert.equal(assignTreatmentTier({ fitScore: 85, fitEvidenceConfidence: 90, treatmentStrategy: treasureValleyTreatmentStrategy }).tier, 'A');
  assert.equal(assignTreatmentTier({ fitScore: 85, fitEvidenceConfidence: 70, treatmentStrategy: treasureValleyTreatmentStrategy }).tier, 'B');
  assert.equal(assignTreatmentTier({ fitScore: 70, fitEvidenceConfidence: 70, treatmentStrategy: treasureValleyTreatmentStrategy }).tier, 'B');
  assert.equal(assignTreatmentTier({ fitScore: 55, fitEvidenceConfidence: 70, treatmentStrategy: treasureValleyTreatmentStrategy }).tier, 'C');
  assert.equal(assignTreatmentTier({ fitScore: 40, fitEvidenceConfidence: 90, treatmentStrategy: treasureValleyTreatmentStrategy }).tier, 'D');
  assert.equal(assignTreatmentTier({ fitScore: 85, fitEvidenceConfidence: 30, treatmentStrategy: treasureValleyTreatmentStrategy }).tier, 'enrichment_hold');
  assert.equal(assignTreatmentTier({ fitScore: null, fitEvidenceConfidence: 90, treatmentStrategy: treasureValleyTreatmentStrategy }).tier, 'enrichment_hold');
});

test('declared treatment bands control the assigned tier', () => {
  const config = normalizeConfig({ score: { treatment: treasureValleyTreatmentStrategy } }).config;

  const cases = [
    { score: 49.9, label: 'below50', tier: 'D' },
    { score: 50, label: '50-64', tier: 'C' },
    { score: 64.9, label: '50-64', tier: 'C' },
    { score: 65, label: '65-79', tier: 'B' },
    { score: 79.9, label: '65-79', tier: 'B' },
    { score: 80, label: '80-100', tier: 'A' },
  ];
  for (const item of cases) {
    const result = assignTreatmentTier({
      fitScore: item.score,
      fitEvidenceConfidence: 90,
      treatmentStrategy: config.score.treatment,
    });
    assert.equal(result.tier, item.tier);
    assert.ok(result.reasons.includes(`fit_band=${item.label}`));
  }
});

test('configured treatment bands use their configured fit cut and reject malformed ladders', () => {
  const tv = normalizeConfig({
    score: { treatment_bands: { fit: [0, 45, 65, 80, 100] } },
  });
  assert.deepEqual(tv.errors, []);

  const defaults = assignTreatmentTier({ fitScore: 47, fitEvidenceConfidence: 90 });
  const configured = assignTreatmentTier({
    fitScore: 47,
    fitEvidenceConfidence: 90,
    treatmentStrategy: { ...treasureValleyTreatmentStrategy, bands: { ...treasureValleyTreatmentStrategy.bands, fit: [0, 45, 65, 80, 100] } },
  });
  assert.equal(defaults.tier, '');
  assert.equal(configured.tier, 'C');
  assert.ok(configured.reasons.includes('fit_band=45-64'));

  const malformed = [
    [0, 65, 50, 80, 100],
    [-1, 50, 65, 80, 100],
    [0, 50, 50, 80, 100],
  ];
  for (const fit of malformed) {
    assert.ok(normalizeConfig({ score: { treatment_bands: { fit } } }).errors.length > 0);
  }
});

test('declared treatment strategy applies opaque tier keys and routes', () => {
  const strategy = {
    bands: {
      fit: [0, 25, 50, 75, 100],
      fit_evidence_confidence: [0, 25, 50, 75, 100],
    },
    matrix: [
      ['cold', 'cold', 'cold', 'cold'],
      ['cold', 'warm', 'warm', 'warm'],
      ['hold', 'warm', 'platinum', 'platinum'],
      ['hold', 'platinum', 'platinum', 'platinum'],
    ],
    unscored_tier: 'hold',
    tiers: {
      cold: { route: 'recycle_monitoring' },
      warm: { route: 'outbound' },
      platinum: { route: 'outbound' },
      hold: { route: 'enrichment' },
    },
  };
  const normalized = normalizeConfig({ score: { treatment: strategy } });
  assert.deepEqual(normalized.errors, []);
  assert.equal(
    assignTreatmentTier({ fitScore: 90, fitEvidenceConfidence: 90, treatmentStrategy: normalized.config.score.treatment }).tier,
    'platinum',
  );
  assert.equal(
    calculatePriority({ treatmentTier: 'cold', config: { tier_lanes: { cold: 'recycle_monitoring' } } }).priority_lane,
    'recycle_monitoring',
  );
});

test('mail treatment is independent; golden ticket is tier-A overlay', () => {
  const full = assignTreatmentAndMail({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    goldenTicket: treasureValleyGoldenTicket,
    postcard: treasureValleyPostcard,
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
    localBuyingAuthority: 'confirmed',
    cohortCapacityOk: true,
    goldenTicketGates: { assetReady: true, mailReady: true, cohortCapacityOk: true },
    cumulativeEnrichmentCostUsd: 2,
  });
  assert.equal(full.treatment_tier, 'A');
  assert.equal(full.mail_treatment, 'golden_ticket');
  assert.equal(full.mail_program_eligible, true);

  const postcardOnly = assignTreatmentAndMail({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    goldenTicket: treasureValleyGoldenTicket,
    postcard: treasureValleyPostcard,
    fitScore: 70,
    fitEvidenceConfidence: 70,
    identityConfidence: 85,
    mailAddressReady: true,
  });
  assert.equal(postcardOnly.treatment_tier, 'B');
  assert.equal(postcardOnly.mail_treatment, 'standard_postcard');

  const tierC = assignTreatmentAndMail({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    goldenTicket: treasureValleyGoldenTicket,
    postcard: treasureValleyPostcard,
    fitScore: 55,
    fitEvidenceConfidence: 70,
    identityConfidence: 85,
    mailAddressReady: true,
  });
  assert.equal(tierC.treatment_tier, 'C');
  assert.equal(tierC.mail_treatment, 'none');
});

test('golden ticket fails when identity weak', () => {
  const g = evaluateGoldenTicket({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    goldenTicket: treasureValleyGoldenTicket,
    treatmentTier: 'A',
    fitScore: 90,
    fitEvidenceConfidence: 90,
    identityConfidence: 50,
    classificationConfidence: 90,
    buyerConfidence: 80,
    mailConfidence: 90,
    timingScore: 75,
    mailAddressReady: true,
    assetReady: true,
    namedBuyerStatus: 'confirmed',
    namedBuyerName: 'Alex',
    localBuyingAuthority: 'confirmed',
    cohortCapacityOk: true,
  });
  assert.equal(g.eligible, false);
  assert.ok(g.withheld.includes('identity_confidence_below_90'));
});

test('candidate tier controls research depth', () => {
  assert.equal(assignCandidateTier(90, treasureValleyCandidateTier).candidate_tier, 'A');
  assert.equal(assignCandidateTier(70, treasureValleyCandidateTier).candidate_tier, 'B');
  assert.equal(assignCandidateTier(55, treasureValleyCandidateTier).candidate_tier, 'C');
  assert.equal(assignCandidateTier(20, treasureValleyCandidateTier).candidate_tier, 'D');
  assert.equal(assignCandidateTier(null).candidate_tier, '');
});

test('enrichment ceilings match provisional policy', () => {
  const r = enrichmentBudgetRemaining({ candidateOrTreatment: 'B', spentUsd: 0.5, enrichmentBudget: { ceilings: { tiers: { B: 1 } } } });
  assert.ok(r.withinBudget);
  assert.ok(r.remaining < 1);
});

test('action confidence gates are action-specific', () => {
  const profile = {
    identity_confidence: 90,
    classification_confidence: 80,
    fit_evidence_confidence: 70,
    buyer_confidence: 60,
    timing_confidence: 50,
    email_confidence: 40,
    phone_confidence: 80,
  };
  const email = actionConfidenceAllows({ action: 'email', profile });
  assert.equal(email.allowed, false);
  const phone = actionConfidenceAllows({ action: 'phone', profile });
  assert.equal(phone.allowed, true);
});

test('lifecycle transitions enforce evidence and independence', () => {
  assert.equal(canTransitionLifecycle('cold', 'contacted'), true);
  assert.equal(canTransitionLifecycle('cold', 'won'), false);
  assert.throws(() => assertLifecycleTransition('cold', 'won', { reason: 'x' }));
  assert.throws(() => assertLifecycleTransition('cold', 'contacted', { reason: '' }));

  const state = createInitialColdState('acct_1');
  const issues = checkStateIntegrity(state);
  assert.equal(issues.filter((i) => i.severity === 'error').length, 0);

  const next = completeActionAndCreateSuccessor({
    state,
    completed_action_id: state.next_action.action_id,
    outcome: 'success',
    evidence: { reason: 'foundational enrichment complete', evidence_ids: ['obs1'] },
    lifecycle_to: 'cold',
    sequence_to: 'active',
    work_to: 'content_generation',
    successor: {
      action_id: 'na_email_1',
      action_type: 'prepare_email',
      account_id: 'acct_1',
      contact_id: 'c1',
      lifecycle_stage: 'cold',
      sequence_state: 'active',
      work_state: 'content_generation',
      reason: 'Tier B email 1',
      on_success: 'wait_or_email_2',
    },
  });
  assert.equal(next.next_action.action_id, 'na_email_1');
  assert.equal(next.sequence_state, 'active');
  // lifecycle not silently rewritten by sequence
  assert.equal(next.lifecycle_stage, 'cold');
});

test('missing next_action on actionable account is integrity error', () => {
  const issues = checkStateIntegrity({
    lifecycle_stage: 'contacted',
    sequence_state: 'active',
    work_state: 'executing_external_action',
    next_action: null,
  });
  assert.ok(issues.some((i) => i.code === 'missing_next_action'));
});

test('contact plan: one active, serial rotation, mail once', () => {
  const plan = buildContactPlan({
    account_id: 'a1',
    campaign_id: 'camp1',
    treatment_tier: 'A',
    mail_treatment: 'standard_postcard',
    contacts: [
      { contact_id: 'c2', outbound_disposition: 'eligible_target', outreach_rank: 2 },
      { contact_id: 'c1', outbound_disposition: 'eligible_target', outreach_rank: 1 },
      { contact_id: 'c3', outbound_disposition: 'routing_only', outreach_rank: 9 },
    ],
  });
  assert.equal(plan.active_contact_id, 'c1');
  assert.deepEqual(plan.held_contact_ids, ['c2']);
  assert.deepEqual(plan.routing_contact_ids, ['c3']);

  assert.throws(() => assertActionTarget({ campaign: plan, contact_id: 'c2', channel: 'email' }));
  assertActionTarget({ campaign: plan, contact_id: 'c1', channel: 'email' });

  const rotated = rotateContact({ campaign: plan, reason: 'exhausted_c1' });
  assert.equal(rotated.rotated, true);
  assert.equal(rotated.campaign.active_contact_id, 'c2');
  assert.equal(rotated.campaign.mail_allocated, false);

  const mailed = allocateMail({ campaign: rotated.campaign, mail_treatment: 'standard_postcard' });
  assert.equal(mailed.mail_allocated, true);
  assert.throws(() => allocateMail({ campaign: mailed, mail_treatment: 'standard_postcard' }));
});

test('applyContactRotation production helper returns plan fields shape', () => {
  const plan = buildContactPlan({
    account_id: 'a1',
    campaign_id: 'camp1',
    treatment_tier: 'A',
    mail_treatment: 'standard_postcard',
    contacts: [
      { contact_id: 'c1', outbound_disposition: 'eligible_target', outreach_rank: 1 },
      { contact_id: 'c2', outbound_disposition: 'eligible_target', outreach_rank: 2 },
    ],
  });
  const out = applyContactRotation({
    account_contact_plan_json: JSON.stringify(plan),
    active_contact_id: 'c1',
  }, { reason: 'exhausted' });
  assert.equal(out.rotated, true);
  assert.equal(out.active_contact_id, 'c2');
  assert.ok(out.account_contact_plan_json);
  assert.equal(JSON.parse(out.account_contact_plan_json).active_contact_id, 'c2');
});

test('economic scenarios require inputs and never invent precision', () => {
  const insuff = calculateEconomicScenario({ scenario_id: 'admin_labor_leak' });
  assert.equal(insuff.evidence_status, 'insufficient');
  assert.equal(insuff.annual_low_usd, null);

  const ok = calculateEconomicScenario({
    scenario_id: 'admin_labor_leak',
    weekly_admin_hours: 10,
    hourly_loaded_cost: 40,
  });
  assert.equal(ok.evidence_status, 'calculated');
  assert.ok(ok.annual_low_usd < ok.annual_high_usd);
  assert.ok(ok.assumptions.length > 0);
});

test('eligibility classification: category alone never disqualifies', () => {
  const ok = classifyEligibility({
    isBusiness: true,
    permanentlyClosed: false,
    outOfTerritory: false,
    isDuplicate: false,
    isNonSmbOrg: false,
    corporateNoLocalAuthority: false,
    identityUnresolved: false,
    suppressed: false,
  });
  assert.equal(ok.outcome, 'eligible');

  const school = classifyEligibility({
    isBusiness: true,
    permanentlyClosed: false,
    outOfTerritory: false,
    isDuplicate: false,
    isNonSmbOrg: true,
    corporateNoLocalAuthority: false,
    identityUnresolved: false,
    suppressed: false,
  });
  assert.equal(school.outcome, 'disqualified');
  assert.ok(school.reasons.includes('non_smb_organization'));
});

test('readiness observes pipeline-declared visit/sms policy and tier C cold calls', () => {
  const policy = { prohibited_channels: ['sms'], prohibited_task_types: ['field_visit', 'visit'] };
  assert.throws(() => assertWorkAllowed({ policy, kind: 'send_sms' }));
  assert.throws(() => assertWorkAllowed({ policy, taskType: 'visit' }));

  const forbidden = findProhibitedSteps([
    { id: 'email_1', kind: 'send_email' },
    { id: 'field_visit', kind: 'manual_task', config: { task_type: 'visit' } },
    { id: 'sms_1', kind: 'send_sms' },
  ], policy);
  assert.ok(forbidden.length >= 2);

  const r = evaluateOutboundReadiness({
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
    proposedAction: { channel: 'phone', kind: 'manual_task' },
  });
  assert.equal(r.ready, false);
  assert.ok(r.blockers.includes('tier_channel_not_permitted'));
});

test('readiness allows prepared tier A email when gates pass', () => {
  const r = evaluateOutboundReadiness({
    eligible: true,
    suppressed: false,
    identityConfidence: 90,
    materialContradiction: false,
    treatmentTier: 'A',
    channels: { email: { ready: true, confidence: 80 } },
    contentReady: true,
    claimAuditPassed: true,
    withinBudget: true,
    hasNextAction: true,
    namedBuyerStatus: 'confirmed',
    namedBuyerName: 'Alex Rivera',
    buyerAffiliationStatus: 'confirmed',
    buyingCenterRole: 'owner',
    confidenceProfile: {
      identity_confidence: 90,
      classification_confidence: 80,
      fit_evidence_confidence: 85,
      buyer_confidence: 70,
      timing_confidence: 40,
      email_confidence: 80,
    },
    proposedAction: { channel: 'email', kind: 'send_email' },
  });
  assert.equal(r.ready, true);
  assert.deepEqual(r.blockers, []);
});
