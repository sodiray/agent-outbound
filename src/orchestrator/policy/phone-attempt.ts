/**
 * Phone attempt policy: windows, ceilings, callbacks, wrong-number invalidation,
 * and capacity_unserved outcomes.
 *
 * Design source: human-phone-call-channel-and-attempt-windows.md
 * - Attempt window: local business hours (09:00–17:00, weekdays)
 * - Max attempts per contact/account (Tier A=4, B=3, default 3; C/D=0)
 * - callback disposition → schedule callback_at (overrides ordinary cadence)
 * - wrong_number → suppress phone on contact (dne_phone), not full account DNC
 * - capacity_unserved when attempts exhausted or capacity never selected the candidate
 */

import { NEXT_ACTION_POLICY_VERSION } from './lifecycle.js';
import { DEFAULT_TIME_ZONE, getWeekdayInTimezone, toZonedIsoDate } from '../lib/working-days.js';
import {
  DEFAULT_CONTACT_POLICY,
  resolveContactPolicy,
  type ContactPolicyConfigInput,
} from '../../schemas/config.js';
import { isAffirmativeFlag } from './booleanish.js';

export const PHONE_ATTEMPT_POLICY_VERSION = 'phone-attempt-v1';

/** Inclusive local start hour, exclusive end hour (09:00 ≤ t < 17:00). */
export const DEFAULT_ATTEMPT_WINDOW_START_HOUR = DEFAULT_CONTACT_POLICY.phone.attempt_window.start_hour;
export const DEFAULT_ATTEMPT_WINDOW_END_HOUR = DEFAULT_CONTACT_POLICY.phone.attempt_window.end_hour;

/** Fallback ceiling when tier is unknown. */
export const DEFAULT_MAX_PHONE_ATTEMPTS = DEFAULT_CONTACT_POLICY.phone.max_attempts.default;

/** Default delay for disposition=callback when no explicit callback_at. */
export const DEFAULT_CALLBACK_DELAY_HOURS = DEFAULT_CONTACT_POLICY.phone.callback_delay_hours;

/**
 * Treatment ceilings (hard calibration params — ceilings, not quotas).
 * Tier C/D: no proactive cold attempts.
 */
export const TIER_MAX_PHONE_ATTEMPTS: Record<string, number> = {
  A: DEFAULT_CONTACT_POLICY.phone.max_attempts.A,
  B: DEFAULT_CONTACT_POLICY.phone.max_attempts.B,
  C: DEFAULT_CONTACT_POLICY.phone.max_attempts.C,
  D: DEFAULT_CONTACT_POLICY.phone.max_attempts.D,
  enrichment_hold: DEFAULT_CONTACT_POLICY.phone.max_attempts.enrichment_hold,
};

export type PhoneCallDisposition =
  | 'completed'
  | 'no_answer'
  | 'callback'
  | 'wrong_number'
  | 'not_interested'
  | 'skipped'
  | 'capacity_unserved';

/** Canonical allowlist for operator dispose / call-board dispositions. */
export const PHONE_CALL_DISPOSITIONS: readonly PhoneCallDisposition[] = [
  'completed',
  'no_answer',
  'callback',
  'wrong_number',
  'not_interested',
  'skipped',
  'capacity_unserved',
] as const;

const PHONE_CALL_DISPOSITION_SET = new Set<string>(PHONE_CALL_DISPOSITIONS);

/** True when `value` is a known PhoneCallDisposition (exact string). */
export function isPhoneCallDisposition(value: unknown): value is PhoneCallDisposition {
  return PHONE_CALL_DISPOSITION_SET.has(String(value ?? '').trim());
}

/** Parse/validate disposition or throw a clear operator error. */
export function assertPhoneCallDisposition(value: unknown): PhoneCallDisposition {
  const raw = String(value ?? '').trim();
  if (!isPhoneCallDisposition(raw)) {
    throw new Error(
      `Invalid call disposition "${raw || '(empty)'}". Allowed: ${PHONE_CALL_DISPOSITIONS.join(', ')}`,
    );
  }
  return raw;
}

export type CallWindowStatus =
  | 'eligible'
  | 'candidate'
  | 'claimed'
  | 'callback_scheduled'
  | 'connected'
  | 'capacity_unserved'
  | 'exhausted'
  | 'blocked'
  | 'cancelled'
  | 'open'
  | 'completed'
  | 'skipped';

