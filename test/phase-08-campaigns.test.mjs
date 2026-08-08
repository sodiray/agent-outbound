/**
 * Phase 8 — Build account campaigns and tiered sequences.
 *
 * Isolation suite mandated by phase-08 review. Drives **shipped** policy
 * modules + real TV outbound.yaml (no reimplementation).
 *
 * Coverage:
 * 1. TV tier_a / tier_b / tier_c / tier_d pipelines exist with no visit steps
 * 2. mergeContactPlan preserves mail_allocated + rotation across re-apply
 * 3. rotateContact atomic handoff (and exhaustion when no held contacts)
 * 4. shouldExecuteSequenceOutbound for tier-routed active / paused states
 * 5. campaign-process age / allowance / quiet / capacity / annual limits
 * 6. Production mail allocate on manual_task complete
 * 7. advanceAfterSuccessfulAction counters + rotation quiet stamp
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import yaml from 'js-yaml';

import {
  buildContactPlan,
  mergeContactPlan,
  rotateContact,
  allocateMail,
  applyContactRotation,
  parseAccountCampaignFromRecord,
  PER_CONTACT_ALLOWANCES,
  CAMPAIGN_MAX_AGE_DAYS,
} from '../dist/orchestrator/policy/contact-campaign.js';
import {
  shouldExecuteSequenceOutbound,
  filterRecordsForSequenceOutbound,
} from '../dist/orchestrator/policy/sequence-outbound.js';
import {
  applyOutboundPolicy as applyRawOutboundPolicy,
  guardChannelExecution,
} from '../dist/orchestrator/policy/apply-record.js';
import { findProhibitedSteps } from '../dist/orchestrator/policy/pipeline-prohibitions.js';
import {
  evaluateCampaignProcess,
  checkCampaignAge,
  checkContactAllowance,
  checkQuietPeriod,
  checkAnnualCampaignLimit,
  rankCallCapacity,
  INTER_CONTACT_QUIET_BUSINESS_DAYS,
  ANNUAL_CAMPAIGN_LIMIT,
  CAMPAIGN_MAX_AGE_BUSINESS_DAYS,
  PER_CONTACT_AUTOMATED_ALLOWANCES,
} from '../dist/orchestrator/policy/campaign-process.js';
import { advanceAfterSuccessfulAction } from '../dist/orchestrator/policy/lifecycle.js';
import { completeManualTask } from '../dist/orchestrator/pipeline/manual.js';
import { openListDb, ensureRecordColumns } from '../dist/orchestrator/runtime/db.js';
import { treasureValleyTreatmentStrategy } from './fixtures/treatment-strategy.mjs';
import { treasureValleyFitModel } from './fixtures/fit-model.mjs';

const applyOutboundPolicy = (input) => applyRawOutboundPolicy({ fitModel: treasureValleyFitModel, ...input });

const __dirname = dirname(fileURLToPath(import.meta.url));
const TV_ROOT =
  process.env.TV_ROOT || '/Users/rayepps/projects/mission/.outbound/treasure-valley';
const TV_YAML = join(TV_ROOT, 'outbound.yaml');

const TIER_PIPELINE_IDS = ['tier_a', 'tier_b', 'tier_c', 'tier_d'];
const VISIT_LIKE =
  /^(visit|field_visit|door_to_door|office_visit|walk_in)$/i;
const contactPolicy = {
  per_contact_allowances: { A: 3, B: 2, C: 1, D: 0 },
  campaign: {
    max_age_business_days: { A: 40, B: 30, C: 20, D: 0 },
    quiet_period_business_days: 3,
    annual_campaign_limit: 2,
    recycle_wait_days: { A: 90, B: 60, C: 45, D: 30 },
  },
};

function loadTvRaw() {
  assert.ok(existsSync(TV_YAML), `TV outbound.yaml missing at ${TV_YAML}`);
  return yaml.load(readFileSync(TV_YAML, 'utf8'));
}

function collectSteps(steps, acc = []) {
  for (const s of steps || []) {
    acc.push(s);
    if (Array.isArray(s.steps)) collectSteps(s.steps, acc);
  }
  return acc;
}

function contactsFixture() {
  return [
    { contact_id: 'c_owner', outbound_disposition: 'eligible_target', outreach_rank: 1 },
    { contact_id: 'c_ops', outbound_disposition: 'eligible_target', outreach_rank: 2 },
    { contact_id: 'c_sales', outbound_disposition: 'eligible_target', outreach_rank: 3 },
    { contact_id: 'c_router', outbound_disposition: 'routing_only', outreach_rank: 9 },
  ];
}

function outboundNextAction(overrides = {}) {
  return JSON.stringify({
    action_id: 'na_out_1',
    action_type: 'send_email',
    account_id: 'acct',
    lifecycle_stage: 'contacted',
    sequence_state: 'active',
    work_state: 'executing_external_action',
    reason: 'test',
    on_success: 'wait_or_followup',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. Tier pipelines exist without visit
// ---------------------------------------------------------------------------

test('TV: sequence_assign routes A/B/C/D into tier_* pipelines; enrichment_hold exists', () => {
  const cfg = loadTvRaw();
  const assign = (cfg.pipeline || []).find((s) => s.id === 'sequence_assign');
  assert.ok(assign, 'sequence_assign missing');
  assert.equal(assign.kind, 'assign');
  assert.equal(assign.target, 'pipeline_name');
  assert.equal(assign.fallback, 'enrichment_hold');

  const routed = (assign.rules || []).map((r) => r.pipeline);
  for (const id of TIER_PIPELINE_IDS) {
    assert.ok(routed.includes(id), `sequence_assign missing rule for ${id}`);
  }

  for (const id of [...TIER_PIPELINE_IDS, 'enrichment_hold']) {
    const pipe = (cfg.pipeline || []).find((s) => s.id === id);
    assert.ok(pipe, `pipeline ${id} missing`);
    assert.equal(pipe.kind, 'pipeline');
  }
});

test('TV: tier_a/b/c/d pipelines exist without field_visit / visit steps', () => {
  const cfg = loadTvRaw();
  const tierSteps = [];

  for (const id of TIER_PIPELINE_IDS) {
    const pipe = (cfg.pipeline || []).find((s) => s.id === id);
    assert.ok(pipe, `missing pipeline ${id}`);
    const steps = collectSteps(pipe.steps || []);
    tierSteps.push(...steps.map((s) => ({ ...s, __pipeline: id })));
  }

  // Structural shape by tier (contract intent, not step-count theater)
  const byId = Object.fromEntries(
    TIER_PIPELINE_IDS.map((id) => {
      const pipe = (cfg.pipeline || []).find((s) => s.id === id);
      return [id, collectSteps(pipe.steps || [])];
    }),
  );

  assert.ok(byId.tier_a.some((s) => s.kind === 'send_email'));
  assert.ok(byId.tier_a.some((s) => s.kind === 'linkedin_connect'));
  assert.ok(
    byId.tier_a.some(
      (s) => s.kind === 'manual_task' && String(s.config?.task_type || '') === 'human_phone',
    ),
    'tier_a should include human_phone manual task',
  );
  assert.ok(
    byId.tier_a.some(
      (s) =>
        s.kind === 'manual_task'
        && /golden_ticket|standard_postcard/i.test(String(s.config?.task_type || '')),
    ),
    'tier_a should include mail production task',
  );

  assert.ok(byId.tier_b.some((s) => s.kind === 'send_email'));
  assert.ok(
    byId.tier_b.some(
      (s) => s.kind === 'manual_task' && String(s.config?.task_type || '') === 'human_phone',
    ),
  );
  assert.ok(
    byId.tier_b.some(
      (s) =>
        s.kind === 'manual_task'
        && String(s.config?.task_type || '') === 'standard_postcard',
    ),
  );
  assert.equal(
    byId.tier_b.some((s) => s.kind === 'linkedin_connect'),
    false,
    'tier_b should not require linkedin_connect in default path',
  );

  assert.ok(byId.tier_c.some((s) => s.kind === 'send_email'));
  assert.equal(
    byId.tier_c.some(
      (s) => s.kind === 'manual_task' && String(s.config?.task_type || '') === 'human_phone',
    ),
    false,
    'tier_c must not include proactive human_phone',
  );
  assert.equal(
    byId.tier_c.some(
      (s) =>
        s.kind === 'manual_task'
        && /postcard|golden_ticket|mail/i.test(String(s.config?.task_type || '')),
    ),
    false,
    'tier_c must not include default mail production',
  );

  assert.equal(byId.tier_d.length, 0, 'tier_d is monitoring — empty steps');
  const dPipe = (cfg.pipeline || []).find((s) => s.id === 'tier_d');
  assert.equal(dPipe.manual, true);

  // No visit-like steps anywhere in tier pipelines
  const forbidden = findProhibitedSteps(tierSteps, cfg.policy);
  assert.deepEqual(forbidden, [], `Forbidden steps in tier pipelines: ${JSON.stringify(forbidden)}`);

  for (const step of tierSteps) {
    const kind = String(step.kind || '').toLowerCase();
    const id = String(step.id || '').toLowerCase();
    const taskType = String(step.config?.task_type || step.config?.taskType || '').toLowerCase();
    assert.notEqual(kind, 'field_visit');
    assert.notEqual(id, 'field_visit');
    assert.equal(VISIT_LIKE.test(taskType), false, `${step.__pipeline}/${step.id} task_type=${taskType}`);
    assert.equal(VISIT_LIKE.test(kind), false);
    assert.equal(VISIT_LIKE.test(id), false);
  }

});

// ---------------------------------------------------------------------------
// 2. mergeContactPlan preserves mail + rotation
// ---------------------------------------------------------------------------

test('mergeContactPlan: preserves active rotation and mail_allocated across re-rank', () => {
  const contacts = contactsFixture();
  let plan = buildContactPlan({
    account_id: 'acct_p8',
    campaign_id: 'camp_p8',
    contacts,
    treatment_tier: 'A',
    mail_treatment: 'golden_ticket',
    contactPolicy,
  });

  assert.equal(plan.active_contact_id, 'c_owner');
  assert.deepEqual(plan.held_contact_ids, ['c_ops', 'c_sales']);
  assert.equal(plan.mail_allocated, false);
  assert.equal(plan.per_contact_action_allowance, 3);
  assert.equal(plan.campaign_max_age_days, 40);

  plan = rotateContact({ campaign: plan, reason: 'owner_exhausted' }).campaign;
  plan = allocateMail({ campaign: plan, mail_treatment: 'golden_ticket' });
  assert.equal(plan.active_contact_id, 'c_ops');
  assert.equal(plan.mail_allocated, true);

  // Fresh plan always restarts at rank-1 / mail false — merge must not wipe progress
  const fresh = buildContactPlan({
    account_id: 'acct_p8',
    campaign_id: 'camp_p8_fresh',
    contacts,
    treatment_tier: 'A',
    mail_treatment: 'golden_ticket',
    contactPolicy,
  });
  assert.equal(fresh.active_contact_id, 'c_owner');
  assert.equal(fresh.mail_allocated, false);

  const merged = mergeContactPlan({ fresh, existing: plan });
  assert.equal(merged.active_contact_id, 'c_ops', 'rotated active preserved');
  assert.deepEqual(merged.held_contact_ids, ['c_sales']);
  assert.equal(merged.mail_allocated, true, 'mail_allocated never cleared true→false');
  assert.equal(merged.campaign_id, 'camp_p8', 'campaign_id preserved');
  assert.equal(merged.held_contact_ids.includes('c_owner'), false, 'exhausted contact not re-queued');
  assert.equal(merged.mail_treatment, 'golden_ticket');
});

test('mergeContactPlan via applyOutboundPolicy preserves rotation + mail on re-apply', () => {
  const contacts = contactsFixture().filter((c) => c.outbound_disposition !== 'routing_only');
  const base = buildContactPlan({
    account_id: 'acct_p8_policy',
    campaign_id: 'camp_p8_pol',
    contacts,
    treatment_tier: 'B',
    mail_treatment: 'standard_postcard',
    contactPolicy,
  });
  const afterRotate = rotateContact({ campaign: base, reason: 'exhaust' }).campaign;
  const afterMail = allocateMail({
    campaign: afterRotate,
    mail_treatment: 'standard_postcard',
  });
  assert.equal(afterMail.active_contact_id, 'c_ops');
  assert.equal(afterMail.mail_allocated, true);

  const result = applyOutboundPolicy({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    record: {
      _row_id: 'acct_p8_policy',
      fit_score: 72,
      fit_evidence_confidence: 80,
      identity_confidence: 90,
      buyer_confidence: 70,
      address_rdi: 'Commercial',
      account_contact_plan_json: JSON.stringify(afterMail),
      active_contact_id: 'c_ops',
      lifecycle_stage: 'contacted',
      account_sequence_state: 'active',
      work_state: 'content_generation',
      next_action_json: outboundNextAction({ account_id: 'acct_p8_policy' }),
    },
    contacts,
    campaignId: 'camp_p8_pol_should_not_win',
  });

  assert.equal(result.patch.treatment_tier, 'B');
  assert.equal(result.patch.pipeline_name, 'tier_b');
  assert.equal(result.patch.active_contact_id, 'c_ops');

  const plan = parseAccountCampaignFromRecord({
    account_contact_plan_json: result.patch.account_contact_plan_json,
  });
  assert.ok(plan);
  assert.equal(plan.active_contact_id, 'c_ops');
  assert.equal(plan.mail_allocated, true);
  assert.equal(plan.campaign_id, 'camp_p8_pol');
  assert.equal(plan.held_contact_ids.includes('c_owner'), false);
});

// ---------------------------------------------------------------------------
// 3. rotateContact
// ---------------------------------------------------------------------------

test('rotateContact: atomic handoff through queue; false when exhausted', () => {
  let plan = buildContactPlan({
    account_id: 'acct_rot',
    campaign_id: 'camp_rot',
    contacts: contactsFixture(),
    treatment_tier: 'C',
    contactPolicy,
  });

  assert.equal(plan.active_contact_id, 'c_owner');
  assert.deepEqual(plan.held_contact_ids, ['c_ops', 'c_sales']);
  assert.equal(plan.per_contact_action_allowance, 1);

  const r1 = rotateContact({ campaign: plan, reason: 'window_closed' });
  assert.equal(r1.rotated, true);
  assert.equal(r1.previous_contact_id, 'c_owner');
  assert.equal(r1.campaign.active_contact_id, 'c_ops');
  assert.deepEqual(r1.campaign.held_contact_ids, ['c_sales']);
  // Prior plan object not mutated
  assert.equal(plan.active_contact_id, 'c_owner');

  const r2 = rotateContact({ campaign: r1.campaign, reason: 'window_closed' });
  assert.equal(r2.rotated, true);
  assert.equal(r2.previous_contact_id, 'c_ops');
  assert.equal(r2.campaign.active_contact_id, 'c_sales');
  assert.deepEqual(r2.campaign.held_contact_ids, []);

  const r3 = rotateContact({ campaign: r2.campaign, reason: 'no_more' });
  assert.equal(r3.rotated, false);
  assert.equal(r3.previous_contact_id, 'c_sales');
  assert.equal(r3.campaign.active_contact_id, null);
  assert.deepEqual(r3.campaign.held_contact_ids, []);

  // Production helper mirrors rotateContact and never reallocates mail
  const withMail = { ...r1.campaign, mail_allocated: true };
  const viaHelper = applyContactRotation(
    { account_contact_plan_json: JSON.stringify(withMail), active_contact_id: 'c_ops' },
    { reason: 'exhaust' },
  );
  assert.equal(viaHelper.rotated, true);
  assert.equal(viaHelper.active_contact_id, 'c_sales');
  const parsed = parseAccountCampaignFromRecord({
    account_contact_plan_json: viaHelper.account_contact_plan_json,
  });
  assert.equal(parsed.mail_allocated, true, 'rotation must not clear mail_allocated');
});

// ---------------------------------------------------------------------------
// 4. shouldExecuteSequenceOutbound for tiers
// ---------------------------------------------------------------------------

test('shouldExecuteSequenceOutbound: allows active tier A/B/C outbound; blocks paused', () => {
  const now = '2026-08-04T15:00:00.000Z';

  for (const tier of ['A', 'B', 'C']) {
    const pipeline_name =
      tier === 'A' ? 'tier_a' : tier === 'B' ? 'tier_b' : 'tier_c';
    const d = shouldExecuteSequenceOutbound(
      {
        _row_id: `acct_${tier}`,
        treatment_tier: tier,
        pipeline_name,
        account_sequence_state: 'active',
        next_action_json: outboundNextAction({ account_id: `acct_${tier}` }),
      },
      now,
    );
    assert.equal(d.execute, true, `tier ${tier} active outbound should execute`);
    assert.equal(d.reason, 'outbound_action');
  }

  // Tier D / enrichment_hold typically hold non-outbound next actions
  for (const [tier, action_type] of [
    ['D', 'recycle_monitor'],
    ['enrichment_hold', 'enrichment_repair'],
  ]) {
    const d = shouldExecuteSequenceOutbound(
      {
        _row_id: `acct_${tier}`,
        treatment_tier: tier,
        pipeline_name: tier === 'D' ? 'tier_d' : 'enrichment_hold',
        account_sequence_state: 'active',
        next_action_json: outboundNextAction({
          account_id: `acct_${tier}`,
          action_type,
          sequence_state: 'active',
        }),
      },
      now,
    );
    assert.equal(d.execute, false, `${tier} ${action_type} must not auto-outbound`);
    assert.match(d.reason, /non_outbound/);
  }

  // Any paused_* sequence state blocks regardless of tier pipeline
  for (const state of ['paused_review', 'paused_inbound', 'paused_repair', 'recycle_wait', 'completed', 'cancelled']) {
    const d = shouldExecuteSequenceOutbound(
      {
        treatment_tier: 'A',
        pipeline_name: 'tier_a',
        account_sequence_state: state,
        next_action_json: outboundNextAction(),
      },
      now,
    );
    assert.equal(d.execute, false, `state ${state} must block`);
    assert.equal(d.reason, `sequence_state_${state}`);
  }
});

test('shouldExecuteSequenceOutbound: filterRecords drops paused tier rows, keeps active', () => {
  const now = '2026-08-04T15:00:00.000Z';
  const rows = [
    {
      _row_id: 'a',
      pipeline_name: 'tier_a',
      account_sequence_state: 'active',
      next_action_json: outboundNextAction({ account_id: 'a' }),
    },
    {
      _row_id: 'b',
      pipeline_name: 'tier_b',
      account_sequence_state: 'paused_review',
      next_action_json: outboundNextAction({ account_id: 'b' }),
    },
    {
      _row_id: 'c',
      pipeline_name: 'tier_c',
      account_sequence_state: 'active',
      next_action_json: outboundNextAction({
        account_id: 'c',
        action_type: 'wait',
        due_at: '2026-08-10T00:00:00.000Z',
      }),
    },
  ];
  const kept = filterRecordsForSequenceOutbound(rows, now);
  assert.deepEqual(
    kept.map((r) => r._row_id),
    ['a'],
    'only active outbound-ready tier row remains',
  );
});

test('applyOutboundPolicy maps treatment tiers to pipeline_name tier_*', () => {
  const cases = [
    { fit: 90, conf: 90, tier: 'A', pipeline: 'tier_a' },
    { fit: 72, conf: 80, tier: 'B', pipeline: 'tier_b' },
    { fit: 55, conf: 70, tier: 'C', pipeline: 'tier_c' },
    { fit: 40, conf: 50, tier: 'D', pipeline: 'tier_d' },
    { fit: null, conf: null, tier: 'enrichment_hold', pipeline: 'enrichment_hold' },
  ];
  for (const c of cases) {
    const result = applyOutboundPolicy({
      treatmentStrategy: treasureValleyTreatmentStrategy,
      record: {
        _row_id: `map_${c.tier}`,
        fit_score: c.fit,
        fit_evidence_confidence: c.conf,
        identity_confidence: 90,
        buyer_confidence: 70,
        classification_confidence: 90,
        address_rdi: 'Commercial',
        // High-tier A requires named buyer + affiliation (fail closed otherwise → hold).
        ...(c.tier === 'A'
          ? {
            named_buyer_status: 'confirmed',
            observed_buyer_name: 'Alex Rivera',
            buyer_affiliation_status: 'confirmed',
            buying_center_role: 'owner',
          }
          : {}),
      },
      contacts: [
        { contact_id: 'only', outbound_disposition: 'eligible_target', outreach_rank: 1 },
      ],
    });
    assert.equal(result.patch.treatment_tier, c.tier, `expected tier ${c.tier}`);
    assert.equal(result.patch.pipeline_name, c.pipeline, `expected pipeline ${c.pipeline}`);
  }
});

// ---------------------------------------------------------------------------
// 5. campaign-process: age / allowance / quiet / capacity / annual
// ---------------------------------------------------------------------------

test('campaign-process: age / allowance / quiet / annual block over-limit work', () => {
  const plan = buildContactPlan({
    account_id: 'proc_1',
    campaign_id: 'camp_proc',
    contacts: contactsFixture(),
    treatment_tier: 'B',
    mail_treatment: 'standard_postcard',
    contactPolicy,
  });
  assert.ok(plan.started_at, 'new plans stamp started_at');
  assert.equal(plan.per_contact_action_allowance, 2);

  // Age: backdate start far past Tier B max (30 business days)
  const aged = { ...plan, started_at: '2020-01-01T00:00:00.000Z' };
  const age = checkCampaignAge({ campaign: aged, treatment_tier: 'B', asOf: '2026-08-04T12:00:00.000Z', contactPolicy });
  assert.equal(age.allowed, false);
  assert.ok(age.blockers.some((b) => b.startsWith('campaign_age_exceeded')));

  // Allowance: Tier B max 2 automated actions
  const allowOk = checkContactAllowance({ treatment_tier: 'B', automated_actions_used: 1, contactPolicy });
  assert.equal(allowOk.allowed, true);
  const allowBlock = checkContactAllowance({ treatment_tier: 'B', automated_actions_used: 2, contactPolicy });
  assert.equal(allowBlock.allowed, false);
  assert.ok(allowBlock.blockers.some((b) => b.startsWith('per_contact_allowance_exceeded')));

  // Quiet: less than INTER_CONTACT_QUIET_BUSINESS_DAYS after rotation
  const quietBlock = checkQuietPeriod({
    last_rotation_at: '2026-08-03T12:00:00.000Z',
    asOf: '2026-08-04T12:00:00.000Z',
    contactPolicy,
  });
  assert.equal(quietBlock.allowed, false);
  const quietOk = checkQuietPeriod({
    last_rotation_at: '2026-07-20T12:00:00.000Z',
    asOf: '2026-08-04T12:00:00.000Z',
    contactPolicy,
  });
  assert.equal(quietOk.allowed, true);
  assert.equal(checkQuietPeriod({ last_rotation_at: null, contactPolicy }).allowed, true);

  // Annual: ≤2 campaigns / 12 months
  assert.equal(checkAnnualCampaignLimit({ campaigns_in_last_12_months: 1, contactPolicy }).allowed, true);
  assert.equal(checkAnnualCampaignLimit({ campaigns_in_last_12_months: 2, contactPolicy }).allowed, false);

  // Composite evaluate
  const evalBlocked = evaluateCampaignProcess({
    campaign: aged,
    treatment_tier: 'B',
    automated_actions_used: 5,
    last_rotation_at: '2026-08-03T12:00:00.000Z',
    campaigns_in_last_12_months: 2,
    asOf: '2026-08-04T12:00:00.000Z',
    contactPolicy,
  });
  assert.equal(evalBlocked.allowed, false);
  assert.ok(evalBlocked.blockers.length >= 3);
});

test('campaign-process: rankCallCapacity uses pipeline priority without tier assumptions', () => {
  const ranked = rankCallCapacity({
    candidates: [
      { record_id: 'b_hi', treatment_tier: 'B', fit_score: 99, priority_rank: 3 },
      { record_id: 'a_lo', treatment_tier: 'A', fit_score: 40, priority_rank: 2 },
      { record_id: 'a_hi', treatment_tier: 'A', fit_score: 85, priority_rank: 1 },
      { record_id: 'custom', treatment_tier: 'priority_customer', fit_score: 90, priority_rank: 4 },
    ],
    capacity: 3,
  });
  assert.deepEqual(
    ranked.map((r) => r.record_id),
    ['a_hi', 'a_lo', 'b_hi'],
  );
  assert.equal(ranked[0].spillover, false);
  assert.equal(ranked[1].spillover, false);
  assert.equal(ranked[2].spillover, false);
  assert.equal(ranked.some((r) => r.record_id === 'custom'), false);
});

test('applyOutboundPolicy: process blockers land in readiness; new plan increments annual count', () => {
  const contacts = contactsFixture().filter((c) => c.outbound_disposition === 'eligible_target');
  const first = applyOutboundPolicy({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    record: {
      _row_id: 'acct_annual',
      fit_score: 72,
      fit_evidence_confidence: 80,
      identity_confidence: 90,
      buyer_confidence: 70,
      address_rdi: 'Commercial',
    },
    contacts,
    campaignId: 'camp_annual_1',
    contactPolicy,
  });
  assert.equal(first.patch.treatment_tier, 'B');
  assert.equal(first.patch.campaigns_in_last_12_months, 1);
  const plan = parseAccountCampaignFromRecord({
    account_contact_plan_json: first.patch.account_contact_plan_json,
  });
  assert.ok(plan?.started_at);

  // Over age + over annual → readiness not ready
  const agedPlan = { ...plan, started_at: '2019-01-01T00:00:00.000Z' };
  const blocked = applyOutboundPolicy({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    record: {
      _row_id: 'acct_annual',
      fit_score: 72,
      fit_evidence_confidence: 80,
      identity_confidence: 90,
      buyer_confidence: 70,
      address_rdi: 'Commercial',
      account_contact_plan_json: JSON.stringify(agedPlan),
      campaigns_in_last_12_months: 2,
      automated_actions_used: 0,
    },
    contacts,
    contactPolicy,
  });
  assert.equal(blocked.readiness?.ready, false);
  assert.ok(
    (blocked.readiness?.blockers || []).some((b) => String(b).startsWith('campaign_age_exceeded')),
  );
  // Re-apply with existing plan must NOT re-increment annual
  assert.equal(blocked.patch.campaigns_in_last_12_months, undefined);
});

test('guardChannelExecution hard-blocks automated send when allowance exceeded', () => {
  const plan = buildContactPlan({
    account_id: 'guard_1',
    campaign_id: 'camp_g',
    contacts: contactsFixture(),
    treatment_tier: 'C',
    contactPolicy,
  });
  // Tier C allowance = 1; already used 1 → next send blocked
  const guard = guardChannelExecution({
    config: { policy: { enforce_readiness: false, prohibited_task_types: ['field_visit'] }, contact_policy: contactPolicy },
    record: {
      _row_id: 'guard_1',
      treatment_tier: 'C',
      account_contact_plan_json: JSON.stringify(plan),
      automated_actions_used: 1,
      campaigns_in_last_12_months: 0,
    },
    stepKind: 'send_email',
    channel: 'email',
    intent: 'send',
  });
  assert.equal(guard.allowed, false);
  assert.match(String(guard.reason || ''), /campaign_process|allowance/);
});

// ---------------------------------------------------------------------------
// 6. Mail allocate on complete (production path)
// ---------------------------------------------------------------------------

test('completeManualTask: allocateMail once on mail production step', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-p8-mail-'));
  writeFileSync(
    join(listDir, 'outbound.yaml'),
    `list: { name: p8mail }\npipeline: []\nscore: { criteria: [] }\n`,
  );
  writeFileSync(join(listDir, 'operator.md'), 'x');
  writeFileSync(join(listDir, 'mcp.json'), '{}');
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const campaign = buildContactPlan({
    account_id: 'mail_acct',
    campaign_id: 'camp_mail',
    contacts: [{ contact_id: 'c1', outbound_disposition: 'eligible_target', outreach_rank: 1 }],
    treatment_tier: 'B',
    mail_treatment: 'standard_postcard',
  });
  ensureRecordColumns({
    db,
    columns: ['account_contact_plan_json', 'mail_treatment', 'mail_allocated', 'mail_allocated_at'],
  });
  db.prepare(`
    INSERT INTO records (_row_id, business_name, sequence_name, sequence_status, account_contact_plan_json, mail_treatment, _created_at, _updated_at, created_at, updated_at)
    VALUES (?, 'Mail Co', 'default', 'idle', ?, 'standard_postcard', ?, ?, ?, ?)
  `).run('mail_acct', JSON.stringify(campaign), now, now, now, now);

  try {
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
      VALUES ('e_mail', 'mail_acct', 'mail_standard', 'manual_task', 0, 'awaiting_manual', ?)
    `).run(now);
  } catch {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_events (
        event_id TEXT PRIMARY KEY,
        record_id TEXT,
        step_id TEXT,
        kind TEXT,
        passed INTEGER,
        reason TEXT,
        occurred_at TEXT
      )
    `);
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
      VALUES ('e_mail', 'mail_acct', 'mail_standard', 'manual_task', 0, 'awaiting_manual', ?)
    `).run(now);
  }

  const result = await completeManualTask({ db, recordId: 'mail_acct', stepId: 'mail_standard', note: 'postcard sent' });
  assert.equal(result.status, 'manual_completed');
  assert.equal(result.mail_allocated, true);
  const row = db.prepare('SELECT * FROM records WHERE _row_id=?').get('mail_acct');
  assert.equal(Number(row.mail_allocated), 1);
  const plan = parseAccountCampaignFromRecord(row);
  assert.equal(plan.mail_allocated, true);
  assert.throws(() => allocateMail({ campaign: plan, mail_treatment: 'standard_postcard' }));
  db.close();
});

// ---------------------------------------------------------------------------
// 7. Succession counters + one lifecycle / work / next_action preserved
// ---------------------------------------------------------------------------

test('advanceAfterSuccessfulAction: increments automated_actions_used; rotation resets + stamps quiet', () => {
  const plan = buildContactPlan({
    account_id: 'succ_1',
    campaign_id: 'camp_succ',
    contacts: contactsFixture(),
    treatment_tier: 'A',
    mail_treatment: 'golden_ticket',
  });
  const advanced = advanceAfterSuccessfulAction({
    record: {
      _row_id: 'succ_1',
      lifecycle_stage: 'cold',
      account_sequence_state: 'active',
      work_state: 'executing_external_action',
      active_contact_id: plan.active_contact_id,
      account_contact_plan_json: JSON.stringify(plan),
      treatment_tier: 'A',
      automated_actions_used: 0,
      next_action_json: outboundNextAction({
        account_id: 'succ_1',
        contact_id: 'c_owner',
        action_type: 'send_email',
      }),
    },
    channel: 'email',
    stepKind: 'send_email',
    stepId: 'email_1',
    sequenceCompleted: false,
  });
  assert.equal(advanced.patch.lifecycle_stage, 'contacted');
  assert.equal(advanced.patch.automated_actions_used, 1);
  assert.ok(advanced.patch.next_action_json);
  assert.equal(advanced.rotated, false);

  // Exhaust contact sequence → rotate to next held
  const rotated = advanceAfterSuccessfulAction({
    record: {
      _row_id: 'succ_1',
      lifecycle_stage: 'contacted',
      account_sequence_state: 'active',
      work_state: 'executing_external_action',
      active_contact_id: plan.active_contact_id,
      account_contact_plan_json: JSON.stringify(plan),
      treatment_tier: 'A',
      automated_actions_used: 2,
      next_action_json: outboundNextAction({
        account_id: 'succ_1',
        contact_id: 'c_owner',
        action_type: 'send_email',
      }),
    },
    channel: 'email',
    stepKind: 'send_email',
    stepId: 'email_last',
    sequenceCompleted: true,
    rotate: true,
  });
  assert.equal(rotated.rotated, true);
  assert.equal(rotated.patch.active_contact_id, 'c_ops');
  assert.equal(rotated.patch.automated_actions_used, 0, 'new contact starts at 0 allowance used');
  assert.ok(rotated.patch.last_contact_rotation_at);
  // One lifecycle, one work, one next_action after handoff
  assert.equal(rotated.patch.lifecycle_stage, 'contacted');
  assert.equal(rotated.patch.account_sequence_state, 'active');
  assert.equal(rotated.patch.work_state, 'content_generation');
  const na = JSON.parse(rotated.patch.next_action_json);
  assert.ok(na.action_id);
  assert.equal(na.contact_id, 'c_ops');
});

test('TV: tier_c is single automated email (allowance C=1); no phone/mail', () => {
  const cfg = loadTvRaw();
  const pipe = (cfg.pipeline || []).find((s) => s.id === 'tier_c');
  assert.ok(pipe);
  const steps = collectSteps(pipe.steps || []);
  const emails = steps.filter((s) => s.kind === 'send_email');
  assert.equal(emails.length, 1, 'tier_c must be one automated email to match C allowance');
  assert.equal(
    steps.some((s) => s.kind === 'manual_task' && /phone|postcard|golden|mail/i.test(String(s.config?.task_type || ''))),
    false,
  );
});
