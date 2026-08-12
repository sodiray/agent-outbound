/**
 * Config-intent conformance.
 *
 * Every test here answers one question: does the engine do what the config
 * SAID, for a control an author declares? A control that is declared but not
 * enforced is worse than no control, because everyone believes it is working.
 *
 * Two production incidents motivate the file:
 *   - a step declared `on_error: empty`, a provider returned 429, the engine
 *     hard-errored anyway, and ~176 records were stranded through `depends_on`;
 *   - a filter declared `on_fail: drop` and dropped nothing for weeks.
 *
 * Where the engine does NOT honour a declaration, the test PINS the real
 * behaviour and says so in a comment. Nothing here asserts a wish.
 *
 * Everything is hermetic: temp dirs, field_check conditions (no model spend),
 * and injected fake actions. No network, no provider, no real send.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runDataflowCore, runPipelineDataflow } from '../dist/orchestrator/pipeline/dataflow.js';
import { executeStepBatch } from '../dist/orchestrator/pipeline/step-executor.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';

const newListDir = () => mkdtempSync(join(tmpdir(), 'ao-config-intent-'));

const writeConfig = (listDir, yaml) => writeFileSync(join(listDir, 'outbound.yaml'), yaml);

/**
 * A filter gate on `quality`, then an assign that depends on it. The assign is
 * the downstream observable: it rewrites `sequence_name`, so "did downstream
 * run for this record" is a fact in the record, not an inference.
 */
const CONFIG_PREAMBLE = `
ai:
  default_model: anthropic/claude-haiku-4-5-20251001
source:
  identity: [quality]
sequences:
  qualified:
    steps: []
  holding:
    steps: []
`;

const gateThenAssignConfig = (onFail) => `${CONFIG_PREAMBLE}
pipeline:
  - kind: filter
    id: quality_gate
    type: field_check
    inputs: [quality]
    match: all
    conditions:
      - field: quality
        operator: eq
        value: good
    on_fail: ${onFail}
  - kind: assign
    id: route_after_gate
    target: sequence_name
    fallback: holding
    depends_on: [quality_gate]
    inputs: [quality, sequence_status]
    rules:
      - sequence: qualified
        conditions:
          - field: quality
            operator: eq
            value: good
`;

const seedGateRecords = (listDir, rows) => {
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: ['quality'] });
  rows.forEach((row) => upsertRecord({ db, row }));
  db.close();
};

const readRecords = (listDir) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    const rows = db.prepare('SELECT * FROM records ORDER BY _row_id').all();
    const events = db.prepare(`
      SELECT record_id, step_id, passed, reason
      FROM pipeline_events
      ORDER BY record_id, step_id
    `).all();
    return {
      byId: new Map(rows.map((row) => [row._row_id, row])),
      events,
      eventFor: (recordId, stepId) => events.find((event) => (
        event.record_id === recordId && event.step_id === stepId
      )),
    };
  } finally {
    db.close();
  }
};

const pipelineFlags = (record) => {
  const raw = record?.extra_json;
  const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
  return Array.isArray(parsed.pipeline_flags) ? parsed.pipeline_flags : [];
};

// ---------------------------------------------------------------------------
// A. `on_fail` on filter steps
// ---------------------------------------------------------------------------

test('on_fail: drop actually drops the failing record and stops its downstream steps', async () => {
  const listDir = newListDir();
  writeConfig(listDir, gateThenAssignConfig('drop'));
  seedGateRecords(listDir, [
    { _row_id: 'keeper', business_name: 'Keeper', quality: 'good' },
    { _row_id: 'loser', business_name: 'Loser', quality: 'bad' },
  ]);

  await runPipelineDataflow({ listDir });

  const state = readRecords(listDir);
  const loser = state.byId.get('loser');
  const keeper = state.byId.get('keeper');

  // Dropped: out of play, and the gate that did it is named on the record.
  assert.notEqual(String(loser.disqualified_at || ''), '', 'on_fail: drop must disqualify the failing record');
  assert.equal(loser.disqualified_gate, 'quality_gate');
  assert.match(String(loser.disqualify_reason || ''), /quality/i);
  assert.deepEqual(
    pipelineFlags(loser).map((flag) => ({ step_id: flag.step_id, severity: flag.severity })),
    [{ step_id: 'quality_gate', severity: 'drop' }],
  );

  // Downstream did not run for it: sequence_name was never rewritten, and the
  // scheduler says why. This is the half that "dropped ZERO records" hid.
  assert.notEqual(loser.sequence_name, 'qualified');
  assert.notEqual(loser.sequence_name, 'holding');
  assert.equal(state.eventFor('loser', 'route_after_gate')?.reason, 'skipped:record_dropped');

  // The passing record is untouched by any of this and routes normally.
  assert.equal(String(keeper.disqualified_at || ''), '');
  assert.equal(keeper.sequence_name, 'qualified');
  assert.equal(state.eventFor('keeper', 'quality_gate')?.passed, 1);
});

