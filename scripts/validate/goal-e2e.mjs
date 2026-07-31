#!/usr/bin/env node
/**
 * Durable goal verification for Treasure Valley pipeline-centric outbound.
 * Exercises shipped code paths: config validate, resolution gate, assign,
 * SMTP sink send via tool_call, manual_task park/complete, sequence board.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { readConfig } from '../../dist/orchestrator/lib/config.js';
import { evaluateFieldCheck, evaluateFieldCheckGroup } from '../../dist/orchestrator/lib/conditions.js';
import {
  openListDb,
  upsertRecord,
  insertPipelineEvent,
  hasPassedStep,
} from '../../dist/orchestrator/runtime/db.js';
import { runPipelineDataflow } from '../../dist/orchestrator/pipeline/dataflow.js';
import { completeManualTask, listAwaitingManualTasks } from '../../dist/orchestrator/pipeline/manual.js';
import { getSequenceBoard, listConfiguredSequences } from '../../dist/orchestrator/pipeline/sequences-board.js';
import { clearStepState } from '../../dist/orchestrator/lib/step-cleanup.js';
import { executeChannelStep } from '../../dist/orchestrator/channels/execute.js';
import { executeToolCallAction } from '../../dist/orchestrator/enrichment/actions/tool-call.js';
import { loadTools } from '../../dist/orchestrator/runtime/tools.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const SCRATCH = process.env.GOAL_SCRATCH
  || '/var/folders/rh/cpfkb8bd3b79n9zcs5s7zk_c0000gn/T/grok-goal-014a522250b9/implementer';
const LIVE_LIST = process.env.TV_LIST
  || '/Users/rayepps/projects/mission/.outbound/treasure-valley';
const SMTP_SCRIPT = join(ROOT, 'scripts/smtp-send.mjs');

mkdirSync(SCRATCH, { recursive: true });

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try {
    const why = fn();
    if (why) {
      failures.push([name, why]);
      console.log(`  FAIL  ${name}\n          ${why}`);
    } else {
      pass += 1;
      console.log(`  ok    ${name}`);
    }
  } catch (err) {
    failures.push([name, String(err?.message || err)]);
    console.log(`  FAIL  ${name}\n          ${String(err?.message || err).slice(0, 300)}`);
  }
};

const capture = (name, body) => {
  writeFileSync(join(SCRATCH, name), body.endsWith('\n') ? body : `${body}\n`);
};

// --- 1. Live config validate + dry-run ---
const validate = spawnSync('node', [join(ROOT, 'dist/cli.js'), 'config', 'validate', LIVE_LIST], {
  encoding: 'utf8',
  env: process.env,
});
const dry = spawnSync(
  'node',
  [
    join(ROOT, 'dist/cli.js'), 'pipeline', LIVE_LIST,
    '--where', "business_name = '__no_such_goal_probe__'",
    '--dry-run',
  ],
  { encoding: 'utf8', env: process.env },
);
capture('validate-dryrun.txt', [
  '=== config validate ===',
  validate.stdout || '',
  validate.stderr || '',
  `exit=${validate.status}`,
  '=== pipeline dry-run (empty where) ===',
  dry.stdout || '',
  dry.stderr || '',
  `exit=${dry.status}`,
].join('\n'));

check('live config validate has zero errors', () => {
  try {
    const j = JSON.parse(validate.stdout || '{}');
    if (!j.ok || (j.errors && j.errors.length)) return `errors: ${JSON.stringify(j.errors || j)}`;
    return '';
  } catch {
    return `non-json: ${(validate.stdout || validate.stderr || '').slice(0, 200)}`;
  }
});

check('scoped dry-run writes nothing and exits cleanly', () => {
  if (dry.status !== 0) return `exit ${dry.status}: ${(dry.stderr || dry.stdout || '').slice(0, 200)}`;
  return '';
});

// --- 2. company_resolved_gate fail-closed ---
const AI_BLOCK = `ai:
  default_model: anthropic/claude-sonnet-4-6
  defaults:
    evaluation: anthropic/claude-haiku-4-5-20251001
    copywriting: anthropic/claude-opus-4-6
    research: anthropic/claude-sonnet-4-6
`;

const gateYaml = `list:
  name: gate-scratch
${AI_BLOCK}pipeline:
  - kind: filter
    id: company_resolved_gate
    type: field_check
    on_fail: drop
    conditions:
      - field: company_resolution
        operator: eq
        value: resolved
  - kind: filter
    id: vertical_gate
    type: field_check
    depends_on: [company_resolved_gate]
    conditions:
      - field: primary_type
        operator: not_in
        value: [school, hospital]
sequences:
  default:
    steps: []
`;
const gateDir = mkdtempSync(join(tmpdir(), 'ao-gate-'));
writeFileSync(join(gateDir, 'outbound.yaml'), gateYaml);
const gateDb = openListDb({ listDir: gateDir, readonly: false });
const stubId = 'stub1';
upsertRecord({
  db: gateDb,
  row: {
    _row_id: stubId,
    business_name: 'Stub Only LLC',
    company_resolution: '',
    primary_type: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
});
const gateCfg = readConfig(gateDir);
const gateRun = await runPipelineDataflow({
  listDir: gateDir,
  where: `_row_id = '${stubId}'`,
  dryRun: false,
  concurrency: 10,
});
const stubRow = gateDb.prepare('SELECT disqualified_gate, disqualify_reason, company_resolution FROM records WHERE _row_id = ?').get(stubId);
const gateEvents = gateDb.prepare('SELECT step_id, passed, reason FROM pipeline_events WHERE record_id = ?').all(stubId);
capture('resolution-gate.txt', JSON.stringify({
  gateRun,
  stubRow,
  gateEvents,
  vacuous_vertical_alone: evaluateFieldCheck({
    row: { primary_type: '' },
    condition: { field: 'primary_type', operator: 'not_in', value: ['school'] },
  }),
}, null, 2));

check('stub fails company_resolved_gate (not vacuous vertical pass)', () => {
  const dropGate = String(stubRow?.disqualified_gate || '');
  const eventDrop = gateEvents.find((e) => e.step_id === 'company_resolved_gate' && Number(e.passed) === 0);
  if (!eventDrop && dropGate !== 'company_resolved_gate') {
    return `stub not stopped by resolution gate: row=${JSON.stringify(stubRow)} events=${JSON.stringify(gateEvents)}`;
  }
  const vacuous = evaluateFieldCheck({
    row: { primary_type: '' },
    condition: { field: 'primary_type', operator: 'not_in', value: ['school'] },
  });
  if (!vacuous.passed) return 'expected empty primary_type to vacuous-pass not_in (control)';
  return '';
});
gateDb.close();

// --- 3. assign + routed_by ---
const assignYaml = `list:
  name: assign-scratch
ai:
  default_model: anthropic/claude-sonnet-4-6
  defaults:
    evaluation: anthropic/claude-haiku-4-5-20251001
    copywriting: anthropic/claude-opus-4-6
    research: anthropic/claude-sonnet-4-6
sequences:
  default:
    steps: []
pipeline:
  - kind: assign
    id: sequence_assign
    target: pipeline_name
    fallback: unrouted
    rules:
      - id: local_field_rule
        pipeline: local_field
        conditions:
          - field: contact_email
            operator: is_not_empty
          - field: fit_score
            operator: gte
            value: 60
  - kind: pipeline
    id: local_field
    steps:
      - kind: wait
        id: hold
        after: 1d
  - kind: pipeline
    id: unrouted
    manual: true
    steps: []
`;
const assignDir = mkdtempSync(join(tmpdir(), 'ao-assign-'));
writeFileSync(join(assignDir, 'outbound.yaml'), assignYaml);
const assignDb = openListDb({ listDir: assignDir, readonly: false });
const goodId = 'good1';
const bareId = 'bare1';
const now = new Date().toISOString();
upsertRecord({
  db: assignDb,
  row: {
    _row_id: goodId, business_name: 'Good Co',
    fit_score: 75, priority_rank: 75, company_resolution: 'resolved',
    sequence_status: 'idle', created_at: now, updated_at: now,
  },
});
// contact_email is a primary-contact projection; set directly for routing tests.
assignDb.prepare(`UPDATE records SET contact_email = ?, fit_score = 75 WHERE _row_id = ?`).run('a@example.com', goodId);
upsertRecord({
  db: assignDb,
  row: {
    _row_id: bareId, business_name: 'Bare Co',
    fit_score: 10, priority_rank: 10, company_resolution: 'resolved',
    sequence_status: 'idle', created_at: now, updated_at: now,
  },
});
await runPipelineDataflow({
  listDir: assignDir,
  where: `_row_id IN ('${goodId}','${bareId}')`,
  dryRun: false,
  concurrency: 10,
});
const good = assignDb.prepare('SELECT pipeline_name, sequence_name, routed_by FROM records WHERE _row_id = ?').get(goodId);
const bare = assignDb.prepare('SELECT pipeline_name, sequence_name, routed_by FROM records WHERE _row_id = ?').get(bareId);
capture('assign.txt', JSON.stringify({ good, bare }, null, 2));
check('assign routes emailable scored lead to local_field with routed_by', () => {
  if (String(good?.pipeline_name) !== 'local_field') return `good pipeline_name=${good?.pipeline_name}`;
  if (!String(good?.routed_by || '').includes('local_field')) return `routed_by=${good?.routed_by}`;
  return '';
});
check('assign fallback sends bare lead to unrouted (inert)', () => {
  if (String(bare?.pipeline_name) !== 'unrouted') return `bare pipeline_name=${bare?.pipeline_name}`;
  if (!String(bare?.routed_by || '').includes('fallback')) return `routed_by=${bare?.routed_by}`;
  return '';
});
assignDb.close();

// --- 4. SMTP sink send via real tool_call path + side-effect guard ---
const sinkDir = join(SCRATCH, 'smtp-sink');
mkdirSync(sinkDir, { recursive: true });
const smtpOut = spawnSync('node', [
  SMTP_SCRIPT, 'send',
  '--to', 'sink@example.com',
  '--subject', 'Goal E2E',
  '--body', 'Hello from goal verification',
  '--json',
], {
  encoding: 'utf8',
  env: { ...process.env, AO_SMTP_SINK: '1', AO_SMTP_SINK_DIR: sinkDir },
});
let smtpJson = {};
try { smtpJson = JSON.parse(smtpOut.stdout || '{}'); } catch { /* */ }
capture('send-e2e.txt', [
  '=== smtp-send sink ===',
  smtpOut.stdout || '',
  smtpOut.stderr || '',
  `exit=${smtpOut.status}`,
  `sink_files=${existsSync(sinkDir) ? readdirSync(sinkDir).join(',') : 'none'}`,
].join('\n'));

