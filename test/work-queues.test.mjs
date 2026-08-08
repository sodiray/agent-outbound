/**
 * Operator work queues + expanded health detectors.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const {
  listRepairQueue,
  listEnrichmentHoldQueue,
  listObjectionQueue,
  listCallbackQueue,
  listMeetingQueue,
  listRecycleQueue,
  listReentryQueue,
  listStageReviewQueue,
  listManualQueue,
  listWorkQueue,
  listAllWorkQueueCounts,
  WORK_QUEUE_NAMES,
} = await import('../dist/orchestrator/operator/work-queues.js');
const { runHealthChecks } = await import('../dist/orchestrator/operator/health.js');
const {
  workQueuesCommand,
  queueRepairCommand,
} = await import('../dist/commands/operator-surfaces.js');
const {
  openListDb,
  ensureRecordColumns,
} = await import('../dist/orchestrator/runtime/db.js');
const {
  pauseForStageReview,
} = await import('../dist/orchestrator/policy/transition-audit.js');

const projectYaml = () => `
list:
  name: Work Queues
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
  const listDir = mkdtempSync(join(tmpdir(), 'ao-work-queues-'));
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml());
  writeFileSync(join(listDir, 'operator.md'), 'ops');
  return listDir;
};

const COLUMNS = [
  'lifecycle_stage',
  'account_sequence_state',
  'work_state',
  'next_action_json',
  'treatment_tier',
  'eligibility_outcome',
  'disposition_latest',
  'disposition_follow_up_at',
  'reply_classification_latest',
  'email_reply_classification',
  'meeting_booked_at',
  'material_contradiction',
  'integrity_errors',
  'priority_lane',
  'stage_review_json',
  'disqualified_at',
  'callback_at',
];

const seed = (db, rowId, fields = {}) => {
  const now = new Date().toISOString();
  ensureRecordColumns({ db, columns: COLUMNS });
  const cols = [
    '_row_id', 'business_name', 'sequence_name', 'sequence_status', 'sequence_step',
    'lifecycle_stage', 'account_sequence_state', 'work_state',
    'treatment_tier', 'eligibility_outcome', 'disposition_latest',
    'disposition_follow_up_at', 'reply_classification_latest',
    'meeting_booked_at', 'material_contradiction', 'integrity_errors',
    'priority_lane', 'next_action_json', 'stage_review_json', 'disqualified_at',
    '_created_at', '_updated_at', 'created_at', 'updated_at',
  ];
  const values = {
    _row_id: rowId,
    business_name: fields.business_name || `Biz ${rowId}`,
    sequence_name: 'default',
    sequence_status: fields.sequence_status || 'active',
    sequence_step: 0,
    lifecycle_stage: fields.lifecycle_stage || 'contacted',
    account_sequence_state: fields.account_sequence_state || 'active',
    work_state: fields.work_state || 'idle',
    treatment_tier: fields.treatment_tier || 'B',
    eligibility_outcome: fields.eligibility_outcome || 'eligible',
    disposition_latest: fields.disposition_latest || '',
    disposition_follow_up_at: fields.disposition_follow_up_at || '',
    reply_classification_latest: fields.reply_classification_latest || '',
    meeting_booked_at: fields.meeting_booked_at || '',
    material_contradiction: fields.material_contradiction ?? 0,
    integrity_errors: fields.integrity_errors || '',
    priority_lane: fields.priority_lane || '',
    next_action_json: fields.next_action_json || '',
    stage_review_json: fields.stage_review_json || '',
    disqualified_at: fields.disqualified_at || '',
    _created_at: now,
    _updated_at: now,
    created_at: now,
    updated_at: now,
  };
  // Upsert-ish: delete then insert for test isolation
  try {
    db.prepare(`DELETE FROM records WHERE _row_id = ?`).run(rowId);
  } catch { /* empty */ }
  const placeholders = cols.map(() => '?').join(', ');
  db.prepare(`
    INSERT INTO records (${cols.join(', ')})
    VALUES (${placeholders})
  `).run(...cols.map((c) => values[c]));
};

