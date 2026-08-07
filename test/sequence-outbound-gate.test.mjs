/**
 * Proves the sequencer outbound gate consumes next_action_json + account_sequence_state.
 * Pure helper tests + openListDb selection simulation matching runner wiring.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openListDb, ensureRecordColumns } from '../dist/orchestrator/runtime/db.js';
import {
  shouldExecuteSequenceOutbound,
  filterRecordsForSequenceOutbound,
  SEQUENCE_STATES_BLOCK_OUTBOUND,
  OUTBOUND_ACTION_TYPES,
  WAIT_ACTION_TYPES,
  NON_OUTBOUND_ACTION_TYPES,
} from '../dist/orchestrator/policy/sequence-outbound.js';
import { NEXT_ACTION_POLICY_VERSION } from '../dist/orchestrator/policy/lifecycle.js';
import { addIsoDays } from '../dist/orchestrator/lib/working-days.js';
import { resolveSequencerClock } from '../dist/orchestrator/sequencer/runner.js';

const NOW = '2026-08-04T15:00:00.000Z';
const TODAY = '2026-08-04';

const nextAction = (action_type, overrides = {}) => ({
  action_id: `na_${action_type}_1`,
  action_type,
  account_id: 'acct_1',
  lifecycle_stage: 'contacted',
  sequence_state: 'active',
  work_state: 'executing_external_action',
  reason: `test ${action_type}`,
  on_success: 'continue',
  policy_version: NEXT_ACTION_POLICY_VERSION,
  ...overrides,
});

const record = (overrides = {}) => ({
  _row_id: 'acct_1',
  sequence_status: 'active',
  sequence_step: 0,
  next_action_date: TODAY,
  account_sequence_state: 'active',
  work_state: 'executing_external_action',
  lifecycle_stage: 'contacted',
  next_action_json: JSON.stringify(nextAction('send_email')),
  ...overrides,
});

// --- Pure helper -----------------------------------------------------------

test('send_email / prepare_outbound allow normal sequence execution', () => {
  for (const action_type of ['send_email', 'prepare_outbound', 'linkedin_connect', 'send_mail']) {
    const d = shouldExecuteSequenceOutbound(record({
      next_action_json: JSON.stringify(nextAction(action_type)),
    }), NOW);
    assert.equal(d.execute, true, action_type);
    assert.equal(d.reason, 'outbound_action');
    assert.equal(d.action_type, action_type);
  }
  assert.ok(OUTBOUND_ACTION_TYPES.has('send_email'));
});

test('paused_* / recycle_wait / completed / cancelled block outbound regardless of next_action', () => {
  for (const sequence_state of SEQUENCE_STATES_BLOCK_OUTBOUND) {
    const d = shouldExecuteSequenceOutbound(record({
      account_sequence_state: sequence_state,
      next_action_json: JSON.stringify(nextAction('send_email')),
    }), NOW);
    assert.equal(d.execute, false, sequence_state);
    assert.equal(d.reason, `sequence_state_${sequence_state}`);
  }
});

test('foundational_enrichment / reentry / terminal never auto-execute outbound', () => {
  for (const action_type of [
    'foundational_enrichment',
    'reentry_evaluation',
    'terminal_recordkeeping',
    'recycle_monitor',
    'await_reply_or_recycle',
  ]) {
    assert.ok(NON_OUTBOUND_ACTION_TYPES.has(action_type) || action_type.startsWith('terminal'), action_type);
    const d = shouldExecuteSequenceOutbound(record({
      account_sequence_state: 'active',
      next_action_json: JSON.stringify(nextAction(action_type)),
    }), NOW);
    assert.equal(d.execute, false, action_type);
    assert.match(d.reason, /non_outbound_action_/);
  }
});

test('wait skips when due_at is in the future', () => {
  assert.ok(WAIT_ACTION_TYPES.has('wait'));
  const d = shouldExecuteSequenceOutbound(record({
    next_action_date: '2026-08-20',
    next_action_json: JSON.stringify(nextAction('wait', {
      due_at: '2026-08-20T00:00:00.000Z',
      work_state: 'waiting_time_or_event',
      sequence_state: 'waiting',
    })),
    account_sequence_state: 'waiting',
  }), NOW);
  assert.equal(d.execute, false);
  assert.equal(d.reason, 'wait_not_due');
});

test('wait allows when due_at has passed (advance wait)', () => {
  const d = shouldExecuteSequenceOutbound(record({
    next_action_date: '2026-08-01',
    next_action_json: JSON.stringify(nextAction('wait', {
      due_at: '2026-08-01T00:00:00.000Z',
      work_state: 'waiting_time_or_event',
      sequence_state: 'waiting',
    })),
    account_sequence_state: 'waiting',
  }), NOW);
  assert.equal(d.execute, true);
  assert.equal(d.reason, 'wait_due');
});

test('wait due on day D fires on D and not D-1 in the pipeline timezone', () => {
  const waitingRecord = record({
    next_action_date: '2026-08-10',
    next_action_json: JSON.stringify(nextAction('wait', {
      due_at: '2026-08-10',
      work_state: 'waiting_time_or_event',
      sequence_state: 'waiting',
    })),
    account_sequence_state: 'waiting',
  });
  const onDueDate = shouldExecuteSequenceOutbound(
    waitingRecord,
    '2026-08-10T12:00:00.000Z',
    { today: '2026-08-10', timeZone: 'America/Boise' },
  );
  const dayBefore = shouldExecuteSequenceOutbound(
    waitingRecord,
    '2026-08-09T12:00:00.000Z',
    { today: '2026-08-09', timeZone: 'America/Boise' },
  );

  assert.equal(onDueDate.execute, true);
  assert.equal(onDueDate.reason, 'wait_due');
  assert.equal(dayBefore.execute, false);
  assert.equal(dayBefore.reason, 'wait_not_due');
});

test('three-day cadence from the 7th becomes due on the 10th', () => {
  const dueAt = addIsoDays('2026-08-07', 3);
  assert.equal(dueAt, '2026-08-10');

  const waitingRecord = record({
    next_action_date: dueAt,
    next_action_json: JSON.stringify(nextAction('wait', {
      due_at: dueAt,
      work_state: 'waiting_time_or_event',
      sequence_state: 'waiting',
    })),
    account_sequence_state: 'waiting',
  });
  const decision = shouldExecuteSequenceOutbound(
    waitingRecord,
    '2026-08-10T12:00:00.000Z',
    { today: dueAt, timeZone: 'America/Boise' },
  );

  assert.equal(decision.execute, true);
  assert.equal(decision.reason, 'wait_due');
});

test('date-only AO_NOW retains its named pipeline date', () => {
  const previousAoNow = process.env.AO_NOW;
  process.env.AO_NOW = '2026-08-10';
  try {
    assert.deepEqual(
      resolveSequencerClock({ timeZone: 'America/Boise' }),
      { logicalNow: new Date('2026-08-10T00:00:00.000Z'), today: '2026-08-10' },
    );
    assert.equal(
      resolveSequencerClock({ now: '2026-08-10T00:00:00.000Z', timeZone: 'America/Boise' }).today,
      '2026-08-09',
    );
  } finally {
    if (previousAoNow === undefined) delete process.env.AO_NOW;
    else process.env.AO_NOW = previousAoNow;
  }
});

test('wait without due_at falls back to next_action_date for due check', () => {
  const notDue = shouldExecuteSequenceOutbound(record({
    next_action_date: '2026-08-20',
    next_action_json: JSON.stringify(nextAction('wait', { due_at: null })),
    account_sequence_state: 'waiting',
  }), NOW);
  assert.equal(notDue.execute, false);
  assert.equal(notDue.reason, 'wait_not_due');

  const due = shouldExecuteSequenceOutbound(record({
    next_action_date: '2026-08-01',
    next_action_json: JSON.stringify(nextAction('wait', { due_at: null })),
    account_sequence_state: 'waiting',
  }), NOW);
  assert.equal(due.execute, true);
  assert.equal(due.reason, 'wait_due');
});

test('missing next_action_json allows legacy sequence_step path', () => {
  const d = shouldExecuteSequenceOutbound(record({
    next_action_json: '',
    account_sequence_state: 'active',
  }), NOW);
  assert.equal(d.execute, true);
  assert.equal(d.reason, 'no_next_action_json');
});

test('unknown action_type does not invent outbound permission', () => {
  const d = shouldExecuteSequenceOutbound(record({
    next_action_json: JSON.stringify(nextAction('teleport_to_mars')),
  }), NOW);
  assert.equal(d.execute, false);
  assert.match(d.reason, /unknown_action_type_/);
});

test('filterRecordsForSequenceOutbound drops gated rows', () => {
  const rows = [
    record({ _row_id: 'a', next_action_json: JSON.stringify(nextAction('send_email')) }),
    record({
      _row_id: 'b',
      account_sequence_state: 'paused_review',
      next_action_json: JSON.stringify(nextAction('send_email')),
    }),
    record({
      _row_id: 'c',
      next_action_json: JSON.stringify(nextAction('foundational_enrichment')),
    }),
  ];
  const allowed = filterRecordsForSequenceOutbound(rows, NOW);
  assert.deepEqual(allowed.map((r) => r._row_id), ['a']);
});

// --- openListDb selection simulation (mirrors collectDueRecords + gate) ----

const POLICY_COLUMNS = [
  'lifecycle_stage',
  'account_sequence_state',
  'work_state',
  'next_action_json',
  'active_contact_id',
  'treatment_tier',
  'suppressed',
];

const projectYaml = `
list:
  name: Sequence Gate Test
business:
  name: Mission
  description: Test
  icp: Test
  offer: Test
pipeline: []
sequences:
  default:
    steps:
      - kind: send_email
        id: email_1
        day: 0
`;

/**
 * Same selection shape the runner uses after collectDueRecords:
 * in-play-ish active rows, then shouldExecuteSequenceOutbound.
 */
