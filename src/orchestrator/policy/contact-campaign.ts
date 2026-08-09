/**
 * One-account campaign with ordered contacts and at most one active contact.
 */

import {
  DEFAULT_CONTACT_POLICY,
  resolveContactPolicy,
  type ContactPolicyConfigInput,
} from '../../schemas/config.js';

export type ContactDisposition =
  | 'active_target'
  | 'eligible_target'
  | 'routing_only'
  | 'excluded'
  | 'unresolved';

export type CampaignContact = {
  contact_id: string;
  outbound_disposition: ContactDisposition;
  outreach_rank: number;
  suppression_state?: string | null;
  engagement_state?: string | null;
};

export type AccountCampaign = {
  account_id: string;
  campaign_id: string;
  ordered_target_contact_ids: string[];
  active_contact_id: string | null;
  held_contact_ids: string[];
  routing_contact_ids: string[];
  excluded_contact_ids: string[];
  mail_allocated: boolean;
  /** The selected pipeline-owned mail product, or the engine's no-mail sentinel. */
  mail_treatment: string;
  per_contact_action_allowance: number;
  campaign_max_age_days: number;
  started_at?: string | null;
  selection_rule_version: string;
};

export const CONTACT_CAMPAIGN_RULE_VERSION = 'contact-campaign-v1';

/** Backward-compatible exports; pipeline defaults now live in contact_policy. */
export const PER_CONTACT_ALLOWANCES: Record<string, number> = {
  ...DEFAULT_CONTACT_POLICY.per_contact_allowances,
};

/** Calendar-day storage mirrors the configured business-day enforcement values. */
export const CAMPAIGN_MAX_AGE_DAYS: Record<string, number> = {
  ...DEFAULT_CONTACT_POLICY.campaign.max_age_business_days,
};

/**
 * Build ordered eligible queue: eligible_target by outreach_rank, then set active = first.
 */
export function buildContactPlan(input: {
  account_id: string;
  campaign_id: string;
  contacts: CampaignContact[];
  treatment_tier: string;
  mail_treatment?: AccountCampaign['mail_treatment'];
  contactPolicy?: ContactPolicyConfigInput;
}): AccountCampaign {
  const contactPolicy = resolveContactPolicy(input.contactPolicy);
  const eligible = input.contacts
    .filter((c) => c.outbound_disposition === 'eligible_target' || c.outbound_disposition === 'active_target')
    .filter((c) => !c.suppression_state || c.suppression_state === 'none')
    .sort((a, b) => a.outreach_rank - b.outreach_rank);

  const routing = input.contacts
    .filter((c) => c.outbound_disposition === 'routing_only')
    .map((c) => c.contact_id);

  const excluded = input.contacts
    .filter((c) => c.outbound_disposition === 'excluded')
    .map((c) => c.contact_id);

  const ordered = eligible.map((c) => c.contact_id);
  const active = ordered[0] || null;
  const held = ordered.slice(1);

  return {
    account_id: input.account_id,
    campaign_id: input.campaign_id,
    ordered_target_contact_ids: ordered,
    active_contact_id: active,
    held_contact_ids: held,
    routing_contact_ids: routing,
    excluded_contact_ids: excluded,
    mail_allocated: false,
    mail_treatment: input.mail_treatment || 'none',
    per_contact_action_allowance: contactPolicy.per_contact_allowances[input.treatment_tier] ?? Number.MAX_SAFE_INTEGER,
    campaign_max_age_days:
      contactPolicy.campaign.max_age_business_days[input.treatment_tier]
      ?? contactPolicy.campaign.max_age_business_days_unknown_tier
      ?? Number.MAX_SAFE_INTEGER,
    // First build stamps campaign start so age enforcement has a real origin.
    started_at: new Date().toISOString(),
    selection_rule_version: CONTACT_CAMPAIGN_RULE_VERSION,
  };
}

/**
 * Merge a freshly ranked contact queue with an existing campaign plan so
 * re-apply/rescore does not wipe rotation or mail-once state.
 *
 * Preserves:
 * - active_contact_id when still eligible
 * - held queue (does not re-queue contacts already rotated past)
 * - mail_allocated (never clears true → false)
 * - campaign_id / started_at
 *
 * Refreshes: mail_treatment, allowances, max age; appends brand-new eligible contacts.
 */
