/**
 * End-to-end path for Treasure Valley policy + config gates.
 * Drives real shipped policy modules and real TV outbound.yaml (no reimplementation).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';
import {
  calculateFitScore,
  calculatePriority,
  assignCandidateTier,
} from '../dist/orchestrator/policy/scoring.js';
import { assignTreatmentAndMail } from '../dist/orchestrator/policy/treatment.js';
import {
  createInitialColdState,
  completeActionAndCreateSuccessor,
  checkStateIntegrity,
} from '../dist/orchestrator/policy/lifecycle.js';
import {
  buildContactPlan,
  rotateContact,
  allocateMail,
  assertActionTarget,
} from '../dist/orchestrator/policy/contact-campaign.js';
import { calculateEconomicScenario } from '../dist/orchestrator/policy/economics.js';
import {
  evaluateOutboundReadiness,
  classifyEligibility,
} from '../dist/orchestrator/policy/readiness.js';
import { findForbiddenSteps } from '../dist/orchestrator/policy/forbidden-channels.js';

const TV_YAML = '/Users/rayepps/projects/mission/.outbound/treasure-valley/outbound.yaml';
const TAXONOMY = '/Users/rayepps/projects/mission/.outbound/treasure-valley/build/registries/vertical-taxonomy.json';
const DIAG = '/Users/rayepps/projects/mission/.outbound/treasure-valley/build/registries/diagnostic-families.json';
const PROOF = '/Users/rayepps/projects/mission/.outbound/treasure-valley/build/assets/proof-library.json';

/** Representative raw-style fixture: HVAC SMB */
const FIXTURE = {
  account_id: 'fixture_hvac_boise',
  business_name: 'Boise Peak HVAC',
  primary_type: 'hvac_contractor',
  website: 'https://example-boise-hvac.test',
  address: '1234 Fairview Ave, Boise, ID',
  isBusiness: true,
  permanentlyClosed: false,
  outOfTerritory: false,
  isDuplicate: false,
  isNonSmbOrg: false,
  corporateNoLocalAuthority: false,
  identityUnresolved: false,
  suppressed: false,
  observations: [
    {
      evidence_id: 'obs_reviews_callback',
      predicate: 'review_mentions_slow_callback',
      value: true,
      support: 'Multiple Google reviews mention delayed callbacks',
      support_status: 'supported_third_party',
    },
    {
      evidence_id: 'obs_multi_crew',
      predicate: 'fleet_or_crew_signals',
      value: 'multiple service vans visible in photos',
      support_status: 'supported_third_party',
    },
  ],
  contacts: [
    {
      contact_id: 'c_owner',
      name: 'Alex Rivera',
      outbound_disposition: 'eligible_target',
      outreach_rank: 1,
      email: 'alex@example-boise-hvac.test',
    },
    {
      contact_id: 'c_om',
      name: 'Sam Lee',
      outbound_disposition: 'eligible_target',
      outreach_rank: 2,
      email: 'office@example-boise-hvac.test',
    },
  ],
};

function loadTvConfig() {
  return yaml.load(readFileSync(TV_YAML, 'utf8'));
}

function collectSteps(steps, acc = []) {
  for (const s of steps || []) {
    acc.push(s);
    if (s.steps) collectSteps(s.steps, acc);
  }
  return acc;
}

