import assert from 'node:assert/strict';
import test from 'node:test';

import { nowIso } from '../dist/orchestrator/lib/record.js';
import {
  checkQuietPeriod,
} from '../dist/orchestrator/policy/campaign-process.js';
import { applyOutboundPolicy } from '../dist/orchestrator/policy/apply-record.js';
import { buildContactPlan } from '../dist/orchestrator/policy/contact-campaign.js';
import { calculateTimingScore } from '../dist/orchestrator/policy/timing-reachability.js';
import { resolveWaitDueAt } from '../dist/orchestrator/policy/lifecycle.js';
import { shouldExecuteSequenceOutbound } from '../dist/orchestrator/policy/sequence-outbound.js';
import { evaluateLinkedinConnectGate } from '../dist/orchestrator/policy/linkedin-lifecycle.js';
import { evaluatePhoneAttemptEligibility } from '../dist/orchestrator/policy/phone-attempt.js';
import { isClaimLeaseActive } from '../dist/orchestrator/operator/call-board.js';
import { countMailboxSendsToday } from '../dist/orchestrator/lib/mailboxes.js';
import { enrichDepHash, isEnrichFresh } from '../dist/orchestrator/enrichment/runner.js';

const withClock = (value, run) => {
  const previous = process.env.AO_NOW;
  process.env.AO_NOW = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.AO_NOW;
    else process.env.AO_NOW = previous;
  }
};

const campaignRecord = (plan) => ({
  _row_id: 'clock_account',
  fit_score: 72,
  fit_evidence_confidence: 80,
  identity_confidence: 90,
  buyer_confidence: 70,
  address_rdi: 'Commercial',
  account_contact_plan_json: JSON.stringify(plan),
  active_contact_id: plan.active_contact_id,
  lifecycle_stage: 'contacted',
  account_sequence_state: 'active',
  work_state: 'content_generation',
  last_contact_rotation_at: '2026-08-07T03:22:38.000Z',
});

test('injected clock drives quiet-period decisions through the policy entry point', () => {
  const plan = {
    ...buildContactPlan({
      account_id: 'clock_account',
      campaign_id: 'clock_campaign',
      contacts: [{ contact_id: 'clock_contact', outbound_disposition: 'eligible_target' }],
      treatment_tier: 'B',
    }),
    started_at: '2026-08-01T00:00:00.000Z',
  };

  const inside = withClock('2026-08-08T16:00:00.000Z', () => {
    assert.equal(nowIso(), '2026-08-08T16:00:00.000Z');
    const direct = checkQuietPeriod({ last_rotation_at: '2026-08-07T03:22:38.000Z' });
    const applied = applyOutboundPolicy({ record: campaignRecord(plan) });
    return { direct, applied };
  });
  assert.deepEqual(inside.direct.blockers, ['inter_contact_quiet_period:1<3']);
  assert.ok(inside.applied.readiness?.blockers.includes('inter_contact_quiet_period:1<3'));

  const past = withClock('2026-08-21T16:00:00.000Z', () => {
    const direct = checkQuietPeriod({ last_rotation_at: '2026-08-07T03:22:38.000Z' });
    const applied = applyOutboundPolicy({ record: campaignRecord(plan) });
    return { direct, applied };
  });
  assert.equal(past.direct.allowed, true);
  assert.equal(
    past.applied.readiness?.blockers.some((blocker) => blocker.startsWith('inter_contact_quiet_period:')),
    false,
  );
});

test('other decision gates use the injected clock when no explicit instant is supplied', () => {
  const timing = withClock('2026-08-11T16:00:00.000Z', () => calculateTimingScore({
    timing_signals_json: JSON.stringify([{
      id: 'hiring_spike',
      strength: 80,
      observed_at: '2026-08-01T16:00:00.000Z',
      half_life_days: 10,
    }]),
  }));
  assert.equal(timing.generated_at, '2026-08-11T16:00:00.000Z');
  assert.equal(timing.timing_score, 40);

  const waitDue = withClock('2026-08-11T16:00:00.000Z', () => resolveWaitDueAt({}));
  assert.equal(waitDue, '2026-08-13');

  const sequenceGate = withClock('2026-08-11T16:00:00.000Z', () => shouldExecuteSequenceOutbound({
    account_sequence_state: 'waiting',
    next_action_json: JSON.stringify({ action_id: 'clock_wait', action_type: 'wait', due_at: '2026-08-10T00:00:00.000Z' }),
  }));
  assert.equal(sequenceGate.reason, 'wait_due');

  const linkedinGate = withClock('2026-08-11T16:00:00.000Z', () => evaluateLinkedinConnectGate({
    linkedin_lifecycle_state: 'invite_sent',
    linkedin_invite_sent_at: '2026-08-10T16:00:00.000Z',
  }));
  assert.equal(linkedinGate.allowed, true);

  const phoneGate = withClock('2026-08-05T16:00:00.000Z', () => evaluatePhoneAttemptEligibility({
    treatment_tier: 'B',
    call_attempt_count: 0,
  }, {
    config: { timeZone: 'America/Boise' },
  }));
  assert.equal(phoneGate.eligible, true);

  const leaseActive = withClock('2026-08-11T16:00:00.000Z', () => isClaimLeaseActive({
    call_claim_status: 'claimed',
    call_claim_expires_at: '2026-08-11T17:00:00.000Z',
  }));
  assert.equal(leaseActive, true);
});

test('injected clock sets mailbox caps and enrichment freshness boundaries', () => {
  const queryAt = withClock('2026-08-11T16:00:00.000Z', () => {
    const db = {
      prepare: () => ({
        get: (at) => ({ n: at === '2026-08-11T00:00:00.000Z' ? 2 : 0 }),
      }),
    };
    return countMailboxSendsToday(db, 'mailbox-1');
  });
  assert.equal(queryAt, 2);

  const stepConfig = { cache_ttl_seconds: 3_600 };
  const cached = {
    dep_hash: enrichDepHash(stepConfig),
    cache_ttl_seconds: 3_600,
    updated_at: '2026-08-11T15:30:00.000Z',
  };
  assert.equal(withClock('2026-08-11T16:00:00.000Z', () => isEnrichFresh({ cached, stepConfig })), true);
  assert.equal(withClock('2026-08-11T17:00:01.000Z', () => isEnrichFresh({ cached, stepConfig })), false);
});
