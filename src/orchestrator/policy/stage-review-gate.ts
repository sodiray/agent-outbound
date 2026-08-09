/**
 * Runtime gate for config.policy.review_required_for.
 *
 * Design invariant: no meaningful external interaction for kinds listed in
 * review_required_for without current version-bound authorization.
 *
 * Phase A1 (MIS-835) slice:
 * - linkedin_connect: hard-block unless stage_review_json is authorized for the stage
 * - send_email: ready draft (interim approval artifact) OR authorized stage review
 * - pipeline-declared mail products: call the same helpers when mail is automated;
 *   today mail parks as manual_task and is not auto-sent here
 *
 * asset_version is a material fingerprint (account, contact, recipient, content/claim,
 * step). On external send, recompute current version and refuse when authorized review
 * is bound to a different fingerprint — see invalidateStageReviewIfAssetChanged.
 */

import { stableHash } from '../lib/record.js';
import {
  parseStageReviewJson,
  type StageReviewAuthorization,
} from './transition-audit.js';
import type { ResolvedReviewPresentation } from './review-presentation.js';

export type PolicyConfigLike = {
  policy?: {
    review_required_for?: string[] | null;
    version?: string | null;
  } | null;
} | null | undefined;

const normalizeToken = (value: string | null | undefined): string =>
  String(value || '').trim().toLowerCase();

/** Tokens from policy.review_required_for (lowercased). Empty when unset. */
export function reviewRequiredTokens(config: PolicyConfigLike): Set<string> {
  const list = config?.policy?.review_required_for;
  if (!Array.isArray(list) || list.length === 0) return new Set();
  return new Set(
    list
      .map((item) => normalizeToken(item))
      .filter(Boolean),
  );
}

/**
 * True when policy.review_required_for includes this step kind and/or task type.
 * Removing a token from the config list must change runtime behavior.
 */
export function isReviewRequired(
  config: PolicyConfigLike,
  stepKind: string | null | undefined,
  taskType?: string | null,
): boolean {
  const tokens = reviewRequiredTokens(config);
  if (tokens.size === 0) return false;
  const kind = normalizeToken(stepKind);
  const task = normalizeToken(taskType);
  if (kind && tokens.has(kind)) return true;
  if (task && tokens.has(task)) return true;
  return false;
}

/**
 * True when stage_review_json is authorized for this stage (and asset version when given).
 * Accepts stage_id match against review.stage_id or review.action_type so callers can
 * pass either the sequence step id or the step kind (e.g. linkedin_connect).
 */
export function isAuthorizedForStep(
  record: Record<string, unknown> | null | undefined,
  stageId: string | null | undefined,
  assetVersion?: string | null,
): boolean {
  const review = parseStageReviewJson(record?.stage_review_json);
  if (!review) return false;
  if (review.status !== 'authorized') return false;

  const stage = String(stageId || '').trim();
  if (stage) {
    const stageKey = stage.toLowerCase();
    const reviewStage = String(review.stage_id || '').trim().toLowerCase();
    const reviewAction = String(review.action_type || '').trim().toLowerCase();
    if (reviewStage !== stageKey && reviewAction !== stageKey) {
      return false;
    }
  }

  if (assetVersion != null && String(assetVersion).trim() !== '') {
    if (String(review.asset_version) !== String(assetVersion)) return false;
  }

  return true;
}

/** True when a ready draft may stand in as the email authorization artifact (this slice). */
export function isEmailDraftAuthorization(hasReadyDraft: boolean): boolean {
  return Boolean(hasReadyDraft);
}

export type ExternalActionAuthDecision = {
  /** True when the external action may proceed. */
  allowed: boolean;
  reason: string;
  reviewRequired: boolean;
  stageAuthorized: boolean;
  /** Email-only interim: ready draft treated as approval for this phase. */
  emailDraftAuthorized: boolean;
  /** Existing stage review packet (if any). */
  existing: StageReviewAuthorization | null;
  /** True when caller should create/refresh a pending pauseForStageReview. */
  needsPendingReview: boolean;
};

/**
 * Decide whether an external action (email / linkedin / mail product) may run under
 * policy.review_required_for.
 *
 * - Not in list → allowed
 * - linkedin / mail: require authorized stage review (no draft interim)
 * - email: authorized stage review OR ready draft (interim)
 */
