/**
 * Production entrypoint: process one inbound reply text against a record.
 * Classifies with the pipeline-declared classifier, applies durable reply handling, and persists.
 *
 * DSN / mailer-daemon bodies are routed through processBounceEvent (durable,
 * idempotent by messageId) before the general reply classifier.
 */
import { classifyReplyAction } from '../actions/classify-reply/index.js';
import { generateObjectWithTools } from './llm.js';
import { randomUUID } from 'node:crypto';
import { applyInboundReplyClassification } from '../policy/inbound-reply.js';
import { detectBounceFromText } from '../policy/bounce.js';
import { addSuppression, ensureRecordColumns, insertChannelEvent, upsertRecord } from './db.js';
import { processBounceEvent } from './bounce-process.js';
import { nowIso } from '../lib/record.js';

type ReplyClassifier = {
  model?: unknown;
  prompt?: unknown;
  output?: {
    classifications?: unknown;
    opt_out_classifications?: unknown;
  };
};

const optOutClassifications = (classifier: ReplyClassifier | undefined) => (
  Array.isArray(classifier?.output?.opt_out_classifications)
    ? classifier.output.opt_out_classifications.map((value) => String(value || '').trim()).filter(Boolean)
    : []
);

export async function processInboundReplyText(input: {
  db: any;
  recordId: string;
  replyText: string;
  messageId?: string;
  threadId?: string;
  replyAt?: string;
  contactId?: string;
  classifier?: ReplyClassifier;
  aiConfig?: Record<string, unknown>;
  globalSuppressionDb?: any;
  /** Pipeline config for optional policy.on_hard_bounce.suppress on DSN/bounce path. */
  config?: {
    policy?: {
      on_hard_bounce?: {
        suppress?: unknown;
      };
    };
  };
  generate?: typeof generateObjectWithTools;
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
      contactId: input.contactId,
      bounceAt: input.replyAt || nowIso(),
      config: input.config,
      globalSuppressionDb: input.globalSuppressionDb,
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
  const pauseAt = String(input.replyAt || nowIso());
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
    classifier: input.classifier,
    aiConfig: input.aiConfig || {},
    generate: input.generate,
  }).catch((error) => {
    const message = String(error instanceof Error ? error.message : error);
    const failedPatch = {
      ...prePause,
      inbound_classification_in_flight: 0,
      inbound_classification_error: message,
      inbound_classification_failed_at: pauseAt,
      reply_classification_latest: 'classification_failed',
    };
    ensureRecordColumns({ db: input.db, columns: Object.keys(failedPatch) });
    upsertRecord({ db: input.db, row: failedPatch });
    insertChannelEvent({
      db: input.db,
      event: {
        id: randomUUID(),
        row_id: recordId,
        contact_id: input.contactId || '',
        channel: 'email',
        event_type: 'reply_classification_failed',
        action: 'reply_classification_failed',
        disposition: 'classification_failed',
        provider_message_id: input.messageId || '',
        provider_thread_id: input.threadId || '',
        payload: { error: message, pause_first: true },
        occurred_at: pauseAt,
      },
    });
    throw new Error(`Inbound reply classification failed for ${recordId}: ${message}`);
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
      contactId: input.contactId,
      bounceAt: pauseAt,
      config: input.config,
      globalSuppressionDb: input.globalSuppressionDb,
    });
    return {
      classification,
      record: bounced.record,
      sequence_status: bounced.sequence_status,
      lifecycle_stage: String(bounced.record.lifecycle_stage || ''),
      account_sequence_state: String(bounced.record.account_sequence_state || ''),
    };
  }
  const explicitStop = optOutClassifications(input.classifier).includes(classification);
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
    contactId: input.contactId,
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
  if (explicitStop) {
    const email = String(record.email_primary || record.contact_email || '').trim().toLowerCase();
    if (email) {
      const entry = {
        id: randomUUID(),
        value: email,
        value_type: 'email',
        scope: 'global',
        reason: 'opt_out',
        source: 'inbound_reply_classifier',
        record_id: recordId,
        created_at: pauseAt,
      };
      addSuppression({ db: input.db, entry });
      if (input.globalSuppressionDb && input.globalSuppressionDb !== input.db) {
        addSuppression({ db: input.globalSuppressionDb, entry });
      }
    }
  }

  const next = input.db.prepare('SELECT * FROM records WHERE _row_id = ?').get(recordId);
  return {
    classification,
    record: next,
    sequence_status: applied.sequence_status,
    lifecycle_stage: applied.lifecycle_stage,
    account_sequence_state: applied.account_sequence_state,
  };
}
