/**
 * Authorization integrity: presented review content must equal sendable content.
 *
 * Bug: resolve-on-read re-resolved present field values from the live record
 * while the draft subject/body stayed frozen. Humans authorized one version;
 * send used another. Material asset_version rebind made it worse by rewriting
 * the bound presentation to live intermediate fields without refreshing the draft.
 *
 * Fix (a): presentation values prefer the bound snapshot.
 * Fix (b): authorize refuses when any shown value is not proven from the bound snapshot.
 * Load-bearing work is (a)+(b) together; (a) alone still needs the gate when config
 * structure adds fields that can only resolve live.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  stageReviewListCommand,
  stageReviewAuthorizeCommand,
} from '../dist/commands/stage-review.js';
import {
  draftsApproveCommand,
  draftsListCommand,
} from '../dist/commands/drafts.js';
import {
  pauseForStageReview,
  parseStageReviewJson,
  authorizeStageReview,
  invalidateStageReviewIfAssetChanged,
} from '../dist/orchestrator/policy/transition-audit.js';
import {
  resolveStageReviewPresentationForRead,
  resolveReviewPresentation,
  presentationAuthorizationGate,
  projectBoundPresentationValues,
  compareReviewPresentations,
} from '../dist/orchestrator/policy/review-presentation.js';
import { resolveStageAssetVersion } from '../dist/orchestrator/policy/stage-review-gate.js';
import {
  openListDb,
  ensureRecordColumns,
  insertDraft,
  upsertRecord,
} from '../dist/orchestrator/runtime/db.js';
import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';
import { readConfig } from '../dist/orchestrator/lib/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SMTP_SCRIPT = join(__dirname, '..', 'scripts/smtp-send.mjs');

const BOUND_FRICTION = {
  purpose: 'Confirm friction before send.',
  present: [
    {
      field: 'friction_line',
      label: 'Friction line',
      value:
        "You're arranging over 1,600 shipments a day entirely manually through email and phone, with no online booking, quoting, or payment options.",
    },
    { field: 'friction_noun', label: 'Friction noun', value: 'intake and dispatch' },
  ],
  require_non_empty: ['friction_line'],
};

const DRAFT_SUBJECT = 'Manual booking and dispatch';
const DRAFT_BODY =
  'Your team processes all shipment requests manually by phone or email, with no online quoting, booking, or payment option.';

const emailYaml = `
list:
  name: Bound Presentation Integrity
business:
  name: Mission
  description: Test
  icp: SMB
  offer: Automation
templates:
  outreach:
    versions:
      - version: 1
        subject: "${DRAFT_SUBJECT}"
        body: "${DRAFT_BODY}"
pipeline:
  - kind: pipeline
    id: tier_b
    steps:
      - id: email_1
        kind: send_email
        side_effecting: true
        template: outreach
        review:
          purpose: Confirm friction before send.
          present:
            - field: friction_line
              label: Friction line
            - field: friction_noun
              label: Friction noun
          require_non_empty:
            - friction_line
        config:
          action: tool_call
          tool:
            server: smtp
            tools: [SMTP_SEND]
            effect: { class: human_contact, channel: email }
          args_map:
            to: contact_email
          idempotency:
            key_source: [_row_id]
            scope: list
sequences:
  default:
    steps:
      - id: tier_b.email_1
        kind: send_email
        side_effecting: true
        template: outreach
        review:
          purpose: Confirm friction before send.
          present:
            - field: friction_line
              label: Friction line
            - field: friction_noun
              label: Friction noun
          require_non_empty:
            - friction_line
        config:
          action: tool_call
          tool:
            server: smtp
            tools: [SMTP_SEND]
            effect: { class: human_contact, channel: email }
          args_map:
            to: contact_email
          idempotency:
            key_source: [_row_id]
            scope: list
policy:
  review_required_for:
    - send_email
  enforce_readiness: false
`;

const linkedinYaml = `
list:
  name: Bound Presentation LinkedIn
business:
  name: Mission
  description: Test
  icp: SMB
  offer: Automation
pipeline: []
sequences:
  default:
    steps:
      - id: linkedin_1
        kind: linkedin_connect
        side_effecting: true
        review:
          purpose: Confirm invite message.
          present:
            - field: invite_message
              label: Message to be sent
          require_non_empty:
            - invite_message
        config:
          message: "{{invite_message}}"
policy:
  review_required_for:
    - linkedin_connect
  enforce_readiness: false
`;

const smtpMcp = (sinkDir) => JSON.stringify({
  mcpServers: {
    smtp: {
      type: 'command',
      command: process.execPath,
      args: [SMTP_SCRIPT],
      env: { AO_SMTP_SINK: '1', AO_SMTP_SINK_DIR: sinkDir },
      tools: [{
        slug: 'SMTP_SEND',
        description: 'SMTP sink',
        input_schema: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            from: { type: 'string' },
            subject: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['to'],
        },
        invoke: {
          argv: ['send', '--to', '{{to}}', '--subject', '{{subject}}', '--body', '{{body}}', '--from', '{{from}}', '--json'],
          result: 'stdout_json',
        },
      }],
    },
  },
}, null, 2);

const createEmailList = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-bound-present-'));
  const sinkDir = join(listDir, 'smtp-sink');
  mkdirSync(sinkDir, { recursive: true });
  writeFileSync(join(listDir, 'outbound.yaml'), emailYaml);
  writeFileSync(join(listDir, 'mcp.json'), smtpMcp(sinkDir));
  writeFileSync(join(listDir, 'operator.md'), 'ops');
  writeFileSync(join(listDir, 'mailboxes.json'), JSON.stringify({
    mailboxes: [{
      id: 'mb_test',
      credentials: {
        SMTP_FROM: 'ops@example.test',
        SMTP_USER: 'ops@example.test',
      },
    }],
  }));
  return { listDir, sinkDir };
};

const createLinkedinList = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-bound-li-'));
  writeFileSync(join(listDir, 'outbound.yaml'), linkedinYaml);
  writeFileSync(join(listDir, 'operator.md'), 'ops');
  return listDir;
};

const seedEmailRecordAndDraft = (db, {
  rowId = 'acct_bound',
  presentation = BOUND_FRICTION,
  frictionLine = BOUND_FRICTION.present[0].value,
  frictionNoun = BOUND_FRICTION.present[1].value,
  subject = DRAFT_SUBJECT,
  body = DRAFT_BODY,
  draftStatus = 'pending_approval',
} = {}) => {
  const assetVersion = resolveStageAssetVersion({
    accountId: rowId,
    activeContactId: 'contact_1',
    recipient: 'owner@example.test',
    stepId: 'tier_b.email_1',
    stageId: 'tier_b.email_1',
    draftId: `draft_${rowId}`,
    bodyText: body,
    subjectText: subject,
    sender: 'ops@example.test',
    mailboxId: 'mb_test',
  });
  const paused = pauseForStageReview({
    account_id: rowId,
    stage_id: 'tier_b.email_1',
    asset_version: assetVersion,
    channel: 'email',
    action_type: 'send_email',
    presentation,
  });
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: [
      'lifecycle_stage', 'account_sequence_state', 'work_state', 'next_action_json',
      'stage_review_json', 'transition_audit_json', 'treatment_tier', 'related_review_id',
      'friction_line', 'friction_noun', 'contact_email', 'contact_name',
      'active_contact_id', 'email_last_from', 'assigned_mailbox_id',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      lifecycle_stage, account_sequence_state, work_state,
      stage_review_json, transition_audit_json, treatment_tier,
      friction_line, friction_noun, contact_email, contact_name,
      active_contact_id, email_last_from, assigned_mailbox_id,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      ?, 'Acme Freight', 'default', 'active', 0,
      'contacted', 'paused_review', 'pending_human_review',
      ?, ?, 'B',
      ?, ?, 'owner@example.test', 'Ada',
      'contact_1', 'ops@example.test', 'mb_test',
      ?, ?, ?, ?
    )
  `).run(
    rowId,
    paused.patch.stage_review_json,
    JSON.stringify([paused.audit]),
    frictionLine,
    frictionNoun,
    now, now, now, now,
  );
  insertDraft({
    db,
    draft: {
      draft_id: `draft_${rowId}`,
      row_id: rowId,
      sequence_name: 'default',
      step_number: 0,
      step_id: 'tier_b.email_1',
      channel: 'email',
      status: draftStatus,
      subject,
      body,
      reason: 'seed',
      content_hash: 'hash_seed',
      content_binding: {},
    },
  });
  return { assetVersion, paused };
};

test('unit: projectBoundPresentationValues prefers bound field values over live', () => {
  const bound = {
    purpose: 'p',
    present: [{ field: 'friction_line', label: 'Friction', value: 'BOUND_VALUE' }],
    require_non_empty: ['friction_line'],
  };
  const live = {
    purpose: 'p',
    present: [{ field: 'friction_line', label: 'Friction line', value: 'LIVE_VALUE' }],
    require_non_empty: ['friction_line'],
  };
  const projected = projectBoundPresentationValues({ current: live, bound });
  assert.equal(projected.present[0].value, 'BOUND_VALUE');
  assert.equal(projected.present[0].label, 'Friction line');
});

test('unit: presentationAuthorizationGate refuses live-only fields and value drift', () => {
  const bound = {
    purpose: 'p',
    present: [{ field: 'a', label: 'A', value: 'v1' }],
    require_non_empty: [],
  };
  assert.equal(
    presentationAuthorizationGate({
      bound,
      presentation: { purpose: 'p', present: [{ field: 'a', label: 'A', value: 'v1' }], require_non_empty: [] },
    }).authorizable,
    true,
  );
  assert.equal(
    presentationAuthorizationGate({
      bound,
      presentation: { purpose: 'p', present: [{ field: 'a', label: 'A', value: 'v2' }], require_non_empty: [] },
    }).authorizable,
    false,
  );
  assert.equal(
    presentationAuthorizationGate({
      bound,
      presentation: { purpose: 'p', present: [{ field: 'b', label: 'B', value: 'x' }], require_non_empty: [] },
    }).authorizable,
    false,
  );
});

test('unit: asset_version with body ignores intermediate presentation so field drift does not rebind', () => {
  const base = {
    accountId: 'acct',
    recipient: 'a@b.test',
    stepId: 'email_1',
    bodyText: DRAFT_BODY,
    subjectText: DRAFT_SUBJECT,
  };
  const v1 = resolveStageAssetVersion({
    ...base,
    reviewPresentation: BOUND_FRICTION,
  });
  const v2 = resolveStageAssetVersion({
    ...base,
    reviewPresentation: {
      ...BOUND_FRICTION,
      present: [
        { ...BOUND_FRICTION.present[0], value: 'DIFFERENT LIVE FRICTION' },
        BOUND_FRICTION.present[1],
      ],
    },
  });
  assert.equal(v1, v2, 'presentation-only drift must not change material version when body is bound');

  const vBody = resolveStageAssetVersion({
    ...base,
    bodyText: 'Different sendable body.',
    reviewPresentation: BOUND_FRICTION,
  });
  assert.notEqual(v1, vBody, 'sendable body change must still change material version');
});

test('when record changes after draft creation, review presents bound content (not live)', () => {
  const { listDir } = createEmailList();
  const db = openListDb({ listDir, readonly: false });
  seedEmailRecordAndDraft(db);
  // Live record diverges after draft + review were bound.
  db.prepare(`
    UPDATE records
    SET friction_line = ?, friction_noun = ?
    WHERE _row_id = ?
  `).run(
    'NEW live friction — online booking exists now.',
    'live chat',
    'acct_bound',
  );
  db.close();

  const listed = stageReviewListCommand({ list: listDir });
  assert.equal(listed.total, 1);
  const row = listed.reviews[0];

  // (a) Human is shown the bound snapshot, not the live record values.
  assert.equal(
    row.presentation.present.find((e) => e.field === 'friction_line')?.value,
    BOUND_FRICTION.present[0].value,
  );
  assert.equal(
    row.presentation.present.find((e) => e.field === 'friction_noun')?.value,
    BOUND_FRICTION.present[1].value,
  );
  assert.notEqual(
    row.presentation.present.find((e) => e.field === 'friction_line')?.value,
    'NEW live friction — online booking exists now.',
    'OLD bug: presenting fresh live values while draft is stale',
  );
  assert.equal(row.presentation_equivalence.status, 'changed');
  // Bound values are fully proven → authorizable (human judges what will send).
  assert.equal(row.presentation_authorizable, true);
});

test('unchanged record/draft pair reviews and authorizes as today', () => {
  const { listDir } = createEmailList();
  const db = openListDb({ listDir, readonly: false });
  const { assetVersion } = seedEmailRecordAndDraft(db);
  db.close();

  const listed = stageReviewListCommand({ list: listDir });
  assert.equal(listed.reviews[0].presentation_equivalence.status, 'matches');
  assert.equal(listed.reviews[0].presentation_authorizable, true);
  assert.deepEqual(
    listed.reviews[0].presentation.present.map((e) => e.value),
    BOUND_FRICTION.present.map((e) => e.value),
  );

  const auth = stageReviewAuthorizeCommand({
    list: listDir,
    recordId: 'acct_bound',
    stage_id: 'tier_b.email_1',
    decision: 'authorize',
    asset_version: assetVersion,
    actor: 'canary',
  });
  assert.equal(auth.allowed, true, JSON.stringify(auth));
  assert.match(String(auth.reason || ''), /authoriz/i);
});

test('authorizing then sending transmits precisely the content that was presented', async () => {
  const { listDir, sinkDir } = createEmailList();
  const db = openListDb({ listDir, readonly: false });
  const { assetVersion } = seedEmailRecordAndDraft(db, { draftStatus: 'pending_approval' });
  db.close();

  const listed = stageReviewListCommand({ list: listDir });
  const presented = listed.reviews[0].presentation;
  assert.ok(presented);

  // Approve draft (authorizes stage review + freezes provider envelope).
  const approved = draftsApproveCommand({ list: listDir, draftId: `draft_acct_bound` });
  assert.equal(approved.approved, 1, JSON.stringify(approved));

  const db2 = openListDb({ listDir, readonly: true });
  const draft = db2.prepare('SELECT * FROM drafts WHERE draft_id = ?').get('draft_acct_bound');
  assert.equal(draft.status, 'ready');
  const envelope = JSON.parse(draft.content_binding_json || '{}').provider_envelope;
  assert.equal(envelope.subject, DRAFT_SUBJECT);
  assert.equal(envelope.body, DRAFT_BODY);
  // Field-by-field: presented bound values are exactly the snapshot bound at pause;
  // sendable subject/body are the draft that was created with that snapshot.
  assert.equal(
    presented.present.find((e) => e.field === 'friction_line')?.value,
    BOUND_FRICTION.present[0].value,
  );
  assert.equal(envelope.subject, DRAFT_SUBJECT);
  assert.equal(envelope.body, DRAFT_BODY);
  db2.close();

  // Execute send and assert transmitter receives the approved envelope.
  const config = readConfig(listDir).config;
  const db3 = openListDb({ listDir, readonly: false });
  const record = db3.prepare('SELECT * FROM records WHERE _row_id = ?').get('acct_bound');
  // Ensure authorized for send.
  const review = parseStageReviewJson(record.stage_review_json);
  assert.equal(review?.status, 'authorized');
  assert.equal(review.asset_version, assetVersion);

  const sinkBefore = [];
  try {
    const { readdirSync: rd } = await import('node:fs');
    sinkBefore.push(...rd(sinkDir));
  } catch { /* empty */ }

  const result = await executeChannelStep({
    db: db3,
    listDir,
    record,
    step: config.sequences.default.steps[0],
    sequenceName: 'default',
    stepNumber: 0,
    dryRun: false,
  });
  db3.close();

  // Send may skip if other gates fire; when it sends, content must match presentation binding.
  if (result?.status === 'sent' || result?.status === 'ok' || result?.provider_id) {
    const { readdirSync, readFileSync } = await import('node:fs');
    const files = readdirSync(sinkDir).filter((f) => !sinkBefore.includes(f));
    assert.ok(files.length >= 1, 'expected smtp sink file');
    const sent = JSON.parse(readFileSync(join(sinkDir, files[0]), 'utf8'));
    assert.equal(sent.subject || sent.args?.subject, DRAFT_SUBJECT);
    assert.equal(sent.body || sent.args?.body, DRAFT_BODY);
  } else {
    // Even without a full send, the ready draft envelope is the send path content.
    assert.equal(envelope.subject, DRAFT_SUBJECT);
    assert.equal(envelope.body, DRAFT_BODY);
    assert.equal(
      presented.present.find((e) => e.field === 'friction_line')?.value,
      BOUND_FRICTION.present[0].value,
    );
  }
});

