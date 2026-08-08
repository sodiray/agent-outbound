/**
 * Phone attempt policy: windows, ceilings, callbacks, wrong-number, capacity_unserved.
 * Wired through call-board list eligibility + dispose transitions.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openListDb, ensureRecordColumns } from '../dist/orchestrator/runtime/db.js';
import {
  DEFAULT_ATTEMPT_WINDOW_END_HOUR,
  DEFAULT_ATTEMPT_WINDOW_START_HOUR,
  DEFAULT_MAX_PHONE_ATTEMPTS,
  TIER_MAX_PHONE_ATTEMPTS,
  applyCapacityUnserved,
  applyPhoneDisposition,
  evaluatePhoneAttemptEligibility,
  getZonedHour,
  hasFutureCallback,
  isCallbackDue,
  isPhoneAttemptCeilingReached,
  isPhonePathSuppressed,
  isWithinPhoneAttemptWindow,
  maxPhoneAttemptsForTier,
  resolvePhoneAttemptPolicyConfig,
  scheduleCallbackAt,
} from '../dist/orchestrator/policy/phone-attempt.js';
import {
  isActionDueInTimezone,
  resolveWorkingDayConfig,
  toZonedIsoDate,
} from '../dist/orchestrator/lib/working-days.js';
import { normalizeConfig } from '../dist/schemas/config.js';
import {
  claimCallBoardEntry,
  disposeCallBoardEntry,
  getCallBoard,
  isCallBoardEligible,
} from '../dist/orchestrator/operator/call-board.js';

/** Wednesday 2026-08-05 16:00 UTC = 10:00 America/Boise (MDT). */
const BOISE_BUSINESS_MS = Date.parse('2026-08-05T16:00:00.000Z');
/** Wednesday 2026-08-05 02:00 UTC = 20:00 prior evening Boise — outside window. */
const BOISE_EVENING_MS = Date.parse('2026-08-05T02:00:00.000Z');
/** Saturday 2026-08-08 16:00 UTC — weekend. */
const BOISE_WEEKEND_MS = Date.parse('2026-08-08T16:00:00.000Z');
const BOISE_PHONE_POLICY = {
  timeZone: 'America/Boise',
  startHour: 9,
  endHour: 17,
  weekdaysOnly: true,
  maxAttemptsByTier: { A: 4, B: 3, C: 0, D: 0 },
  defaultMaxAttempts: 3,
  callbackDelayHours: 24,
};

const phoneNextAction = JSON.stringify({
  action_id: 'na_call',
  action_type: 'call_human',
  account_id: 'x',
  channel: 'phone',
  lifecycle_stage: 'contacted',
  sequence_state: 'active',
  work_state: 'human_commercial_followup',
  reason: 'phone',
  on_success: 'continue',
});

const baseRecord = (overrides = {}) => ({
  _row_id: 'p1',
  treatment_tier: 'B',
  phone: '+12085550100',
  contact_phone: '+12085550100',
  suppressed: 0,
  lifecycle_stage: 'contacted',
  account_sequence_state: 'active',
  call_claim_status: 'open',
  call_attempt_count: 0,
  next_action_json: phoneNextAction,
  ...overrides,
});

function openTempDb() {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-phone-policy-'));
  writeFileSync(
    join(listDir, 'outbound.yaml'),
    `list: { name: phone-policy }\npipeline: []\nscore: { criteria: [] }\nsequences: { default: { steps: [] } }\n`,
  );
  writeFileSync(join(listDir, 'operator.md'), 'phone');
  writeFileSync(join(listDir, 'mcp.json'), '{}');
  return openListDb({ listDir, readonly: false });
}

