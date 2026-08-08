/**
 * Lifecycle, sequence, work, and next-action invariants.
 * Dimensions remain independent; transitions require evidence.
 */

import {
  applyContactRotation,
  parseAccountCampaignFromRecord,
  type AccountCampaign,
  type ApplyContactRotationResult,
} from './contact-campaign.js';
import {
  appendTransitionAudit,
  createTransitionAudit,
  type TransitionAuditRecord,
} from './transition-audit.js';
import {
  DEFAULT_CONTACT_POLICY,
  resolveContactPolicy,
  type ContactPolicyConfigInput,
} from '../../schemas/config.js';
import { isAffirmativeFlag } from './booleanish.js';
import { nowIso } from '../lib/record.js';

export const LIFECYCLE_STAGES = [
  'cold',
  'contacted',
  'replied',
  'engaged',
  'meeting_booked',
  'won',
  'lost',
  'recycled',
  'disqualified',
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const SEQUENCE_STATES = [
  'not_started',
  'active',
  'paused_review',
  'paused_inbound',
  'paused_repair',
  'waiting',
  'unreachable',
  'exhausted',
  'recycle_wait',
  'completed',
  'cancelled',
] as const;

export type SequenceState = (typeof SEQUENCE_STATES)[number];

export const WORK_STATES = [
  'research_enrichment',
  'identity_contact_resolution',
  /** Targeted re-enrich after enrichment_hold (planEnrichmentRepair). */
  'enrichment_repair',
  'content_generation',
  'pending_human_review',
  'waiting_time_or_event',
  'executing_external_action',
  'contact_rotation',
  'channel_repair',
  'human_commercial_followup',
  'meeting_prep_or_completion',
  'reentry_evaluation',
  'terminal_recordkeeping',
  'idle',
] as const;

export type WorkState = (typeof WORK_STATES)[number];

export type NextAction = {
  action_id: string;
  action_type: string;
  account_id: string;
  contact_id?: string | null;
  owner_type?: string | null;
  owner_id?: string | null;
  due_at?: string | null;
  external_trigger?: string | null;
  lifecycle_stage: LifecycleStage;
  sequence_state: SequenceState;
  work_state: WorkState;
  preconditions?: string[];
  readiness_gates?: string[];
  reason: string;
  on_success: string;
  on_skip?: string;
  on_failure?: string;
  related_review_id?: string | null;
  related_asset_id?: string | null;
  policy_version: string;
};

export const NEXT_ACTION_POLICY_VERSION = 'tv-next-action-v1';

const TERMINAL_LIFECYCLE = new Set<LifecycleStage>(['won', 'lost', 'disqualified']);

/** Allowed lifecycle transitions (evidence still required by callers). */
const LIFECYCLE_EDGES: Record<LifecycleStage, LifecycleStage[]> = {
  cold: ['contacted', 'recycled', 'disqualified'],
  contacted: ['replied', 'engaged', 'recycled', 'lost', 'disqualified'],
  replied: ['engaged', 'meeting_booked', 'recycled', 'lost', 'disqualified', 'contacted'],
  engaged: ['meeting_booked', 'won', 'lost', 'recycled'],
  meeting_booked: ['won', 'lost', 'engaged', 'recycled'],
  won: [],
  lost: ['recycled', 'cold'],
  recycled: ['cold', 'contacted', 'disqualified'],
  disqualified: [],
};

export function canTransitionLifecycle(from: LifecycleStage, to: LifecycleStage): boolean {
  if (from === to) return true;
  return (LIFECYCLE_EDGES[from] || []).includes(to);
}

export function assertLifecycleTransition(
  from: LifecycleStage,
  to: LifecycleStage,
  evidence: { reason: string; evidence_ids?: string[] },
): void {
  if (!canTransitionLifecycle(from, to)) {
    throw new Error(`Prohibited lifecycle transition ${from} -> ${to}`);
  }
  if (!evidence?.reason) {
    throw new Error('Lifecycle transition requires evidence.reason');
  }
}

export type AccountStateBundle = {
  lifecycle_stage: LifecycleStage;
  sequence_state: SequenceState;
  work_state: WorkState;
  next_action: NextAction | null;
  suppressed?: boolean;
  treatment_tier?: string | null;
  active_contact_id?: string | null;
};

export type IntegrityIssue = {
  code: string;
  message: string;
  severity: 'error' | 'warning';
};

/**
 * Integrity checks: surface impossible combinations.
 */
export function checkStateIntegrity(state: AccountStateBundle): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const { lifecycle_stage, sequence_state, work_state, next_action } = state;

  if (!LIFECYCLE_STAGES.includes(lifecycle_stage)) {
    issues.push({ code: 'invalid_lifecycle', message: `Unknown lifecycle_stage ${lifecycle_stage}`, severity: 'error' });
  }
  if (!SEQUENCE_STATES.includes(sequence_state)) {
    issues.push({ code: 'invalid_sequence', message: `Unknown sequence_state ${sequence_state}`, severity: 'error' });
  }
  if (!WORK_STATES.includes(work_state)) {
    issues.push({ code: 'invalid_work', message: `Unknown work_state ${work_state}`, severity: 'error' });
  }

  const terminal = TERMINAL_LIFECYCLE.has(lifecycle_stage);
  const actionableNonterminal =
    !terminal &&
    !state.suppressed &&
    sequence_state !== 'completed' &&
    sequence_state !== 'cancelled' &&
    sequence_state !== 'not_started';

  if (actionableNonterminal && !next_action) {
    issues.push({
      code: 'missing_next_action',
      message: 'Actionable nonterminal account requires exactly one next_action',
      severity: 'error',
    });
  }

  if (terminal && next_action && next_action.action_type !== 'terminal_recordkeeping') {
    issues.push({
      code: 'terminal_has_active_action',
      message: 'Terminal lifecycle should not carry an active outreach next_action',
      severity: 'warning',
    });
  }

  if (sequence_state === 'paused_review' && work_state !== 'pending_human_review' && work_state !== 'idle') {
    issues.push({
      code: 'review_work_mismatch',
      message: 'paused_review should pair with pending_human_review work_state',
      severity: 'warning',
    });
  }

  if (next_action) {
    if (next_action.lifecycle_stage !== lifecycle_stage) {
      issues.push({
        code: 'next_action_lifecycle_drift',
        message: 'next_action.lifecycle_stage does not match account lifecycle_stage',
        severity: 'error',
      });
    }
    if (next_action.contact_id && state.active_contact_id && next_action.contact_id !== state.active_contact_id) {
      issues.push({
        code: 'next_action_inactive_contact',
        message: 'next_action targets a contact that is not the active contact',
        severity: 'error',
      });
    }
  }

  return issues;
}

