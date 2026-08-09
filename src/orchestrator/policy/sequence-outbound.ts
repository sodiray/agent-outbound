/**
 * Sequencer gate: whether a record may auto-execute an outbound sequence step
 * given account_sequence_state and next_action_json (not only sequence_step integers).
 *
 * Channel independence (RES-CAMPAIGN-ORCHESTRATION):
 * - Phone park / next_action=phone is optional capacity for Tier A/B.
 * - It must NOT block independent channels (mail, email, linkedin) when those
 *   steps are otherwise due — TV mail depends_on email_2, not phone_1.
 * - Sequence pause/cancel/inbound still blocks every channel.
 */

import { parseNextActionFromRecord, type SequenceState } from './lifecycle.js';
import { isAffirmativeFlag } from './booleanish.js';
import { isActionDueOnDate, toZonedIsoDate } from '../lib/working-days.js';
import { nowIso } from '../lib/record.js';

/** Sequence states that must never auto-execute outbound. */
export const SEQUENCE_STATES_BLOCK_OUTBOUND = new Set<SequenceState | string>([
  'paused_review',
  'paused_inbound',
  'paused_repair',
  'unreachable',
  'recycle_wait',
  'completed',
  'cancelled',
]);

/** next_action types that mean "do outbound / prepare for outbound". */
export const OUTBOUND_ACTION_TYPES = new Set([
  'send_email',
  'prepare_outbound',
  'send_mail',
  'send_sms',
  'send_postcard',
  'linkedin_connect',
  'execute_outbound',
  'outbound_send',
  'manual_task_outbound',
]);

/**
 * Parallel / optional-capacity channel work. These keep the account in play but
 * do not monopolize the sequencer: mail (and other independent channels) may
 * still park/send when the next_action is phone capacity work.
 */
export const PARALLEL_CHANNEL_ACTION_TYPES = new Set([
  'human_phone',
  'phone_call',
  'phone',
  'call',
  'claim_call',
  'manual_task',
  'manual_phone',
  'awaiting_manual_phone',
]);

/** next_action types that are waits (may unlock when due_at has passed). */
export const WAIT_ACTION_TYPES = new Set([
  'wait',
  'await_time',
  'wait_time_or_event',
]);

/** Non-outbound work: never auto-send from the sequencer. */
export const NON_OUTBOUND_ACTION_TYPES = new Set([
  'foundational_enrichment',
  'enrichment_repair',
  'reentry_evaluation',
  'terminal_recordkeeping',
  'recycle_monitor',
  'await_reply_or_recycle',
  'identity_contact_resolution',
  'content_generation',
  'pending_human_review',
  'human_review_repair',
  'channel_repair',
  'human_commercial_followup',
  'meeting_prep_or_completion',
  'contact_rotation',
]);

export type SequenceOutboundChannel =
  | 'email'
  | 'phone'
  | 'linkedin'
  | 'mail'
  | 'sms'
  | 'manual'
  | string;

export type SequenceOutboundDecision = {
  /** True when the sequencer may run the normal outbound sequence path. */
  execute: boolean;
  reason: string;
  action_type?: string | null;
  sequence_state?: string | null;
  /** True when the decision is channel-scoped (phone work vs independent mail). */
  channel_independent?: boolean;
};

export type SequenceOutboundOptions = {
  /**
   * Named channel of the action about to run. When next_action is phone capacity
   * work, non-phone channels (mail / email / linkedin) remain allowed.
   * Omit for record-level filter (collectDueRecords) — phone next_action still
   * keeps the account in play so independent steps can be selected.
   */
  channel?: SequenceOutboundChannel | null;
  stepKind?: string | null;
  taskType?: string | null;
  /** Pipeline-local date for date-only waits. Takes precedence over instant conversion. */
  today?: string | null;
  /** Pipeline timezone for date-only waits when no logical date is supplied. */
  timeZone?: string | null;
};

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isDueAtOrBefore = (
  dueRaw: string | null | undefined,
  now: string | Date,
  options?: SequenceOutboundOptions | null,
): boolean => {
  const due = String(dueRaw || '').trim();
  if (!due) return true; // no explicit due → defer timing to next_action_date / resolveDueStep
  if (ISO_DATE_PATTERN.test(due)) {
    const today = String(options?.today || '').trim()
      || toZonedIsoDate(now, String(options?.timeZone || '').trim() || undefined);
    return isActionDueOnDate({ nextActionDate: due, today });
  }
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const dueMs = Date.parse(due.includes('T') || due.includes(' ') ? due : `${due}T00:00:00.000Z`);
  if (Number.isNaN(nowMs) || Number.isNaN(dueMs)) {
    // Lexicographic fallback for ISO / YYYY-MM-DD strings
    const nowStr = now instanceof Date ? now.toISOString() : String(now);
    return due <= nowStr;
  }
  return dueMs <= nowMs;
};

