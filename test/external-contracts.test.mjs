import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openListDb, upsertRecord, ensureRecordColumns } from '../dist/orchestrator/runtime/db.js';
import { ingestExternalEvents, listExternalEvents, resolveExternalEvent, consumeExternalEvent } from '../dist/orchestrator/runtime/external-events.js';
import { listExternalOperations, reconcileExternalOperation, externalOperationEnv } from '../dist/orchestrator/runtime/external-operations.js';
import { executeStepBatch } from '../dist/orchestrator/pipeline/step-executor.js';
import { runPipelineDataflow } from '../dist/orchestrator/pipeline/dataflow.js';
import { getPipelineForViz, getPipelineStepRecordsForViz } from '../dist/viz/data.js';
import { normalizeConfig } from '../dist/schemas/config.js';

const wait = { kind: 'await_event', id: 'response', source: 'external', event: 'result_ready', reference_field: 'receipt_ref', inputs: ['receipt_ref'],
  output_map: { result_text: 'value' }, outputs: { result_text: { type: 'string', description: 'External result' } } };
const effect = { kind: 'action', id: 'external_capability', side_effecting: true, idempotency: { key_source: ['_row_id'] },
  tool: { server: 'arbitrary_service', tools: ['EXECUTE'], effect: { class: 'external_mutation' } },
  output_map: { receipt_ref: 'reference' }, outputs: { receipt_ref: { type: 'string', description: 'Opaque external reference' } }, inputs: [] };
const harness = (t) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-external-contract-'));
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: ['receipt_ref'] });
  upsertRecord({ db, row: { _row_id: 'record-1', business_name: 'Example', receipt_ref: 'opaque-1' } });
  const config = { pipeline: [effect, { ...wait, depends_on: ['external_capability'] }] };
  writeFileSync(join(listDir, 'outbound.yaml'), JSON.stringify(config));
  t.after(() => { db.close(); rmSync(listDir, { recursive: true, force: true }); });
  return { db, listDir, config };
};
const event = (id, reference = 'opaque-1') => ({ source: 'external', id, type: 'result_ready', reference,
  occurred_at: '2026-01-01T12:00:00.000Z', data: { value: 'provider-neutral result' } });

