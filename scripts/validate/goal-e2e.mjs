#!/usr/bin/env node
/**
 * Durable goal verification — drives SHIPPED entry points only.
 *
 * 1. config validate + scoped dry-run (live list)
 * 2. company_resolved_gate fail-closed (runPipelineDataflow)
 * 3. assign + routed_by (runPipelineDataflow)
 * 4. real pipeline send via tool_call SMTP sink (readConfig → runPipelineDataflow)
 * 5. manual_task park/complete
 * 6. sequence board current-position with an advanced lead
 * 7. tier0
 */
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { readConfig } from '../../dist/orchestrator/lib/config.js';
import { evaluateFieldCheck } from '../../dist/orchestrator/lib/conditions.js';
import { flattenPipelineSteps } from '../../dist/orchestrator/lib/subpipelines.js';
import {
  openListDb,
  upsertRecord,
  insertPipelineEvent,
} from '../../dist/orchestrator/runtime/db.js';
import { runPipelineDataflow } from '../../dist/orchestrator/pipeline/dataflow.js';
import { completeManualTask, listAwaitingManualTasks } from '../../dist/orchestrator/pipeline/manual.js';
import { getSequenceBoard, listConfiguredSequences } from '../../dist/orchestrator/pipeline/sequences-board.js';
import { clearStepState } from '../../dist/orchestrator/lib/step-cleanup.js';
import { renderTemplateText, resolveStepTemplate } from '../../dist/orchestrator/lib/templates.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const SCRATCH = process.env.GOAL_SCRATCH
  || '/var/folders/rh/cpfkb8bd3b79n9zcs5s7zk_c0000gn/T/grok-goal-0a1a977e5bad/implementer';
const LIVE_LIST = process.env.TV_LIST
  || '/Users/rayepps/projects/mission/.outbound/treasure-valley';
const SMTP_SCRIPT = join(ROOT, 'scripts/smtp-send.mjs');
const CLI = join(ROOT, 'dist/cli.js');

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
    console.log(`  FAIL  ${name}\n          ${String(err?.message || err).slice(0, 400)}`);
  }
};

const capture = (name, body) => {
  writeFileSync(join(SCRATCH, name), body.endsWith('\n') ? body : `${body}\n`);
};

const AI = `ai:
  default_model: anthropic/claude-sonnet-4-6
  defaults:
    evaluation: anthropic/claude-haiku-4-5-20251001
    copywriting: anthropic/claude-opus-4-6
    research: anthropic/claude-sonnet-4-6
`;

const smtpMcpJson = (sinkDir) => JSON.stringify({
  mcpServers: {
    smtp: {
      type: 'command',
      command: 'node',
      args: [SMTP_SCRIPT],
      env: {
        AO_SMTP_SINK: '1',
        AO_SMTP_SINK_DIR: sinkDir,
      },
      tools: [{
        slug: 'SMTP_SEND',
        description: 'Send one email via sink/SMTP',
        input_schema: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            to_name: { type: 'string' },
            business_name: { type: 'string' },
            subject: { type: 'string' },
            body: { type: 'string' },
            subject_template: { type: 'string' },
            template_id: { type: 'string' },
            from: { type: 'string' },
          },
          required: ['to'],
        },
        invoke: {
          argv: [
            'send', '--to', '{{to}}', '--to-name', '{{to_name}}',
            '--business-name', '{{business_name}}', '--subject', '{{subject}}',
            '--body', '{{body}}', '--subject-template', '{{subject_template}}',
            '--template-id', '{{template_id}}', '--from', '{{from}}', '--json',
          ],
          result: 'stdout_json',
        },
      }],
    },
  },
}, null, 2);

// --- 1. Live validate + dry-run ---
const validate = spawnSync('node', [CLI, 'config', 'validate', LIVE_LIST], { encoding: 'utf8' });
const dry = spawnSync('node', [
  CLI, 'pipeline', LIVE_LIST,
  '--where', "business_name = '__no_such_goal_probe__'",
  '--dry-run',
], { encoding: 'utf8' });
capture('validate-dryrun.txt', [
  '=== config validate ===', validate.stdout || '', validate.stderr || '', `exit=${validate.status}`,
  '=== dry-run ===', dry.stdout || '', dry.stderr || '', `exit=${dry.status}`,
].join('\n'));

check('live config validate has zero errors', () => {
  const j = JSON.parse(validate.stdout || '{}');
  if (!j.ok || (j.errors && j.errors.length)) return JSON.stringify(j.errors || j);
  return '';
});
check('scoped dry-run exits cleanly', () => (dry.status === 0 ? '' : (dry.stderr || dry.stdout || '').slice(0, 200)));

// --- 1b. Config preserves tool_call fields (the skeptic bug) ---
const liveCfg = readConfig(LIVE_LIST);
const liveEmail = flattenPipelineSteps(liveCfg.config)
  .find((s) => String(s?.kind) === 'send_email' && String(s?.id || '').includes('email_1'));
check('readConfig preserves action:tool_call on send_email config', () => {
  const action = String(liveEmail?.config?.action || '').trim();
  const argsMap = liveEmail?.config?.args_map;
  if (action !== 'tool_call') {
    return `action stripped or missing: ${JSON.stringify(liveEmail?.config)}`;
  }
  if (!argsMap || typeof argsMap !== 'object' || !argsMap.to) {
    return `args_map stripped: ${JSON.stringify(liveEmail?.config)}`;
  }
  return '';
});

