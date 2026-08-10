/**
 * Phase A1 — stage-review gate (policy.review_required_for) + executeChannelStep wiring.
 *
 * Bug classes:
 * - isReviewRequired mismatches kind/taskType or ignores empty list → wrong gate.
 * - linkedin_connect listed but no stage auth still sends (or fails to pause_review).
 * - authorized stage_review_json still hard-blocks after authorizeStageReview.
 * - send_email listed with no draft/auth still sends; ready draft should allow.
 * - Removing a token from review_required_for leaves the gate sticky (config not live).
 *
 * Pure unit tests + executeChannelStep non-dryRun early returns (no live Unipile/SMTP).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  isReviewRequired,
  reviewRequiredTokens,
  evaluateExternalActionAuthorization,
  isAuthorizedForStep,
  resolveStageAssetVersion,
} from '../dist/orchestrator/policy/stage-review-gate.js';
import {
  pauseForStageReview,
  authorizeStageReview,
  parseStageReviewJson,
  parseStageReviewStore,
  findStageReview,
  invalidateStageReviewIfAssetChanged,
  listPendingStageReviews,
  STAGE_REVIEWS_STORE_VERSION,
} from '../dist/orchestrator/policy/transition-audit.js';
import {
  stageReviewAuthorizeCommand,
  stageReviewListCommand,
} from '../dist/commands/stage-review.js';
import { presentationAuthorizationGate } from '../dist/orchestrator/policy/review-presentation.js';
import { openListDb, ensureRecordColumns, insertDraft, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';
import { completeManualTask } from '../dist/orchestrator/pipeline/manual.js';
import { runPipelineDataflow } from '../dist/orchestrator/pipeline/dataflow.js';
import { buildContactPlan } from '../dist/orchestrator/policy/contact-campaign.js';
import { NEXT_ACTION_POLICY_VERSION } from '../dist/orchestrator/policy/lifecycle.js';
import { ensureStageReviewOnManualTaskPark } from '../dist/orchestrator/policy/manual-task-stage-review.js';

/** Mirror execute currentStageAssetVersion composition for seed/authorize parity. */
const materialAssetVersion = ({
  record,
  stageId,
  recipient,
  bodyText,
  subjectText,
  draftId,
  assetId,
  policyVersion,
} = {}) => {
  return resolveStageAssetVersion({
    accountId: String(record?._row_id || record?.id || record?.account_id || ''),
    activeContactId: String(record?.active_contact_id || record?.contact_id || '') || null,
    contactId: String(record?.contact_id || '') || null,
    recipient: recipient
      ?? String(record?.contact_email || record?.email || record?.linkedin_url || ''),
    stepId: stageId,
    stageId,
    assetId: assetId ?? null,
    draftId: draftId ?? null,
    policyVersion: policyVersion ?? null,
    bodyText: bodyText ?? 'Hello — I would be glad to connect.',
    subjectText: subjectText ?? null,
  });
};

// --- Pure: isReviewRequired ------------------------------------------------

test('isReviewRequired: empty / missing list never requires review', () => {
  assert.equal(isReviewRequired(null, 'linkedin_connect'), false);
  assert.equal(isReviewRequired({}, 'send_email'), false);
  assert.equal(isReviewRequired({ policy: {} }, 'linkedin_connect'), false);
  assert.equal(isReviewRequired({ policy: { review_required_for: [] } }, 'send_email'), false);
  assert.equal(isReviewRequired({ policy: { review_required_for: null } }, 'linkedin_connect'), false);
  assert.equal(reviewRequiredTokens({ policy: { review_required_for: [] } }).size, 0);
});

test('isReviewRequired: match/mismatch on kind and taskType (table)', () => {
  const config = {
    policy: {
      review_required_for: ['linkedin_connect', 'send_email', 'golden_ticket'],
    },
  };

  const cases = [
    { kind: 'linkedin_connect', task: null, expected: true },
    { kind: 'LinkedIn_Connect', task: null, expected: true }, // case-insensitive
    { kind: 'send_email', task: null, expected: true },
    { kind: 'manual_task', task: 'golden_ticket', expected: true },
    { kind: 'manual_task', task: 'human_phone', expected: false },
    { kind: 'send_sms', task: null, expected: false },
    { kind: null, task: 'send_email', expected: true },
    { kind: '', task: '', expected: false },
    { kind: 'other', task: 'other', expected: false },
  ];

  for (const c of cases) {
    assert.equal(
      isReviewRequired(config, c.kind, c.task),
      c.expected,
      JSON.stringify(c),
    );
  }
});