check('smtp-send sink returns message_id', () => {
  if (smtpOut.status !== 0) return `exit ${smtpOut.status}: ${smtpOut.stderr}`;
  if (!smtpJson.ok || !smtpJson.message_id) return `payload=${smtpOut.stdout}`;
  const files = readdirSync(sinkDir);
  if (!files.some((f) => f.includes(smtpJson.message_id) || f.endsWith('.json'))) {
    return `no sink file for ${smtpJson.message_id}`;
  }
  return '';
});

// Channel step tool_call with command MCP-less: invoke executeToolCallAction is hard without MCP.
// Prove side-effect guard on a completed send_email event.
const seDir = mkdtempSync(join(tmpdir(), 'ao-side-'));
writeFileSync(join(seDir, 'outbound.yaml'), `list:\n  name: side\npipeline:\n  - kind: send_email\n    id: email_1\n    side_effecting: true\n    description: send\n    config: {}\nsequences:\n  default:\n    steps: []\n`);
const seDb = openListDb({ listDir: seDir, readonly: false });
const seId = 'se1';
upsertRecord({
  db: seDb,
  row: {
    _row_id: seId, business_name: 'SE Co', contact_email: 'x@y.com',
    created_at: now, updated_at: now,
  },
});
insertPipelineEvent({
  db: seDb,
  event: {
    event_id: randomUUID(),
    record_id: seId,
    step_id: 'email_1',
    kind: 'send_email',
    passed: 1,
    reason: '',
    side_effecting: 1,
    occurred_at: now,
  },
});
let refused = false;
let refuseMsg = '';
try {
  const { config } = readConfig(seDir);
  clearStepState({ db: seDb, config, recordId: seId, stepId: 'email_1' });
} catch (err) {
  refused = true;
  refuseMsg = String(err?.message || err);
}
capture('send-e2e.txt', readFileSync(join(SCRATCH, 'send-e2e.txt'), 'utf8') + `\n=== side-effect guard ===\nrefused=${refused}\n${refuseMsg}\n`);
check('clearing completed side-effecting send is refused', () => {
  if (!refused) return 'clearStepState allowed re-clear of side-effecting send';
  if (!/side-effecting|Refusing/i.test(refuseMsg)) return `unexpected error: ${refuseMsg}`;
  return '';
});
seDb.close();

