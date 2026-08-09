import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { draftsApproveCommand, draftsListCommand } from '../dist/commands/drafts.js';
import { executePipelineSequenceAction } from '../dist/orchestrator/pipeline/sequence-step-runtime.js';
import { openListDb, ensureRecordColumns } from '../dist/orchestrator/runtime/db.js';
import { readConfig } from '../dist/orchestrator/lib/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SMTP_SCRIPT = join(__dirname, '..', 'scripts/smtp-send.mjs');

const outboundYaml = (body, templateVersion = 1) => `
list:
  name: Content equivalence
business:
  name: Test
  description: Test
  icp: Test
  offer: Test
templates:
  outreach:
    versions:
      - version: ${templateVersion}
        subject: "Hello {{contact_name}}"
        body: "${body}"
sequences:
  default:
    steps:
      - id: email_1
        kind: send_email
        side_effecting: true
        draft_approval_required: true
        template: outreach
        config:
          action: tool_call
          tool:
            server: smtp
            tools: [SMTP_SEND]
            effect: { class: human_contact, channel: email }
          args_map:
            to: contact_email
          idempotency:
            key_source: [_row_id]
            scope: list
pipeline: []
policy:
  enforce_readiness: false
`;

const smtpMcp = (sinkDir) => JSON.stringify({
  mcpServers: {
    smtp: {
      type: 'command',
      command: process.execPath,
      args: [SMTP_SCRIPT],
      env: { AO_SMTP_SINK: '1', AO_SMTP_SINK_DIR: sinkDir },
      tools: [{
        slug: 'SMTP_SEND',
        description: 'SMTP sink',
        input_schema: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            from: { type: 'string' },
            subject: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['to'],
        },
        invoke: {
          argv: ['send', '--to', '{{to}}', '--subject', '{{subject}}', '--body', '{{body}}', '--from', '{{from}}', '--json'],
          result: 'stdout_json',
        },
      }],
    },
  },
}, null, 2);

const createList = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-approved-content-'));
  const sinkDir = join(listDir, 'smtp-sink');
  mkdirSync(sinkDir, { recursive: true });
  writeFileSync(join(listDir, 'outbound.yaml'), outboundYaml('Old approved copy.'));
  writeFileSync(join(listDir, 'mcp.json'), smtpMcp(sinkDir));
  writeFileSync(join(listDir, 'operator.md'), 'test');

  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: [
      'contact_email',
      'contact_name',
      'active_contact_id',
      'email_last_from',
      'assigned_mailbox_id',
      'account_sequence_state',
      'treatment_tier',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, contact_email, contact_name, active_contact_id,
      email_last_from, assigned_mailbox_id, account_sequence_state,
      treatment_tier,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'record_1',
    'Example Co',
    'owner@example.test',
    'Pat Owner',
    'contact_1',
    'sender@example.test',
    'mailbox_1',
    'active',
    'A',
    now,
    now,
    now,
    now,
  );
  db.close();
  return { listDir, sinkDir };
};

const runStep = async ({ db, listDir, intent }) => {
  const config = readConfig(listDir).config;
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('record_1');
  return executePipelineSequenceAction({
    mcp: null,
    listDir,
    listName: 'Content equivalence',
    toolCatalog: null,
    db,
    record,
    config,
    sequenceName: 'default',
    stepNumber: 1,
    step: config.sequences.default.steps[0],
    sequence: { steps: config.sequences.default.steps },
    channelHint: 'email',
    intent,
  });
};