test('isReviewRequired: removing linkedin_connect from list changes gate (config is live)', () => {
  const withLinkedin = {
    policy: { review_required_for: ['linkedin_connect', 'send_email'] },
  };
  const withoutLinkedin = {
    policy: { review_required_for: ['send_email'] },
  };
  assert.equal(isReviewRequired(withLinkedin, 'linkedin_connect'), true);
  assert.equal(isReviewRequired(withoutLinkedin, 'linkedin_connect'), false);
  // send_email still gated under the reduced list
  assert.equal(isReviewRequired(withoutLinkedin, 'send_email'), true);

  const blocked = evaluateExternalActionAuthorization({
    config: withLinkedin,
    record: {},
    stepKind: 'linkedin_connect',
    stageId: 'linkedin_1',
    channel: 'linkedin',
  });
  const open = evaluateExternalActionAuthorization({
    config: withoutLinkedin,
    record: {},
    stepKind: 'linkedin_connect',
    stageId: 'linkedin_1',
    channel: 'linkedin',
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'stage_review_required');
  assert.equal(open.allowed, true);
  assert.equal(open.reason, 'review_not_required');
});

// --- Pure: evaluateExternalActionAuthorization -----------------------------

test('evaluateExternalActionAuthorization: linkedin no auth → blocked + needsPendingReview', () => {
  const decision = evaluateExternalActionAuthorization({
    config: { policy: { review_required_for: ['linkedin_connect'] } },
    record: {},
    stepKind: 'linkedin_connect',
    stageId: 'linkedin_1',
    channel: 'linkedin',
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reviewRequired, true);
  assert.equal(decision.needsPendingReview, true);
  assert.equal(decision.reason, 'stage_review_required');
  // No draft interim for LinkedIn
  assert.equal(decision.emailDraftAuthorized, false);
});

test('evaluateExternalActionAuthorization: authorized stage_review_json allows linkedin', () => {
  const paused = pauseForStageReview({
    account_id: 'acct_li_auth',
    stage_id: 'linkedin_1',
    asset_version: 'av_li_1',
    contact_id: 'c_owner',
    channel: 'linkedin',
    action_type: 'linkedin_connect',
    pending_action: {
      action_type: 'linkedin_connect',
      account_id: 'acct_li_auth',
      contact_id: 'c_owner',
    },
    lifecycle_stage: 'contacted',
    reason: 'review before connect',
  });
  const authorized = authorizeStageReview({
    review_id: paused.authorization.review_id,
    stage_id: 'linkedin_1',
    asset_version: 'av_li_1',
    expected_asset_version: 'av_li_1',
    decision: 'authorize',
    account_id: 'acct_li_auth',
    existing: paused.authorization,
    lifecycle_stage: 'contacted',
    actor: 'operator_a',
  });
  assert.equal(authorized.allowed, true);
  assert.equal(authorized.authorization.status, 'authorized');

  const record = {
    stage_review_json: authorized.patch.stage_review_json,
  };
  assert.equal(isAuthorizedForStep(record, 'linkedin_1'), true);

  const decision = evaluateExternalActionAuthorization({
    config: { policy: { review_required_for: ['linkedin_connect'] } },
    record,
    stepKind: 'linkedin_connect',
    stageId: 'linkedin_1',
    channel: 'linkedin',
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.stageAuthorized, true);
  assert.equal(decision.reason, 'stage_review_authorized');
  assert.equal(decision.needsPendingReview, false);
});

test('evaluateExternalActionAuthorization: send_email no draft/auth blocked; ready draft allows', () => {
  const config = { policy: { review_required_for: ['send_email'] } };
  const stageId = 'email_1';

  const noAuth = evaluateExternalActionAuthorization({
    config,
    record: {},
    stepKind: 'send_email',
    stageId,
    channel: 'email',
    hasReadyDraft: false,
  });
  assert.equal(noAuth.allowed, false);
  assert.equal(noAuth.reason, 'stage_review_or_draft_approval_required');
  assert.equal(noAuth.needsPendingReview, true);

  const withDraft = evaluateExternalActionAuthorization({
    config,
    record: {},
    stepKind: 'send_email',
    stageId,
    channel: 'email',
    hasReadyDraft: true,
  });
  assert.equal(withDraft.allowed, true);
  assert.equal(withDraft.emailDraftAuthorized, true);
  assert.equal(withDraft.reason, 'email_ready_draft_authorization');
});

// --- Refusal diagnostics: version drift vs no review (same allow set) ------

/**
 * Build an authorized stage_review_json for the given stage/version.
 * Pure evaluate tests only — no DB.
 */
const authorizedReviewRecord = ({
  stageId,
  assetVersion,
  actionType = 'linkedin_connect',
  channel = 'linkedin',
  accountId = 'acct_eval_diag',
} = {}) => {
  const paused = pauseForStageReview({
    account_id: accountId,
    stage_id: stageId,
    asset_version: assetVersion,
    contact_id: 'c_owner',
    channel,
    action_type: actionType,
    pending_action: {
      action_type: actionType,
      account_id: accountId,
      contact_id: 'c_owner',
    },
    lifecycle_stage: 'contacted',
    reason: 'review for eval diagnostic',
  });
  const authorized = authorizeStageReview({
    review_id: paused.authorization.review_id,
    stage_id: stageId,
    asset_version: assetVersion,
    expected_asset_version: assetVersion,
    decision: 'authorize',
    account_id: accountId,
    existing: paused.authorization,
    lifecycle_stage: 'contacted',
    actor: 'operator_diag',
  });
  assert.equal(authorized.allowed, true);
  return { stage_review_json: authorized.patch.stage_review_json };
};

test('evaluateExternalActionAuthorization: authorized for stage with drifted asset_version → content-changed reason', () => {
  const stageId = 'linkedin_1';
  const record = authorizedReviewRecord({
    stageId,
    assetVersion: 'av_bound_stale',
    actionType: 'linkedin_connect',
  });

  const decision = evaluateExternalActionAuthorization({
    config: { policy: { review_required_for: ['linkedin_connect'] } },
    record,
    stepKind: 'linkedin_connect',
    stageId,
    assetVersion: 'av_current_after_edit',
    channel: 'linkedin',
  });

  assert.equal(decision.allowed, false, 'drifted version must still refuse');
  assert.equal(
    decision.reason,
    'stage_review_asset_version_mismatch',
    'must name content/version change so operator re-authorizes the current asset',
  );
  assert.notEqual(decision.reason, 'stage_review_required');
});

test('evaluateExternalActionAuthorization: no review at all → stage_review_required (unchanged)', () => {
  const decision = evaluateExternalActionAuthorization({
    config: { policy: { review_required_for: ['linkedin_connect'] } },
    record: {},
    stepKind: 'linkedin_connect',
    stageId: 'linkedin_1',
    assetVersion: 'av_any',
    channel: 'linkedin',
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'stage_review_required');
  assert.notEqual(decision.reason, 'stage_review_asset_version_mismatch');
});

test('evaluateExternalActionAuthorization CONTROL: correct stage + version still PASSES', () => {
  const stageId = 'linkedin_1';
  const assetVersion = 'av_current_ok';
  const record = authorizedReviewRecord({
    stageId,
    assetVersion,
    actionType: 'linkedin_connect',
  });

  const decision = evaluateExternalActionAuthorization({
    config: { policy: { review_required_for: ['linkedin_connect'] } },
    record,
    stepKind: 'linkedin_connect',
    stageId,
    assetVersion,
    channel: 'linkedin',
  });

  assert.equal(decision.allowed, true, 'must not change the allow set — only refusal reasons');
  assert.equal(decision.stageAuthorized, true);
  assert.equal(decision.reason, 'stage_review_authorized');
});

test('evaluateExternalActionAuthorization CONTROL: other-stage auth is not version drift', () => {
  // Authorized only for a LinkedIn stage; evaluating email must not claim
  // "content changed" — there is no email review to re-check.
  const record = authorizedReviewRecord({
    stageId: 'linkedin_1',
    assetVersion: 'av_li_only',
    actionType: 'linkedin_connect',
    channel: 'linkedin',
  });

  const decision = evaluateExternalActionAuthorization({
    config: { policy: { review_required_for: ['send_email', 'linkedin_connect'] } },
    record,
    stepKind: 'send_email',
    stageId: 'email_1',
    assetVersion: 'av_email_current',
    channel: 'email',
    hasReadyDraft: false,
  });

  assert.equal(decision.allowed, false);
  assert.equal(
    decision.reason,
    'stage_review_or_draft_approval_required',
    'wrong-stage authorization is "create a review", not "content changed"',
  );
  assert.notEqual(decision.reason, 'stage_review_asset_version_mismatch');
});

// --- Material asset_version composition + invalidate helper -----------------

test('resolveStageAssetVersion: material fields change fingerprint; sparse fallback stable', () => {
  const base = {
    accountId: 'acct_m',
    activeContactId: 'c1',
    recipient: 'a@example.com',
    stepId: 'email_1',
    bodyText: 'Approved body A',
  };
  const vA = resolveStageAssetVersion(base);
  const vB = resolveStageAssetVersion({ ...base, bodyText: 'Approved body B' });
  const vContact = resolveStageAssetVersion({ ...base, activeContactId: 'c2' });
  const vRecipient = resolveStageAssetVersion({ ...base, recipient: 'b@example.com' });
  assert.match(vA, /^srv1:[a-f0-9]{64}$/);
  assert.notEqual(vA, vB, 'content change must invalidate');
  assert.notEqual(vA, vContact, 'contact change must invalidate');
  assert.notEqual(vA, vRecipient, 'recipient change must invalidate');
  // Same inputs → same version
  assert.equal(vA, resolveStageAssetVersion(base));
  // Step alone is still material (srv1 hash); empty inputs use legacy pragmatic bind.
  const stepOnly = resolveStageAssetVersion({
    stageId: 'linkedin_1',
    policyVersion: 'tv-pipeline-v1',
  });
  assert.match(stepOnly, /^srv1:[a-f0-9]{64}$/);
  assert.equal(
    resolveStageAssetVersion({ policyVersion: 'tv-pipeline-v1' }),
    'tv-pipeline-v1:stage',
  );
  assert.equal(resolveStageAssetVersion({}), 'stage:stage');
});

test('invalidateStageReviewIfAssetChanged: authorized A + current B → invalidate + re-pause pending B', () => {
  const recordBase = {
    _row_id: 'acct_mat',
    active_contact_id: 'c_owner',
    contact_email: 'mat@example.com',
    lifecycle_stage: 'contacted',
  };
  const versionA = materialAssetVersion({
    record: { ...recordBase, linkedin_message: 'Message A' },
    stageId: 'linkedin_1',
    bodyText: 'Message A',
  });
  const versionB = materialAssetVersion({
    record: { ...recordBase, linkedin_message: 'Message B' },
    stageId: 'linkedin_1',
    bodyText: 'Message B',
  });
  assert.notEqual(versionA, versionB);

  const paused = pauseForStageReview({
    account_id: 'acct_mat',
    stage_id: 'linkedin_1',
    asset_version: versionA,
    contact_id: 'c_owner',
    channel: 'linkedin',
    action_type: 'linkedin_connect',
    pending_action: { action_type: 'linkedin_connect', account_id: 'acct_mat' },
    lifecycle_stage: 'contacted',
  });
  const authorized = authorizeStageReview({
    review_id: paused.authorization.review_id,
    stage_id: 'linkedin_1',
    asset_version: versionA,
    expected_asset_version: versionA,
    decision: 'authorize',
    account_id: 'acct_mat',
    existing: paused.authorization,
    lifecycle_stage: 'contacted',
    actor: 'op',
  });
  assert.equal(authorized.allowed, true);
  assert.equal(authorized.authorization.status, 'authorized');

  const record = {
    ...recordBase,
    stage_review_json: authorized.patch.stage_review_json,
    linkedin_message: 'Message B',
  };
  const result = invalidateStageReviewIfAssetChanged({
    record,
    stage_id: 'linkedin_1',
    current_asset_version: versionB,
    account_id: 'acct_mat',
    contact_id: 'c_owner',
    channel: 'linkedin',
    action_type: 'linkedin_connect',
    re_pause: true,
  });
  assert.equal(result.changed, true);
  assert.equal(result.invalidated, true);
  assert.ok(result.patch?.stage_review_json);
  const after = parseStageReviewJson(result.patch.stage_review_json);
  assert.equal(after.status, 'pending', 're-pause opens pending on new asset');
  assert.equal(after.asset_version, versionB);
  // Matching version is a no-op
  const same = invalidateStageReviewIfAssetChanged({
    record: { stage_review_json: authorized.patch.stage_review_json },
    stage_id: 'linkedin_1',
    current_asset_version: versionA,
  });
  assert.equal(same.invalidated, false);
  assert.equal(same.changed, false);
});

test('invalidateStageReviewIfAssetChanged: pending A + current B → re-bind pending B (never authorizes)', () => {
  const recordBase = {
    _row_id: 'acct_pending_rebind',
    active_contact_id: 'c_owner',
    contact_email: 'pending-rebind@example.com',
    lifecycle_stage: 'contacted',
  };
  const versionA = materialAssetVersion({
    record: { ...recordBase, linkedin_message: 'Pending message A' },
    stageId: 'linkedin_1',
    bodyText: 'Pending message A',
  });
  const versionB = materialAssetVersion({
    record: { ...recordBase, linkedin_message: 'Pending message B' },
    stageId: 'linkedin_1',
    bodyText: 'Pending message B',
  });
  assert.notEqual(versionA, versionB);

  const paused = pauseForStageReview({
    account_id: 'acct_pending_rebind',
    stage_id: 'linkedin_1',
    asset_version: versionA,
    contact_id: 'c_owner',
    channel: 'linkedin',
    action_type: 'linkedin_connect',
    pending_action: { action_type: 'linkedin_connect', account_id: 'acct_pending_rebind' },
    lifecycle_stage: 'contacted',
  });
  assert.equal(paused.authorization.status, 'pending');
  assert.equal(paused.patch.account_sequence_state, 'paused_review');

  const result = invalidateStageReviewIfAssetChanged({
    record: {
      ...recordBase,
      stage_review_json: paused.patch.stage_review_json,
      account_sequence_state: 'paused_review',
      linkedin_message: 'Pending message B',
    },
    stage_id: 'linkedin_1',
    current_asset_version: versionB,
    account_id: 'acct_pending_rebind',
    contact_id: 'c_owner',
    channel: 'linkedin',
    action_type: 'linkedin_connect',
    re_pause: true,
  });
  assert.equal(result.changed, true);
  assert.equal(result.invalidated, true);
  assert.ok(result.patch?.stage_review_json);
  assert.equal(result.patch.account_sequence_state, 'paused_review', 'rebind stays paused');
  const after = parseStageReviewJson(result.patch.stage_review_json);
  assert.equal(after.status, 'pending');
  assert.equal(after.asset_version, versionB);
  assert.notEqual(after.status, 'authorized');
});

// --- executeChannelStep: LinkedIn + email review gates ---------------------

const projectYaml = ({ reviewRequiredFor }) => `
list:
  name: Stage Review Gate Test
business:
  name: Mission
  description: Test
  icp: Test
  offer: Test
pipeline: []
sequences:
  default:
    steps:
      - kind: linkedin_connect
        id: linkedin_1
        day: 0
      - kind: send_email
        id: email_1
        day: 1
policy:
  version: tv-pipeline-v1
  forbidden_channels: [send_sms, visit, field_visit]
  enforce_readiness: false
  review_required_for: ${JSON.stringify(reviewRequiredFor)}
channels:
  email:
    draft_approval_required: false
`;

const nextAction = (accountId, overrides = {}) => ({
  action_id: `na_${accountId}`,
  action_type: overrides.action_type || 'linkedin_connect',
  account_id: accountId,
  contact_id: 'c_owner',
  lifecycle_stage: 'contacted',
  sequence_state: 'active',
  work_state: 'executing_external_action',
  reason: 'test stage review',
  on_success: 'continue',
  policy_version: NEXT_ACTION_POLICY_VERSION,
  ...overrides,
});

const seedList = ({
  rowId = 'acct_review_1',
  reviewRequiredFor = ['linkedin_connect', 'send_email'],
  next_action_json,
  stage_review_json = null,
  account_sequence_state = 'active',
  contact_email = 'seniority@example-review.test',
  active_contact_id = 'c_owner',
} = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-stage-review-'));
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml({ reviewRequiredFor }));
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: [
      'lifecycle_stage',
      'account_sequence_state',
      'work_state',
      'next_action_json',
      'active_contact_id',
      'contact_id',
      'treatment_tier',
      'suppressed',
      'stage_review_json',
      'related_review_id',
      'transition_audit_json',
    ],
  });
  const na =
    next_action_json !== undefined
      ? next_action_json
      : JSON.stringify(nextAction(rowId, { action_type: 'linkedin_connect' }));
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      contact_email, lifecycle_stage, account_sequence_state, work_state, next_action_json,
      active_contact_id, treatment_tier, suppressed, stage_review_json,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      ?, 'Review HVAC', 'default', 'active', 0,
      ?, 'contacted', ?, 'executing_external_action', ?,
      ?, 'B', 0, ?,
      ?, ?, ?, ?
    )
  `).run(
    rowId,
    contact_email,
    account_sequence_state,
    na,
    active_contact_id,
    stage_review_json,
    now,
    now,
    now,
    now,
  );
  return { listDir, db, rowId };
};

const linkedinStep = {
  kind: 'linkedin_connect',
  id: 'linkedin_1',
  config: {
    channel: 'linkedin',
    invite_message: 'Hello — I would be glad to connect.',
    daily_cap: 999,
    idempotency: {
      key_source: ['_row_id', 'step_id'],
      scope: 'list',
    },
  },
};

const emailStep = {
  kind: 'send_email',
  id: 'email_1',
  config: {
    action: 'tool_call',
    tool: { server: 'noop', tools: ['NOOP'] },
    daily_cap: 999,
    idempotency: {
      key_source: ['_row_id', 'step_id'],
      scope: 'list',
    },
  },
};

const runLinkedin = async ({ listDir, db, record, dryRun = false, step = linkedinStep }) =>
  executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Stage Review Gate Test',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step,
    sequence: { steps: [step] },
    channelHint: 'linkedin',
    intent: 'send',
    dryRun,
  });

const runEmail = async ({ listDir, db, record, dryRun = false }) =>
  executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Stage Review Gate Test',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step: emailStep,
    sequence: { steps: [emailStep] },
    channelHint: 'email',
    intent: 'send',
    dryRun,
  });

test('executeChannelStep: linkedin_connect in review_required_for, no auth → skip + paused_review', async () => {
  const { listDir, db, rowId } = seedList({
    rowId: 'acct_li_block',
    reviewRequiredFor: ['linkedin_connect'],
    next_action_json: JSON.stringify(
      nextAction('acct_li_block', { action_type: 'linkedin_connect' }),
    ),
  });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);

  // Gate only runs on live send path (!dryRun).
  const out = await runLinkedin({ listDir, db, record, dryRun: false });
  assert.equal(out.status, 'skipped', JSON.stringify(out));
  assert.match(
    String(out.reason),
    /stage review required before linkedin_connect/i,
    String(out.reason),
  );

  const after = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  assert.equal(after.account_sequence_state, 'paused_review');
  assert.equal(after.work_state, 'pending_human_review');
  const review = parseStageReviewJson(after.stage_review_json);
  assert.ok(review, 'expected pending stage_review_json');
  assert.equal(review.status, 'pending');
  assert.equal(String(review.stage_id), 'linkedin_1');
  assert.equal(String(review.action_type || ''), 'linkedin_connect');

  const na = JSON.parse(after.next_action_json);
  assert.equal(na.action_type, 'pending_human_review');

  db.close();
});

test('executeChannelStep: mail review preserves product identity and resumes canonical send_mail action', async () => {
  const accountId = 'acct_mail_review';
  const { listDir, db, rowId } = seedList({
    rowId: accountId,
    reviewRequiredFor: ['standard_postcard'],
    next_action_json: JSON.stringify(
      nextAction(accountId, { action_type: 'send_mail' }),
    ),
  });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const step = {
    kind: 'manual_task',
    id: 'standard_postcard_1',
    config: {
      task_type: 'standard_postcard',
      channel: 'mail',
    },
  };
  const out = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Stage Review Gate Test',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step,
    sequence: { steps: [step] },
    channelHint: 'mail',
    intent: 'send',
    dryRun: false,
  });
  assert.equal(out.status, 'skipped');
  assert.equal(out.reason, 'awaiting_manual');

  const after = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const review = parseStageReviewJson(after.stage_review_json);
  assert.ok(review);
  assert.equal(review.action_type, 'standard_postcard');
  assert.equal(review.pending_action_snapshot.action_type, 'send_mail');
  db.close();
});

test('executeChannelStep: linkedin after authorizeStageReview proceeds past gate (not review-blocked)', async () => {
  const accountId = 'acct_li_auth_exec';
  // Seed first so material asset_version matches execute's recompute sources.
  const { listDir, db, rowId } = seedList({
    rowId: accountId,
    reviewRequiredFor: ['linkedin_connect'],
    next_action_json: JSON.stringify(
      nextAction(accountId, { action_type: 'linkedin_connect' }),
    ),
  });
  const seeded = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const assetVersion = materialAssetVersion({
    record: seeded,
    stageId: 'linkedin_1',
    policyVersion: 'tv-pipeline-v1',
  });

  const paused = pauseForStageReview({
    account_id: accountId,
    stage_id: 'linkedin_1',
    asset_version: assetVersion,
    contact_id: 'c_owner',
    channel: 'linkedin',
    action_type: 'linkedin_connect',
    pending_action: {
      action_type: 'linkedin_connect',
      account_id: accountId,
      contact_id: 'c_owner',
      lifecycle_stage: 'contacted',
      sequence_state: 'active',
      work_state: 'executing_external_action',
      reason: 'resume after review',
      on_success: 'continue',
      policy_version: NEXT_ACTION_POLICY_VERSION,
    },
    lifecycle_stage: 'contacted',
    reason: 'review before connect',
  });
  const authorized = authorizeStageReview({
    review_id: paused.authorization.review_id,
    stage_id: 'linkedin_1',
    asset_version: assetVersion,
    expected_asset_version: assetVersion,
    decision: 'authorize',
    account_id: accountId,
    existing: paused.authorization,
    lifecycle_stage: 'contacted',
    actor: 'operator_a',
  });
  assert.equal(authorized.allowed, true);

  upsertRecord({
    db,
    row: {
      ...seeded,
      account_sequence_state: authorized.patch.account_sequence_state || 'active',
      work_state: authorized.patch.work_state || 'executing_external_action',
      next_action_json: authorized.patch.next_action_json
        || JSON.stringify(nextAction(accountId, { action_type: 'linkedin_connect' })),
      stage_review_json: authorized.patch.stage_review_json,
      related_review_id: authorized.patch.related_review_id,
    },
  });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);

  // dryRun never hits the review gate; use non-dryRun so authorize is exercised.
  // Without pipeline credentials the path fails closed after the review gate opens.
  const prevFixture = process.env.AO_UNIPILE_FIXTURE;
  delete process.env.AO_UNIPILE_FIXTURE;
  try {
    const out = await runLinkedin({ listDir, db, record, dryRun: false });
    assert.ok(
      !/stage review required/i.test(String(out.reason || '')),
      `still review-gated: ${JSON.stringify(out)}`,
    );
    assert.ok(
      !/asset changed/i.test(String(out.reason || '')),
      `material invalidation on matching version: ${JSON.stringify(out)}`,
    );
    // Missing pipeline credentials are the expected stop after the review gate opens.
    assert.equal(out.status, 'failed');
    assert.match(String(out.reason), /unipile.*UNIPILE_API_KEY.*UNIPILE_DSN/i);

    // Sequence must remain active (authorize path), not re-paused for review.
    const after = db.prepare('SELECT account_sequence_state FROM records WHERE _row_id = ?').get(rowId);
    assert.equal(after.account_sequence_state, 'active');
  } finally {
    if (prevFixture === undefined) delete process.env.AO_UNIPILE_FIXTURE;
    else process.env.AO_UNIPILE_FIXTURE = prevFixture;
  }

  // dryRun also must not re-open review (sanity: authorized record is outbound-capable).
  const dry = await runLinkedin({ listDir, db, record, dryRun: true });
  assert.ok(
    !/stage review required/i.test(String(dry.reason || '')),
    String(dry.reason),
  );

  db.close();
});

test('executeChannelStep: authorized version A + content change → B blocks send and re-pauses', async () => {
  const accountId = 'acct_li_material_change';
  const messageA = 'Approved LinkedIn message A';
  const messageB = 'Updated LinkedIn message B';

  const { listDir, db, rowId } = seedList({
    rowId: accountId,
    reviewRequiredFor: ['linkedin_connect'],
    next_action_json: JSON.stringify(
      nextAction(accountId, { action_type: 'linkedin_connect' }),
    ),
  });
  // Stamp content version A onto the record before authorize.
  const seeded = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  ensureRecordColumns({ db, columns: ['linkedin_message'] });
  upsertRecord({
    db,
    row: { ...seeded, linkedin_message: messageA },
  });
  const withA = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const versionA = materialAssetVersion({
    record: withA,
    stageId: 'linkedin_1',
    policyVersion: 'tv-pipeline-v1',
    bodyText: messageA,
  });

  const paused = pauseForStageReview({
    account_id: accountId,
    stage_id: 'linkedin_1',
    asset_version: versionA,
    contact_id: 'c_owner',
    channel: 'linkedin',
    action_type: 'linkedin_connect',
    pending_action: {
      action_type: 'linkedin_connect',
      account_id: accountId,
      contact_id: 'c_owner',
      lifecycle_stage: 'contacted',
      sequence_state: 'active',
      work_state: 'executing_external_action',
      reason: 'resume after review',
      on_success: 'continue',
      policy_version: NEXT_ACTION_POLICY_VERSION,
    },
    lifecycle_stage: 'contacted',
  });
  const authorized = authorizeStageReview({
    review_id: paused.authorization.review_id,
    stage_id: 'linkedin_1',
    asset_version: versionA,
    expected_asset_version: versionA,
    decision: 'authorize',
    account_id: accountId,
    existing: paused.authorization,
    lifecycle_stage: 'contacted',
    actor: 'operator_a',
  });
  assert.equal(authorized.allowed, true);

  upsertRecord({
    db,
    row: {
      ...withA,
      account_sequence_state: 'active',
      work_state: 'executing_external_action',
      next_action_json: authorized.patch.next_action_json
        || JSON.stringify(nextAction(accountId, { action_type: 'linkedin_connect' })),
      stage_review_json: authorized.patch.stage_review_json,
      linkedin_message: messageA,
    },
  });

  // Material change: outbound copy becomes B → current asset_version drifts.
  const beforeSend = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  upsertRecord({
    db,
    row: { ...beforeSend, linkedin_message: messageB },
  });
  const versionB = materialAssetVersion({
    record: { ...beforeSend, linkedin_message: messageB },
    stageId: 'linkedin_1',
    policyVersion: 'tv-pipeline-v1',
    bodyText: messageB,
  });
  assert.notEqual(versionA, versionB);

  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const prevFixture = process.env.AO_UNIPILE_FIXTURE;
  delete process.env.AO_UNIPILE_FIXTURE;
  try {
    const out = await runLinkedin({
      listDir,
      db,
      record,
      dryRun: false,
      step: {
        ...linkedinStep,
        config: {
          ...linkedinStep.config,
          args_map: { invite_message: 'linkedin_message' },
          invite_message: '',
        },
      },
    });
    assert.equal(out.status, 'skipped', JSON.stringify(out));
    assert.match(
      String(out.reason),
      /asset changed|invalidated/i,
      String(out.reason),
    );

    const after = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
    assert.equal(after.account_sequence_state, 'paused_review');
    assert.equal(after.work_state, 'pending_human_review');
    const review = parseStageReviewJson(after.stage_review_json);
    assert.ok(review);
    // Re-pause binds pending review to the new material fingerprint.
    assert.equal(review.status, 'pending');
    assert.equal(review.asset_version, versionB);
  } finally {
    if (prevFixture === undefined) delete process.env.AO_UNIPILE_FIXTURE;
    else process.env.AO_UNIPILE_FIXTURE = prevFixture;
  }

  db.close();
});

// --- Deadlock fix: material invalidation ahead of outbound gate ------------
//
// A pending review on paused_review bound to a stale asset_version used to sit
// forever behind shouldExecuteSequenceOutbound (which the pause itself holds
// shut). Refresh must run before that gate; it must never authorize a send.

const countLiveInteractionLedger = (db) => {
  try {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM live_interaction_ledger').get()?.n || 0);
  } catch {
    return 0;
  }
};

const countChannelEventsAll = (db) => {
  try {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM channel_events').get()?.n || 0);
  } catch {
    return 0;
  }
};

test('executeChannelStep: paused_review + pending review on stale asset → re-binds, still gated, no send', async () => {
  const accountId = 'acct_stale_pending_refresh';
  const messageA = 'Stale pending LinkedIn message A';
  const messageB = 'Current LinkedIn message B after content change';
  const transmitterCalls = [];

  const { listDir, db, rowId } = seedList({
    rowId: accountId,
    reviewRequiredFor: ['linkedin_connect'],
    account_sequence_state: 'paused_review',
    next_action_json: JSON.stringify(
      nextAction(accountId, {
        action_type: 'pending_human_review',
        sequence_state: 'paused_review',
        work_state: 'pending_human_review',
      }),
    ),
  });
  ensureRecordColumns({ db, columns: ['linkedin_message', 'work_state', 'related_review_id', 'transition_audit_json'] });
  const seeded = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  upsertRecord({ db, row: { ...seeded, linkedin_message: messageA } });
  const withA = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const versionA = materialAssetVersion({
    record: withA,
    stageId: 'linkedin_1',
    policyVersion: 'tv-pipeline-v1',
    bodyText: messageA,
  });
  const versionB = materialAssetVersion({
    record: { ...withA, linkedin_message: messageB },
    stageId: 'linkedin_1',
    policyVersion: 'tv-pipeline-v1',
    bodyText: messageB,
  });
  assert.notEqual(versionA, versionB);

  const paused = pauseForStageReview({
    account_id: accountId,
    stage_id: 'linkedin_1',
    asset_version: versionA,
    contact_id: 'c_owner',
    channel: 'linkedin',
    action_type: 'linkedin_connect',
    pending_action: {
      action_type: 'linkedin_connect',
      account_id: accountId,
      contact_id: 'c_owner',
      lifecycle_stage: 'contacted',
      sequence_state: 'active',
      work_state: 'executing_external_action',
      reason: 'resume after review',
      on_success: 'continue',
      policy_version: NEXT_ACTION_POLICY_VERSION,
    },
    lifecycle_stage: 'contacted',
    reason: 'pending review bound to A',
  });
  assert.equal(paused.authorization.status, 'pending');
  assert.equal(paused.authorization.asset_version, versionA);

  upsertRecord({
    db,
    row: {
      ...withA,
      account_sequence_state: 'paused_review',
      work_state: 'pending_human_review',
      next_action_json: paused.patch.next_action_json,
      stage_review_json: paused.patch.stage_review_json,
      related_review_id: paused.patch.related_review_id,
      linkedin_message: messageB,
    },
  });

  const ledgerBefore = countLiveInteractionLedger(db);
  const eventsBefore = countChannelEventsAll(db);
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const boundBefore = parseStageReviewJson(record.stage_review_json);
  assert.equal(boundBefore.status, 'pending');
  assert.equal(boundBefore.asset_version, versionA);

  const prevFixture = process.env.AO_UNIPILE_FIXTURE;
  delete process.env.AO_UNIPILE_FIXTURE;
  try {
    const out = await runLinkedin({
      listDir,
      db,
      record,
      dryRun: false,
      step: {
        ...linkedinStep,
        config: {
          ...linkedinStep.config,
          args_map: { invite_message: 'linkedin_message' },
          invite_message: '',
          // Injected transmitter — must never fire while gated/refreshed.
          __tryTool: async (...args) => {
            transmitterCalls.push(args);
            return { result: { invitation_id: 'must_not_send' }, provider: 'test_provider' };
          },
        },
      },
    });

    // Safety: still gated, never a send. Outcome names the refresh.
    assert.equal(out.status, 'skipped', JSON.stringify(out));
    assert.match(
      String(out.reason),
      /asset changed|invalidated|re-paused for review/i,
      `operator should see refresh reason, not only generic pause: ${out.reason}`,
    );
    assert.equal(out.provider_id, '');
    assert.equal(transmitterCalls.length, 0, 'injected transmitter must never be called');
    assert.equal(countLiveInteractionLedger(db), ledgerBefore, 'live-interaction ledger unchanged');
    assert.equal(countChannelEventsAll(db), eventsBefore, 'no channel_events from a gated refresh');

    const after = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
    assert.equal(after.account_sequence_state, 'paused_review', 'still gated after rebind');
    assert.equal(after.work_state, 'pending_human_review');
    const review = parseStageReviewJson(after.stage_review_json);
    assert.ok(review);
    assert.equal(review.status, 'pending', 'refresh is a pending review, never an approval');
    assert.equal(review.asset_version, versionB, 're-bound to current material fingerprint');
  } finally {
    if (prevFixture === undefined) delete process.env.AO_UNIPILE_FIXTURE;
    else process.env.AO_UNIPILE_FIXTURE = prevFixture;
  }

  db.close();
});

test('executeChannelStep: paused_review + pending review on matching asset → same gate reason, review untouched, no send', async () => {
  const accountId = 'acct_match_pending_control';
  const message = 'Stable LinkedIn message that still matches the bound review';
  const transmitterCalls = [];

  const { listDir, db, rowId } = seedList({
    rowId: accountId,
    reviewRequiredFor: ['linkedin_connect'],
    account_sequence_state: 'paused_review',
    next_action_json: JSON.stringify(
      nextAction(accountId, {
        action_type: 'pending_human_review',
        sequence_state: 'paused_review',
        work_state: 'pending_human_review',
      }),
    ),
  });
  ensureRecordColumns({ db, columns: ['linkedin_message', 'work_state', 'related_review_id', 'transition_audit_json'] });
  const seeded = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  upsertRecord({ db, row: { ...seeded, linkedin_message: message } });
  const withMsg = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const version = materialAssetVersion({
    record: withMsg,
    stageId: 'linkedin_1',
    policyVersion: 'tv-pipeline-v1',
    bodyText: message,
  });

  const paused = pauseForStageReview({
    account_id: accountId,
    stage_id: 'linkedin_1',
    asset_version: version,
    contact_id: 'c_owner',
    channel: 'linkedin',
    action_type: 'linkedin_connect',
    pending_action: {
      action_type: 'linkedin_connect',
      account_id: accountId,
      contact_id: 'c_owner',
      lifecycle_stage: 'contacted',
      sequence_state: 'active',
      work_state: 'executing_external_action',
      reason: 'resume after review',
      on_success: 'continue',
      policy_version: NEXT_ACTION_POLICY_VERSION,
    },
    lifecycle_stage: 'contacted',
    reason: 'pending review matching current asset',
  });

  upsertRecord({
    db,
    row: {
      ...withMsg,
      account_sequence_state: 'paused_review',
      work_state: 'pending_human_review',
      next_action_json: paused.patch.next_action_json,
      stage_review_json: paused.patch.stage_review_json,
      related_review_id: paused.patch.related_review_id,
      linkedin_message: message,
    },
  });

  const before = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const reviewBefore = parseStageReviewJson(before.stage_review_json);
  const reviewJsonBefore = String(before.stage_review_json || '');
  const ledgerBefore = countLiveInteractionLedger(db);
  const eventsBefore = countChannelEventsAll(db);

  const prevFixture = process.env.AO_UNIPILE_FIXTURE;
  delete process.env.AO_UNIPILE_FIXTURE;
  try {
    const out = await runLinkedin({
      listDir,
      db,
      record: before,
      dryRun: false,
      step: {
        ...linkedinStep,
        config: {
          ...linkedinStep.config,
          args_map: { invite_message: 'linkedin_message' },
          invite_message: '',
          __tryTool: async (...args) => {
            transmitterCalls.push(args);
            return { result: { invitation_id: 'must_not_send' }, provider: 'test_provider' };
          },
        },
      },
    });

    // CONTROL: same gate as before the fix when asset still matches.
    assert.equal(out.status, 'skipped', JSON.stringify(out));
    assert.match(
      String(out.reason),
      /sequence_outbound_gated:.*sequence_state_paused_review/,
      String(out.reason),
    );
    assert.equal(transmitterCalls.length, 0, 'injected transmitter must never be called');
    assert.equal(countLiveInteractionLedger(db), ledgerBefore, 'live-interaction ledger unchanged');
    assert.equal(countChannelEventsAll(db), eventsBefore);

    const after = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
    assert.equal(after.account_sequence_state, 'paused_review');
    assert.equal(String(after.stage_review_json || ''), reviewJsonBefore, 'review untouched when asset matches');
    const reviewAfter = parseStageReviewJson(after.stage_review_json);
    assert.equal(reviewAfter.status, reviewBefore.status);
    assert.equal(reviewAfter.asset_version, reviewBefore.asset_version);
    assert.equal(reviewAfter.review_id, reviewBefore.review_id);
  } finally {
    if (prevFixture === undefined) delete process.env.AO_UNIPILE_FIXTURE;
    else process.env.AO_UNIPILE_FIXTURE = prevFixture;
  }

  db.close();
});

test('executeChannelStep: unreachable record does not perform stage-review bookkeeping', async () => {
  const accountId = 'acct_unreachable_no_review_bookkeeping';
  const messageA = 'Unreachable stale message A';
  const messageB = 'Unreachable content B';

  const { listDir, db, rowId } = seedList({
    rowId: accountId,
    reviewRequiredFor: ['linkedin_connect'],
    // No contact_email → reachability parks as unreachable.
    contact_email: '',
    active_contact_id: '',
    account_sequence_state: 'paused_review',
    next_action_json: JSON.stringify(
      nextAction(accountId, {
        action_type: 'pending_human_review',
        sequence_state: 'paused_review',
        work_state: 'pending_human_review',
      }),
    ),
  });
  ensureRecordColumns({
    db,
    columns: ['linkedin_message', 'work_state', 'related_review_id', 'transition_audit_json', 'linkedin_url', 'contact_linkedin'],
  });
  const seeded = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  // Explicitly blank delivery targets so reconcileSequenceReachability parks.
  upsertRecord({
    db,
    row: {
      ...seeded,
      contact_email: '',
      email: '',
      linkedin_url: '',
      contact_linkedin: '',
      phone: '',
      linkedin_message: messageA,
      active_contact_id: '',
    },
  });
  const withA = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const versionA = materialAssetVersion({
    record: withA,
    stageId: 'linkedin_1',
    policyVersion: 'tv-pipeline-v1',
    bodyText: messageA,
  });

  const paused = pauseForStageReview({
    account_id: accountId,
    stage_id: 'linkedin_1',
    asset_version: versionA,
    contact_id: null,
    channel: 'linkedin',
    action_type: 'linkedin_connect',
    lifecycle_stage: 'contacted',
    reason: 'pending on unreachable record',
  });
  const reviewJsonBefore = String(paused.patch.stage_review_json || '');
  upsertRecord({
    db,
    row: {
      ...withA,
      account_sequence_state: 'paused_review',
      work_state: 'pending_human_review',
      next_action_json: paused.patch.next_action_json,
      stage_review_json: paused.patch.stage_review_json,
      related_review_id: paused.patch.related_review_id,
      linkedin_message: messageB,
      contact_email: '',
      active_contact_id: '',
    },
  });

  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const out = await runLinkedin({ listDir, db, record, dryRun: false });
  assert.equal(out.status, 'skipped', JSON.stringify(out));
  assert.match(
    String(out.reason),
    /sequence_unreachable/,
    `unreachable must short-circuit before review bookkeeping: ${out.reason}`,
  );
  assert.doesNotMatch(
    String(out.reason),
    /asset changed|invalidated|re-paused for review/i,
    'must not report material invalidation for unreachable',
  );

  const after = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  // Review JSON must be untouched (no rebind / invalidate bookkeeping).
  assert.equal(String(after.stage_review_json || ''), reviewJsonBefore);
  const reviewAfter = parseStageReviewJson(after.stage_review_json);
  assert.equal(reviewAfter.asset_version, versionA, 'stale binding left alone when unreachable');
  assert.equal(reviewAfter.status, 'pending');

  db.close();
});

test('executeChannelStep: send_email in review_required_for, no draft/auth → blocked + paused_review', async () => {
  const accountId = 'acct_email_block';
  const { listDir, db, rowId } = seedList({
    rowId: accountId,
    reviewRequiredFor: ['send_email'],
    next_action_json: JSON.stringify(
      nextAction(accountId, { action_type: 'send_email' }),
    ),
  });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);

  const out = await runEmail({ listDir, db, record, dryRun: false });
  assert.equal(out.status, 'skipped', JSON.stringify(out));
  assert.match(
    String(out.reason),
    /stage review or draft approval required/i,
    String(out.reason),
  );

  const after = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  assert.equal(after.account_sequence_state, 'paused_review');
  const review = parseStageReviewJson(after.stage_review_json);
  assert.ok(review);
  assert.equal(review.status, 'pending');
  assert.equal(String(review.action_type || ''), 'send_email');

  db.close();
});

test('executeChannelStep: send_email with ready draft allows past review gate (before provider)', async () => {
  const accountId = 'acct_email_draft';
  const { listDir, db, rowId } = seedList({
    rowId: accountId,
    reviewRequiredFor: ['send_email'],
    next_action_json: JSON.stringify(
      nextAction(accountId, { action_type: 'send_email' }),
    ),
  });
  insertDraft({
    db,
    draft: {
      draft_id: 'draft_ready_1',
      row_id: rowId,
      sequence_name: 'default',
      step_number: 1,
      step_id: 'email_1',
      channel: 'email',
      status: 'ready',
      subject: 'Hello',
      body: 'Body',
      reason: 'approved for test',
      artifacts: {},
    },
  });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);

  const out = await runEmail({ listDir, db, record, dryRun: false });
  // Must not stop at stage-review / draft-approval gate.
  assert.ok(
    !/stage review or draft approval required/i.test(String(out.reason || '')),
    `still review-gated: ${JSON.stringify(out)}`,
  );
  // Sequence must not be paused_review by the gate (provider may still fail later).
  const after = db.prepare('SELECT account_sequence_state FROM records WHERE _row_id = ?').get(rowId);
  assert.notEqual(after.account_sequence_state, 'paused_review');

  db.close();
});

test('executeChannelStep: removing linkedin_connect from review_required_for opens the gate', async () => {
  const accountId = 'acct_li_config_live';
  const { listDir, db, rowId } = seedList({
    rowId: accountId,
    // Config live: linkedin_connect not listed.
    reviewRequiredFor: ['send_email'],
    next_action_json: JSON.stringify(
      nextAction(accountId, { action_type: 'linkedin_connect' }),
    ),
  });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);

  const prevFixture = process.env.AO_UNIPILE_FIXTURE;
  delete process.env.AO_UNIPILE_FIXTURE;
  try {
    const out = await runLinkedin({ listDir, db, record, dryRun: false });
    assert.ok(
      !/stage review required/i.test(String(out.reason || '')),
      `config sticky: ${JSON.stringify(out)}`,
    );
    const after = db.prepare('SELECT account_sequence_state FROM records WHERE _row_id = ?').get(rowId);
    assert.notEqual(after.account_sequence_state, 'paused_review');
  } finally {
    if (prevFixture === undefined) delete process.env.AO_UNIPILE_FIXTURE;
    else process.env.AO_UNIPILE_FIXTURE = prevFixture;
  }

  db.close();
});

// --- completeManualTask mail stage-review diagnostics (assertMailStageReviewAuthorized) ---
//
// The positive gate accepts authorization bound to stepId / productType / 'mail' /
// 'manual_task'. The refusal diagnostic must use the same identity: authorized for a
// *different* stage is "stage review required", not "asset_version mismatch".

const mailStageReviewConfig = ({
  stepId = 'mail_golden',
  productType = 'golden_ticket',
  reviewRequiredFor = ['golden_ticket'],
} = {}) => ({
  policy: {
    version: 'tv-pipeline-v1',
    review_required_for: reviewRequiredFor,
  },
  pipeline: [
    {
      kind: 'manual_task',
      id: stepId,
      config: { task_type: productType, channel: 'mail' },
    },
  ],
  channels: {
    mail: { template_id: 'postcard_v1' },
  },
});

/** Material fingerprint matching assertMailStageReviewAuthorized's resolveStageAssetVersion inputs. */
const mailCompleteAssetVersion = ({
  rowId,
  stepId,
  address = '1 Main St',
  activeContactId = 'c1',
  contactId = 'c1',
  bodyText = '',
  policyVersion = 'tv-pipeline-v1',
} = {}) => resolveStageAssetVersion({
  accountId: rowId,
  activeContactId,
  contactId,
  recipient: address,
  stepId,
  stageId: stepId,
  bodyText: bodyText || null,
  policyVersion,
  reviewPresentation: null,
});

const seedMailManualComplete = ({
  rowId = 'mail_stage_review_1',
  stepId = 'mail_golden',
  productType = 'golden_ticket',
  stage_review_json = null,
  address = '1 Main St',
  mail_copy = '',
} = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-mail-stage-review-'));
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml({ reviewRequiredFor: [productType] }));
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const campaign = buildContactPlan({
    account_id: rowId,
    campaign_id: `camp_${rowId}`,
    treatment_tier: 'A',
    mail_treatment: productType,
    contacts: [{ contact_id: 'c1', outbound_disposition: 'eligible_target', outreach_rank: 1 }],
  });
  ensureRecordColumns({
    db,
    columns: [
      'lifecycle_stage',
      'account_sequence_state',
      'work_state',
      'next_action_json',
      'active_contact_id',
      'contact_id',
      'treatment_tier',
      'suppressed',
      'stage_review_json',
      'related_review_id',
      'transition_audit_json',
      'account_contact_plan_json',
      'mail_treatment',
      'mail_allocated',
      'mail_copy',
      'address',
      'city',
      'state',
      'zip',
      'business_name',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      contact_email, lifecycle_stage, account_sequence_state, work_state, next_action_json,
      active_contact_id, treatment_tier, suppressed, stage_review_json,
      account_contact_plan_json, mail_treatment, mail_allocated, mail_copy,
      address, city, state, zip,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      ?, 'Mail Review HVAC', 'default', 'active', 0,
      'owner@example-mail-review.test', 'contacted', 'active', 'executing_external_action', ?,
      'c1', 'A', 0, ?,
      ?, ?, 0, ?,
      ?, 'Boise', 'ID', '83702',
      ?, ?, ?, ?
    )
  `).run(
    rowId,
    JSON.stringify(nextAction(rowId, { action_type: 'manual_task' })),
    stage_review_json,
    JSON.stringify(campaign),
    productType,
    mail_copy,
    address,
    now,
    now,
    now,
    now,
  );
  try {
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
      VALUES (?, ?, ?, 'manual_task', 0, 'awaiting_manual', ?)
    `).run(`park_${rowId}`, rowId, stepId, now);
  } catch {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_events (
        event_id TEXT PRIMARY KEY,
        record_id TEXT,
        step_id TEXT,
        kind TEXT,
        passed INTEGER,
        reason TEXT,
        occurred_at TEXT
      )
    `);
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
      VALUES (?, ?, ?, 'manual_task', 0, 'awaiting_manual', ?)
    `).run(`park_${rowId}`, rowId, stepId, now);
  }
  return { listDir, db, rowId, stepId, productType, address };
};

test('completeManualTask mail: authorized review for a different stage → stage review required (not asset_version mismatch)', async () => {
  const stepId = 'mail_golden';
  const productType = 'golden_ticket';
  // Real failure mode: LinkedIn authorized, no mail review at all.
  const paused = pauseForStageReview({
    account_id: 'mail_wrong_stage',
    stage_id: 'tier_a.linkedin_1',
    asset_version: 'av_linkedin_only',
    contact_id: 'c1',
    channel: 'linkedin',
    action_type: 'linkedin_connect',
  });
  const authorized = authorizeStageReview({
    review_id: paused.authorization.review_id,
    stage_id: 'tier_a.linkedin_1',
    asset_version: 'av_linkedin_only',
    expected_asset_version: 'av_linkedin_only',
    decision: 'authorize',
    existing: paused.authorization,
  });
  const { db, rowId } = seedMailManualComplete({
    rowId: 'mail_wrong_stage',
    stepId,
    productType,
    stage_review_json: authorized.patch.stage_review_json,
  });
  // Keep sequence active: we are completing mail, not blocked by LI pause state.
  db.prepare(`UPDATE records SET account_sequence_state = 'active' WHERE _row_id = ?`).run(rowId);

  await assert.rejects(
    () => completeManualTask({
      db,
      config: mailStageReviewConfig({ stepId, productType }),
      recordId: rowId,
      stepId,
      note: 'try mail complete',
    }),
    (err) => {
      const msg = String(err?.message || err);
      assert.match(
        msg,
        /Stage review required before completing mail task "golden_ticket"/,
        `expected "stage review required", got: ${msg}`,
      );
      assert.doesNotMatch(
        msg,
        /asset_version mismatch/i,
        `must not report version drift when the only review is a different stage: ${msg}`,
      );
      return true;
    },
  );
  db.close();
});

test('completeManualTask mail: authorized for this stage with drifted asset_version → asset_version mismatch', async () => {
  const stepId = 'mail_golden';
  const productType = 'golden_ticket';
  // Bind identity via product type (not step id) with a stale fingerprint so
  // invalidateStageReviewIfAssetChanged (stage_id=stepId only) does not absorb
  // the case — this is the diagnostic branch under test.
  const paused = pauseForStageReview({
    account_id: 'mail_version_drift',
    stage_id: productType,
    asset_version: 'stale_bound_version_not_current',
    contact_id: 'c1',
    channel: 'mail',
    action_type: productType,
  });
  const authorized = authorizeStageReview({
    review_id: paused.authorization.review_id,
    stage_id: productType,
    asset_version: 'stale_bound_version_not_current',
    expected_asset_version: 'stale_bound_version_not_current',
    decision: 'authorize',
    existing: paused.authorization,
  });
  const { db, rowId, address } = seedMailManualComplete({
    rowId: 'mail_version_drift',
    stepId,
    productType,
    stage_review_json: authorized.patch.stage_review_json,
  });
  db.prepare(`UPDATE records SET account_sequence_state = 'active' WHERE _row_id = ?`).run(rowId);

  // Sanity: current material version is not the stale bound one (else gate would pass).
  const current = mailCompleteAssetVersion({ rowId, stepId, address });
  assert.notEqual(current, 'stale_bound_version_not_current');
  assert.equal(
    isAuthorizedForStep(
      { stage_review_json: authorized.patch.stage_review_json },
      productType,
      current,
    ),
    false,
  );
  assert.equal(
    isAuthorizedForStep(
      { stage_review_json: authorized.patch.stage_review_json },
      productType,
    ),
    true,
  );

  await assert.rejects(
    () => completeManualTask({
      db,
      config: mailStageReviewConfig({ stepId, productType }),
      recordId: rowId,
      stepId,
      note: 'try mail complete',
    }),
    (err) => {
      const msg = String(err?.message || err);
      assert.match(
        msg,
        /Stage review asset_version mismatch for mail task "golden_ticket"/,
        `expected asset_version mismatch, got: ${msg}`,
      );
      return true;
    },
  );
  db.close();
});

test('completeManualTask mail: correctly authorized + versioned review still completes', async () => {
  const stepId = 'mail_golden';
  const productType = 'golden_ticket';
  const rowId = 'mail_auth_ok';
  const address = '1 Main St';
  // Seed record first so we can bind authorization to the same material version complete recomputes.
  const { db } = seedMailManualComplete({
    rowId,
    stepId,
    productType,
    stage_review_json: null,
    address,
  });
  const current = mailCompleteAssetVersion({ rowId, stepId, address });
  const paused = pauseForStageReview({
    account_id: rowId,
    stage_id: stepId,
    asset_version: current,
    contact_id: 'c1',
    channel: 'mail',
    action_type: productType,
  });
  const authorized = authorizeStageReview({
    review_id: paused.authorization.review_id,
    stage_id: stepId,
    asset_version: current,
    expected_asset_version: current,
    decision: 'authorize',
    existing: paused.authorization,
  });
  db.prepare(`
    UPDATE records
    SET stage_review_json = ?, account_sequence_state = 'active'
    WHERE _row_id = ?
  `).run(authorized.patch.stage_review_json, rowId);

  const result = await completeManualTask({
    db,
    config: mailStageReviewConfig({ stepId, productType }),
    recordId: rowId,
    stepId,
    note: 'mailed after authorize',
  });
  assert.equal(result.status, 'manual_completed');
  assert.equal(result.mail_allocated, true);
  db.close();
});

// --- Declared review: on manual_task park materializes pending stage review ---
//
// A parked manual_task with a review: block must produce a pending stage review
// addressable by stage-review list/authorize. Policy.review_required_for alone
// is not the only door — the author declares review: on the step.

const declaredMailReviewBlock = {
  purpose: 'Physical mail costs real money per piece and cannot be recalled.',
  present: [
    { field: 'business_name', label: 'Business' },
    { field: 'address', label: 'Delivery address' },
  ],
  require_non_empty: ['address', 'business_name'],
};

const seedDeclaredManualMail = ({
  rowId = 'acct_declared_mail_review',
  stepId = 'mail_standard',
  taskType = 'standard_postcard',
  productType = 'golden_ticket',
  reviewRequiredFor = [],
  address = '1 Main St',
  businessName = 'Declared Review HVAC',
  stage_review_json = null,
} = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-declared-manual-review-'));
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml({ reviewRequiredFor }));
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const campaign = buildContactPlan({
    account_id: rowId,
    campaign_id: `camp_${rowId}`,
    treatment_tier: 'A',
    mail_treatment: productType,
    contacts: [{ contact_id: 'c1', outbound_disposition: 'eligible_target', outreach_rank: 1 }],
  });
  ensureRecordColumns({
    db,
    columns: [
      'lifecycle_stage',
      'account_sequence_state',
      'work_state',
      'next_action_json',
      'active_contact_id',
      'contact_id',
      'treatment_tier',
      'suppressed',
      'stage_review_json',
      'related_review_id',
      'transition_audit_json',
      'account_contact_plan_json',
      'mail_treatment',
      'mail_allocated',
      'mail_copy',
      'address',
      'city',
      'state',
      'zip',
      'business_name',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      contact_email, lifecycle_stage, account_sequence_state, work_state, next_action_json,
      active_contact_id, treatment_tier, suppressed, stage_review_json,
      account_contact_plan_json, mail_treatment, mail_allocated, mail_copy,
      address, city, state, zip,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      ?, ?, 'default', 'active', 0,
      'owner@example-declared-review.test', 'contacted', 'active', 'executing_external_action', ?,
      'c1', 'A', 0, ?,
      ?, ?, 0, '',
      ?, 'Boise', 'ID', '83702',
      ?, ?, ?, ?
    )
  `).run(
    rowId,
    businessName,
    JSON.stringify(nextAction(rowId, { action_type: 'manual_task' })),
    stage_review_json,
    JSON.stringify(campaign),
    productType,
    address,
    now,
    now,
    now,
    now,
  );
  const step = {
    kind: 'manual_task',
    id: stepId,
    config: { task_type: taskType, channel: 'mail' },
    review: declaredMailReviewBlock,
  };
  const config = {
    policy: {
      version: 'tv-pipeline-v1',
      review_required_for: reviewRequiredFor,
    },
    pipeline: [step],
    channels: { mail: { template_id: 'postcard_v1' } },
  };
  return { listDir, db, rowId, stepId, taskType, productType, step, config, address };
};