export function mergeContactPlan(input: {
  fresh: AccountCampaign;
  existing: AccountCampaign | null | undefined;
}): AccountCampaign {
  const fresh = input.fresh;
  const existing = input.existing;
  if (!existing) return fresh;

  const eligibleSet = new Set(fresh.ordered_target_contact_ids || []);
  const priorOrdered = Array.isArray(existing.ordered_target_contact_ids)
    ? existing.ordered_target_contact_ids
    : [];
  const priorSeen = new Set(priorOrdered);

  // Active: keep if still eligible, else first remaining held, else fresh active.
  let active = existing.active_contact_id || null;
  if (active && !eligibleSet.has(active)) active = null;

  const priorHeld = Array.isArray(existing.held_contact_ids) ? existing.held_contact_ids : [];
  const held: string[] = [];
  for (const id of priorHeld) {
    if (eligibleSet.has(id) && id !== active) held.push(id);
  }
  if (!active && held.length) active = held.shift() || null;

  // Only append contacts that never appeared on the prior campaign (new discoveries).
  // Do NOT re-add contacts that were ordered before the current active (already tried).
  for (const id of fresh.ordered_target_contact_ids || []) {
    if (!eligibleSet.has(id)) continue;
    if (id === active) continue;
    if (held.includes(id)) continue;
    if (priorSeen.has(id)) continue; // already known to campaign; not re-queued
    held.push(id);
  }

  if (!active) {
    active = fresh.active_contact_id && eligibleSet.has(fresh.active_contact_id)
      ? fresh.active_contact_id
      : (held.shift() || null);
  }

  const ordered = active ? [active, ...held] : [...held];

  return {
    ...fresh,
    campaign_id: existing.campaign_id || fresh.campaign_id,
    started_at: existing.started_at ?? fresh.started_at,
    ordered_target_contact_ids: ordered,
    active_contact_id: active,
    held_contact_ids: held,
    mail_allocated: Boolean(existing.mail_allocated) || Boolean(fresh.mail_allocated),
    mail_treatment: fresh.mail_treatment,
  };
}

/**
 * Atomic contact handoff: close current, activate next held eligible contact.
 */
export function rotateContact(input: {
  campaign: AccountCampaign;
  reason: string;
}): { campaign: AccountCampaign; previous_contact_id: string | null; rotated: boolean } {
  const previous = input.campaign.active_contact_id;
  if (!input.campaign.held_contact_ids.length) {
    return {
      campaign: {
        ...input.campaign,
        active_contact_id: null,
      },
      previous_contact_id: previous,
      rotated: false,
    };
  }
  const [next, ...rest] = input.campaign.held_contact_ids;
  return {
    campaign: {
      ...input.campaign,
      active_contact_id: next,
      held_contact_ids: rest,
    },
    previous_contact_id: previous,
    rotated: true,
  };
}

/**
 * Parse account_contact_plan_json from a record (string or object).
 */
export function parseAccountCampaignFromRecord(
  record: Record<string, unknown>,
): AccountCampaign | null {
  const raw = record?.account_contact_plan_json;
  if (raw == null || raw === '') return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const campaign = parsed as AccountCampaign;
    if (!Array.isArray(campaign.held_contact_ids) && !Array.isArray(campaign.ordered_target_contact_ids)) {
      return null;
    }
    // Normalize arrays so rotateContact is safe on partially-shaped plans.
    return {
      ...campaign,
      held_contact_ids: Array.isArray(campaign.held_contact_ids) ? campaign.held_contact_ids : [],
      ordered_target_contact_ids: Array.isArray(campaign.ordered_target_contact_ids)
        ? campaign.ordered_target_contact_ids
        : [],
      routing_contact_ids: Array.isArray(campaign.routing_contact_ids) ? campaign.routing_contact_ids : [],
      excluded_contact_ids: Array.isArray(campaign.excluded_contact_ids) ? campaign.excluded_contact_ids : [],
      active_contact_id: campaign.active_contact_id ?? null,
    };
  } catch {
    return null;
  }
}

export type ApplyContactRotationResult = {
  /** True when a held contact was promoted to active. */
  rotated: boolean;
  previous_contact_id: string | null;
  active_contact_id: string | null;
  /** Updated plan JSON when a campaign plan was present; null when no plan. */
  account_contact_plan_json: string | null;
  campaign: AccountCampaign | null;
  reason: string;
};