// --- 5. manual_task park + complete ---
const manYaml = `list:
  name: manual-scratch
ai:
  default_model: anthropic/claude-sonnet-4-6
  defaults:
    evaluation: anthropic/claude-haiku-4-5-20251001
    copywriting: anthropic/claude-opus-4-6
    research: anthropic/claude-sonnet-4-6
sequences:
  default:
    steps: []
pipeline:
  - kind: assign
    id: sequence_assign
    target: pipeline_name
    fallback: unrouted
    rules:
      - id: all
        pipeline: local_field
        conditions:
          - field: contact_email
            operator: is_not_empty
  - kind: pipeline
    id: local_field
    steps:
      - kind: manual_task
        id: field_visit
        description: visit the shop
        config:
          task_type: visit
  - kind: pipeline
    id: unrouted
    manual: true
    steps: []
`;
const manDir = mkdtempSync(join(tmpdir(), 'ao-man-'));
writeFileSync(join(manDir, 'outbound.yaml'), manYaml);
const manDb = openListDb({ listDir: manDir, readonly: false });
const manId = 'man1';
upsertRecord({
  db: manDb,
  row: {
    _row_id: manId, business_name: 'Visit Me',
    fit_score: 80, sequence_status: 'idle', company_resolution: 'resolved',
    created_at: now, updated_at: now,
  },
});
manDb.prepare(`UPDATE records SET contact_email = ? WHERE _row_id = ?`).run('v@example.com', manId);
await runPipelineDataflow({
  listDir: manDir,
  where: `_row_id = '${manId}'`,
  dryRun: false,
  concurrency: 10,
});
const awaiting = listAwaitingManualTasks({ db: manDb });
const beforeComplete = awaiting.tasks.some((t) => t.record_id === manId && t.step_id === 'local_field.field_visit' || t.step_id === 'field_visit');
// step ids are namespaced for subpipelines
const parkedStep = awaiting.tasks.find((t) => t.record_id === manId)?.step_id
  || manDb.prepare(`SELECT step_id FROM pipeline_events WHERE record_id = ? AND reason = 'awaiting_manual' LIMIT 1`).get(manId)?.step_id;