test('declared review: parking manual_task opens pending stage review listable by step id', async () => {
  const { listDir, db, rowId, stepId, step, config } = seedDeclaredManualMail({
    rowId: 'acct_park_opens_review',
    // Policy empty — door must open from the step's review: block alone.
    reviewRequiredFor: [],
  });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const out = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Declared Review Test',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step,
    sequence: { steps: [step] },
    channelHint: 'mail',
    intent: 'send',
    dryRun: false,
  });
  assert.equal(out.status, 'skipped');
  assert.equal(out.reason, 'awaiting_manual');
  assert.equal(out.parked, true);

  const after = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const review = parseStageReviewJson(after.stage_review_json);
  assert.ok(review, 'expected pending stage_review_json after park');
  assert.equal(review.status, 'pending');
  assert.equal(String(review.stage_id), stepId);
  assert.equal(String(review.action_type || ''), 'standard_postcard');
  assert.equal(String(review.channel || ''), 'mail');
  assert.ok(review.presentation, 'bound presentation from declared review:');
  assert.equal(review.presentation.purpose, declaredMailReviewBlock.purpose);

  const listed = listPendingStageReviews({ db, status: 'open', config });
  assert.ok(listed.total >= 1, 'stage-review list must surface the parked mail review');
  const match = listed.reviews.find((r) => r.record_id === rowId && r.stage_id === stepId);
  assert.ok(match, 'list must include this record+step');
  assert.equal(match.status, 'pending');
  assert.equal(match.channel, 'mail');
  db.close();
});