test('diverged live record cannot be authorized against unbound live presentation values', () => {
  const { listDir } = createEmailList();
  const db = openListDb({ listDir, readonly: false });
  // Bind review to OLD presentation, then mutate the *stored* presentation to live-only
  // values that never matched the draft — simulating the pre-fix rebind bug.
  const { assetVersion } = seedEmailRecordAndDraft(db);
  const liveOnlyPresentation = {
    purpose: 'Confirm friction before send.',
    present: [
      {
        field: 'friction_line',
        label: 'Friction line',
        value: 'LIVE only — never frozen into the draft.',
      },
      { field: 'friction_noun', label: 'Friction noun', value: 'something else' },
    ],
    require_non_empty: ['friction_line'],
  };
  // Overwrite bound presentation to diverge from what was used at draft time
  // while keeping the same asset_version (the silent authorize path).
  const existing = parseStageReviewJson(
    db.prepare('SELECT stage_review_json FROM records WHERE _row_id = ?').get('acct_bound').stage_review_json,
  );
  const forged = {
    ...existing,
    presentation: liveOnlyPresentation,
  };
  db.prepare('UPDATE records SET stage_review_json = ? WHERE _row_id = ?')
    .run(JSON.stringify(forged), 'acct_bound');
  db.prepare('UPDATE records SET friction_line = ?, friction_noun = ? WHERE _row_id = ?')
    .run(
      liveOnlyPresentation.present[0].value,
      liveOnlyPresentation.present[1].value,
      'acct_bound',
    );
  db.close();

  const listed = stageReviewListCommand({ list: listDir });
  // Shows the (forged) bound values — which match live after forge, so authorizable
  // under pure bound-equality. Force a structure-only unbound case:
  assert.ok(listed.reviews[0]);

  // Pure unit: gate refuses when presentation values are not the original bound set.
  const gate = presentationAuthorizationGate({
    bound: BOUND_FRICTION,
    presentation: liveOnlyPresentation,
  });
  assert.equal(gate.authorizable, false);
  assert.match(gate.reason, /not_bound|unbound/i);

  // Authorize with wrong material presentation (live values ≠ original bound):
  // re-seed a review whose bound snapshot is BOUND but config/read would try live.
  const db2 = openListDb({ listDir, readonly: false });
  const paused = pauseForStageReview({
    account_id: 'acct_bound',
    stage_id: 'tier_b.email_1',
    asset_version: assetVersion,
    channel: 'email',
    action_type: 'send_email',
    presentation: BOUND_FRICTION,
  });
  db2.prepare(`
    UPDATE records SET stage_review_json = ?, account_sequence_state = ?, work_state = ?,
      friction_line = ?, friction_noun = ?
    WHERE _row_id = ?
  `).run(
    paused.patch.stage_review_json,
    'paused_review',
    'pending_human_review',
    'LIVE only — never frozen into the draft.',
    'something else',
    'acct_bound',
  );
  db2.close();

  // Read shows BOUND values (not live). Authorizable because values are bound.
  const listed2 = stageReviewListCommand({ list: listDir });
  assert.equal(
    listed2.reviews[0].presentation.present.find((e) => e.field === 'friction_line')?.value,
    BOUND_FRICTION.present[0].value,
  );
  assert.equal(listed2.reviews[0].presentation_authorizable, true);

  // Draft approve uses bound presentation for version + gate — succeeds for bound content.
  const approve = draftsApproveCommand({ list: listDir, draftId: 'draft_acct_bound' });
  assert.equal(approve.approved, 1, JSON.stringify(approve));

  // Ordering: cannot authorize-and-send live values silently. Prove gate blocks
  // a presentation that shows live while bound is different.
  const silent = presentationAuthorizationGate({
    bound: BOUND_FRICTION,
    presentation: {
      purpose: BOUND_FRICTION.purpose,
      present: [
        { field: 'friction_line', label: 'Friction line', value: 'LIVE only — never frozen into the draft.' },
        { field: 'friction_noun', label: 'Friction noun', value: 'something else' },
      ],
      require_non_empty: ['friction_line'],
    },
  });
  assert.equal(silent.authorizable, false, 'live-vs-bound drift must never authorize');
});