// --- 2. Resolution gate ---
const gateDir = mkdtempSync(join(tmpdir(), 'ao-gate-'));
writeFileSync(join(gateDir, 'outbound.yaml'), `list:
  name: gate
${AI}pipeline:
  - kind: filter
    id: company_resolved_gate
    type: field_check
    on_fail: drop
    conditions:
      - {field: company_resolution, operator: eq, value: resolved}
  - kind: filter
    id: vertical_gate
    type: field_check
    depends_on: [company_resolved_gate]
    conditions:
      - {field: primary_type, operator: not_in, value: [school]}
sequences:
  default: { steps: [] }
`);
const gateDb = openListDb({ listDir: gateDir, readonly: false });
const stubId = 'stub1';
const now = new Date().toISOString();
upsertRecord({
  db: gateDb,
  row: {
    _row_id: stubId, business_name: 'Stub Only', company_resolution: '',
    primary_type: '', created_at: now, updated_at: now,
  },
});
await runPipelineDataflow({ listDir: gateDir, where: `_row_id = '${stubId}'`, concurrency: 10 });
const stubRow = gateDb.prepare('SELECT disqualified_gate FROM records WHERE _row_id = ?').get(stubId);
const gateEvents = gateDb.prepare('SELECT step_id, passed, reason FROM pipeline_events WHERE record_id = ?').all(stubId);
const vacuous = evaluateFieldCheck({
  row: { primary_type: '' },
  condition: { field: 'primary_type', operator: 'not_in', value: ['school'] },
});
capture('resolution-gate.txt', JSON.stringify({ stubRow, gateEvents, vacuous }, null, 2));
check('stub fails company_resolved_gate', () => {
  const drop = gateEvents.find((e) => e.step_id === 'company_resolved_gate' && Number(e.passed) === 0);
  if (!drop && String(stubRow?.disqualified_gate) !== 'company_resolved_gate') {
    return JSON.stringify({ stubRow, gateEvents });
  }
  if (!vacuous.passed) return 'control: empty primary_type must vacuous-pass not_in';
  return '';
});
gateDb.close();

// --- 3. Assign ---
const assignDir = mkdtempSync(join(tmpdir(), 'ao-assign-'));
writeFileSync(join(assignDir, 'outbound.yaml'), `list:
  name: assign
${AI}sequences:
  default: { steps: [] }
pipeline:
  - kind: assign
    id: sequence_assign
    target: pipeline_name
    fallback: unrouted
    rules:
      - id: local_field_rule
        pipeline: local_field
        conditions:
          - {field: contact_email, operator: is_not_empty}
          - {field: fit_score, operator: gte, value: 60}
  - kind: pipeline
    id: local_field
    steps:
      - {kind: wait, id: hold, after: 1d}
  - kind: pipeline
    id: unrouted
    manual: true
    steps: []
`);
const assignDb = openListDb({ listDir: assignDir, readonly: false });
upsertRecord({
  db: assignDb,
  row: {
    _row_id: 'good1', business_name: 'Good', fit_score: 75, priority_rank: 75,
    sequence_status: 'idle', company_resolution: 'resolved', created_at: now, updated_at: now,
  },
});
assignDb.prepare(`UPDATE records SET contact_email = ? WHERE _row_id = ?`).run('a@example.com', 'good1');
upsertRecord({
  db: assignDb,
  row: {
    _row_id: 'bare1', business_name: 'Bare', fit_score: 10, priority_rank: 10,
    sequence_status: 'idle', company_resolution: 'resolved', created_at: now, updated_at: now,
  },
});
await runPipelineDataflow({
  listDir: assignDir,
  where: `_row_id IN ('good1','bare1')`,
  concurrency: 10,
});
const good = assignDb.prepare('SELECT pipeline_name, routed_by FROM records WHERE _row_id = ?').get('good1');
const bare = assignDb.prepare('SELECT pipeline_name, routed_by FROM records WHERE _row_id = ?').get('bare1');
capture('assign.txt', JSON.stringify({ good, bare }, null, 2));
check('assign routes emailable scored lead', () => {
  if (String(good?.pipeline_name) !== 'local_field') return `pipeline_name=${good?.pipeline_name}`;
  if (!String(good?.routed_by || '').includes('local_field')) return `routed_by=${good?.routed_by}`;
  return '';
});
check('assign fallback to unrouted', () => {
  if (String(bare?.pipeline_name) !== 'unrouted') return `pipeline_name=${bare?.pipeline_name}`;
  return '';
});
assignDb.close();

// --- 4. REAL pipeline send via tool_call (shipped path) ---
const sendDir = mkdtempSync(join(tmpdir(), 'ao-send-'));
const sinkDir = join(SCRATCH, 'smtp-sink-pipeline');
mkdirSync(sinkDir, { recursive: true });
// Clean prior sink files for this run
for (const f of readdirSync(sinkDir)) {
  try { rmSync(join(sinkDir, f)); } catch { /* */ }
}
writeFileSync(join(sendDir, 'mcp.json'), smtpMcpJson(sinkDir));
// Live TV shape: step declares template: email_1 and does NOT put subject/body in args.
// Copy must come from resolveStepTemplate + merge into tool_call args.
writeFileSync(join(sendDir, 'outbound.yaml'), `list:
  name: send-e2e
${AI}templates:
  email_1:
    id: email_1
    channel_hint: email
    versions:
      - version: 1
        subject: 'Quick question for {{business_name}}'
        body: |
          Hi {{contact_name | default: there}},

          I work with local {{business_name}}-type businesses in the Treasure Valley that are buried in admin busywork — intake, quote follow-up, scheduling, invoicing.

          Worth a 10-minute conversation about what that looks like at {{business_name}}?

          Ray
        note: day-1 initial
sequences:
  default: { steps: [] }
pipeline:
  - kind: assign
    id: sequence_assign
    target: pipeline_name
    fallback: unrouted
    rules:
      - id: local_field_rule
        pipeline: local_field
        conditions:
          - {field: contact_email, operator: is_not_empty}
  - kind: pipeline
    id: local_field
    steps:
      - kind: send_email
        id: email_1
        description: first touch
        side_effecting: true
        draft_approval_required: false
        template: email_1
        depends_on: []
        config:
          action: tool_call
          tool:
            server: smtp
            tools: [SMTP_SEND]
          args_map:
            to: contact_email
            to_name: contact_name
            business_name: business_name
          args:
            template_id: email_1
          output_map:
            message_id: message_id
            provider_id: message_id
          daily_cap: 2
          outputs:
            message_id:
              type: string
              description: Provider message id
          columns:
            message_id: email_last_message_id
          idempotency:
            key_source: [_row_id, step_id]
            scope: list
      - kind: wait
        id: wait_after_email_1
        depends_on: [email_1]
        after: 2d
      - kind: manual_task
        id: field_visit
        description: walk-in
        depends_on: [wait_after_email_1]
  - kind: pipeline
    id: unrouted
    manual: true
    steps: []
`);

