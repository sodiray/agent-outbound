/**
 * Readiness evaluators for account, contact, channel, content, treatment, suppression.
 */

import { actionConfidenceAllows, type EvidenceConfidenceProfile } from './scoring.js';
import { assertWorkAllowed } from './pipeline-prohibitions.js';
import {
  DEFAULT_SCORE_ACTION_CONFIDENCE,
  type ActionConfidenceConfigInput,
  type ContactPolicyConfigInput,
  resolveContactPolicy,
} from '../../schemas/config.js';

export type ReadinessInput = {
  eligible: boolean;
  suppressed: boolean;
  identityConfidence: number;
  materialContradiction: boolean;
  treatmentTier: string;
  /**
   * When mail_treatment is none, mail channel ready is forced false —
   * never invent mail permission from address reachability alone.
   */
  mailTreatment?: string | null;
  channels: Record<string, { ready: boolean; confidence?: number }>;
  contentReady?: boolean;
  withinBudget?: boolean;
  collision?: boolean;
  hasNextAction?: boolean;
  confidenceProfile?: EvidenceConfidenceProfile;
  actionConfidence?: ActionConfidenceConfigInput;
  policy?: {
    prohibited_channels?: unknown;
    prohibited_task_types?: unknown;
  };
  contactPolicy?: ContactPolicyConfigInput;
  /** Named buyer evidence; a pipeline may require it for an opaque tier. */
  namedBuyerStatus?: string | null;
  namedBuyerName?: string | null;
  /** Optional affiliation fields. An unresolved affiliation is always held. */
  buyerAffiliationStatus?: string | null;
  buyingCenterRole?: string | null;
  proposedAction?: {
    kind?: string;
    channel?: string;
    taskType?: string;
    stepId?: string;
  };
};

/** Channel is usable when ready=true and confidence is a finite number (present). */
function channelUsable(state: { ready?: boolean; confidence?: number } | null | undefined): boolean {
  if (!state || state.ready !== true) return false;
  if (state.confidence == null || state.confidence === ('' as unknown)) return false;
  const c = Number(state.confidence);
  return Number.isFinite(c);
}

export type ReadinessResult = {
  ready: boolean;
  blockers: string[];
  warnings: string[];
  permitted_channels: string[];
};

const isConfidenceAction = (value: string): value is 'email' | 'phone' | 'linkedin' | 'mail' => (
  ['email', 'phone', 'linkedin', 'mail'].includes(value)
);

export type ReadinessChannelPermission = {
  /** A valid persisted channel set is available and authoritative. */
  computed: boolean;
  permitted: boolean;
};

/**
 * Read the persisted readiness snapshot for a channel action.
 *
 * A missing, malformed, or pre-readiness snapshot is intentionally not treated
 * as an empty permission set: older generic pipelines may not calculate
 * readiness at all. Once a snapshot explicitly contains permitted_channels,
 * including an empty array, it is authoritative and therefore fail-closed.
 */
export const readinessChannelPermission = ({
  record,
  channel,
}: {
  record: Record<string, unknown>;
  channel: string;
}): ReadinessChannelPermission => {
  const requested = String(channel || '').trim().toLowerCase();
  if (!requested) return { computed: false, permitted: true };

  const raw = record.readiness_json;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { computed: false, permitted: true };
  }

  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { computed: false, permitted: true };
    }
    const permittedChannels = (parsed as Record<string, unknown>).permitted_channels;
    if (!Array.isArray(permittedChannels)) {
      return { computed: false, permitted: true };
    }
    return {
      computed: true,
      permitted: permittedChannels.some((value) => String(value || '').trim().toLowerCase() === requested),
    };
  } catch {
    return { computed: false, permitted: true };
  }
};

/**
 * Baseline outbound readiness before any active external action.
 */