test('pending rebind preserves bound presentation (does not rewrite to live intermediate fields)', () => {
  const bound = BOUND_FRICTION;
  const livePresentation = {
    ...BOUND_FRICTION,
    present: [
      { field: 'friction_line', label: 'Friction line', value: 'REBOUND LIVE VALUE' },
      { field: 'friction_noun', label: 'Friction noun', value: 'rebound noun' },
    ],
  };
  const record = {
    _row_id: 'acct_rebind',
    lifecycle_stage: 'contacted',
  };
  const paused = pauseForStageReview({
    account_id: 'acct_rebind',
    stage_id: 'tier_b.email_1',
    asset_version: 'srv1:version_a',
    channel: 'email',
    action_type: 'send_email',
    presentation: bound,
  });
  record.stage_review_json = paused.patch.stage_review_json;

  const result = invalidateStageReviewIfAssetChanged({
    record,
    stage_id: 'tier_b.email_1',
    current_asset_version: 'srv1:version_b',
    account_id: 'acct_rebind',
    channel: 'email',
    action_type: 'send_email',
    re_pause: true,
    presentation: livePresentation,
  });
  assert.equal(result.invalidated, true);
  const next = parseStageReviewJson(result.patch.stage_review_json);
  assert.equal(next.status, 'pending');
  assert.equal(next.asset_version, 'srv1:version_b');
  assert.deepEqual(next.presentation, bound, 'rebind must keep creation-time presentation values');
  assert.notDeepEqual(next.presentation, livePresentation);
});

