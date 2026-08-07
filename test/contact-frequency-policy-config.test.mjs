import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../dist/schemas/config.js';
import { buildContactPlan } from '../dist/orchestrator/policy/contact-campaign.js';
import {
  checkAnnualCampaignLimit,
  checkContactAllowance,
  checkQuietPeriod,
  evaluateCampaignExhaustion,
} from '../dist/orchestrator/policy/campaign-process.js';
import { guardChannelExecution } from '../dist/orchestrator/policy/apply-record.js';
import {
  isWithinPhoneAttemptWindow,
  maxPhoneAttemptsForTier,
  resolvePhoneAttemptPolicyConfig,
  scheduleCallbackAt,
} from '../dist/orchestrator/policy/phone-attempt.js';
import { evaluateLinkedinConnectGate } from '../dist/orchestrator/policy/linkedin-lifecycle.js';
import { resolveWaitDueAt } from '../dist/orchestrator/policy/lifecycle.js';

const contact = {
  contact_id: 'contact-1',
  outbound_disposition: 'eligible_target',
  outreach_rank: 1,
};

const planFor = (contactPolicy) => buildContactPlan({
  account_id: 'account-1',
  campaign_id: 'campaign-1',
  contacts: [contact],
  treatment_tier: 'A',
  contactPolicy,
});

test('contact frequency campaign defaults reproduce values, overrides apply, and malformed values reject', () => {
  const defaults = normalizeConfig({}).config.contact_policy;
  assert.deepEqual(defaults.per_contact_allowances, { A: 3, B: 2, C: 1, D: 0, enrichment_hold: 0 });
  assert.deepEqual(defaults.campaign.max_age_business_days, { A: 40, B: 30, C: 20, D: 0, enrichment_hold: 14 });
  assert.equal(defaults.campaign.max_age_business_days_unknown_tier, 30);
  assert.equal(defaults.campaign.quiet_period_business_days, 3);
  assert.equal(defaults.campaign.annual_campaign_limit, 2);
  assert.deepEqual(defaults.campaign.recycle_wait_days, { A: 90, B: 60, C: 45, D: 30, enrichment_hold: 14 });
  assert.equal(defaults.campaign.recycle_wait_days_unknown_tier, 60);

  const contactPolicy = normalizeConfig({
    contact_policy: {
      per_contact_allowances: { A: 2 },
      campaign: {
        max_age_business_days: { A: 12 },
        quiet_period_business_days: 4,
        annual_campaign_limit: 3,
        recycle_wait_days: { A: 7 },
      },
    },
  }).config.contact_policy;
  const plan = planFor(contactPolicy);
  assert.equal(plan.per_contact_action_allowance, 2);
  assert.equal(plan.campaign_max_age_days, 12);
  assert.equal(checkContactAllowance({ treatment_tier: 'A', automated_actions_used: 2, contactPolicy }).allowed, false);
  assert.equal(checkQuietPeriod({
    last_rotation_at: '2026-08-03T12:00:00.000Z',
    asOf: '2026-08-06T12:00:00.000Z',
    contactPolicy,
  }).allowed, false);
  assert.equal(checkAnnualCampaignLimit({
    campaigns_in_last_12_months: 3,
    contactPolicy,
  }).allowed, false);
  assert.equal(evaluateCampaignExhaustion({
    campaign: { ...plan, active_contact_id: null, held_contact_ids: [] },
    treatment_tier: 'A',
    contactPolicy,
  }).recycle_wait_days, 7);

  assert.ok(normalizeConfig({
    contact_policy: { campaign: { annual_campaign_limit: -1 } },
  }).errors.length > 0);
});

test('contact frequency phone defaults reproduce values, overrides apply, and malformed values reject', () => {
  const defaults = normalizeConfig({}).config;
  const defaultPhone = resolvePhoneAttemptPolicyConfig(defaults);
  assert.equal(defaultPhone.startHour, 9);
  assert.equal(defaultPhone.endHour, 17);
  assert.equal(defaultPhone.weekdaysOnly, true);
  assert.equal(defaultPhone.defaultMaxAttempts, 3);
  assert.deepEqual(defaultPhone.maxAttemptsByTier, { default: 3, A: 4, B: 3, C: 0, D: 0, enrichment_hold: 0 });
  assert.equal(defaultPhone.callbackDelayHours, 24);

  const config = normalizeConfig({
    contact_policy: {
      phone: {
        attempt_window: { start_hour: 10, end_hour: 16, weekdays_only: false },
        max_attempts: { A: 2 },
        callback_delay_hours: 6,
      },
    },
  }).config;
  const phone = resolvePhoneAttemptPolicyConfig(config);
  assert.equal(maxPhoneAttemptsForTier('A', undefined, phone), 2);
  assert.equal(isWithinPhoneAttemptWindow('2026-08-08T16:00:00.000Z', {
    ...phone,
    timeZone: 'America/Boise',
  }), true);
  assert.equal(scheduleCallbackAt('2026-08-05T16:00:00.000Z', phone), '2026-08-05T22:00:00.000Z');

  assert.ok(normalizeConfig({
    contact_policy: { phone: { attempt_window: { start_hour: 17, end_hour: 17 } } },
  }).errors.length > 0);
});

test('contact frequency LinkedIn defaults reproduce values, overrides apply, and malformed values reject', () => {
  const defaultPolicy = normalizeConfig({}).config.contact_policy;
  assert.equal(defaultPolicy.linkedin.invite_cooldown_hours, 24);
  const record = {
    linkedin_lifecycle_state: 'none',
    linkedin_last_connect_at: '2026-08-05T16:00:00.000Z',
  };
  assert.equal(evaluateLinkedinConnectGate(record, {
    contactPolicy: defaultPolicy,
    nowMs: Date.parse('2026-08-05T18:00:00.000Z'),
  }).reason, 'cooldown');

  const contactPolicy = normalizeConfig({
    contact_policy: { linkedin: { invite_cooldown_hours: 1 } },
  }).config.contact_policy;
  assert.equal(evaluateLinkedinConnectGate(record, {
    contactPolicy,
    nowMs: Date.parse('2026-08-05T18:00:00.000Z'),
  }).allowed, true);
  assert.ok(normalizeConfig({
    contact_policy: { linkedin: { invite_cooldown_hours: -1 } },
  }).errors.length > 0);
});

test('contact frequency fallback wait defaults reproduce values, overrides apply, and malformed values reject', () => {
  const from = new Date('2026-08-05T16:00:00.000Z');
  assert.equal(resolveWaitDueAt({}, from), '2026-08-07');
  const contactPolicy = normalizeConfig({
    contact_policy: { fallback_wait_days: 5 },
  }).config.contact_policy;
  assert.equal(resolveWaitDueAt({}, from, undefined, contactPolicy), '2026-08-10');
  assert.ok(normalizeConfig({
    contact_policy: { fallback_wait_days: -1 },
  }).errors.length > 0);
});

test('contact frequency allowance remains fail-closed when contact_policy is absent', () => {
  const campaign = planFor(undefined);
  const result = guardChannelExecution({
    record: {
      treatment_tier: 'A',
      automated_actions_used: 3,
      account_contact_plan_json: JSON.stringify(campaign),
    },
    stepKind: 'send_email',
    intent: 'send',
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason || '', /per_contact_allowance_exceeded:3>=3/);
});