function insertPhoneRecord(db, row) {
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: [
      'phone', 'contact_phone', 'treatment_tier', 'fit_score', 'suppressed',
      'lifecycle_stage', 'account_sequence_state', 'next_action_json',
      'call_claim_status', 'call_claimed_by', 'call_claimed_at', 'call_claim_expires_at',
      'call_attempt_count', 'call_disposition', 'call_window_status', 'call_callback_at',
      'dne_phone', 'phone_suppressed', 'dnc_phone', 'contact_name', 'business_name',
    ],
  });
  const r = baseRecord(row);
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, phone, contact_phone,
      treatment_tier, fit_score, suppressed, lifecycle_stage, account_sequence_state,
      next_action_json, call_claim_status, call_attempt_count, contact_name,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, ?, 'default', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    r._row_id,
    r.business_name || 'Phone Co',
    r.phone,
    r.contact_phone,
    r.treatment_tier,
    r.fit_score ?? 80,
    r.suppressed ?? 0,
    r.lifecycle_stage,
    r.account_sequence_state,
    r.next_action_json,
    r.call_claim_status || 'open',
    r.call_attempt_count ?? 0,
    r.contact_name || 'Pat',
    now, now, now, now,
  );
  // Optional policy columns via UPDATE so older schemas still insert.
  const extras = [];
  const vals = [];
  for (const col of [
    'call_callback_at', 'dne_phone', 'phone_suppressed', 'dnc_phone', 'call_window_status',
  ]) {
    if (r[col] != null && r[col] !== '') {
      extras.push(`${col} = ?`);
      vals.push(r[col]);
    }
  }
  if (extras.length) {
    vals.push(r._row_id);
    db.prepare(`UPDATE records SET ${extras.join(', ')} WHERE _row_id = ?`).run(...vals);
  }
  return r._row_id;
}

// ── Pure policy unit tests ──────────────────────────────────────────────────

