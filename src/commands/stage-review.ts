/**
 * Production operator boundary: authorize, reject, or reopen non-email stage
 * reviews (LinkedIn, mail). Email can use drafts_approve as an interim; this
 * command is the explicit gate for channels without a draft interim.
 *
 * Persists stage_review_json and, on authorize, resumes account_sequence_state
 * via authorizeStageReview (exact-version bound).
 *
 * `reopen` is the supported undo for a mistaken or provisional rejection: the
 * rejected packet moves to history and a fresh **pending** review is opened.
 * Never auto-authorizes. Distinct from `review clear` (declared review: stages
 * like sourced_review), which is a different subsystem.
 *
 * Also exposes list-pending for the stage-review operator queue.
 */
import {
  ensureRecordColumns,
  getRecordById,
  openListDb,
  upsertRecord,
} from '../orchestrator/runtime/db.js';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';
import { readConfig } from '../orchestrator/lib/config.js';
import {
  appendTransitionAudit,
  authorizeStageReview,
  findStageReview,
  listPendingStageReviews,
  listStageReviews,
  parseStageReviewJson,
  parseStageReviewStore,
  reopenStageReview,
  type StageReviewApplyResult,
} from '../orchestrator/policy/transition-audit.js';
import {
  presentationAuthorizationGate,
  resolveStageReviewPresentationForRead,
} from '../orchestrator/policy/review-presentation.js';
import { assertRecordAccessForMutation } from '../orchestrator/policy/canary-isolation.js';
import { isAffirmativeFlag } from '../orchestrator/policy/booleanish.js';

const ALLOWED_DECISIONS = new Set(['authorize', 'reject'] as const);

/** Suppressed, dropped, or terminal-sequence records cannot re-enter review. */
const stageReviewRecordBlockedReason = (
  record: Record<string, unknown>,
): string | null => {
  if (isAffirmativeFlag(record.suppressed, { failClosed: true })) {
    return 'record_suppressed';
  }
  const disqualifiedAt = normalize(record.disqualified_at);
  if (disqualifiedAt) {
    return 'record_disqualified';
  }
  const lifecycle = normalizeKey(record.lifecycle_stage);
  if (['won', 'lost', 'disqualified'].includes(lifecycle)) {
    return `record_terminal_lifecycle:${lifecycle}`;
  }
  const sequence = normalizeKey(record.sequence_status || record.sequence_state);
  if (['completed', 'cancelled', 'opted_out', 'bounced'].includes(sequence)) {
    return `record_terminal_sequence:${sequence}`;
  }
  const accountSequence = normalizeKey(record.account_sequence_state);
  if (['completed', 'cancelled'].includes(accountSequence)) {
    return `record_terminal_account_sequence:${accountSequence}`;
  }
  return null;
};

