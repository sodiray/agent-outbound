/**
 * Human call board: capacity-ranked, claimable phone work with dispositions.
 *
 * Eligibility (all required):
 * - not suppressed
 * - lifecycle not terminal (won / lost / disqualified)
 * - account_sequence_state not cancelled / completed / paused_* blocking / recycle_wait
 * - has open manual phone park OR next_action is call/phone
 * - active contact has a phone number
 * - phone attempt policy: within attempt window, under attempt ceiling,
 *   callback_at due (when scheduled), phone path not dne_phone/suppressed
 *
 * Claims use a time-bounded lease (`call_claim_expires_at`, default 2h).
 * Another operator cannot claim while a lease is unexpired; stale leases
 * present as open on the board and may be reclaimed.
 *
 * Dispose applies phone-attempt policy transitions (wrong_number → dne_phone,
 * callback → callback_at, ceiling → capacity_unserved).
 *
 * Do NOT dump every A/B record that merely has a phone on file.
 */

import { rankCallCapacity } from '../policy/campaign-process.js';
import { parseNextActionFromRecord } from '../policy/lifecycle.js';
import { SEQUENCE_STATES_BLOCK_OUTBOUND } from '../policy/sequence-outbound.js';
import {
  applyPhoneDisposition,
  assertPhoneCallDisposition,
  evaluatePhoneAttemptEligibility,
  type PhoneAttemptPolicyConfig,
  type PhoneCallDisposition,
} from '../policy/phone-attempt.js';
import { listAwaitingManualTasks } from '../pipeline/manual.js';
import {
  nowTimestamp,
  ensureRecordColumns,
  upsertRecord,
  insertChannelEvent,
} from '../runtime/db.js';
import { randomUUID } from 'node:crypto';

/** Default claim lease duration (2 hours). */
export const CALL_CLAIM_LEASE_MS = 2 * 60 * 60 * 1000;

export type CallBoardEntry = {
  record_id: string;
  business_name: string;
  treatment_tier: string;
  fit_score: number | null;
  step_id: string;
  contact_name: string;
  contact_phone: string;
  rank: number;
  spillover: boolean;
  claim_status: 'open' | 'claimed' | 'completed' | 'skipped';
  claimed_by?: string | null;
  claimed_at?: string | null;
  claim_expires_at?: string | null;
  call_attempt_count?: number;
  parked_at?: string;
};

export type CallBoardResult = {
  capacity: number;
  total_candidates: number;
  entries: CallBoardEntry[];
  as_of: string;
};

const TERMINAL_LIFECYCLE = new Set(['won', 'lost', 'disqualified']);

const text = (value: unknown) => String(value ?? '').trim();

/** ISO expiry timestamp for a new claim lease starting at `from` (default now). */
export function callClaimExpiresAt(from: Date | string | number = Date.now()): string {
  const base = from instanceof Date ? from.getTime() : typeof from === 'number' ? from : Date.parse(String(from));
  const ms = Number.isFinite(base) ? base : Date.now();
  return new Date(ms + CALL_CLAIM_LEASE_MS).toISOString();
}

/**
 * True when the row holds an unexpired claim lease by someone.
 * Missing `call_claim_expires_at` falls back to `call_claimed_at + 2h` so
 * pre-lease rows still age out; with neither timestamp, treat as expired.
 */
export function isClaimLeaseActive(
  row: Record<string, unknown> | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!row) return false;
  const status = text(row.call_claim_status).toLowerCase();
  if (status !== 'claimed') return false;
  const claimContactId = text(row.call_claim_contact_id);
  const activeContactId = text(row.active_contact_id || row.contact_id);
  if (claimContactId && activeContactId && claimContactId !== activeContactId) return false;

  const expiresRaw = text(row.call_claim_expires_at);
  if (expiresRaw) {
    const exp = Date.parse(expiresRaw);
    return Number.isFinite(exp) && exp > nowMs;
  }

  const claimedAtRaw = text(row.call_claimed_at);
  if (claimedAtRaw) {
    const claimedMs = Date.parse(claimedAtRaw);
    if (!Number.isFinite(claimedMs)) return false;
    return claimedMs + CALL_CLAIM_LEASE_MS > nowMs;
  }

  return false;
}