test('phone-attempt: no default window or tier ceiling; declared policy controls them', () => {
  assert.equal(DEFAULT_ATTEMPT_WINDOW_START_HOUR, 0);
  assert.equal(DEFAULT_ATTEMPT_WINDOW_END_HOUR, 24);
  assert.equal(DEFAULT_MAX_PHONE_ATTEMPTS, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(TIER_MAX_PHONE_ATTEMPTS, {});
  assert.equal(maxPhoneAttemptsForTier('A', undefined, BOISE_PHONE_POLICY), 4);
  assert.equal(maxPhoneAttemptsForTier('B', undefined, BOISE_PHONE_POLICY), 3);
  assert.equal(maxPhoneAttemptsForTier('C', undefined, BOISE_PHONE_POLICY), 0);
  assert.equal(maxPhoneAttemptsForTier('Z', undefined, BOISE_PHONE_POLICY), 3);
  assert.equal(maxPhoneAttemptsForTier('A', 2, BOISE_PHONE_POLICY), 2);
});

test('phone-attempt: attempt window Boise business hours + weekdays', () => {
  assert.equal(isWithinPhoneAttemptWindow(BOISE_BUSINESS_MS, BOISE_PHONE_POLICY), true);
  assert.equal(getZonedHour(BOISE_BUSINESS_MS, 'America/Boise'), 10);
  assert.equal(isWithinPhoneAttemptWindow(BOISE_EVENING_MS, BOISE_PHONE_POLICY), false);
  assert.equal(isWithinPhoneAttemptWindow(BOISE_WEEKEND_MS, BOISE_PHONE_POLICY), false);
  // Configurable hours
  assert.equal(
    isWithinPhoneAttemptWindow(BOISE_BUSINESS_MS, { ...BOISE_PHONE_POLICY, startHour: 11, endHour: 17 }),
    false,
  );
  assert.equal(
    isWithinPhoneAttemptWindow(BOISE_WEEKEND_MS, { ...BOISE_PHONE_POLICY, weekdaysOnly: false }),
    true,
  );
});

test('phone-attempt: configured timezone controls wall-clock day and hours', () => {
  const instant = '2026-08-05T14:00:00.000Z'; // 08:00 Boise, 10:00 New York.
  assert.equal(isWithinPhoneAttemptWindow(instant, BOISE_PHONE_POLICY), false);
  assert.equal(isWithinPhoneAttemptWindow(instant, { ...BOISE_PHONE_POLICY, timeZone: 'America/New_York' }), true);
  assert.equal(toZonedIsoDate('2026-08-05T05:00:00.000Z', 'America/Boise'), '2026-08-04');
  assert.equal(toZonedIsoDate('2026-08-05T05:00:00.000Z', 'America/New_York'), '2026-08-05');
});

test('phone-attempt: pipeline timezone accepts IANA zones and phone overrides operations', () => {
  const valid = normalizeConfig({
    operations: { timezone: 'America/New_York' },
    channels: { phone: { timezone: 'America/New_York' } },
  });
  assert.deepEqual(valid.errors, []);
  assert.equal(resolvePhoneAttemptPolicyConfig(valid.config).timeZone, 'America/New_York');
  const timing = resolveWorkingDayConfig(valid.config.sequences.default);
  assert.equal(timing.timeZone, 'America/New_York');
  assert.equal(isActionDueInTimezone({
    nextActionDate: '2026-08-05',
    now: '2026-08-05T05:00:00.000Z',
    timeZone: timing.timeZone,
  }), true);
  assert.equal(normalizeConfig({ operations: { timezone: 'Not/AZone' } }).errors.length, 1);
  assert.equal(normalizeConfig({ channels: { phone: { timezone: 'Not/AZone' } } }).errors.length, 1);
});

test('phone-attempt: ceiling reached', () => {
  assert.equal(isPhoneAttemptCeilingReached(baseRecord({ call_attempt_count: 0 }), BOISE_PHONE_POLICY), false);
  assert.equal(isPhoneAttemptCeilingReached(baseRecord({ call_attempt_count: 3 }), BOISE_PHONE_POLICY), true);
  assert.equal(
    isPhoneAttemptCeilingReached(baseRecord({ treatment_tier: 'A', call_attempt_count: 3 }), BOISE_PHONE_POLICY),
    false,
  );
  assert.equal(
    isPhoneAttemptCeilingReached(baseRecord({ treatment_tier: 'A', call_attempt_count: 4 }), BOISE_PHONE_POLICY),
    true,
  );
  assert.equal(
    isPhoneAttemptCeilingReached(baseRecord({ treatment_tier: 'C', call_attempt_count: 0 }), BOISE_PHONE_POLICY),
    true,
  );
});

test('phone-attempt: callback schedule + due checks', () => {
  const from = '2026-08-05T16:00:00.000Z';
  const cb = scheduleCallbackAt(from, { callbackDelayHours: 24 });
  assert.equal(cb, '2026-08-06T16:00:00.000Z');

  const future = baseRecord({ call_callback_at: '2026-08-06T16:00:00.000Z' });
  assert.equal(hasFutureCallback(future, BOISE_BUSINESS_MS), true);
  assert.equal(isCallbackDue(future, BOISE_BUSINESS_MS), false);
  assert.equal(isCallbackDue(future, Date.parse('2026-08-06T17:00:00.000Z')), true);

  const due = baseRecord({ call_callback_at: '2026-08-05T12:00:00.000Z' });
  assert.equal(isCallbackDue(due, BOISE_BUSINESS_MS), true);
  assert.equal(hasFutureCallback(due, BOISE_BUSINESS_MS), false);
});

test('phone-attempt: wrong_number sets dne_phone not account DNC', () => {
  const applied = applyPhoneDisposition({
    record: baseRecord({ suppressed: 0, dnc_phone: 0 }),
    disposition: 'wrong_number',
    at: '2026-08-05T16:05:00.000Z',
  });
  assert.equal(applied.phone_invalidated, true);
  assert.equal(applied.patch.dne_phone, 1);
  assert.equal(applied.patch.phone_suppressed, 1);
  assert.equal(applied.patch.phone_status, 'invalid');
  // Must NOT flip full-account suppression or opt-out dnc_phone.
  assert.ok(applied.patch.suppressed === 0 || applied.patch.suppressed == null);
  assert.ok(!applied.patch.dnc_phone || applied.patch.dnc_phone === 0);
  assert.equal(applied.call_claim_status, 'completed');
  assert.equal(applied.call_window_status, 'blocked');
  assert.equal(applied.next_action?.action_type, 'channel_repair');
  assert.equal(applied.next_action?.phone_outcome, 'wrong_number');
  assert.equal(isPhonePathSuppressed(applied.patch), true);
});

test('phone-attempt: callback disposition schedules callback_at and re-opens', () => {
  const applied = applyPhoneDisposition({
    record: baseRecord(),
    disposition: 'callback',
    at: '2026-08-05T16:05:00.000Z',
    callbackAt: '2026-08-06T15:00:00.000Z',
  });
  assert.equal(applied.call_claim_status, 'open');
  assert.equal(applied.call_window_status, 'callback_scheduled');
  assert.equal(applied.patch.call_callback_at, '2026-08-06T15:00:00.000Z');
  assert.equal(applied.call_attempt_count, 1);
  assert.equal(applied.next_action?.action_type, 'call_human');
  assert.equal(applied.next_action?.phone_outcome, 'callback_scheduled');
  assert.equal(applied.next_action?.due_at, '2026-08-06T15:00:00.000Z');
});

test('phone-attempt: no_answer under ceiling re-opens; at ceiling → capacity_unserved', () => {
  const under = applyPhoneDisposition({
    record: baseRecord({ call_attempt_count: 1, treatment_tier: 'B' }),
    disposition: 'no_answer',
    config: BOISE_PHONE_POLICY,
  });
  assert.equal(under.call_claim_status, 'open');
  assert.equal(under.capacity_unserved, false);
  assert.equal(under.call_attempt_count, 2);
  assert.equal(under.next_action?.phone_outcome, 'no_answer');

  const atCeiling = applyPhoneDisposition({
    record: baseRecord({ call_attempt_count: 2, treatment_tier: 'B' }),
    disposition: 'no_answer',
    config: BOISE_PHONE_POLICY,
  });
  assert.equal(atCeiling.call_attempt_count, 3);
  assert.equal(atCeiling.capacity_unserved, true);
  assert.equal(atCeiling.call_claim_status, 'completed');
  assert.equal(atCeiling.call_window_status, 'exhausted');
  assert.equal(atCeiling.next_action?.action_type, 'capacity_unserved');
  assert.equal(atCeiling.patch.call_capacity_unserved, 1);
  // Exhaustion is not disqualification.
  assert.equal(atCeiling.patch.lifecycle_stage, 'contacted');
  assert.notEqual(atCeiling.patch.suppressed, 1);
});

test('phone-attempt: capacity_unserved without dial does not bump attempts', () => {
  const applied = applyCapacityUnserved({
    record: baseRecord({ call_attempt_count: 1 }),
    reason: 'window_expired_unclaimed',
  });
  assert.equal(applied.call_attempt_count, 1);
  assert.equal(applied.capacity_unserved, true);
  assert.equal(applied.next_action?.action_type, 'capacity_unserved');
  assert.equal(applied.call_window_status, 'capacity_unserved');
});

test('phone-attempt: evaluatePhoneAttemptEligibility gates', () => {
  const ok = evaluatePhoneAttemptEligibility(baseRecord(), { nowMs: BOISE_BUSINESS_MS, config: BOISE_PHONE_POLICY });
  assert.equal(ok.eligible, true);

  const outside = evaluatePhoneAttemptEligibility(baseRecord(), { nowMs: BOISE_EVENING_MS, config: BOISE_PHONE_POLICY });
  assert.equal(outside.eligible, false);
  assert.ok(outside.blockers.some((b) => b.includes('outside_attempt_window')));

  const ceiling = evaluatePhoneAttemptEligibility(
    baseRecord({ call_attempt_count: 3 }),
    { nowMs: BOISE_BUSINESS_MS, config: BOISE_PHONE_POLICY },
  );
  assert.equal(ceiling.eligible, false);
  assert.ok(ceiling.blockers.some((b) => b.startsWith('attempt_ceiling')));

  const futureCb = evaluatePhoneAttemptEligibility(
    baseRecord({ call_callback_at: '2026-08-10T16:00:00.000Z' }),
    { nowMs: BOISE_BUSINESS_MS, config: BOISE_PHONE_POLICY },
  );
  assert.equal(futureCb.eligible, false);
  assert.ok(futureCb.blockers.some((b) => b.startsWith('callback_not_due')));

  const dueCb = evaluatePhoneAttemptEligibility(
    baseRecord({ call_callback_at: '2026-08-05T12:00:00.000Z' }),
    { nowMs: BOISE_BUSINESS_MS, config: BOISE_PHONE_POLICY },
  );
  assert.equal(dueCb.eligible, true);
  assert.ok(dueCb.reasons.includes('callback_due'));

  const wrong = evaluatePhoneAttemptEligibility(
    baseRecord({ dne_phone: 1 }),
    { nowMs: BOISE_BUSINESS_MS, config: BOISE_PHONE_POLICY },
  );
  assert.equal(wrong.eligible, false);
  assert.ok(wrong.blockers.includes('phone_path_suppressed'));
});

// ── Call-board wiring ───────────────────────────────────────────────────────

test('call-board: eligibility respects attempt window, ceiling, callback, dne_phone', () => {
  const row = baseRecord();
  assert.equal(
    isCallBoardEligible(row, {
      hasOpenPhonePark: false,
      nowMs: BOISE_BUSINESS_MS,
      phonePolicy: BOISE_PHONE_POLICY,
    }),
    true,
  );
  assert.equal(
    isCallBoardEligible(row, {
      hasOpenPhonePark: false,
      nowMs: BOISE_EVENING_MS,
      phonePolicy: BOISE_PHONE_POLICY,
    }),
    false,
  );
  assert.equal(
    isCallBoardEligible(baseRecord({ call_attempt_count: 3 }), {
      hasOpenPhonePark: false,
      nowMs: BOISE_BUSINESS_MS,
      phonePolicy: BOISE_PHONE_POLICY,
    }),
    false,
  );
  assert.equal(
    isCallBoardEligible(baseRecord({ call_callback_at: '2026-08-20T00:00:00.000Z' }), {
      hasOpenPhonePark: false,
      nowMs: BOISE_BUSINESS_MS,
      phonePolicy: BOISE_PHONE_POLICY,
    }),
    false,
  );
  assert.equal(
    isCallBoardEligible(baseRecord({ dne_phone: 1 }), {
      hasOpenPhonePark: false,
      nowMs: BOISE_BUSINESS_MS,
      phonePolicy: BOISE_PHONE_POLICY,
    }),
    false,
  );
  // Structural-only path still works with policy disabled.
  assert.equal(
    isCallBoardEligible(baseRecord({ call_attempt_count: 99 }), {
      hasOpenPhonePark: false,
      enforcePhoneAttemptPolicy: false,
    }),
    true,
  );
});

test('call-board: getCallBoard filters ceiling / outside window / future callback', () => {
  const db = openTempDb();
  insertPhoneRecord(db, { _row_id: 'ok_call', fit_score: 90 });
  insertPhoneRecord(db, {
    _row_id: 'ceiling_call',
    call_attempt_count: 3,
    fit_score: 99,
  });
  insertPhoneRecord(db, {
    _row_id: 'future_cb',
    call_callback_at: '2026-08-20T16:00:00.000Z',
    fit_score: 95,
  });
  insertPhoneRecord(db, {
    _row_id: 'due_cb',
    call_callback_at: '2026-08-05T12:00:00.000Z',
    fit_score: 70,
  });

  const board = getCallBoard({ db, capacity: 25, nowMs: BOISE_BUSINESS_MS, phonePolicy: BOISE_PHONE_POLICY });
  const ids = board.entries.map((e) => e.record_id);
  assert.ok(ids.includes('ok_call'), `expected ok_call: ${ids}`);
  assert.ok(ids.includes('due_cb'), `expected due callback: ${ids}`);
  assert.ok(!ids.includes('ceiling_call'), 'ceiling must not list');
  assert.ok(!ids.includes('future_cb'), 'future callback must not list');

  // Outside window → empty (or no cold candidates)
  const night = getCallBoard({ db, capacity: 25, nowMs: BOISE_EVENING_MS, phonePolicy: BOISE_PHONE_POLICY });
  assert.equal(night.entries.length, 0);

  db.close();
});

test('call-board: dispose wrong_number / callback / unserved transitions persist', () => {
  const db = openTempDb();
  insertPhoneRecord(db, { _row_id: 'disp_wrong', treatment_tier: 'A' });
  insertPhoneRecord(db, { _row_id: 'disp_cb', treatment_tier: 'A' });
  insertPhoneRecord(db, { _row_id: 'disp_na', treatment_tier: 'B', call_attempt_count: 2 });

  claimCallBoardEntry({
    db,
    recordId: 'disp_wrong',
    claimedBy: 'alice',
    nowMs: BOISE_BUSINESS_MS,
    phonePolicy: BOISE_PHONE_POLICY,
  });
  const wrong = disposeCallBoardEntry({
    db,
    recordId: 'disp_wrong',
    disposition: 'wrong_number',
    disposedBy: 'alice',
    phonePolicy: BOISE_PHONE_POLICY,
  });
  assert.equal(wrong.phone_invalidated, true);
  assert.equal(wrong.call_claim_status, 'completed');
  const wrongRow = db.prepare('SELECT * FROM records WHERE _row_id=?').get('disp_wrong');
  assert.equal(Number(wrongRow.dne_phone), 1);
  assert.equal(Number(wrongRow.phone_suppressed), 1);
  assert.ok(Number(wrongRow.suppressed) !== 1, 'must not full-account DNC');
  // Board no longer surfaces wrong-number path
  assert.equal(
    isCallBoardEligible(wrongRow, { hasOpenPhonePark: false, nowMs: BOISE_BUSINESS_MS, phonePolicy: BOISE_PHONE_POLICY }),
    false,
  );

  claimCallBoardEntry({
    db,
    recordId: 'disp_cb',
    claimedBy: 'alice',
    nowMs: BOISE_BUSINESS_MS,
    phonePolicy: BOISE_PHONE_POLICY,
  });
  const cb = disposeCallBoardEntry({
    db,
    recordId: 'disp_cb',
    disposition: 'callback',
    disposedBy: 'alice',
    callbackAt: '2026-08-06T15:00:00.000Z',
    phonePolicy: BOISE_PHONE_POLICY,
  });
  assert.equal(cb.call_claim_status, 'open');
  assert.equal(cb.callback_at, '2026-08-06T15:00:00.000Z');
  const cbRow = db.prepare('SELECT * FROM records WHERE _row_id=?').get('disp_cb');
  assert.equal(String(cbRow.call_callback_at), '2026-08-06T15:00:00.000Z');
  assert.equal(String(cbRow.call_window_status), 'callback_scheduled');
  // Future callback not eligible yet
  assert.equal(
    isCallBoardEligible(cbRow, { hasOpenPhonePark: false, nowMs: BOISE_BUSINESS_MS, phonePolicy: BOISE_PHONE_POLICY }),
    false,
  );
  // Due callback is eligible
  assert.equal(
    isCallBoardEligible(cbRow, {
      hasOpenPhonePark: false,
      nowMs: Date.parse('2026-08-06T16:00:00.000Z'),
      phonePolicy: BOISE_PHONE_POLICY,
    }),
    true,
  );

  claimCallBoardEntry({
    db,
    recordId: 'disp_na',
    claimedBy: 'bob',
    nowMs: BOISE_BUSINESS_MS,
    phonePolicy: BOISE_PHONE_POLICY,
  });
  const na = disposeCallBoardEntry({
    db,
    recordId: 'disp_na',
    disposition: 'no_answer',
    disposedBy: 'bob',
    phonePolicy: BOISE_PHONE_POLICY,
  });
  assert.equal(na.capacity_unserved, true);
  assert.equal(na.call_attempt_count, 3);
  assert.equal(na.call_window_status, 'exhausted');
  const naRow = db.prepare('SELECT * FROM records WHERE _row_id=?').get('disp_na');
  assert.equal(Number(naRow.call_capacity_unserved), 1);
  const next = JSON.parse(String(naRow.next_action_json));
  assert.equal(next.action_type, 'capacity_unserved');

  db.close();
});

test('call-board: claim refuses outside attempt window and at ceiling', () => {
  const db = openTempDb();
  insertPhoneRecord(db, { _row_id: 'claim_window' });
  insertPhoneRecord(db, { _row_id: 'claim_ceiling', call_attempt_count: 3 });

  assert.throws(
    () => claimCallBoardEntry({
      db,
      recordId: 'claim_window',
      claimedBy: 'op',
      nowMs: BOISE_EVENING_MS,
      phonePolicy: BOISE_PHONE_POLICY,
    }),
    /outside_attempt_window|not call-board eligible/,
  );

  assert.throws(
    () => claimCallBoardEntry({
      db,
      recordId: 'claim_ceiling',
      claimedBy: 'op',
      nowMs: BOISE_BUSINESS_MS,
      phonePolicy: BOISE_PHONE_POLICY,
    }),
    /attempt_ceiling|not call-board eligible/,
  );

  // Happy path inside window
  const claimed = claimCallBoardEntry({
    db,
    recordId: 'claim_window',
    claimedBy: 'op',
    nowMs: BOISE_BUSINESS_MS,
    phonePolicy: BOISE_PHONE_POLICY,
  });
  assert.equal(claimed.ok, true);

  db.close();
});