test('declared review: authorize by step id then complete succeeds; without authorize complete refuses', async () => {
  const productType = 'golden_ticket';
  const { listDir, db, rowId, stepId, step, config, address } = seedDeclaredManualMail({
    rowId: 'acct_authorize_then_complete',
    productType,
    reviewRequiredFor: [productType],
  });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Declared Review Test',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step,
    sequence: { steps: [step] },
    channelHint: 'mail',
    intent: 'send',
    dryRun: false,
  });

  // Leave pending stage review; restore outbound next_action + active sequence so
  // complete reaches the stage-review gate (not sequence/non-outbound action gates).
  const outboundNa = JSON.stringify(nextAction(rowId, { action_type: 'manual_task' }));
  db.prepare(`
    UPDATE records
    SET account_sequence_state = 'active',
        work_state = 'executing_external_action',
        next_action_json = ?
    WHERE _row_id = ?
  `).run(outboundNa, rowId);

  // Gate not weakened: complete still refuses without authorization.
  await assert.rejects(
    () => completeManualTask({
      db,
      config,
      recordId: rowId,
      stepId,
      note: 'try without authorize',
    }),
    /Stage review required before completing mail task/,
  );

  const pending = parseStageReviewJson(
    db.prepare('SELECT stage_review_json FROM records WHERE _row_id = ?').get(rowId).stage_review_json,
  );
  assert.equal(pending.status, 'pending');
  assert.equal(String(pending.stage_id), stepId);

  const authorized = authorizeStageReview({
    review_id: pending.review_id,
    stage_id: stepId,
    asset_version: pending.asset_version,
    expected_asset_version: pending.asset_version,
    decision: 'authorize',
    account_id: rowId,
    existing: pending,
    lifecycle_stage: 'contacted',
    actor: 'operator',
  });
  assert.equal(authorized.allowed, true, authorized.reason);
  assert.equal(authorized.authorization.status, 'authorized');
  db.prepare(`
    UPDATE records
    SET stage_review_json = ?,
        account_sequence_state = 'active',
        work_state = 'executing_external_action',
        next_action_json = ?
    WHERE _row_id = ?
  `).run(
    authorized.patch.stage_review_json,
    authorized.patch.next_action_json || outboundNa,
    rowId,
  );

  const result = await completeManualTask({
    db,
    config,
    recordId: rowId,
    stepId,
    note: 'mailed after authorize',
  });
  assert.equal(result.status, 'manual_completed');
  assert.equal(result.mail_allocated, true);
  // address retained for material fingerprint parity checks
  assert.equal(address, '1 Main St');
  db.close();
});