/**
 * Effective board presentation of claim state.
 * Terminal statuses (completed / skipped) pass through; active leases show
 * claimed; expired / missing leases show open with claim fields cleared.
 */
export function resolveCallClaimPresentation(
  row: Record<string, unknown> | null | undefined,
  nowMs: number = Date.now(),
): {
  claim_status: CallBoardEntry['claim_status'];
  claimed_by: string | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
  call_attempt_count: number;
} {
  const attempt = Math.max(0, Number(row?.call_attempt_count) || 0);
  const raw = text(row?.call_claim_status).toLowerCase();
  if (raw === 'completed' || raw === 'skipped') {
    return {
      claim_status: raw,
      claimed_by: row?.call_claimed_by ? text(row.call_claimed_by) : null,
      claimed_at: row?.call_claimed_at ? text(row.call_claimed_at) : null,
      claim_expires_at: null,
      call_attempt_count: attempt,
    };
  }
  if (raw === 'claimed' && isClaimLeaseActive(row, nowMs)) {
    return {
      claim_status: 'claimed',
      claimed_by: row?.call_claimed_by ? text(row.call_claimed_by) : null,
      claimed_at: row?.call_claimed_at ? text(row.call_claimed_at) : null,
      claim_expires_at: text(row?.call_claim_expires_at) || callClaimExpiresAt(text(row?.call_claimed_at) || nowMs),
      call_attempt_count: attempt,
    };
  }
  // Stale claim or open → present as open.
  return {
    claim_status: 'open',
    claimed_by: null,
    claimed_at: null,
    claim_expires_at: null,
    call_attempt_count: attempt,
  };
}

/** True when the record has a usable phone number on the active contact fields. */
export function recordHasPhone(row: Record<string, unknown> | null | undefined): boolean {
  if (!row) return false;
  return Boolean(text(row.phone) || text(row.contact_phone));
}

export function isRecordSuppressed(row: Record<string, unknown> | null | undefined): boolean {
  if (!row) return true;
  const s = row.suppressed;
  return s === true || s === 1 || s === '1' || s === 'true';
}

export function isTerminalLifecycle(row: Record<string, unknown> | null | undefined): boolean {
  return TERMINAL_LIFECYCLE.has(text(row?.lifecycle_stage).toLowerCase());
}

/**
 * Sequence states that must not appear on the call board:
 * cancelled, completed, paused_* that block outbound, recycle_wait.
 */
export function isSequenceStateBlockingCallBoard(
  row: Record<string, unknown> | null | undefined,
): boolean {
  const state = text(row?.account_sequence_state);
  if (!state) return false;
  if (SEQUENCE_STATES_BLOCK_OUTBOUND.has(state)) return true;
  if (state.startsWith('paused_')) return true;
  return false;
}

/** True when step_id / task_type clearly identifies a human phone park. */
export function isPhoneParkStep(stepId: string, taskType = ''): boolean {
  const s = text(stepId).toLowerCase();
  const t = text(taskType).toLowerCase();
  return (
    s.includes('phone')
    || s.includes('call')
    || t === 'human_phone'
    || t.includes('phone')
    || (t.includes('call') && t !== 'callback')
  );
}

/** True when next_action_json targets a phone / call action. */
export function nextActionIsPhone(row: Record<string, unknown> | null | undefined): boolean {
  if (!row) return false;
  const next = parseNextActionFromRecord(row);
  if (next) {
    const hay = [
      next.action_type,
      (next as { channel?: string }).channel,
      next.work_state,
      next.reason,
      next.owner_type,
      next.on_success,
    ]
      .map((x) => text(x).toLowerCase())
      .join(' ');
    if (
      hay.includes('phone')
      || /\bcall\b/.test(hay)
      || hay.includes('human_phone')
    ) {
      return true;
    }
    return false;
  }
  // Unparseable / missing action_id: fall back to raw JSON string match.
  const raw = text(row.next_action_json).toLowerCase();
  if (!raw) return false;
  return (
    raw.includes('phone')
    || raw.includes('human_phone')
    || raw.includes('"call"')
    || raw.includes("'call'")
  );
}