/**
 * Complete one action and create its successor atomically (pure function).
 */
export function completeActionAndCreateSuccessor(input: {
  state: AccountStateBundle;
  completed_action_id: string;
  outcome: 'success' | 'skip' | 'failure' | 'recycle' | 'terminal';
  evidence: { reason: string; evidence_ids?: string[] };
  successor: Omit<NextAction, 'policy_version'> | null;
  lifecycle_to?: LifecycleStage;
  sequence_to?: SequenceState;
  work_to?: WorkState;
}): AccountStateBundle {
  if (!input.state.next_action || input.state.next_action.action_id !== input.completed_action_id) {
    throw new Error('Completed action_id does not match current next_action');
  }

  let lifecycle_stage = input.state.lifecycle_stage;
  if (input.lifecycle_to) {
    assertLifecycleTransition(lifecycle_stage, input.lifecycle_to, input.evidence);
    lifecycle_stage = input.lifecycle_to;
  }

  const sequence_state = input.sequence_to ?? input.state.sequence_state;
  const work_state = input.work_to ?? input.state.work_state;

  let next_action: NextAction | null = null;
  if (input.successor) {
    next_action = {
      ...input.successor,
      lifecycle_stage,
      sequence_state,
      work_state,
      policy_version: NEXT_ACTION_POLICY_VERSION,
    };
  } else if (input.outcome === 'recycle') {
    next_action = {
      action_id: `na_recycle_${Date.now()}`,
      action_type: 'reentry_evaluation',
      account_id: input.state.next_action.account_id,
      lifecycle_stage: lifecycle_stage === 'cold' ? 'recycled' : lifecycle_stage,
      sequence_state: 'recycle_wait',
      work_state: 'reentry_evaluation',
      reason: input.evidence.reason,
      on_success: 'reenter_or_remain',
      policy_version: NEXT_ACTION_POLICY_VERSION,
    };
    lifecycle_stage = lifecycle_stage === 'disqualified' ? lifecycle_stage : 'recycled';
  }

  const next: AccountStateBundle = {
    ...input.state,
    lifecycle_stage,
    sequence_state,
    work_state,
    next_action,
  };

  const issues = checkStateIntegrity(next).filter((i) => i.severity === 'error');
  if (issues.length) {
    throw new Error(`Integrity failure after transition: ${issues.map((i) => i.code).join(', ')}`);
  }
  return next;
}