test('TV config has no forbidden visit/sms/voice paths', () => {
  const cfg = loadTvConfig();
  const all = collectSteps(cfg.pipeline);
  for (const seq of Object.values(cfg.sequences || {})) {
    collectSteps(seq.steps, all);
  }
  const forbidden = findForbiddenSteps(all);
  assert.deepEqual(
    forbidden,
    [],
    `Forbidden steps present: ${JSON.stringify(forbidden)}`,
  );
  // Executable steps only — policy.forbidden_channels may list ban names by design
  for (const step of all) {
    assert.notEqual(step.kind, 'send_sms');
    const taskType = step.config?.task_type || step.config?.taskType || '';
    assert.equal(/^(visit|field_visit|door_to_door|office_visit|walk_in|sms)$/i.test(taskType), false);
    assert.equal(/^field_visit$/i.test(String(step.id || '')), false);
  }
  assert.ok(cfg.pipeline.some((s) => s.id === 'tier_a'));
  assert.ok(cfg.pipeline.some((s) => s.id === 'account_intelligence'));
  assert.ok(cfg.pipeline.some((s) => s.id === 'treatment_assignment'));
  // Score criteria exclude legacy penalties
  const critIds = (cfg.score?.criteria || []).map((c) => c.id);
  assert.equal(critIds.includes('hipaa_exposure'), false);
  assert.equal(critIds.includes('walk_in_decision_maker_access'), false);
  assert.equal(cfg.channels?.email?.draft_approval_required, true);
  assert.equal(cfg.channels?.phone?.sms, false);
});

test('fixture path: eligibility → fit → treatment → readiness', () => {
  const eligibility = classifyEligibility(FIXTURE);
  assert.equal(eligibility.outcome, 'eligible');

  const fit = calculateFitScore([
    { id: 'operational_coordination_burden', grade: 8, evidence_ids: ['obs_reviews_callback'] },
    { id: 'repetition_and_volume', grade: 8, evidence_ids: ['obs_multi_crew'] },
    { id: 'economic_impact_potential', grade: 7, evidence_ids: ['obs_multi_crew'] },
    { id: 'operating_scale_surface_area', grade: 7 },
    { id: 'mission_delivery_compatibility', grade: 8 },
    { id: 'local_buying_autonomy', grade: 9 },
  ]);
  assert.ok(fit.fit_score >= 70);

  const candidate = assignCandidateTier(fit.fit_score);
  assert.ok(['A', 'B'].includes(candidate.candidate_tier));
  const treatment = assignTreatmentAndMail({
    fitScore: fit.fit_score,
    fitEvidenceConfidence: 85,
    identityConfidence: 90,
    buyerConfidence: 75,
    timingScore: 40,
    mailAddressReady: true,
    goldenTicketGates: { assetReady: true, mailReady: true },
    cumulativeEnrichmentCostUsd: 1.2,
  });
  assert.ok(['A', 'B'].includes(treatment.treatment_tier));
  assert.ok(['standard_postcard', 'golden_ticket', 'none'].includes(treatment.mail_treatment));

  const priority = calculatePriority({
    fitScore: fit.fit_score,
    timingScore: 40,
    treatmentTier: treatment.treatment_tier,
  });
  assert.equal(priority.priority_lane, 'outbound');
  assert.notEqual(priority.priority_rank, fit.fit_score);

  const taxonomy = JSON.parse(readFileSync(TAXONOMY, 'utf8'));
  assert.ok(taxonomy.verticals.trades_field_services.sub_verticals.includes('hvac'));
  const diagnostics = JSON.parse(readFileSync(DIAG, 'utf8'));
  assert.ok(diagnostics.families.trades_field_services.hypotheses.length > 0);

  const economics = calculateEconomicScenario({
    scenario_id: 'missed_lead_revenue',
    missed_leads_per_month: 4,
    avg_job_value: 3500,
    close_rate: 0.25,
  });
  assert.equal(economics.evidence_status, 'calculated');

  const proofLibrary = JSON.parse(readFileSync(PROOF, 'utf8'));
  assert.ok(proofLibrary.proofs.some((proof) => proof.category === 'trades_admin_automation'));

  const readiness = evaluateOutboundReadiness({
    eligible: true,
    suppressed: false,
    identityConfidence: 90,
    materialContradiction: false,
    treatmentTier: treatment.treatment_tier,
    channels: { email: { ready: true, confidence: 80 } },
    contentReady: true,
    withinBudget: true,
    hasNextAction: true,
    confidenceProfile: {
      identity_confidence: 90,
      classification_confidence: 80,
      fit_evidence_confidence: 85,
      buyer_confidence: 75,
      timing_confidence: 40,
      email_confidence: 80,
    },
    proposedAction: { channel: 'email', kind: 'send_email' },
  });
  assert.equal(readiness.ready, true);
});