/**
 * True when next_action is clearly a non-phone digital channel
 * (send_email / linkedin / mail). Used to refuse call-board claims when
 * there is no open phone park — email-next_action accounts must not be claimable.
 */
export function nextActionIsNonPhoneDigital(
  row: Record<string, unknown> | null | undefined,
): boolean {
  if (!row) return false;
  // Phone next_action wins even if JSON also mentions email in free text.
  if (nextActionIsPhone(row)) return false;

  const next = parseNextActionFromRecord(row);
  const actionType = text(next?.action_type).toLowerCase();
  const channel = text((next as { channel?: string } | null)?.channel).toLowerCase();
  const work = text(next?.work_state).toLowerCase();
  const tokens = [actionType, channel, work].filter(Boolean);

  const isDigital = (s: string) =>
    s === 'send_email'
    || s === 'email'
    || s === 'linkedin_connect'
    || s === 'linkedin'
    || s === 'send_mail'
    || s === 'send_postcard'
    || s === 'mail'
    || s === 'postcard'
    || s.includes('send_email')
    || s.includes('linkedin')
    || (s.includes('mail') && !s.includes('email_thread')); // mail product, not phone

  if (tokens.some(isDigital)) return true;

  // Raw JSON fallback when unparseable.
  if (next) return false;
  const raw = text(row.next_action_json).toLowerCase();
  if (!raw) return false;
  return (
    raw.includes('send_email')
    || raw.includes('"email"')
    || raw.includes('linkedin')
    || raw.includes('send_mail')
    || raw.includes('postcard')
    || (raw.includes('"mail"') && !raw.includes('email'))
  );
}

/**
 * True when the record has an open manual park that is a phone/call task.
 * Checks pipeline_events via listAwaitingManualTasks (passed=0 awaiting_manual).
 */
export function recordHasOpenPhonePark(db: any, recordId: string): boolean {
  const rid = text(recordId);
  if (!rid || !db) return false;
  try {
    const parked = listAwaitingManualTasks({ db, limit: 500 });
    return parked.tasks.some(
      (t) => text(t.record_id) === rid && isPhoneParkStep(t.step_id, t.task_type),
    );
  } catch {
    return false;
  }
}

export type CallBoardEligibilityOpts = {
  hasOpenPhonePark: boolean;
  /** Instant for attempt-window / callback due checks (default Date.now()). */
  nowMs?: number;
  /** Phone attempt policy overrides (window hours, max attempts, timezone). */
  phonePolicy?: PhoneAttemptPolicyConfig;
  /**
   * When false, skip attempt-window / ceiling / callback gates
   * (structural tests of suppression/lifecycle only). Default true.
   */
  enforcePhoneAttemptPolicy?: boolean;
};

/**
 * Shared eligibility gate for call-board candidates.
 * `hasOpenPhonePark` is true when the record has an open manual phone park.
 * Otherwise next_action must itself be call/phone.
 * Phone attempt policy (window, ceiling, callback due, dne_phone) applies
 * unless `enforcePhoneAttemptPolicy` is false.
 */
export function isCallBoardEligible(
  row: Record<string, unknown> | null | undefined,
  opts: CallBoardEligibilityOpts,
): boolean {
  if (!row) return false;
  if (isRecordSuppressed(row)) return false;
  if (isTerminalLifecycle(row)) return false;
  if (isSequenceStateBlockingCallBoard(row)) return false;
  if (!recordHasPhone(row)) return false;
  // Claim already finished — never re-surface.
  const claim = text(row.call_claim_status).toLowerCase();
  if (claim === 'completed' || claim === 'skipped') return false;

  const channelOk = opts.hasOpenPhonePark || nextActionIsPhone(row);
  if (!channelOk) return false;

  if (opts.enforcePhoneAttemptPolicy === false) return true;

  const phoneGate = evaluatePhoneAttemptEligibility(row, {
    nowMs: opts.nowMs,
    config: opts.phonePolicy,
    enforceAttemptWindow: true,
    enforceCallbackDue: true,
  });
  return phoneGate.eligible;
}

