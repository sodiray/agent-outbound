/**
 * Durable transition / usage audit records for lifecycle transitions and human decisions.
 * Stage-review authorization with exact-version binding and sequence pause/resume coupling.
 *
 * Note: intentionally does not import lifecycle.ts (avoids circular dependency —
 * lifecycle succession appends transition audits).
 */

export const TRANSITION_AUDIT_VERSION = 'tv-transition-audit-v1';
export const STAGE_REVIEW_POLICY_VERSION = 'tv-stage-review-v1';
/** Keep aligned with lifecycle.NEXT_ACTION_POLICY_VERSION. */
const NEXT_ACTION_POLICY_VERSION = 'tv-next-action-v1';

type LifecycleStage = string;
type SequenceState = string;
type WorkState = string;

type NextAction = {
  action_id: string;
  action_type: string;
  account_id: string;
  contact_id?: string | null;
  owner_type?: string | null;
  owner_id?: string | null;
  due_at?: string | null;
  external_trigger?: string | null;
  lifecycle_stage: LifecycleStage;
  sequence_state: SequenceState;
  work_state: WorkState;
  preconditions?: string[];
  readiness_gates?: string[];
  reason: string;
  on_success: string;
  on_skip?: string;
  on_failure?: string;
  related_review_id?: string | null;
  related_asset_id?: string | null;
  policy_version: string;
};

export type TransitionAuditRecord = {
  audit_id: string;
  account_id: string;
  kind: 'lifecycle' | 'sequence' | 'work' | 'next_action' | 'human_decision' | 'usage' | 'repair';
  from_state?: string | null;
  to_state?: string | null;
  reason: string;
  evidence_ids: string[];
  actor: 'system' | 'human' | 'provider';
  cost_usd?: number | null;
  model?: string | null;
  tool?: string | null;
  occurred_at: string;
  policy_version: string;
};

export type StageReviewStatus =
  | 'pending'
  | 'authorized'
  | 'rejected'
  | 'invalidated'
  | 'edited'
  | 'regenerated';

export type StageReviewDecision =
  | 'authorize'
  | 'reject'
  | 'invalidate'
  | 'edit'
  | 'regenerate'
  | 'hold'
  | 'skip';

/** Version-bound review packet: exactly one stage result awaiting human decision. */
export type StageReviewAuthorization = {
  review_id: string;
  stage_id: string;
  asset_version: string;
  status: StageReviewStatus;
  account_id?: string | null;
  contact_id?: string | null;
  channel?: string | null;
  action_type?: string | null;
  authorized_by?: string | null;
  authorized_at?: string | null;
  notes?: string;
  policy_version?: string;
  pending_action_snapshot?: Record<string, unknown> | null;
};

export type StageReviewApplyResult = {
  authorization: StageReviewAuthorization;
  /** True when the decision is valid for the bound asset version and current review. */
  allowed: boolean;
  reason: string;
  /** Record fields to merge after the decision (sequence/work/next_action + review). */
  patch: {
    account_sequence_state?: SequenceState;
    work_state?: WorkState;
    next_action_json?: string;
    stage_review_json?: string;
    related_review_id?: string;
  };
  audit: TransitionAuditRecord;
};