// Prove parsed config keeps action
const parsedSend = readConfig(sendDir);
const parsedEmail = flattenPipelineSteps(parsedSend.config)
  .find((s) => String(s?.id || '').endsWith('email_1') || String(s?.id) === 'email_1');
check('fixture readConfig keeps action tool_call', () => {
  if (String(parsedEmail?.config?.action) !== 'tool_call') {
    return `config=${JSON.stringify(parsedEmail?.config)}`;
  }
  return '';
});

// refresh-tools so tool catalog has SMTP_SEND
const refresh = spawnSync('node', [CLI, 'refresh-tools', sendDir], {
  encoding: 'utf8',
  env: { ...process.env, AO_SMTP_SINK: '1', AO_SMTP_SINK_DIR: sinkDir },
});

const sendDb = openListDb({ listDir: sendDir, readonly: false });
upsertRecord({
  db: sendDb,
  row: {
    _row_id: 'send1', business_name: 'Send Co', fit_score: 80,
    sequence_status: 'idle', company_resolution: 'resolved',
    created_at: now, updated_at: now,
  },
});
sendDb.prepare(`UPDATE records SET contact_email = ?, contact_name = ?, business_name = ? WHERE _row_id = ?`)
  .run('buyer@example.com', 'Pat Buyer', 'Send Co HVAC', 'send1');
const sendRecord = sendDb.prepare('SELECT * FROM records WHERE _row_id = ?').get('send1');

// Expected rendered copy from shipped resolveStepTemplate (same entry used by pipeline).
const expectedTemplate = resolveStepTemplate({
  config: parsedSend.config,
  step: parsedEmail,
  record: sendRecord,
});
const expectedSubject = expectedTemplate?.subject || '';
const expectedBody = expectedTemplate?.body || '';

// Drive the REAL pipeline entry (not a hand-built executeChannelStep call)
const sendResult = await runPipelineDataflow({
  listDir: sendDir,
  where: `_row_id = 'send1'`,
  concurrency: 10,
});
const channelEvents = sendDb.prepare(`
  SELECT channel, action, provider_message_id, disposition
  FROM channel_events WHERE row_id = 'send1'
`).all();
const emailEvent = sendDb.prepare(`
  SELECT step_id, passed, reason, side_effecting FROM pipeline_events
  WHERE record_id = 'send1'
    AND step_id IN ('local_field.email_1', 'email_1')
    AND kind = 'send_email'
  ORDER BY occurred_at DESC LIMIT 1
`).get();
const sinkFiles = existsSync(sinkDir) ? readdirSync(sinkDir) : [];
const sendRow = sendDb.prepare(`SELECT pipeline_name, routed_by, email_last_message_id FROM records WHERE _row_id = 'send1'`).get();
const sinkPayload = sinkFiles[0]
  ? JSON.parse(readFileSync(join(sinkDir, sinkFiles[0]), 'utf8'))
  : null;

// Side-effect guard via shipped clearStepState
let refused = false;
let refuseMsg = '';
try {
  clearStepState({
    db: sendDb,
    config: parsedSend.config,
    recordId: 'send1',
    stepId: String(emailEvent?.step_id || 'local_field.email_1'),
  });
} catch (err) {
  refused = true;
  refuseMsg = String(err?.message || err);
}

// Unit-level: liquid default + record auto-bind
const defaultExpand = renderTemplateText(
  'Hi {{contact_name | default: there}}, at {{business_name}}',
  { business_name: 'Acme', contact_name: '' },
);