/** Build capacity-ranked call board from parked human_phone tasks + phone next_actions. */
export function getCallBoard(input: {
  db: any;
  capacity?: number;
  limit?: number;
  /** Injected clock for attempt window / callback due (tests). */
  nowMs?: number;
  phonePolicy?: PhoneAttemptPolicyConfig;
}): CallBoardResult {
  const capacity = Math.max(1, Number(input.capacity) || 25);
  const asOfMs = input.nowMs ?? Date.now();
  const phoneOpts = {
    nowMs: asOfMs,
    phonePolicy: input.phonePolicy,
    enforcePhoneAttemptPolicy: true as const,
  };
  const parked = listAwaitingManualTasks({
    db: input.db,
    limit: Math.max(capacity * 4, 100),
  });

  // Only true phone parks — not every manual_task (mail / linkedin / etc.).
  const phoneTasks = parked.tasks.filter((t) => isPhoneParkStep(t.step_id, t.task_type));

  const candidates: Array<{
    record_id: string;
    treatment_tier: string;
    fit_score?: number;
    priority_rank?: number;
    prepared: boolean;
    /** Callback-due candidates outrank ordinary cold attempts. */
    callback_due: boolean;
    step_id: string;
    business_name: string;
    contact_name: string;
    contact_phone: string;
    parked_at: string;
    claimed_by: string | null;
    claimed_at: string | null;
    claim_expires_at: string | null;
    claim_status: CallBoardEntry['claim_status'];
    call_attempt_count: number;
  }> = [];

  for (const t of phoneTasks) {
    const row = input.db.prepare('SELECT * FROM records WHERE _row_id = ?').get(t.record_id) as
      | Record<string, unknown>
      | undefined;
    if (!isCallBoardEligible(row, { hasOpenPhonePark: true, ...phoneOpts })) continue;
    const claim = resolveCallClaimPresentation(row, asOfMs);
    const phoneGate = evaluatePhoneAttemptEligibility(row, {
      nowMs: asOfMs,
      config: input.phonePolicy,
    });
    candidates.push({
      record_id: t.record_id,
      treatment_tier: text(row?.treatment_tier) || 'B',
      fit_score: row?.fit_score != null ? Number(row.fit_score) : undefined,
      priority_rank: row?.priority_rank != null ? Number(row.priority_rank) : undefined,
      prepared: true,
      callback_due: phoneGate.reasons.includes('callback_due'),
      step_id: t.step_id,
      business_name: t.business_name || text(row?.business_name),
      contact_name: t.contact_name || text(row?.contact_name),
      contact_phone: text(row?.phone) || text(row?.contact_phone),
      parked_at: t.parked_at,
      claimed_by: claim.claimed_by,
      claimed_at: claim.claimed_at,
      claim_expires_at: claim.claim_expires_at,
      claim_status: claim.claim_status,
      call_attempt_count: claim.call_attempt_count,
    });
  }

  // Also include records whose next_action is call/phone (no park yet).
  // Never include "any A/B with a phone" — only next_action phone work that passes eligibility.
  try {
    // SELECT * so new lease columns (call_claim_expires_at, call_attempt_count) are
    // optional — older schemas without them still load next_action phone candidates.
    const active = input.db.prepare(`
      SELECT *
      FROM records
      WHERE treatment_tier IN ('A','B')
        AND (COALESCE(phone,'') != '' OR COALESCE(contact_phone,'') != '')
        AND COALESCE(call_claim_status,'') NOT IN ('completed','skipped')
        AND COALESCE(suppressed, 0) NOT IN (1, '1', 'true')
        AND COALESCE(lifecycle_stage, '') NOT IN ('won', 'lost', 'disqualified')
        AND COALESCE(account_sequence_state, '') NOT IN (
          'cancelled', 'completed', 'paused_review', 'paused_inbound', 'paused_repair', 'recycle_wait'
        )
        AND (
          lower(COALESCE(next_action_json, '')) LIKE '%phone%'
          OR lower(COALESCE(next_action_json, '')) LIKE '%human_phone%'
          OR lower(COALESCE(next_action_json, '')) LIKE '%"call"%'
          OR lower(COALESCE(next_action_json, '')) LIKE '%call_%'
          OR lower(COALESCE(next_action_json, '')) LIKE '%_call%'
        )
      ORDER BY CASE treatment_tier WHEN 'A' THEN 0 ELSE 1 END, fit_score DESC
      LIMIT ?
    `).all(capacity * 4) as Array<Record<string, unknown>>;

    for (const row of active) {
      const recordId = text(row._row_id);
      if (!recordId) continue;
      if (candidates.some((c) => c.record_id === recordId)) continue;
      if (!isCallBoardEligible(row, { hasOpenPhonePark: false, ...phoneOpts })) continue;
      const claim = resolveCallClaimPresentation(row, asOfMs);
      const phoneGate = evaluatePhoneAttemptEligibility(row, {
        nowMs: asOfMs,
        config: input.phonePolicy,
      });
      candidates.push({
        record_id: recordId,
        treatment_tier: text(row.treatment_tier) || 'B',
        fit_score: row.fit_score != null ? Number(row.fit_score) : undefined,
        priority_rank: row.priority_rank != null ? Number(row.priority_rank) : undefined,
        prepared: false,
        callback_due: phoneGate.reasons.includes('callback_due'),
        step_id: 'phone_1',
        business_name: text(row.business_name),
        contact_name: text(row.contact_name),
        contact_phone: text(row.phone) || text(row.contact_phone),
        parked_at: '',
        claimed_by: claim.claimed_by,
        claimed_at: claim.claimed_at,
        claim_expires_at: claim.claim_expires_at,
        claim_status: claim.claim_status,
        call_attempt_count: claim.call_attempt_count,
      });
    }
  } catch {
    /* columns may be missing on empty schema — ignore */
  }

  // Promised callbacks that are due outrank ordinary cold candidates before tier ranking.
  const orderedForRank = [
    ...candidates.filter((c) => c.callback_due),
    ...candidates.filter((c) => !c.callback_due),
  ];

  const ranked = rankCallCapacity({
    candidates: orderedForRank.map((c) => ({
      record_id: c.record_id,
      treatment_tier: c.treatment_tier,
      // Callback-due gets a synthetic score boost so A/B ranking still prefers them.
      fit_score: (c.fit_score || 0) + (c.callback_due ? 10_000 : 0),
      priority_rank: c.priority_rank,
      prepared: c.prepared,
    })),
    capacity,
  });

  const entries: CallBoardEntry[] = ranked.map((r) => {
    const c = candidates.find((x) => x.record_id === r.record_id)!;
    return {
      record_id: r.record_id,
      business_name: c.business_name,
      treatment_tier: r.treatment_tier,
      fit_score: c.fit_score ?? null,
      step_id: c.step_id,
      contact_name: c.contact_name,
      contact_phone: c.contact_phone,
      rank: r.rank,
      spillover: r.spillover,
      claim_status: c.claim_status || 'open',
      claimed_by: c.claimed_by,
      claimed_at: c.claimed_at,
      claim_expires_at: c.claim_expires_at,
      call_attempt_count: c.call_attempt_count,
      parked_at: c.parked_at,
    };
  });

  return {
    capacity,
    total_candidates: candidates.length,
    entries: entries.slice(0, input.limit || capacity),
    as_of: new Date(asOfMs).toISOString(),
  };
}