export function createInitialColdState(accountId: string): AccountStateBundle {
  return {
    lifecycle_stage: 'cold',
    sequence_state: 'not_started',
    work_state: 'research_enrichment',
    next_action: {
      action_id: `na_intake_${accountId}`,
      action_type: 'foundational_enrichment',
      account_id: accountId,
      lifecycle_stage: 'cold',
      sequence_state: 'not_started',
      work_state: 'research_enrichment',
      reason: 'New account requires foundational enrichment before treatment',
      on_success: 'candidate_tier_and_targeted_enrichment',
      policy_version: NEXT_ACTION_POLICY_VERSION,
    },
  };
}

const coerceLifecycle = (raw: unknown): LifecycleStage => {
  const value = String(raw || 'cold').trim() as LifecycleStage;
  return LIFECYCLE_STAGES.includes(value) ? value : 'cold';
};

const coerceSequence = (raw: unknown, fallback: SequenceState = 'active'): SequenceState => {
  const value = String(raw || fallback).trim() as SequenceState;
  return SEQUENCE_STATES.includes(value) ? value : fallback;
};

const coerceWork = (raw: unknown, fallback: WorkState = 'executing_external_action'): WorkState => {
  const value = String(raw || fallback).trim() as WorkState;
  return WORK_STATES.includes(value) ? value : fallback;
};

export function parseNextActionFromRecord(record: Record<string, unknown>): NextAction | null {
  const raw = record?.next_action_json;
  if (raw == null || raw === '') return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!String((parsed as NextAction).action_id || '').trim()) return null;
    return parsed as NextAction;
  } catch {
    return null;
  }
}

const isOutboundChannel = (channel: string, stepKind: string): boolean => {
  const hay = `${channel} ${stepKind}`.toLowerCase();
  return (
    hay.includes('email')
    || hay.includes('mail')
    || hay.includes('call')
    || hay.includes('phone')
    || hay.includes('sms')
    || hay.includes('linkedin')
    || hay.includes('send_')
  );
};

/** Default wait when no next_action_date / progression date is available on the record. */
export const DEFAULT_WAIT_SUCCESSOR_DAYS = 0;

/**
 * Resolve due_at for a wait (or waiting_time_or_event) next_action successor.
 * Prefer record.next_action_date (progression / sequence schedule); else now+defaultWaitDays
 * as an ISO date (YYYY-MM-DD).
 */
export function resolveWaitDueAt(
  record: Record<string, unknown> | null | undefined,
  now: Date = new Date(nowIso()),
  defaultWaitDays?: number,
  contactPolicy?: ContactPolicyConfigInput,
): string {
  const fromRecord = String(record?.next_action_date || '').trim();
  if (fromRecord) return fromRecord;

  const d = new Date(now.getTime());
  const waitDays = defaultWaitDays ?? resolveContactPolicy(contactPolicy).fallback_wait_days ?? DEFAULT_WAIT_SUCCESSOR_DAYS;
  d.setUTCDate(d.getUTCDate() + waitDays);
  return d.toISOString().slice(0, 10);
}

