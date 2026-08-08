/**
 * Campaign process enforcement: age, per-contact allowances, quiet period,
 * call capacity ranking (Tier A-first / B spillover), annual limits, exhaustion.
 */

import {
  DEFAULT_CONTACT_POLICY,
  resolveContactPolicy,
  type ContactPolicyConfigInput,
} from '../../schemas/config.js';
import type { AccountCampaign } from './contact-campaign.js';
import { nowIso } from '../lib/record.js';

export const CAMPAIGN_PROCESS_VERSION = 'tv-campaign-process-v1';

/** Business-day oriented max ages (doc-aligned). */
export const CAMPAIGN_MAX_AGE_BUSINESS_DAYS: Record<string, number> = {
  ...DEFAULT_CONTACT_POLICY.campaign.max_age_business_days,
};

/** Automated action ceilings per contact (doc-aligned, lower than provisional). */
export const PER_CONTACT_AUTOMATED_ALLOWANCES: Record<string, number> = {
  ...DEFAULT_CONTACT_POLICY.per_contact_allowances,
};

export const INTER_CONTACT_QUIET_BUSINESS_DAYS = DEFAULT_CONTACT_POLICY.campaign.quiet_period_business_days;
export const ANNUAL_CAMPAIGN_LIMIT = DEFAULT_CONTACT_POLICY.campaign.annual_campaign_limit;

export type CampaignProcessCheck = {
  allowed: boolean;
  blockers: string[];
  warnings: string[];
  process_version: string;
};

function businessDaysBetween(startIso: string, endIso: string): number {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return 0;
  let days = 0;
  const cur = new Date(start);
  cur.setHours(0, 0, 0, 0);
  const endDay = new Date(end);
  endDay.setHours(0, 0, 0, 0);
  while (cur < endDay) {
    cur.setDate(cur.getDate() + 1);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) days += 1;
  }
  return days;
}

export function checkCampaignAge(input: {
  campaign: AccountCampaign;
  treatment_tier: string;
  asOf?: string;
  contactPolicy?: ContactPolicyConfigInput;
}): CampaignProcessCheck {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const asOf = input.asOf || nowIso();
  const tier = input.treatment_tier || 'D';
  const campaignPolicy = resolveContactPolicy(input.contactPolicy).campaign;
  const maxDays = campaignPolicy.max_age_business_days[tier]
    ?? campaignPolicy.max_age_business_days_unknown_tier;
  if (maxDays <= 0) {
    return { allowed: tier === 'D' || tier === 'enrichment_hold', blockers: tier === 'D' ? ['tier_d_no_campaign_age'] : [], warnings, process_version: CAMPAIGN_PROCESS_VERSION };
  }
  const started = input.campaign.started_at || asOf;
  const age = businessDaysBetween(String(started), asOf);
  if (age > maxDays) {
    blockers.push(`campaign_age_exceeded:${age}>${maxDays}`);
  }
  return { allowed: blockers.length === 0, blockers, warnings, process_version: CAMPAIGN_PROCESS_VERSION };
}

export function checkContactAllowance(input: {
  treatment_tier: string;
  automated_actions_used: number;
  contactPolicy?: ContactPolicyConfigInput;
}): CampaignProcessCheck {
  const blockers: string[] = [];
  const tier = input.treatment_tier || 'D';
  const max = resolveContactPolicy(input.contactPolicy).per_contact_allowances[tier] ?? 0;
  if (input.automated_actions_used >= max) {
    blockers.push(`per_contact_allowance_exceeded:${input.automated_actions_used}>=${max}`);
  }
  return {
    allowed: blockers.length === 0,
    blockers,
    warnings: [],
    process_version: CAMPAIGN_PROCESS_VERSION,
  };
}

export function checkQuietPeriod(input: {
  last_rotation_at?: string | null;
  asOf?: string;
  quiet_days?: number;
  contactPolicy?: ContactPolicyConfigInput;
}): CampaignProcessCheck {
  const blockers: string[] = [];
  const quiet = input.quiet_days
    ?? resolveContactPolicy(input.contactPolicy).campaign.quiet_period_business_days;
  if (!input.last_rotation_at) {
    return { allowed: true, blockers, warnings: [], process_version: CAMPAIGN_PROCESS_VERSION };
  }
  const asOf = input.asOf || nowIso();
  const days = businessDaysBetween(String(input.last_rotation_at), asOf);
  if (days < quiet) {
    blockers.push(`inter_contact_quiet_period:${days}<${quiet}`);
  }
  return { allowed: blockers.length === 0, blockers, warnings: [], process_version: CAMPAIGN_PROCESS_VERSION };
}

export function checkAnnualCampaignLimit(input: {
  campaigns_in_last_12_months: number;
  contactPolicy?: ContactPolicyConfigInput;
}): CampaignProcessCheck {
  const blockers: string[] = [];
  const annualCampaignLimit = resolveContactPolicy(input.contactPolicy).campaign.annual_campaign_limit;
  if (input.campaigns_in_last_12_months >= annualCampaignLimit) {
    blockers.push(`annual_campaign_limit:${input.campaigns_in_last_12_months}>=${annualCampaignLimit}`);
  }
  return { allowed: blockers.length === 0, blockers, warnings: [], process_version: CAMPAIGN_PROCESS_VERSION };
}

/**
 * Rank call candidates: Tier A first, then Tier B spillover.
 * Higher fit_score within tier ranks higher; capacity truncates.
 */