test('declared review: reject prevents manual complete', async () => {
  const productType = 'golden_ticket';
  const { listDir, db, rowId, stepId, step, config } = seedDeclaredManualMail({
    rowId: 'acct_reject_blocks_complete',
    productType,
    reviewRequiredFor: [productType],
  });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Declared Review Test',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step,
    sequence: { steps: [step] },
    channelHint: 'mail',
    intent: 'send',
    dryRun: false,
  });

  const pending = parseStageReviewJson(
    db.prepare('SELECT stage_review_json FROM records WHERE _row_id = ?').get(rowId).stage_review_json,
  );
  const rejected = authorizeStageReview({
    review_id: pending.review_id,
    stage_id: stepId,
    asset_version: pending.asset_version,
    expected_asset_version: pending.asset_version,
    decision: 'reject',
    account_id: rowId,
    existing: pending,
    lifecycle_stage: 'contacted',
    actor: 'operator',
  });
  // Decision applied successfully; status is rejected (not authorized).
  assert.equal(rejected.authorization.status, 'rejected');
  // Restore outbound next_action so complete hits the stage-review gate.
  const outboundNa = JSON.stringify(nextAction(rowId, { action_type: 'manual_task' }));
  db.prepare(`
    UPDATE records
    SET stage_review_json = ?,
        account_sequence_state = 'active',
        work_state = 'executing_external_action',
        next_action_json = ?
    WHERE _row_id = ?
  `).run(rejected.patch.stage_review_json, outboundNa, rowId);

  await assert.rejects(
    () => completeManualTask({
      db,
      config,
      recordId: rowId,
      stepId,
      note: 'try after reject',
    }),
    /Stage review required before completing mail task/,
  );
  db.close();
});

