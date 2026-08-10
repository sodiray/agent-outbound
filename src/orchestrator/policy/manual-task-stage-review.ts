/**
 * Open a pending stage review when parking a manual_task that declares
 * review: or is covered by policy.review_required_for.
 *
 * Shared by every path that records an awaiting_manual park (channel execute
 * and pipeline dataflow) so a park never silently omits the authorization
 * artifact the operator needs to complete the step.
 *
 * Never auto-authorizes. Failures are returned (and optionally audited) —
 * callers still park; completeManualTask continues to refuse without auth.
 */

import { ensureRecordColumns, upsertRecord } from '../runtime/db.js';
import {
  isAuthorizedForAnyOf,
  isReviewRequired,
  reviewRequiredTokens,
  resolveStageAssetVersion,
  type PolicyConfigLike,
} from './stage-review-gate.js';
import {
  resolveReviewPresentation,
  type ResolvedReviewPresentation,
} from './review-presentation.js';
import {
  appendTransitionAudit,
  createTransitionAudit,
  invalidateStageReviewIfAssetChanged,
  parseStageReviewStore,
  pauseForStageReview,
} from './transition-audit.js';

export type ManualTaskParkReviewResult = {
  /** Updated record (may include new stage_review_json / audit). */
  record: Record<string, unknown>;
  /** True when a new pending review was inserted. */
  opened: boolean;
  /** Why a review was not opened (when opened is false and no error). */
  reason: string;
  /**
   * Non-null when opening was required (declared review: or policy) but failed.
   * Park may still proceed; complete must refuse. Never silent.
   */
  error: string | null;
};

const text = (value: unknown, fallback = '') => {
  const s = String(value ?? '').trim();
  return s || fallback;
};

const materialAssetVersion = ({
  record,
  stageId,
  assetForStep,
  policyVersion,
  recipient,
  bodyText,
  activeContactId,
  reviewPresentation,
}: {
  record: Record<string, unknown>;
  stageId: string;
  assetForStep?: { asset_id?: string } | null;
  policyVersion?: string | null;
  recipient?: string | null;
  bodyText?: string | null;
  activeContactId?: string | null;
  reviewPresentation?: ResolvedReviewPresentation | null;
}): string => {
  const accountId = text(record._row_id || record.id || record.account_id);
  const contact = text(
    activeContactId
    || record.active_contact_id
    || record.contact_id,
  );
  const to = text(
    recipient
    || record.contact_email
    || record.email
    || record.linkedin_url
    || record.contact_linkedin
    || record.address,
  );
  return resolveStageAssetVersion({
    accountId,
    activeContactId: contact || null,
    contactId: text(record.contact_id) || null,
    recipient: to || null,
    stepId: stageId,
    stageId,
    assetId: assetForStep?.asset_id ? String(assetForStep.asset_id) : null,
    draftId: null,
    policyVersion: policyVersion ?? null,
    bodyText: bodyText ?? null,
    subjectText: null,
    reviewPresentation: reviewPresentation ?? null,
  });
};

const persistStageReviewPause = ({
  db,
  record,
  stageId,
  assetVersion,
  channel,
  actionType,
  contactId,
  reason,
  presentation,
}: {
  db: any;
  record: Record<string, unknown>;
  stageId: string;
  assetVersion: string;
  channel?: string | null;
  actionType: string;
  contactId?: string | null;
  reason: string;
  presentation?: ResolvedReviewPresentation | null;
}): { record: Record<string, unknown>; allowed: boolean; pauseReason: string } => {
  const accountId = text(record._row_id || record.id || record.account_id);
  const lifecycle = text(record.lifecycle_stage, 'contacted');
  const pendingActionType = text(channel).toLowerCase() === 'mail'
    ? 'send_mail'
    : actionType;
  const paused = pauseForStageReview({
    account_id: accountId,
    stage_id: stageId,
    asset_version: assetVersion,
    contact_id: contactId ?? null,
    channel: channel ?? null,
    action_type: actionType,
    pending_action: {
      action_type: pendingActionType,
      account_id: accountId,
      contact_id: contactId ?? null,
      lifecycle_stage: lifecycle,
      sequence_state: 'active',
      work_state: 'executing_external_action',
      reason: `resume after stage review ${stageId}`,
      on_success: 'wait_or_followup',
    },
    lifecycle_stage: lifecycle,
    reason,
    presentation: presentation ?? null,
    // Multi-review: keep terminal siblings; refuse when another stage is open.
    existing_json: record.stage_review_json,
  });
  if (!paused.allowed) {
    const next: Record<string, unknown> = {
      ...record,
      transition_audit_json: appendTransitionAudit(record.transition_audit_json, paused.audit),
    };
    ensureRecordColumns({ db, columns: ['transition_audit_json'] });
    upsertRecord({ db, row: next });
    return {
      record: next,
      allowed: false,
      pauseReason: String(paused.reason || 'pause_refused'),
    };
  }
  const next: Record<string, unknown> = {
    ...record,
    ...paused.patch,
    transition_audit_json: appendTransitionAudit(record.transition_audit_json, paused.audit),
  };
  ensureRecordColumns({
    db,
    columns: [
      ...Object.keys(paused.patch),
      'transition_audit_json',
      'related_review_id',
    ],
  });
  upsertRecord({ db, row: next });
  return { record: next, allowed: true, pauseReason: 'inserted' };
};