test('on_fail: flag keeps the failing record and lets its downstream steps run', async () => {
  const listDir = newListDir();
  writeConfig(listDir, gateThenAssignConfig('flag'));
  seedGateRecords(listDir, [
    { _row_id: 'keeper', business_name: 'Keeper', quality: 'good' },
    { _row_id: 'loser', business_name: 'Loser', quality: 'bad' },
  ]);

  await runPipelineDataflow({ listDir });

  const state = readRecords(listDir);
  const loser = state.byId.get('loser');

  // Flagged, not dropped: still in play, no disqualification fields written.
  assert.equal(String(loser.disqualified_at || ''), '');
  assert.equal(String(loser.disqualified_gate || ''), '');
  assert.deepEqual(
    pipelineFlags(loser).map((flag) => ({ step_id: flag.step_id, severity: flag.severity })),
    [{ step_id: 'quality_gate', severity: 'flag' }],
  );

  // The gate still recorded a real failure — flag is not "pass".
  assert.equal(state.eventFor('loser', 'quality_gate')?.passed, 0);

  // ...and the downstream step DID run, landing it on the assign fallback.
  assert.equal(loser.sequence_name, 'holding');
  assert.equal(state.eventFor('loser', 'route_after_gate')?.passed, 1);
});

test('drop and flag differ in record state and in downstream execution, not just in a label', async () => {
  const run = async (onFail) => {
    const listDir = newListDir();
    writeConfig(listDir, gateThenAssignConfig(onFail));
    seedGateRecords(listDir, [{ _row_id: 'loser', business_name: 'Loser', quality: 'bad' }]);
    await runPipelineDataflow({ listDir });
    const state = readRecords(listDir);
    const loser = state.byId.get('loser');
    return {
      in_play: String(loser.disqualified_at || '') === '',
      downstream_ran: state.eventFor('loser', 'route_after_gate')?.passed === 1,
      severity: pipelineFlags(loser)[0]?.severity,
    };
  };

  assert.deepEqual(await run('drop'), { in_play: false, downstream_ran: false, severity: 'drop' });
  assert.deepEqual(await run('flag'), { in_play: true, downstream_ran: true, severity: 'flag' });
});

test('KNOWN CONDITIONAL: on_fail: drop does NOT drop a record already committed to outreach', async () => {
  // Declared-but-conditional, and deliberate: shared.ts:152-154 turns a drop
  // into a review flag for any record that is committed (launched_at set, or a
  // committed sequence_status). The engine will not silently vanish a lead a
  // human is already mid-conversation with.
  //
  // This is pinned, not endorsed: an author reading `on_fail: drop` has no way
  // to know from the config that a committed record survives it. If this ever
  // changes to a hard drop, this test must fail loudly rather than a live
  // conversation disappearing.
  const listDir = newListDir();
  writeConfig(listDir, gateThenAssignConfig('drop'));
  seedGateRecords(listDir, [{
    _row_id: 'committed_loser',
    business_name: 'Committed Loser',
    quality: 'bad',
    launched_at: new Date().toISOString(),
  }]);

  await runPipelineDataflow({ listDir });

  const state = readRecords(listDir);
  const record = state.byId.get('committed_loser');
  assert.equal(String(record.disqualified_at || ''), '', 'committed records are not dropped by on_fail: drop');
  assert.equal(record.needs_review, 1);
  assert.match(String(record.review_reason || ''), /^quality_gate: /);
  assert.deepEqual(
    pipelineFlags(record).map((flag) => flag.severity),
    ['review'],
  );
  // Because it was not dropped, downstream still runs for it.
  assert.equal(state.eventFor('committed_loser', 'route_after_gate')?.passed, 1);
});