export function evaluateOutboundReadiness(input: ReadinessInput): ReadinessResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!input.eligible) blockers.push('not_eligible');
  if (input.suppressed) blockers.push('suppressed');
  const actionConfidence = {
    ...DEFAULT_SCORE_ACTION_CONFIDENCE.minimums,
    ...input.actionConfidence?.minimums,
  };
  if (input.identityConfidence < actionConfidence.identity) {
    blockers.push(`identity_confidence_below_${actionConfidence.identity}`);
  }
  if (input.materialContradiction) blockers.push('material_contradiction');
  if (input.withinBudget === false) blockers.push('budget_exceeded');
  if (input.collision) blockers.push('channel_or_contact_collision');
  // Fail closed: missing next_action must not readiness-pass.
  if (input.hasNextAction !== true) blockers.push('missing_next_action');

  // Named buyer + affiliation gates (GT matrix + Tier A readiness).
  const buyerStatus = input.namedBuyerStatus != null
    ? String(input.namedBuyerStatus).trim().toLowerCase()
    : '';
  const buyerName = input.namedBuyerName != null
    ? String(input.namedBuyerName).trim()
    : '';
  const affStatus = input.buyerAffiliationStatus != null
    ? String(input.buyerAffiliationStatus).trim().toLowerCase()
    : '';
  const buyingRole = input.buyingCenterRole != null
    ? String(input.buyingCenterRole).trim()
    : '';
  const affUnresolved = new Set(['unresolved', 'unknown', 'not_found', 'ambiguous']);

  // If affiliation is present and unresolved → always hold (never invent).
  if (affStatus && affUnresolved.has(affStatus)) {
    blockers.push('buyer_affiliation_unresolved');
  }

  const tierRule = resolveContactPolicy(input.contactPolicy).tiers[input.treatmentTier] || {};
  if (tierRule.requires_named_buyer === true) {
    if (!buyerStatus) blockers.push('named_buyer_status_missing');
    else if (!['confirmed', 'likely'].includes(buyerStatus)) {
      blockers.push('named_buyer_not_confirmed');
    }
    if (!buyerName) blockers.push('named_buyer_name_missing');
  }
  if (tierRule.requires_buyer_affiliation === true) {
    if (!affStatus) blockers.push('buyer_affiliation_status_missing');
    else if (!affUnresolved.has(affStatus) && !['confirmed', 'likely'].includes(affStatus)) {
      blockers.push('buyer_affiliation_not_confirmed');
    }
  }
  if (tierRule.requires_buying_center_role === true) {
    if (!buyingRole) blockers.push('buying_center_role_missing');
  }

  if (input.proposedAction) {
    try {
      assertWorkAllowed({
        policy: input.policy,
        kind: input.proposedAction.kind,
        channel: input.proposedAction.channel,
        taskType: input.proposedAction.taskType,
      });
    } catch (error) {
      blockers.push(`prohibited_work:${String((error as Error).message || error)}`);
    }
  }

  // Never invent mail permission: mail_treatment none forces mail not ready.
  const channels = { ...(input.channels || {}) };
  if (channels.mail) {
    const mailTreatment = input.mailTreatment != null
      ? String(input.mailTreatment).trim().toLowerCase()
      : '';
    if (mailTreatment === 'none' || mailTreatment === '') {
      // Empty / none = no mail permission. Explicit empty only forces when provided as 'none'.
      if (mailTreatment === 'none') {
        channels.mail = { ...channels.mail, ready: false };
      }
    }
  }

  const permitted_channels: string[] = [];
  for (const [ch, state] of Object.entries(channels)) {
    if (state?.ready && (!tierRule.permitted_channels || tierRule.permitted_channels.includes(ch))) {
      permitted_channels.push(ch);
    }
  }

  // Baseline: no channel ready=true with confidence → fail closed even without proposedAction.
  const usable = Object.entries(channels).filter(([, state]) => channelUsable(state));
  if (usable.length === 0) {
    blockers.push('no_usable_channel');
  }
  if (permitted_channels.length === 0 && input.proposedAction?.channel) {
    blockers.push('no_ready_channel');
  }

  if (input.proposedAction?.channel === 'email' && channels.email && !channels.email.ready) {
    blockers.push('email_not_ready');
  }
  if (input.proposedAction?.channel === 'phone' && channels.phone && !channels.phone.ready) {
    blockers.push('phone_not_ready');
  }
  if (input.proposedAction?.channel === 'linkedin' && channels.linkedin && !channels.linkedin.ready) {
    blockers.push('linkedin_not_ready');
  }
  if (input.proposedAction?.channel === 'mail' && channels.mail && !channels.mail.ready) {
    blockers.push('mail_not_ready');
  }

  if (
    input.proposedAction?.channel
    && tierRule.permitted_channels
    && !tierRule.permitted_channels.includes(input.proposedAction.channel)
  ) {
    blockers.push('tier_channel_not_permitted');
  }

  // Fail closed: undefined/null content must not readiness-pass.
  if (input.contentReady !== true) blockers.push('content_not_ready');
  if (input.confidenceProfile && input.proposedAction?.channel && isConfidenceAction(input.proposedAction.channel)) {
    const gate = actionConfidenceAllows({
      action: input.proposedAction.channel,
      profile: input.confidenceProfile,
      config: input.actionConfidence,
    });
    if (!gate.allowed) blockers.push(...gate.failing.map((f) => `confidence:${f}`));
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    permitted_channels,
  };
}

/**
 * Eligibility outcome with auditable reason codes.
 */
export type EligibilityOutcome =
  | 'eligible'
  | 'review_hold'
  | 'enrichment_hold'
  | 'active'
  | 'recycle'
  | 'disqualified'
  | 'suppressed';

export function classifyEligibility(input: {
  isBusiness: boolean;
  permanentlyClosed: boolean;
  outOfTerritory: boolean;
  isDuplicate: boolean;
  isNonSmbOrg: boolean; // government, school, church, association
  corporateNoLocalAuthority: boolean;
  identityUnresolved: boolean;
  suppressed: boolean;
  reasonEvidenceIds?: string[];
}): { outcome: EligibilityOutcome; reasons: string[]; evidence_ids: string[] } {
  const reasons: string[] = [];
  const evidence_ids = input.reasonEvidenceIds || [];

  if (input.suppressed) {
    return { outcome: 'suppressed', reasons: ['suppression_rule'], evidence_ids };
  }
  if (!input.isBusiness) {
    return { outcome: 'disqualified', reasons: ['not_a_business'], evidence_ids };
  }
  if (input.permanentlyClosed) {
    return { outcome: 'disqualified', reasons: ['permanently_closed'], evidence_ids };
  }
  if (input.outOfTerritory) {
    return { outcome: 'disqualified', reasons: ['out_of_territory'], evidence_ids };
  }
  if (input.isDuplicate) {
    return { outcome: 'disqualified', reasons: ['duplicate_canonical_record'], evidence_ids };
  }
  if (input.isNonSmbOrg) {
    return { outcome: 'disqualified', reasons: ['non_smb_organization'], evidence_ids };
  }
  if (input.corporateNoLocalAuthority) {
    return { outcome: 'disqualified', reasons: ['corporate_no_local_authority'], evidence_ids };
  }
  if (input.identityUnresolved) {
    return { outcome: 'enrichment_hold', reasons: ['identity_unresolved'], evidence_ids };
  }
  return { outcome: 'eligible', reasons: ['passed_hard_eligibility'], evidence_ids };
}
