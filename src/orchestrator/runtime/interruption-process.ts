/**
 * Production entrypoint: apply a sequence interruption and persist.
 */
import { applySequenceInterruption, type InterruptionKind } from '../policy/interruptions.js';
import type { BounceType } from '../policy/bounce.js';
import { ensureRecordColumns, upsertRecord } from './db.js';
import { processBounceEvent } from './bounce-process.js';

export function processSequenceInterruption(input: {
  db: any;
  recordId: string;
  kind: InterruptionKind;
  reason?: string;
  asOf?: string;
  replyClassification?: string;
  bounceType?: BounceType;
  messageId?: string;
  threadId?: string;
  email?: string;
  contactId?: string;
  snippet?: string;
  /** Pipeline config for optional policy.on_hard_bounce.suppress. */
  config?: {
    policy?: {
      on_hard_bounce?: {
        suppress?: unknown;
      };
    };
  };
  globalSuppressionDb?: any;
}): {
  record: Record<string, unknown>;
  kind: InterruptionKind;
  account_sequence_state: string;
  lifecycle_stage: string;
} {
  const recordId = String(input.recordId || '').trim();
  const record = input.db.prepare('SELECT * FROM records WHERE _row_id = ?').get(recordId);
  if (!record) throw new Error(`Record not found: ${recordId}`);

  if (input.kind === 'email_bounce') {
    const bounced = processBounceEvent({
      db: input.db,
      recordId,
      messageId: input.messageId,
      threadId: input.threadId,
      bounceType: input.bounceType,
      source: 'manual',
      email: input.email,
      contactId: input.contactId,
      snippet: input.snippet,
      bounceAt: input.asOf,
      config: input.config,
      globalSuppressionDb: input.globalSuppressionDb,
    });
    return {
      record: bounced.record,
      kind: input.kind,
      account_sequence_state: String(bounced.record.account_sequence_state || ''),
      lifecycle_stage: String(bounced.record.lifecycle_stage || ''),
    };
  }

  const applied = applySequenceInterruption({
    record,
    kind: input.kind,
    reason: input.reason,
    asOf: input.asOf,
    replyClassification: input.replyClassification,
    bounceType: input.bounceType,
    messageId: input.messageId,
    threadId: input.threadId,
    email: input.email,
    contactId: input.contactId,
    snippet: input.snippet,
  });
  ensureRecordColumns({ db: input.db, columns: Object.keys(applied.patch) });
  upsertRecord({ db: input.db, row: applied.patch });
  const next = input.db.prepare('SELECT * FROM records WHERE _row_id = ?').get(recordId);
  return {
    record: next,
    kind: applied.kind,
    account_sequence_state: applied.account_sequence_state,
    lifecycle_stage: applied.lifecycle_stage,
  };
}