test('declared review: require_non_empty empty fields cannot be authorized', async () => {
  const { listDir, db, rowId, stepId, step } = seedDeclaredManualMail({
    rowId: 'acct_empty_required_fields',
    // Empty business_name + address so require_non_empty fails at authorize.
    address: '',
    businessName: '',
    reviewRequiredFor: [],
  });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Declared Review Test',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step,
    sequence: { steps: [step] },
    channelHint: 'mail',
    intent: 'send',
    dryRun: false,
  });

  const pending = parseStageReviewJson(
    db.prepare('SELECT stage_review_json FROM records WHERE _row_id = ?').get(rowId).stage_review_json,
  );
  assert.ok(pending, 'park must still open a pending review when fields are empty');
  assert.equal(pending.status, 'pending');

  const blocked = authorizeStageReview({
    review_id: pending.review_id,
    stage_id: stepId,
    asset_version: pending.asset_version,
    expected_asset_version: pending.asset_version,
    decision: 'authorize',
    account_id: rowId,
    existing: pending,
    lifecycle_stage: 'contacted',
    actor: 'operator',
  });
  assert.equal(blocked.allowed, false);
  assert.match(String(blocked.reason || ''), /required review field/i);
  db.close();
});

test('manual_task without declared review: park does not invent a stage review (no behavior change)', async () => {
  const rowId = 'acct_no_declared_review';
  const stepId = 'mail_plain';
  // Policy empty and no review: block — same as today: park only, no stage_review_json.
  const { listDir, db } = seedDeclaredManualMail({
    rowId,
    stepId,
    reviewRequiredFor: [],
  });
  const step = {
    kind: 'manual_task',
    id: stepId,
    config: { task_type: 'standard_postcard', channel: 'mail' },
    // no review: block
  };
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const out = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'No Declared Review Test',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step,
    sequence: { steps: [step] },
    channelHint: 'mail',
    intent: 'send',
    dryRun: false,
  });
  assert.equal(out.status, 'skipped');
  assert.equal(out.reason, 'awaiting_manual');

  const after = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  assert.equal(
    parseStageReviewJson(after.stage_review_json),
    null,
    'without review: and without policy.review_required_for, park must not open a stage review',
  );
  const listed = listPendingStageReviews({ db, status: 'open' });
  assert.equal(
    listed.reviews.filter((r) => r.record_id === rowId).length,
    0,
  );
  db.close();
});

test('policy product mismatch: park still opens review when campaign product is review-required', async () => {
  // Real failure mode: step task_type=standard_postcard, campaign product=golden_ticket
  // listed in review_required_for — complete demands auth for golden_ticket; park
  // must open the door even though task_type alone does not match the policy token.
  const { listDir, db, rowId, stepId, productType } = seedDeclaredManualMail({
    rowId: 'acct_policy_product_mismatch',
    taskType: 'standard_postcard',
    productType: 'golden_ticket',
    reviewRequiredFor: ['golden_ticket'],
  });
  // Step without review: block — policy+campaign product alone must open.
  const step = {
    kind: 'manual_task',
    id: stepId,
    config: { task_type: 'standard_postcard', channel: 'mail' },
  };
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Policy Product Mismatch',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step,
    sequence: { steps: [step] },
    channelHint: 'mail',
    intent: 'send',
    dryRun: false,
  });
  const after = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const review = parseStageReviewJson(after.stage_review_json);
  assert.ok(review, `park must open pending review when policy lists campaign product ${productType}`);
  assert.equal(review.status, 'pending');
  assert.equal(String(review.stage_id), stepId);
  db.close();
});

// =============================================================================
// Multi-review bag: a record may hold one operative review per stage
// =============================================================================