export function claimCallBoardEntry(input: {
  db: any;
  recordId: string;
  claimedBy: string;
  nowMs?: number;
  phonePolicy?: PhoneAttemptPolicyConfig;
}): {
  ok: boolean;
  record_id: string;
  claimed_by: string;
  claimed_at: string;
  claim_expires_at: string;
} {
  const rid = String(input.recordId || '').trim();
  const by = String(input.claimedBy || 'operator').trim() || 'operator';
  const now = nowTimestamp();
  const nowMs = input.nowMs ?? Date.now();
  const expiresAt = callClaimExpiresAt(now);
  const row = input.db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rid) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`Record not found: ${rid}`);

  // Eligibility must still hold for a fresh claim (suppressed / terminal / paused /
  // cancelled / inbound / no phone / attempt policy). Re-check full board eligibility
  // so a stale board cannot claim after pause/cancel or outside the attempt window.
  //
  // Critical: do NOT assume hasOpenPhonePark=true. Email / linkedin / mail
  // next_action with no open phone park is never claimable — even if a phone
  // number is on file.
  const phoneOpts = {
    nowMs,
    phonePolicy: input.phonePolicy,
    enforcePhoneAttemptPolicy: true as const,
  };
  const hasOpenPhonePark = recordHasOpenPhonePark(input.db, rid);

  if (nextActionIsNonPhoneDigital(row) && !hasOpenPhonePark) {
    const next = parseNextActionFromRecord(row);
    const actionType = text(next?.action_type) || 'non-phone digital';
    throw new Error(
      `Cannot claim: record ${rid} has next_action=${actionType} (non-phone digital) and no open phone park`,
    );
  }

  if (!isCallBoardEligible(row, { hasOpenPhonePark, ...phoneOpts })) {
    const state = text(row.account_sequence_state) || 'unknown';
    const phoneGate = evaluatePhoneAttemptEligibility(row, {
      nowMs,
      config: input.phonePolicy,
    });
    const detail = phoneGate.blockers.length
      ? ` phone_blockers=${phoneGate.blockers.join(',')}`
      : '';
    throw new Error(
      `Cannot claim: record ${rid} is not call-board eligible (sequence_state=${state}${detail})`,
    );
  }

  const rawStatus = text(row.call_claim_status).toLowerCase();
  if (rawStatus === 'completed' || rawStatus === 'skipped') {
    throw new Error(`Cannot claim: call already ${rawStatus}`);
  }

  // Refuse if another operator holds an unexpired lease. Same operator may refresh.
  if (isClaimLeaseActive(row)) {
    const holder = text(row.call_claimed_by);
    if (holder && holder !== by) {
      const until = text(row.call_claim_expires_at) || 'lease active';
      throw new Error(`Already claimed by ${holder} until ${until}`);
    }
  }

  ensureRecordColumns({
    db: input.db,
    columns: [
      'call_claim_status',
      'call_claimed_by',
      'call_claimed_at',
      'call_claim_expires_at',
      'call_claim_contact_id',
    ],
  });
  const activeContactId = text(row.active_contact_id || row.contact_id);
  upsertRecord({
    db: input.db,
    row: {
      ...row,
      call_claim_status: 'claimed',
      call_claimed_by: by,
      call_claimed_at: now,
      call_claim_expires_at: expiresAt,
      call_claim_contact_id: activeContactId,
    },
  });
  return {
    ok: true,
    record_id: rid,
    claimed_by: by,
    claimed_at: now,
    claim_expires_at: expiresAt,
  };
}