// ---------------------------------------------------------------------------
// B. `on_error` on enrich steps
// ---------------------------------------------------------------------------

const enrichListDir = () => {
  const listDir = newListDir();
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: ['website', 'site_text'] });
  upsertRecord({
    db,
    row: {
      _row_id: 'record_1',
      business_name: 'Example Account',
      website: 'https://example.test',
      sequence_name: 'default',
      sequence_status: 'idle',
    },
  });
  return { listDir, db };
};

const failingToolStep = ({ onError = 'empty', error }) => ({
  kind: 'enrich',
  id: 'remote_lookup',
  action: 'tool_call',
  inputs: ['website'],
  on_error: onError,
  tool: { server: 'provider', tools: ['FETCH'], effect: { class: 'data_lookup' } },
  args_map: { url: 'website' },
  output_map: { site_text: 'markdown' },
  outputs: { site_text: { type: 'string' } },
  __tryTool: async () => { throw error; },
});

const currentRecord = (db) => db.prepare('SELECT * FROM records WHERE _row_id = ?').get('record_1');

/**
 * Run `step` followed by a dependent step through the real scheduler and report
 * which steps executed and what the scheduler said about the ones that did not.
 */
const runWithDependent = async ({ db, listDir, step }) => {
  const ctx = { db, listDir, config: { ai: {} }, mcp: null, toolCatalog: null, force: true };
  const ran = [];
  const notAttempted = [];
  await runDataflowCore({
    records: [currentRecord(db)],
    concurrency: 1,
    isTimeReady: () => true,
    steps: [
      { id: 'remote_lookup', kind: 'enrich', deps: [], executable: true, step },
      { id: 'dependent', kind: 'assign', deps: ['remote_lookup'], executable: true, step: { kind: 'assign' } },
    ],
    loadStep: async (selected, record) => {
      ran.push(selected.id);
      if (selected.id === 'dependent') return { passed: true, reason: '' };
      return (await executeStepBatch(ctx, step, selected.id, [record])).get('record_1');
    },
    // Mirrors the enrich branch of the production persistence callback
    // (dataflow.ts:1287-1313): an errored outcome does NOT resolve the step and
    // marks it errored; anything else resolves.
    onStepOutcome: async (recordState, _selected, outcome) => ({
      record: currentRecord(db) || recordState.record,
      resolved: !outcome.errored,
      errored: Boolean(outcome.errored),
    }),
    onStepNotAttempted: async (_recordState, selected, reason) => {
      notAttempted.push({ step: selected.id, reason });
    },
  });
  return { ran, notAttempted };
};

test('on_error: empty absorbs a record-scoped provider failure as blank and never strands the dependent', async () => {
  const { listDir, db } = enrichListDir();
  try {
    const step = failingToolStep({ error: new Error('HTTP 404 Not Found') });
    const outcome = (await executeStepBatch(
      { db, listDir, config: { ai: {} }, mcp: null, toolCatalog: null, force: true },
      step,
      'remote_lookup',
      [currentRecord(db)],
    )).get('record_1');

    // Absorbed: not a pass, but explicitly not a hard error.
    assert.equal(outcome.errored, false, 'a record-scoped failure must not hard-error under on_error: empty');
    assert.equal(outcome.passed, false);

    // Blank outputs, failure still visible on the record.
    const record = currentRecord(db);
    assert.equal(record.site_text, '');
    assert.equal(record.remote_lookup__status, 'failed');

    // And the graph keeps moving.
    const { ran, notAttempted } = await runWithDependent({ db, listDir, step });
    assert.deepEqual(ran, ['remote_lookup', 'dependent']);
    assert.deepEqual(notAttempted, []);
  } finally {
    db.close();
  }
});

