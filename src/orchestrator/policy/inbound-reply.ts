/**
 * Production inbound-reply application: classify → persist commercial/lifecycle state.
 * Used by reply polling and validation; business transitions live here, not in tests.
 *
 * Bounce path: classifier-detected inbox bounce and provider DSN events share
 * `applyEmailBounce` (hard/soft typing, contact email suppress, durable flags).
 * Runtime entrypoints: processInboundReplyText / processBounceEvent.
 */
import { randomUUID } from 'node:crypto';
import { NEXT_ACTION_POLICY_VERSION, type LifecycleStage, type SequenceState, type WorkState } from './lifecycle.js';
import { assertLifecycleTransition, canTransitionLifecycle } from './lifecycle.js';
import { applyEmailBounce, resolveBounceType } from './bounce.js';
import { isAffirmativeFlag } from './booleanish.js';

export type InboundReplyClassification =
  | 'objection'
  | 'booking_intent'
  | 'positive_signal'
  | 'question'
  | 'hard_no'
  | 'unsubscribe'
  | 'bounce'
  | 'out_of_office'
  | 'unknown'
  | string;

export type ApplyInboundReplyInput = {
  record: Record<string, unknown>;
  classification: InboundReplyClassification;
  replyAt?: string;
  explicitStop?: boolean;
  snippet?: string;
  messageId?: string;
  threadId?: string;
};

export type ApplyInboundReplyResult = {
  patch: Record<string, unknown>;
  channel_event: {
    id: string;
    row_id: string;
    channel: 'email';
    event_type: 'reply_detected' | 'bounced';
    action: 'reply_detected' | 'bounce_detected';
    disposition: string;
    provider_message_id: string;
    provider_thread_id: string;
    payload: Record<string, unknown>;
    occurred_at: string;
  };
  sequence_status: string;
  lifecycle_stage: string;
  account_sequence_state: string;
};

const coerceLifecycle = (raw: unknown): LifecycleStage => {
  const v = String(raw || 'contacted').trim() as LifecycleStage;
  return v || 'contacted';
};

/** Map classifier + stop intent to sequence_status (legacy polling contract). */
export function sequenceStatusForReply(classification: string, explicitStop: boolean): string {
  if (explicitStop) return 'opted_out';
  if (classification === 'unsubscribe') return 'opted_out';
  if (
    classification === 'booking_intent'
    || classification === 'positive_signal'
    || classification === 'question'
    || classification === 'objection'
  ) {
    return 'engaged';
  }
  if (classification === 'bounce') return 'bounced';
  if (classification === 'hard_no') return 'completed';
  return 'active';
}

function transitionLifecycle(from: LifecycleStage, to: LifecycleStage, reason: string): LifecycleStage {
  if (from === to) return from;
  if (!canTransitionLifecycle(from, to)) {
    // Prefer multi-hop when direct edge missing (e.g. contacted → meeting_booked via replied).
    if (canTransitionLifecycle(from, 'replied') && canTransitionLifecycle('replied', to)) {
      assertLifecycleTransition(from, 'replied', { reason });
      assertLifecycleTransition('replied', to, { reason });
      return to;
    }
    if (canTransitionLifecycle(from, 'engaged') && canTransitionLifecycle('engaged', to)) {
      assertLifecycleTransition(from, 'engaged', { reason });
      assertLifecycleTransition('engaged', to, { reason });
      return to;
    }
    throw new Error(`Prohibited lifecycle transition ${from} -> ${to} for ${reason}`);
  }
  assertLifecycleTransition(from, to, { reason });
  return to;
}

/**
 * Apply a classified inbound reply to an account record.
 * Produces the full persistence patch + channel event envelope.
 */