test('approved draft is not sent after its rendered template content changes', async () => {
  const previousSink = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    const { listDir, sinkDir } = createList();
    const db = openListDb({ listDir, readonly: false });
    const drafted = await runStep({ db, listDir, intent: 'draft' });
    assert.equal(drafted.status, 'drafted', JSON.stringify(drafted));
    const draft = db.prepare('SELECT draft_id, content_hash, template_id, template_version FROM drafts WHERE row_id = ?').get('record_1');
    assert.ok(draft.content_hash);
    assert.equal(draft.template_id, 'outreach');
    assert.equal(draft.template_version, 1);
    writeFileSync(join(listDir, 'outbound.yaml'), outboundYaml('New compliance copy.', 2));
    const listed = draftsListCommand({ list: listDir, status: 'pending_approval' });
    assert.equal(listed.rows[0].content_equivalence.status, 'changed');
    assert.equal(draftsApproveCommand({ list: listDir, draftId: draft.draft_id }).approved, 1);
    const attempted = await runStep({ db, listDir, intent: 'send' });

    assert.equal(attempted.status, 'skipped', JSON.stringify(attempted));
    assert.match(String(attempted.reason), /content changed|superseded/i);
    assert.equal(readdirSync(sinkDir).filter((file) => file.endsWith('.json')).length, 0);
    const drafts = db.prepare('SELECT status, body FROM drafts ORDER BY created_at').all();
    assert.deepEqual(drafts, [
      { status: 'superseded', body: 'Old approved copy.' },
      { status: 'pending_approval', body: 'New compliance copy.' },
    ]);
    db.close();
  } finally {
    if (previousSink === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = previousSink;
  }
});

test('approval survives an upstream recompute when rendered content is byte-identical', async () => {
  const previousSink = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    const { listDir, sinkDir } = createList();
    const db = openListDb({ listDir, readonly: false });
    const drafted = await runStep({ db, listDir, intent: 'draft' });
    assert.equal(drafted.status, 'drafted', JSON.stringify(drafted));
    const draft = db.prepare('SELECT draft_id FROM drafts WHERE row_id = ?').get('record_1');
    assert.equal(draftsApproveCommand({ list: listDir, draftId: draft.draft_id }).approved, 1);

    ensureRecordColumns({ db, columns: ['unrelated_enrichment'] });
    db.prepare('UPDATE records SET unrelated_enrichment = ? WHERE _row_id = ?')
      .run('new upstream value', 'record_1');
    const attempted = await runStep({ db, listDir, intent: 'send' });

    assert.equal(attempted.status, 'sent', JSON.stringify(attempted));
    assert.equal(readdirSync(sinkDir).filter((file) => file.endsWith('.json')).length, 1);
    const sent = JSON.parse(readFileSync(join(sinkDir, readdirSync(sinkDir)[0]), 'utf8'));
    assert.equal(sent.body, 'Old approved copy.');
    assert.equal(db.prepare('SELECT status FROM drafts WHERE draft_id = ?').get(draft.draft_id).status, 'sent');
    db.close();
  } finally {
    if (previousSink === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = previousSink;
  }
});

test('a ready draft fails closed when its content can no longer be re-rendered', async () => {
  const previousSink = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    const { listDir, sinkDir } = createList();
    const db = openListDb({ listDir, readonly: false });
    const drafted = await runStep({ db, listDir, intent: 'draft' });
    assert.equal(drafted.status, 'drafted', JSON.stringify(drafted));
    const draft = db.prepare('SELECT draft_id FROM drafts WHERE row_id = ?').get('record_1');
    assert.equal(draftsApproveCommand({ list: listDir, draftId: draft.draft_id }).approved, 1);

    writeFileSync(join(listDir, 'outbound.yaml'), outboundYaml('Replacement copy.').replace('template: outreach', 'template: missing_template'));
    const attempted = await runStep({ db, listDir, intent: 'send' });

    assert.equal(attempted.status, 'skipped', JSON.stringify(attempted));
    assert.match(String(attempted.reason), /cannot be re-rendered|refusing to send/i);
    assert.equal(readdirSync(sinkDir).filter((file) => file.endsWith('.json')).length, 0);
    assert.equal(db.prepare('SELECT status FROM drafts WHERE draft_id = ?').get(draft.draft_id).status, 'ready');
    db.close();
  } finally {
    if (previousSink === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = previousSink;
  }
});