test('KNOWN GAP: on_error: empty does NOT absorb a provider rate limit — it hard-errors and strands the dependent', async () => {
  // THIS IS THE INCIDENT, PINNED. The config said `on_error: empty`. A 429 is
  // not in the record-scoped set (tool-call.ts:125-144 admits 404/408/410, and
  // — for URL-argument calls only — HTTP 400, an HTML-for-JSON parse failure,
  // and connection timeouts). 429 falls through to `return false`, so
  // runner.ts:1827-1830 never reaches the empty-outputs branch, the step
  // hard-errors, and every `depends_on` dependent is stranded. ~176 records.
  //
  // This test asserts the CURRENT behaviour. Do NOT "fix" it by admitting 429
  // to the record-scoped set until the condition below is met -- absorbing a
  // rate limit here is more dangerous than stranding the record, and this
  // hard error is currently load-bearing.
  //
  // Why: absorbing the failure leaves the scrape blank, and nothing downstream
  // requires that the scrape ever succeeded. The quality gates that would catch
  // it are `on_fail: flag`, so they keep the record; the compose step gates only
  // on its own output being empty, not on evidence existing. The capability
  // fields then read as 0, which the pipeline cannot distinguish from "observed
  // absent" -- so the generated sentence asserts an observation nobody made,
  // and it goes to a real business. One record reached that state through a
  // different route (a live site, `site_profile` skipped, all four capability
  // flags defaulting to 0, and an email claiming "your site shows no online
  // booking" about a page whose text mentions booking). Absorbing 429s would
  // reproduce that at the scale of the outage.
  //
  // Close this gap only together with an evidence precondition on compose, so
  // that a record whose site was never read cannot have claims composed about
  // it. Then move these assertions to match `on_error: empty` above.
  const { listDir, db } = enrichListDir();
  try {
    const step = failingToolStep({ error: new Error('HTTP 429 Too Many Requests: rate limit exceeded') });
    const outcome = (await executeStepBatch(
      { db, listDir, config: { ai: {} }, mcp: null, toolCatalog: null, force: true },
      step,
      'remote_lookup',
      [currentRecord(db)],
    )).get('record_1');

    assert.equal(outcome.errored, true, 'PINNED GAP: a 429 hard-errors despite on_error: empty');
    assert.equal(outcome.passed, false);
    assert.match(String(outcome.reason || ''), /429/);

    // The stranding, proven at the scheduler: the dependent never runs, and the
    // scheduler names the cascade.
    const { ran, notAttempted } = await runWithDependent({ db, listDir, step });
    assert.deepEqual(ran, ['remote_lookup'], 'PINNED GAP: the dependent is stranded by the hard error');
    assert.deepEqual(notAttempted, [{ step: 'dependent', reason: 'skipped:upstream_errored:remote_lookup' }]);
  } finally {
    db.close();
  }
});