/** List pending (or filtered) stage reviews for a list — canary ops queue. */
export const stageReviewListCommand = ({
  list,
  status = 'open',
  limit = 100,
  offset = 0,
}: {
  list: string;
  status?: string;
  limit?: number;
  offset?: number;
}) => {
  const listDir = resolveListDir(list);
  const config = (() => {
    try {
      return readConfig(listDir).config as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  const db = openListDb({ listDir, readonly: true });
  try {
    return listPendingStageReviews({
      db,
      status,
      limit: Number(limit) || 100,
      offset: Number(offset) || 0,
      config,
    });
  } finally {
    db.close();
  }
};

const normalize = (value: unknown) => String(value ?? '').trim();
const normalizeKey = (value: unknown) => normalize(value).toLowerCase();

const stageMatches = (
  existing: { stage_id?: string | null; action_type?: string | null },
  stageId: string,
): boolean => {
  const stage = normalizeKey(stageId);
  if (!stage) return true;
  return (
    normalizeKey(existing.stage_id) === stage
    || normalizeKey(existing.action_type) === stage
  );
};

export const stageReviewAuthorizeCommand = ({
  list,
  recordId = '',
  row = '',
  stage_id = '',
  stageId = '',
  decision = '',
  asset_version = '',
  assetVersion = '',
  actor = '',
  notes = '',
}: {
  list: string;
  recordId?: string;
  row?: string;
  stage_id?: string;
  stageId?: string;
  decision?: string;
  asset_version?: string;
  assetVersion?: string;
  actor?: string;
  notes?: string;
}) => {
  const listDir = resolveListDir(list);
  const rid = normalize(recordId || row);
  const stage = normalize(stage_id || stageId);
  const decisionKey = normalizeKey(decision);
  const assetVersionInput = normalize(asset_version || assetVersion);
  const actorName = normalize(actor) || 'operator';
  const noteText = normalize(notes);

  if (!rid) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: 'recordId (or row) is required.',
      retryable: false,
    });
  }
  assertRecordAccessForMutation({ listDir, recordId: rid });
  if (!stage) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: 'stage_id is required.',
      retryable: false,
    });
  }
  if (!ALLOWED_DECISIONS.has(decisionKey as 'authorize' | 'reject')) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: `Invalid decision: ${decision}. Allowed: authorize, reject.`,
      retryable: false,
    });
  }

  const db = openListDb({ listDir, readonly: false });
  try {
    const record = getRecordById({ db, id: rid }) as Record<string, unknown> | undefined;
    if (!record) {
      throw new AgentOutboundError({
        code: 'NOT_FOUND',
        message: `Record not found: ${rid}`,
        retryable: false,
      });
    }

    // Multi-review: select the operative review for this stage_id among siblings.
    const store = parseStageReviewStore(record.stage_review_json);
    const existing =
      findStageReview(record.stage_review_json, [stage])
      || parseStageReviewJson(record.stage_review_json);
    if (!existing || store.reviews.length === 0) {
      throw new AgentOutboundError({
        code: 'NOT_FOUND',
        message: `No stage_review_json on record ${rid}.`,
        retryable: false,
        hint: 'A pending stage review is created when policy.review_required_for pauses the sequence.',
      });
    }
    if (!stageMatches(existing, stage)) {
      const known = listStageReviews(record.stage_review_json)
        .map((r) => r.stage_id)
        .filter(Boolean)
        .join(', ');
      throw new AgentOutboundError({
        code: 'INVALID_ARGUMENT',
        message:
          `stage_id "${stage}" does not match any review on this record `
          + `(known stage_ids: ${known || 'none'}; `
          + `matched stage_id=${existing.stage_id}, action_type=${existing.action_type || ''}).`,
        retryable: false,
      });
    }

    const boundAssetVersion = assetVersionInput || normalize(existing.asset_version);
    if (!boundAssetVersion) {
      throw new AgentOutboundError({
        code: 'INVALID_ARGUMENT',
        message: 'asset_version is required when the pending review has none bound.',
        retryable: false,
      });
    }

    // Fail closed: never authorize when the values a human would be shown are
    // not proven identical to the bound presentation snapshot.
    if (decisionKey === 'authorize') {
      let projectConfig: unknown = null;
      try {
        projectConfig = readConfig(listDir).config;
      } catch {
        projectConfig = null;
      }
      const read = resolveStageReviewPresentationForRead({
        review: existing,
        record,
        config: projectConfig,
      });
      const gate = presentationAuthorizationGate({
        bound: read.bound_presentation,
        presentation: read.presentation,
      });
      if (!gate.authorizable) {
        return {
          ok: false,
          allowed: false,
          reason: gate.reason || 'presentation_not_authorizable',
          decision: decisionKey,
          record_id: String(record._row_id || rid),
          stage_id: stage,
          asset_version: boundAssetVersion,
          review_id: existing.review_id,
          authorization: existing,
          presentation_authorizable: false,
          presentation_authorization_reason: gate.reason,
          account_sequence_state: String(record.account_sequence_state || ''),
          work_state: String(record.work_state || ''),
          next_action_json: String(record.next_action_json || ''),
          stage_review_json: String(record.stage_review_json || ''),
        };
      }
    }

    const accountId = normalize(record._row_id || record.id || existing.account_id || rid);
    const raw = authorizeStageReview({
      review_id: existing.review_id,
      stage_id: normalize(existing.stage_id) || stage,
      asset_version: boundAssetVersion,
      expected_asset_version: normalize(existing.asset_version) || boundAssetVersion,
      decision: decisionKey as 'authorize' | 'reject',
      account_id: accountId,
      contact_id: existing.contact_id ?? null,
      existing,
      existing_json: record.stage_review_json,
      lifecycle_stage: String(record.lifecycle_stage || 'contacted'),
      actor: actorName,
      notes: noteText || undefined,
    });

    if (!raw || typeof raw !== 'object' || !('allowed' in raw)) {
      throw new AgentOutboundError({
        code: 'INTERNAL_ERROR',
        message: 'authorizeStageReview did not return a full apply result.',
        retryable: false,
      });
    }

    const result = raw as StageReviewApplyResult;
    const patch = result.patch || {};
    const next: Record<string, unknown> = {
      ...record,
      ...patch,
      transition_audit_json: appendTransitionAudit(record.transition_audit_json, result.audit),
    };

    ensureRecordColumns({
      db,
      columns: [...Object.keys(patch), 'transition_audit_json'],
    });
    upsertRecord({ db, row: next });

    const persisted = getRecordById({ db, id: String(record._row_id || rid) }) as
      | Record<string, unknown>
      | undefined;
    const review =
      findStageReview(persisted?.stage_review_json ?? next.stage_review_json, [stage, existing.stage_id])
      || result.authorization;

    return {
      ok: Boolean(result.allowed),
      allowed: Boolean(result.allowed),
      reason: result.reason,
      decision: decisionKey,
      record_id: String(record._row_id || rid),
      stage_id: stage,
      asset_version: boundAssetVersion,
      review_id: existing.review_id,
      authorization: review,
      account_sequence_state:
        String(persisted?.account_sequence_state ?? patch.account_sequence_state ?? record.account_sequence_state ?? ''),
      work_state: String(persisted?.work_state ?? patch.work_state ?? record.work_state ?? ''),
      next_action_json: String(persisted?.next_action_json ?? patch.next_action_json ?? record.next_action_json ?? ''),
      stage_review_json: String(persisted?.stage_review_json ?? patch.stage_review_json ?? ''),
    };
  } finally {
    db.close();
  }
};

