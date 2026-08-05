/**
 * RES-OPERATOR-SURFACES: stage-review queue, manual queue, call board, health,
 * timeline, metrics, audit export — pure helpers + thin command wrappers.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const {
  listPendingStageReviews,
  pauseForStageReview,
  authorizeStageReview,
  appendTransitionAudit,
  parseStageReviewJson,
} = await import('../dist/orchestrator/policy/transition-audit.js');
const {
  exportAuditLog,
  getAccountTimeline,
  getCommercialMetrics,
  getDecisionView,
} = await import('../dist/orchestrator/operator/timeline.js');
const { runHealthChecks } = await import('../dist/orchestrator/operator/health.js');
const { listAwaitingManualTasks } = await import('../dist/orchestrator/pipeline/manual.js');
const {
  stageReviewListCommand,
  stageReviewAuthorizeCommand,
} = await import('../dist/commands/stage-review.js');
const {
  auditExportCommand,
  healthCheckCommand,
  metricsCommand,
  timelineCommand,
} = await import('../dist/commands/operator-surfaces.js');
const { manualListCommand } = await import('../dist/commands/manual.js');
const {
  openListDb,
  ensureRecordColumns,
  upsertRecord,
} = await import('../dist/orchestrator/runtime/db.js');

const projectYaml = () => `
list:
  name: Operator Surfaces
business:
  name: Mission
  description: Test
  icp: SMB
  offer: Automation
pipeline: []
sequences:
  default:
    steps: []
policy:
  review_required_for:
    - linkedin_connect
    - mail
`;

const createList = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-ops-surfaces-'));
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml());
  writeFileSync(join(listDir, 'operator.md'), 'ops');
  return listDir;
};

const seedRecord = (db, {
  rowId = 'acct_1',
  stage_review_json = null,
  transition_audit_json = null,
  account_sequence_state = 'paused_review',
  work_state = 'pending_human_review',
} = {}) => {
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: [
      'lifecycle_stage',
      'account_sequence_state',
      'work_state',
      'next_action_json',
      'stage_review_json',
      'transition_audit_json',
      'claim_audit_json',
      'treatment_tier',
      'related_review_id',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      lifecycle_stage, account_sequence_state, work_state,
      stage_review_json, transition_audit_json, treatment_tier,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      ?, 'Acme Plumbing', 'default', 'active', 0,
      'contacted', ?, ?,
      ?, ?, 'B',
      ?, ?, ?, ?
    )
  `).run(
    rowId,
    account_sequence_state,
    work_state,
    stage_review_json,
    transition_audit_json,
    now,
    now,
    now,
    now,
  );
};

test('listPendingStageReviews: returns open reviews only by default', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  const pending = pauseForStageReview({
    account_id: 'acct_open',
    stage_id: 'linkedin_1',
    asset_version: 'asset_v1',
    channel: 'linkedin',
    action_type: 'linkedin_connect',
  });
  const authorized = authorizeStageReview({
    review_id: 'rev_done',
    stage_id: 'mail_1',
    asset_version: 'asset_v2',
    expected_asset_version: 'asset_v2',
    decision: 'authorize',
    account_id: 'acct_done',
    existing: {
      review_id: 'rev_done',
      stage_id: 'mail_1',
      asset_version: 'asset_v2',
      status: 'pending',
      account_id: 'acct_done',
    },
  });
  seedRecord(db, {
    rowId: 'acct_open',
    stage_review_json: pending.patch.stage_review_json,
  });
  seedRecord(db, {
    rowId: 'acct_done',
    stage_review_json: authorized.patch.stage_review_json,
    account_sequence_state: 'active',
    work_state: 'executing_external_action',
  });

  const open = listPendingStageReviews({ db });
  assert.equal(open.total, 1);
  assert.equal(open.reviews[0].record_id, 'acct_open');
  assert.equal(open.reviews[0].stage_id, 'linkedin_1');
  assert.equal(open.reviews[0].asset_version, 'asset_v1');
  assert.equal(open.reviews[0].status, 'pending');

  const all = listPendingStageReviews({ db, status: 'all' });
  assert.equal(all.total, 2);

  db.close();
});

test('stageReviewAuthorizeCommand: authorize requires exact asset version; list command sees queue', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  const paused = pauseForStageReview({
    account_id: 'acct_auth',
    stage_id: 'linkedin_1',
    asset_version: 'bind_v3',
    channel: 'linkedin',
    action_type: 'linkedin_connect',
  });
  seedRecord(db, {
    rowId: 'acct_auth',
    stage_review_json: paused.patch.stage_review_json,
    transition_audit_json: JSON.stringify([paused.audit]),
  });
  db.close();

  const listed = stageReviewListCommand({ list: listDir });
  assert.equal(listed.total, 1);
  assert.equal(listed.reviews[0].asset_version, 'bind_v3');

  const mismatch = stageReviewAuthorizeCommand({
    list: listDir,
    recordId: 'acct_auth',
    stage_id: 'linkedin_1',
    decision: 'authorize',
    asset_version: 'wrong_version',
    actor: 'canary',
  });
  assert.equal(mismatch.allowed, false);
  assert.equal(mismatch.reason, 'asset_version_mismatch');

  // Re-seed a pending review (mismatch invalidated the packet).
  const db2 = openListDb({ listDir, readonly: false });
  const again = pauseForStageReview({
    account_id: 'acct_auth',
    stage_id: 'linkedin_1',
    asset_version: 'bind_v3',
    channel: 'linkedin',
    action_type: 'linkedin_connect',
  });
  const row = db2.prepare('SELECT * FROM records WHERE _row_id = ?').get('acct_auth');
  upsertRecord({
    db: db2,
    row: {
      ...row,
      stage_review_json: again.patch.stage_review_json,
      account_sequence_state: again.patch.account_sequence_state,
      work_state: again.patch.work_state,
      next_action_json: again.patch.next_action_json,
    },
  });
  db2.close();

  const ok = stageReviewAuthorizeCommand({
    list: listDir,
    recordId: 'acct_auth',
    stage_id: 'linkedin_1',
    decision: 'authorize',
    asset_version: 'bind_v3',
    actor: 'canary',
  });
  assert.equal(ok.allowed, true);
  assert.equal(ok.account_sequence_state, 'active');

  const after = stageReviewListCommand({ list: listDir, status: 'open' });
  assert.equal(after.total, 0);

  const rejectedList = createList();
  const dbR = openListDb({ listDir: rejectedList, readonly: false });
  const p = pauseForStageReview({
    account_id: 'acct_rej',
    stage_id: 'mail_standard',
    asset_version: 'mail_v1',
    channel: 'mail',
    action_type: 'mail',
  });
  seedRecord(dbR, {
    rowId: 'acct_rej',
    stage_review_json: p.patch.stage_review_json,
  });
  dbR.close();

  const rejected = stageReviewAuthorizeCommand({
    list: rejectedList,
    recordId: 'acct_rej',
    stage_id: 'mail_standard',
    decision: 'reject',
    asset_version: 'mail_v1',
    actor: 'canary',
    notes: 'wrong asset',
  });
  assert.equal(rejected.allowed, true);
  assert.equal(rejected.decision, 'reject');
  const review = parseStageReviewJson(rejected.stage_review_json);
  assert.equal(review?.status, 'rejected');
});

test('exportAuditLog + auditExportCommand: dumps transition_audit and stage_review JSON', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  const paused = pauseForStageReview({
    account_id: 'acct_aud',
    stage_id: 'linkedin_1',
    asset_version: 'av_1',
    channel: 'linkedin',
    action_type: 'linkedin_connect',
  });
  seedRecord(db, {
    rowId: 'acct_aud',
    stage_review_json: paused.patch.stage_review_json,
    transition_audit_json: JSON.stringify([paused.audit]),
  });

  const pure = exportAuditLog({ db, recordId: 'acct_aud' });
  assert.equal(pure.count, 1);
  assert.ok(Array.isArray(pure.records[0].transition_audit));
  assert.equal(pure.records[0].transition_audit.length, 1);
  assert.equal(pure.records[0].stage_review.stage_id, 'linkedin_1');
  db.close();

  const cmd = auditExportCommand({ list: listDir, record: 'acct_aud' });
  assert.equal(cmd.count, 1);
  assert.equal(cmd.records[0].record_id, 'acct_aud');
  assert.ok(cmd.records[0].stage_review.asset_version === 'av_1');
});

test('manual queue lists parked awaiting_manual tasks', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  seedRecord(db, {
    rowId: 'acct_mail',
    account_sequence_state: 'active',
    work_state: 'idle',
  });
  try {
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
      VALUES ('pe1', 'acct_mail', 'mail_standard', 'manual_task', 0, 'awaiting_manual', ?)
    `).run(now);
  } catch (err) {
    // Some schemas require more columns — skip soft if insert shape differs.
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at, side_effecting)
      VALUES ('pe1', 'acct_mail', 'mail_standard', 'manual_task', 0, 'awaiting_manual', ?, 0)
    `).run(now);
  }
  const pure = listAwaitingManualTasks({ db });
  assert.ok(pure.total >= 1);
  assert.ok(pure.tasks.some((t) => t.record_id === 'acct_mail' && t.step_id === 'mail_standard'));
  db.close();

  const cmd = manualListCommand({ list: listDir });
  assert.ok(cmd.total >= 1);
});

test('health / timeline / metrics commands return structured snapshots', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  seedRecord(db, {
    rowId: 'acct_hm',
    account_sequence_state: 'active',
    work_state: 'idle',
  });
  const health = runHealthChecks({ db });
  assert.equal(typeof health.ok, 'boolean');
  assert.ok(health.checked_at);
  assert.ok(health.counts);

  const timeline = getAccountTimeline({ db, recordId: 'acct_hm' });
  assert.equal(timeline.record_id, 'acct_hm');
  assert.ok(Array.isArray(timeline.events));

  const decision = getDecisionView({ db, recordId: 'acct_hm' });
  assert.equal(decision.record_id, 'acct_hm');

  const metrics = getCommercialMetrics({ db });
  assert.ok(metrics.commercial);
  assert.ok(metrics.activity);
  db.close();

  assert.equal(typeof healthCheckCommand({ list: listDir }).ok, 'boolean');
  assert.equal(timelineCommand({ list: listDir, record: 'acct_hm' }).record_id, 'acct_hm');
  assert.ok(metricsCommand({ list: listDir }).commercial);
});

test('serve.ts wires operator ACTIONS for canary HTTP', () => {
  const src = readFileSync(join(ROOT, 'src/serve.ts'), 'utf8');
  for (const action of [
    'stage_review_authorize',
    'stage_review_list',
    'manual_list',
    'manual_complete',
    'call_board',
    'call_board_claim',
    'call_board_dispose',
    'operator_health',
    'timeline',
    'decision',
    'metrics',
    'audit_export',
  ]) {
    assert.ok(src.includes(action), `serve.ts missing ACTIONS entry for ${action}`);
  }
  const cli = readFileSync(join(ROOT, 'src/cli.ts'), 'utf8');
  assert.ok(cli.includes('stage-review'));
  assert.ok(cli.includes('audit export') || cli.includes("command === 'audit'"));
  assert.ok(cli.includes('stageReviewAuthorizeCommand'));
  assert.ok(cli.includes('stageReviewListCommand'));
  assert.ok(cli.includes('auditExportCommand'));
});