test('on_error: fail keeps a record-scoped failure fatal, so the two settings genuinely differ', async () => {
  const { listDir, db } = enrichListDir();
  try {
    const step = failingToolStep({ onError: 'fail', error: new Error('HTTP 404 Not Found') });
    const outcome = (await executeStepBatch(
      { db, listDir, config: { ai: {} }, mcp: null, toolCatalog: null, force: true },
      step,
      'remote_lookup',
      [currentRecord(db)],
    )).get('record_1');
    assert.equal(outcome.errored, true);

    const { ran } = await runWithDependent({ db, listDir, step });
    assert.deepEqual(ran, ['remote_lookup']);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// C. `depends_on` gating
// ---------------------------------------------------------------------------

test('depends_on: an unresolved dependency blocks the dependent, and the scheduler names it', async () => {
  const listDir = newListDir();
  writeConfig(listDir, `${CONFIG_PREAMBLE}
pipeline:
  - kind: manual_task
    id: human_call
    inputs: [quality]
    config:
      task_type: human_phone
  - kind: assign
    id: route_after_call
    target: sequence_name
    fallback: holding
    depends_on: [human_call]
    inputs: [quality, sequence_status]
    rules:
      - sequence: qualified
        conditions:
          - field: quality
            operator: eq
            value: good
`);
  seedGateRecords(listDir, [{ _row_id: 'parked', business_name: 'Parked', quality: 'good' }]);

  await runPipelineDataflow({ listDir });

  const state = readRecords(listDir);
  // The dependency parked (awaiting a human) — it never resolved.
  assert.equal(state.eventFor('parked', 'human_call')?.reason, 'awaiting_manual');
  // So the dependent did not execute, and the record was NOT routed.
  assert.equal(
    state.eventFor('parked', 'route_after_call')?.reason,
    'skipped:unresolved_dependencies:human_call',
  );
  assert.notEqual(state.byId.get('parked').sequence_name, 'qualified');
});

test('depends_on: an errored dependency blocks the dependent and the cascade is reported', async () => {
  const { listDir, db } = enrichListDir();
  try {
    const step = failingToolStep({ onError: 'fail', error: new Error('HTTP 500 upstream exploded') });
    const { ran, notAttempted } = await runWithDependent({ db, listDir, step });
    assert.deepEqual(ran, ['remote_lookup']);
    assert.deepEqual(notAttempted, [{ step: 'dependent', reason: 'skipped:upstream_errored:remote_lookup' }]);
  } finally {
    db.close();
  }
});

test('depends_on: a satisfied dependency lets the dependent execute', async () => {
  // Same shape as the blocked cases, with a dependency that resolves.
  const listDir = newListDir();
  writeConfig(listDir, gateThenAssignConfig('drop'));
  seedGateRecords(listDir, [{ _row_id: 'keeper', business_name: 'Keeper', quality: 'good' }]);

  await runPipelineDataflow({ listDir });

  const state = readRecords(listDir);
  assert.equal(state.eventFor('keeper', 'quality_gate')?.passed, 1);
  assert.equal(state.eventFor('keeper', 'route_after_gate')?.passed, 1);
  assert.equal(state.byId.get('keeper').sequence_name, 'qualified');
});

// ---------------------------------------------------------------------------
// D. `when` predicates
// ---------------------------------------------------------------------------

test('when: a non-matching record is skipped without erroring, dropping, or stranding downstream', async () => {
  const listDir = newListDir();
  writeConfig(listDir, `${CONFIG_PREAMBLE}
pipeline:
  - kind: filter
    id: quality_gate
    type: field_check
    inputs: [quality, evaluate_gate]
    when:
      match: all
      conditions:
        - field: evaluate_gate
          operator: eq
          value: yes
    match: all
    conditions:
      - field: quality
        operator: eq
        value: good
    on_fail: drop
  - kind: assign
    id: route_after_gate
    target: sequence_name
    fallback: holding
    depends_on: [quality_gate]
    inputs: [quality, sequence_status]
    rules:
      - sequence: qualified
        conditions:
          - field: quality
            operator: eq
            value: good
`);
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: ['quality', 'evaluate_gate'] });
  // Would fail the gate outright, but `when` says do not evaluate it here.
  upsertRecord({ db, row: { _row_id: 'not_evaluated', business_name: 'Skipped', quality: 'bad', evaluate_gate: 'no' } });
  // Same failing quality, but `when` matches — this one is genuinely dropped.
  upsertRecord({ db, row: { _row_id: 'evaluated', business_name: 'Evaluated', quality: 'bad', evaluate_gate: 'yes' } });
  db.close();

  await runPipelineDataflow({ listDir });

  const state = readRecords(listDir);
  const skipped = state.byId.get('not_evaluated');

  // Skipped means: passes the gate as a non-event, in play, unflagged.
  const gateEvent = state.eventFor('not_evaluated', 'quality_gate');
  assert.equal(gateEvent?.passed, 1);
  assert.match(String(gateEvent?.reason || ''), /^skipped:/);
  assert.equal(String(skipped.disqualified_at || ''), '');
  assert.deepEqual(pipelineFlags(skipped), []);

  // No error surface, and the dependent still ran — a `when` skip resolves.
  assert.equal(state.eventFor('not_evaluated', 'route_after_gate')?.passed, 1);
  assert.equal(skipped.sequence_name, 'holding');

  // The record the predicate DID select is dropped, proving the skip is a skip
  // and not the gate quietly passing everything.
  assert.notEqual(String(state.byId.get('evaluated').disqualified_at || ''), '');
});
