/**
 * Requirement-level negative tests for the independent review's top blockers:
 * empty-sequence completion, review body binding, exclusive idempotency,
 * mail complete-before-allocate ordering, inbound pause-first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { computeNextScheduledAction } from '../dist/orchestrator/lib/working-days.js';
import {
  claimIdempotency,
  completeIdempotency,
  getIdempotencyRecord,
  IDEMPOTENCY_PENDING_LEASE_MS,
} from '../dist/orchestrator/runtime/idempotency.js';
import { applyInboundReplyClassification } from '../dist/orchestrator/policy/inbound-reply.js';
import { completeManualTask } from '../dist/orchestrator/pipeline/manual.js';
import { nowTimestamp } from '../dist/orchestrator/runtime/db.js';
import { deriveFitEvidenceConfidence } from '../dist/orchestrator/policy/apply-record.js';

const workingDays = ['mon', 'tue', 'wed', 'thu', 'fri'];
const policy = 'shift_to_next_working_day';

test('BLOCKER-1 empty sequence steps never invents completion', () => {
  const result = computeNextScheduledAction({
    steps: [],
    completedStepNumber: 1,
    launchedAtDate: '2026-03-02',
    workingDays,
    policy,
  });
  assert.equal(result.completed, false);
  assert.equal(result.sequenceStep, 1);
});

test('BLOCKER-1 multi-step sequence does not complete after first email', () => {
  const steps = [
    { id: 'email_1', day: 0 },
    { id: 'email_2_wait', day: 3 },
    { id: 'email_2', day: 3 },
    { id: 'mail', day: 5 },
  ];
  const afterFirst = computeNextScheduledAction({
    steps,
    completedStepNumber: 1,
    launchedAtDate: '2026-03-02',
    workingDays,
    policy,
  });
  assert.equal(afterFirst.completed, false);
  assert.ok(afterFirst.nextActionDate, 'next action date required after step 1');
});

function openIdemDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE idempotency (
      id TEXT PRIMARY KEY,
      idem_key TEXT NOT NULL,
      scope TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_id TEXT,
      payload_json TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(idem_key, scope)
    );
  `);
  return db;
}

test('BLOCKER-3 concurrent claim: second worker does not claim active lease', () => {
  const db = openIdemDb();
  const t0 = Date.now();
  const a = claimIdempotency({
    db,
    idemKey: 'list:row|email_1|c1',
    scope: 'list',
    payload: { worker: 'a' },
    nowMs: t0,
  });
  assert.equal(a.claimed, true);
  const b = claimIdempotency({
    db,
    idemKey: 'list:row|email_1|c1',
    scope: 'list',
    payload: { worker: 'b' },
    nowMs: t0 + 1000,
  });
  assert.equal(b.claimed, false);
  assert.equal(b.reason, 'lease_held');
  completeIdempotency({
    db,
    idemKey: 'list:row|email_1|c1',
    scope: 'list',
    providerId: 'msg_1',
    claimId: a.claim_id,
  });
  const row = getIdempotencyRecord({ db, idemKey: 'list:row|email_1|c1', scope: 'list' });
  assert.equal(row.status, 'sent');
  assert.equal(row.provider_id, 'msg_1');
});

test('BLOCKER-3 expired send lease becomes uncertain and cannot be reclaimed', () => {
  const db = openIdemDb();
  const t0 = Date.now();
  const a = claimIdempotency({
    db,
    idemKey: 'k2',
    scope: 'list',
    nowMs: t0,
    leaseMs: 1000,
  });
  assert.equal(a.claimed, true);
  const b = claimIdempotency({
    db,
    idemKey: 'k2',
    scope: 'list',
    nowMs: t0 + IDEMPOTENCY_PENDING_LEASE_MS + 5000,
  });
  assert.equal(b.claimed, false, 'expired send lease must not be reclaimed');
  assert.equal(b.status, 'uncertain');
  const c = claimIdempotency({ db, idemKey: 'k2', scope: 'list', nowMs: t0 + 999999 });
  assert.equal(c.claimed, false);
  assert.equal(c.status, 'uncertain');
});

test('BLOCKER-5 inbound pause-first: booking_intent does not auto meeting_booked', () => {
  const result = applyInboundReplyClassification({
    record: {
      _row_id: 'r1',
      lifecycle_stage: 'contacted',
      account_sequence_state: 'active',
      work_state: 'executing_external_action',
    },
    classification: 'booking_intent',
    replyAt: '2026-03-02T15:00:00.000Z',
  });
  assert.equal(result.account_sequence_state, 'paused_inbound');
  assert.notEqual(result.lifecycle_stage, 'meeting_booked');
  assert.equal(result.patch.inbound_pending_human_review, 1);
  assert.equal(result.patch.inbound_proposed_classification, 'booking_intent');
  assert.ok(!result.patch.meeting_booked_at, 'meeting_booked_at must not auto-set');
});

test('BLOCKER-5 inbound pause-first: hard_no does not auto lost', () => {
  const result = applyInboundReplyClassification({
    record: {
      _row_id: 'r2',
      lifecycle_stage: 'contacted',
      account_sequence_state: 'active',
    },
    classification: 'hard_no',
    replyAt: '2026-03-02T15:00:00.000Z',
  });
  assert.equal(result.account_sequence_state, 'paused_inbound');
  assert.notEqual(result.lifecycle_stage, 'lost');
  assert.equal(result.patch.suppressed, 0);
});

test('BLOCKER-5 explicit unsubscribe still terminates (legal stop)', () => {
  const result = applyInboundReplyClassification({
    record: {
      _row_id: 'r3',
      lifecycle_stage: 'contacted',
      account_sequence_state: 'active',
    },
    classification: 'unsubscribe',
    explicitStop: true,
    replyAt: '2026-03-02T15:00:00.000Z',
  });
  assert.equal(result.lifecycle_stage, 'lost');
  assert.equal(result.patch.suppressed, 1);
});

test('BLOCKER-7 fit evidence confidence is 0 without evidence_ids', () => {
  const conf = deriveFitEvidenceConfidence([
    { id: 'admin_intensity', grade: 9, reasoning: 'lots of admin busywork observed on site' },
    { id: 'ticket_size', grade: 8, reasoning: 'high ticket jobs likely' },
    { id: 'recurring_work', grade: 7, reasoning: 'service contracts' },
    { id: 'multi_location', grade: 5, reasoning: 'single shop' },
    { id: 'decision_speed', grade: 6, reasoning: 'owner operated' },
  ]);
  assert.equal(conf, 0);
});

function openMailDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE records (
      _row_id TEXT PRIMARY KEY,
      id TEXT,
      account_sequence_state TEXT,
      account_contact_plan_json TEXT,
      mail_treatment TEXT,
      mail_allocated INTEGER,
      business_name TEXT,
      contact_name TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT
    );
    CREATE TABLE pipeline_events (
      event_id TEXT PRIMARY KEY,
      record_id TEXT,
      step_id TEXT,
      kind TEXT,
      passed INTEGER,
      reason TEXT,
      occurred_at TEXT
    );
  `);
  return db;
}

test('BLOCKER-4 mail complete fails closed when mail_treatment is none (no completion event)', async () => {
  const db = openMailDb();
  const rid = 'mail_none_1';
  const sid = 'mail_golden_or_standard';
  const plan = {
    account_id: rid,
    active_contact_id: 'c1',
    held_contact_ids: [],
    mail_treatment: 'none',
    mail_allocated: false,
    contacts: [],
  };
  db.prepare(`
    INSERT INTO records (_row_id, id, account_sequence_state, account_contact_plan_json, mail_treatment, business_name)
    VALUES (?, ?, 'active', ?, 'none', 'Acme HVAC')
  `).run(rid, rid, JSON.stringify(plan));
  const parkAt = '2026-03-01T10:00:00.000Z';
  db.prepare(`
    INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
    VALUES ('park1', ?, ?, 'manual_task', 0, 'awaiting_manual', ?)
  `).run(rid, sid, parkAt);

  await assert.rejects(
    () => completeManualTask({
      db,
      config: { channels: { mail: { template_id: 'postcard_v1' } } },
      recordId: rid,
      stepId: sid,
      note: 'try mail',
      mailProvider: null,
    }),
    /mail_treatment is none|no mail permission/i,
  );

  const done = db.prepare(`
    SELECT * FROM pipeline_events WHERE record_id = ? AND step_id = ? AND passed = 1
  `).all(rid, sid);
  assert.equal(done.length, 0, 'must not write completion when allocate fails');
});

test('BLOCKER-4 mail provider submit failure leaves task parked', async () => {
  const db = openMailDb();
  const rid = 'mail_fail_1';
  const sid = 'mail_standard';
  const plan = {
    account_id: rid,
    active_contact_id: 'c1',
    held_contact_ids: [],
    mail_treatment: 'standard_postcard',
    mail_allocated: false,
    contacts: [{ contact_id: 'c1', name: 'Pat', email: '', phone: '' }],
  };
  db.prepare(`
    INSERT INTO records (_row_id, id, account_sequence_state, account_contact_plan_json, mail_treatment, business_name, address, city, state, zip)
    VALUES (?, ?, 'active', ?, 'standard_postcard', 'Acme', '1 Main', 'Boise', 'ID', '83702')
  `).run(rid, rid, JSON.stringify(plan));
  db.prepare(`
    INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
    VALUES ('park2', ?, ?, 'manual_task', 0, 'awaiting_manual', '2026-03-01T10:00:00.000Z')
  `).run(rid, sid);

  await assert.rejects(
    () => completeManualTask({
      db,
      config: { channels: { mail: { template_id: 'postcard_v1' } } },
      recordId: rid,
      stepId: sid,
      mailProvider: {
        name: 'test',
        submit: async () => ({ ok: false, reason: 'lob_down', provider: 'test' }),
      },
    }),
    /submit failed|lob_down/i,
  );

  const done = db.prepare(`
    SELECT * FROM pipeline_events WHERE record_id = ? AND step_id = ? AND passed = 1
  `).all(rid, sid);
  assert.equal(done.length, 0);
});