function buildWaitSuccessor(input: {
  accountId: string;
  contactId?: string | null;
  lifecycle_stage: LifecycleStage;
  sequence_state: SequenceState;
  work_state: WorkState;
  reason: string;
  sequenceCompleted?: boolean;
  /** ISO date or datetime when the wait unlocks. Required for first-class sequencer gating. */
  due_at?: string | null;
}): Omit<NextAction, 'policy_version'> {
  const suffix = `${input.accountId}_${Date.now()}`;
  const due_at = input.due_at != null && String(input.due_at).trim() !== ''
    ? String(input.due_at).trim()
    : null;
  if (input.sequenceCompleted) {
    return {
      action_id: `na_await_reply_${suffix}`,
      action_type: 'await_reply_or_recycle',
      account_id: input.accountId,
      contact_id: input.contactId ?? null,
      lifecycle_stage: input.lifecycle_stage,
      sequence_state: input.sequence_state,
      work_state: input.work_state,
      due_at,
      reason: input.reason,
      on_success: 'evaluate_reply_or_rotate',
    };
  }
  return {
    action_id: `na_wait_${suffix}`,
    action_type: 'wait',
    account_id: input.accountId,
    contact_id: input.contactId ?? null,
    lifecycle_stage: input.lifecycle_stage,
    sequence_state: input.sequence_state,
    work_state: input.work_state,
    due_at,
    reason: input.reason,
    on_success: 'execute_next_sequence_step',
  };
}

/** After promoting a held contact, queue outreach for the new active contact. */
function buildPostRotationSuccessor(input: {
  accountId: string;
  contactId: string | null;
  lifecycle_stage: LifecycleStage;
  reason: string;
  previousContactId?: string | null;
}): Omit<NextAction, 'policy_version'> {
  const suffix = `${input.accountId}_${Date.now()}`;
  return {
    action_id: `na_contact_email_${suffix}`,
    action_type: 'send_email',
    account_id: input.accountId,
    contact_id: input.contactId,
    lifecycle_stage: input.lifecycle_stage,
    sequence_state: 'active',
    work_state: 'content_generation',
    reason: input.reason,
    on_success: 'wait_or_followup',
  };
}

function hasHeldContacts(campaign: AccountCampaign | null): boolean {
  return Boolean(campaign?.held_contact_ids?.length);
}

/**
 * Decide whether advanceAfterSuccessfulAction should run applyContactRotation.
 * Default path stays simple: explicit rotate flag, force_contact_rotate, contact_rotation
 * action type, sequence complete with held contacts, or on_success contains "rotate".
 */
export function shouldApplyContactRotation(input: {
  record: Record<string, unknown>;
  next_action: NextAction | null;
  sequenceCompleted?: boolean;
  rotate?: boolean;
  campaign?: AccountCampaign | null;
}): boolean {
  const campaign = input.campaign !== undefined
    ? input.campaign
    : parseAccountCampaignFromRecord(input.record);
  if (!campaign) return false;

  if (input.rotate) return true;
  if (input.record.force_contact_rotate === true || input.record.force_contact_rotate === 1
    || input.record.force_contact_rotate === '1' || input.record.force_contact_rotate === 'true') {
    return true;
  }
  if (input.next_action?.action_type === 'contact_rotation') return true;

  const held = hasHeldContacts(campaign);
  if (input.sequenceCompleted && held) return true;

  const onSuccess = String(input.next_action?.on_success || '').toLowerCase();
  if (held && onSuccess.includes('rotate')) return true;

  return false;
}