/** Normalize channel/step hints into a coarse channel token. */
export function resolveOutboundChannelHint(opts?: SequenceOutboundOptions | null): string {
  if (!opts) return '';
  const values = [
    opts.channel,
    opts.taskType,
    opts.stepKind,
  ]
    .map((x) => String(x || '').trim().toLowerCase())
    .filter(Boolean);
  const channels: Record<string, string> = {
    email: 'email',
    send_email: 'email',
    linkedin: 'linkedin',
    linkedin_connect: 'linkedin',
    mail: 'mail',
    send_mail: 'mail',
    sms: 'sms',
    send_sms: 'sms',
    phone: 'phone',
    phone_call: 'phone',
    human_phone: 'phone',
    manual: 'manual',
    manual_task: 'manual',
  };
  return values.map((value) => channels[value] || '').find(Boolean) || values[0] || '';
}

/** True when action_type / work_state indicates phone capacity work. */
export function isPhoneCapacityActionType(actionType: string | null | undefined, workState?: string | null): boolean {
  const a = String(actionType || '').trim().toLowerCase();
  const w = String(workState || '').trim().toLowerCase();
  if (!a && !w) return false;
  if (PARALLEL_CHANNEL_ACTION_TYPES.has(a)) {
    // generic manual_task is phone capacity only when work_state / type says phone
    if (a === 'manual_task') {
      return w.includes('phone') || w.includes('call') || !w;
    }
    return true;
  }
  if (a.includes('phone') || a.includes('call')) return true;
  if (w.includes('phone') || w.includes('human_phone')) return true;
  return false;
}

/**
 * True when a sequence step is optional phone capacity (human_phone manual park).
 * Used by the sequencer to advance the cursor past an open phone park so
 * independent mail (depends_on without phone) can run.
 */
export function isOptionalPhoneCapacityStep(step: {
  kind?: unknown;
  id?: unknown;
  config?: Record<string, unknown> | null;
} | null | undefined): boolean {
  if (!step) return false;
  const kind = String(step.kind || '').trim().toLowerCase();
  const id = String(step.id || '').trim().toLowerCase();
  const cfg = step.config && typeof step.config === 'object' ? step.config : {};
  const task = String(cfg.task_type || cfg.taskType || '').trim().toLowerCase();
  const channel = String(cfg.channel || '').trim().toLowerCase();
  if (kind !== 'manual_task' && kind !== 'human_phone') {
    // Still treat phone-ish ids as capacity when kind is missing in fixtures
    if (!(id.includes('phone') || id.includes('call'))) return false;
  }
  return (
    task === 'human_phone'
    || task.includes('phone')
    || channel === 'phone'
    || channel === 'call'
    || id.includes('phone')
    || (id.includes('call') && !id.includes('callback'))
  );
}

/**
 * True when no later step declares a hard depends_on on the given step id —
 * phone is then safe to leave parked while the cursor advances to independent work.
 */
export function laterStepsDependOn(
  steps: Array<{ id?: unknown; depends_on?: unknown; runs_after?: unknown }>,
  stepId: string,
): boolean {
  const target = String(stepId || '').trim();
  if (!target) return false;
  const idx = steps.findIndex((s) => String(s?.id || '').trim() === target);
  if (idx < 0) return false;
  for (let i = idx + 1; i < steps.length; i += 1) {
    const s = steps[i];
    const deps = [
      ...(Array.isArray(s?.depends_on) ? s.depends_on : []),
      ...(Array.isArray(s?.runs_after) ? s.runs_after : []),
    ].map((d) => String(d || '').trim());
    if (deps.includes(target)) return true;
  }
  return false;
}

/**
 * Pure helper: should the sequencer / executeChannelStep auto-execute outbound
 * for this record (optionally for a specific channel)?
 *
 * - Blocks paused / recycle_wait / completed / cancelled sequence states (all channels)
 * - Respects next_action_json.action_type (wait/reentry/enrichment/terminal vs outbound)
 * - Phone capacity next_action does NOT block mail / email / linkedin (channel independence)
 * - For wait actions, allows only when due_at is empty or has passed (else skip)
 * - Missing / unparseable next_action_json → allow (legacy records use sequence_step only)
 */
