/**
 * Production entrypoint: process one inbound reply text against a record.
 * Classifies (with keyword fallback when no model), applies commercial lifecycle, persists.
 *
 * DSN / mailer-daemon bodies are routed through processBounceEvent (durable,
 * idempotent by messageId) before the general reply classifier.
 */
import { classifyReplyAction } from '../actions/classify-reply/index.js';
import { applyInboundReplyClassification } from '../policy/inbound-reply.js';
import { detectBounceFromText } from '../policy/bounce.js';
import { ensureRecordColumns, insertChannelEvent, upsertRecord } from './db.js';
import { processBounceEvent } from './bounce-process.js';

const hasExplicitStopIntent = (text: string) => {
  const normalized = String(text || '').toLowerCase();
  if (!normalized.trim()) return false;
  return normalized.includes(' stop ')
    || normalized.includes('unsubscribe')
    || normalized.includes('do not contact')
    || normalized.includes('remove me');
};

export async function processInboundReplyText(input: {
  db: any;
  recordId: string;
  replyText: string;
  messageId?: string;
  threadId?: string;
  model?: string;
  aiConfig?: Record<string, unknown>;
}): Promise<{
  classification: string;
  record: Record<string, unknown>;
  sequence_status: string;
  lifecycle_stage: string;
  account_sequence_state: string;
}> {
  const recordId = String(input.recordId || '').trim();
  const record = input.db.prepare('SELECT * FROM records WHERE _row_id = ?').get(recordId);
  if (!record) throw new Error(`Record not found: ${recordId}`);

  const replyText = String(input.replyText || '');

  // Provider bounce DSN path: durable + idempotent before classifier spend.
  const dsnType = detectBounceFromText(replyText);
  if (dsnType) {
    const bounced = processBounceEvent({
      db: input.db,
      recordId,
      messageId: input.messageId,
      threadId: input.threadId,
      bounceType: dsnType,
      source: 'dsn',
      snippet: replyText,
    });
    return {
      classification: 'bounce',
      record: bounced.record,
      sequence_status: bounced.sequence_status,
      lifecycle_stage: String(bounced.record.lifecycle_stage || ''),
      account_sequence_state: String(bounced.record.account_sequence_state || ''),
    };
  }

  // Pause-first: persist outbound stop BEFORE model classification latency so
  // another worker cannot send while the classifier is running.
  const pauseAt = new Date().toISOString();
  const prePause = {
    ...record,
    account_sequence_state: 'paused_inbound',
    work_state: 'human_commercial_followup',
    inbound_pending_human_review: 1,
    inbound_classification_in_flight: 1,
    inbound_pause_at: pauseAt,
    email_last_reply_at: pauseAt,
  };
  ensureRecordColumns({
    db: input.db,
    columns: [
      'account_sequence_state',
      'work_state',
      'inbound_pending_human_review',
      'inbound_classification_in_flight',
      'inbound_pause_at',
      'email_last_reply_at',
    ],
  });
  upsertRecord({ db: input.db, row: prePause });

  const classified = await classifyReplyAction({
    replyText,
    model: input.model || '',
    aiConfig: input.aiConfig || {},
  });
  const classification = String(classified.classification || 'unknown');
  if (classification === 'bounce') {
    const bounced = processBounceEvent({
      db: input.db,
      recordId,
      messageId: input.messageId,
      threadId: input.threadId,
      source: 'classifier',
      snippet: replyText,
    });
    return {
      classification,
      record: bounced.record,
      sequence_status: bounced.sequence_status,
      lifecycle_stage: String(bounced.record.lifecycle_stage || ''),
      account_sequence_state: String(bounced.record.account_sequence_state || ''),
    };
  }
  const explicitStop = hasExplicitStopIntent(` ${replyText} `);
  // Re-read after pause so apply sees paused_inbound baseline.
  const pausedRecord = input.db.prepare('SELECT * FROM records WHERE _row_id = ?').get(recordId) || prePause;
  const applied = applyInboundReplyClassification({
    record: pausedRecord,
    classification,
    replyAt: pauseAt,
    explicitStop,
    snippet: replyText,
    messageId: input.messageId,
    threadId: input.threadId,
  });
  applied.channel_event.payload = {
    ...applied.channel_event.payload,
    classifier_reason: classified.reason || '',
    pause_first: true,
  };
  applied.patch.inbound_classification_in_flight = 0;

  ensureRecordColumns({
    db: input.db,
    columns: Object.keys(applied.patch),
  });
  upsertRecord({ db: input.db, row: applied.patch });
  insertChannelEvent({ db: input.db, event: applied.channel_event });

  const next = input.db.prepare('SELECT * FROM records WHERE _row_id = ?').get(recordId);
  return {
    classification,
    record: next,
    sequence_status: applied.sequence_status,
    lifecycle_stage: applied.lifecycle_stage,
    account_sequence_state: applied.account_sequence_state,
  };
}
