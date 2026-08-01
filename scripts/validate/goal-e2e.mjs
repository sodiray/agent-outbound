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
  || '/var/folders/rh/cpfkb8bd3b79n9zcs5s7zk_c0000gn/T/grok-goal-014a522250b9/implementer';
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
  ? completeManualTask({
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

// --- 7. tier0 ---
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
for (const dir of [gateDir, assignDir, sendDir, boardDir]) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${'='.repeat(60)}\npassed ${pass}   failed ${failures.length}`);
if (failures.length) {
  for (const [n, w] of failures) console.log(` - ${n}: ${w}`);
  process.exit(1);
}