export type PhoneAttemptPolicyConfig = {
  timeZone?: string;
  startHour?: number;
  endHour?: number;
  /** Override per-tier / default ceiling. */
  maxAttempts?: number;
  /** Pipeline-configured default and per-tier ceilings. */
  maxAttemptsByTier?: Partial<Record<string, number>>;
  defaultMaxAttempts?: number;
  /** Hours until callback when disposition=callback and no explicit time. */
  callbackDelayHours?: number;
  /** Restrict attempt window to Mon–Fri in timeZone (default true). */
  weekdaysOnly?: boolean;
};

const optionalNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Resolve phone policy values from the pipeline's contact policy and timezone config. */
export const resolvePhoneAttemptPolicyConfig = (config: unknown): PhoneAttemptPolicyConfig => {
  const pipeline = config && typeof config === 'object'
    ? config as Record<string, unknown>
    : {};
  const operations = pipeline.operations && typeof pipeline.operations === 'object'
    ? pipeline.operations as Record<string, unknown>
    : {};
  const channels = pipeline.channels && typeof pipeline.channels === 'object'
    ? pipeline.channels as Record<string, unknown>
    : {};
  const phone = channels.phone && typeof channels.phone === 'object'
    ? channels.phone as Record<string, unknown>
    : {};
  const contactPolicy = resolveContactPolicy(
    pipeline.contact_policy as ContactPolicyConfigInput | undefined,
  );
  const timeZone = String(phone.timezone || operations.timezone || DEFAULT_TIME_ZONE).trim();

  return {
    timeZone,
    startHour: contactPolicy.phone.attempt_window.start_hour,
    endHour: contactPolicy.phone.attempt_window.end_hour,
    maxAttemptsByTier: contactPolicy.phone.max_attempts,
    defaultMaxAttempts: contactPolicy.phone.max_attempts.default,
    callbackDelayHours: contactPolicy.phone.callback_delay_hours,
    weekdaysOnly: contactPolicy.phone.attempt_window.weekdays_only,
  };
};

const text = (value: unknown) => String(value ?? '').trim();

/** Local wall-clock hour (0–23) in an IANA timezone. */
export function getZonedHour(
  now: Date | string | number = Date.now(),
  timeZone: string = DEFAULT_TIME_ZONE,
): number {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) return -1;
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  }).format(d);
  // Some engines emit "24" for midnight — normalize.
  const hour = Number(hourStr);
  if (!Number.isFinite(hour)) return -1;
  return hour === 24 ? 0 : hour;
}

export function maxPhoneAttemptsForTier(
  treatmentTier: string | null | undefined,
  override?: number,
  config: PhoneAttemptPolicyConfig = {},
): number {
  if (Number.isFinite(Number(override)) && Number(override) >= 0) {
    return Math.floor(Number(override));
  }
  const tier = text(treatmentTier) || 'B';
  const configured = optionalNumber(config.maxAttemptsByTier?.[tier]);
  if (configured !== undefined && configured >= 0) return Math.floor(configured);
  if (tier in TIER_MAX_PHONE_ATTEMPTS) {
    return TIER_MAX_PHONE_ATTEMPTS[tier];
  }
  const defaultMaxAttempts = optionalNumber(config.defaultMaxAttempts);
  return defaultMaxAttempts !== undefined && defaultMaxAttempts >= 0
    ? Math.floor(defaultMaxAttempts)
    : DEFAULT_MAX_PHONE_ATTEMPTS;
}

export function readCallAttemptCount(
  record: Record<string, unknown> | null | undefined,
): number {
  return Math.max(0, Math.floor(Number(record?.call_attempt_count) || 0));
}

/**
 * True when local wall clock is inside the attempt window.
 * Default: Mon–Fri 09:00–17:00 UTC when no pipeline policy is supplied.
 */