function applySafeSuccessor(input: {
  state: AccountStateBundle;
  lifecycle_to?: LifecycleStage;
  sequence_to: SequenceState;
  work_to: WorkState;
  successor: Omit<NextAction, 'policy_version'> | null;
  evidence: { reason: string; evidence_ids?: string[] };
}): AccountStateBundle {
  let lifecycle_stage = input.state.lifecycle_stage;
  if (input.lifecycle_to && input.lifecycle_to !== lifecycle_stage) {
    assertLifecycleTransition(lifecycle_stage, input.lifecycle_to, input.evidence);
    lifecycle_stage = input.lifecycle_to;
  }

  let next_action: NextAction | null = null;
  if (input.successor) {
    next_action = {
      ...input.successor,
      lifecycle_stage,
      sequence_state: input.sequence_to,
      work_state: input.work_to,
      policy_version: NEXT_ACTION_POLICY_VERSION,
    };
  }

  const next: AccountStateBundle = {
    ...input.state,
    lifecycle_stage,
    sequence_state: input.sequence_to,
    work_state: input.work_to,
    next_action,
  };

  const issues = checkStateIntegrity(next).filter((i) => i.severity === 'error');
  if (issues.length) {
    throw new Error(`Integrity failure after safe successor: ${issues.map((i) => i.code).join(', ')}`);
  }
  return next;
}

export type AdvanceAfterSuccessfulActionInput = {
  record: Record<string, unknown>;
  channel?: string;
  stepKind?: string;
  stepId?: string;
  evidence?: { reason: string; evidence_ids?: string[] };
  /** True when the channel sequence has no further steps. */
  sequenceCompleted?: boolean;
  /**
   * Explicit contact rotation request (tests + production).
   * Also triggered when next_action.action_type === 'contact_rotation',
   * record.force_contact_rotate, sequence complete with held contacts,
   * or next_action.on_success includes "rotate".
  */
  rotate?: boolean;
  /** Pipeline-owned person-contact cadence controls. */
  contactPolicy?: ContactPolicyConfigInput;
};

export type AdvanceAfterSuccessfulActionResult = {
  patch: {
    lifecycle_stage: LifecycleStage;
    account_sequence_state: SequenceState;
    work_state: WorkState;
    next_action_json: string;
    active_contact_id?: string;
    account_contact_plan_json?: string;
    /** Durable transition audit ledger (JSON array). */
    transition_audit_json?: string;
    /** Per-contact automated touch count for campaign-process allowances. */
    automated_actions_used?: number;
    /** ISO timestamp of last contact rotation (quiet period origin). */
    last_contact_rotation_at?: string;
  };
  state: AccountStateBundle;
  integrity_errors: string[];
  /** True when completeActionAndCreateSuccessor was used (matching action_id). */
  used_complete_action: boolean;
  /** True when a held contact was promoted via applyContactRotation / rotateContact. */
  rotated: boolean;
  previous_contact_id?: string | null;
  rotation?: ApplyContactRotationResult | null;
  /** The audit entry written for this succession. */
  audit?: TransitionAuditRecord | null;
};

/**
 * Production helper: after a successful non-draft external channel action,
 * complete the current next_action (when present) and install exactly one successor.
 * Optionally rotates contact (applyContactRotation) on exhaustion / explicit rotate.
 * Never jumps lifecycle to won/lost from an outbound send alone.
 */