const selectDueForOutbound = (db, nowIso) => {
  const rows = db.prepare(`
    SELECT * FROM records
    WHERE (sequence_status IS NULL OR sequence_status NOT IN ('completed','opted_out'))
    ORDER BY updated_at DESC
  `).all();
  return rows.filter((row) => shouldExecuteSequenceOutbound(row, nowIso).execute);
};

const seedList = (fixtures) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-seq-gate-'));
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml);
  writeFileSync(join(listDir, 'operator.md'), 'test');
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: POLICY_COLUMNS });
  const now = new Date().toISOString();
  for (const f of fixtures) {
    db.prepare(`
      INSERT INTO records (
        _row_id, business_name, sequence_name, sequence_status, sequence_step,
        next_action_date, lifecycle_stage, account_sequence_state, work_state, next_action_json,
        _created_at, _updated_at, created_at, updated_at
      ) VALUES (?, ?, 'default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      f._row_id,
      f.business_name || f._row_id,
      f.sequence_status || 'active',
      f.sequence_step ?? 0,
      f.next_action_date || TODAY,
      f.lifecycle_stage || 'contacted',
      f.account_sequence_state || 'active',
      f.work_state || 'executing_external_action',
      f.next_action_json != null ? f.next_action_json : JSON.stringify(nextAction('send_email', { account_id: f._row_id })),
      now,
      now,
      now,
      now,
    );
  }
  return { listDir, db };
};

test('openListDb selection respects next_action_json and account_sequence_state', () => {
  const { db } = seedList([
    {
      _row_id: 'due_send',
      next_action_json: JSON.stringify(nextAction('send_email', { account_id: 'due_send' })),
    },
    {
      _row_id: 'paused',
      account_sequence_state: 'paused_inbound',
      next_action_json: JSON.stringify(nextAction('send_email', { account_id: 'paused' })),
    },
    {
      _row_id: 'enrich_hold',
      account_sequence_state: 'not_started',
      next_action_json: JSON.stringify(nextAction('foundational_enrichment', {
        account_id: 'enrich_hold',
        sequence_state: 'not_started',
        work_state: 'research_enrichment',
      })),
    },
    {
      _row_id: 'waiting_future',
      account_sequence_state: 'waiting',
      next_action_date: '2026-09-01',
      next_action_json: JSON.stringify(nextAction('wait', {
        account_id: 'waiting_future',
        due_at: '2026-09-01T00:00:00.000Z',
        sequence_state: 'waiting',
        work_state: 'waiting_time_or_event',
      })),
    },
    {
      _row_id: 'waiting_due',
      account_sequence_state: 'waiting',
      next_action_date: '2026-08-01',
      next_action_json: JSON.stringify(nextAction('wait', {
        account_id: 'waiting_due',
        due_at: '2026-08-01T00:00:00.000Z',
        sequence_state: 'waiting',
        work_state: 'waiting_time_or_event',
      })),
    },
    {
      _row_id: 'seq_completed',
      account_sequence_state: 'completed',
      sequence_status: 'active',
      next_action_json: JSON.stringify(nextAction('send_email', { account_id: 'seq_completed' })),
    },
  ]);

  const due = selectDueForOutbound(db, NOW);
  const ids = due.map((r) => r._row_id).sort();
  assert.deepEqual(ids, ['due_send', 'waiting_due']);
  db.close();
});

test('runner imports shouldExecuteSequenceOutbound from policy (source contract)', async () => {
  // Build emits runner.js; assert the production import site exists.
  const { readFileSync } = await import('node:fs');
  const runnerSrc = readFileSync(
    join(process.cwd(), 'src/orchestrator/sequencer/runner.ts'),
    'utf8',
  );
  assert.match(runnerSrc, /shouldExecuteSequenceOutbound/);
  assert.match(runnerSrc, /from '\.\.\/policy\/sequence-outbound\.js'/);
  assert.match(runnerSrc, /sequence_outbound_gated/);
});