export function isWithinPhoneAttemptWindow(
  now: Date | string | number = Date.now(),
  config: PhoneAttemptPolicyConfig = {},
): boolean {
  const timeZone = config.timeZone || DEFAULT_TIME_ZONE;
  const startHour = Number.isFinite(Number(config.startHour))
    ? Number(config.startHour)
    : DEFAULT_ATTEMPT_WINDOW_START_HOUR;
  const endHour = Number.isFinite(Number(config.endHour))
    ? Number(config.endHour)
    : DEFAULT_ATTEMPT_WINDOW_END_HOUR;
  const weekdaysOnly = config.weekdaysOnly !== false;

  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) return false;

  if (weekdaysOnly) {
    const wd = getWeekdayInTimezone(d, timeZone);
    if (wd === 'sat' || wd === 'sun') return false;
  }

  const hour = getZonedHour(d, timeZone);
  if (hour < 0) return false;
  return hour >= startHour && hour < endHour;
}

/** Phone path structurally suppressed (wrong number / invalid), not account DNC. */
export function isPhonePathSuppressed(
  record: Record<string, unknown> | null | undefined,
): boolean {
  if (!record) return true;
  if (isAffirmativeFlag(record.dne_phone, { failClosed: true })) return true;
  if (isAffirmativeFlag(record.phone_suppressed, { failClosed: true })) return true;
  // dnc_phone is opt-out (person said don't call) — also blocks board.
  if (isAffirmativeFlag(record.dnc_phone, { failClosed: true })) return true;
  return false;
}

export function isPhoneAttemptCeilingReached(
  record: Record<string, unknown> | null | undefined,
  config: PhoneAttemptPolicyConfig = {},
): boolean {
  const max = maxPhoneAttemptsForTier(
    text(record?.treatment_tier),
    config.maxAttempts,
    config,
  );
  if (max <= 0) return true;
  return readCallAttemptCount(record) >= max;
}

/**
 * Parse callback due timestamp from record fields.
 * Accepts call_callback_at, callback_at, disposition_follow_up_at.
 */