let seq = 0;
function newId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now()}_${seq}`;
}

export function createTransitionAudit(input: {
  account_id: string;
  kind: TransitionAuditRecord['kind'];
  from_state?: string | null;
  to_state?: string | null;
  reason: string;
  evidence_ids?: string[];
  actor?: TransitionAuditRecord['actor'];
  cost_usd?: number | null;
  model?: string | null;
  tool?: string | null;
}): TransitionAuditRecord {
  return {
    audit_id: newId('ta'),
    account_id: input.account_id,
    kind: input.kind,
    from_state: input.from_state ?? null,
    to_state: input.to_state ?? null,
    reason: input.reason,
    evidence_ids: input.evidence_ids || [],
    actor: input.actor || 'system',
    cost_usd: input.cost_usd ?? null,
    model: input.model ?? null,
    tool: input.tool ?? null,
    occurred_at: new Date().toISOString(),
    policy_version: TRANSITION_AUDIT_VERSION,
  };
}

/** Append audit record to an in-memory/JSON array stored on the record. */
export function appendTransitionAudit(
  existingJson: unknown,
  entry: TransitionAuditRecord,
  maxEntries = 50,
): string {
  let list: TransitionAuditRecord[] = [];
  try {
    const parsed = typeof existingJson === 'string' ? JSON.parse(existingJson || '[]') : existingJson;
    if (Array.isArray(parsed)) list = parsed as TransitionAuditRecord[];
  } catch {
    list = [];
  }
  list.push(entry);
  if (list.length > maxEntries) list = list.slice(-maxEntries);
  return JSON.stringify(list);
}

export function parseStageReviewJson(raw: unknown): StageReviewAuthorization | null {
  if (raw == null || raw === '') return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as StageReviewAuthorization;
    if (!obj.review_id || !obj.stage_id || !obj.asset_version) return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * Create a version-bound pending review and pause the account sequence.
 * Does not invent commercial lifecycle transitions.
 */
export function pauseForStageReview(input: {
  account_id: string;
  stage_id: string;
  asset_version: string;
  contact_id?: string | null;
  channel?: string | null;
  action_type?: string | null;
  /** Snapshot of the outbound action awaiting authorization (restored on authorize). */
  pending_action?: Partial<NextAction> | Record<string, unknown> | null;
  lifecycle_stage?: LifecycleStage | string;
  reason?: string;
  review_id?: string;
}): {
  authorization: StageReviewAuthorization;
  patch: {
    account_sequence_state: SequenceState;
    work_state: WorkState;
    next_action_json: string;
    stage_review_json: string;
    related_review_id: string;
  };
  audit: TransitionAuditRecord;
} {
  const review_id = input.review_id || newId('rev');
  const lifecycle = (input.lifecycle_stage || 'contacted') as LifecycleStage;
  const authorization: StageReviewAuthorization = {
    review_id,
    stage_id: input.stage_id,
    asset_version: input.asset_version,
    status: 'pending',
    account_id: input.account_id,
    contact_id: input.contact_id ?? null,
    channel: input.channel ?? null,
    action_type: input.action_type ?? null,
    authorized_by: null,
    authorized_at: null,
    notes: input.reason,
    policy_version: STAGE_REVIEW_POLICY_VERSION,
    pending_action_snapshot: input.pending_action
      ? (input.pending_action as Record<string, unknown>)
      : null,
  };

  const next_action: NextAction = {
    action_id: newId('na_review'),
    action_type: 'pending_human_review',
    account_id: input.account_id,
    contact_id: input.contact_id ?? null,
    lifecycle_stage: lifecycle,
    sequence_state: 'paused_review',
    work_state: 'pending_human_review',
    reason: input.reason || `Stage review required for ${input.stage_id}@${input.asset_version}`,
    on_success: 'resume_after_review',
    related_review_id: review_id,
    related_asset_id: input.asset_version,
    policy_version: NEXT_ACTION_POLICY_VERSION,
  };

  const audit = createTransitionAudit({
    account_id: input.account_id,
    kind: 'human_decision',
    from_state: 'active',
    to_state: 'paused_review',
    reason: `pause_for_review ${review_id} stage=${input.stage_id} asset=${input.asset_version}`,
    evidence_ids: [review_id, input.asset_version],
    actor: 'system',
  });

  return {
    authorization,
    patch: {
      account_sequence_state: 'paused_review',
      work_state: 'pending_human_review',
      next_action_json: JSON.stringify(next_action),
      stage_review_json: JSON.stringify(authorization),
      related_review_id: review_id,
    },
    audit,
  };
}

/**
 * Apply a human review decision with exact-version authorization.
 *
 * - authorize: resume sequence with the pending outbound action (or provided resume action)
 * - reject / hold: stay paused or skip to configured safe next_action
 * - invalidate: clear authorization; remain paused_review until a new review is created
 * - edit: mark edited; remain pending (new asset_version should be supplied on re-authorize)
 * - regenerate: return work to content_generation; sequence paused_repair until content ready
 * - skip: complete review as rejected and install skip successor when provided
 *
 * Version mismatch against expected_asset_version (or existing review asset_version)
 * refuses authorize and forces invalidation semantics.
 */
export function authorizeStageReview(input: {
  review_id: string;
  stage_id: string;
  asset_version: string;
  decision: StageReviewDecision | 'authorize' | 'reject' | 'invalidate' | 'edit' | 'regenerate';
  actor?: string;
  notes?: string;
  account_id?: string;
  contact_id?: string | null;
  /** Bound version that must match asset_version for authorize. */
  expected_asset_version?: string | null;
  /** Existing pending review (from stage_review_json). */
  existing?: StageReviewAuthorization | null;
  /** Lifecycle stage preserved across the decision (never invents won/lost). */
  lifecycle_stage?: LifecycleStage | string;
  /**
   * Action restored on authorize (defaults to existing.pending_action_snapshot).
   * Must be an outbound-capable next_action shape.
   */
  resume_action?: Partial<NextAction> | Record<string, unknown> | null;
  /** Successor installed on skip/reject when provided. */
  skip_action?: Partial<NextAction> | Record<string, unknown> | null;
}): StageReviewAuthorization | StageReviewApplyResult {
  const statusMap: Record<string, StageReviewStatus> = {
    authorize: 'authorized',
    reject: 'rejected',
    invalidate: 'invalidated',
    edit: 'edited',
    regenerate: 'regenerated',
    hold: 'rejected',
    skip: 'rejected',
  };

  const account_id = input.account_id || input.existing?.account_id || 'unknown';
  const lifecycle = (input.lifecycle_stage
    || (input.existing?.pending_action_snapshot as { lifecycle_stage?: string } | null)?.lifecycle_stage
    || 'contacted') as LifecycleStage;

  // Exact-version gate: authorize only the bound asset version.
  const boundVersion = input.expected_asset_version
    ?? input.existing?.asset_version
    ?? input.asset_version;
  const versionMismatch = Boolean(
    boundVersion
    && input.asset_version
    && String(boundVersion) !== String(input.asset_version)
    && (input.decision === 'authorize' || input.decision === 'edit'),
  );

  // Already-terminal reviews cannot be re-authorized.
  const prior = input.existing?.status;
  const alreadyTerminal = prior === 'authorized' || prior === 'rejected' || prior === 'invalidated';
  if (alreadyTerminal && input.decision === 'authorize') {
    const authorization: StageReviewAuthorization = {
      review_id: input.review_id,
      stage_id: input.stage_id,
      asset_version: input.asset_version,
      status: prior!,
      account_id,
      contact_id: input.contact_id ?? input.existing?.contact_id ?? null,
      authorized_by: input.existing?.authorized_by ?? null,
      authorized_at: input.existing?.authorized_at ?? null,
      notes: input.notes || `refused: review already ${prior}`,
      policy_version: STAGE_REVIEW_POLICY_VERSION,
      pending_action_snapshot: input.existing?.pending_action_snapshot ?? null,
    };
    const audit = createTransitionAudit({
      account_id,
      kind: 'human_decision',
      from_state: prior,
      to_state: prior,
      reason: `authorize refused: review already ${prior}`,
      evidence_ids: [input.review_id],
      actor: 'human',
    });
    return {
      authorization,
      allowed: false,
      reason: `review_already_${prior}`,
      patch: {
        stage_review_json: JSON.stringify(authorization),
        related_review_id: input.review_id,
      },
      audit,
    };
  }

  if (versionMismatch) {
    const authorization: StageReviewAuthorization = {
      review_id: input.review_id,
      stage_id: input.stage_id,
      asset_version: input.asset_version,
      status: 'invalidated',
      account_id,
      contact_id: input.contact_id ?? input.existing?.contact_id ?? null,
      authorized_by: null,
      authorized_at: null,
      notes: input.notes || `asset_version mismatch expected=${boundVersion}`,
      policy_version: STAGE_REVIEW_POLICY_VERSION,
      pending_action_snapshot: input.existing?.pending_action_snapshot ?? null,
    };
    const audit = createTransitionAudit({
      account_id,
      kind: 'human_decision',
      from_state: prior || 'pending',
      to_state: 'invalidated',
      reason: `version_mismatch expected=${boundVersion} got=${input.asset_version}`,
      evidence_ids: [input.review_id, String(boundVersion), input.asset_version],
      actor: 'system',
    });
    // Stay paused — invalidated review cannot execute.
    const next_action: NextAction = {
      action_id: newId('na_review_invalid'),
      action_type: 'pending_human_review',
      account_id,
      contact_id: input.contact_id ?? input.existing?.contact_id ?? null,
      lifecycle_stage: lifecycle,
      sequence_state: 'paused_review',
      work_state: 'pending_human_review',
      reason: `Invalidated: asset version mismatch (${boundVersion} vs ${input.asset_version})`,
      on_success: 'create_new_review',
      related_review_id: input.review_id,
      related_asset_id: input.asset_version,
      policy_version: NEXT_ACTION_POLICY_VERSION,
    };
    return {
      authorization,
      allowed: false,
      reason: 'asset_version_mismatch',
      patch: {
        account_sequence_state: 'paused_review',
        work_state: 'pending_human_review',
        next_action_json: JSON.stringify(next_action),
        stage_review_json: JSON.stringify(authorization),
        related_review_id: input.review_id,
      },
      audit,
    };
  }

  const status = statusMap[input.decision] || 'pending';
  const now = new Date().toISOString();
  const authorization: StageReviewAuthorization = {
    review_id: input.review_id,
    stage_id: input.stage_id,
    asset_version: input.asset_version,
    status,
    account_id,
    contact_id: input.contact_id ?? input.existing?.contact_id ?? null,
    channel: input.existing?.channel ?? null,
    action_type: input.existing?.action_type ?? null,
    authorized_by: input.decision === 'authorize' ? (input.actor || 'human') : null,
    authorized_at: input.decision === 'authorize' ? now : null,
    notes: input.notes,
    policy_version: STAGE_REVIEW_POLICY_VERSION,
    pending_action_snapshot: input.existing?.pending_action_snapshot ?? null,
  };

  // Legacy callers that only need the authorization object (no account_id / existing):
  // keep simple shape when no coupling fields provided.
  const wantsFullResult = Boolean(
    input.account_id
    || input.existing
    || input.resume_action
    || input.expected_asset_version
    || input.skip_action
    || input.lifecycle_stage,
  );
  if (!wantsFullResult) {
    return authorization;
  }

  const patch: StageReviewApplyResult['patch'] = {
    stage_review_json: JSON.stringify(authorization),
    related_review_id: input.review_id,
  };

  let reason = `decision_${input.decision}`;

  if (input.decision === 'authorize') {
    const snap = (input.resume_action
      || input.existing?.pending_action_snapshot
      || null) as Partial<NextAction> | null;
    const contact_id = (snap?.contact_id
      ?? input.contact_id
      ?? input.existing?.contact_id
      ?? null) as string | null;
    const action_type = String(snap?.action_type || input.existing?.action_type || 'send_email');
    const resumed: NextAction = {
      action_id: String(snap?.action_id || newId('na_auth')),
      action_type,
      account_id,
      contact_id,
      lifecycle_stage: lifecycle,
      sequence_state: 'active',
      work_state: 'executing_external_action',
      reason: snap?.reason || `Authorized review ${input.review_id} asset=${input.asset_version}`,
      on_success: String(snap?.on_success || 'wait_or_followup'),
      related_review_id: input.review_id,
      related_asset_id: input.asset_version,
      policy_version: NEXT_ACTION_POLICY_VERSION,
      due_at: snap?.due_at ?? null,
      preconditions: snap?.preconditions,
      readiness_gates: snap?.readiness_gates,
    };
    patch.account_sequence_state = 'active';
    patch.work_state = 'executing_external_action';
    patch.next_action_json = JSON.stringify(resumed);
    reason = 'authorized_resume_outbound';
  } else if (input.decision === 'regenerate') {
    const next_action: NextAction = {
      action_id: newId('na_regen'),
      action_type: 'content_generation',
      account_id,
      contact_id: input.contact_id ?? input.existing?.contact_id ?? null,
      lifecycle_stage: lifecycle,
      sequence_state: 'paused_repair',
      work_state: 'content_generation',
      reason: input.notes || `Regenerate content for review ${input.review_id}`,
      on_success: 'return_to_review',
      related_review_id: input.review_id,
      related_asset_id: input.asset_version,
      policy_version: NEXT_ACTION_POLICY_VERSION,
    };
    patch.account_sequence_state = 'paused_repair';
    patch.work_state = 'content_generation';
    patch.next_action_json = JSON.stringify(next_action);
    reason = 'regenerate_content';
  } else if (input.decision === 'edit') {
    // Edited content needs a new asset version on the next authorize; stay pending.
    authorization.status = 'edited';
    patch.stage_review_json = JSON.stringify(authorization);
    patch.account_sequence_state = 'paused_review';
    patch.work_state = 'pending_human_review';
    const next_action: NextAction = {
      action_id: newId('na_edit'),
      action_type: 'pending_human_review',
      account_id,
      contact_id: input.contact_id ?? input.existing?.contact_id ?? null,
      lifecycle_stage: lifecycle,
      sequence_state: 'paused_review',
      work_state: 'pending_human_review',
      reason: input.notes || `Edited asset pending re-authorization ${input.review_id}`,
      on_success: 'authorize_edited_version',
      related_review_id: input.review_id,
      related_asset_id: input.asset_version,
      policy_version: NEXT_ACTION_POLICY_VERSION,
    };
    patch.next_action_json = JSON.stringify(next_action);
    reason = 'edited_pending_reauth';
  } else if (input.decision === 'invalidate') {
    patch.account_sequence_state = 'paused_review';
    patch.work_state = 'pending_human_review';
    const next_action: NextAction = {
      action_id: newId('na_inv'),
      action_type: 'pending_human_review',
      account_id,
      contact_id: input.contact_id ?? input.existing?.contact_id ?? null,
      lifecycle_stage: lifecycle,
      sequence_state: 'paused_review',
      work_state: 'pending_human_review',
      reason: input.notes || `Review invalidated ${input.review_id}`,
      on_success: 'create_new_review',
      related_review_id: input.review_id,
      related_asset_id: input.asset_version,
      policy_version: NEXT_ACTION_POLICY_VERSION,
    };
    patch.next_action_json = JSON.stringify(next_action);
    reason = 'invalidated_await_new_review';
  } else if (input.decision === 'skip') {
    const skip = (input.skip_action || null) as Partial<NextAction> | null;
    if (skip) {
      const next_action: NextAction = {
        action_id: String(skip.action_id || newId('na_skip')),
        action_type: String(skip.action_type || 'wait'),
        account_id,
        contact_id: (skip.contact_id ?? input.contact_id ?? input.existing?.contact_id ?? null) as string | null,
        lifecycle_stage: lifecycle,
        sequence_state: (skip.sequence_state as SequenceState) || 'waiting',
        work_state: (skip.work_state as WorkState) || 'waiting_time_or_event',
        reason: skip.reason || `Skipped review ${input.review_id}`,
        on_success: String(skip.on_success || 'execute_next_sequence_step'),
        due_at: skip.due_at ?? null,
        related_review_id: input.review_id,
        policy_version: NEXT_ACTION_POLICY_VERSION,
      };
      patch.account_sequence_state = next_action.sequence_state;
      patch.work_state = next_action.work_state;
      patch.next_action_json = JSON.stringify(next_action);
    } else {
      patch.account_sequence_state = 'active';
      patch.work_state = 'waiting_time_or_event';
      const next_action: NextAction = {
        action_id: newId('na_skip'),
        action_type: 'wait',
        account_id,
        contact_id: input.contact_id ?? input.existing?.contact_id ?? null,
        lifecycle_stage: lifecycle,
        sequence_state: 'waiting',
        work_state: 'waiting_time_or_event',
        reason: input.notes || `Skipped action after review ${input.review_id}`,
        on_success: 'execute_next_sequence_step',
        due_at: null,
        related_review_id: input.review_id,
        policy_version: NEXT_ACTION_POLICY_VERSION,
      };
      patch.account_sequence_state = 'waiting';
      patch.next_action_json = JSON.stringify(next_action);
    }
    reason = 'skipped_after_review';
  } else if (input.decision === 'reject') {
    // Reject must not strand forever on pending_human_review / paused_review.
    // Clear stuck pending → repair path so the record re-enters operator work
    // (human_review_repair) under paused_repair with reason rejected_review.
    // Optional skip_action may install a recycle path instead.
    const skip = (input.skip_action || null) as Partial<NextAction> | null;
    if (skip && (String(skip.action_type || '').includes('recycle')
      || String(skip.sequence_state || '') === 'recycle_wait')) {
      const next_action: NextAction = {
        action_id: String(skip.action_id || newId('na_rej_recycle')),
        action_type: String(skip.action_type || 'recycle_monitor'),
        account_id,
        contact_id: (skip.contact_id ?? input.contact_id ?? input.existing?.contact_id ?? null) as string | null,
        lifecycle_stage: lifecycle,
        sequence_state: (skip.sequence_state as SequenceState) || 'recycle_wait',
        work_state: (skip.work_state as WorkState) || 'waiting_time_or_event',
        reason: skip.reason || input.notes || 'rejected_review',
        on_success: String(skip.on_success || 'reentry_evaluation'),
        due_at: skip.due_at ?? null,
        related_review_id: input.review_id,
        related_asset_id: input.asset_version,
        policy_version: NEXT_ACTION_POLICY_VERSION,
      };
      patch.account_sequence_state = next_action.sequence_state;
      patch.work_state = next_action.work_state;
      patch.next_action_json = JSON.stringify(next_action);
    } else {
      const next_action: NextAction = {
        action_id: newId('na_rej_repair'),
        action_type: 'human_review_repair',
        account_id,
        contact_id: input.contact_id ?? input.existing?.contact_id ?? null,
        lifecycle_stage: lifecycle,
        sequence_state: 'paused_repair',
        work_state: 'channel_repair',
        reason: input.notes || 'rejected_review',
        on_success: 'return_to_review_or_next_step',
        related_review_id: input.review_id,
        related_asset_id: input.asset_version,
        policy_version: NEXT_ACTION_POLICY_VERSION,
      };
      patch.account_sequence_state = 'paused_repair';
      patch.work_state = 'channel_repair';
      patch.next_action_json = JSON.stringify(next_action);
    }
    reason = 'rejected_review';
  } else {
    // hold — stay paused with named decision (explicit hold, not reject)
    patch.account_sequence_state = 'paused_review';
    patch.work_state = 'pending_human_review';
    const next_action: NextAction = {
      action_id: newId('na_hold'),
      action_type: 'pending_human_review',
      account_id,
      contact_id: input.contact_id ?? input.existing?.contact_id ?? null,
      lifecycle_stage: lifecycle,
      sequence_state: 'paused_review',
      work_state: 'pending_human_review',
      reason: input.notes || `Held review ${input.review_id}`,
      on_success: 'operator_decision',
      related_review_id: input.review_id,
      related_asset_id: input.asset_version,
      policy_version: NEXT_ACTION_POLICY_VERSION,
    };
    patch.next_action_json = JSON.stringify(next_action);
    reason = 'held_by_reviewer';
  }

  const audit = createTransitionAudit({
    account_id,
    kind: 'human_decision',
    from_state: prior || 'pending',
    to_state: authorization.status,
    reason: `${reason} review=${input.review_id} stage=${input.stage_id}`,
    evidence_ids: [input.review_id, input.asset_version],
    actor: input.decision === 'invalidate' && !input.actor ? 'system' : 'human',
  });

  return {
    authorization,
    allowed: input.decision === 'authorize' || input.decision === 'skip' || input.decision === 'regenerate'
      || input.decision === 'edit' || input.decision === 'reject' || input.decision === 'hold'
      || input.decision === 'invalidate',
    reason,
    patch,
    audit,
  };
}

/**
 * Fail-closed material-change gate for external send.
 *
 * When stage_review_json is **authorized** for `stage_id` but its bound
 * `asset_version` no longer equals `current_asset_version` (recomputed from the
 * asset about to execute: account, contact, recipient, content/claim, step),
 * invalidate the authorization and optionally re-pause with a pending review
 * bound to the current fingerprint.
 *
 * Callers on email / linkedin / mail complete must recompute current version,
 * invoke this helper, persist any patch, and **not send** when `invalidated`.
 */
export function invalidateStageReviewIfAssetChanged(input: {
  record: Record<string, unknown> | null | undefined;
  stage_id: string;
  current_asset_version: string;
  account_id?: string;
  contact_id?: string | null;
  channel?: string | null;
  action_type?: string | null;
  lifecycle_stage?: string | null;
  reason?: string;
  /**
   * When true (default), after invalidation open a new pending review bound to
   * current_asset_version so the operator re-authorizes the new asset.
   */
  re_pause?: boolean;
}): {
  /** True when bound version differs from current (whether or not we invalidated). */
  changed: boolean;
  /** True when an authorized review was invalidated due to version drift. */
  invalidated: boolean;
  patch: StageReviewApplyResult['patch'] | null;
  audits: TransitionAuditRecord[];
  authorization: StageReviewAuthorization | null;
  reason: string;
} {
  const existing = parseStageReviewJson(input.record?.stage_review_json);
  const current = String(input.current_asset_version || '').trim();
  const stage = String(input.stage_id || '').trim();

  if (!existing || !current) {
    return {
      changed: false,
      invalidated: false,
      patch: null,
      audits: [],
      authorization: existing,
      reason: 'no_authorized_review_or_version',
    };
  }

  const stageKey = stage.toLowerCase();
  const reviewStage = String(existing.stage_id || '').trim().toLowerCase();
  const reviewAction = String(existing.action_type || '').trim().toLowerCase();
  const stageMatch =
    !stageKey
    || reviewStage === stageKey
    || reviewAction === stageKey;
  if (!stageMatch) {
    return {
      changed: false,
      invalidated: false,
      patch: null,
      audits: [],
      authorization: existing,
      reason: 'stage_mismatch',
    };
  }

  const bound = String(existing.asset_version || '').trim();
  if (!bound || bound === current) {
    return {
      changed: false,
      invalidated: false,
      patch: null,
      audits: [],
      authorization: existing,
      reason: 'asset_version_matches',
    };
  }

  // Only invalidate live authorizations. Pending/edited with drift is handled by
  // re-bind on authorize; terminal rejected/invalidated cannot authorize send.
  if (existing.status !== 'authorized') {
    return {
      changed: true,
      invalidated: false,
      patch: null,
      audits: [],
      authorization: existing,
      reason: `version_drift_status_${existing.status}`,
    };
  }

  const account_id = String(
    input.account_id
    || existing.account_id
    || input.record?._row_id
    || input.record?.id
    || input.record?.account_id
    || 'unknown',
  );
  const contact_id = (input.contact_id
    ?? existing.contact_id
    ?? null) as string | null;
  const lifecycle = String(
    input.lifecycle_stage
    || input.record?.lifecycle_stage
    || 'contacted',
  );
  const notes = input.reason
    || `Material change invalidated stage review: bound=${bound} current=${current}`;

  const inv = authorizeStageReview({
    review_id: existing.review_id,
    stage_id: existing.stage_id || stage,
    asset_version: current,
    expected_asset_version: bound,
    decision: 'invalidate',
    account_id,
    contact_id,
    existing,
    lifecycle_stage: lifecycle,
    notes,
    actor: 'system',
  }) as StageReviewApplyResult;

  const audits: TransitionAuditRecord[] = [inv.audit];
  let patch: StageReviewApplyResult['patch'] = { ...inv.patch };
  let authorization = inv.authorization;
  let reason = 'invalidated_asset_version_changed';

  if (input.re_pause !== false) {
    const paused = pauseForStageReview({
      account_id,
      stage_id: stage || existing.stage_id,
      asset_version: current,
      contact_id,
      channel: input.channel ?? existing.channel ?? null,
      action_type: input.action_type ?? existing.action_type ?? null,
      pending_action: existing.pending_action_snapshot,
      lifecycle_stage: lifecycle,
      reason: notes,
    });
    patch = {
      ...patch,
      ...paused.patch,
    };
    authorization = paused.authorization;
    audits.push(paused.audit);
    reason = 'invalidated_and_repaused_asset_version_changed';
  }

  return {
    changed: true,
    invalidated: true,
    patch,
    audits,
    authorization,
    reason,
  };
}

/**
 * Pause for channel repair; sequencer blocks until resumeRepair is applied.
 */
export function pauseForRepair(input: {
  account_id: string;
  contact_id?: string | null;
  lifecycle_stage?: LifecycleStage | string;
  channel?: string;
  reason: string;
}): {
  patch: {
    account_sequence_state: SequenceState;
    work_state: WorkState;
    next_action_json: string;
  };
  audit: TransitionAuditRecord;
} {
  const lifecycle = (input.lifecycle_stage || 'contacted') as LifecycleStage;
  const next_action: NextAction = {
    action_id: newId('na_repair'),
    action_type: 'channel_repair',
    account_id: input.account_id,
    contact_id: input.contact_id ?? null,
    lifecycle_stage: lifecycle,
    sequence_state: 'paused_repair',
    work_state: 'channel_repair',
    reason: input.reason,
    on_success: 'resume_after_repair',
    policy_version: NEXT_ACTION_POLICY_VERSION,
  };
  const audit = createTransitionAudit({
    account_id: input.account_id,
    kind: 'repair',
    from_state: 'active',
    to_state: 'paused_repair',
    reason: input.reason,
    evidence_ids: input.channel ? [input.channel] : [],
    actor: 'system',
  });
  return {
    patch: {
      account_sequence_state: 'paused_repair',
      work_state: 'channel_repair',
      next_action_json: JSON.stringify(next_action),
    },
    audit,
  };
}

/**
 * Resume after repair or recycle_wait with a single successor next_action.
 */
export function resumeAfterPause(input: {
  account_id: string;
  from_sequence_state: SequenceState | string;
  contact_id?: string | null;
  lifecycle_stage?: LifecycleStage | string;
  successor_action_type?: string;
  reason: string;
  due_at?: string | null;
}): {
  patch: {
    account_sequence_state: SequenceState;
    work_state: WorkState;
    next_action_json: string;
  };
  audit: TransitionAuditRecord;
} {
  const lifecycle = (input.lifecycle_stage || 'contacted') as LifecycleStage;
  const action_type = input.successor_action_type || 'send_email';
  const isWait = action_type === 'wait' || action_type === 'reentry_evaluation';
  const sequence_state: SequenceState = isWait ? 'waiting' : 'active';
  const work_state: WorkState = isWait
    ? (action_type === 'reentry_evaluation' ? 'reentry_evaluation' : 'waiting_time_or_event')
    : 'executing_external_action';
  const next_action: NextAction = {
    action_id: newId('na_resume'),
    action_type,
    account_id: input.account_id,
    contact_id: input.contact_id ?? null,
    lifecycle_stage: lifecycle,
    sequence_state,
    work_state,
    reason: input.reason,
    on_success: 'wait_or_followup',
    due_at: input.due_at ?? null,
    policy_version: NEXT_ACTION_POLICY_VERSION,
  };
  const audit = createTransitionAudit({
    account_id: input.account_id,
    kind: 'sequence',
    from_state: String(input.from_sequence_state),
    to_state: sequence_state,
    reason: input.reason,
    actor: 'system',
  });
  return {
    patch: {
      account_sequence_state: sequence_state,
      work_state,
      next_action_json: JSON.stringify(next_action),
    },
    audit,
  };
}

/** Detect channel/contact collision from multi-contact plan + channel flags. */
export function detectCollision(input: {
  active_contact_id?: string | null;
  proposed_contact_id?: string | null;
  channel?: string;
  same_channel_in_flight?: boolean;
  suppressed_contact_ids?: string[];
}): { collision: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (
    input.proposed_contact_id &&
    input.active_contact_id &&
    input.proposed_contact_id !== input.active_contact_id
  ) {
    reasons.push('proposed_contact_not_active');
  }
  if (input.same_channel_in_flight) {
    reasons.push('same_channel_in_flight');
  }
  if (
    input.proposed_contact_id &&
    (input.suppressed_contact_ids || []).includes(input.proposed_contact_id)
  ) {
    reasons.push('proposed_contact_suppressed');
  }
  return { collision: reasons.length > 0, reasons };
}

/** Statuses that still need an operator decision on the stage-review queue. */
export const OPEN_STAGE_REVIEW_STATUSES = new Set<StageReviewStatus>([
  'pending',
  'edited',
]);

export type PendingStageReviewRow = {
  record_id: string;
  business_name: string;
  review_id: string;
  stage_id: string;
  asset_version: string;
  status: StageReviewStatus | string;
  channel?: string | null;
  action_type?: string | null;
  account_sequence_state?: string;
  work_state?: string;
  contact_id?: string | null;
  notes?: string;
  authorized_by?: string | null;
  authorized_at?: string | null;
};

/**
 * Queryable stage-review queue for canary operators.
 * Default: open statuses only (pending / edited). Pass status to filter, or 'all'.
 */
export function listPendingStageReviews(input: {
  db: any;
  status?: string;
  limit?: number;
  offset?: number;
}): { total: number; reviews: PendingStageReviewRow[]; as_of: string } {
  const limit = Math.max(1, Number(input.limit) || 100);
  const offset = Math.max(0, Number(input.offset) || 0);
  const statusFilter = String(input.status || 'open').trim().toLowerCase();

  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = input.db.prepare(`
      SELECT
        _row_id AS record_id,
        COALESCE(business_name, '') AS business_name,
        stage_review_json,
        COALESCE(account_sequence_state, sequence_status, '') AS account_sequence_state,
        COALESCE(work_state, '') AS work_state
      FROM records
      WHERE COALESCE(stage_review_json, '') != ''
      ORDER BY COALESCE(updated_at, _updated_at, created_at) DESC
    `).all() as Array<Record<string, unknown>>;
  } catch {
    // Schema may lack account_sequence_state / work_state on older DBs.
    try {
      rows = input.db.prepare(`
        SELECT
          _row_id AS record_id,
          COALESCE(business_name, '') AS business_name,
          stage_review_json,
          COALESCE(sequence_status, '') AS account_sequence_state,
          '' AS work_state
        FROM records
        WHERE COALESCE(stage_review_json, '') != ''
        ORDER BY COALESCE(updated_at, _updated_at, created_at) DESC
      `).all() as Array<Record<string, unknown>>;
    } catch {
      rows = [];
    }
  }

  const reviews: PendingStageReviewRow[] = [];
  for (const row of rows) {
    const review = parseStageReviewJson(row.stage_review_json);
    if (!review) continue;
    const status = String(review.status || 'pending').toLowerCase();
    if (statusFilter === 'open' || statusFilter === '') {
      if (!OPEN_STAGE_REVIEW_STATUSES.has(status as StageReviewStatus)) continue;
    } else if (statusFilter !== 'all' && status !== statusFilter) {
      continue;
    }
    reviews.push({
      record_id: String(row.record_id || ''),
      business_name: String(row.business_name || ''),
      review_id: review.review_id,
      stage_id: review.stage_id,
      asset_version: review.asset_version,
      status: review.status || 'pending',
      channel: review.channel ?? null,
      action_type: review.action_type ?? null,
      account_sequence_state: String(row.account_sequence_state || ''),
      work_state: String(row.work_state || ''),
      contact_id: review.contact_id ?? null,
      notes: review.notes,
      authorized_by: review.authorized_by ?? null,
      authorized_at: review.authorized_at ?? null,
    });
  }

  const total = reviews.length;
  return {
    total,
    reviews: reviews.slice(offset, offset + limit),
    as_of: new Date().toISOString(),
  };
}
