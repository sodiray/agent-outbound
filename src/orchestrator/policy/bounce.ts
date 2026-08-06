/**
 * Email bounce / DSN handling.
 *
 * Provider bounce events (DSN, SMTP bounce reports, webhook) and classifier-
 * detected inbox bounces share one durable path:
 *   - mark email channel not ready (email_bounced / email_status)
 *   - hard vs soft typing
 *   - soft-suppress contact email path (dne_email + suppressed_contact_ids)
 *   - hard: terminal sequence_status=bounced (channel-level, not full-account DNC)
 *   - soft: increment soft_bounce_count; harden after threshold
 *
 * Idempotency is by provider_message_id (or synthetic key) — reprocessing the
 * same DSN must not double-count soft bounces or invent a second terminal.
 */

import { randomUUID } from 'node:crypto';
import { NEXT_ACTION_POLICY_VERSION } from './lifecycle.js';

export type BounceType = 'hard' | 'soft';
export type BounceSource =
  | 'classifier'
  | 'dsn'
  | 'smtp'
  | 'provider_webhook'
  | 'manual';

export type ApplyEmailBounceInput = {
  record: Record<string, unknown>;
  bounceType?: BounceType;
  source?: BounceSource;
  bounceAt?: string;
  messageId?: string;
  threadId?: string;
  email?: string;
  contactId?: string;
  snippet?: string;
  /** Soft bounces at or above this count harden (default 3). */
  softBounceThreshold?: number;
  /**
   * When true, a second application of the same messageId is a no-op (caller
   * already checked channel_events). Pure policy layer still returns a full
   * patch for first application; use `alreadyBouncedSameMessage` for pure checks.
   */
  alreadyApplied?: boolean;
};

export type BounceChannelEvent = {
  id: string;
  row_id: string;
  channel: 'email';
  event_type: 'bounced';
  action: 'bounce_detected';
  disposition: string;
  provider_message_id: string;
  provider_thread_id: string;
  payload: Record<string, unknown>;
  occurred_at: string;
};

export type ApplyEmailBounceResult = {
  patch: Record<string, unknown>;
  channel_event: BounceChannelEvent;
  bounce_type: BounceType;
  sequence_status: string;
  /** True when input.alreadyApplied — patch is identity, event still formed for tracing. */
  already_applied: boolean;
  hardened_from_soft: boolean;
};

/** Default soft-bounce count before treating as hard suppress. */
export const SOFT_BOUNCE_HARDEN_THRESHOLD = 3;

/**
 * Detect bounce/DSN patterns in free text (inbox mailer-daemon, SMTP DSN body).
 * Returns hard | soft | null (not a bounce signal).
 */
export function detectBounceFromText(text: string): BounceType | null {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return null;

  const hardMarkers = [
    'user unknown',
    'mailbox not found',
    'no such user',
    'recipient rejected',
    'address rejected',
    'does not exist',
    'invalid recipient',
    'unknown user',
    '5.1.1',
    '5.1.2',
    '5.4.1',
    'permanent failure',
    'permanent error',
    'undeliverable',
    'delivery permanently failed',
  ];
  const softMarkers = [
    'mailbox full',
    'over quota',
    'try again later',
    'temporary failure',
    'temporarily deferred',
    '4.2.2',
    '4.4.1',
    '4.7.1',
    'greylisted',
    'out of office', // not a bounce — handled below as null after check order
  ];
  const genericBounce = [
    'mailer-daemon',
    'mail delivery failed',
    'delivery status notification',
    'returned mail',
    'undelivered mail returned',
    'failure notice',
    'delivery failure',
    'message not delivered',
    'dsn',
  ];

  // OOO is not a bounce.
  if (
    t.includes('out of office')
    || t.includes('automatic reply')
    || t.includes('auto-reply')
    || t.includes('autoreply')
  ) {
    // Only null if no hard bounce markers also present.
    if (!hardMarkers.some((m) => t.includes(m)) && !genericBounce.some((m) => t.includes(m))) {
      return null;
    }
  }

  if (hardMarkers.some((m) => t.includes(m))) return 'hard';
  if (softMarkers.some((m) => t.includes(m))) return 'soft';
  if (genericBounce.some((m) => t.includes(m))) return 'hard'; // unknown DSN → fail closed hard
  if (t.includes('bounce') || t.includes('bounced')) return 'hard';
  return null;
}

/**
 * Prefer structured bounce type; fall back to text detection; default hard for
 * explicit bounce classification without typing.
 */
export function resolveBounceType(input: {
  bounceType?: BounceType | string | null;
  snippet?: string;
  classification?: string;
}): BounceType {
  const explicit = String(input.bounceType || '').trim().toLowerCase();
  if (explicit === 'hard' || explicit === 'soft') return explicit;

  const fromText = detectBounceFromText(input.snippet || '');
  if (fromText) return fromText;

  if (String(input.classification || '').trim().toLowerCase() === 'bounce') {
    return 'hard';
  }
  return 'hard';
}