test('multi-review: terminal for step X then pending for step Y; list returns both', () => {
  const pausedX = pauseForStageReview({
    account_id: 'acct_multi_xy',
    stage_id: 'linkedin_1',
    asset_version: 'av_li',
    channel: 'linkedin',
    action_type: 'linkedin_connect',
    reason: 'review linkedin',
  });
  assert.equal(pausedX.allowed, true);
  const authX = authorizeStageReview({
    review_id: pausedX.authorization.review_id,
    stage_id: 'linkedin_1',
    asset_version: 'av_li',
    expected_asset_version: 'av_li',
    decision: 'authorize',
    account_id: 'acct_multi_xy',
    existing: pausedX.authorization,
    existing_json: pausedX.patch.stage_review_json,
    actor: 'op',
  });
  assert.equal(authX.allowed, true);
  assert.equal(authX.authorization.status, 'authorized');

  const pausedY = pauseForStageReview({
    account_id: 'acct_multi_xy',
    stage_id: 'mail_postcard',
    asset_version: 'av_mail',
    channel: 'mail',
    action_type: 'standard_postcard',
    reason: 'review mail after linkedin',
    existing_json: authX.patch.stage_review_json,
  });
  assert.equal(pausedY.allowed, true, pausedY.reason);
  assert.equal(pausedY.authorization.status, 'pending');
  assert.equal(pausedY.authorization.stage_id, 'mail_postcard');

  const store = parseStageReviewStore(pausedY.patch.stage_review_json);
  assert.equal(store.reviews.length, 2, 'both X and Y must be operative');
  const byStage = Object.fromEntries(store.reviews.map((r) => [r.stage_id, r]));
  assert.equal(byStage.linkedin_1.status, 'authorized');
  assert.equal(byStage.mail_postcard.status, 'pending');

  // listPendingStageReviews expands multi-review rows
  const listDir = mkdtempSync(join(tmpdir(), 'ao-multi-list-'));
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml({ reviewRequiredFor: [] }));
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: ['stage_review_json', 'account_sequence_state', 'work_state', 'business_name'],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      stage_review_json, account_sequence_state, work_state,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, 'Multi Co', 'default', 'active', 2, ?, 'paused_review', 'pending_human_review', ?, ?, ?, ?)
  `).run('acct_multi_xy', pausedY.patch.stage_review_json, now, now, now, now);

  const open = listPendingStageReviews({ db, status: 'open' });
  const openFor = open.reviews.filter((r) => r.record_id === 'acct_multi_xy');
  assert.equal(openFor.length, 1);
  assert.equal(openFor[0].stage_id, 'mail_postcard');

  const all = listPendingStageReviews({ db, status: 'all' });
  const allFor = all.reviews.filter((r) => r.record_id === 'acct_multi_xy');
  assert.equal(allFor.length, 2, 'list all must return both reviews distinguishably');
  const stages = new Set(allFor.map((r) => r.stage_id));
  assert.ok(stages.has('linkedin_1'));
  assert.ok(stages.has('mail_postcard'));
  db.close();
});

test('multi-review: authorizing Y does not authorize or alter X (and vice versa)', () => {
  const pX = pauseForStageReview({
    account_id: 'acct_scope',
    stage_id: 'step_x',
    asset_version: 'av_x',
    action_type: 'linkedin_connect',
  });
  const aX = authorizeStageReview({
    review_id: pX.authorization.review_id,
    stage_id: 'step_x',
    asset_version: 'av_x',
    expected_asset_version: 'av_x',
    decision: 'authorize',
    account_id: 'acct_scope',
    existing: pX.authorization,
    existing_json: pX.patch.stage_review_json,
    actor: 'op',
  });
  const pY = pauseForStageReview({
    account_id: 'acct_scope',
    stage_id: 'step_y',
    asset_version: 'av_y',
    action_type: 'manual_task',
    existing_json: aX.patch.stage_review_json,
  });
  assert.equal(pY.allowed, true);

  // Before authorize Y: X authorized, Y pending
  const recordMid = { stage_review_json: pY.patch.stage_review_json };
  assert.equal(isAuthorizedForStep(recordMid, 'step_x', 'av_x'), true);
  assert.equal(isAuthorizedForStep(recordMid, 'step_y', 'av_y'), false);

  const aY = authorizeStageReview({
    review_id: pY.authorization.review_id,
    stage_id: 'step_y',
    asset_version: 'av_y',
    expected_asset_version: 'av_y',
    decision: 'authorize',
    account_id: 'acct_scope',
    existing: pY.authorization,
    existing_json: pY.patch.stage_review_json,
    actor: 'op',
  });
  assert.equal(aY.allowed, true);

  const recordAfter = { stage_review_json: aY.patch.stage_review_json };
  assert.equal(isAuthorizedForStep(recordAfter, 'step_x', 'av_x'), true, 'X still authorized');
  assert.equal(isAuthorizedForStep(recordAfter, 'step_y', 'av_y'), true, 'Y now authorized');
  assert.equal(isAuthorizedForStep(recordAfter, 'step_x', 'av_y'), false, 'Y version must not unlock X');
  assert.equal(isAuthorizedForStep(recordAfter, 'step_y', 'av_x'), false, 'X version must not unlock Y');

  const store = parseStageReviewStore(aY.patch.stage_review_json);
  const x = store.reviews.find((r) => r.stage_id === 'step_x');
  const y = store.reviews.find((r) => r.stage_id === 'step_y');
  assert.equal(x.review_id, pX.authorization.review_id);
  assert.equal(x.status, 'authorized');
  assert.equal(x.asset_version, 'av_x');
  assert.equal(y.status, 'authorized');
  assert.equal(y.asset_version, 'av_y');

  // Reject X must not touch Y
  const rejX = authorizeStageReview({
    review_id: x.review_id,
    stage_id: 'step_x',
    asset_version: 'av_x',
    expected_asset_version: 'av_x',
    decision: 'reject',
    account_id: 'acct_scope',
    existing: x,
    existing_json: aY.patch.stage_review_json,
    actor: 'op',
  });
  // Already terminal authorize refusal path may keep authorized; reject of terminal
  // is handled as already terminal for authorize only. Use a fresh pending for reject
  // path: just assert Y unchanged after any decision on X.
  const afterRej = parseStageReviewStore(rejX.patch.stage_review_json || aY.patch.stage_review_json);
  const yAfter = afterRej.reviews.find((r) => r.stage_id === 'step_y');
  assert.equal(yAfter.status, 'authorized');
  assert.equal(yAfter.asset_version, 'av_y');
});

test('multi-review: pending for step X is NOT overwritten when step Y wants one (refuse)', () => {
  const pX = pauseForStageReview({
    account_id: 'acct_conflict',
    stage_id: 'step_x',
    asset_version: 'av_x',
    action_type: 'linkedin_connect',
  });
  assert.equal(pX.allowed, true);
  const jsonX = pX.patch.stage_review_json;

  const pY = pauseForStageReview({
    account_id: 'acct_conflict',
    stage_id: 'step_y',
    asset_version: 'av_y',
    action_type: 'manual_task',
    existing_json: jsonX,
  });
  assert.equal(pY.allowed, false, 'must refuse when another stage is pending');
  assert.match(String(pY.reason || ''), /pending_review_other_stage/);
  assert.equal(pY.patch.stage_review_json, undefined, 'must not write a destructive patch');

  // Original pending X intact
  const still = parseStageReviewJson(jsonX);
  assert.equal(still.stage_id, 'step_x');
  assert.equal(still.status, 'pending');

  // Gate also refuses needsPendingReview for Y
  const decision = evaluateExternalActionAuthorization({
    config: { policy: { review_required_for: ['manual_task'] } },
    record: { stage_review_json: jsonX },
    stepKind: 'manual_task',
    stageId: 'step_y',
    channel: 'mail',
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.needsPendingReview, false);
  assert.match(String(decision.reason || ''), /pending_other_stage|pending_review_other_stage/);
});

test('multi-review e2e: park → review → authorize → manual complete after earlier terminal review', async () => {
  // Seed with terminal linkedin review already on the record (the live failure mode).
  const liPaused = pauseForStageReview({
    account_id: 'acct_e2e_multi',
    stage_id: 'linkedin_1',
    asset_version: 'av_li_done',
    channel: 'linkedin',
    action_type: 'linkedin_connect',
  });
  const liAuth = authorizeStageReview({
    review_id: liPaused.authorization.review_id,
    stage_id: 'linkedin_1',
    asset_version: 'av_li_done',
    expected_asset_version: 'av_li_done',
    decision: 'authorize',
    account_id: 'acct_e2e_multi',
    existing: liPaused.authorization,
    existing_json: liPaused.patch.stage_review_json,
    actor: 'op',
  });
  assert.equal(liAuth.allowed, true);

  const { listDir, db, rowId, stepId, step, config } = seedDeclaredManualMail({
    rowId: 'acct_e2e_multi',
    stepId: 'mail_postcard',
    productType: 'golden_ticket',
    reviewRequiredFor: ['golden_ticket'],
    stage_review_json: liAuth.patch.stage_review_json,
  });

  // Park the manual_task — must open a NEW pending mail review alongside terminal LI.
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const park = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Multi E2E',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 2,
    step,
    sequence: { steps: [step] },
    channelHint: 'mail',
    intent: 'send',
    dryRun: false,
  });
  assert.equal(park.status, 'skipped');
  assert.equal(park.reason, 'awaiting_manual');

  const afterPark = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const store = parseStageReviewStore(afterPark.stage_review_json);
  assert.ok(
    store.reviews.length >= 2,
    `expected terminal LI + pending mail, got ${store.reviews.length}: ${JSON.stringify(store.reviews.map((r) => ({ s: r.stage_id, st: r.status })))}`,
  );
  const li = store.reviews.find((r) => r.stage_id === 'linkedin_1');
  const mail = store.reviews.find((r) => r.stage_id === stepId);
  assert.ok(li && li.status === 'authorized', 'linkedin terminal must survive');
  assert.ok(mail && mail.status === 'pending', 'mail pending must open');

  // Restore outbound sequence so complete reaches the stage-review gate
  // (not sequence_state_paused_review), matching the declared-review e2e pattern.
  const outboundNa = JSON.stringify(nextAction(rowId, { action_type: 'manual_task' }));
  db.prepare(`
    UPDATE records
    SET account_sequence_state = 'active',
        work_state = 'executing_external_action',
        next_action_json = ?
    WHERE _row_id = ?
  `).run(outboundNa, rowId);

  // complete without authorize still refuses
  await assert.rejects(
    () => completeManualTask({
      db,
      config,
      recordId: rowId,
      stepId,
      note: 'too early',
    }),
    /Stage review required/,
  );

  // Authorize mail only (LI sibling preserved via existing_json)
  const authorized = authorizeStageReview({
    review_id: mail.review_id,
    stage_id: stepId,
    asset_version: mail.asset_version,
    expected_asset_version: mail.asset_version,
    decision: 'authorize',
    account_id: rowId,
    existing: mail,
    existing_json: afterPark.stage_review_json,
    lifecycle_stage: 'contacted',
    actor: 'operator',
  });
  assert.equal(authorized.allowed, true, authorized.reason);
  db.prepare(`
    UPDATE records
    SET stage_review_json = ?,
        account_sequence_state = 'active',
        work_state = 'executing_external_action',
        next_action_json = ?
    WHERE _row_id = ?
  `).run(
    authorized.patch.stage_review_json,
    authorized.patch.next_action_json || outboundNa,
    rowId,
  );

  // LinkedIn still authorized, mail now authorized
  const afterAuth = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  assert.equal(isAuthorizedForStep(afterAuth, 'linkedin_1'), true);
  assert.equal(isAuthorizedForStep(afterAuth, stepId, mail.asset_version), true);

  const result = await completeManualTask({
    db,
    config,
    recordId: rowId,
    stepId,
    note: 'mailed after multi-review authorize',
  });
  assert.equal(result.status, 'manual_completed');
  db.close();
});

test('multi-review: legacy single-object stage_review_json still lists, authorizes, rejects', () => {
  // Write legacy single-object shape directly (no v2 bag).
  const legacy = {
    review_id: 'rev_legacy_1',
    stage_id: 'email_1',
    asset_version: 'av_legacy',
    status: 'pending',
    account_id: 'acct_legacy',
    channel: 'email',
    action_type: 'send_email',
    policy_version: 'stage-review-v1',
    presentation: {
      purpose: 'legacy',
      present: [{ field: 'business_name', label: 'Business', value: 'Legacy Co' }],
      require_non_empty: ['business_name'],
    },
    pending_action_snapshot: {
      action_type: 'send_email',
      account_id: 'acct_legacy',
    },
  };
  const legacyJson = JSON.stringify(legacy);
  // parse understands legacy
  assert.equal(parseStageReviewJson(legacyJson)?.review_id, 'rev_legacy_1');
  assert.equal(parseStageReviewStore(legacyJson).reviews.length, 1);
  assert.equal(parseStageReviewStore(legacyJson).version, STAGE_REVIEWS_STORE_VERSION);

  const listDir = mkdtempSync(join(tmpdir(), 'ao-legacy-review-'));
  // Minimal config so presentation resolves
  writeFileSync(join(listDir, 'outbound.yaml'), `
project:
  name: Legacy
  vertical: test
policy:
  review_required_for: []
pipeline:
  - kind: pipeline
    id: main
    steps:
      - kind: send_email
        id: email_1
        review:
          purpose: legacy
          present:
            - field: business_name
              label: Business
          require_non_empty:
            - business_name
`);
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: [
      'stage_review_json', 'account_sequence_state', 'work_state',
      'business_name', 'lifecycle_stage', 'next_action_json', 'transition_audit_json',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      lifecycle_stage, account_sequence_state, work_state, stage_review_json,
      next_action_json, _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      'acct_legacy', 'Legacy Co', 'default', 'active', 0,
      'contacted', 'paused_review', 'pending_human_review', ?,
      ?, ?, ?, ?, ?
    )
  `).run(
    legacyJson,
    JSON.stringify({
      action_id: 'na1',
      action_type: 'pending_human_review',
      account_id: 'acct_legacy',
      lifecycle_stage: 'contacted',
      sequence_state: 'paused_review',
      work_state: 'pending_human_review',
      reason: 'legacy',
      on_success: 'resume',
      policy_version: NEXT_ACTION_POLICY_VERSION,
    }),
    now, now, now, now,
  );
  db.close();

  const listed = stageReviewListCommand({ list: listDir, status: 'open' });
  const rows = listed.reviews.filter((r) => r.record_id === 'acct_legacy');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage_id, 'email_1');
  assert.equal(rows[0].status, 'pending');

  const auth = stageReviewAuthorizeCommand({
    list: listDir,
    recordId: 'acct_legacy',
    stage_id: 'email_1',
    decision: 'authorize',
    asset_version: 'av_legacy',
    actor: 'op',
  });
  assert.equal(auth.allowed, true, JSON.stringify(auth));
  assert.equal(auth.authorization.status, 'authorized');

  // Re-seed reject path with a fresh legacy pending
  const db2 = openListDb({ listDir, readonly: false });
  const legacy2 = { ...legacy, review_id: 'rev_legacy_2', status: 'pending' };
  db2.prepare(`
    UPDATE records SET stage_review_json = ?, account_sequence_state = 'paused_review',
      work_state = 'pending_human_review' WHERE _row_id = 'acct_legacy'
  `).run(JSON.stringify(legacy2));
  db2.close();

  const rej = stageReviewAuthorizeCommand({
    list: listDir,
    recordId: 'acct_legacy',
    stage_id: 'email_1',
    decision: 'reject',
    asset_version: 'av_legacy',
    actor: 'op',
  });
  assert.equal(rej.authorization.status, 'rejected');
  // Still parseable as single or bag
  assert.ok(parseStageReviewJson(rej.stage_review_json) || findStageReview(rej.stage_review_json, ['email_1']));
});

test('multi-review: presentation-integrity gate still refuses a diverged review per step', () => {
  // Step X authorized with bound presentation; step Y pending with its own bound presentation.
  // Diverged live values must not authorize Y; X remains authorized independently.
  const boundY = {
    purpose: 'Mail review',
    present: [
      { field: 'business_name', label: 'Business', value: 'Bound Name' },
      { field: 'address', label: 'Address', value: '1 Bound St' },
    ],
    require_non_empty: ['business_name', 'address'],
  };
  const pX = pauseForStageReview({
    account_id: 'acct_pres_multi',
    stage_id: 'linkedin_1',
    asset_version: 'av_x',
    action_type: 'linkedin_connect',
    presentation: {
      purpose: 'LI',
      present: [{ field: 'invite_message', label: 'Invite', value: 'hello' }],
      require_non_empty: ['invite_message'],
    },
  });
  const aX = authorizeStageReview({
    review_id: pX.authorization.review_id,
    stage_id: 'linkedin_1',
    asset_version: 'av_x',
    expected_asset_version: 'av_x',
    decision: 'authorize',
    account_id: 'acct_pres_multi',
    existing: pX.authorization,
    existing_json: pX.patch.stage_review_json,
    actor: 'op',
  });
  const pY = pauseForStageReview({
    account_id: 'acct_pres_multi',
    stage_id: 'mail_1',
    asset_version: 'av_y',
    action_type: 'manual_task',
    presentation: boundY,
    existing_json: aX.patch.stage_review_json,
  });
  assert.equal(pY.allowed, true);

  // Presentation gate (de30ee3 property): diverged shown values refuse authorize.
  const diverged = presentationAuthorizationGate({
    bound: boundY,
    presentation: {
      purpose: boundY.purpose,
      present: [
        { field: 'business_name', label: 'Business', value: 'LIVE DRIFT NAME' },
        { field: 'address', label: 'Address', value: '1 Bound St' },
      ],
      require_non_empty: boundY.require_non_empty,
    },
  });
  assert.equal(diverged.authorizable, false);

  // Matching bound values still authorizable for Y; X unaffected
  const ok = presentationAuthorizationGate({
    bound: boundY,
    presentation: boundY,
  });
  assert.equal(ok.authorizable, true);
  assert.equal(
    isAuthorizedForStep({ stage_review_json: pY.patch.stage_review_json }, 'linkedin_1', 'av_x'),
    true,
  );
  assert.equal(
    isAuthorizedForStep({ stage_review_json: pY.patch.stage_review_json }, 'mail_1', 'av_y'),
    false,
  );

  const aY = authorizeStageReview({
    review_id: pY.authorization.review_id,
    stage_id: 'mail_1',
    asset_version: 'av_y',
    expected_asset_version: 'av_y',
    decision: 'authorize',
    account_id: 'acct_pres_multi',
    existing: pY.authorization,
    existing_json: pY.patch.stage_review_json,
    actor: 'op',
  });
  assert.equal(aY.allowed, true);
  // X still intact after Y authorize
  const store = parseStageReviewStore(aY.patch.stage_review_json);
  assert.equal(store.reviews.find((r) => r.stage_id === 'linkedin_1')?.status, 'authorized');
  assert.equal(store.reviews.find((r) => r.stage_id === 'mail_1')?.status, 'authorized');
});