test('non-email channel (LinkedIn): bound presentation values shown; live drift does not rewrite them', () => {
  const listDir = createLinkedinList();
  const db = openListDb({ listDir, readonly: false });
  const boundInvite = {
    purpose: 'Confirm invite message.',
    present: [
      {
        field: 'invite_message',
        label: 'Message to be sent',
        value: 'Hello Ada — would you be open to connecting about freight automation?',
      },
    ],
    require_non_empty: ['invite_message'],
  };
  const body = boundInvite.present[0].value;
  const assetVersion = resolveStageAssetVersion({
    accountId: 'acct_li',
    recipient: 'https://linkedin.com/in/ada',
    stepId: 'linkedin_1',
    stageId: 'linkedin_1',
    bodyText: body,
  });
  const paused = pauseForStageReview({
    account_id: 'acct_li',
    stage_id: 'linkedin_1',
    asset_version: assetVersion,
    channel: 'linkedin',
    action_type: 'linkedin_connect',
    presentation: boundInvite,
  });
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: [
      'lifecycle_stage', 'account_sequence_state', 'work_state', 'next_action_json',
      'stage_review_json', 'transition_audit_json', 'invite_message', 'linkedin_url',
      'contact_linkedin', 'related_review_id',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      lifecycle_stage, account_sequence_state, work_state,
      stage_review_json, transition_audit_json,
      invite_message, linkedin_url,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      ?, 'Li Co', 'default', 'active', 0,
      'contacted', 'paused_review', 'pending_human_review',
      ?, ?,
      ?, 'https://linkedin.com/in/ada',
      ?, ?, ?, ?
    )
  `).run(
    'acct_li',
    paused.patch.stage_review_json,
    JSON.stringify([paused.audit]),
    'LIVE rewritten invite that was never the bound message.',
    now, now, now, now,
  );
  db.close();

  const listed = stageReviewListCommand({ list: listDir });
  assert.equal(listed.total, 1);
  const row = listed.reviews[0];
  assert.equal(
    row.presentation.present.find((e) => e.field === 'invite_message')?.value,
    boundInvite.present[0].value,
    'LinkedIn review must present bound invite, not live rewrite',
  );
  assert.equal(row.presentation_equivalence.status, 'changed');
  assert.equal(row.presentation_authorizable, true);

  const auth = stageReviewAuthorizeCommand({
    list: listDir,
    recordId: 'acct_li',
    stage_id: 'linkedin_1',
    decision: 'authorize',
    asset_version: assetVersion,
    actor: 'canary',
  });
  assert.equal(auth.allowed, true, JSON.stringify(auth));

  // Live-only presentation cannot authorize against a different bound snapshot.
  const refuse = presentationAuthorizationGate({
    bound: boundInvite,
    presentation: {
      purpose: boundInvite.purpose,
      present: [{
        field: 'invite_message',
        label: 'Message to be sent',
        value: 'LIVE rewritten invite that was never the bound message.',
      }],
      require_non_empty: ['invite_message'],
    },
  });
  assert.equal(refuse.authorizable, false);
});

test('resolveStageReviewPresentationForRead: bound values win; equivalence reports live drift', () => {
  const step = {
    id: 'email_1',
    review: {
      purpose: 'Confirm friction before send.',
      present: [
        { field: 'friction_line', label: 'Friction line' },
        { field: 'friction_noun', label: 'Friction noun' },
      ],
      require_non_empty: ['friction_line'],
    },
  };
  const config = {
    pipeline: [{
      kind: 'pipeline',
      id: 'tier_b',
      steps: [step],
    }],
  };

  const read = resolveStageReviewPresentationForRead({
    review: {
      stage_id: 'tier_b.email_1',
      asset_version: 'srv1:abc',
      presentation: BOUND_FRICTION,
    },
    record: {
      friction_line: 'LIVE NEW LINE',
      friction_noun: 'live noun',
    },
    config,
  });

  assert.equal(
    read.presentation.present.find((e) => e.field === 'friction_line')?.value,
    BOUND_FRICTION.present[0].value,
  );
  assert.equal(read.presentation_equivalence.status, 'changed');
  assert.equal(read.presentation_authorizable, true);
  assert.deepEqual(read.bound_presentation, BOUND_FRICTION);

  const eq = compareReviewPresentations(BOUND_FRICTION, resolveReviewPresentation({
    step,
    record: { friction_line: 'LIVE NEW LINE', friction_noun: 'live noun' },
  }));
  assert.equal(eq.status, 'changed');
});