function parseSuppressedContactIds(record: Record<string, unknown>): string[] {
  if (Array.isArray(record.suppressed_contact_ids)) {
    return (record.suppressed_contact_ids as unknown[]).map((v) => String(v));
  }
  try {
    const parsed = JSON.parse(String(record.suppressed_contact_ids_json || '[]'));
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

/**
 * Apply a bounce to an account record (pure policy).
 * Soft-suppresses email channel/contact path only — does not set account-wide
 * suppressed=1 (full DNC is opt-out / hard_no / manual).
 */
export function applyEmailBounce(input: ApplyEmailBounceInput): ApplyEmailBounceResult {
  const record = input.record || {};
  const recordId = String(record._row_id || record.id || '').trim();
  if (!recordId) throw new Error('applyEmailBounce: record id required');

  const bounceAt = String(input.bounceAt || new Date().toISOString());
  const messageId = String(input.messageId || `bounce_${randomUUID().slice(0, 12)}`).trim();
  const threadId = String(
    input.threadId || record.email_thread_id || record.email_last_thread_id || '',
  ).trim();
  const source: BounceSource = input.source || 'dsn';
  const threshold = Math.max(
    1,
    Number(input.softBounceThreshold) || SOFT_BOUNCE_HARDEN_THRESHOLD,
  );

  if (input.alreadyApplied) {
    return {
      patch: { ...record },
      channel_event: {
        id: randomUUID(),
        row_id: recordId,
        channel: 'email',
        event_type: 'bounced',
        action: 'bounce_detected',
        disposition: String(record.email_bounce_type || 'hard'),
        provider_message_id: messageId,
        provider_thread_id: threadId,
        payload: {
          source,
          already_applied: true,
          snippet: String(input.snippet || ''),
        },
        occurred_at: bounceAt,
      },
      bounce_type: (String(record.email_bounce_type || 'hard') === 'soft' ? 'soft' : 'hard'),
      sequence_status: String(record.sequence_status || 'bounced'),
      already_applied: true,
      hardened_from_soft: false,
    };
  }

  let bounceType = resolveBounceType({
    bounceType: input.bounceType,
    snippet: input.snippet,
  });

  let softCount = Math.max(0, Number(record.email_soft_bounce_count) || 0);
  let hardened_from_soft = false;

  if (bounceType === 'soft') {
    softCount += 1;
    if (softCount >= threshold) {
      bounceType = 'hard';
      hardened_from_soft = true;
    }
  }

  const isHard = bounceType === 'hard';

  // Contact email path soft-suppress (always for hard; for soft after harden only...
  // Actually: soft also sets dne_email so we don't immediately re-send; readiness
  // treats email_bounced as not ready either way).
  let suppressed_contact_ids = parseSuppressedContactIds(record);
  const contactId = String(
    input.contactId || record.active_contact_id || record.contact_id || record.primary_contact_id || '',
  ).trim();
  if (contactId && !suppressed_contact_ids.includes(contactId)) {
    suppressed_contact_ids = [...suppressed_contact_ids, contactId];
  }

  const emailAddress = String(
    input.email || record.contact_email || record.email_primary || '',
  ).trim().toLowerCase();

  const nextAction = JSON.stringify({
    action_id: `na_term_bounce_${recordId}`,
    action_type: 'terminal_recordkeeping',
    account_id: recordId,
    lifecycle_stage: String(record.lifecycle_stage || 'contacted'),
    sequence_state: isHard ? 'completed' : String(record.account_sequence_state || 'active'),
    work_state: isHard ? 'terminal_recordkeeping' : 'channel_repair',
    reason: isHard ? 'hard_bounce' : 'soft_bounce',
    on_success: isHard ? 'stop' : 'retry_or_repair',
    policy_version: NEXT_ACTION_POLICY_VERSION,
  });

  const patch: Record<string, unknown> = {
    ...record,
    email_bounced: 1,
    email_status: 'bounced',
    email_bounce_type: bounceType,
    email_bounce_at: bounceAt,
    email_bounce_source: source,
    email_soft_bounce_count: softCount,
    email_last_bounce_message_id: messageId,
    dne_email: 1,
    suppressed_contact_ids,
    suppressed_contact_ids_json: JSON.stringify(suppressed_contact_ids),
    disposition_latest: isHard ? 'hard_bounce' : 'soft_bounce',
    // Soft: leave sequence runnable on other channels; hard: bounce terminal.
    sequence_status: isHard ? 'bounced' : String(record.sequence_status || 'active'),
    account_sequence_state: isHard
      ? 'completed'
      : String(record.account_sequence_state || 'active'),
    work_state: isHard ? 'terminal_recordkeeping' : 'channel_repair',
    next_action_json: nextAction,
    next_action_date: isHard ? '' : record.next_action_date,
  };

  if (emailAddress) {
    patch.email_bounced_address = emailAddress;
  }

  // Hard bounce does not set suppressed=1 (account DNC) — only email channel flags.
  // Optional future: global suppression list write lives in process layer.

  const channel_event: BounceChannelEvent = {
    id: randomUUID(),
    row_id: recordId,
    channel: 'email',
    event_type: 'bounced',
    action: 'bounce_detected',
    disposition: bounceType,
    provider_message_id: messageId,
    provider_thread_id: threadId,
    payload: {
      source,
      bounce_type: bounceType,
      soft_bounce_count: softCount,
      hardened_from_soft,
      email: emailAddress,
      snippet: String(input.snippet || '').slice(0, 2000),
      threshold,
    },
    occurred_at: bounceAt,
  };

  return {
    patch,
    channel_event,
    bounce_type: bounceType,
    sequence_status: String(patch.sequence_status),
    already_applied: false,
    hardened_from_soft,
  };
}