test('listRepairQueue: paused_repair / material_contradiction / integrity_errors', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  seed(db, 'rep_1', {
    account_sequence_state: 'paused_repair',
    work_state: 'channel_repair',
  });
  seed(db, 'rep_2', {
    material_contradiction: 1,
    account_sequence_state: 'active',
  });
  seed(db, 'rep_3', {
    integrity_errors: JSON.stringify(['missing_next_action']),
  });
  seed(db, 'rep_ok', {
    account_sequence_state: 'active',
    work_state: 'idle',
  });

  const q = listRepairQueue({ db });
  assert.equal(q.queue, 'repair');
  assert.ok(q.total >= 3);
  const ids = q.items.map((i) => i.record_id);
  assert.ok(ids.includes('rep_1'));
  assert.ok(ids.includes('rep_2'));
  assert.ok(ids.includes('rep_3'));
  assert.ok(!ids.includes('rep_ok'));
  assert.ok(q.items.find((i) => i.record_id === 'rep_1')?.reason.includes('paused_repair'));
  db.close();
});

test('listEnrichmentHoldQueue: treatment_tier + eligibility', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  seed(db, 'eh_1', { treatment_tier: 'enrichment_hold' });
  seed(db, 'eh_2', { eligibility_outcome: 'enrichment_hold', treatment_tier: 'C' });
  seed(db, 'eh_ok', { treatment_tier: 'A', eligibility_outcome: 'eligible' });

  const q = listEnrichmentHoldQueue({ db });
  assert.equal(q.queue, 'enrichment_hold');
  const ids = q.items.map((i) => i.record_id);
  assert.ok(ids.includes('eh_1'));
  assert.ok(ids.includes('eh_2'));
  assert.ok(!ids.includes('eh_ok'));
  db.close();
});

test('listObjectionQueue / listCallbackQueue / listMeetingQueue', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  seed(db, 'obj_1', {
    disposition_latest: 'objection',
    reply_classification_latest: 'objection',
  });
  seed(db, 'cb_1', {
    disposition_latest: 'callback_requested',
    disposition_follow_up_at: '2020-01-01T00:00:00.000Z',
  });
  seed(db, 'mt_1', {
    lifecycle_stage: 'meeting_booked',
    disposition_latest: 'meeting_booked',
    meeting_booked_at: '2026-01-15T12:00:00.000Z',
  });

  const objections = listObjectionQueue({ db });
  assert.ok(objections.items.some((i) => i.record_id === 'obj_1'));
  // callback_requested also surfaces on objection queue (inbound path)
  assert.ok(objections.items.some((i) => i.record_id === 'cb_1'));

  const callbacks = listCallbackQueue({ db, now: '2026-08-01T00:00:00.000Z' });
  assert.ok(callbacks.items.some((i) => i.record_id === 'cb_1'));
  const due = callbacks.items.find((i) => i.record_id === 'cb_1');
  assert.equal(due.is_due, true);

  const meetings = listMeetingQueue({ db });
  assert.ok(meetings.items.some((i) => i.record_id === 'mt_1'));
  db.close();
});

test('listRecycleQueue / listReentryQueue', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  seed(db, 'rc_1', {
    account_sequence_state: 'recycle_wait',
    lifecycle_stage: 'recycled',
    priority_lane: 'recycle_monitoring',
  });
  seed(db, 're_1', {
    work_state: 'reentry_evaluation',
    next_action_json: JSON.stringify({
      action_type: 'reentry_evaluation',
      reason: 'campaign_exhausted',
    }),
  });

  const recycle = listRecycleQueue({ db });
  assert.ok(recycle.items.some((i) => i.record_id === 'rc_1'));

  const reentry = listReentryQueue({ db });
  assert.ok(reentry.items.some((i) => i.record_id === 're_1'));
  db.close();
});

test('listStageReviewQueue wraps pending stage reviews', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  const pending = pauseForStageReview({
    account_id: 'sr_1',
    stage_id: 'linkedin_1',
    asset_version: 'av_1',
    channel: 'linkedin',
    action_type: 'linkedin_connect',
  });
  seed(db, 'sr_1', {
    account_sequence_state: 'paused_review',
    work_state: 'pending_human_review',
    stage_review_json: pending.patch.stage_review_json,
  });

  const q = listStageReviewQueue({ db });
  assert.equal(q.queue, 'stage_review');
  assert.ok(q.total >= 1);
  assert.ok(q.items.some((i) => i.record_id === 'sr_1' && i.stage_id === 'linkedin_1'));
  db.close();
});

