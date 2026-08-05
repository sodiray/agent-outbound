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
import { contentBindingFromRecord } from '../dist/orchestrator/policy/claim-binding.js';
import { openListDb, ensureRecordColumns, insertDraft, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';
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
  const binding = contentBindingFromRecord(record || {});
  return resolveStageAssetVersion({
    accountId: String(record?._row_id || record?.id || record?.account_id || ''),
    activeContactId: String(record?.active_contact_id || record?.contact_id || '') || null,
    contactId: String(record?.contact_id || '') || null,
    recipient: recipient
      ?? String(record?.contact_email || record?.email || record?.linkedin_url || ''),
    stepId: stageId,
    stageId,
    claimPacketHash: binding.claim_packet_hash || null,
    assetId: assetId ?? null,
    draftId: draftId ?? null,
    policyVersion: policyVersion ?? null,
    bodyText: bodyText ?? null,
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

// --- Material asset_version composition + invalidate helper -----------------

test('resolveStageAssetVersion: material fields change fingerprint; sparse fallback stable', () => {
  const base = {
    accountId: 'acct_m',
    activeContactId: 'c1',
    recipient: 'a@example.com',
    stepId: 'email_1',
    claimPacketHash: 'packet_aaa',
  };
  const vA = resolveStageAssetVersion(base);
  const vB = resolveStageAssetVersion({ ...base, claimPacketHash: 'packet_bbb' });
  const vContact = resolveStageAssetVersion({ ...base, activeContactId: 'c2' });
  const vRecipient = resolveStageAssetVersion({ ...base, recipient: 'b@example.com' });
  assert.match(vA, /^srv1:[a-f0-9]{64}$/);
  assert.notEqual(vA, vB, 'content/claim change must invalidate');
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
    record: { ...recordBase, permitted_claim_packet_json: JSON.stringify({ permitted_claims: [{ claim_id: 'cA' }] }) },
    stageId: 'linkedin_1',
  });
  const versionB = materialAssetVersion({
    record: { ...recordBase, permitted_claim_packet_json: JSON.stringify({ permitted_claims: [{ claim_id: 'cB' }] }) },
    stageId: 'linkedin_1',
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
    permitted_claim_packet_json: JSON.stringify({ permitted_claims: [{ claim_id: 'cB' }] }),
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

const runLinkedin = async ({ listDir, db, record, dryRun = false }) =>
  executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Stage Review Gate Test',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step: linkedinStep,
    sequence: { steps: [linkedinStep] },
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
  // Without Unipile credentials the path is skipped for readiness — still past review.
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
    // Unconfigured Unipile is the expected stop after the review gate opens.
    assert.equal(out.status, 'skipped');
    assert.match(String(out.reason), /unipile_not_configured|unipile_/i);

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
  const claimA = JSON.stringify({ permitted_claims: [{ claim_id: 'claim_A' }] });
  const claimB = JSON.stringify({ permitted_claims: [{ claim_id: 'claim_B' }] });

  const { listDir, db, rowId } = seedList({
    rowId: accountId,
    reviewRequiredFor: ['linkedin_connect'],
    next_action_json: JSON.stringify(
      nextAction(accountId, { action_type: 'linkedin_connect' }),
    ),
  });
  // Stamp content version A onto the record before authorize.
  const seeded = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  ensureRecordColumns({ db, columns: ['permitted_claim_packet_json'] });
  upsertRecord({
    db,
    row: { ...seeded, permitted_claim_packet_json: claimA },
  });
  const withA = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const versionA = materialAssetVersion({
    record: withA,
    stageId: 'linkedin_1',
    policyVersion: 'tv-pipeline-v1',
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
      permitted_claim_packet_json: claimA,
    },
  });

  // Material change: claim packet becomes B → current asset_version drifts.
  const beforeSend = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  upsertRecord({
    db,
    row: { ...beforeSend, permitted_claim_packet_json: claimB },
  });
  const versionB = materialAssetVersion({
    record: { ...beforeSend, permitted_claim_packet_json: claimB },
    stageId: 'linkedin_1',
    policyVersion: 'tv-pipeline-v1',
  });
  assert.notEqual(versionA, versionB);

  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const prevFixture = process.env.AO_UNIPILE_FIXTURE;
  delete process.env.AO_UNIPILE_FIXTURE;
  try {
    const out = await runLinkedin({ listDir, db, record, dryRun: false });
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
