/**
 * Stage-review presentation is resolved at read time (like draft content_equivalence).
 *
 * Bug class: a pending review stored presentation at creation and never re-resolved,
 * so operators judged stale fields after config/content moved.
 *
 * Does not change authorization — asset_version gate stays exact-version bound.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  stageReviewListCommand,
  stageReviewAuthorizeCommand,
} from '../dist/commands/stage-review.js';
import {
  decisionViewCommand,
  timelineCommand,
} from '../dist/commands/operator-surfaces.js';
import {
  pauseForStageReview,
  parseStageReviewJson,
} from '../dist/orchestrator/policy/transition-audit.js';
import {
  openListDb,
  ensureRecordColumns,
} from '../dist/orchestrator/runtime/db.js';

const STAGE_ID = 'tier_b.email_1';
const BOUND_ASSET = 'srv1_bound_at_creation';

const stalePresentation = {
  purpose: 'Confirm the pre-template email copy.',
  present: [
    {
      field: 'email_subject',
      label: 'Subject',
      value: 'Intake and booking at a practice like yours tend to run manual',
    },
    {
      field: 'email_body',
      label: 'Body',
      value:
        'Intake and booking at a practice like yours tend to run manual … Ray Mission Reply STOP and I will not contact you again.',
    },
  ],
  require_non_empty: ['email_subject', 'email_body'],
};

const currentReviewBlock = `
        review:
          purpose: Confirm friction and evidence before send.
          present:
            - field: friction_line
              label: Friction line
            - field: friction_noun
              label: Friction noun
            - field: preliminary_snapshot
              label: Snapshot
          require_non_empty:
            - friction_line
`;

const projectYaml = ({ includeCurrentReview = true } = {}) => `
list:
  name: Stage Review Presentation Read
business:
  name: Mission
  description: Test
  icp: SMB
  offer: Automation
pipeline:
  - kind: pipeline
    id: tier_b
    steps:
      - id: email_1
        kind: send_email
        side_effecting: true
${includeCurrentReview ? currentReviewBlock : ''}
sequences:
  default:
    steps: []
policy:
  review_required_for:
    - send_email
`;

const createList = (yaml = projectYaml()) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-stage-review-present-'));
  writeFileSync(join(listDir, 'outbound.yaml'), yaml);
  writeFileSync(join(listDir, 'operator.md'), 'ops');
  return listDir;
};

const seedPendingReview = (db, {
  rowId = 'acct_present',
  presentation = stalePresentation,
  asset_version = BOUND_ASSET,
  recordFields = {},
} = {}) => {
  const now = new Date().toISOString();
  const paused = pauseForStageReview({
    account_id: rowId,
    stage_id: STAGE_ID,
    asset_version,
    channel: 'email',
    action_type: 'send_email',
    presentation,
  });
  const columns = [
    'lifecycle_stage',
    'account_sequence_state',
    'work_state',
    'next_action_json',
    'stage_review_json',
    'transition_audit_json',
    'treatment_tier',
    'related_review_id',
    'friction_line',
    'friction_noun',
    'preliminary_snapshot',
    'email_subject',
    'email_body',
    ...Object.keys(recordFields),
  ];
  ensureRecordColumns({ db, columns: [...new Set(columns)] });

  const extraCols = Object.keys(recordFields);
  const extraPlaceholders = extraCols.map(() => '?').join(', ');
  const extraSql = extraCols.length ? `, ${extraCols.join(', ')}` : '';
  const extraVals = extraCols.map((key) => recordFields[key]);

  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      lifecycle_stage, account_sequence_state, work_state,
      stage_review_json, transition_audit_json, treatment_tier,
      friction_line, friction_noun, preliminary_snapshot,
      email_subject, email_body,
      _created_at, _updated_at, created_at, updated_at
      ${extraSql}
    ) VALUES (
      ?, 'Acme PT', 'default', 'active', 0,
      'contacted', 'paused_review', 'pending_human_review',
      ?, ?, 'B',
      ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?
      ${extraCols.length ? `, ${extraPlaceholders}` : ''}
    )
  `).run(
    rowId,
    paused.patch.stage_review_json,
    JSON.stringify([paused.audit]),
    recordFields.friction_line
      ?? "You've implemented online booking and payment, but patients with quick questions before booking have no live chat option.",
    recordFields.friction_noun ?? 'live chat',
    recordFields.preliminary_snapshot ?? 'Online booking present; no live chat.',
    recordFields.email_subject
      ?? 'Intake and booking at a practice like yours tend to run manual',
    recordFields.email_body
      ?? 'Intake and booking at a practice like yours tend to run manual … Ray Mission Reply STOP and I will not contact you again.',
    now,
    now,
    now,
    now,
    ...extraVals,
  );

  return paused;
};

test('stage-review list resolves current structure when stage config changed since creation', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  seedPendingReview(db);
  db.close();

  const listed = stageReviewListCommand({ list: listDir });
  assert.equal(listed.total, 1);
  const row = listed.reviews[0];

  assert.equal(row.presentation_equivalence.status, 'changed');
  assert.ok(row.presentation_equivalence.changed_fields.length > 0);

  const fields = (row.presentation?.present || []).map((entry) => entry.field).sort();
  assert.deepEqual(fields, ['friction_line', 'friction_noun', 'preliminary_snapshot']);
  // New fields (not in bound snapshot) surface live values, but are not authorizable.
  assert.equal(
    row.presentation.present.find((entry) => entry.field === 'friction_line')?.value,
    "You've implemented online booking and payment, but patients with quick questions before booking have no live chat option.",
  );
  assert.ok(
    !(row.presentation?.present || []).some((entry) => entry.field === 'email_subject'),
    'current presentation must not surface stale email_subject',
  );
  assert.equal(row.presentation_authorizable, false);
  assert.match(String(row.presentation_authorization_reason || ''), /unbound/i);
});

test('stage-review list retains bound presentation and asset_version for history', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  seedPendingReview(db, { asset_version: BOUND_ASSET, presentation: stalePresentation });
  db.close();

  const listed = stageReviewListCommand({ list: listDir });
  const row = listed.reviews[0];

  assert.equal(row.asset_version, BOUND_ASSET);
  assert.equal(row.bound_asset_version, BOUND_ASSET);
  assert.deepEqual(row.bound_presentation, stalePresentation);

  // Stored packet on the record is still the creation-time snapshot (not overwritten).
  const db2 = openListDb({ listDir, readonly: true });
  const stored = db2.prepare('SELECT stage_review_json FROM records WHERE _row_id = ?')
    .get('acct_present');
  const parsed = parseStageReviewJson(stored.stage_review_json);
  assert.deepEqual(parsed.presentation, stalePresentation);
  assert.equal(parsed.asset_version, BOUND_ASSET);
  db2.close();
});

const matchingFrictionPresentation = {
  purpose: 'Confirm friction and evidence before send.',
  present: [
    {
      field: 'friction_line',
      label: 'Friction line',
      value:
        "You've implemented online booking and payment, but patients with quick questions before booking have no live chat option.",
    },
    { field: 'friction_noun', label: 'Friction noun', value: 'live chat' },
    {
      field: 'preliminary_snapshot',
      label: 'Snapshot',
      value: 'Online booking present; no live chat.',
    },
  ],
  require_non_empty: ['friction_line'],
};

test('CONTROL: unchanged config and values report matches and read as before', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  seedPendingReview(db, { presentation: matchingFrictionPresentation });
  db.close();

  const listed = stageReviewListCommand({ list: listDir });
  const row = listed.reviews[0];

  assert.equal(row.presentation_equivalence.status, 'matches');
  assert.deepEqual(row.presentation_equivalence.changed_fields, []);
  assert.deepEqual(row.presentation, matchingFrictionPresentation);
  assert.deepEqual(row.bound_presentation, matchingFrictionPresentation);
  assert.equal(row.presentation_authorizable, true);
  assert.equal(row.asset_version, BOUND_ASSET);
  assert.equal(row.bound_asset_version, BOUND_ASSET);
});

test('CONTROL: authorization still accepts bound version and refuses mismatch', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  // Structure-migrated bound presentation is not authorizable (live-only fields).
  seedPendingReview(db, { asset_version: BOUND_ASSET, presentation: stalePresentation });
  db.close();

  const listed = stageReviewListCommand({ list: listDir });
  assert.equal(listed.reviews[0].presentation_equivalence.status, 'changed');
  assert.equal(listed.reviews[0].presentation_authorizable, false);
  assert.equal(listed.reviews[0].asset_version, BOUND_ASSET);

  const unbound = stageReviewAuthorizeCommand({
    list: listDir,
    recordId: 'acct_present',
    stage_id: STAGE_ID,
    decision: 'authorize',
    asset_version: BOUND_ASSET,
    actor: 'canary',
  });
  assert.equal(unbound.allowed, false);
  assert.match(String(unbound.reason || ''), /unbound|presentation/i);

  // Re-seed with a fully bound presentation so the version gate can be tested.
  const db2 = openListDb({ listDir, readonly: false });
  const paused = pauseForStageReview({
    account_id: 'acct_present',
    stage_id: STAGE_ID,
    asset_version: BOUND_ASSET,
    channel: 'email',
    action_type: 'send_email',
    presentation: matchingFrictionPresentation,
  });
  ensureRecordColumns({
    db: db2,
    columns: ['stage_review_json', 'account_sequence_state', 'work_state', 'next_action_json', 'related_review_id'],
  });
  db2.prepare(`
    UPDATE records
    SET stage_review_json = ?,
        account_sequence_state = ?,
        work_state = ?,
        next_action_json = ?,
        related_review_id = ?
    WHERE _row_id = ?
  `).run(
    paused.patch.stage_review_json,
    paused.patch.account_sequence_state,
    paused.patch.work_state,
    paused.patch.next_action_json,
    paused.patch.related_review_id,
    'acct_present',
  );
  db2.close();

  const mismatch = stageReviewAuthorizeCommand({
    list: listDir,
    recordId: 'acct_present',
    stage_id: STAGE_ID,
    decision: 'authorize',
    asset_version: 'wrong_version',
    actor: 'canary',
  });
  assert.equal(mismatch.allowed, false);
  assert.equal(mismatch.reason, 'asset_version_mismatch');

  // Re-seed pending after invalidation (authorize mismatch invalidates the packet).
  const db3 = openListDb({ listDir, readonly: false });
  const paused2 = pauseForStageReview({
    account_id: 'acct_present',
    stage_id: STAGE_ID,
    asset_version: BOUND_ASSET,
    channel: 'email',
    action_type: 'send_email',
    presentation: matchingFrictionPresentation,
  });
  ensureRecordColumns({
    db: db3,
    columns: ['stage_review_json', 'account_sequence_state', 'work_state', 'next_action_json', 'related_review_id'],
  });
  db3.prepare(`
    UPDATE records
    SET stage_review_json = ?,
        account_sequence_state = ?,
        work_state = ?,
        next_action_json = ?,
        related_review_id = ?
    WHERE _row_id = ?
  `).run(
    paused2.patch.stage_review_json,
    paused2.patch.account_sequence_state,
    paused2.patch.work_state,
    paused2.patch.next_action_json,
    paused2.patch.related_review_id,
    'acct_present',
  );
  db3.close();

  const ok = stageReviewAuthorizeCommand({
    list: listDir,
    recordId: 'acct_present',
    stage_id: STAGE_ID,
    decision: 'authorize',
    asset_version: BOUND_ASSET,
    actor: 'canary',
  });
  assert.equal(ok.allowed, true, JSON.stringify(ok));
  assert.match(String(ok.reason || ''), /authoriz/i);
  assert.equal(ok.asset_version, BOUND_ASSET);
  assert.equal(ok.account_sequence_state, 'active');
});

test('decision and timeline detail surfaces also re-resolve presentation structure', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  seedPendingReview(db);
  db.close();

  const decision = decisionViewCommand({ list: listDir, record: 'acct_present' });
  assert.equal(decision.stage_review.presentation_equivalence.status, 'changed');
  assert.deepEqual(
    (decision.stage_review.presentation?.present || []).map((entry) => entry.field).sort(),
    ['friction_line', 'friction_noun', 'preliminary_snapshot'],
  );
  assert.deepEqual(decision.stage_review.bound_presentation, stalePresentation);
  assert.equal(decision.stage_review.bound_asset_version, BOUND_ASSET);
  assert.equal(decision.stage_review.asset_version, BOUND_ASSET);
  assert.equal(decision.stage_review.presentation_authorizable, false);

  const timeline = timelineCommand({ list: listDir, record: 'acct_present' });
  assert.equal(timeline.current.stage_review.presentation_equivalence.status, 'changed');
  assert.equal(
    timeline.current.stage_review.presentation.present.find((entry) => entry.field === 'friction_line')?.value,
    "You've implemented online booking and payment, but patients with quick questions before booking have no live chat option.",
  );
  assert.deepEqual(timeline.current.stage_review.bound_presentation, stalePresentation);
});