/**
 * Production helper: rotate active contact from a record's contact plan.
 * Pure — returns patch fields for account_contact_plan_json + active_contact_id.
 * Uses rotateContact; does not reallocate mail.
 */
export function applyContactRotation(
  record: Record<string, unknown>,
  options?: { reason?: string },
): ApplyContactRotationResult {
  const reason = String(options?.reason || 'contact_exhausted').trim() || 'contact_exhausted';
  const campaign = parseAccountCampaignFromRecord(record);
  if (!campaign) {
    const fallbackActive = String(record.active_contact_id || '') || null;
    return {
      rotated: false,
      previous_contact_id: fallbackActive,
      active_contact_id: fallbackActive,
      account_contact_plan_json: null,
      campaign: null,
      reason: 'no_campaign_plan',
    };
  }

  const result = rotateContact({ campaign, reason });
  return {
    rotated: result.rotated,
    previous_contact_id: result.previous_contact_id,
    active_contact_id: result.campaign.active_contact_id,
    account_contact_plan_json: JSON.stringify(result.campaign),
    campaign: result.campaign,
    reason,
  };
}

/**
 * Remove permanently suppressed contacts from the remaining campaign queue.
 *
 * The active/held queue is authoritative here: using ordered_target_contact_ids
 * would reintroduce contacts already rotated past. The caller supplies the
 * suppressed ids from durable contact state, so a policy re-apply cannot put a
 * suppressed person back into the outbound queue.
 */
export function removeSuppressedContactsFromCampaign(input: {
  campaign: AccountCampaign;
  suppressedContactIds: Iterable<string>;
}): { campaign: AccountCampaign; previous_contact_id: string | null; rotated: boolean } {
  const suppressed = new Set(
    [...input.suppressedContactIds]
      .map((contactId) => String(contactId || '').trim())
      .filter(Boolean),
  );
  const previous = input.campaign.active_contact_id;
  const remaining = [
    ...(previous ? [previous] : []),
    ...(input.campaign.held_contact_ids || []),
  ].filter((contactId) => !suppressed.has(contactId));
  const active = remaining[0] || null;
  const held = remaining.slice(1);
  const excluded = [...new Set([
    ...(input.campaign.excluded_contact_ids || []),
    ...[...suppressed],
  ])];

  return {
    campaign: {
      ...input.campaign,
      ordered_target_contact_ids: active ? [active, ...held] : [],
      active_contact_id: active,
      held_contact_ids: held,
      excluded_contact_ids: excluded,
    },
    previous_contact_id: previous,
    rotated: previous !== active,
  };
}

/**
 * Allocate account-level mail once. Never reallocates on contact rotation.
 */
export function allocateMail(input: {
  campaign: AccountCampaign;
  mail_treatment: string;
}): AccountCampaign {
  if (input.campaign.mail_allocated) {
    throw new Error('Mail already allocated for this account campaign');
  }
  if (input.campaign.mail_treatment === 'none') {
    throw new Error('Campaign has no mail_treatment permission');
  }
  if (input.campaign.mail_treatment !== input.mail_treatment) {
    throw new Error(
      `Mail treatment mismatch: campaign=${input.campaign.mail_treatment} requested=${input.mail_treatment}`,
    );
  }
  return { ...input.campaign, mail_allocated: true };
}

/**
 * Named action may only target the active contact (or account-level for mail).
 * For email/phone/linkedin: empty contact_id must not soft-pass — contact_id is required
 * and must equal the campaign active contact.
 */
export function assertActionTarget(input: {
  campaign: AccountCampaign;
  contact_id?: string | null;
  channel: 'email' | 'phone' | 'linkedin' | 'mail';
}): void {
  if (input.channel === 'mail') {
    if (input.campaign.mail_allocated) {
      throw new Error('Mail already sent for this campaign');
    }
    return;
  }
  if (!input.campaign.active_contact_id) {
    throw new Error('No active contact for named channel action');
  }
  const contactId = String(input.contact_id || '').trim();
  if (!contactId) {
    throw new Error('contact_id required for named channel action');
  }
  if (contactId !== input.campaign.active_contact_id) {
    throw new Error('Action contact is not the active contact');
  }
  if (input.campaign.held_contact_ids.includes(contactId)) {
    throw new Error('Held contact cannot receive outreach');
  }
}
