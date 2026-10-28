import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const event = (id, minute, data = {}) => ({ id, source: 'fixture', type: 'inbound', reference: 'conversation-1', occurred_at: `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`, data });
const runCli = (args) => {
  const run = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, `agent-outbound ${args.join(' ')} failed:\n${run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout);
};
const readLines = (path) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const actionStep = (id = 'send') => ({ kind: 'action', id, inputs: ['inbound_text', 'edited_value', '_ao_turn_id'], side_effecting: true, idempotency: { key_source: ['_ao_turn_id'], scope: 'list' }, tool: { server: 'counter', tools: ['COUNT'], effect: { class: 'external_mutation' } }, args_map: { reply: 'inbound_text', edited: 'edited_value' } });

const createList = (t, { steps, onNewEvent, until } = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-on-event-turn-'));
  const counterPath = join(listDir, 'counter.jsonl');
  const scriptPath = join(listDir, 'counter.mjs');
  writeFileSync(scriptPath, `
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const counterPath = process.env.AO_TURN_COUNTER;
const calls = existsSync(counterPath) ? readFileSync(counterPath, 'utf8').trim().split('\\n').filter(Boolean) : [];
appendFileSync(counterPath, JSON.stringify({ operation_key: process.env.AO_OPERATION_KEY || '', reply: process.argv[2] || '', edited: process.argv[3] || '' }) + '\\n');
if (process.env.AO_TURN_FAIL_ONCE === '1' && calls.length === 0) process.exit(1);
process.stdout.write(JSON.stringify({ ok: true, enriched: 'yes' }));
`);
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: { counter: { type: 'command', command: process.execPath, args: [scriptPath], env: { AO_TURN_COUNTER: counterPath }, tools: [{ slug: 'COUNT', input_schema: { type: 'object', properties: { reply: { type: 'string' }, edited: { type: 'string' } } }, invoke: { argv: ['{{reply}}', '{{edited}}'], result: 'stdout_json' } }] } } }));
  const block = { kind: 'on_event', id: 'message_turn', source: 'fixture', event: 'inbound', reference_field: 'conversation_ref', event_fields: { inbound_text: 'text', remaining: 'remaining' }, steps: steps || [{ kind: 'filter', id: 'accept', type: 'field_check', conditions: [] }, { ...actionStep(), depends_on: ['accept'] }], ...(onNewEvent ? { on_new_event: onNewEvent } : {}), ...(until ? { until } : {}) };
  writeFileSync(join(listDir, 'outbound.yaml'), JSON.stringify({ ai: { defaults: { research: 'openai/gpt-4o-mini' } }, pipeline: [block] }));
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: ['conversation_ref', 'confidence', 'edited_value'] });
  upsertRecord({ db, row: { _row_id: 'record-1', business_name: 'Example', conversation_ref: 'conversation-1', confidence: 0.9 } });
  db.close();
  t.after(() => rmSync(listDir, { recursive: true, force: true }));
  return { listDir, counterPath };
};
const ingest = (listDir, events) => { const file = join(listDir, `events-${Math.random()}.json`); writeFileSync(file, JSON.stringify(events)); return runCli(['events', 'ingest', listDir, '--file', file]); };
const pipeline = (listDir) => runCli(['pipeline', listDir]);

test('two event turns run each inner step once, retain distinct operation keys, and until ignores the third event', (t) => {
  const { listDir, counterPath } = createList(t, { until: { conditions: [{ field: 'remaining', operator: 'lt', value: 1 }] } });
  const ingested = ingest(listDir, [event('event-2', 2, { text: 'second', remaining: 0 }), event('event-1', 1, { text: 'first', remaining: 2 })]);
  assert.deepEqual(ingested.result.record_ids, ['record-1']);
  pipeline(listDir); pipeline(listDir);
  assert.equal(readLines(counterPath).length, 2, JSON.stringify(runCli(['turns', listDir]).result));
  ingest(listDir, [event('event-3', 3, { text: 'third', remaining: 0 })]); pipeline(listDir);
  const turns = runCli(['turns', listDir, '--record', 'record-1']).result.turns;
  assert.deepEqual(turns.map(({ turn_index, event_id, status }) => ({ turn_index, event_id, status })), [{ turn_index: 1, event_id: 'event-1', status: 'completed' }, { turn_index: 2, event_id: 'event-2', status: 'completed' }, { turn_index: 3, event_id: 'event-3', status: 'ignored' }]);
  assert.ok(turns.slice(0, 2).every((turn) => turn.steps.every((step) => step.status === 'passed')));
  const calls = readLines(counterPath);
  assert.notEqual(calls[0].operation_key, calls[1].operation_key);
});

for (const onNewEvent of ['supersede', 'queue']) test(`${onNewEvent} handles a new event while an inner review is parked`, (t) => {
  const { listDir, counterPath } = createList(t, { onNewEvent, steps: [{ kind: 'review', id: 'human_gate', edit_fields: ['edited_value'] }, { ...actionStep(), depends_on: ['human_gate'] }] });
  ingest(listDir, [event('event-1', 1, { text: 'first' })]); pipeline(listDir);
  ingest(listDir, [event('event-2', 2, { text: 'second' })]); pipeline(listDir);
  const beforeApproval = runCli(['turns', listDir]).result.turns;
  if (onNewEvent === 'supersede') {
    assert.equal(beforeApproval[0].status, 'superseded'); assert.equal(beforeApproval[1].status, 'open'); assert.equal(readLines(counterPath).length, 0);
  } else { assert.equal(beforeApproval.length, 1); assert.equal(beforeApproval[0].status, 'open'); }
  const reviewList = runCli(['review', 'list', listDir, '--stage', 'human_gate']).result;
  assert.equal(reviewList.records[0]._turn_index, onNewEvent === 'supersede' ? 2 : 1);
  runCli(['review', 'approve', listDir, 'record-1', '--stage', 'human_gate', '--set', 'edited_value=approved']); pipeline(listDir);
  if (onNewEvent === 'queue') { pipeline(listDir); runCli(['review', 'approve', listDir, 'record-1', '--stage', 'human_gate']); pipeline(listDir); }
  const turns = runCli(['turns', listDir]).result.turns;
  assert.ok(onNewEvent === 'supersede'
    ? turns[0].status === 'superseded' && turns[1].status === 'completed'
    : turns.every((turn) => turn.status === 'completed'));
  assert.equal(readLines(counterPath).length, onNewEvent === 'supersede' ? 1 : 2);
  assert.ok(readLines(counterPath).every((call) => call.edited === 'approved'));
});

test('an inner review honors when, accepts edit_fields on approval, and reject stops later steps', (t) => {
  const { listDir, counterPath } = createList(t, { steps: [{ kind: 'review', id: 'confidence_gate', when: { conditions: [{ field: 'confidence', operator: 'lt', value: 0.8 }] }, edit_fields: ['edited_value'] }, { ...actionStep(), depends_on: ['confidence_gate'] }] });
  ingest(listDir, [event('high', 1, { text: 'high' })]); pipeline(listDir); assert.equal(readLines(counterPath).length, 1);
  {
    const db = openListDb({ listDir, readonly: false });
    upsertRecord({ db, row: { ...db.prepare('SELECT * FROM records WHERE _row_id = ?').get('record-1'), confidence: 0.4 } });
    db.close();
  }
  ingest(listDir, [event('low', 2, { text: 'low' })]); pipeline(listDir);
  assert.equal(runCli(['review', 'list', listDir, '--stage', 'confidence_gate']).result.records[0]._turn_index, 2);
  runCli(['review', 'approve', listDir, 'record-1', '--stage', 'confidence_gate', '--set', 'edited_value=human-edited']); pipeline(listDir);
  assert.equal(readLines(counterPath)[1].edited, 'human-edited');
  ingest(listDir, [event('reject', 3, { text: 'reject' })]); pipeline(listDir);
  runCli(['review', 'reject', listDir, 'record-1', '--stage', 'confidence_gate', '--reason', 'no']); pipeline(listDir);
  assert.equal(readLines(counterPath).length, 2, 'a rejected review must not run dependent actions');
  {
    const db = openListDb({ listDir, readonly: true });
    try { assert.equal(db.prepare("SELECT status FROM event_turns WHERE event_id = 'reject'").get().status, 'completed'); } finally { db.close(); }
  }
});

test('a when-skipped inner action is reported as skipped and does not invoke its tool', (t) => {
  const action = actionStep('gated_send');
  const { listDir, counterPath } = createList(t, { steps: [{ ...action, inputs: [...action.inputs, 'confidence'], when: { conditions: [{ field: 'confidence', operator: 'lt', value: 0.8 }] } }] });
  ingest(listDir, [event('high-confidence', 1, { text: 'do not send' })]); pipeline(listDir);
  const turns = runCli(['turns', listDir]).result.turns;
  assert.deepEqual(turns[0].steps.map(({ step_id, status }) => ({ step_id, status })), [{ step_id: 'gated_send', status: 'skipped' }]);
  assert.equal(readLines(counterPath).length, 0);
});

test('an errored inner tool step retries and completes on the next pipeline run', (t) => {
  const { listDir, counterPath } = createList(t, { steps: [{ kind: 'enrich', id: 'flaky', action: 'tool_call', tool: { server: 'counter', tools: ['COUNT'], effect: { class: 'data_lookup' } }, output_map: { enriched: 'enriched' }, outputs: { enriched: { type: 'string', description: 'Fixture output' } } }] });
  const mcpPath = join(listDir, 'mcp.json'); const mcp = JSON.parse(readFileSync(mcpPath, 'utf8')); mcp.mcpServers.counter.env.AO_TURN_FAIL_ONCE = '1'; writeFileSync(mcpPath, JSON.stringify(mcp));
  ingest(listDir, [event('flaky', 1, { text: 'retry' })]); pipeline(listDir); pipeline(listDir);
  assert.equal(readLines(counterPath).length, 2, JSON.stringify(runCli(['turns', listDir]).result));
  const turns = runCli(['turns', listDir]).result.turns;
  assert.equal(turns[0].status, 'completed'); assert.equal(turns[0].steps[0].status, 'passed');
});