/**
 * Release an active lease back to open. Only the lease owner may release while
 * the lease is unexpired (unless force=true, e.g. supervisor).
 * Expired leases may be released by anyone (cleanup).
 */
export function releaseCallBoardClaim(input: {
  db: any;
  recordId: string;
  releasedBy: string;
  force?: boolean;
}): {
  ok: boolean;
  record_id: string;
  released: boolean;
  reason: string;
} {
  const rid = String(input.recordId || '').trim();
  const by = String(input.releasedBy || 'operator').trim() || 'operator';
  const row = input.db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rid) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`Record not found: ${rid}`);

  const rawStatus = text(row.call_claim_status).toLowerCase();
  if (rawStatus === 'completed' || rawStatus === 'skipped') {
    return { ok: true, record_id: rid, released: false, reason: `already_${rawStatus}` };
  }
  if (rawStatus !== 'claimed' && !text(row.call_claimed_by)) {
    return { ok: true, record_id: rid, released: false, reason: 'not_claimed' };
  }

  const holder = text(row.call_claimed_by);
  const active = isClaimLeaseActive(row);
  if (active && holder && holder !== by && !input.force) {
    throw new Error(`Cannot release: lease held by ${holder} until ${text(row.call_claim_expires_at)}`);
  }

  ensureRecordColumns({
    db: input.db,
    columns: [
      'call_claim_status',
      'call_claimed_by',
      'call_claimed_at',
      'call_claim_expires_at',
      'call_claim_contact_id',
    ],
  });
  upsertRecord({
    db: input.db,
    row: {
      ...row,
      call_claim_status: 'open',
      call_claimed_by: '',
      call_claimed_at: '',
      call_claim_expires_at: '',
      call_claim_contact_id: '',
    },
  });
  return {
    ok: true,
    record_id: rid,
    released: true,
    reason: active ? (input.force ? 'force_released' : 'owner_released') : 'expired_cleared',
  };
}