export function readCallbackAt(
  record: Record<string, unknown> | null | undefined,
): string | null {
  if (!record) return null;
  const raw = text(
    record.call_callback_at
    || record.callback_at
    || record.disposition_follow_up_at
    || '',
  );
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** True when a scheduled callback exists and is due at/before now. */
export function isCallbackDue(
  record: Record<string, unknown> | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const at = readCallbackAt(record);
  if (!at) return false;
  const ms = Date.parse(at);
  return Number.isFinite(ms) && ms <= nowMs;
}

/** True when a future callback is scheduled (blocks ordinary cold re-queue). */
export function hasFutureCallback(
  record: Record<string, unknown> | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const at = readCallbackAt(record);
  if (!at) return false;
  const ms = Date.parse(at);
  return Number.isFinite(ms) && ms > nowMs;
}

/**
 * Schedule callback_at ISO from a disposition=callback.
 * Defaults to now + callbackDelayHours (24h).
 */
export function scheduleCallbackAt(
  from: Date | string | number = Date.now(),
  config: PhoneAttemptPolicyConfig = {},
): string {
  const base = from instanceof Date
    ? from.getTime()
    : typeof from === 'number'
      ? from
      : Date.parse(String(from));
  const ms = Number.isFinite(base) ? base : Date.now();
  const hours = Number.isFinite(Number(config.callbackDelayHours))
    && Number(config.callbackDelayHours) >= 0
    ? Number(config.callbackDelayHours)
    : DEFAULT_CALLBACK_DELAY_HOURS;
  return new Date(ms + hours * 60 * 60 * 1000).toISOString();
}

export type PhoneAttemptEligibility = {
  eligible: boolean;
  blockers: string[];
  reasons: string[];
  max_attempts: number;
  attempt_count: number;
  within_window: boolean;
  callback_at: string | null;
  policy_version: string;
};

/**
 * Pure eligibility for call-board list / claim under attempt policy.
 * Does not re-check suppression/lifecycle/sequence (call-board owns those).
 */
export function evaluatePhoneAttemptEligibility(
  record: Record<string, unknown> | null | undefined,
  opts: {
    nowMs?: number;
    config?: PhoneAttemptPolicyConfig;
    /** When false, skip local business-hours gate (admin / tests). Default true. */
    enforceAttemptWindow?: boolean;
    /**
     * When true (default), a future callback_at blocks eligibility until due.
     * Callbacks that are due pass this gate.
     */
    enforceCallbackDue?: boolean;
  } = {},
): PhoneAttemptEligibility {
  const blockers: string[] = [];
  const reasons: string[] = [];
  const nowMs = opts.nowMs ?? Date.now();
  const config = opts.config || {};
  const enforceWindow = opts.enforceAttemptWindow !== false;
  const enforceCallback = opts.enforceCallbackDue !== false;

  const maxAttempts = maxPhoneAttemptsForTier(
    text(record?.treatment_tier),
    config.maxAttempts,
  );
  const attemptCount = readCallAttemptCount(record);
  const within = isWithinPhoneAttemptWindow(nowMs, config);
  const callbackAt = readCallbackAt(record);

  if (!record) {
    blockers.push('missing_record');
  } else {
    if (isPhonePathSuppressed(record)) {
      blockers.push('phone_path_suppressed');
    }
    if (attemptCount >= maxAttempts || maxAttempts <= 0) {
      blockers.push(`attempt_ceiling:${attemptCount}>=${maxAttempts}`);
    }
    if (enforceWindow && !within) {
      // Promised callbacks that are due may still surface outside ordinary hours
      // only when explicitly opted; default: still respect window for dial safety.
      blockers.push('outside_attempt_window');
    }
    if (enforceCallback && hasFutureCallback(record, nowMs)) {
      blockers.push(`callback_not_due:${callbackAt}`);
    }
    const windowStatus = text(record.call_window_status).toLowerCase();
    if (
      windowStatus === 'capacity_unserved'
      || windowStatus === 'exhausted'
      || windowStatus === 'blocked'
      || windowStatus === 'cancelled'
    ) {
      blockers.push(`call_window_${windowStatus}`);
    }
  }

  if (blockers.length === 0) {
    reasons.push('phone_attempt_ok');
    if (isCallbackDue(record, nowMs)) reasons.push('callback_due');
  }

  return {
    eligible: blockers.length === 0,
    blockers,
    reasons,
    max_attempts: maxAttempts,
    attempt_count: attemptCount,
    within_window: within,
    callback_at: callbackAt,
    policy_version: PHONE_ATTEMPT_POLICY_VERSION,
  };
}

function bumpAttempt(disposition: PhoneCallDisposition): boolean {
  // Skipped without dial / capacity_unserved without dial do not count.
  if (disposition === 'skipped' || disposition === 'capacity_unserved') return false;
  return true;
}

function buildCapacityUnservedNextAction(input: {
  accountId: string;
  contactId?: string | null;
  lifecycle_stage: string;
  sequence_state: string;
  reason: string;
}): Record<string, unknown> {
  return {
    action_id: `na_capacity_unserved_${input.accountId}_${Date.now()}`,
    action_type: 'capacity_unserved',
    account_id: input.accountId,
    contact_id: input.contactId ?? null,
    channel: 'phone',
    lifecycle_stage: input.lifecycle_stage,
    sequence_state: input.sequence_state,
    work_state: 'idle',
    reason: input.reason,
    on_success: 'continue_sequence_or_recycle',
    policy_version: NEXT_ACTION_POLICY_VERSION,
    phone_outcome: 'capacity_unserved',
  };
}

function buildCallbackNextAction(input: {
  accountId: string;
  contactId?: string | null;
  lifecycle_stage: string;
  sequence_state: string;
  callbackAt: string;
}): Record<string, unknown> {
  return {
    action_id: `na_callback_${input.accountId}_${Date.now()}`,
    action_type: 'call_human',
    account_id: input.accountId,
    contact_id: input.contactId ?? null,
    channel: 'phone',
    lifecycle_stage: input.lifecycle_stage,
    sequence_state: input.sequence_state,
    work_state: 'human_commercial_followup',
    due_at: input.callbackAt,
    reason: 'callback_requested',
    on_success: 'continue_phone_or_exit',
    policy_version: NEXT_ACTION_POLICY_VERSION,
    phone_outcome: 'callback_scheduled',
  };
}

function buildWrongNumberNextAction(input: {
  accountId: string;
  contactId?: string | null;
  lifecycle_stage: string;
  sequence_state: string;
}): Record<string, unknown> {
  return {
    action_id: `na_wrong_number_${input.accountId}_${Date.now()}`,
    action_type: 'channel_repair',
    account_id: input.accountId,
    contact_id: input.contactId ?? null,
    channel: 'phone',
    lifecycle_stage: input.lifecycle_stage,
    sequence_state: input.sequence_state === 'active' ? 'paused_repair' : input.sequence_state,
    work_state: 'channel_repair',
    reason: 'wrong_number',
    on_success: 'seek_alternate_phone_or_continue',
    policy_version: NEXT_ACTION_POLICY_VERSION,
    phone_outcome: 'wrong_number',
  };
}

export type ApplyPhoneDispositionResult = {
  patch: Record<string, unknown>;
  call_attempt_count: number;
  call_window_status: CallWindowStatus;
  /** Effective claim board status after disposition. */
  call_claim_status: 'open' | 'claimed' | 'completed' | 'skipped';
  disposition: PhoneCallDisposition;
  next_action: Record<string, unknown> | null;
  /** True when phone path is invalidated (dne_phone). */
  phone_invalidated: boolean;
  /** True when attempts/capacity produced capacity_unserved. */
  capacity_unserved: boolean;
  policy_version: string;
};

/**
 * Pure disposition → record patch. Does not touch the DB.
 *
 * wrong_number → dne_phone + phone_suppressed (not account suppressed / not dnc_phone)
 * callback → call_callback_at + window open when due
 * no_answer under ceiling → re-open for next attempt
 * no_answer at ceiling / capacity_unserved → capacity_unserved next_action
 */
export function applyPhoneDisposition(input: {
  record: Record<string, unknown>;
  disposition: PhoneCallDisposition;
  note?: string;
  at?: string;
  config?: PhoneAttemptPolicyConfig;
  /** Explicit callback time; otherwise scheduleCallbackAt(at). */
  callbackAt?: string | null;
  /** Force capacity_unserved even when attempts remain (board never selected). */
  forceCapacityUnserved?: boolean;
}): ApplyPhoneDispositionResult {
  const record = input.record;
  const at = String(input.at || new Date().toISOString());
  const config = input.config || {};
  const disposition = input.disposition;
  const accountId = text(record._row_id || record.account_id || 'unknown');
  const contactId = text(
    record.active_contact_id || record.contact_id || '',
  ) || null;
  const lifecycle = text(record.lifecycle_stage) || 'contacted';
  const sequence = text(record.account_sequence_state) || 'active';

  const priorAttempts = readCallAttemptCount(record);
  const nextAttempts = bumpAttempt(disposition) ? priorAttempts + 1 : priorAttempts;
  const maxAttempts = maxPhoneAttemptsForTier(text(record.treatment_tier), config.maxAttempts);
  const ceilingHit = nextAttempts >= maxAttempts || maxAttempts <= 0;

  let call_window_status: CallWindowStatus = 'candidate';
  let call_claim_status: ApplyPhoneDispositionResult['call_claim_status'] = 'open';
  let next_action: Record<string, unknown> | null = null;
  let phone_invalidated = false;
  let capacity_unserved = false;
  let call_callback_at = text(record.call_callback_at) || '';

  const basePatch: Record<string, unknown> = {
    call_disposition: disposition,
    call_disposition_at: at,
    call_disposition_note: String(input.note || ''),
    call_attempt_count: nextAttempts,
    // Clear lease fields after any completed dial disposition.
    call_claimed_by: '',
    call_claimed_at: '',
    call_claim_expires_at: '',
  };

  if (disposition === 'capacity_unserved' || input.forceCapacityUnserved) {
    capacity_unserved = true;
    call_window_status = 'capacity_unserved';
    call_claim_status = 'completed';
    next_action = buildCapacityUnservedNextAction({
      accountId,
      contactId,
      lifecycle_stage: lifecycle,
      sequence_state: sequence,
      reason: 'capacity_unserved',
    });
  } else if (disposition === 'wrong_number') {
    phone_invalidated = true;
    call_window_status = 'blocked';
    call_claim_status = 'completed';
    next_action = buildWrongNumberNextAction({
      accountId,
      contactId,
      lifecycle_stage: lifecycle,
      sequence_state: sequence,
    });
    Object.assign(basePatch, {
      // Structural number invalidation — NOT full-account DNC, NOT dnc_phone opt-out.
      dne_phone: 1,
      phone_suppressed: 1,
      phone_status: 'invalid',
      phone_invalid_reason: 'wrong_number',
      // Leave suppressed / dnc_phone untouched.
      account_sequence_state:
        sequence === 'active' || sequence === 'waiting'
          ? 'paused_repair'
          : sequence,
      work_state: 'channel_repair',
    });
  } else if (disposition === 'callback') {
    const cb = text(input.callbackAt) || scheduleCallbackAt(at, config);
    call_callback_at = cb;
    call_window_status = 'callback_scheduled';
    call_claim_status = 'open';
    next_action = buildCallbackNextAction({
      accountId,
      contactId,
      lifecycle_stage: lifecycle,
      sequence_state: sequence,
      callbackAt: cb,
    });
    Object.assign(basePatch, {
      call_callback_at: cb,
      callback_at: cb,
      disposition_follow_up_at: cb,
      disposition_latest: 'callback_requested',
    });
  } else if (disposition === 'no_answer') {
    if (ceilingHit) {
      capacity_unserved = true;
      call_window_status = 'exhausted';
      call_claim_status = 'completed';
      next_action = buildCapacityUnservedNextAction({
        accountId,
        contactId,
        lifecycle_stage: lifecycle,
        sequence_state: sequence,
        reason: `attempt_ceiling_exhausted:${nextAttempts}>=${maxAttempts}`,
      });
      // Design: exhaustion ≠ DQ. Leave lifecycle alone; surface capacity_unserved.
    } else {
      call_window_status = 'candidate';
      call_claim_status = 'open';
      // Stay on phone path — ordinary cadence re-queue (same day blocked by board window).
      next_action = {
        action_id: `na_phone_retry_${accountId}_${Date.now()}`,
        action_type: 'call_human',
        account_id: accountId,
        contact_id: contactId,
        channel: 'phone',
        lifecycle_stage: lifecycle,
        sequence_state: sequence,
        work_state: 'human_commercial_followup',
        reason: 'no_answer_retry',
        on_success: 'continue_phone_or_exit',
        policy_version: NEXT_ACTION_POLICY_VERSION,
        phone_outcome: 'no_answer',
      };
    }
  } else if (disposition === 'not_interested') {
    call_window_status = 'exhausted';
    call_claim_status = 'completed';
    next_action = {
      action_id: `na_not_interested_${accountId}_${Date.now()}`,
      action_type: 'terminal_recordkeeping',
      account_id: accountId,
      contact_id: contactId,
      channel: 'phone',
      lifecycle_stage: lifecycle,
      sequence_state: 'completed',
      work_state: 'terminal_recordkeeping',
      reason: 'not_interested',
      on_success: 'stop',
      policy_version: NEXT_ACTION_POLICY_VERSION,
      phone_outcome: 'not_interested',
    };
    Object.assign(basePatch, {
      account_sequence_state: 'completed',
      work_state: 'terminal_recordkeeping',
      disposition_latest: 'not_interested',
    });
  } else if (disposition === 'skipped') {
    call_window_status = 'cancelled';
    call_claim_status = 'skipped';
  } else {
    // completed (connected outcome collapsed for board) — exits the window
    // regardless of attempt ceiling.
    call_window_status = 'connected';
    call_claim_status = 'completed';
  }

  const patch: Record<string, unknown> = {
    ...record,
    ...basePatch,
    call_claim_status,
    call_window_status,
    call_callback_at: call_callback_at || text(record.call_callback_at) || '',
  };

  if (next_action) {
    patch.next_action_json = JSON.stringify(next_action);
    if (disposition === 'callback' && call_callback_at) {
      // Surface due date for sequencer / board.
      patch.next_action_date = toZonedIsoDate(call_callback_at, config.timeZone || DEFAULT_TIME_ZONE)
        || call_callback_at.slice(0, 10);
    }
    if (capacity_unserved) {
      patch.phone_outcome = 'capacity_unserved';
      patch.call_capacity_unserved = 1;
    }
  }

  return {
    patch,
    call_attempt_count: nextAttempts,
    call_window_status,
    call_claim_status,
    disposition,
    next_action,
    phone_invalidated,
    capacity_unserved,
    policy_version: PHONE_ATTEMPT_POLICY_VERSION,
  };
}

/**
 * Mark a candidate capacity_unserved without a dial (window expired / never claimed).
 * Does not bump attempt count or invent a no-answer.
 */
export function applyCapacityUnserved(input: {
  record: Record<string, unknown>;
  at?: string;
  reason?: string;
}): ApplyPhoneDispositionResult {
  return applyPhoneDisposition({
    record: input.record,
    disposition: 'capacity_unserved',
    note: input.reason || 'capacity_unserved',
    at: input.at,
    forceCapacityUnserved: true,
  });
}