test('first-class actions and event waits validate without models or provider configuration', () => {
  const normalized = normalizeConfig({ pipeline: [effect, wait] });
  assert.deepEqual(normalized.errors, []);
  assert.equal(normalized.config.pipeline[0].concurrency, 4);
  assert.ok(normalizeConfig({ pipeline: [{ ...effect, side_effecting: false }] }).errors.length);
  assert.ok(normalizeConfig({ pipeline: [{ ...effect, concurrency: 0 }] }).errors.length);
  const missing = { ...effect }; delete missing.idempotency;
  assert.ok(normalizeConfig({ pipeline: [missing] }).errors.length);
});
test('event ingest deduplicates identical envelopes and rejects conflicting reuse atomically', (t) => {
  const h = harness(t);
  assert.equal(ingestExternalEvents({ ...h, events: [event('one')] }).events[0].status, 'matched');
  assert.equal(ingestExternalEvents({ ...h, events: [event('one')] }).events[0].duplicate, true);
  assert.throws(() => ingestExternalEvents({ ...h, events: [event('new'), { ...event('one'), data: { value: 'conflict' } }] }), /Conflicting/);
  assert.equal(listExternalEvents(h.db).length, 1);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM channel_events').get().n, 0);
});
test('event ingress has no automatic reply or commercial policy side effects', (t) => {
  const h = harness(t); ingestExternalEvents({ ...h, events: [event('one')] });
  const row = h.db.prepare('SELECT * FROM records').get();
  assert.equal(row.sequence_status, 'idle'); assert.equal(row.suppressed, 0);
  assert.equal(row.email_last_reply_at, '');
});
test('unmatched and ambiguous references require explicit review without guessing', (t) => {
  const h = harness(t);
  assert.equal(ingestExternalEvents({ ...h, events: [event('missing', 'unknown')] }).events[0].status, 'unmatched');
  upsertRecord({ db: h.db, row: { _row_id: 'record-2', receipt_ref: 'opaque-1' } });
  assert.equal(ingestExternalEvents({ ...h, events: [event('ambiguous')] }).events[0].status, 'ambiguous');
  resolveExternalEvent({ ...h, source: 'external', id: 'ambiguous', recordId: 'record-1' });
  assert.equal(listExternalEvents(h.db).find((e) => e.event_id === 'ambiguous').record_id, 'record-1');
});
test('await_event parks, binds declared outputs, and replays consumption after a simulated crash', (t) => {
  const h = harness(t); const record = h.db.prepare('SELECT * FROM records').get();
  assert.equal(consumeExternalEvent({ ...h, step: wait, record }).parked, true);
  ingestExternalEvents({ ...h, events: [event('one')] });
  assert.equal(consumeExternalEvent({ ...h, step: wait, record }).passed, true);
  h.db.prepare("UPDATE records SET result_text = ''").run();
  assert.equal(consumeExternalEvent({ ...h, step: wait, record }).passed, true);
  assert.equal(h.db.prepare('SELECT result_text FROM records').get().result_text, 'provider-neutral result');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM external_event_consumptions').get().n, 1);
});
test('events arriving before references are re-correlated when the graph reaches a wait', (t) => {
  const h = harness(t); h.db.prepare("UPDATE records SET receipt_ref = ''").run();
  assert.equal(ingestExternalEvents({ ...h, events: [event('early')] }).events[0].status, 'unmatched');
  h.db.prepare("UPDATE records SET receipt_ref = 'opaque-1'").run();
  assert.equal(consumeExternalEvent({ ...h, step: wait, record: h.db.prepare('SELECT * FROM records').get() }).passed, true);
});
test('actions expose a stable opaque operation key and do not execute twice', async (t) => {
  const h = harness(t); const calls = [];
  const step = { ...effect, __tryTool: async () => { calls.push(externalOperationEnv()); return { result: { reference: 'new-reference' } }; } };
  const row = () => h.db.prepare('SELECT * FROM records').get();
  const first = (await executeStepBatch(h, step, effect.id, [row()])).get('record-1');
  const second = (await executeStepBatch(h, step, effect.id, [row()])).get('record-1');
  assert.equal(first.passed, true); assert.equal(second.executed, false); assert.equal(calls.length, 1);
  assert.match(calls[0].AO_OPERATION_KEY, /^[a-f0-9]{64}$/);
  assert.equal(calls[0].AO_RECORD_ID, 'record-1');
  assert.equal(listExternalOperations(h.db)[0].state, 'completed');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM channel_events').get().n, 0);
});
test('actions bound record-level external work by configured concurrency', async (t) => {
  const h = harness(t);
  const baseRecord = h.db.prepare('SELECT * FROM records WHERE _row_id = ?').get('record-1');
  const records = Array.from({ length: 6 }, (_, index) => ({
    ...baseRecord,
    _row_id: `record-${index + 1}`,
    business_name: `Record ${index + 1}`,
  }));
  records.forEach((record) => upsertRecord({ db: h.db, row: record }));
  const state = { inFlight: 0, maximum: 0, completed: 0 };
  const step = {
    ...effect,
    concurrency: 2,
    __tryTool: async () => {
      state.inFlight += 1;
      state.maximum = Math.max(state.maximum, state.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      state.inFlight -= 1;
      state.completed += 1;
      return { result: { reference: `receipt-${state.completed}` } };
    },
  };
  const rows = h.db.prepare('SELECT * FROM records ORDER BY _row_id').all();

  const outcomes = await executeStepBatch(h, step, step.id, rows);

  assert.equal(state.maximum, 2);
  assert.equal(state.completed, 6);
  assert.equal([...outcomes.values()].filter((outcome) => outcome.passed).length, 6);
});
test('unknown effect outcome blocks retries and a generic receipt restores outputs', async (t) => {
  const h = harness(t); const state = { calls: 0 };
  const step = { ...effect, __tryTool: async () => { state.calls += 1; throw new Error('response lost after external commit'); } };
  const record = h.db.prepare('SELECT * FROM records').get();
  assert.equal((await executeStepBatch(h, step, effect.id, [record])).get('record-1').passed, false);
  assert.equal((await executeStepBatch(h, step, effect.id, [record])).get('record-1').passed, false);
  assert.equal(state.calls, 1);
  const op = listExternalOperations(h.db)[0]; assert.equal(op.state, 'uncertain');
  const unknown = reconcileExternalOperation({ ...h, receipt: { operation_key: op.operation_key, status: 'unknown' } });
  assert.equal(unknown.reconciled, false);
  const receipt = { operation_key: op.operation_key, status: 'succeeded', outputs: { receipt_ref: 'reconciled-reference' } };
  assert.equal(reconcileExternalOperation({ ...h, receipt }).reconciled, true);
  assert.equal(h.db.prepare('SELECT receipt_ref FROM records').get().receipt_ref, 'reconciled-reference');
  assert.equal(reconcileExternalOperation({ ...h, receipt }).reconciled, false);
  assert.throws(() => reconcileExternalOperation({ ...h, receipt: { ...receipt, outputs: { receipt_ref: 'different' } } }), /conflicts/);
});

const deferredAction = {
  kind: 'action',
  id: 'paced_action',
  side_effecting: true,
  idempotency: { key_source: ['_row_id'] },
  tool: { server: 'deferred_command', tools: ['ACT'], effect: { class: 'external_mutation' } },
  output_map: { receipt_ref: 'reference' },
  outputs: { receipt_ref: { type: 'string', description: 'Opaque external reference' } },
  inputs: [],
};

const deferredHarness = (t, firstResult) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-deferred-action-'));
  const server = `deferred_command_${listDir.split('-').at(-1)}`;
  const statePath = join(listDir, 'calls.txt');
  const scriptPath = join(listDir, 'deferred-tool.mjs');
  writeFileSync(scriptPath, `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const statePath = process.env.STATE_PATH;
const calls = existsSync(statePath) ? Number(readFileSync(statePath, 'utf8') || '0') : 0;
writeFileSync(statePath, String(calls + 1));
if (calls === 0 && process.env.FIRST_RESULT === '__EXIT__') process.exit(9);
console.log(calls === 0 ? process.env.FIRST_RESULT : JSON.stringify({ reference: 'completed-reference' }));
`);
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      [server]: {
        type: 'command', command: process.execPath, args: [scriptPath],
        env: { STATE_PATH: statePath, FIRST_RESULT: firstResult === '__EXIT__' ? '__EXIT__' : JSON.stringify(firstResult) },
        tools: [{ slug: 'ACT', invoke: { argv: [], result: 'stdout_json' } }],
      },
    },
  }));
  writeFileSync(join(listDir, 'outbound.yaml'), JSON.stringify({
    pipeline: [{ ...deferredAction, tool: { ...deferredAction.tool, server } }, { kind: 'wait', id: 'dependent', depends_on: ['paced_action'], after: '1d' }],
  }));
  const step = { ...deferredAction, tool: { ...deferredAction.tool, server } };
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: ['receipt_ref'] });
  upsertRecord({ db, row: { _row_id: 'deferred-record', business_name: 'Deferred Co' } });
  db.close();
  t.after(() => rmSync(listDir, { recursive: true, force: true }));
  return { listDir, step, calls: () => Number(readFileSync(statePath, 'utf8') || '0') };
};