test('multi-contact campaign lifecycle with single next action', () => {
  let state = createInitialColdState(FIXTURE.account_id);
  assert.equal(checkStateIntegrity(state).filter((i) => i.severity === 'error').length, 0);

  state = completeActionAndCreateSuccessor({
    state,
    completed_action_id: state.next_action.action_id,
    outcome: 'success',
    evidence: { reason: 'foundational complete', evidence_ids: ['obs_reviews_callback'] },
    sequence_to: 'active',
    work_to: 'executing_external_action',
    successor: {
      action_id: 'na_email_c1',
      action_type: 'send_email',
      account_id: FIXTURE.account_id,
      contact_id: 'c_owner',
      lifecycle_stage: 'cold',
      sequence_state: 'active',
      work_state: 'executing_external_action',
      reason: 'Tier treatment email 1 to active contact',
      on_success: 'wait_or_followup',
    },
  });

  const plan = buildContactPlan({
    account_id: FIXTURE.account_id,
    campaign_id: 'camp_fixture_1',
    treatment_tier: 'A',
    mail_treatment: 'standard_postcard',
    contacts: FIXTURE.contacts,
  });
  assert.equal(plan.active_contact_id, 'c_owner');
  assertActionTarget({ campaign: plan, contact_id: 'c_owner', channel: 'email' });
  assert.throws(() => assertActionTarget({ campaign: plan, contact_id: 'c_om', channel: 'email' }));

  // Email sent → lifecycle contacted, next wait
  state = completeActionAndCreateSuccessor({
    state,
    completed_action_id: 'na_email_c1',
    outcome: 'success',
    evidence: { reason: 'email accepted by provider', evidence_ids: ['evt_send_1'] },
    lifecycle_to: 'contacted',
    sequence_to: 'waiting',
    work_to: 'waiting_time_or_event',
    successor: {
      action_id: 'na_wait_1',
      action_type: 'wait',
      account_id: FIXTURE.account_id,
      contact_id: 'c_owner',
      lifecycle_stage: 'contacted',
      sequence_state: 'waiting',
      work_state: 'waiting_time_or_event',
      reason: 'Business-day wait before follow-up',
      on_success: 'email_2_or_rotate',
    },
  });
  assert.equal(state.lifecycle_stage, 'contacted');
  assert.equal(state.sequence_state, 'waiting');
  assert.ok(state.next_action);

  // Exhaust contact → atomic rotation
  const rotated = rotateContact({ campaign: plan, reason: 'contact_exhausted' });
  assert.equal(rotated.campaign.active_contact_id, 'c_om');
  const mailed = allocateMail({
    campaign: rotated.campaign,
    mail_treatment: 'standard_postcard',
  });
  assert.equal(mailed.mail_allocated, true);
  // Rotation does not reset mail
  assert.throws(() =>
    allocateMail({ campaign: mailed, mail_treatment: 'standard_postcard' }),
  );

  assert.equal(checkStateIntegrity(state).filter((i) => i.severity === 'error').length, 0);
});

test('registries and proof library are loadable seed assets', () => {
  const t = JSON.parse(readFileSync(TAXONOMY, 'utf8'));
  assert.equal(t.taxonomy_version, 'tv-vertical-v1');
  assert.ok(Object.keys(t.verticals).length >= 10);
  const d = JSON.parse(readFileSync(DIAG, 'utf8'));
  assert.equal(d.offer, 'diagnostic_partnership');
  const p = JSON.parse(readFileSync(PROOF, 'utf8'));
  assert.ok(p.proofs.every((x) => x.proof_id && x.provenance.includes('Mission')));
});
