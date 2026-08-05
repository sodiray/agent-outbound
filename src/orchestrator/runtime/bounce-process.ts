/**
 * Production entrypoint: process one provider bounce / DSN event.
 * Durable + idempotent by provider_message_id on channel_events.
 */
import {
  applyEmailBounce,
  detectBounceFromText,
  resolveBounceType,
  type BounceSource,
  type BounceType,
} from '../policy/bounce.js';
import {
  ensureRecordColumns,
  insertChannelEvent,
  upsertRecord,
} from './db.js';

/** True when this provider message id was already recorded as a bounce. */
export function bounceAlreadyRecorded(db: any, providerMessageId: string): boolean {
  const mid = String(providerMessageId || '').trim();
  if (!mid) return false;
  try {
    const row = db.prepare(`
      SELECT 1 AS hit FROM channel_events
      WHERE channel = 'email'
        AND (
          action = 'bounce_detected'
          OR event_type = 'bounced'
          OR disposition IN ('hard', 'soft', 'bounce', 'hard_bounce', 'soft_bounce')
        )
        AND provider_message_id = ?
      LIMIT 1
    `).get(mid);
    return Boolean(row?.hit);
  } catch {
    return false;
  }
}

export type ProcessBounceEventInput = {
  db: any;
  recordId: string;
  /** Provider / DSN message id — required for durable idempotency when present. */
  messageId?: string;
  threadId?: string;
  bounceType?: BounceType | string;
  source?: BounceSource;
  snippet?: string;
  email?: string;
  bounceAt?: string;
  softBounceThreshold?: number;
};

export type ProcessBounceEventResult = {
  record: Record<string, unknown>;
  bounce_type: BounceType;
  sequence_status: string;
  already_applied: boolean;
  hardened_from_soft: boolean;
  channel_event_id: string;
};

/**
 * Apply a provider bounce event to a record and persist.
 * Safe to call twice with the same messageId — second call is a no-op.
 */
export function processBounceEvent(input: ProcessBounceEventInput): ProcessBounceEventResult {
  const recordId = String(input.recordId || '').trim();
  if (!recordId) throw new Error('processBounceEvent: recordId required');

  const record = input.db.prepare('SELECT * FROM records WHERE _row_id = ?').get(recordId) as
    | Record<string, unknown>
    | undefined;
  if (!record) throw new Error(`Record not found: ${recordId}`);

  const messageId = String(input.messageId || '').trim()
    || `bounce_${recordId}_${String(input.bounceAt || Date.now())}`;

  const already = bounceAlreadyRecorded(input.db, messageId);
  if (already) {
    return {
      record,
      bounce_type: (String(record.email_bounce_type || 'hard') === 'soft' ? 'soft' : 'hard'),
      sequence_status: String(record.sequence_status || 'bounced'),
      already_applied: true,
      hardened_from_soft: false,
      channel_event_id: '',
    };
  }

  const applied = applyEmailBounce({
    record,
    bounceType: resolveBounceType({
      bounceType: input.bounceType,
      snippet: input.snippet,
    }),
    source: input.source || 'dsn',
    bounceAt: input.bounceAt,
    messageId,
    threadId: input.threadId,
    email: input.email,
    snippet: input.snippet,
    softBounceThreshold: input.softBounceThreshold,
  });

  ensureRecordColumns({
    db: input.db,
    columns: Object.keys(applied.patch),
  });
  upsertRecord({ db: input.db, row: applied.patch });
  insertChannelEvent({ db: input.db, event: applied.channel_event });

  const next = input.db.prepare('SELECT * FROM records WHERE _row_id = ?').get(recordId) as
    Record<string, unknown>;

  return {
    record: next,
    bounce_type: applied.bounce_type,
    sequence_status: applied.sequence_status,
    already_applied: false,
    hardened_from_soft: applied.hardened_from_soft,
    channel_event_id: applied.channel_event.id,
  };
}

/**
 * If text looks like a DSN/bounce, process as bounce; otherwise return null.
 * Used by inbound-reply process to route mailer-daemon traffic.
 */
export function tryProcessBounceFromText(input: {
  db: any;
  recordId: string;
  text: string;
  messageId?: string;
  threadId?: string;
  source?: BounceSource;
}): ProcessBounceEventResult | null {
  const bounceType = detectBounceFromText(input.text);
  if (!bounceType) return null;
  return processBounceEvent({
    db: input.db,
    recordId: input.recordId,
    messageId: input.messageId,
    threadId: input.threadId,
    bounceType,
    source: input.source || 'dsn',
    snippet: input.text,
  });
}