export function applyInboundReplyClassification(input: ApplyInboundReplyInput): ApplyInboundReplyResult {
  const record = input.record || {};
  const recordId = String(record._row_id || record.id || '').trim();
  if (!recordId) throw new Error('applyInboundReplyClassification: record id required');

  const classification = String(input.classification || 'unknown').trim() || 'unknown';
  const explicitStop = Boolean(input.explicitStop);
  const replyAt = String(input.replyAt || new Date().toISOString());
  const sequence_status = sequenceStatusForReply(classification, explicitStop);

  let lifecycle_stage = coerceLifecycle(record.lifecycle_stage);
  let account_sequence_state: SequenceState = String(record.account_sequence_state || 'active').trim() as SequenceState || 'active';
  let work_state: WorkState = String(record.work_state || 'executing_external_action').trim() as WorkState || 'executing_external_action';
  let disposition_latest = String(record.disposition_latest || '');
  let disposition_follow_up_at = String(record.disposition_follow_up_at || '');
  let meeting_booked_at = String(record.meeting_booked_at || '');
  let next_action_json = record.next_action_json;
  let suppressed = Number(isAffirmativeFlag(record.suppressed, { failClosed: true }));
  let suppressed_reason = String(record.suppressed_reason || '');
  let suppressed_at = String(record.suppressed_at || '');

  const reason = `inbound_reply:${classification}`;

  // Pause-first invariant: never auto-mark lost / meeting_booked from model
  // classification before human review. Only explicit legal opt-out (unsubscribe
  // / explicitStop) may terminate without review. Bounce stays structural.
  // Proposed classification is stored for the reply queue; humans confirm terminal
  // outcomes via operator disposition.

  if (explicitStop || classification === 'unsubscribe') {
    // Legal stop — required auto-suppress, still terminal.
    lifecycle_stage = transitionLifecycle(lifecycle_stage, 'lost', reason);
    account_sequence_state = 'completed';
    work_state = 'terminal_recordkeeping';
    suppressed = 1;
    suppressed_reason = 'opt_out';
    suppressed_at = replyAt;
    next_action_json = JSON.stringify({
      action_id: `na_term_optout_${recordId}`,
      action_type: 'terminal_recordkeeping',
      account_id: recordId,
      lifecycle_stage: 'lost',
      sequence_state: 'completed',
      work_state: 'terminal_recordkeeping',
      reason: 'opt_out',
      on_success: 'stop',
      policy_version: NEXT_ACTION_POLICY_VERSION,
    });
  } else if (classification === 'bounce') {
    // Structural channel invalidation — delegated to applyEmailBounce below.
    disposition_latest = 'bounce';
  } else if (
    classification === 'hard_no'
    || classification === 'objection'
    || classification === 'booking_intent'
    || classification === 'positive_signal'
    || classification === 'question'
    || classification === 'unknown'
  ) {
    // Pause outreach first. Keep lifecycle at replied (not lost / meeting_booked)
    // until a human confirms. Persist proposed classification for reply queue.
    try {
      lifecycle_stage = transitionLifecycle(lifecycle_stage, 'replied', reason);
    } catch {
      // Already terminal / replied — keep current stage, still pause sequence.
      lifecycle_stage = coerceLifecycle(record.lifecycle_stage);
    }
    account_sequence_state = 'paused_inbound';
    work_state = 'human_commercial_followup';
    disposition_latest = classification === 'hard_no'
      ? 'hard_no_pending_review'
      : classification === 'booking_intent'
        ? 'booking_intent_pending_review'
        : classification === 'objection'
          ? 'callback_requested'
          : classification;
    if (classification === 'objection') {
      disposition_follow_up_at = new Date(new Date(replyAt).getTime() + 3 * 86400000).toISOString();
    }
    // Do NOT set meeting_booked_at automatically — human confirms.
    next_action_json = JSON.stringify({
      action_id: `na_inb_review_${recordId}`,
      action_type: 'human_inbound_review',
      account_id: recordId,
      lifecycle_stage,
      sequence_state: 'paused_inbound',
      work_state: 'human_commercial_followup',
      reason: `inbound_pause_first:${classification}`,
      on_success: 'human_confirm',
      proposed_classification: classification,
      policy_version: NEXT_ACTION_POLICY_VERSION,
    });
  }

  // Bounce: shared durable path (hard/soft, contact email suppress, sequence terminal).
  // Not full-account DNC (suppressed=1 reserved for opt-out / hard_no / manual).
  if (classification === 'bounce') {
    const bounce = applyEmailBounce({
      record,
      bounceType: resolveBounceType({
        classification: 'bounce',
        snippet: input.snippet,
      }),
      source: 'classifier',
      bounceAt: replyAt,
      messageId: input.messageId,
      threadId: input.threadId,
      snippet: input.snippet,
    });
    // Merge commercial reply cursor fields onto bounce patch.
    const patch: Record<string, unknown> = {
      ...bounce.patch,
      email_last_reply_at: replyAt,
      email_reply_classification: classification,
      reply_classification_latest: classification,
      suppressed,
      suppressed_reason,
      suppressed_at,
      meeting_booked_at,
      disposition_follow_up_at,
    };
    return {
      patch,
      channel_event: {
        id: bounce.channel_event.id,
        row_id: bounce.channel_event.row_id,
        channel: 'email' as const,
        event_type: 'bounced' as const,
        action: 'bounce_detected' as const,
        disposition: bounce.bounce_type,
        provider_message_id: bounce.channel_event.provider_message_id,
        provider_thread_id: bounce.channel_event.provider_thread_id,
        payload: {
          ...bounce.channel_event.payload,
          classification: 'bounce',
          explicit_stop: explicitStop,
          source: 'inbound_reply_handler',
          snippet: String(input.snippet || ''),
        },
        occurred_at: replyAt,
      },
      sequence_status: bounce.sequence_status,
      lifecycle_stage: String(patch.lifecycle_stage || lifecycle_stage),
      account_sequence_state: String(patch.account_sequence_state || account_sequence_state),
    };
  }

  let email_bounced = Number(isAffirmativeFlag(record.email_bounced, { failClosed: true }));
  let email_status = String(record.email_status || '');
  let dne_email = Number(isAffirmativeFlag(record.dne_email, { failClosed: true }));
  let suppressed_contact_ids: string[] = Array.isArray(record.suppressed_contact_ids)
    ? [...(record.suppressed_contact_ids as string[])]
    : (() => {
      try {
        const parsed = JSON.parse(String(record.suppressed_contact_ids_json || '[]'));
        return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
      } catch {
        return [];
      }
    })();
  let email_bounce_type = String(record.email_bounce_type || '');

  const patch: Record<string, unknown> = {
    ...record,
    email_last_reply_at: replyAt,
    email_reply_classification: classification,
    reply_classification_latest: classification,
    // Proposed (not confirmed) classification for reply queue / human review.
    inbound_proposed_classification: (
      explicitStop || classification === 'unsubscribe' || classification === 'bounce'
    )
      ? ''
      : classification,
    inbound_pending_human_review: (
      explicitStop || classification === 'unsubscribe' || classification === 'bounce'
    )
      ? 0
      : 1,
    sequence_status,
    next_action_date: sequence_status === 'active' ? record.next_action_date : '',
    lifecycle_stage,
    account_sequence_state,
    work_state,
    disposition_latest,
    disposition_follow_up_at,
    meeting_booked_at,
    next_action_json,
    suppressed,
    suppressed_reason,
    suppressed_at,
    email_bounced,
    email_status,
    email_bounce_type,
    dne_email,
    suppressed_contact_ids,
    suppressed_contact_ids_json: JSON.stringify(suppressed_contact_ids),
  };

  const channel_event = {
    id: randomUUID(),
    row_id: recordId,
    channel: 'email' as const,
    event_type: 'reply_detected' as const,
    action: 'reply_detected' as const,
    disposition: classification,
    provider_message_id: String(input.messageId || `msg_${randomUUID().slice(0, 8)}`),
    provider_thread_id: String(input.threadId || record.email_thread_id || record.email_last_thread_id || ''),
    payload: {
      snippet: String(input.snippet || ''),
      classification,
      proposed_only: !(explicitStop || classification === 'unsubscribe'),
      explicit_stop: explicitStop,
      source: 'inbound_reply_handler',
      pause_first: true,
    },
    occurred_at: replyAt,
  };

  return {
    patch,
    channel_event,
    sequence_status,
    lifecycle_stage,
    account_sequence_state,
  };
}