/**
 * Expire all stale claimed leases (call_claim_expires_at <= now).
 * Durable clear so eligibility / claim no longer see ghost holders.
 */
export function expireCallBoardLeases(input: {
  db: any;
  nowMs?: number;
  limit?: number;
}): { expired: number; record_ids: string[] } {
  const nowMs = input.nowMs ?? Date.now();
  const limit = Math.max(1, Number(input.limit) || 500);
  const recordIds: string[] = [];

  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = input.db.prepare(`
      SELECT * FROM records
      WHERE lower(COALESCE(call_claim_status, '')) = 'claimed'
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
  } catch {
    return { expired: 0, record_ids: [] };
  }

  ensureRecordColumns({
    db: input.db,
    columns: [
      'call_claim_status',
      'call_claimed_by',
      'call_claimed_at',
      'call_claim_expires_at',
      'call_claim_contact_id',
    ],
  });

  for (const row of rows) {
    if (isClaimLeaseActive(row, nowMs)) continue;
    const rid = text(row._row_id);
    if (!rid) continue;
    upsertRecord({
      db: input.db,
      row: {
        ...row,
        call_claim_status: 'open',
        call_claimed_by: '',
        call_claimed_at: '',
        call_claim_expires_at: '',
        call_claim_contact_id: '',
      },
    });
    recordIds.push(rid);
  }

  return { expired: recordIds.length, record_ids: recordIds };
}

/**
 * True when `operator` may act on the claim (dispose / work the call).
 * Unclaimed or expired → anyone. Active lease → only the owner.
 */
export function isCallLeaseOwner(
  row: Record<string, unknown> | null | undefined,
  operator: string,
  nowMs: number = Date.now(),
): boolean {
  if (!isClaimLeaseActive(row, nowMs)) return true;
  const holder = text(row?.call_claimed_by);
  if (!holder) return true;
  return holder === text(operator);
}

export function disposeCallBoardEntry(input: {
  db: any;
  recordId: string;
  disposition: PhoneCallDisposition | string;
  note?: string;
  /** Operator performing dispose — must own active lease when present. */
  disposedBy?: string;
  force?: boolean;
  /** Explicit callback time for disposition=callback. */
  callbackAt?: string | null;
  phonePolicy?: PhoneAttemptPolicyConfig;
  at?: string;
}): {
  ok: boolean;
  record_id: string;
  disposition: string;
  call_attempt_count: number;
  call_claim_status: string;
  call_window_status: string;
  capacity_unserved: boolean;
  phone_invalidated: boolean;
  callback_at: string | null;
} {
  const rid = String(input.recordId || '').trim();
  // Fail closed on arbitrary disposition strings — only known PhoneCallDisposition values.
  const disposition = assertPhoneCallDisposition(input.disposition);
  const row = input.db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rid) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`Record not found: ${rid}`);
  const now = String(input.at || nowTimestamp());
  const by = String(input.disposedBy || '').trim();
  const claimContactId = text(row.call_claim_contact_id);
  const activeContactId = text(row.active_contact_id || row.contact_id);
  if (
    text(row.call_claim_status).toLowerCase() === 'claimed'
    && claimContactId
    && activeContactId
    && claimContactId !== activeContactId
    && !input.force
  ) {
    throw new Error(
      `Cannot dispose: claim belongs to contact ${claimContactId}, active contact is ${activeContactId}`,
    );
  }

  // Lease owner gate: another operator's unexpired lease blocks dispose.
  if (by && !input.force && !isCallLeaseOwner(row, by)) {
    const holder = text(row.call_claimed_by);
    const until = text(row.call_claim_expires_at) || 'lease active';
    throw new Error(`Cannot dispose: lease held by ${holder} until ${until}`);
  }

  const applied = applyPhoneDisposition({
    record: row,
    disposition,
    note: input.note,
    at: now,
    config: input.phonePolicy,
    callbackAt: input.callbackAt,
  });

  ensureRecordColumns({
    db: input.db,
    columns: [
      'call_claim_status',
      'call_claimed_by',
      'call_claimed_at',
      'call_claim_expires_at',
      'call_disposition',
      'call_disposition_at',
      'call_disposition_note',
      'call_attempt_count',
      'call_window_status',
      'call_callback_at',
      'callback_at',
      'dne_phone',
      'phone_suppressed',
      'phone_status',
      'phone_invalid_reason',
      'call_capacity_unserved',
      'phone_outcome',
      'next_action_json',
      'next_action_date',
      'account_sequence_state',
      'work_state',
      'disposition_latest',
      'disposition_follow_up_at',
    ],
  });
  upsertRecord({
    db: input.db,
    row: applied.patch,
  });

  // Structural wrong_number: also stamp the contacts-table row so eligibility
  // (loadCampaignContactsFromDb / dne_phone) does not re-promote the number.
  if (applied.phone_invalidated) {
    const contactId = text(
      applied.patch.active_contact_id
      || row.active_contact_id
      || row.contact_id
      || '',
    );
    if (contactId) {
      try {
        const cols = new Set(
          (input.db.prepare(`PRAGMA table_info(contacts)`).all() as Array<{ name?: string }>)
            .map((c) => String(c.name || '')),
        );
        const sets: string[] = [];
        const params: Record<string, unknown> = { contact_id: contactId, row_id: rid };
        if (cols.has('dne_phone')) {
          sets.push('dne_phone = 1');
        }
        if (cols.has('phone_status')) {
          sets.push(`phone_status = 'invalid'`);
        }
        if (cols.has('phone')) {
          // Keep phone for audit but mark invalid via dne_phone; do not blank
          // unless column absent would leave a dialable number with no flag.
        }
        if (sets.length > 0) {
          input.db.prepare(
            `UPDATE contacts SET ${sets.join(', ')} WHERE (contact_id = @contact_id OR id = @contact_id) AND row_id = @row_id`,
          ).run(params);
        }
      } catch {
        /* harness without contacts table / columns */
      }
    }
  }

  try {
    insertChannelEvent({
      db: input.db,
      event: {
        id: randomUUID(),
        row_id: rid,
        channel: 'call',
        event_type: 'disposition',
        action: 'call_disposition',
        disposition,
        payload: {
          disposition,
          note: String(input.note || ''),
          disposed_by: by || '',
          call_window_status: applied.call_window_status,
          call_attempt_count: applied.call_attempt_count,
          capacity_unserved: applied.capacity_unserved,
          phone_invalidated: applied.phone_invalidated,
          callback_at: text(applied.patch.call_callback_at) || null,
          next_action: applied.next_action,
          policy_version: applied.policy_version,
        },
        occurred_at: now,
      },
    });
  } catch {
    /* harness without channel_events */
  }

  return {
    ok: true,
    record_id: rid,
    disposition,
    call_attempt_count: applied.call_attempt_count,
    call_claim_status: applied.call_claim_status,
    call_window_status: applied.call_window_status,
    capacity_unserved: applied.capacity_unserved,
    phone_invalidated: applied.phone_invalidated,
    callback_at: text(applied.patch.call_callback_at) || null,
  };
}