export function rankCallCapacity(input: {
  candidates: Array<{
    record_id: string;
    treatment_tier: string;
    fit_score?: number;
    priority_rank?: number;
    prepared?: boolean;
  }>;
  capacity: number;
}): Array<{ record_id: string; treatment_tier: string; rank: number; spillover: boolean }> {
  const capacity = Math.max(0, Number(input.capacity) || 0);
  const a = input.candidates
    .filter((c) => c.treatment_tier === 'A')
    .sort((x, y) => (y.fit_score || 0) - (x.fit_score || 0) || (x.priority_rank || 999) - (y.priority_rank || 999));
  const b = input.candidates
    .filter((c) => c.treatment_tier === 'B')
    .sort((x, y) => (y.fit_score || 0) - (x.fit_score || 0) || (x.priority_rank || 999) - (y.priority_rank || 999));
  const ordered = [...a.map((c) => ({ ...c, spillover: false })), ...b.map((c) => ({ ...c, spillover: true }))];
  return ordered.slice(0, capacity).map((c, i) => ({
    record_id: c.record_id,
    treatment_tier: c.treatment_tier,
    rank: i + 1,
    spillover: c.spillover,
  }));
}

export function evaluateCampaignProcess(input: {
  campaign: AccountCampaign;
  treatment_tier: string;
  automated_actions_used?: number;
  last_rotation_at?: string | null;
  campaigns_in_last_12_months?: number;
  asOf?: string;
  contactPolicy?: ContactPolicyConfigInput;
}): CampaignProcessCheck {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const checks = [
    checkCampaignAge({
      campaign: input.campaign,
      treatment_tier: input.treatment_tier,
      asOf: input.asOf,
      contactPolicy: input.contactPolicy,
    }),
    checkContactAllowance({
      treatment_tier: input.treatment_tier,
      automated_actions_used: input.automated_actions_used ?? 0,
      contactPolicy: input.contactPolicy,
    }),
    checkQuietPeriod({
      last_rotation_at: input.last_rotation_at,
      asOf: input.asOf,
      contactPolicy: input.contactPolicy,
    }),
    checkAnnualCampaignLimit({
      campaigns_in_last_12_months: input.campaigns_in_last_12_months ?? 0,
      contactPolicy: input.contactPolicy,
    }),
  ];
  for (const c of checks) {
    blockers.push(...c.blockers);
    warnings.push(...c.warnings);
  }
  return {
    allowed: blockers.length === 0,
    blockers,
    warnings,
    process_version: CAMPAIGN_PROCESS_VERSION,
  };
}

/** Recycle wait periods by treatment tier (calendar days) after exhaustion. */
export const RECYCLE_WAIT_DAYS: Record<string, number> = {
  ...DEFAULT_CONTACT_POLICY.campaign.recycle_wait_days,
};

export type ExhaustionDecision = {
  exhausted: boolean;
  reason: string;
  recycle_wait_days: number;
  next_action_type: 'reentry_evaluation' | 'prepare_outbound' | 'channel_repair';
  sequence_state: 'recycle_wait' | 'paused_repair' | 'active';
};

/**
 * Decide exhaustion → recycle without inventing DQ.
 * Exhausted when campaign age exceeded OR no remaining contacts and allowances spent.
 */
export function evaluateCampaignExhaustion(input: {
  campaign: AccountCampaign;
  treatment_tier: string;
  automated_actions_used?: number;
  asOf?: string;
  channel_needs_repair?: boolean;
  contactPolicy?: ContactPolicyConfigInput;
}): ExhaustionDecision {
  const tier = input.treatment_tier || 'D';
  const campaignPolicy = resolveContactPolicy(input.contactPolicy).campaign;
  const wait = campaignPolicy.recycle_wait_days[tier]
    ?? campaignPolicy.recycle_wait_days_unknown_tier;
  if (input.channel_needs_repair) {
    return {
      exhausted: false,
      reason: 'channel_repair_required',
      recycle_wait_days: 0,
      next_action_type: 'channel_repair',
      sequence_state: 'paused_repair',
    };
  }
  const age = checkCampaignAge({
    campaign: input.campaign,
    treatment_tier: tier,
    asOf: input.asOf,
    contactPolicy: input.contactPolicy,
  });
  const allowance = checkContactAllowance({
    treatment_tier: tier,
    automated_actions_used: input.automated_actions_used ?? 0,
    contactPolicy: input.contactPolicy,
  });
  const held = (input.campaign.held_contact_ids || []).length;
  const active = input.campaign.active_contact_id;
  const noContactsLeft = !active && held === 0;
  if (age.blockers.length || (allowance.blockers.length && noContactsLeft) || noContactsLeft) {
    return {
      exhausted: true,
      reason: age.blockers[0] || allowance.blockers[0] || 'contacts_exhausted',
      recycle_wait_days: wait,
      next_action_type: 'reentry_evaluation',
      sequence_state: 'recycle_wait',
    };
  }
  return {
    exhausted: false,
    reason: 'campaign_active',
    recycle_wait_days: 0,
    next_action_type: 'prepare_outbound',
    sequence_state: 'active',
  };
}

/**
 * Build re-entry gate after recycle wait: allowed only if suppressions clear and
 * annual campaign limit not exceeded.
 */
export function evaluateReentry(input: {
  campaigns_in_last_12_months?: number;
  suppressed?: boolean;
  still_eligible?: boolean;
  contactPolicy?: ContactPolicyConfigInput;
}): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.suppressed) reasons.push('still_suppressed');
  if (input.still_eligible === false) reasons.push('no_longer_eligible');
  if (
    (input.campaigns_in_last_12_months ?? 0)
    >= resolveContactPolicy(input.contactPolicy).campaign.annual_campaign_limit
  ) {
    reasons.push('annual_campaign_limit');
  }
  return { allowed: reasons.length === 0, reasons };
}