test('listManualQueue wraps awaiting_manual pipeline events', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  seed(db, 'man_1', { account_sequence_state: 'active' });
  try {
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
      VALUES ('pe_man_1', 'man_1', 'mail_standard', 'manual_task', 0, 'awaiting_manual', ?)
    `).run(now);
  } catch {
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at, side_effecting)
      VALUES ('pe_man_1', 'man_1', 'mail_standard', 'manual_task', 0, 'awaiting_manual', ?, 0)
    `).run(now);
  }

  const q = listManualQueue({ db });
  assert.equal(q.queue, 'manual');
  assert.ok(q.items.some((i) => i.record_id === 'man_1'));
  db.close();
});

test('listWorkQueue dispatches by name; listAllWorkQueueCounts covers all', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  seed(db, 'wq_1', { treatment_tier: 'enrichment_hold' });

  const one = listWorkQueue({ db, queue: 'enrichment_hold' });
  assert.equal(one.queue, 'enrichment_hold');
  assert.ok(one.total >= 1);

  assert.throws(() => listWorkQueue({ db, queue: 'not_a_queue' }), /Unknown work queue/);

  const all = listAllWorkQueueCounts({ db });
  for (const name of WORK_QUEUE_NAMES) {
    assert.ok(typeof all.queues[name] === 'number', `missing count for ${name}`);
  }
  db.close();
});

test('workQueuesCommand + queueRepairCommand open list DBs', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  seed(db, 'cmd_1', { account_sequence_state: 'paused_repair' });
  db.close();

  const counts = workQueuesCommand({ list: listDir, queue: 'all' });
  assert.ok(counts.queues);
  assert.ok(typeof counts.queues.repair === 'number');

  const repair = queueRepairCommand({ list: listDir });
  assert.equal(repair.queue, 'repair');
  assert.ok(repair.items.some((i) => i.record_id === 'cmd_1'));
});

test('health: false_pipeline_health, tier_d outbound, in_play+disqualified', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });

  // false pipeline health: active + no next_action
  seed(db, 'h_false', {
    sequence_status: 'active',
    account_sequence_state: 'active',
    next_action_json: '',
  });

  // in-play + disqualified contradiction
  seed(db, 'h_dq', {
    sequence_status: 'active',
    account_sequence_state: 'active',
    disqualified_at: '2026-01-01T00:00:00.000Z',
    lifecycle_stage: 'disqualified',
  });

  const report = runHealthChecks({ db, limit: 100 });
  assert.ok(report.counts.false_pipeline_health >= 1);
  assert.ok(report.counts.in_play_disqualified_contradiction >= 1);

  const codes = new Set(report.issues.map((i) => i.code));
  assert.ok(codes.has('false_pipeline_health'));
  assert.ok(codes.has('in_play_disqualified_contradiction'));
  db.close();
});

test('health: sourced_review pileup detector counts awaiting review', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  // Under threshold: still emits sourced_review_pending sample issues
  seed(db, 'src_1', { sequence_status: 'active' });
  try {
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
      VALUES ('pe_src_1', 'src_1', 'sourced_review', 'review', 0, 'awaiting_review', ?)
    `).run(now);
  } catch {
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at, side_effecting)
      VALUES ('pe_src_1', 'src_1', 'sourced_review', 'review', 0, 'awaiting_review', ?, 0)
    `).run(now);
  }

  const report = runHealthChecks({ db, limit: 50 });
  assert.ok(report.counts.sourced_review_pileup >= 1);
  const codes = report.issues.map((i) => i.code);
  assert.ok(
    codes.includes('sourced_review_pending') || codes.includes('sourced_review_pileup'),
    `expected sourced_review issue, got ${codes.join(',')}`,
  );
  db.close();
});

test('serve.ts + cli.ts wire work queue surfaces', () => {
  const serve = readFileSync(join(ROOT, 'src/serve.ts'), 'utf8');
  for (const action of [
    'work_queues',
    'operator_queues',
    'queue_repair',
    'queue_enrichment_hold',
    'queue_objection',
    'queue_callback',
    'queue_meeting',
    'queue_recycle',
    'queue_reentry',
    'queue_stage_review',
    'queue_manual',
    'queue_reply',
  ]) {
    assert.ok(serve.includes(action), `serve.ts missing ${action}`);
  }
  const cli = readFileSync(join(ROOT, 'src/cli.ts'), 'utf8');
  assert.ok(cli.includes('work-queues') || cli.includes('work_queues'));
  assert.ok(cli.includes('workQueuesCommand'));
});