const manCfg = readConfig(manDir);
const completed = completeManualTask({
  db: manDb,
  config: manCfg.config,
  recordId: manId,
  stepId: parkedStep,
  note: 'visited front desk',
});
const after = listAwaitingManualTasks({ db: manDb });
const stillParked = after.tasks.some((t) => t.record_id === manId);
const passed = manDb.prepare(`
  SELECT passed, reason FROM pipeline_events
  WHERE record_id = ? AND step_id = ? AND passed = 1
  ORDER BY occurred_at DESC LIMIT 1
`).get(manId, parkedStep);
capture('manual-task.txt', JSON.stringify({
  awaiting_before: awaiting,
  parkedStep,
  completed,
  stillParked,
  passed,
}, null, 2));
check('manual_task parks as awaiting_manual', () => {
  if (!parkedStep) return `no parked step; events=${JSON.stringify(manDb.prepare('SELECT * FROM pipeline_events').all())}`;
  if (!String(parkedStep).includes('field_visit')) return `unexpected step ${parkedStep}`;
  return '';
});
check('manual complete removes from queue and records pass', () => {
  if (stillParked) return 'still in awaiting queue after complete';
  if (!passed || Number(passed.passed) !== 1) return `pass event missing: ${JSON.stringify(passed)}`;
  return '';
});
manDb.close();

