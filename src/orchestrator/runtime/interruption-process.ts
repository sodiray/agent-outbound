/**
 * Production entrypoint: apply a sequence interruption and persist.
 */
import { applySequenceInterruption, type InterruptionKind } from '../policy/interruptions.js';
import type { BounceType } from '../policy/bounce.js';
import { ensureRecordColumns, upsertRecord } from './db.js';

export function processSequenceInterruption(input: {
  db: any;
  recordId: string;
  kind: InterruptionKind;
  reason?: string;
  bounceType?: BounceType;
  messageId?: string;
  threadId?: string;
  email?: string;
  contactId?: string;
  snippet?: string;
}): {
  record: Record<string, unknown>;
  kind: InterruptionKind;
  account_sequence_state: string;
  lifecycle_stage: string;
} {
  const recordId = String(input.recordId || '').trim();
  const record = input.db.prepare('SELECT * FROM records WHERE _row_id = ?').get(recordId);
  if (!record) throw new Error(`Record not found: ${recordId}`);

  const applied = applySequenceInterruption({
    record,
    kind: input.kind,
    reason: input.reason,
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
