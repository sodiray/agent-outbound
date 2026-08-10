/**
 * A prior pass must not permanently suppress a non-side-effecting gate when
 * its declared inputs later change. Side-effecting / engine-owned transmitters
 * stay resolved forever (double-send guard).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  REEXAMINED_INPUTS_CHANGED_REASON,
  runDataflowCore,
  runPipelineDataflow,
} from '../dist/orchestrator/pipeline/dataflow.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';

const listDirFor = (prefix) => mkdtempSync(join(tmpdir(), prefix));

const contentGateConfig = `
list:
  name: resolved-reopen
ai:
  default_model: openrouter/anthropic/claude-haiku-4.5
sequences:
  default: { steps: [] }
pipeline:
  - kind: filter
    id: content_gate
    type: field_check
    inputs: [claim_text]
    match: all
    conditions:
      - field: claim_text
        operator: eq
        value: ok
    on_fail: drop
  - kind: send_email
    id: outreach
    side_effecting: true
    inputs: [claim_text]
    config: { channel: email }
score:
  criteria: []
`;

const seedList = ({ claimText = 'ok', sequenceStatus = 'idle', disqualifiedAt = '' } = {}) => {
  const listDir = listDirFor('ao-resolved-reopen-');
  writeFileSync(join(listDir, 'outbound.yaml'), contentGateConfig);
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({ db, columns: [{ name: 'claim_text', type: 'TEXT' }] });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, claim_text, sequence_name, sequence_status,
      disqualified_at, disqualified_gate, disqualify_reason,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?
    )
  `).run(
    'acct_reopen',
    'Reopen Co',
    claimText,
    'default',
    sequenceStatus,
    disqualifiedAt || null,
    disqualifiedAt ? 'content_gate' : null,
    disqualifiedAt ? 'prior drop' : null,
    now,
    now,
    now,
    now,
  );
  db.close();
  return listDir;
};

const eventsFor = (listDir, stepId) => {
  const db = openListDb({ listDir, readonly: true });
  const rows = db.prepare(`
    SELECT step_id, kind, passed, reason
    FROM pipeline_events
    WHERE record_id = 'acct_reopen' AND step_id = ?
    ORDER BY rowid
  `).all(stepId);
  db.close();
  return rows;
};

const setClaimText = (listDir, claimText) => {
  const db = openListDb({ listDir, readonly: false });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('acct_reopen');
  upsertRecord({ db, row: { ...record, claim_text: claimText } });
  db.close();
};

const recordRow = (listDir) => {
  const db = openListDb({ listDir, readonly: true });
  const row = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('acct_reopen');
  db.close();
  return row;
};

test('resolved non-side-effecting filter re-runs when declared inputs change', async () => {
  const listDir = seedList({ claimText: 'ok' });

  await runPipelineDataflow({ listDir });
  const afterPass = eventsFor(listDir, 'content_gate').filter((e) => e.passed === 1);
  assert.equal(afterPass.length, 1, 'first run should pass the gate once');

  setClaimText(listDir, 'bad regenerated content');
  await runPipelineDataflow({ listDir });

  const gateEvents = eventsFor(listDir, 'content_gate');
  const reexamined = gateEvents.filter((e) => e.passed === 0 && String(e.reason || '').length > 0);
  assert.ok(
    reexamined.length >= 1,
    `gate must re-run and fail on changed inputs, events=${JSON.stringify(gateEvents)}`,
  );
  const row = recordRow(listDir);
  assert.ok(row.disqualified_at, 'failing re-examination must drop the record');
});

test('resolved non-side-effecting filter stays already_resolved when inputs are unchanged', async () => {
  const listDir = seedList({ claimText: 'ok' });

  await runPipelineDataflow({ listDir });
  await runPipelineDataflow({ listDir });

  const gateEvents = eventsFor(listDir, 'content_gate');
  const passes = gateEvents.filter((e) => e.passed === 1);
  assert.equal(passes.length, 1, 'must not re-execute the gate when inputs are unchanged');
  const skipped = gateEvents.filter((e) => e.reason === 'skipped:already_resolved');
  assert.ok(skipped.length >= 1, `expected skipped:already_resolved, events=${JSON.stringify(gateEvents)}`);
  assert.ok(
    !gateEvents.some((e) => e.reason === REEXAMINED_INPUTS_CHANGED_REASON),
    'unchanged inputs must not record a re-examination reason',
  );
});

test('resolved side-effecting transmitter does not re-run when inputs change (double-send guard)', async () => {
  const listDir = seedList({ claimText: 'ok' });
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  // Prior successful send — the double-send guard must keep this resolved forever.
  db.prepare(`
    INSERT INTO pipeline_events (
      event_id, record_id, step_id, kind, passed, reason, side_effecting, occurred_at
    ) VALUES (?, 'acct_reopen', 'outreach', 'send_email', 1, 'sent', 1, ?)
  `).run(`evt_send_${now}`, now);
  // Gate already passed under the original inputs so the send is not blocked by deps.
  db.prepare(`
    INSERT INTO pipeline_events (
      event_id, record_id, step_id, kind, passed, reason, occurred_at
    ) VALUES (?, 'acct_reopen', 'content_gate', 'filter', 1, '', ?)
  `).run(`evt_gate_${now}`, now);
  db.prepare(`
    INSERT INTO staleness (id, record_id, step_id, dep_hash, cache_ttl, cache_ttl_seconds, updated_at)
    VALUES (?, 'acct_reopen', 'filter:content_gate', 'seed-fresh-placeholder', '', 0, ?)
  `).run(`stale_gate_${now}`, now);
  db.close();

  // Change a declared input of the transmitter. Must NOT re-open the send.
  setClaimText(listDir, 'completely different body');

  let sendExecutions = 0;
  const steps = [
    {
      id: 'content_gate', index: 0, step: { kind: 'filter', id: 'content_gate', side_effecting: false },
      kind: 'filter', tier: 0, cost: 0, dropGate: true, deps: [], executable: true,
    },
    {
      id: 'outreach', index: 1,
      step: { kind: 'send_email', id: 'outreach', side_effecting: true, inputs: ['claim_text'] },
      kind: 'send_email', tier: 3, cost: 0, dropGate: false, deps: ['content_gate'], executable: true,
    },
  ];
  const skipped = [];
  await runDataflowCore({
    records: [{ _row_id: 'acct_reopen', claim_text: 'completely different body' }],
    steps,
    concurrency: 1,
    // Mirrors initializeResolved permanent-resolve for transmitters / prior passes
    // that must not re-open when inputs move.
    initialResolvedByRecord: new Map([['acct_reopen', new Set(['content_gate', 'outreach'])]]),
    isTimeReady: () => true,
    loadStep: async (step) => {
      if (step.id === 'outreach') sendExecutions += 1;
      throw new Error(`must not execute pre-resolved step ${step.id}`);
    },
    onStepOutcome: async () => ({}),
    onStepNotAttempted: async (_rs, step, reason) => {
      skipped.push({ id: step.id, reason });
    },
  });

  assert.equal(sendExecutions, 0, 'transmitter must never re-execute after a prior pass');
  assert.deepEqual(
    skipped.find((s) => s.id === 'outreach'),
    { id: 'outreach', reason: 'skipped:already_resolved' },
  );

  // Full pipeline path: seed a real pass + change inputs; send stays resolved
  // even if an upstream gate re-opens and drops the record.
  await runPipelineDataflow({ listDir });
  const sendEvents = eventsFor(listDir, 'outreach');
  const sendPasses = sendEvents.filter((e) => e.passed === 1);
  assert.equal(
    sendPasses.length,
    1,
    `double-send guard: send must not gain another pass event, events=${JSON.stringify(sendEvents)}`,
  );
  assert.ok(
    !sendEvents.some((e) => e.reason === REEXAMINED_INPUTS_CHANGED_REASON),
    'transmitter must never be re-examined for input changes',
  );
});

test('dropped or terminal records are not resurrected by input-driven re-open', async () => {
  const listDir = seedList({
    claimText: 'bad regenerated content',
    sequenceStatus: 'idle',
    disqualifiedAt: '2026-01-01T00:00:00.000Z',
  });
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO pipeline_events (
      event_id, record_id, step_id, kind, passed, reason, occurred_at
    ) VALUES (?, 'acct_reopen', 'content_gate', 'filter', 1, '', ?)
  `).run(`evt_prior_${now}`, now);
  db.close();

  await runPipelineDataflow({ listDir });

  const row = recordRow(listDir);
  assert.ok(row.disqualified_at, 'dropped record must remain dropped');
  const gateEvents = eventsFor(listDir, 'content_gate');
  // In-play filter re-open must not run for a disqualified (out-of-play) record.
  assert.equal(
    gateEvents.filter((e) => e.reason === REEXAMINED_INPUTS_CHANGED_REASON).length,
    0,
    `dropped record must not be re-examined, events=${JSON.stringify(gateEvents)}`,
  );

  // In-scheduler: once a record is dropped, later gates must not run (no resurrection).
  const attempted = [];
  const skipped = [];
  await runDataflowCore({
    records: [{ _row_id: 'terminal-drop' }],
    steps: [
      {
        id: 'dropper', index: 0, step: {}, kind: 'filter',
        tier: 0, cost: 0, dropGate: true, deps: [], executable: true,
      },
      {
        id: 'later_gate', index: 1, step: {}, kind: 'filter',
        tier: 0, cost: 0, dropGate: true, deps: ['dropper'], executable: true,
      },
    ],
    concurrency: 1,
    isTimeReady: () => true,
    loadStep: async (step) => {
      attempted.push(step.id);
      return step.id === 'dropper'
        ? { passed: false, reason: 'drop' }
        : { passed: true, reason: '' };
    },
    onStepOutcome: async (_rs, step, outcome) => ({
      resolved: outcome.passed,
      dropped: step.id === 'dropper' && !outcome.passed,
    }),
    onStepNotAttempted: async (_rs, step, reason) => {
      skipped.push({ id: step.id, reason });
    },
  });
  assert.deepEqual(attempted, ['dropper']);
  assert.ok(
    skipped.some((s) => s.id === 'later_gate' && s.reason === 'skipped:record_dropped'),
    `later gate must not run after drop, skipped=${JSON.stringify(skipped)}`,
  );
});

test('re-examination is distinguishable from never-re-examined in recorded reason', async () => {
  const listDir = seedList({ claimText: 'ok' });

  await runPipelineDataflow({ listDir });
  const firstPass = eventsFor(listDir, 'content_gate').filter((e) => e.passed === 1);
  assert.equal(firstPass.length, 1);
  assert.notEqual(firstPass[0].reason, REEXAMINED_INPUTS_CHANGED_REASON);

  // Unchanged re-run: still resolved, never re-examined.
  await runPipelineDataflow({ listDir });
  const afterUnchanged = eventsFor(listDir, 'content_gate');
  assert.ok(afterUnchanged.some((e) => e.reason === 'skipped:already_resolved'));
  assert.ok(!afterUnchanged.some((e) => e.reason === REEXAMINED_INPUTS_CHANGED_REASON));

  // Change input to another value that still passes the field check — re-pass
  // should record the re-examination reason, not another silent pass or already_resolved.
  // Use a condition that still equals 'ok' after a write of the same check value
  // but a different staleness identity: flip away and back forces re-open then pass.
  // Force the existing staleness row stale while keeping claim_text=ok so the
  // re-opened gate passes again and records the re-examination reason.
  const db = openListDb({ listDir, readonly: false });
  db.prepare(`
    UPDATE staleness SET dep_hash = 'intentionally-stale'
    WHERE record_id = 'acct_reopen' AND step_id = 'filter:content_gate'
  `).run();
  db.close();

  await runPipelineDataflow({ listDir });
  const reexamined = eventsFor(listDir, 'content_gate').filter(
    (e) => e.passed === 1 && e.reason === REEXAMINED_INPUTS_CHANGED_REASON,
  );
  assert.ok(
    reexamined.length >= 1,
    `expected ${REEXAMINED_INPUTS_CHANGED_REASON} on re-pass, events=${JSON.stringify(eventsFor(listDir, 'content_gate'))}`,
  );
});