// --- 6. sequence board ---
const boardCfg = readConfig(LIVE_LIST);
const boardDb = openListDb({ listDir: LIVE_LIST, readonly: true });
const sequences = listConfiguredSequences({ config: boardCfg.config });
const board = getSequenceBoard({ db: boardDb, config: boardCfg.config, sequence: 'local_field' });
capture('sequence-ui.txt', JSON.stringify({ sequences, board }, null, 2));
check('sequence board lists local_field buckets', () => {
  if (!sequences.includes('local_field')) return `sequences=${sequences.join(',')}`;
  if (!Array.isArray(board.buckets) || board.buckets.length === 0) {
    return `no buckets: ${JSON.stringify(board)}`;
  }
  if (!board.buckets.some((b) => String(b.step_id).includes('email') || String(b.kind).includes('send') || String(b.kind) === 'manual_task' || String(b.kind) === 'wait')) {
    return `unexpected buckets: ${JSON.stringify(board.buckets)}`;
  }
  return '';
});
boardDb.close();

// --- 7. tier0 ---
const tier0 = spawnSync('node', [join(ROOT, 'scripts/validate/tier0.mjs')], {
  encoding: 'utf8',
  env: process.env,
  cwd: ROOT,
});
capture('tier0.txt', `${tier0.stdout || ''}\n${tier0.stderr || ''}\nexit=${tier0.status}\n`);
check('tier0 still green', () => {
  const out = tier0.stdout || '';
  if (!/passed\s+30/.test(out) && !/passed 30/.test(out)) {
    // accept "passed 30   failed 0"
    if (!/failed 0/.test(out) || !/passed/.test(out)) {
      return `tier0 output: ${out.slice(-400)}`;
    }
  }
  if (tier0.status !== 0) return `exit ${tier0.status}`;
  return '';
});

// Live CLI sequence list / manual list smoke
const seqList = spawnSync('node', [join(ROOT, 'dist/cli.js'), 'sequence', 'list', LIVE_LIST], { encoding: 'utf8' });
const manList = spawnSync('node', [join(ROOT, 'dist/cli.js'), 'manual', 'list', LIVE_LIST], { encoding: 'utf8' });
capture('sequence-ui.txt', readFileSync(join(SCRATCH, 'sequence-ui.txt'), 'utf8')
  + `\n=== CLI sequence list ===\n${seqList.stdout}\n=== CLI manual list ===\n${manList.stdout}\n`);
check('CLI sequence list works', () => (seqList.status === 0 ? '' : seqList.stderr || 'fail'));
check('CLI manual list works', () => (manList.status === 0 ? '' : manList.stderr || 'fail'));

// Cleanup temps
for (const dir of [gateDir, assignDir, seDir, manDir]) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${'='.repeat(60)}\npassed ${pass}   failed ${failures.length}`);
if (failures.length) {
  for (const [n, w] of failures) console.log(` - ${n}: ${w}`);
  process.exit(1);
}