export function shouldExecuteSequenceOutbound(
  record: Record<string, unknown> | null | undefined,
  now: string | Date = nowIso(),
  options?: SequenceOutboundOptions | null,
): SequenceOutboundDecision {
  const row = record || {};
  const sequence_state = String(row.account_sequence_state || '').trim() || null;
  const channelHint = resolveOutboundChannelHint(options);

  if (String(row.disqualified_at || '').trim() || String(row.lifecycle_stage || '').trim().toLowerCase() === 'disqualified') {
    return {
      execute: false,
      reason: 'record_disqualified',
      sequence_state,
      action_type: null,
    };
  }

  if (isAffirmativeFlag(row.suppressed, { failClosed: true })) {
    return {
      execute: false,
      reason: 'record_suppressed',
      sequence_state,
      action_type: null,
    };
  }

  if (sequence_state && SEQUENCE_STATES_BLOCK_OUTBOUND.has(sequence_state)) {
    return {
      execute: false,
      reason: `sequence_state_${sequence_state}`,
      sequence_state,
      action_type: null,
    };
  }

  const next = parseNextActionFromRecord(row);
  if (!next) {
    return {
      execute: true,
      reason: 'no_next_action_json',
      sequence_state,
      action_type: null,
    };
  }

  const action_type = String(next.action_type || '').trim().toLowerCase();
  if (!action_type) {
    return {
      execute: true,
      reason: 'next_action_missing_type',
      sequence_state,
      action_type: '',
    };
  }

  if (OUTBOUND_ACTION_TYPES.has(action_type) || action_type.startsWith('send_')) {
    return {
      execute: true,
      reason: 'outbound_action',
      sequence_state,
      action_type,
    };
  }

  // Phone / manual capacity work: keep account in play; never monopolize other channels.
  if (isPhoneCapacityActionType(action_type, next.work_state)) {
    // Record-level filter (no channel): allow so sequencer can select mail/phone steps.
    if (!channelHint || channelHint === 'phone' || channelHint === 'manual' || channelHint === 'call') {
      return {
        execute: true,
        reason: 'parallel_phone_capacity',
        sequence_state,
        action_type,
        channel_independent: true,
      };
    }
    // Independent channels (mail / email / linkedin) proceed while phone is parked.
    if (channelHint === 'mail' || channelHint === 'email' || channelHint === 'linkedin') {
      return {
        execute: true,
        reason: 'phone_does_not_block_independent_channel',
        sequence_state,
        action_type,
        channel_independent: true,
      };
    }
    // Unknown channel alongside phone work — allow rather than invent a hard block.
    return {
      execute: true,
      reason: 'parallel_phone_capacity',
      sequence_state,
      action_type,
      channel_independent: true,
    };
  }

  // Generic parallel channel actions (e.g. mail manual_task next_action)
  if (PARALLEL_CHANNEL_ACTION_TYPES.has(action_type)) {
    return {
      execute: true,
      reason: 'parallel_channel_action',
      sequence_state,
      action_type,
      channel_independent: true,
    };
  }

  if (WAIT_ACTION_TYPES.has(action_type)) {
    const dueHint = next.due_at || row.next_action_date || null;
    if (!isDueAtOrBefore(dueHint != null ? String(dueHint) : null, now, options)) {
      return {
        execute: false,
        reason: 'wait_not_due',
        sequence_state,
        action_type,
      };
    }
    // Wait elapsed (or no due_at): allow sequence path so the next step can run.
    return {
      execute: true,
      reason: 'wait_due',
      sequence_state,
      action_type,
    };
  }

  if (
    NON_OUTBOUND_ACTION_TYPES.has(action_type)
    || action_type.startsWith('terminal')
    || action_type.startsWith('reentry')
    || action_type.includes('enrichment')
  ) {
    return {
      execute: false,
      reason: `non_outbound_action_${action_type}`,
      sequence_state,
      action_type,
    };
  }

  // Unknown action types: do not invent outbound permission.
  return {
    execute: false,
    reason: `unknown_action_type_${action_type}`,
    sequence_state,
    action_type,
  };
}

/**
 * Filter records the sequencer may consider for outbound execution.
 * Pure; does not touch the DB. Phone capacity next_action keeps the row in play.
 */
export function filterRecordsForSequenceOutbound<T extends Record<string, unknown>>(
  records: T[] | null | undefined,
  now: string | Date = nowIso(),
): T[] {
  return (records || []).filter((record) => shouldExecuteSequenceOutbound(record, now).execute);
}