capture('send-e2e.txt', JSON.stringify({
  refresh_exit: refresh.status,
  refresh_out: (refresh.stdout || '').slice(0, 400),
  parsed_email_config: parsedEmail?.config,
  expected_template: {
    subject: expectedSubject,
    body: expectedBody,
    has_placeholder: /\{\{/.test(expectedSubject + expectedBody),
  },
  sinkPayload,
  sendResult_summary: {
    survivors: sendResult?.survivors,
    processed: sendResult?.processed,
    failed: sendResult?.failed,
    errors: sendResult?.errors,
  },
  channelEvents,
  emailEvent,
  sendRow,
  sinkFiles,
  side_effect_refused: refused,
  refuseMsg,
  defaultExpand,
}, null, 2));

check('pipeline send via tool_call writes channel_events with message id', () => {
  const ok = channelEvents.find((e) => e.channel === 'email' && e.action === 'executed' && e.provider_message_id);
  if (!ok) {
    return `no successful channel event: ${JSON.stringify({ channelEvents, emailEvent, errors: sendResult?.errors })}`;
  }
  if (Number(emailEvent?.passed) !== 1) return `email pipeline event not passed: ${JSON.stringify(emailEvent)}`;
  if (!sinkFiles.some((f) => f.includes(String(ok.provider_message_id)) || f.endsWith('.json'))) {
    return `no sink file for ${ok.provider_message_id}; files=${sinkFiles.join(',')}`;
  }
  return '';
});
check('sink body equals rendered template copy (live shape: template: email_1, no args.body)', () => {
  if (!expectedSubject || !expectedBody) {
    return `resolveStepTemplate failed: ${JSON.stringify(expectedTemplate)}`;
  }
  if (/\{\{/.test(expectedSubject) || /\{\{/.test(expectedBody)) {
    return `template left unexpanded placeholders: subject=${expectedSubject} body=${expectedBody.slice(0, 120)}`;
  }
  if (!sinkPayload) return 'no sink payload';
  if (String(sinkPayload.subject || '') !== expectedSubject) {
    return `subject mismatch:\n  sink=${sinkPayload.subject}\n  expected=${expectedSubject}`;
  }
  // Normalize trailing newlines for comparison
  const sinkBody = String(sinkPayload.body || '').replace(/\s+$/, '');
  const wantBody = String(expectedBody || '').replace(/\s+$/, '');
  if (sinkBody !== wantBody) {
    return `body mismatch:\n  sink=${JSON.stringify(sinkBody)}\n  expected=${JSON.stringify(wantBody)}`;
  }
  if (!sinkBody.includes('Send Co HVAC')) {
    return `body missing business_name expansion: ${sinkBody.slice(0, 200)}`;
  }
  if (!sinkBody.includes('Hi Pat Buyer')) {
    return `body missing contact_name expansion: ${sinkBody.slice(0, 200)}`;
  }
  // Must not be the generic smtp-send fallback
  if (/Hello from Agent Outbound|Quick note regarding/i.test(sinkBody) && !sinkBody.includes('Treasure Valley')) {
    return `looks like generic sink body, not template: ${sinkBody.slice(0, 200)}`;
  }
  return '';
});
check('template default filter expands empty contact_name to "there"', () => {
  if (defaultExpand !== 'Hi there, at Acme') return `got: ${defaultExpand}`;
  return '';
});
check('clearing side-effecting send is refused', () => {
  if (!refused) return 'clearStepState did not refuse';
  if (!/side-effecting|Refusing/i.test(refuseMsg)) return refuseMsg;
  return '';
});

// --- 5. Manual park/complete (reuse send list after advancing wait artificially) ---
// Force-complete wait so manual becomes eligible
const waitId = 'local_field.wait_after_email_1';
const visitId = 'local_field.field_visit';
// Mark wait as passed so next pipeline run parks on visit
insertPipelineEvent({
  db: sendDb,
  event: {
    event_id: randomUUID(),
    record_id: 'send1',
    step_id: waitId,
    kind: 'wait',
    passed: 1,
    reason: 'forced_for_board_test',
    occurred_at: new Date().toISOString(),
  },
});
await runPipelineDataflow({
  listDir: sendDir,
  where: `_row_id = 'send1'`,
  concurrency: 10,
});
const awaiting = listAwaitingManualTasks({ db: sendDb });
const parked = awaiting.tasks.find((t) => t.record_id === 'send1');
const completed = parked
  ? await completeManualTask({
    db: sendDb,
    config: parsedSend.config,
    recordId: 'send1',
    stepId: parked.step_id,
    note: 'visited',
  })
  : null;
const afterManual = listAwaitingManualTasks({ db: sendDb });
capture('manual-task.txt', JSON.stringify({ awaiting, parked, completed, afterManual }, null, 2));
check('manual_task parks after email+wait', () => {
  if (!parked || !String(parked.step_id).includes('field_visit')) {
    return `parked=${JSON.stringify(parked)}; events=${JSON.stringify(sendDb.prepare('SELECT step_id,passed,reason FROM pipeline_events WHERE record_id=?').all('send1'))}`;
  }
  return '';
});
check('manual complete clears queue', () => {
  if (!completed) return 'complete did not run';
  if (afterManual.tasks.some((t) => t.record_id === 'send1')) return 'still in queue';
  return '';
});

// --- 6. Board current-position with advanced lead ---
// Re-seed a fresh list with controlled progress for board assertions
const boardDir = mkdtempSync(join(tmpdir(), 'ao-board-'));
writeFileSync(join(boardDir, 'outbound.yaml'), `list:
  name: board
${AI}sequences:
  default: { steps: [] }
pipeline:
  - kind: assign
    id: sequence_assign
    target: pipeline_name
    fallback: unrouted
    rules:
      - id: r1
        pipeline: local_field
        conditions:
          - {field: contact_email, operator: is_not_empty}
  - kind: pipeline
    id: local_field
    steps:
      - {kind: send_email, id: email_1, side_effecting: true, description: e1, config: {action: tool_call, tool: {server: smtp, tools: [SMTP_SEND]}, args: {subject: s, body: b}, args_map: {to: contact_email}, output_map: {message_id: message_id}, daily_cap: 5}}
      - {kind: wait, id: wait_after_email_1, depends_on: [email_1], after: 2d}
      - {kind: manual_task, id: field_visit, depends_on: [wait_after_email_1], description: visit}
  - kind: pipeline
    id: unrouted
    manual: true
    steps: []
`);
writeFileSync(join(boardDir, 'mcp.json'), smtpMcpJson(join(SCRATCH, 'smtp-sink-board')));
spawnSync('node', [CLI, 'refresh-tools', boardDir], {
  encoding: 'utf8',
  env: { ...process.env, AO_SMTP_SINK: '1', AO_SMTP_SINK_DIR: join(SCRATCH, 'smtp-sink-board') },
});
const boardDb = openListDb({ listDir: boardDir, readonly: false });
// Lead A: only assigned (at email_1, not started) — after pipeline will be past email into wait
upsertRecord({
  db: boardDb,
  row: {
    _row_id: 'leadA', business_name: 'A Co', fit_score: 90, sequence_status: 'idle',
    company_resolution: 'resolved', created_at: now, updated_at: now,
  },
});
boardDb.prepare(`UPDATE records SET contact_email = ? WHERE _row_id = ?`).run('a@x.com', 'leadA');
await runPipelineDataflow({ listDir: boardDir, where: `_row_id = 'leadA'`, concurrency: 10 });
// After email_1 send, wait parks with wake_at → current position should be wait
const boardCfg = readConfig(boardDir);
const board = getSequenceBoard({ db: boardDb, config: boardCfg.config, sequence: 'local_field' });
const emailBucket = board.buckets.find((b) => b.step_id.endsWith('email_1') || b.step_id === 'email_1');
const waitBucket = board.buckets.find((b) => b.step_id.includes('wait'));
const visitBucket = board.buckets.find((b) => b.step_id.includes('field_visit'));

// Lead B: force past email+wait into visit park
upsertRecord({
  db: boardDb,
  row: {
    _row_id: 'leadB', business_name: 'B Co', fit_score: 90, sequence_status: 'idle',
    company_resolution: 'resolved', pipeline_name: 'local_field', created_at: now, updated_at: now,
  },
});
boardDb.prepare(`UPDATE records SET contact_email = ?, pipeline_name = 'local_field', routed_by = 'local_field_rule' WHERE _row_id = ?`)
  .run('b@x.com', 'leadB');
const t = new Date().toISOString();
for (const [stepId, kind] of [
  ['local_field.email_1', 'send_email'],
  ['local_field.wait_after_email_1', 'wait'],
]) {
  insertPipelineEvent({
    db: boardDb,
    event: {
      event_id: randomUUID(), record_id: 'leadB', step_id: stepId, kind,
      passed: 1, reason: '', side_effecting: kind === 'send_email' ? 1 : 0, occurred_at: t,
    },
  });
}
insertPipelineEvent({
  db: boardDb,
  event: {
    event_id: randomUUID(), record_id: 'leadB', step_id: 'local_field.field_visit',
    kind: 'manual_task', passed: 0, reason: 'awaiting_manual', occurred_at: t,
  },
});
const board2 = getSequenceBoard({ db: boardDb, config: boardCfg.config, sequence: 'local_field' });
const email2 = board2.buckets.find((b) => String(b.step_id).includes('email_1'));
const wait2 = board2.buckets.find((b) => String(b.step_id).includes('wait'));
const visit2 = board2.buckets.find((b) => String(b.step_id).includes('field_visit'));

capture('sequence-ui.txt', JSON.stringify({
  after_email_send: board,
  after_manual_park: board2,
  email2_has_leadB: email2?.record_ids?.includes('leadB'),
  wait2_has_leadB: wait2?.record_ids?.includes('leadB'),
  visit2_has_leadB: visit2?.record_ids?.includes('leadB'),
  sequences: listConfiguredSequences({ config: boardCfg.config }),
}, null, 2));

check('board: lead after email is in wait bucket, NOT still in email_1', () => {
  if (!waitBucket || waitBucket.count < 1 || !waitBucket.record_ids.includes('leadA')) {
    return `wait bucket missing leadA: ${JSON.stringify(board)}`;
  }
  if (emailBucket?.record_ids?.includes('leadA')) {
    return `leadA still listed under completed email_1: ${JSON.stringify(emailBucket)}`;
  }
  return '';
});
check('board: lead at visit is only in visit bucket', () => {
  if (!visit2?.record_ids?.includes('leadB')) {
    return `visit missing leadB: ${JSON.stringify(board2)}`;
  }
  if (email2?.record_ids?.includes('leadB') || wait2?.record_ids?.includes('leadB')) {
    return `leadB wrongly still in earlier buckets: email=${JSON.stringify(email2)} wait=${JSON.stringify(wait2)}`;
  }
  if (board2.total_assigned < 2) return `total_assigned=${board2.total_assigned}`;
  return '';
});

// CLI board on this fixture
const cliBoard = spawnSync('node', [CLI, 'sequence', 'board', boardDir, '--sequence', 'local_field'], { encoding: 'utf8' });
capture('sequence-ui.txt', readFileSync(join(SCRATCH, 'sequence-ui.txt'), 'utf8')
  + `\n=== CLI board ===\n${cliBoard.stdout || ''}\n${cliBoard.stderr || ''}\n`);
check('CLI sequence board works', () => (cliBoard.status === 0 ? '' : (cliBoard.stderr || '').slice(0, 200)));

boardDb.close();
sendDb.close();

// --- 7. Draft → approve → send (scoped, tool_call + templates) ---
const draftDir = mkdtempSync(join(tmpdir(), 'ao-draft-'));
const draftSink = join(SCRATCH, 'smtp-sink-draft');
mkdirSync(draftSink, { recursive: true });
for (const f of readdirSync(draftSink)) {
  try { rmSync(join(draftSink, f)); } catch { /* */ }
}
writeFileSync(join(draftDir, 'mcp.json'), smtpMcpJson(draftSink));
writeFileSync(join(draftDir, 'outbound.yaml'), `list:
  name: draft-e2e
${AI}templates:
  email_1:
    id: email_1
    channel_hint: email
    versions:
      - version: 1
        subject: 'Draft for {{business_name}}'
        body: |
          Hello {{contact_name | default: there}},

          Draft body for {{business_name}}.
        note: draft-path
sequences:
  default: { steps: [] }
pipeline:
  - kind: assign
    id: sequence_assign
    target: pipeline_name
    fallback: unrouted
    rules:
      - id: local_field_rule
        pipeline: local_field
        conditions:
          - {field: contact_email, operator: is_not_empty}
  - kind: pipeline
    id: local_field
    steps:
      - kind: send_email
        id: email_1
        description: first touch with approval
        side_effecting: true
        draft_approval_required: true
        template: email_1
        depends_on: []
        config:
          action: tool_call
          tool:
            server: smtp
            tools: [SMTP_SEND]
          args_map:
            to: contact_email
            to_name: contact_name
            business_name: business_name
          args:
            template_id: email_1
          output_map:
            message_id: message_id
            provider_id: message_id
          daily_cap: 2
          outputs:
            message_id:
              type: string
              description: Provider message id
          columns:
            message_id: email_last_message_id
          idempotency:
            key_source: [_row_id, step_id]
            scope: list
  - kind: pipeline
    id: unrouted
    manual: true
    steps: []
`);
spawnSync('node', [CLI, 'refresh-tools', draftDir], {
  encoding: 'utf8',
  env: { ...process.env, AO_SMTP_SINK: '1', AO_SMTP_SINK_DIR: draftSink },
});
const draftDb = openListDb({ listDir: draftDir, readonly: false });
upsertRecord({
  db: draftDb,
  row: {
    _row_id: 'draft1', business_name: 'Draft Co', fit_score: 80,
    sequence_status: 'idle', company_resolution: 'resolved',
    created_at: now, updated_at: now,
  },
});
draftDb.prepare(`UPDATE records SET contact_email = ?, contact_name = ? WHERE _row_id = ?`)
  .run('draft-buyer@example.com', 'Dana Draft', 'draft1');

// Pass 1: create pending draft (scoped where)
const draftPass1 = await runPipelineDataflow({
  listDir: draftDir,
  where: `_row_id = 'draft1'`,
  concurrency: 10,
});
const pendingDrafts = draftDb.prepare(`
  SELECT draft_id, status, subject, body, step_number, sequence_name
  FROM drafts WHERE row_id = 'draft1'
`).all();
const sinkAfterDraft = existsSync(draftSink) ? readdirSync(draftSink) : [];

// Approve via shipped CLI path
const draftId = String(pendingDrafts[0]?.draft_id || '');
const approveCli = draftId
  ? spawnSync('node', [CLI, 'drafts', 'approve', draftDir, '--id', draftId], { encoding: 'utf8' })
  : { status: 1, stdout: '', stderr: 'no draft id' };
const readyDrafts = draftDb.prepare(`
  SELECT draft_id, status FROM drafts WHERE row_id = 'draft1' AND status = 'ready'
`).all();

// Pass 2: send approved draft
const draftPass2 = await runPipelineDataflow({
  listDir: draftDir,
  where: `_row_id = 'draft1'`,
  concurrency: 10,
});
const sentChannel = draftDb.prepare(`
  SELECT channel, action, provider_message_id
  FROM channel_events
  WHERE row_id = 'draft1' AND action = 'executed'
`).all();
const sinkAfterSend = existsSync(draftSink) ? readdirSync(draftSink) : [];
const sentDrafts = draftDb.prepare(`SELECT draft_id, status FROM drafts WHERE row_id = 'draft1'`).all();

// Re-dispatch must not re-send (idempotent skip or already-passed)
const draftPass3 = await runPipelineDataflow({
  listDir: draftDir,
  where: `_row_id = 'draft1'`,
  concurrency: 10,
});
const sinkAfterRedispatch = existsSync(draftSink) ? readdirSync(draftSink) : [];

capture('draft-approve-send.txt', JSON.stringify({
  draftPass1_summary: {
    survivors: draftPass1?.survivors,
    processed: draftPass1?.processed,
    failed: draftPass1?.failed,
    errors: draftPass1?.errors,
  },
  pendingDrafts,
  sinkAfterDraft,
  approveCli: {
    status: approveCli.status,
    out: (approveCli.stdout || '').slice(0, 400),
    err: (approveCli.stderr || '').slice(0, 200),
  },
  readyDrafts,
  draftPass2_summary: {
    survivors: draftPass2?.survivors,
    processed: draftPass2?.processed,
    failed: draftPass2?.failed,
    errors: draftPass2?.errors,
  },
  sentChannel,
  sinkAfterSend,
  sentDrafts,
  draftPass3_summary: {
    survivors: draftPass3?.survivors,
    processed: draftPass3?.processed,
    failed: draftPass3?.failed,
    skipped_passed: draftPass3?.skipped_passed,
  },
  sinkAfterRedispatch,
  scoped_where_only: true,
}, null, 2));

check('draft path creates pending_approval draft without SMTP sink file', () => {
  if (!pendingDrafts.length || pendingDrafts[0].status !== 'pending_approval') {
    return `drafts=${JSON.stringify(pendingDrafts)}; pass1=${JSON.stringify(draftPass1?.errors)}`;
  }
  if (!String(pendingDrafts[0].subject || '').includes('Draft Co')) {
    return `subject not templated: ${pendingDrafts[0].subject}`;
  }
  if (sinkAfterDraft.length > 0) {
    return `SMTP fired on draft: ${sinkAfterDraft.join(',')}`;
  }
  return '';
});
check('drafts approve CLI marks draft ready', () => {
  if (approveCli.status !== 0) return (approveCli.stderr || approveCli.stdout || '').slice(0, 200);
  if (!readyDrafts.length) return 'no ready draft after approve';
  return '';
});
check('approved draft sends via tool_call with message id', () => {
  const ok = sentChannel.find((e) => e.provider_message_id);
  if (!ok) {
    return `no executed channel event: ${JSON.stringify({ sentChannel, errors: draftPass2?.errors, sentDrafts })}`;
  }
  if (sinkAfterSend.length < 1) return `no sink file after send: ${sinkAfterSend.join(',')}`;
  return '';
});
check('re-dispatch does not create another sink send', () => {
  if (sinkAfterRedispatch.length !== sinkAfterSend.length) {
    return `sink grew on redispatch: before=${sinkAfterSend.length} after=${sinkAfterRedispatch.length}`;
  }
  return '';
});
draftDb.close();

// --- 8. SPA structure: Sequence + Manual routes + API client ---
const spaRoot = join(ROOT, 'src/viz/ui/src');
const spaFiles = {
  main: readFileSync(join(spaRoot, 'main.tsx'), 'utf8'),
  sequences: existsSync(join(spaRoot, 'SequencesRoute.tsx'))
    ? readFileSync(join(spaRoot, 'SequencesRoute.tsx'), 'utf8') : '',
  manual: existsSync(join(spaRoot, 'ManualRoute.tsx'))
    ? readFileSync(join(spaRoot, 'ManualRoute.tsx'), 'utf8') : '',
  api: readFileSync(join(spaRoot, 'api.ts'), 'utf8'),
  nav: existsSync(join(spaRoot, 'RouteNav.tsx'))
    ? readFileSync(join(spaRoot, 'RouteNav.tsx'), 'utf8') : '',
};
const distIndex = join(ROOT, 'src/viz/ui/dist/index.html');
const distAssets = existsSync(join(ROOT, 'src/viz/ui/dist/assets'))
  ? readdirSync(join(ROOT, 'src/viz/ui/dist/assets'))
  : [];
const builtJs = distAssets.find((f) => f.endsWith('.js')) || '';
const builtJsBody = builtJs
  ? readFileSync(join(ROOT, 'src/viz/ui/dist/assets', builtJs), 'utf8')
  : '';

capture('spa-sequences-manual.txt', JSON.stringify({
  routes_in_main: {
    sequences: /path=["']\/sequences["']/.test(spaFiles.main),
    manual: /path=["']\/manual["']/.test(spaFiles.main),
  },
  sequences_route_exists: Boolean(spaFiles.sequences),
  manual_route_exists: Boolean(spaFiles.manual),
  api_client: {
    fetchSequences: /fetchSequences/.test(spaFiles.api),
    fetchSequenceBoard: /fetchSequenceBoard/.test(spaFiles.api),
    fetchManualTasks: /fetchManualTasks/.test(spaFiles.api),
    completeManualTask: /completeManualTask/.test(spaFiles.api),
  },
  nav_links: {
    sequences: /\/sequences/.test(spaFiles.nav),
    manual: /\/manual/.test(spaFiles.nav),
  },
  dist_built: existsSync(distIndex),
  dist_js: builtJs,
  dist_includes_sequences: /sequence-board|SequencesRoute|\/sequences/.test(builtJsBody),
  dist_includes_manual: /manual-queue|ManualRoute|\/manual/.test(builtJsBody),
}, null, 2));

check('SPA registers /sequences and /manual routes', () => {
  if (!/path=["']\/sequences["']/.test(spaFiles.main)) return 'missing /sequences route in main.tsx';
  if (!/path=["']\/manual["']/.test(spaFiles.main)) return 'missing /manual route in main.tsx';
  if (!spaFiles.sequences) return 'SequencesRoute.tsx missing';
  if (!spaFiles.manual) return 'ManualRoute.tsx missing';
  if (!/fetchSequenceBoard|sequence-board/.test(spaFiles.sequences)) {
    return 'SequencesRoute does not call board API';
  }
  if (!/completeManualTask|\/api\/manual/.test(spaFiles.manual + spaFiles.api)) {
    return 'ManualRoute missing complete action';
  }
  if (!/\/sequences/.test(spaFiles.nav) || !/\/manual/.test(spaFiles.nav)) {
    return 'RouteNav missing Sequences/Manual links';
  }
  return '';
});
check('SPA dist build includes sequence/manual surfaces', () => {
  if (!existsSync(distIndex)) return 'dist/index.html missing — run ui build';
  if (!builtJs) return 'no dist JS asset';
  if (!/\/sequences|Sequences|sequence-board/.test(builtJsBody)) {
    return 'built JS missing sequences surface';
  }
  if (!/\/manual|Manual|manual-queue/.test(builtJsBody)) {
    return 'built JS missing manual surface';
  }
  return '';
});

// --- 9. Mailforge config + sink parity proof (live Mailforge needs SMTP_* env) ---
const smtpHelp = spawnSync('node', [SMTP_SCRIPT, '--help'], { encoding: 'utf8' });
const sinkProofDir = join(SCRATCH, 'mailforge-sink-parity');
mkdirSync(sinkProofDir, { recursive: true });
const sinkProof = spawnSync('node', [
  SMTP_SCRIPT, 'send',
  '--to', 'parity@example.com',
  '--subject', 'Mailforge path parity',
  '--body', 'Sink proves the same CLI entry Mailforge uses.',
  '--from', 'outbound@example.com',
  '--json',
], {
  encoding: 'utf8',
  env: {
    ...process.env,
    AO_SMTP_SINK: '1',
    AO_SMTP_SINK_DIR: sinkProofDir,
    SMTP_HOST: '', // force sink
  },
});
const liveHost = String(process.env.SMTP_HOST || '').trim();
const liveUser = String(process.env.SMTP_USER || '').trim();
const livePass = String(process.env.SMTP_PASS || '').trim();
const envGap = !liveHost || !liveUser || !livePass;
let liveAttempt = null;
if (!envGap) {
  liveAttempt = spawnSync('node', [
    SMTP_SCRIPT, 'send',
    '--to', process.env.MAILFORGE_TEST_TO || liveUser,
    '--subject', 'Agent Outbound Mailforge probe',
    '--body', 'Scoped live probe from goal verification.',
    '--json',
  ], {
    encoding: 'utf8',
    env: { ...process.env, AO_SMTP_SINK: '0' },
    timeout: 45_000,
  });
}
const tvMcp = readFileSync(join(LIVE_LIST, 'mcp.json'), 'utf8');
const tvYaml = readFileSync(join(LIVE_LIST, 'outbound.yaml'), 'utf8');
capture('mailforge-send.txt', [
  '=== env ===',
  `SMTP_HOST=${liveHost ? '[set]' : '[missing]'}`,
  `SMTP_USER=${liveUser ? '[set]' : '[missing]'}`,
  `SMTP_PASS=${livePass ? '[set]' : '[missing]'}`,
  `SMTP_FROM=${process.env.SMTP_FROM ? '[set]' : '[missing]'}`,
  `env_gap=${envGap}`,
  '',
  '=== smtp-send --help (documents Mailforge env) ===',
  smtpHelp.stdout || '',
  smtpHelp.stderr || '',
  '',
  '=== sink parity (same tool entry as Mailforge) ===',
  `exit=${sinkProof.status}`,
  sinkProof.stdout || '',
  sinkProof.stderr || '',
  '',
  '=== live attempt ===',
  envGap
    ? 'SKIPPED: set SMTP_HOST, SMTP_USER, SMTP_PASS (and optional SMTP_FROM/SMTP_PORT) to prove live Mailforge delivery. Code path + mcp smtp server + daily_cap=2 are wired; criterion 1 blocked only by credentials.'
    : JSON.stringify({
      status: liveAttempt?.status,
      stdout: (liveAttempt?.stdout || '').slice(0, 800),
      stderr: (liveAttempt?.stderr || '').slice(0, 400),
    }, null, 2),
  '',
  '=== treasure-valley wiring ===',
  `mcp has smtp server: ${/"smtp"\s*:/.test(tvMcp)}`,
  `outbound.yaml tool_call SMTP_SEND: ${/SMTP_SEND/.test(tvYaml) && /action:\s*tool_call/.test(tvYaml)}`,
  `daily_cap present: ${/daily_cap:\s*2/.test(tvYaml)}`,
].join('\n'));

check('smtp tool + TV mcp/config ready for Mailforge (sink parity when no creds)', () => {
  if (smtpHelp.status !== 0 && !(smtpHelp.stdout || '').includes('SMTP_HOST')) {
    return 'smtp-send help missing Mailforge env docs';
  }
  if (sinkProof.status !== 0) return (sinkProof.stderr || sinkProof.stdout || '').slice(0, 200);
  let sinkJson;
  try { sinkJson = JSON.parse(sinkProof.stdout || '{}'); } catch {
    return `sink stdout not JSON: ${sinkProof.stdout}`;
  }
  if (!sinkJson.ok || !sinkJson.message_id || sinkJson.mode !== 'sink') {
    return `bad sink result: ${JSON.stringify(sinkJson)}`;
  }
  if (!/"smtp"\s*:/.test(tvMcp)) return 'treasure-valley mcp.json missing smtp server';
  if (!/SMTP_SEND/.test(tvYaml)) return 'treasure-valley outbound.yaml missing SMTP_SEND';
  if (!/daily_cap:\s*2/.test(tvYaml)) return 'daily_cap: 2 missing from TV config';
  if (!envGap && liveAttempt && liveAttempt.status !== 0) {
    return `live SMTP failed: ${(liveAttempt.stderr || liveAttempt.stdout || '').slice(0, 300)}`;
  }
  return '';
});

// --- 10. STARTTLS shipped CLI (RFC 3207 post-upgrade EHLO, no second 220) ---
const starttls = spawnSync('node', [join(ROOT, 'scripts/validate/smtp-starttls.mjs')], {
  encoding: 'utf8',
  cwd: ROOT,
  env: { ...process.env, GOAL_SCRATCH: SCRATCH },
});
capture('smtp-starttls-goal-e2e.txt', `${starttls.stdout || ''}\n${starttls.stderr || ''}\nexit=${starttls.status}\n`);
check('smtp-send STARTTLS shipped CLI validation is green', () => {
  if (starttls.status !== 0) return `exit ${starttls.status}: ${(starttls.stderr || starttls.stdout || '').slice(-400)}`;
  if (!/passed 4\s+failed 0/.test(starttls.stdout || '')) return (starttls.stdout || '').slice(-400);
  return '';
});

// --- 11. mailbox catalog + per-send SMTP overlay ---
const mailboxValidation = spawnSync('node', [join(ROOT, 'scripts/validate/mailboxes.mjs')], {
  encoding: 'utf8', cwd: ROOT,
});
capture('mailboxes.txt', `${mailboxValidation.stdout || ''}\n${mailboxValidation.stderr || ''}\nexit=${mailboxValidation.status}\n`);
check('multi-mailbox validation is green', () => {
  if (mailboxValidation.status !== 0) return `exit ${mailboxValidation.status}: ${(mailboxValidation.stderr || mailboxValidation.stdout || '').slice(-500)}`;
  if (!/failed 0/.test(mailboxValidation.stdout || '')) return (mailboxValidation.stdout || '').slice(-500);
  return '';
});

// --- 12. tier0 ---
const tier0 = spawnSync('node', [join(ROOT, 'scripts/validate/tier0.mjs')], {
  encoding: 'utf8', cwd: ROOT,
});
capture('tier0.txt', `${tier0.stdout || ''}\n${tier0.stderr || ''}\nexit=${tier0.status}\n`);
check('tier0 still green', () => {
  if (tier0.status !== 0) return `exit ${tier0.status}`;
  if (!/failed 0/.test(tier0.stdout || '')) return (tier0.stdout || '').slice(-300);
  return '';
});

// Cleanup temps
for (const dir of [gateDir, assignDir, sendDir, boardDir, draftDir]) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${'='.repeat(60)}\npassed ${pass}   failed ${failures.length}`);
if (failures.length) {
  for (const [n, w] of failures) console.log(` - ${n}: ${w}`);
  process.exit(1);
}
