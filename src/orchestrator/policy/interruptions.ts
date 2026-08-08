/**
 * Production sequence interruption handlers.
 * Terminal / opportunity / cancellation transitions — not test-local state writes.
 */
import { NEXT_ACTION_POLICY_VERSION, type LifecycleStage, type SequenceState, type WorkState } from './lifecycle.js';
import { assertLifecycleTransition, canTransitionLifecycle } from './lifecycle.js';
import { applyEmailBounce, type BounceType } from './bounce.js';
import { nowIso } from '../lib/record.js';

export type InterruptionKind =
  | 'became_customer'
  | 'inbound_opportunity'
  | 'referral'
  | 'disqualified'
  | 'campaign_cancelled'
  | 'email_bounce';

export type ApplyInterruptionInput = {
  record: Record<string, unknown>;
  kind: InterruptionKind;
  reason?: string;
  asOf?: string;
  bounceType?: BounceType;
  messageId?: string;
  threadId?: string;
  email?: string;
  contactId?: string;
  snippet?: string;
};

export type ApplyInterruptionResult = {
  patch: Record<string, unknown>;
  kind: InterruptionKind;
  account_sequence_state: string;
  lifecycle_stage: string;
};

function hopLifecycle(from: LifecycleStage, to: LifecycleStage, reason: string): LifecycleStage {
  if (from === to) return from;
  if (canTransitionLifecycle(from, to)) {
    assertLifecycleTransition(from, to, { reason });
    return to;
  }
  // Common multi-hop: contacted → engaged → meeting_booked → won
  const paths: LifecycleStage[][] = [
    ['replied', to],
    ['engaged', to],
    ['meeting_booked', to],
    ['replied', 'engaged', to],
    ['engaged', 'meeting_booked', to],
    ['contacted', 'engaged', 'meeting_booked', 'won'],
    ['contacted', 'replied', 'meeting_booked', 'won'],
    ['contacted', 'lost'],
    ['contacted', 'disqualified'],
  ];
  for (const path of paths) {
    if (path[path.length - 1] !== to) continue;
    let cur = from;
    let ok = true;
    for (const step of path) {
      if (cur === step) continue;
      if (!canTransitionLifecycle(cur, step)) {
        ok = false;
        break;
      }
      cur = step;
    }
    if (!ok || cur !== to) continue;
    cur = from;
    for (const step of path) {
      if (cur === step) continue;
      assertLifecycleTransition(cur, step, { reason });
      cur = step;
    }
    return to;
  }
  throw new Error(`No legal lifecycle path ${from} -> ${to} for ${reason}`);
}

/**
 * Apply a campaign/sequence interruption and return the persistence patch.
 */
export function applySequenceInterruption(input: ApplyInterruptionInput): ApplyInterruptionResult {
  const record = input.record || {};
  const recordId = String(record._row_id || record.id || '').trim();
  if (!recordId) throw new Error('applySequenceInterruption: record id required');

  const kind = input.kind;
  const reason = String(input.reason || kind);
  const asOf = String(input.asOf || nowIso());
  let lifecycle_stage = String(record.lifecycle_stage || 'contacted').trim() as LifecycleStage;
  let account_sequence_state: SequenceState = 'active';
  let work_state: WorkState = 'idle';
  let sequence_status = String(record.sequence_status || 'active');
  let disposition_latest = String(record.disposition_latest || '');
  let next_action_json: unknown = record.next_action_json;

  switch (kind) {
    case 'became_customer': {
      lifecycle_stage = hopLifecycle(lifecycle_stage, 'won', reason);
      account_sequence_state = 'completed';
      work_state = 'terminal_recordkeeping';
      sequence_status = 'completed';
      disposition_latest = 'became_customer';
      next_action_json = JSON.stringify({
        action_id: `na_customer_${recordId}`,
        action_type: 'terminal_recordkeeping',
        account_id: recordId,
        lifecycle_stage: 'won',
        sequence_state: 'completed',
        work_state: 'terminal_recordkeeping',
        reason: 'became_customer',
        on_success: 'stop',
        policy_version: NEXT_ACTION_POLICY_VERSION,
      });
      break;
    }
    case 'inbound_opportunity':
    case 'referral': {
      lifecycle_stage = hopLifecycle(lifecycle_stage, 'engaged', reason);
      account_sequence_state = 'paused_inbound';
      work_state = 'human_commercial_followup';
      sequence_status = 'engaged';
      disposition_latest = kind === 'referral' ? 'referral' : 'inbound_opportunity';
      next_action_json = JSON.stringify({
        action_id: `na_${kind}_${recordId}`,
        action_type: 'human_commercial_followup',
        account_id: recordId,
        lifecycle_stage: 'engaged',
        sequence_state: 'paused_inbound',
        work_state: 'human_commercial_followup',
        reason,
        on_success: 'human',
        policy_version: NEXT_ACTION_POLICY_VERSION,
      });
      break;
    }
    case 'disqualified': {
      lifecycle_stage = hopLifecycle(lifecycle_stage, 'disqualified', reason);
      account_sequence_state = 'completed';
      work_state = 'terminal_recordkeeping';
      sequence_status = 'completed';
      disposition_latest = 'disqualified';
      next_action_json = JSON.stringify({
        action_id: `na_dq_${recordId}`,
        action_type: 'terminal_disqualified',
        account_id: recordId,
        lifecycle_stage: 'disqualified',
        sequence_state: 'completed',
        work_state: 'terminal_recordkeeping',
        reason: 'disqualified',
        on_success: 'stop',
        policy_version: NEXT_ACTION_POLICY_VERSION,
      });
      break;
    }
    case 'campaign_cancelled': {
      account_sequence_state = 'cancelled';
      work_state = 'idle';
      sequence_status = 'cancelled';
      disposition_latest = 'campaign_cancelled';
      next_action_json = JSON.stringify({
        action_id: `na_cancel_${recordId}`,
        action_type: 'terminal_recordkeeping',
        account_id: recordId,
        lifecycle_stage,
        sequence_state: 'cancelled',
        work_state: 'idle',
        reason: 'campaign_cancelled',
        on_success: 'stop',
        policy_version: NEXT_ACTION_POLICY_VERSION,
      });
      break;
    }
    case 'email_bounce': {
      const bounced = applyEmailBounce({
        record,
        bounceType: input.bounceType,
        bounceAt: asOf,
        messageId: input.messageId,
        threadId: input.threadId,
        email: input.email,
        contactId: input.contactId,
        snippet: input.snippet,
        source: 'dsn',
      });
      return {
        patch: bounced.patch,
        kind,
        account_sequence_state: String(bounced.patch.account_sequence_state || ''),
        lifecycle_stage: String(bounced.patch.lifecycle_stage || lifecycle_stage),
      };
    }
    default:
      throw new Error(`Unknown interruption kind: ${kind}`);
  }

  const patch: Record<string, unknown> = {
    ...record,
    lifecycle_stage,
    account_sequence_state,
    work_state,
    sequence_status,
    disposition_latest,
    next_action_json,
    interrupted_at: asOf,
    interruption_kind: kind,
  };

  return {
    patch,
    kind,
    account_sequence_state,
    lifecycle_stage,
  };
}