export function advanceAfterSuccessfulAction(
  input: AdvanceAfterSuccessfulActionInput,
): AdvanceAfterSuccessfulActionResult {
  const record = input.record || {};
  const accountId = String(record._row_id || record.id || 'unknown');
  const channel = String(input.channel || '').trim().toLowerCase();
  const stepKind = String(input.stepKind || '').trim().toLowerCase();
  const outbound = isOutboundChannel(channel, stepKind);

  const lifecycle_stage = coerceLifecycle(record.lifecycle_stage);
  const sequence_state = coerceSequence(record.account_sequence_state, 'active');
  const work_state = coerceWork(record.work_state, 'executing_external_action');
  const next_action = parseNextActionFromRecord(record);
  const campaign = parseAccountCampaignFromRecord(record);
  const sequenceCompleted = Boolean(input.sequenceCompleted);

  const evidence = input.evidence?.reason
    ? input.evidence
    : {
      reason: `Successful ${channel || stepKind || 'channel'} action${input.stepId ? ` (${input.stepId})` : ''}`,
      evidence_ids: input.stepId ? [String(input.stepId)] : [],
    };

  // Contact rotation (optional): promote next held contact and persist plan fields.
  let rotation: ApplyContactRotationResult | null = null;
  if (shouldApplyContactRotation({
    record,
    next_action,
    sequenceCompleted,
    rotate: input.rotate,
    campaign,
  })) {
    rotation = applyContactRotation(record, {
      reason: next_action?.action_type === 'contact_rotation'
        ? (next_action.reason || 'contact_rotation')
        : sequenceCompleted
          ? 'sequence_exhausted_rotate_contact'
          : evidence.reason,
    });
  }

  const rotatedOntoHeld = Boolean(rotation?.rotated);
  const active_contact_id = rotatedOntoHeld
    ? rotation!.active_contact_id
    : (String(record.active_contact_id || next_action?.contact_id || '') || null);

  // First successful outbound moves cold → contacted only. No silent terminal jumps.
  const lifecycle_to: LifecycleStage | undefined =
    lifecycle_stage === 'cold' && outbound ? 'contacted' : undefined;

  // When sequence completes but a held contact remains and we rotated, start the next
  // contact's work instead of leaving the account sequence_completed with no next_action.
  const handoffAfterSequence = rotatedOntoHeld && sequenceCompleted;
  const handoffAfterRotationAction =
    rotatedOntoHeld && next_action?.action_type === 'contact_rotation';
  const handoffToNewContact = handoffAfterSequence || handoffAfterRotationAction;

  // Mid-sequence: wait for next due step. Sequence finished (no rotation): completed.
  // Integrity: completed/cancelled may omit next_action; waiting/active require exactly one.
  const sequence_to: SequenceState = handoffToNewContact
    ? 'active'
    : sequenceCompleted
      ? 'completed'
      : 'waiting';
  const work_to: WorkState = handoffToNewContact
    ? 'content_generation'
    : 'waiting_time_or_event';

  const targetLifecycle = lifecycle_to || lifecycle_stage;

  let successor: Omit<NextAction, 'policy_version'> | null;
  if (handoffToNewContact) {
    successor = buildPostRotationSuccessor({
      accountId,
      contactId: active_contact_id,
      lifecycle_stage: targetLifecycle,
      reason: rotation?.reason
        ? `Rotated contact (${rotation.previous_contact_id || 'none'} → ${active_contact_id || 'none'}): ${rotation.reason}`
        : evidence.reason,
      previousContactId: rotation?.previous_contact_id,
    });
  } else if (sequenceCompleted) {
    // No held contact to hand off — clear next_action (sequence completed).
    successor = null;
  } else {
    // Prefer progression next_action_date (executeChannelStep sets it before advance);
    // else now+2d so shouldExecuteSequenceOutbound gates on due_at first-class.
    const due_at = resolveWaitDueAt(record, new Date(nowIso()), undefined, input.contactPolicy);
    successor = buildWaitSuccessor({
      accountId,
      contactId: active_contact_id,
      lifecycle_stage: targetLifecycle,
      sequence_state: sequence_to,
      work_state: work_to,
      reason: evidence.reason,
      sequenceCompleted: false,
      due_at,
    });
  }

  // State used for succession: active_contact_id is the post-rotation target so the
  // successor integrity check (next_action.contact_id === active_contact_id) holds.
  const state: AccountStateBundle = {
    lifecycle_stage,
    sequence_state,
    work_state,
    next_action,
    suppressed: isAffirmativeFlag(record.suppressed, { failClosed: true }),
    treatment_tier: record.treatment_tier != null && record.treatment_tier !== ''
      ? String(record.treatment_tier)
      : null,
    active_contact_id,
  };

  let nextState: AccountStateBundle;
  let used_complete_action = false;

  if (next_action?.action_id) {
    try {
      nextState = completeActionAndCreateSuccessor({
        state,
        completed_action_id: next_action.action_id,
        outcome: 'success',
        evidence,
        successor,
        lifecycle_to,
        sequence_to,
        work_to,
      });
      used_complete_action = true;
    } catch {
      // Mismatched or integrity-hostile current action: install a safe successor without throwing away the send.
      nextState = applySafeSuccessor({
        state,
        lifecycle_to,
        sequence_to,
        work_to,
        successor,
        evidence,
      });
    }
  } else {
    nextState = applySafeSuccessor({
      state,
      lifecycle_to,
      sequence_to,
      work_to,
      successor,
      evidence,
    });
  }

  // Keep post-rotation active_contact_id on the returned state (successor already targets it).
  if (rotation) {
    nextState = {
      ...nextState,
      active_contact_id: rotation.active_contact_id,
    };
  }

  // Guard: outbound success must never invent terminal commercial outcomes.
  if (nextState.lifecycle_stage === 'won' || nextState.lifecycle_stage === 'lost') {
    if (lifecycle_stage !== 'won' && lifecycle_stage !== 'lost') {
      throw new Error(`Refusing silent lifecycle jump to ${nextState.lifecycle_stage} after channel success`);
    }
  }

  const integrity_errors = checkStateIntegrity(nextState)
    .filter((i) => i.severity === 'error')
    .map((i) => i.code);

  const audit = createTransitionAudit({
    account_id: accountId,
    kind: rotatedOntoHeld ? 'next_action' : (lifecycle_to ? 'lifecycle' : 'sequence'),
    from_state: `${lifecycle_stage}/${sequence_state}`,
    to_state: `${nextState.lifecycle_stage}/${nextState.sequence_state}`,
    reason: rotatedOntoHeld
      ? `succession+rotation ${rotation?.previous_contact_id || '?'}→${active_contact_id || '?'}: ${evidence.reason}`
      : `succession after ${channel || stepKind || 'action'}: ${evidence.reason}`,
    evidence_ids: evidence.evidence_ids || [],
    actor: 'system',
  });

  // Automated touch counters feed campaign-process per-contact allowances.
  // Only email + LinkedIn count; human phone / physical mail are manual.
  const automatedHay = `${channel} ${stepKind}`.toLowerCase();
  const isAutomatedTouch =
    automatedHay.includes('send_email')
    || automatedHay.includes('linkedin')
    || (channel === 'email' && !automatedHay.includes('mail_'))
    || stepKind === 'email';
  let automated_actions_used = Number(record.automated_actions_used || 0) || 0;
  if (isAutomatedTouch) automated_actions_used += 1;

  const rotationAt = nowIso();
  const patch: AdvanceAfterSuccessfulActionResult['patch'] = {
    lifecycle_stage: nextState.lifecycle_stage,
    account_sequence_state: nextState.sequence_state,
    work_state: nextState.work_state,
    next_action_json: nextState.next_action ? JSON.stringify(nextState.next_action) : '',
    transition_audit_json: appendTransitionAudit(record.transition_audit_json, audit),
    automated_actions_used,
  };

  if (rotation?.account_contact_plan_json != null) {
    patch.account_contact_plan_json = rotation.account_contact_plan_json;
    patch.active_contact_id = rotation.active_contact_id || '';
  }

  // Quiet period origin + fresh per-contact allowance when a held contact is promoted.
  if (rotatedOntoHeld) {
    patch.last_contact_rotation_at = rotationAt;
    patch.automated_actions_used = 0;
  }

  return {
    patch,
    state: nextState,
    integrity_errors,
    used_complete_action,
    rotated: Boolean(rotation?.rotated),
    previous_contact_id: rotation?.previous_contact_id ?? null,
    rotation,
    audit,
  };
}