const persistMaterialInvalidation = ({
  db,
  record,
  stageId,
  currentAssetVersion,
  channel,
  actionType,
  contactId,
  presentation,
}: {
  db: any;
  record: Record<string, unknown>;
  stageId: string;
  currentAssetVersion: string;
  channel?: string | null;
  actionType: string;
  contactId?: string | null;
  presentation?: ResolvedReviewPresentation | null;
}): { record: Record<string, unknown>; blocked: boolean; reason?: string } => {
  const result = invalidateStageReviewIfAssetChanged({
    record,
    stage_id: stageId,
    current_asset_version: currentAssetVersion,
    account_id: text(record._row_id || record.id || record.account_id),
    contact_id: contactId ?? null,
    channel: channel ?? null,
    action_type: actionType,
    lifecycle_stage: text(record.lifecycle_stage, 'contacted'),
    re_pause: true,
    presentation: presentation ?? null,
  });
  if (!result.invalidated || !result.patch) {
    return { record, blocked: false };
  }
  let auditJson = record.transition_audit_json;
  for (const audit of result.audits) {
    auditJson = appendTransitionAudit(auditJson, audit);
  }
  const next: Record<string, unknown> = {
    ...record,
    ...result.patch,
    transition_audit_json: auditJson,
  };
  ensureRecordColumns({
    db,
    columns: [
      ...Object.keys(result.patch),
      'transition_audit_json',
      'related_review_id',
    ],
  });
  upsertRecord({ db, row: next });
  return {
    record: next,
    blocked: true,
    reason: 'Stage review invalidated: asset changed; re-paused for review.',
  };
};

/**
 * Record a visible failure when opening a required stage review fails.
 * Park still proceeds; completeManualTask keeps refusing without auth.
 */
const recordOpenFailure = ({
  db,
  record,
  stageId,
  error,
}: {
  db: any;
  record: Record<string, unknown>;
  stageId: string;
  error: string;
}): Record<string, unknown> => {
  const accountId = text(record._row_id || record.id || record.account_id);
  const audit = createTransitionAudit({
    account_id: accountId,
    kind: 'repair',
    from_state: 'awaiting_manual',
    to_state: 'awaiting_manual',
    reason: `stage_review_open_failed:${stageId}:${error}`,
    actor: 'system',
  });
  const next: Record<string, unknown> = {
    ...record,
    transition_audit_json: appendTransitionAudit(record.transition_audit_json, audit),
    last_error: `stage_review_open_failed:${error}`,
  };
  try {
    ensureRecordColumns({
      db,
      columns: ['transition_audit_json', 'last_error'],
    });
    upsertRecord({ db, row: next });
  } catch {
    // Still return the in-memory failure so callers can surface it.
  }
  return next;
};

/**
 * When a manual_task is parked as awaiting_manual, open a pending stage review
 * if the step declares review: or policy requires review for this task/channel.
 *
 * Idempotent for an already-pending or already-authorized review for this stage.
 * Safe to call from every park path (channel execute + pipeline dataflow).
 */