test('a deferred action releases its claim, writes nothing, holds dependents, and retries successfully', async (t) => {
  const h = deferredHarness(t, { ao_outcome: 'deferred', reason: 'daily pacing limit', retry_after: '2026-01-02T00:00:00.000Z' });
  const first = await runPipelineDataflow({ listDir: h.listDir, clock: '2026-01-01T00:00:00.000Z' });
  const beforeRetry = await runPipelineDataflow({ listDir: h.listDir, clock: '2026-01-01T12:00:00.000Z' });
  const second = await runPipelineDataflow({ listDir: h.listDir, clock: '2026-01-02T00:00:00.000Z' });
  const db = openListDb({ listDir: h.listDir, readonly: true });
  try {
    assert.equal(first.deferred, 1, JSON.stringify(first));
    assert.equal(first.errored, 0);
    assert.equal(beforeRetry.deferred, 1);
    assert.equal(beforeRetry.errored, 0);
    assert.equal(h.calls(), 2, 'the tool runs once initially and once after retry_after');
    assert.equal(second.deferred, 0);
    assert.equal(db.prepare('SELECT receipt_ref FROM records').get().receipt_ref, 'completed-reference');
    assert.equal(db.prepare('SELECT status FROM idempotency').get().status, 'sent');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM errored_events WHERE step_id = 'paced_action'").get().n, 0);
    assert.equal(getPipelineForViz(h.listDir).nodes.find((node) => node.id === 'paced_action').counts.deferred, 0);
  } finally { db.close(); }
});

