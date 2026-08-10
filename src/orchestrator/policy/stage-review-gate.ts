/**
 * Runtime gate for config.policy.review_required_for.
 *
 * Design invariant: no meaningful external interaction for kinds listed in
 * review_required_for without current version-bound authorization.
 *
 * Phase A1 (MIS-835) slice:
 * - linkedin_connect: hard-block unless stage_review_json is authorized for the stage
 * - send_email: ready draft (interim approval artifact) OR authorized stage review
 * - manual_task with a declared review: block (or policy.review_required_for): parks
 *   as awaiting_manual and opens a pending stage review (same pauseForStageReview
 *   machinery as LinkedIn). Not auto-sent; complete still requires authorization.
 *
 * asset_version is a material fingerprint (account, contact, recipient, content/claim,
 * step). On external send, recompute current version and refuse when authorized review
 * is bound to a different fingerprint — see invalidateStageReviewIfAssetChanged.
 */

import { stableHash } from '../lib/record.js';
import {
  findStageReviewInStore,
  isOpenStageReviewStatus,
  parseStageReviewJson,
  parseStageReviewStore,
  stageReviewMatchesKeys,
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
 * True when stage_review_json holds an authorized review for this stage
 * (and asset version when given). Scans all operative reviews on the record
 * so an authorization for step X never satisfies step Y.
 * Accepts stage_id match against review.stage_id or review.action_type so callers can
 * pass either the sequence step id or the step kind (e.g. linkedin_connect).
 */
export function isAuthorizedForStep(
  record: Record<string, unknown> | null | undefined,
  stageId: string | null | undefined,
  assetVersion?: string | null,
): boolean {
  const store = parseStageReviewStore(record?.stage_review_json);
  if (store.reviews.length === 0) return false;

  const stage = String(stageId || '').trim();
  const candidates = stage
    ? store.reviews.filter((r) => stageReviewMatchesKeys(r, [stage]))
    : store.reviews;

  for (const review of candidates) {
    if (review.status !== 'authorized') continue;
    if (assetVersion != null && String(assetVersion).trim() !== '') {
      if (String(review.asset_version) !== String(assetVersion)) continue;
    }
    return true;
  }
  return false;
}

/**
 * True when authorized for any of the given stage identity keys.
 *
 * When assetVersion is supplied, also requires an exact material fingerprint match
 * (via isAuthorizedForStep). Shared by allow paths and refusal diagnostics so
 * "is this review for this stage?" cannot drift between them.
 */
export function isAuthorizedForAnyOf(
  record: Record<string, unknown> | null | undefined,
  stageKeys: Array<string | null | undefined>,
  assetVersion?: string | null,
): boolean {
  for (const key of stageKeys) {
    // Empty key would skip stage matching inside isAuthorizedForStep (any
    // authorized review would match). Never treat blank as an identity key.
    if (!String(key || '').trim()) continue;
    if (isAuthorizedForStep(record, key, assetVersion)) return true;
  }
  return false;
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
  const store = parseStageReviewStore(input.record?.stage_review_json);
  // Same identity key set for allow and refusal diagnostics (stage id, kind, task).
  const stageKeys = [input.stageId, kind, task || null];
  const existing =
    findStageReviewInStore(store, stageKeys)
    || parseStageReviewJson(input.record?.stage_review_json);

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

  const stageAuthorized = isAuthorizedForAnyOf(input.record, stageKeys, input.assetVersion);

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
  const pendingForStage = store.reviews.some(
    (r) =>
      isOpenStageReviewStatus(r.status)
      && (
        !String(input.stageId || '').trim()
        || stageReviewMatchesKeys(r, stageKeys)
      ),
  );

  // A genuine open review for a *different* stage must not be overwritten.
  // Refuse a second pending open (fail closed); do not set needsPendingReview.
  const pendingOtherStage = store.reviews.find(
    (r) =>
      isOpenStageReviewStatus(r.status)
      && String(input.stageId || '').trim()
      && !stageReviewMatchesKeys(r, stageKeys),
  );

  // Authorized for this stage identity but wrong material version → content changed.
  // An authorization for a *different* stage is not a version drift: fall through
  // to "stage review required" (there is no review for this stage to re-check).
  // Only meaningful when a current asset version was supplied for binding.
  const hasBoundAssetVersion =
    input.assetVersion != null && String(input.assetVersion).trim() !== '';
  const authorizedForStageIdentity =
    hasBoundAssetVersion && isAuthorizedForAnyOf(input.record, stageKeys);

  if (pendingOtherStage && !pendingForStage) {
    return {
      allowed: false,
      reason: `stage_review_pending_other_stage:${pendingOtherStage.stage_id}`,
      reviewRequired: true,
      stageAuthorized: false,
      emailDraftAuthorized: false,
      existing: pendingOtherStage,
      needsPendingReview: false,
    };
  }

  return {
    allowed: false,
    reason: authorizedForStageIdentity
      ? 'stage_review_asset_version_mismatch'
      : isEmail
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
  /**
   * Resolved review fields are material only when exact sendable copy is not
   * already fingerprinting content. Intermediate present fields (e.g. friction
   * lines that fed a template) must not re-bind a pending review to live record
   * values while the draft body stays frozen — that is the authorization-
   * integrity bug presentation_authorization_gate closes at authorize time.
   * When body/subject are present they are the sendable artifact.
   */
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
  // Include presentation hash only when it is the content standing in for a
  // body — never alongside exact subject/body (those already bind the send).
  if (input.reviewPresentation && !bodyHash) {
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
