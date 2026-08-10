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
  invalidateStageReviewIfAssetChanged,
} from '../dist/orchestrator/policy/transition-audit.js';
import { openListDb, ensureRecordColumns, insertDraft, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';
import { completeManualTask } from '../dist/orchestrator/pipeline/manual.js';
import { buildContactPlan } from '../dist/orchestrator/policy/contact-campaign.js';
import { NEXT_ACTION_POLICY_VERSION } from '../dist/orchestrator/policy/lifecycle.js';

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