test('a deferred action is visible as deferred before its retry and does not run dependents', async (t) => {
  const h = deferredHarness(t, { ao_outcome: 'deferred', reason: 'daily pacing limit' });
  const summary = await runPipelineDataflow({ listDir: h.listDir, clock: '2026-01-01T00:00:00.000Z' });
  const db = openListDb({ listDir: h.listDir, readonly: true });
  try {
    assert.equal(summary.deferred, 1, JSON.stringify(summary));
    assert.equal(summary.errored, 0);
    assert.equal(h.calls(), 1);
    assert.deepEqual(db.prepare('SELECT receipt_ref FROM records').get(), { receipt_ref: '' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM idempotency').get().n, 0);
    assert.deepEqual(db.prepare("SELECT status, message FROM run_state ORDER BY started_at DESC LIMIT 1").get(), {
      status: 'incomplete',
      message: 'Pipeline incomplete · 0 errored records need retry · 0 awaiting review · 1 deferred',
    });
    assert.deepEqual(getPipelineStepRecordsForViz(h.listDir, 'paced_action', 'deferred').records.map((record) => record._row_id), ['deferred-record']);
    assert.equal(getPipelineForViz(h.listDir).nodes.find((node) => node.id === 'paced_action').counts.errored, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pipeline_events WHERE step_id = 'dependent' AND passed = 1").get().n, 0);
  } finally { db.close(); }
});

for (const [label, firstResult] of [
  ['malformed deferred result', { ao_outcome: 'deferred' }],
  ['unknown ao_outcome', { ao_outcome: 'later', reason: 'not accepted' }],
  ['deferred result with output', { ao_outcome: 'deferred', reason: 'daily pacing limit', reference: 'must-not-write' }],
  ['non-zero command exit', '__EXIT__'],
]) {
  test(`${label} becomes uncertain`, async (t) => {
    const h = deferredHarness(t, firstResult);
    const db = openListDb({ listDir: h.listDir, readonly: false });
    try {
      const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('deferred-record');
      const outcome = (await executeStepBatch({ db, listDir: h.listDir, config: { pipeline: [h.step] } }, h.step, h.step.id, [record])).get('deferred-record');
      assert.equal(outcome.errored, true);
      const claim = db.prepare('SELECT status FROM idempotency').get();
      assert.equal(claim.status, 'uncertain');
      assert.match(String(outcome.reason), /ao_outcome|Deferred action result|exited with 9/);
    } finally { db.close(); }
  });
}
