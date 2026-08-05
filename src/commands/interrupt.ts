/**
 * Operator/API command: apply a sequence interruption to a record.
 * Production boundary for customer / opportunity / referral / DQ / cancel transitions.
 */
import { resolveListDir } from '../orchestrator/runtime/paths.js';
import { openListDb } from '../orchestrator/runtime/db.js';
import { processSequenceInterruption } from '../orchestrator/runtime/interruption-process.js';
import type { InterruptionKind } from '../orchestrator/policy/interruptions.js';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';
import { assertRecordAccessForMutation } from '../orchestrator/policy/canary-isolation.js';

const ALLOWED_KINDS = new Set<InterruptionKind>([
  'became_customer',
  'inbound_opportunity',
  'referral',
  'disqualified',
  'campaign_cancelled',
]);

export const interruptCommand = ({
  list,
  recordId = '',
  row = '',
  kind = '',
  reason = '',
}: {
  list: string;
  recordId?: string;
  row?: string;
  kind?: string;
  reason?: string;
}) => {
  const listDir = resolveListDir(list);
  const rid = String(recordId || row || '').trim();
  const interruptionKind = String(kind || '').trim() as InterruptionKind;
  if (!rid) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: 'recordId (or row) is required.',
      retryable: false,
    });
  }
  if (!ALLOWED_KINDS.has(interruptionKind)) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: `Invalid interruption kind: ${kind}. Allowed: ${[...ALLOWED_KINDS].join(', ')}`,
      retryable: false,
    });
  }
  assertRecordAccessForMutation({ listDir, recordId: rid });

  const db = openListDb({ listDir, readonly: false });
  try {
    const result = processSequenceInterruption({
      db,
      recordId: rid,
      kind: interruptionKind,
      reason: String(reason || interruptionKind),
    });
    return {
      ok: true,
      record_id: rid,
      kind: result.kind,
      lifecycle_stage: result.lifecycle_stage,
      account_sequence_state: result.account_sequence_state,
      disposition_latest: result.record.disposition_latest || '',
      sequence_status: result.record.sequence_status || '',
      next_action_json: result.record.next_action_json || '',
    };
  } finally {
    db.close();
  }
};