// =============================================================================
// Pipeline path regression: awaiting_manual park must open stage review
//
// Root cause: step-executor short-circuits manual_task without executeChannelStep;
// dataflow alone inserts the park event. Review creation lived only in
// executeChannelStep — so pipeline parks never opened a review. Tests that only
// call executeChannelStep miss this path.
// =============================================================================

const pipelineYamlWithManualMail = ({
  stepId = 'mail_standard',
  taskType = 'standard_postcard',
  reviewRequiredFor = [],
  withReviewBlock = true,
} = {}) => {
  const reviewBlock = withReviewBlock ? `
    review:
      purpose: Physical mail costs real money per piece and cannot be recalled.
      present:
        - field: business_name
          label: Business
        - field: address
          label: Delivery address
      require_non_empty:
        - address
        - business_name` : '';
  return `
list:
  name: Pipeline Manual Park Review
business:
  name: Mission
  description: Test
  icp: Test
  offer: Test
ai:
  default_model: anthropic/claude-haiku-4-5-20251001
pipeline:
  - kind: manual_task
    id: ${stepId}
    inputs: [business_name, address]
    config:
      task_type: ${taskType}
      channel: mail${reviewBlock}
policy:
  version: tv-pipeline-v1
  enforce_readiness: false
  review_required_for: ${JSON.stringify(reviewRequiredFor)}
channels:
  mail:
    template_id: postcard_v1
`;
};

const seedPipelineManualMail = ({
  rowId = 'acct_pipeline_park_review',
  stepId = 'mail_standard',
  taskType = 'standard_postcard',
  productType = 'golden_ticket',
  reviewRequiredFor = [],
  withReviewBlock = true,
  address = '1 Main St',
  businessName = 'Pipeline Park HVAC',
  stage_review_json = null,
} = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-pipeline-manual-park-'));
  writeFileSync(
    join(listDir, 'outbound.yaml'),
    pipelineYamlWithManualMail({ stepId, taskType, reviewRequiredFor, withReviewBlock }),
  );
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const campaign = buildContactPlan({
    account_id: rowId,
    campaign_id: `camp_${rowId}`,
    treatment_tier: 'A',
    mail_treatment: productType,
    contacts: [{ contact_id: 'c1', outbound_disposition: 'eligible_target', outreach_rank: 1 }],
  });
  ensureRecordColumns({
    db,
    columns: [
      'lifecycle_stage',
      'account_sequence_state',
      'work_state',
      'next_action_json',
      'active_contact_id',
      'contact_id',
      'treatment_tier',
      'suppressed',
      'stage_review_json',
      'related_review_id',
      'transition_audit_json',
      'account_contact_plan_json',
      'mail_treatment',
      'mail_allocated',
      'mail_copy',
      'address',
      'city',
      'state',
      'zip',
      'business_name',
      'last_error',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      contact_email, lifecycle_stage, account_sequence_state, work_state, next_action_json,
      active_contact_id, treatment_tier, suppressed, stage_review_json,
      account_contact_plan_json, mail_treatment, mail_allocated, mail_copy,
      address, city, state, zip,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      ?, ?, 'default', 'active', 0,
      'owner@example-pipeline-park.test', 'contacted', 'active', 'executing_external_action', ?,
      'c1', 'A', 0, ?,
      ?, ?, 0, '',
      ?, 'Boise', 'ID', '83702',
      ?, ?, ?, ?
    )
  `).run(
    rowId,
    businessName,
    JSON.stringify(nextAction(rowId, { action_type: 'manual_task' })),
    stage_review_json,
    JSON.stringify(campaign),
    productType,
    address,
    now,
    now,
    now,
    now,
  );
  return { listDir, db, rowId, stepId, taskType, productType };
};

test('pipeline path: parking manual_task with review: opens pending stage review listable by channel and step id', async () => {
  // Uses runPipelineDataflow — the path that actually parks in production —
  // not a direct executeChannelStep helper call.
  const { listDir, db, rowId, stepId } = seedPipelineManualMail({
    rowId: 'acct_pipeline_opens_review',
    reviewRequiredFor: [],
    withReviewBlock: true,
  });

  await runPipelineDataflow({ listDir, force: true });

  const park = db.prepare(`
    SELECT reason, passed FROM pipeline_events
    WHERE record_id = ? AND step_id = ? AND kind = 'manual_task'
    ORDER BY occurred_at DESC LIMIT 1
  `).get(rowId, stepId);
  assert.ok(park, 'pipeline must record awaiting_manual park event');
  assert.equal(Number(park.passed), 0);
  assert.equal(park.reason, 'awaiting_manual');

  const after = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const review = parseStageReviewJson(after.stage_review_json);
  assert.ok(review, 'pipeline park must open pending stage_review_json');
  assert.equal(review.status, 'pending');
  assert.equal(String(review.stage_id), stepId);
  assert.equal(String(review.channel || ''), 'mail');
  assert.equal(String(review.action_type || ''), 'standard_postcard');
  assert.ok(review.presentation, 'bound presentation from declared review:');

  const listedAll = listPendingStageReviews({ db, status: 'all' });
  const byChannel = listedAll.reviews.filter(
    (r) => r.record_id === rowId && String(r.channel || '') === 'mail',
  );
  assert.ok(byChannel.length >= 1, 'stage-review list filtered by channel=mail must find the park');
  const byStep = listedAll.reviews.find((r) => r.record_id === rowId && r.stage_id === stepId);
  assert.ok(byStep, 'review must be addressable by step id');
  assert.equal(byStep.status, 'pending');

  // Gate not weakened: complete still refuses without authorize.
  const outboundNa = JSON.stringify(nextAction(rowId, { action_type: 'manual_task' }));
  db.prepare(`
    UPDATE records
    SET account_sequence_state = 'active',
        work_state = 'executing_external_action',
        next_action_json = ?
    WHERE _row_id = ?
  `).run(outboundNa, rowId);
  await assert.rejects(
    () => completeManualTask({
      db,
      config: {
        policy: { version: 'tv-pipeline-v1', review_required_for: [] },
        pipeline: [{
          kind: 'manual_task',
          id: stepId,
          config: { task_type: 'standard_postcard', channel: 'mail' },
          review: {
            purpose: 'Physical mail',
            present: [
              { field: 'business_name', label: 'Business' },
              { field: 'address', label: 'Delivery address' },
            ],
            require_non_empty: ['address', 'business_name'],
          },
        }],
        channels: { mail: { template_id: 'postcard_v1' } },
      },
      recordId: rowId,
      stepId,
      note: 'too early',
    }),
    /Stage review required|asset changed|Re-authorize|fail-closed/i,
  );
  db.close();
});

test('pipeline path: terminal review for other step still gets new pending mail review (multi-review store)', async () => {
  const liPaused = pauseForStageReview({
    account_id: 'acct_pipeline_multi',
    stage_id: 'linkedin_1',
    asset_version: 'av_li_done',
    channel: 'linkedin',
    action_type: 'linkedin_connect',
  });
  const liAuth = authorizeStageReview({
    review_id: liPaused.authorization.review_id,
    stage_id: 'linkedin_1',
    asset_version: 'av_li_done',
    expected_asset_version: 'av_li_done',
    decision: 'authorize',
    account_id: 'acct_pipeline_multi',
    existing: liPaused.authorization,
    existing_json: liPaused.patch.stage_review_json,
    actor: 'op',
  });
  assert.equal(liAuth.allowed, true);

  const { listDir, db, rowId, stepId } = seedPipelineManualMail({
    rowId: 'acct_pipeline_multi',
    stepId: 'mail_standard',
    reviewRequiredFor: [],
    withReviewBlock: true,
    // Legacy-looking single-object terminal can also appear; use multi bag from authorize.
    stage_review_json: liAuth.patch.stage_review_json,
  });

  await runPipelineDataflow({ listDir, force: true });

  const after = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const store = parseStageReviewStore(after.stage_review_json);
  assert.ok(
    store.reviews.length >= 2,
    `expected terminal LI + pending mail via pipeline park, got ${store.reviews.length}: `
    + JSON.stringify(store.reviews.map((r) => ({ s: r.stage_id, st: r.status }))),
  );
  const li = store.reviews.find((r) => r.stage_id === 'linkedin_1');
  const mail = store.reviews.find((r) => r.stage_id === stepId);
  assert.ok(li && li.status === 'authorized', 'linkedin terminal must survive pipeline park');
  assert.ok(mail && mail.status === 'pending', 'mail pending must open alongside terminal');
  assert.equal(String(mail.channel || ''), 'mail');

  const listed = listPendingStageReviews({ db, status: 'all' });
  const mailListed = listed.reviews.filter(
    (r) => r.record_id === rowId && String(r.channel || '') === 'mail',
  );
  assert.ok(mailListed.length >= 1);
  db.close();
});

test('pipeline path: manual_task without review: and without policy token does not invent a stage review', async () => {
  const { listDir, db, rowId, stepId } = seedPipelineManualMail({
    rowId: 'acct_pipeline_no_review',
    stepId: 'mail_plain',
    reviewRequiredFor: [],
    withReviewBlock: false,
  });

  await runPipelineDataflow({ listDir, force: true });

  const park = db.prepare(`
    SELECT reason FROM pipeline_events
    WHERE record_id = ? AND step_id = ? AND kind = 'manual_task' AND passed = 0
    LIMIT 1
  `).get(rowId, stepId);
  assert.ok(park, 'still parks awaiting_manual');
  assert.equal(park.reason, 'awaiting_manual');

  const after = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  assert.equal(
    parseStageReviewJson(after.stage_review_json),
    null,
    'no declared review: and no policy token → no stage review invented',
  );
  const listed = listPendingStageReviews({ db, status: 'all' });
  assert.equal(listed.reviews.filter((r) => r.record_id === rowId).length, 0);
  db.close();
});

test('ensureStageReviewOnManualTaskPark: open failure is visible and complete still refuses', async () => {
  const { listDir, db, rowId, stepId } = seedPipelineManualMail({
    rowId: 'acct_review_open_fail',
    reviewRequiredFor: [],
    withReviewBlock: true,
  });
  // Seed an open pending park without a review (reproduces the live bug state).
  db.prepare(`
    INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
    VALUES (?, ?, ?, 'manual_task', 0, 'awaiting_manual', ?)
  `).run('park_pre', rowId, stepId, new Date().toISOString());

  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const step = {
    kind: 'manual_task',
    id: stepId,
    config: { task_type: 'standard_postcard', channel: 'mail' },
    review: {
      purpose: 'Physical mail',
      present: [
        { field: 'business_name', label: 'Business' },
        { field: 'address', label: 'Delivery address' },
      ],
      require_non_empty: ['address', 'business_name'],
    },
  };

  // Force open failure: db that throws on every prepare used by upsert paths.
  let threw = false;
  const flakyDb = {
    prepare(sql) {
      // Allow reads for existing state; fail writes that open the review.
      if (/UPDATE\s+records|INSERT\s+INTO\s+records/i.test(sql)) {
        threw = true;
        throw new Error('simulated_stage_review_write_failure');
      }
      return db.prepare(sql);
    },
    exec: (...args) => db.exec(...args),
    close: () => db.close(),
  };

  const result = ensureStageReviewOnManualTaskPark({
    db: flakyDb,
    record,
    step,
    projectConfig: { policy: { version: 'tv-pipeline-v1', review_required_for: [] } },
    stageId: stepId,
    stepKind: 'manual_task',
    taskType: 'standard_postcard',
    channel: 'mail',
  });
  assert.equal(result.opened, false);
  assert.ok(result.error, 'failure must be visible on the result');
  assert.match(String(result.error), /simulated_stage_review_write_failure|stage_review/i);
  assert.equal(threw, true);

  // Real record still has no review (write failed) — complete refuses.
  const after = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  // May have last_error / audit from recordOpenFailure if a partial write path ran;
  // the review itself must not be pending authorized.
  const review = parseStageReviewJson(after.stage_review_json);
  assert.ok(!review || review.status !== 'authorized');

  const outboundNa = JSON.stringify(nextAction(rowId, { action_type: 'manual_task' }));
  db.prepare(`
    UPDATE records
    SET account_sequence_state = 'active',
        work_state = 'executing_external_action',
        next_action_json = ?
    WHERE _row_id = ?
  `).run(outboundNa, rowId);

  await assert.rejects(
    () => completeManualTask({
      db,
      config: {
        policy: { version: 'tv-pipeline-v1', review_required_for: [] },
        pipeline: [step],
        channels: { mail: { template_id: 'postcard_v1' } },
      },
      recordId: rowId,
      stepId,
      note: 'still refuse without review',
    }),
    /Stage review required|awaiting|not authorized|manual/i,
  );
  // Visibility: helper returned error; optionally last_error/audit on record when persist worked.
  assert.ok(result.error);
  db.close();
});