/**
 * Re-open a rejected channel stage review as a fresh pending decision.
 * Prior rejection is retained in stage-reviews-v2 history (never erased).
 * Never auto-authorizes. Distinct from `review clear` (sourced_review stages).
 */
export const stageReviewReopenCommand = ({
  list,
  recordId = '',
  row = '',
  stage_id = '',
  stageId = '',
  asset_version = '',
  assetVersion = '',
  actor = '',
  notes = '',
}: {
  list: string;
  recordId?: string;
  row?: string;
  stage_id?: string;
  stageId?: string;
  asset_version?: string;
  assetVersion?: string;
  actor?: string;
  notes?: string;
}) => {
  const listDir = resolveListDir(list);
  const rid = normalize(recordId || row);
  const stage = normalize(stage_id || stageId);
  const assetVersionInput = normalize(asset_version || assetVersion);
  const actorName = normalize(actor) || 'operator';
  const noteText = normalize(notes);

  if (!rid) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: 'recordId (or row) is required.',
      retryable: false,
    });
  }
  assertRecordAccessForMutation({ listDir, recordId: rid });
  if (!stage) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: 'stage_id is required.',
      retryable: false,
    });
  }

  const db = openListDb({ listDir, readonly: false });
  try {
    const record = getRecordById({ db, id: rid }) as Record<string, unknown> | undefined;
    if (!record) {
      throw new AgentOutboundError({
        code: 'NOT_FOUND',
        message: `Record not found: ${rid}`,
        retryable: false,
      });
    }

    const blocked = stageReviewRecordBlockedReason(record);
    if (blocked) {
      return {
        ok: false,
        allowed: false,
        reason: blocked,
        decision: 'reopen',
        record_id: String(record._row_id || rid),
        stage_id: stage,
        review_id: null,
        authorization: null,
        prior: null,
        account_sequence_state: String(record.account_sequence_state || ''),
        work_state: String(record.work_state || ''),
        next_action_json: String(record.next_action_json || ''),
        stage_review_json: String(record.stage_review_json || ''),
      };
    }

    const existing =
      findStageReview(record.stage_review_json, [stage])
      || parseStageReviewJson(record.stage_review_json);
    if (!existing) {
      throw new AgentOutboundError({
        code: 'NOT_FOUND',
        message: `No stage_review_json on record ${rid}.`,
        retryable: false,
        hint: 'A pending stage review is created when policy.review_required_for pauses the sequence.',
      });
    }
    if (!stageMatches(existing, stage)) {
      const known = listStageReviews(record.stage_review_json)
        .map((r) => r.stage_id)
        .filter(Boolean)
        .join(', ');
      throw new AgentOutboundError({
        code: 'INVALID_ARGUMENT',
        message:
          `stage_id "${stage}" does not match any review on this record `
          + `(known stage_ids: ${known || 'none'}; `
          + `matched stage_id=${existing.stage_id}, action_type=${existing.action_type || ''}).`,
        retryable: false,
      });
    }

    const accountId = normalize(record._row_id || record.id || existing.account_id || rid);
    const result = reopenStageReview({
      account_id: accountId,
      stage_id: normalize(existing.stage_id) || stage,
      existing_json: record.stage_review_json,
      asset_version: assetVersionInput || normalize(existing.asset_version),
      actor: actorName,
      notes: noteText || undefined,
      contact_id: existing.contact_id ?? null,
      channel: existing.channel ?? null,
      action_type: existing.action_type ?? null,
      pending_action: existing.pending_action_snapshot ?? null,
      presentation: existing.presentation ?? null,
      lifecycle_stage: String(record.lifecycle_stage || 'contacted'),
    });

    if (!result.allowed) {
      return {
        ok: false,
        allowed: false,
        reason: result.reason,
        decision: 'reopen',
        record_id: String(record._row_id || rid),
        stage_id: stage,
        review_id: existing.review_id,
        authorization: existing,
        prior: result.prior,
        account_sequence_state: String(record.account_sequence_state || ''),
        work_state: String(record.work_state || ''),
        next_action_json: String(record.next_action_json || ''),
        stage_review_json: String(record.stage_review_json || ''),
      };
    }

    const patch = result.patch || {};
    const next: Record<string, unknown> = {
      ...record,
      ...patch,
      transition_audit_json: appendTransitionAudit(record.transition_audit_json, result.audit),
    };

    ensureRecordColumns({
      db,
      columns: [...Object.keys(patch), 'transition_audit_json'],
    });
    upsertRecord({ db, row: next });

    const persisted = getRecordById({ db, id: String(record._row_id || rid) }) as
      | Record<string, unknown>
      | undefined;
    const review =
      findStageReview(persisted?.stage_review_json ?? next.stage_review_json, [stage, existing.stage_id])
      || result.authorization;
    const store = parseStageReviewStore(persisted?.stage_review_json ?? next.stage_review_json);

    return {
      ok: true,
      allowed: true,
      reason: result.reason,
      decision: 'reopen',
      record_id: String(record._row_id || rid),
      stage_id: stage,
      asset_version: String(review?.asset_version || result.authorization?.asset_version || ''),
      review_id: review?.review_id || result.authorization?.review_id || null,
      authorization: review,
      prior: result.prior,
      history_count: store.history.length,
      account_sequence_state:
        String(persisted?.account_sequence_state ?? patch.account_sequence_state ?? record.account_sequence_state ?? ''),
      work_state: String(persisted?.work_state ?? patch.work_state ?? record.work_state ?? ''),
      next_action_json: String(persisted?.next_action_json ?? patch.next_action_json ?? record.next_action_json ?? ''),
      stage_review_json: String(persisted?.stage_review_json ?? patch.stage_review_json ?? ''),
    };
  } finally {
    db.close();
  }
};