export function evaluateExternalActionAuthorization(input: {
  config: PolicyConfigLike;
  record: Record<string, unknown> | null | undefined;
  stepKind: string | null | undefined;
  taskType?: string | null;
  /** Prefer sequence step id; kind is also accepted by isAuthorizedForStep. */
  stageId: string;
  assetVersion?: string | null;
  /** When true, ready draft counts as email authorization for this slice. */
  hasReadyDraft?: boolean;
  channel?: string | null;
}): ExternalActionAuthDecision {
  const kind = normalizeToken(input.stepKind);
  const task = normalizeToken(input.taskType);
  const channel = normalizeToken(input.channel);
  const reviewRequired = isReviewRequired(input.config, input.stepKind, input.taskType);
  const existing = parseStageReviewJson(input.record?.stage_review_json);

  if (!reviewRequired) {
    return {
      allowed: true,
      reason: 'review_not_required',
      reviewRequired: false,
      stageAuthorized: false,
      emailDraftAuthorized: false,
      existing,
      needsPendingReview: false,
    };
  }

  const stageAuthorized =
    isAuthorizedForStep(input.record, input.stageId, input.assetVersion)
    || isAuthorizedForStep(input.record, kind, input.assetVersion)
    || (task ? isAuthorizedForStep(input.record, task, input.assetVersion) : false);

  const isEmail =
    kind === 'send_email'
    || channel === 'email'
    || kind === 'email';
  const emailDraftAuthorized = isEmail && isEmailDraftAuthorization(Boolean(input.hasReadyDraft));

  if (stageAuthorized || emailDraftAuthorized) {
    return {
      allowed: true,
      reason: stageAuthorized ? 'stage_review_authorized' : 'email_ready_draft_authorization',
      reviewRequired: true,
      stageAuthorized,
      emailDraftAuthorized,
      existing,
      needsPendingReview: false,
    };
  }

  // Pending review already open for this stage → wait; do not thrash a new review.
  const pendingForStage = Boolean(
    existing
    && (existing.status === 'pending' || existing.status === 'edited')
    && (
      !String(input.stageId || '').trim()
      || normalizeToken(existing.stage_id) === normalizeToken(input.stageId)
      || normalizeToken(existing.action_type) === kind
      || (task && normalizeToken(existing.action_type) === task)
    ),
  );

  return {
    allowed: false,
    reason: isEmail
      ? 'stage_review_or_draft_approval_required'
      : 'stage_review_required',
    reviewRequired: true,
    stageAuthorized: false,
    emailDraftAuthorized: false,
    existing,
    needsPendingReview: !pendingForStage,
  };
}

/**
 * Resolve a material asset_version fingerprint for stage-review binding.
 *
 * Composition (included when non-empty) so review is bound to the exact outbound
 * identity and content about to execute:
 * - account_id
 * - active_contact_id (falls back to contact_id)
 * - recipient (email / linkedin / mail address)
 * - content: **exact body/subject first** (email, LinkedIn invite, mail copy).
 * - step_id (falls back to stageId)
 *
 * When any material field is present the result is `srv1:<sha256>` of a stable
 * key-ordered bag — pause and send must call this with the same sources so a
 * change to account, contact, recipient, content, or step invalidates auth.
 *
 * Sparse fallback (no identity/content available): assetId → draftId →
 * policyVersion:stageId → stage:stageId (legacy pragmatic bind).
 */
export function resolveStageAssetVersion(input: {
  assetId?: string | null;
  draftId?: string | null;
  stageId?: string | null;
  policyVersion?: string | null;
  /** Account / record id bound into the review. */
  accountId?: string | null;
  /** Preferred contact pin (campaign active contact). */
  activeContactId?: string | null;
  contactId?: string | null;
  /** Recipient address / handle for the channel about to fire. */
  recipient?: string | null;
  /** Sending mailbox / from-address — must invalidate review when changed. */
  sender?: string | null;
  /** Exact mailbox id — two mailboxes sharing a from-address must not interchange. */
  mailboxId?: string | null;
  /** Precomputed content fingerprint. */
  contentHash?: string | null;
  /** Raw copy — preferred content source for email / LI / mail. */
  bodyText?: string | null;
  subjectText?: string | null;
  templateHash?: string | null;
  /** Resolved review fields are material so later changes invalidate authorization. */
  reviewPresentation?: ResolvedReviewPresentation | null;
  stepId?: string | null;
}): string {
  const step = String(input.stepId || input.stageId || '').trim();
  const account = String(input.accountId || '').trim();
  const contact = String(input.activeContactId || input.contactId || '').trim();
  const recipient = String(input.recipient || '').trim().toLowerCase();
  const sender = String(input.sender || '').trim().toLowerCase();
  const mailboxId = String(input.mailboxId || '').trim();

  const bodyParts = [
    String(input.subjectText || '').trim(),
    String(input.bodyText || '').trim(),
    String(input.templateHash || '').trim(),
  ].filter(Boolean);
  const bodyHash = bodyParts.length > 0 ? stableHash(bodyParts.join('\n')) : '';
  const explicitContent = String(input.contentHash || '').trim();
  let content = '';
  if (bodyHash) {
    content = bodyHash;
  } else if (explicitContent) {
    content = explicitContent;
  }
  if (!content) {
    const asset = String(input.assetId || '').trim();
    if (asset) content = asset;
  }
  if (!content) {
    const draft = String(input.draftId || '').trim();
    if (draft) content = draft;
  }

  const material: Record<string, string> = {};
  if (account) material.account = account;
  if (contact) material.contact = contact;
  if (recipient) material.recipient = recipient;
  if (sender) material.sender = sender;
  if (mailboxId) material.mailbox = mailboxId;
  if (step) material.step = step;
  if (content) material.content = content;
  if (input.reviewPresentation) {
    material.review_presentation = stableHash(input.reviewPresentation);
  }

  if (Object.keys(material).length > 0) {
    return `srv1:${stableHash(material)}`;
  }

  // Legacy pragmatic fallback when no material identity/content is available.
  const asset = String(input.assetId || '').trim();
  if (asset) return asset;
  const draft = String(input.draftId || '').trim();
  if (draft) return draft;
  const stage = String(input.stageId || '').trim() || 'stage';
  const policy = String(input.policyVersion || '').trim();
  return policy ? `${policy}:${stage}` : `stage:${stage}`;
}
