/**
 * Phase 2 foundations isolation suite.
 *
 * Drives **shipped** AgentOutbound policy functions only (no reimplementation).
 * Proves Complete-when slice: multi-contact account can move through controlled
 * internal states, reviews, pauses, handoffs, and successor actions without
 * providers or Treasure Valley-specific content.
 *
 * Closures:
 * 1. createInitialColdState integrity
 * 2. rotate + mergeContactPlan
 * 3. completeActionAndCreateSuccessor / advanceAfterSuccessfulAction
 * 4. shouldExecuteSequenceOutbound gate
 * 5. authorizeStageReview / pauseForStageReview (exact-version + pause/resume)
 * 6. detectCollision + transition audit ledger
 * 7. repair / recycle resume helpers
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyOutboundPolicy,
} from '../dist/orchestrator/policy/apply-record.js';
import {
  buildContactPlan,
  mergeContactPlan,
  rotateContact,
  applyContactRotation,
  allocateMail,
  assertActionTarget,
  parseAccountCampaignFromRecord,
} from '../dist/orchestrator/policy/contact-campaign.js';
import {
  createInitialColdState,
  checkStateIntegrity,
  completeActionAndCreateSuccessor,
  canTransitionLifecycle,
  assertLifecycleTransition,
  advanceAfterSuccessfulAction,
  shouldApplyContactRotation,
  NEXT_ACTION_POLICY_VERSION,
} from '../dist/orchestrator/policy/lifecycle.js';
import {
  shouldExecuteSequenceOutbound,
  filterRecordsForSequenceOutbound,
  SEQUENCE_STATES_BLOCK_OUTBOUND,
} from '../dist/orchestrator/policy/sequence-outbound.js';
import {
  authorizeStageReview,
  pauseForStageReview,
  pauseForRepair,
  resumeAfterPause,
  detectCollision,
  createTransitionAudit,
  appendTransitionAudit,
  parseStageReviewJson,
  TRANSITION_AUDIT_VERSION,
  STAGE_REVIEW_POLICY_VERSION,
} from '../dist/orchestrator/policy/transition-audit.js';

// ---------------------------------------------------------------------------
// 1. createInitialColdState integrity
// ---------------------------------------------------------------------------

test('createInitialColdState: cold + not_started + foundational_enrichment next_action has zero integrity errors', () => {
  const state = createInitialColdState('acct_multi_1');
  assert.equal(state.lifecycle_stage, 'cold');
  assert.equal(state.sequence_state, 'not_started');
  assert.equal(state.work_state, 'research_enrichment');
  assert.ok(state.next_action);
  assert.equal(state.next_action.action_type, 'foundational_enrichment');
  assert.equal(state.next_action.account_id, 'acct_multi_1');
  assert.equal(state.next_action.policy_version, NEXT_ACTION_POLICY_VERSION);
  assert.equal(state.next_action.lifecycle_stage, 'cold');
  assert.equal(state.next_action.sequence_state, 'not_started');
  assert.equal(state.next_action.work_state, 'research_enrichment');

  const issues = checkStateIntegrity(state);
  assert.equal(
    issues.filter((i) => i.severity === 'error').length,
    0,
    `unexpected integrity errors: ${JSON.stringify(issues)}`,
  );
  // not_started is non-actionable for the "missing next_action" rule, but we
  // still require a next_action object on cold intake for progression.
  assert.ok(state.next_action.action_id.startsWith('na_intake_'));
});

test('createInitialColdState: deterministic shape for distinct accounts', () => {
  const a = createInitialColdState('a');
  const b = createInitialColdState('b');
  assert.notEqual(a.next_action.action_id, b.next_action.action_id);
  assert.equal(a.next_action.action_type, b.next_action.action_type);
  assert.equal(checkStateIntegrity(a).filter((i) => i.severity === 'error').length, 0);
  assert.equal(checkStateIntegrity(b).filter((i) => i.severity === 'error').length, 0);
});

// ---------------------------------------------------------------------------
// 2. rotate + merge plan
// ---------------------------------------------------------------------------

const threeContacts = () => [
  { contact_id: 'c_owner', outbound_disposition: 'eligible_target', outreach_rank: 1 },
  { contact_id: 'c_ops', outbound_disposition: 'eligible_target', outreach_rank: 2 },
  { contact_id: 'c_sales', outbound_disposition: 'eligible_target', outreach_rank: 3 },
  { contact_id: 'c_router', outbound_disposition: 'routing_only', outreach_rank: 9 },
];

test('rotate + mergeContactPlan: multi-contact handoff survives re-rank / re-apply', () => {
  const contacts = threeContacts();
  let plan = buildContactPlan({
    account_id: 'acct_multi_1',
    campaign_id: 'camp_multi_1',
    contacts,
    treatment_tier: 'B',
    mail_treatment: 'standard_postcard',
  });

  // Stable identity: one active, ordered held queue, routing separate
  assert.equal(plan.active_contact_id, 'c_owner');
  assert.deepEqual(plan.held_contact_ids, ['c_ops', 'c_sales']);
  assert.deepEqual(plan.routing_contact_ids, ['c_router']);
  assert.equal(plan.mail_allocated, false);
  assert.equal(plan.ordered_target_contact_ids[0], 'c_owner');

  // Named action may only target active contact
  assertActionTarget({ campaign: plan, contact_id: 'c_owner', channel: 'email' });
  assert.throws(() => assertActionTarget({ campaign: plan, contact_id: 'c_ops', channel: 'email' }));

  // Atomic handoff to next held
  const rotated = rotateContact({ campaign: plan, reason: 'owner_exhausted' });
  assert.equal(rotated.rotated, true);
  assert.equal(rotated.previous_contact_id, 'c_owner');
  plan = rotated.campaign;
  assert.equal(plan.active_contact_id, 'c_ops');
  assert.deepEqual(plan.held_contact_ids, ['c_sales']);

  // Mail once on the campaign (account-level), independent of contact rotation
  plan = allocateMail({ campaign: plan, mail_treatment: 'standard_postcard' });
  assert.equal(plan.mail_allocated, true);
  assert.throws(() => allocateMail({ campaign: plan, mail_treatment: 'standard_postcard' }));

  // Fresh re-rank always restarts at c_owner / mail false — merge must preserve
  const fresh = buildContactPlan({
    account_id: 'acct_multi_1',
    campaign_id: 'camp_multi_1_fresh',
    contacts,
    treatment_tier: 'B',
    mail_treatment: 'standard_postcard',
  });
  assert.equal(fresh.active_contact_id, 'c_owner');
  assert.equal(fresh.mail_allocated, false);

  const merged = mergeContactPlan({ fresh, existing: plan });
  assert.equal(merged.active_contact_id, 'c_ops', 'merge keeps rotated active contact');
  assert.deepEqual(merged.held_contact_ids, ['c_sales']);
  assert.equal(merged.mail_allocated, true, 'merge never clears mail_allocated');
  assert.equal(merged.campaign_id, 'camp_multi_1', 'merge keeps existing campaign_id');
  // Already-tried owner must not re-enter the held queue
  assert.equal(merged.held_contact_ids.includes('c_owner'), false);
  assert.equal(merged.ordered_target_contact_ids.includes('c_owner')
    ? merged.ordered_target_contact_ids[0] === 'c_owner'
    : true, true);

  // Production applyContactRotation helper matches rotateContact
  const viaHelper = applyContactRotation({
    account_contact_plan_json: JSON.stringify(
      buildContactPlan({
        account_id: 'acct_multi_1',
        campaign_id: 'camp_multi_1',
        contacts,
        treatment_tier: 'B',
      }),
    ),
    active_contact_id: 'c_owner',
  }, { reason: 'owner_exhausted' });
  assert.equal(viaHelper.rotated, true);
  assert.equal(viaHelper.active_contact_id, 'c_ops');
  assert.ok(viaHelper.account_contact_plan_json);
  const parsed = parseAccountCampaignFromRecord({
    account_contact_plan_json: viaHelper.account_contact_plan_json,
  });
  assert.equal(parsed.active_contact_id, 'c_ops');
});

test('rotate + merge via applyOutboundPolicy preserves rotation and mail across re-apply', () => {
  const contacts = threeContacts().filter((c) => c.outbound_disposition !== 'routing_only');
  const basePlan = buildContactPlan({
    account_id: 'acct_policy_merge',
    campaign_id: 'camp_pm',
    contacts,
    treatment_tier: 'B',
    mail_treatment: 'standard_postcard',
  });
  const afterRotate = rotateContact({ campaign: basePlan, reason: 'exhaust' }).campaign;
  const afterMail = allocateMail({
    campaign: afterRotate,
    mail_treatment: 'standard_postcard',
  });
  assert.equal(afterMail.active_contact_id, 'c_ops');
  assert.equal(afterMail.mail_allocated, true);

  const result = applyOutboundPolicy({
    record: {
      _row_id: 'acct_policy_merge',
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
      next_action_json: JSON.stringify({
        action_id: 'na_prep_1',
        action_type: 'prepare_outbound',
        account_id: 'acct_policy_merge',
        contact_id: 'c_ops',
        lifecycle_stage: 'contacted',
        sequence_state: 'active',
        work_state: 'content_generation',
        reason: 'mid campaign',
        on_success: 'execute_or_review',
        policy_version: NEXT_ACTION_POLICY_VERSION,
      }),
    },
    contacts,
    campaignId: 'camp_pm_rerun',
  });

  const planAfter = JSON.parse(String(result.patch.account_contact_plan_json || '{}'));
  assert.equal(planAfter.active_contact_id, 'c_ops');
  assert.equal(planAfter.mail_allocated, true);
  assert.equal(result.patch.active_contact_id, 'c_ops');
  assert.equal(result.integrity_errors.length, 0);
});

// ---------------------------------------------------------------------------
// 3. completeAction succession
// ---------------------------------------------------------------------------

test('completeActionAndCreateSuccessor: atomic complete + exactly one successor', () => {
  const cold = createInitialColdState('acct_succ');
  const afterEnrich = completeActionAndCreateSuccessor({
    state: cold,
    completed_action_id: cold.next_action.action_id,
    outcome: 'success',
    evidence: { reason: 'foundational enrichment complete', evidence_ids: ['obs_1'] },
    lifecycle_to: 'cold',
    sequence_to: 'active',
    work_to: 'content_generation',
    successor: {
      action_id: 'na_email_1',
      action_type: 'send_email',
      account_id: 'acct_succ',
      contact_id: 'c_owner',
      lifecycle_stage: 'cold',
      sequence_state: 'active',
      work_state: 'content_generation',
      reason: 'Tier B first email',
      on_success: 'wait_or_followup',
    },
  });

  assert.equal(afterEnrich.next_action.action_id, 'na_email_1');
  assert.equal(afterEnrich.sequence_state, 'active');
  assert.equal(afterEnrich.lifecycle_stage, 'cold'); // sequence does not invent commercial stages
  assert.equal(afterEnrich.work_state, 'content_generation');
  assert.equal(afterEnrich.next_action.policy_version, NEXT_ACTION_POLICY_VERSION);
  assert.equal(
    checkStateIntegrity({
      ...afterEnrich,
      active_contact_id: 'c_owner',
    }).filter((i) => i.severity === 'error').length,
    0,
  );

  // Second succession: email success → wait, with lifecycle cold→contacted
  const afterSend = completeActionAndCreateSuccessor({
    state: {
      ...afterEnrich,
      active_contact_id: 'c_owner',
    },
    completed_action_id: 'na_email_1',
    outcome: 'success',
    evidence: { reason: 'provider accepted email', evidence_ids: ['msg_1'] },
    lifecycle_to: 'contacted',
    sequence_to: 'waiting',
    work_to: 'waiting_time_or_event',
    successor: {
      action_id: 'na_wait_1',
      action_type: 'wait',
      account_id: 'acct_succ',
      contact_id: 'c_owner',
      lifecycle_stage: 'contacted',
      sequence_state: 'waiting',
      work_state: 'waiting_time_or_event',
      due_at: '2026-08-10',
      reason: 'wait for day-3 followup',
      on_success: 'execute_next_sequence_step',
    },
  });

  assert.equal(afterSend.lifecycle_stage, 'contacted');
  assert.equal(afterSend.sequence_state, 'waiting');
  assert.equal(afterSend.next_action.action_id, 'na_wait_1');
  assert.equal(afterSend.next_action.action_type, 'wait');
  assert.equal(afterSend.next_action.due_at, '2026-08-10');
  assert.equal(
    checkStateIntegrity(afterSend).filter((i) => i.severity === 'error').length,
    0,
  );
});

test('completeActionAndCreateSuccessor: rejects mismatched action_id and prohibited lifecycle jumps', () => {
  const cold = createInitialColdState('acct_bad');
  assert.throws(
    () => completeActionAndCreateSuccessor({
      state: cold,
      completed_action_id: 'wrong_id',
      outcome: 'success',
      evidence: { reason: 'x' },
      successor: null,
    }),
    /does not match/,
  );
  assert.equal(canTransitionLifecycle('cold', 'won'), false);
  assert.throws(() => assertLifecycleTransition('cold', 'won', { reason: 'nope' }));
  assert.throws(() => assertLifecycleTransition('cold', 'contacted', { reason: '' }));
});

test('advanceAfterSuccessfulAction: multi-contact sequence complete rotates and installs post-rotation successor', () => {
  const plan = buildContactPlan({
    account_id: 'acct_adv',
    campaign_id: 'camp_adv',
    contacts: threeContacts().filter((c) => c.outbound_disposition !== 'routing_only'),
    treatment_tier: 'B',
  });
  assert.equal(plan.active_contact_id, 'c_owner');
  assert.ok(shouldApplyContactRotation({
    record: {
      account_contact_plan_json: JSON.stringify(plan),
      active_contact_id: 'c_owner',
    },
    next_action: {
      action_id: 'na_last',
      action_type: 'send_email',
      account_id: 'acct_adv',
      contact_id: 'c_owner',
      lifecycle_stage: 'contacted',
      sequence_state: 'active',
      work_state: 'executing_external_action',
      reason: 'last step',
      on_success: 'done',
      policy_version: NEXT_ACTION_POLICY_VERSION,
    },
    sequenceCompleted: true,
  }));

  const result = advanceAfterSuccessfulAction({
    record: {
      _row_id: 'acct_adv',
      lifecycle_stage: 'contacted',
      account_sequence_state: 'active',
      work_state: 'executing_external_action',
      active_contact_id: 'c_owner',
      account_contact_plan_json: JSON.stringify(plan),
      next_action_json: JSON.stringify({
        action_id: 'na_last',
        action_type: 'send_email',
        account_id: 'acct_adv',
        contact_id: 'c_owner',
        lifecycle_stage: 'contacted',
        sequence_state: 'active',
        work_state: 'executing_external_action',
        reason: 'last step on contact',
        on_success: 'evaluate_reply_or_rotate',
        policy_version: NEXT_ACTION_POLICY_VERSION,
      }),
    },
    channel: 'email',
    stepKind: 'send_email',
    stepId: 'email_last',
    sequenceCompleted: true,
    evidence: { reason: 'sequence exhausted on contact', evidence_ids: ['email_last'] },
  });

  assert.equal(result.rotated, true);
  assert.equal(result.previous_contact_id, 'c_owner');
  assert.equal(result.used_complete_action, true);
  assert.equal(result.patch.account_sequence_state, 'active'); // handoff, not completed
  assert.equal(result.patch.work_state, 'content_generation');
  assert.equal(result.patch.active_contact_id, 'c_ops');
  const next = JSON.parse(result.patch.next_action_json);
  assert.equal(next.action_type, 'send_email');
  assert.equal(next.contact_id, 'c_ops');
  assert.equal(result.integrity_errors.length, 0);
  assert.ok(!['won', 'lost', 'disqualified'].includes(result.patch.lifecycle_stage));
});

// ---------------------------------------------------------------------------
// 4. sequencer gate blocks paused states
// ---------------------------------------------------------------------------

const NOW = '2026-08-04T15:00:00.000Z';

const outboundRecord = (overrides = {}) => ({
  _row_id: 'acct_gate',
  sequence_status: 'active',
  sequence_step: 0,
  next_action_date: '2026-08-04',
  account_sequence_state: 'active',
  work_state: 'executing_external_action',
  lifecycle_stage: 'contacted',
  next_action_json: JSON.stringify({
    action_id: 'na_send_1',
    action_type: 'send_email',
    account_id: 'acct_gate',
    contact_id: 'c_owner',
    lifecycle_stage: 'contacted',
    sequence_state: 'active',
    work_state: 'executing_external_action',
    reason: 'ready',
    on_success: 'wait',
    policy_version: NEXT_ACTION_POLICY_VERSION,
  }),
  ...overrides,
});

test('shouldExecuteSequenceOutbound: blocks every paused / recycle_wait / completed / cancelled state', () => {
  assert.ok(SEQUENCE_STATES_BLOCK_OUTBOUND.has('paused_review'));
  assert.ok(SEQUENCE_STATES_BLOCK_OUTBOUND.has('paused_inbound'));
  assert.ok(SEQUENCE_STATES_BLOCK_OUTBOUND.has('paused_repair'));
  assert.ok(SEQUENCE_STATES_BLOCK_OUTBOUND.has('recycle_wait'));
  assert.ok(SEQUENCE_STATES_BLOCK_OUTBOUND.has('completed'));
  assert.ok(SEQUENCE_STATES_BLOCK_OUTBOUND.has('cancelled'));

  for (const sequence_state of SEQUENCE_STATES_BLOCK_OUTBOUND) {
    const d = shouldExecuteSequenceOutbound(
      outboundRecord({ account_sequence_state: sequence_state }),
      NOW,
    );
    assert.equal(d.execute, false, `expected block for ${sequence_state}`);
    assert.equal(d.reason, `sequence_state_${sequence_state}`);
  }
});

test('shouldExecuteSequenceOutbound: allows active outbound; filterRecordsForSequenceOutbound drops paused', () => {
  const allow = shouldExecuteSequenceOutbound(outboundRecord(), NOW);
  assert.equal(allow.execute, true);
  assert.equal(allow.reason, 'outbound_action');

  const paused = outboundRecord({
    _row_id: 'acct_paused',
    account_sequence_state: 'paused_review',
    work_state: 'pending_human_review',
  });
  const active = outboundRecord({ _row_id: 'acct_active' });
  const filtered = filterRecordsForSequenceOutbound([paused, active], NOW);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]._row_id, 'acct_active');
});

test('shouldExecuteSequenceOutbound: non-outbound next_action types block even when sequence is active', () => {
  for (const action_type of [
    'foundational_enrichment',
    'pending_human_review',
    'terminal_recordkeeping',
    'reentry_evaluation',
    'contact_rotation',
  ]) {
    const d = shouldExecuteSequenceOutbound(
      outboundRecord({
        next_action_json: JSON.stringify({
          action_id: `na_${action_type}`,
          action_type,
          account_id: 'acct_gate',
          lifecycle_stage: 'cold',
          sequence_state: 'active',
          work_state: 'research_enrichment',
          reason: action_type,
          on_success: 'next',
          policy_version: NEXT_ACTION_POLICY_VERSION,
        }),
      }),
      NOW,
    );
    assert.equal(d.execute, false, action_type);
  }
});

// ---------------------------------------------------------------------------
// 5. Stage review: pause / exact-version authorize / invalidate
// ---------------------------------------------------------------------------

test('pauseForStageReview + authorizeStageReview: exact-version auth resumes outbound and gates sequencer', () => {
  const accountId = 'acct_review_1';
  const pending = {
    action_id: 'na_send_reviewed',
    action_type: 'send_email',
    account_id: accountId,
    contact_id: 'c_owner',
    lifecycle_stage: 'cold',
    sequence_state: 'active',
    work_state: 'executing_external_action',
    reason: 'first email draft ready',
    on_success: 'wait_or_followup',
    policy_version: NEXT_ACTION_POLICY_VERSION,
  };

  const paused = pauseForStageReview({
    account_id: accountId,
    stage_id: 'email_send',
    asset_version: 'asset_v1',
    contact_id: 'c_owner',
    channel: 'email',
    action_type: 'send_email',
    pending_action: pending,
    lifecycle_stage: 'cold',
    reason: 'human review before first send',
    review_id: 'rev_email_1',
  });

  assert.equal(paused.authorization.status, 'pending');
  assert.equal(paused.authorization.asset_version, 'asset_v1');
  assert.equal(paused.authorization.policy_version, STAGE_REVIEW_POLICY_VERSION);
  assert.equal(paused.patch.account_sequence_state, 'paused_review');
  assert.equal(paused.patch.work_state, 'pending_human_review');
  const reviewNa = JSON.parse(paused.patch.next_action_json);
  assert.equal(reviewNa.action_type, 'pending_human_review');
  assert.equal(reviewNa.related_review_id, 'rev_email_1');
  assert.equal(paused.audit.kind, 'human_decision');

  // Sequencer must block while paused
  const gate = shouldExecuteSequenceOutbound({
    _row_id: accountId,
    account_sequence_state: paused.patch.account_sequence_state,
    next_action_json: paused.patch.next_action_json,
  }, NOW);
  assert.equal(gate.execute, false);
  assert.equal(gate.reason, 'sequence_state_paused_review');

  // Version mismatch refuses authorize
  const bad = authorizeStageReview({
    review_id: 'rev_email_1',
    stage_id: 'email_send',
    asset_version: 'asset_v2_wrong',
    expected_asset_version: 'asset_v1',
    decision: 'authorize',
    account_id: accountId,
    existing: paused.authorization,
    lifecycle_stage: 'cold',
    actor: 'operator_a',
  });
  assert.ok(bad && typeof bad === 'object' && 'allowed' in bad);
  assert.equal(bad.allowed, false);
  assert.equal(bad.reason, 'asset_version_mismatch');
  assert.equal(bad.authorization.status, 'invalidated');
  assert.equal(bad.patch.account_sequence_state, 'paused_review');

  // Correct version authorizes and restores pending outbound
  const ok = authorizeStageReview({
    review_id: 'rev_email_1',
    stage_id: 'email_send',
    asset_version: 'asset_v1',
    expected_asset_version: 'asset_v1',
    decision: 'authorize',
    account_id: accountId,
    existing: paused.authorization,
    lifecycle_stage: 'cold',
    actor: 'operator_a',
    notes: 'looks good',
  });
  assert.ok(ok && typeof ok === 'object' && 'allowed' in ok);
  assert.equal(ok.allowed, true);
  assert.equal(ok.authorization.status, 'authorized');
  assert.equal(ok.authorization.authorized_by, 'operator_a');
  assert.equal(ok.patch.account_sequence_state, 'active');
  assert.equal(ok.patch.work_state, 'executing_external_action');
  const resumed = JSON.parse(ok.patch.next_action_json);
  assert.equal(resumed.action_type, 'send_email');
  assert.equal(resumed.contact_id, 'c_owner');
  assert.equal(resumed.related_review_id, 'rev_email_1');
  assert.equal(ok.audit.kind, 'human_decision');

  const gateOpen = shouldExecuteSequenceOutbound({
    _row_id: accountId,
    account_sequence_state: ok.patch.account_sequence_state,
    next_action_json: ok.patch.next_action_json,
  }, NOW);
  assert.equal(gateOpen.execute, true);
  assert.equal(gateOpen.reason, 'outbound_action');
});

test('authorizeStageReview: regenerate / reject / skip produce deterministic sequence states', () => {
  const existing = {
    review_id: 'rev_2',
    stage_id: 'email_send',
    asset_version: 'av1',
    status: 'pending',
    account_id: 'acct_r2',
    contact_id: 'c1',
    pending_action_snapshot: {
      action_id: 'na_x',
      action_type: 'send_email',
      contact_id: 'c1',
    },
  };

  const regen = authorizeStageReview({
    review_id: 'rev_2',
    stage_id: 'email_send',
    asset_version: 'av1',
    decision: 'regenerate',
    account_id: 'acct_r2',
    existing,
    lifecycle_stage: 'contacted',
    notes: 'tone off',
  });
  assert.ok(regen && 'patch' in regen);
  assert.equal(regen.patch.account_sequence_state, 'paused_repair');
  assert.equal(JSON.parse(regen.patch.next_action_json).action_type, 'content_generation');
  assert.equal(
    shouldExecuteSequenceOutbound({
      account_sequence_state: regen.patch.account_sequence_state,
      next_action_json: regen.patch.next_action_json,
    }, NOW).execute,
    false,
  );

  const skip = authorizeStageReview({
    review_id: 'rev_2',
    stage_id: 'email_send',
    asset_version: 'av1',
    decision: 'skip',
    account_id: 'acct_r2',
    existing,
    lifecycle_stage: 'contacted',
  });
  assert.ok(skip && 'patch' in skip);
  assert.equal(skip.patch.account_sequence_state, 'waiting');
  assert.equal(JSON.parse(skip.patch.next_action_json).action_type, 'wait');

  // Legacy simple shape (no coupling fields) still returns authorization only
  const simple = authorizeStageReview({
    review_id: 'r',
    stage_id: 's',
    asset_version: 'v',
    decision: 'authorize',
    actor: 'h',
  });
  assert.equal(simple.status, 'authorized');
  assert.equal(simple.authorized_by, 'h');
  assert.equal('allowed' in simple, false);
});

// ---------------------------------------------------------------------------
// 6. Collision detection + transition audit ledger
// ---------------------------------------------------------------------------

test('detectCollision: inactive contact, in-flight channel, suppressed contact', () => {
  assert.equal(detectCollision({
    active_contact_id: 'c1',
    proposed_contact_id: 'c1',
  }).collision, false);

  const inactive = detectCollision({
    active_contact_id: 'c1',
    proposed_contact_id: 'c2',
  });
  assert.equal(inactive.collision, true);
  assert.ok(inactive.reasons.includes('proposed_contact_not_active'));

  const inflight = detectCollision({
    active_contact_id: 'c1',
    proposed_contact_id: 'c1',
    same_channel_in_flight: true,
  });
  assert.equal(inflight.collision, true);
  assert.ok(inflight.reasons.includes('same_channel_in_flight'));

  const suppressed = detectCollision({
    active_contact_id: 'c1',
    proposed_contact_id: 'c2',
    suppressed_contact_ids: ['c2'],
  });
  assert.equal(suppressed.collision, true);
  assert.ok(suppressed.reasons.includes('proposed_contact_suppressed'));
});

test('transition audit: create/append + advanceAfterSuccessfulAction writes ledger', () => {
  const a = createTransitionAudit({
    account_id: 'acct_aud',
    kind: 'lifecycle',
    from_state: 'cold',
    to_state: 'contacted',
    reason: 'first_outbound',
  });
  assert.ok(a.audit_id);
  assert.equal(a.policy_version, TRANSITION_AUDIT_VERSION);

  const json = appendTransitionAudit(null, a);
  const list = JSON.parse(json);
  assert.equal(list.length, 1);

  const advanced = advanceAfterSuccessfulAction({
    record: {
      _row_id: 'acct_aud',
      lifecycle_stage: 'cold',
      account_sequence_state: 'active',
      work_state: 'executing_external_action',
      active_contact_id: 'c_owner',
      transition_audit_json: json,
      next_action_json: JSON.stringify({
        action_id: 'na_s',
        action_type: 'send_email',
        account_id: 'acct_aud',
        contact_id: 'c_owner',
        lifecycle_stage: 'cold',
        sequence_state: 'active',
        work_state: 'executing_external_action',
        reason: 'send',
        on_success: 'wait',
        policy_version: NEXT_ACTION_POLICY_VERSION,
      }),
    },
    channel: 'email',
    stepKind: 'send_email',
    sequenceCompleted: false,
    evidence: { reason: 'sent', evidence_ids: ['e1'] },
  });
  assert.ok(advanced.patch.transition_audit_json);
  const ledger = JSON.parse(advanced.patch.transition_audit_json);
  assert.ok(ledger.length >= 2);
  assert.ok(advanced.audit);
  assert.equal(advanced.audit.account_id, 'acct_aud');
  assert.equal(advanced.patch.lifecycle_stage, 'contacted');
});

test('detectCollision feeds applyOutboundPolicy readiness collision blocker', () => {
  const out = applyOutboundPolicy({
    record: {
      _row_id: 'acct_col',
      fit_score: 80,
      fit_evidence_confidence: 80,
      identity_confidence: 90,
      buyer_confidence: 70,
      address_rdi: 'Commercial',
      contact_email: 'a@b.test',
      email_confidence: 90,
      proposed_contact_id: 'c_other',
      active_contact_id: 'c_owner',
      same_channel_in_flight: true,
    },
    contacts: threeContacts().filter((c) => c.outbound_disposition !== 'routing_only'),
  });
  const readiness = JSON.parse(String(out.patch.readiness_json));
  const collision = JSON.parse(String(out.patch.collision_json));
  assert.equal(collision.collision, true);
  assert.ok(readiness.blockers.some((b) => String(b).includes('collision') || b === 'channel_or_contact_collision'));
  assert.ok(out.patch.transition_audit_json);
});

// ---------------------------------------------------------------------------
// 7. Repair / recycle pause and resumption
// ---------------------------------------------------------------------------

test('pauseForRepair + resumeAfterPause: sequencer blocks then allows outbound', () => {
  const repair = pauseForRepair({
    account_id: 'acct_rep',
    contact_id: 'c1',
    lifecycle_stage: 'contacted',
    channel: 'email',
    reason: 'mailbox bounce',
  });
  assert.equal(repair.patch.account_sequence_state, 'paused_repair');
  assert.equal(
    shouldExecuteSequenceOutbound({
      account_sequence_state: repair.patch.account_sequence_state,
      next_action_json: repair.patch.next_action_json,
    }, NOW).execute,
    false,
  );

  const resume = resumeAfterPause({
    account_id: 'acct_rep',
    from_sequence_state: 'paused_repair',
    contact_id: 'c1',
    lifecycle_stage: 'contacted',
    successor_action_type: 'send_email',
    reason: 'mailbox repaired',
  });
  assert.equal(resume.patch.account_sequence_state, 'active');
  assert.equal(
    shouldExecuteSequenceOutbound({
      account_sequence_state: resume.patch.account_sequence_state,
      next_action_json: resume.patch.next_action_json,
    }, NOW).execute,
    true,
  );

  const recycleResume = resumeAfterPause({
    account_id: 'acct_rep',
    from_sequence_state: 'recycle_wait',
    contact_id: 'c1',
    lifecycle_stage: 'recycled',
    successor_action_type: 'reentry_evaluation',
    reason: 'recycle window elapsed',
  });
  assert.equal(JSON.parse(recycleResume.patch.next_action_json).action_type, 'reentry_evaluation');
  assert.equal(
    shouldExecuteSequenceOutbound({
      account_sequence_state: recycleResume.patch.account_sequence_state,
      next_action_json: recycleResume.patch.next_action_json,
    }, NOW).execute,
    false,
    'reentry_evaluation is non-outbound',
  );
});

// ---------------------------------------------------------------------------
// Multi-contact controlled internal path (Complete-when logical demo, pure)
// ---------------------------------------------------------------------------

test('Complete-when path: multi-contact through cold → review → authorize → send → wait → rotate', () => {
  const accountId = 'acct_complete_when';
  const contacts = threeContacts().filter((c) => c.outbound_disposition !== 'routing_only');

  // Intake
  let state = createInitialColdState(accountId);
  assert.equal(checkStateIntegrity(state).filter((i) => i.severity === 'error').length, 0);

  // Policy projection with multi-contact plan (no provider, no TV content)
  const policy = applyOutboundPolicy({
    record: {
      _row_id: accountId,
      fit_score: 75,
      fit_evidence_confidence: 85,
      identity_confidence: 90,
      buyer_confidence: 75,
      address_rdi: 'Commercial',
      contact_email: 'owner@example.test',
      email_confidence: 85,
      lifecycle_stage: 'cold',
      account_sequence_state: 'not_started',
      work_state: 'research_enrichment',
    },
    contacts,
    campaignId: `camp_${accountId}`,
  });
  assert.equal(policy.treatment_tier, 'B');
  assert.ok(policy.campaign);
  assert.equal(policy.campaign.active_contact_id, 'c_owner');
  assert.deepEqual(policy.campaign.held_contact_ids, ['c_ops', 'c_sales']);
  assert.ok(policy.next_action);
  assert.equal(policy.integrity_errors.length, 0);
  // Policy apply writes transition audit + collision surface
  assert.ok(policy.patch.transition_audit_json);
  assert.ok(policy.patch.collision_json);

  const pendingSend = {
    action_id: 'na_send_owner',
    action_type: 'send_email',
    account_id: accountId,
    contact_id: 'c_owner',
    lifecycle_stage: 'cold',
    sequence_state: 'active',
    work_state: 'executing_external_action',
    reason: 'first touch',
    on_success: 'wait_or_followup',
    policy_version: NEXT_ACTION_POLICY_VERSION,
  };

  // Stage review pause (version-bound) — no provider
  const paused = pauseForStageReview({
    account_id: accountId,
    stage_id: 'email_send',
    asset_version: 'email_body_v1',
    contact_id: 'c_owner',
    channel: 'email',
    action_type: 'send_email',
    pending_action: pendingSend,
    lifecycle_stage: 'cold',
    review_id: 'rev_complete_when',
  });
  assert.equal(paused.patch.account_sequence_state, 'paused_review');
  assert.equal(
    shouldExecuteSequenceOutbound({
      _row_id: accountId,
      account_sequence_state: paused.patch.account_sequence_state,
      next_action_json: paused.patch.next_action_json,
    }, NOW).execute,
    false,
  );
  const parsedReview = parseStageReviewJson(paused.patch.stage_review_json);
  assert.ok(parsedReview);
  assert.equal(parsedReview.status, 'pending');

  // Human authorizes exact asset version
  const authorized = authorizeStageReview({
    review_id: 'rev_complete_when',
    stage_id: 'email_send',
    asset_version: 'email_body_v1',
    expected_asset_version: 'email_body_v1',
    decision: 'authorize',
    account_id: accountId,
    existing: paused.authorization,
    lifecycle_stage: 'cold',
    actor: 'reviewer_1',
  });
  assert.ok(authorized && 'allowed' in authorized);
  assert.equal(authorized.allowed, true);
  assert.equal(authorized.patch.account_sequence_state, 'active');
  const authorizedNa = JSON.parse(authorized.patch.next_action_json);
  assert.equal(authorizedNa.action_type, 'send_email');

  // Channel success path (pure helper — no provider) + transition audit
  const advanced = advanceAfterSuccessfulAction({
    record: {
      _row_id: accountId,
      lifecycle_stage: 'cold',
      account_sequence_state: authorized.patch.account_sequence_state,
      work_state: authorized.patch.work_state,
      active_contact_id: 'c_owner',
      account_contact_plan_json: JSON.stringify(policy.campaign),
      next_action_json: authorized.patch.next_action_json,
      treatment_tier: policy.treatment_tier,
      transition_audit_json: appendTransitionAudit(
        policy.patch.transition_audit_json,
        authorized.audit,
      ),
    },
    channel: 'email',
    stepKind: 'send_email',
    stepId: 'email_1',
    sequenceCompleted: false,
    evidence: { reason: 'simulated send success', evidence_ids: ['sim_1'] },
  });
  assert.equal(advanced.patch.lifecycle_stage, 'contacted');
  assert.equal(advanced.patch.account_sequence_state, 'waiting');
  assert.equal(advanced.rotated, false);
  const wait = JSON.parse(advanced.patch.next_action_json);
  assert.equal(wait.action_type, 'wait');
  assert.ok(wait.due_at);
  assert.ok(advanced.patch.transition_audit_json);
  assert.ok(JSON.parse(advanced.patch.transition_audit_json).length >= 2);

  // Wait not due → sequencer blocked; wait due → allowed
  const notDue = shouldExecuteSequenceOutbound({
    _row_id: accountId,
    account_sequence_state: 'waiting',
    next_action_json: advanced.patch.next_action_json,
  }, '2020-01-01T00:00:00.000Z');
  // due_at is now+2d from advance; far-past "now" means not due if due is future... 
  // actually isDueAtOrBefore: due in future vs now=2020 → due is NOT before now if due is 2026.
  // advance sets due_at to ~now+2d at test runtime (2026), so with now=2020, wait is NOT due.
  assert.equal(notDue.execute, false);
  assert.equal(notDue.reason, 'wait_not_due');

  const due = shouldExecuteSequenceOutbound({
    _row_id: accountId,
    account_sequence_state: 'waiting',
    next_action_json: advanced.patch.next_action_json,
  }, '2099-01-01T00:00:00.000Z');
  assert.equal(due.execute, true);
  assert.equal(due.reason, 'wait_due');

  // Exhaust contact sequence → rotate handoff to held contact
  const handoff = advanceAfterSuccessfulAction({
    record: {
      _row_id: accountId,
      lifecycle_stage: 'contacted',
      account_sequence_state: 'active',
      work_state: 'executing_external_action',
      active_contact_id: 'c_owner',
      account_contact_plan_json: JSON.stringify(policy.campaign),
      transition_audit_json: advanced.patch.transition_audit_json,
      next_action_json: JSON.stringify({
        action_id: 'na_last_owner',
        action_type: 'send_email',
        account_id: accountId,
        contact_id: 'c_owner',
        lifecycle_stage: 'contacted',
        sequence_state: 'active',
        work_state: 'executing_external_action',
        reason: 'last step owner',
        on_success: 'rotate',
        policy_version: NEXT_ACTION_POLICY_VERSION,
      }),
    },
    channel: 'email',
    stepKind: 'send_email',
    sequenceCompleted: true,
  });
  assert.equal(handoff.rotated, true);
  assert.equal(handoff.patch.active_contact_id, 'c_ops');
  assert.equal(handoff.patch.account_sequence_state, 'active');
  const post = JSON.parse(handoff.patch.next_action_json);
  assert.equal(post.contact_id, 'c_ops');
  assert.equal(post.action_type, 'send_email');
  assert.equal(handoff.integrity_errors.length, 0);
  assert.ok(handoff.audit);

  // Merge plan after handoff still preserves rotation if re-applied
  const afterRotatePlan = JSON.parse(String(handoff.patch.account_contact_plan_json));
  const fresh = buildContactPlan({
    account_id: accountId,
    campaign_id: 'camp_fresh',
    contacts,
    treatment_tier: 'B',
  });
  const merged = mergeContactPlan({ fresh, existing: afterRotatePlan });
  assert.equal(merged.active_contact_id, 'c_ops');
});