export function ensureStageReviewOnManualTaskPark(input: {
  db: any;
  record: Record<string, unknown>;
  step: Record<string, unknown> | null | undefined;
  projectConfig?: PolicyConfigLike;
  stageId: string;
  stepKind?: string | null;
  taskType?: string | null;
  channel?: string | null;
  assetForStep?: { asset_id?: string } | null;
  activeContactId?: string | null;
  /** When false, skip persist of failure audit (still returns error). Default true. */
  persist?: boolean;
}): ManualTaskParkReviewResult {
  const {
    db,
    step,
    projectConfig,
    stageId,
    assetForStep = null,
    persist = true,
  } = input;
  let record = input.record;

  const stepKind = text(input.stepKind || step?.kind, 'manual_task');
  const taskType = text(
    input.taskType
    || (step?.config as any)?.task_type
    || (step?.config as any)?.taskType,
  );
  const channel = text(
    input.channel
    || (step?.config as any)?.channel,
  ).toLowerCase();
  const activeContactId = text(
    input.activeContactId
    || record.active_contact_id
    || record.contact_id,
  ) || null;

  try {
    const presentation = resolveReviewPresentation({
      step,
      record,
    });
    const hasDeclaredReview = Boolean(presentation);
    const policyTokens = reviewRequiredTokens(projectConfig);
    const taskKey = taskType.toLowerCase();
    const mailTreatment = text(record.mail_treatment).toLowerCase();
    // Align with completeManualTask: policy may list the campaign product
    // (e.g. golden_ticket) while the step's task_type is a different label
    // (e.g. standard_postcard). Also honor a bare "mail" token.
    const policyRequiresReview =
      isReviewRequired(projectConfig, stepKind, taskType)
      || (channel === 'mail' && (
        policyTokens.has('mail')
        || (taskKey && policyTokens.has(taskKey))
        || (mailTreatment && mailTreatment !== 'none' && policyTokens.has(mailTreatment))
      ));

    if (!hasDeclaredReview && !policyRequiresReview) {
      return {
        record,
        opened: false,
        reason: 'review_not_required',
        error: null,
      };
    }

    const actionType = taskType || stepKind || 'manual_task';
    const reviewChannel = channel || null;
    const bodyText = text(
      record.mail_copy
      || record.mail_body
      || record.preliminary_snapshot
      || record.invite_message,
    );
    const recipient = text(
      (channel === 'mail'
        ? (record.address || record.contact_email)
        : '')
      || record.address
      || record.contact_email
      || record.linkedin_url
      || record.contact_linkedin,
    );
    const assetVersion = materialAssetVersion({
      record,
      stageId,
      assetForStep,
      policyVersion: projectConfig?.policy?.version,
      recipient,
      bodyText: bodyText || null,
      activeContactId,
      reviewPresentation: presentation,
    });

    const invalidated = persistMaterialInvalidation({
      db,
      record,
      stageId,
      currentAssetVersion: assetVersion,
      channel: reviewChannel,
      actionType,
      contactId: activeContactId,
      presentation,
    });
    // Material rebind already opened a pending review — do not thrash.
    if (invalidated.blocked) {
      return {
        record: invalidated.record,
        opened: true,
        reason: 'material_invalidation_rebound',
        error: null,
      };
    }

    record = invalidated.record;
    const stageKeys = [
      stageId,
      taskType,
      stepKind,
      channel || null,
      mailTreatment && mailTreatment !== 'none' ? mailTreatment : null,
    ];
    const stageStore = parseStageReviewStore(record.stage_review_json);
    const pendingForStage = stageStore.reviews.some((r) => {
      const st = text(r.status).toLowerCase();
      if (st !== 'pending' && st !== 'edited') return false;
      return stageKeys.some((key) => {
        const k = text(key).toLowerCase();
        if (!k) return false;
        return (
          text(r.stage_id).toLowerCase() === k
          || text(r.action_type).toLowerCase() === k
        );
      });
    });
    if (pendingForStage) {
      return {
        record,
        opened: false,
        reason: 'pending_for_stage',
        error: null,
      };
    }
    const alreadyAuthorized = isAuthorizedForAnyOf(
      record,
      stageKeys,
      assetVersion,
    );
    if (alreadyAuthorized) {
      return {
        record,
        opened: false,
        reason: 'already_authorized',
        error: null,
      };
    }

    const paused = persistStageReviewPause({
      db,
      record,
      stageId,
      assetVersion,
      channel: reviewChannel,
      actionType,
      contactId: activeContactId,
      reason:
        `Stage review required before manual task `
        + `${taskType || stageId}`,
      presentation,
    });
    if (!paused.allowed) {
      // Required review did not open — visible refusal, still fail-closed.
      const err = `pause_refused:${paused.pauseReason}`;
      const failed = persist
        ? recordOpenFailure({ db, record: paused.record, stageId, error: err })
        : paused.record;
      return {
        record: failed,
        opened: false,
        reason: 'pause_refused',
        error: err,
      };
    }
    return {
      record: paused.record,
      opened: true,
      reason: 'inserted',
      error: null,
    };
  } catch (err) {
    const message = String((err as Error)?.message || err || 'unknown_error');
    const failed = persist
      ? recordOpenFailure({ db, record, stageId, error: message })
      : record;
    return {
      record: failed,
      opened: false,
      reason: 'exception',
      error: message,
    };
  }
}
