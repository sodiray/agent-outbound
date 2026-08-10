import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  draftsApproveCommand,
  draftsListCommand,
  draftsEditCommand,
  draftsRefreshCommand,
} from '../dist/commands/drafts.js';
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

test('a hand-edited draft sends the text the human wrote', async () => {
  const previousSink = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    const { listDir, sinkDir } = createList();
    const db = openListDb({ listDir, readonly: false });
    await runStep({ db, listDir, intent: 'draft' });
    const draft = db.prepare('SELECT draft_id FROM drafts WHERE row_id = ?').get('record_1');

    draftsEditCommand({ list: listDir, draftId: draft.draft_id, body: 'Hand-edited by a human before sending.' });

    // The queue must not present a deliberate edit as drift.
    const listed = draftsListCommand({ list: listDir, status: 'pending_approval' });
    assert.equal(listed.rows[0].content_equivalence.status, 'human_edited');

    assert.equal(draftsApproveCommand({ list: listDir, draftId: draft.draft_id }).approved, 1);
    const sent = await runStep({ db, listDir, intent: 'send' });
    assert.equal(sent.status, 'sent', JSON.stringify(sent));

    const files = readdirSync(sinkDir).filter((file) => file.endsWith('.json'));
    assert.equal(files.length, 1);
    const payload = JSON.parse(readFileSync(join(sinkDir, files[0]), 'utf8'));
    const body = payload.body ?? payload.args?.body;
    assert.equal(body, 'Hand-edited by a human before sending.');
    db.close();
  } finally {
    if (previousSink === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = previousSink;
  }
});

test('a hand-edited draft altered after approval is still refused', async () => {
  const previousSink = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    const { listDir, sinkDir } = createList();
    const db = openListDb({ listDir, readonly: false });
    await runStep({ db, listDir, intent: 'draft' });
    const draft = db.prepare('SELECT draft_id FROM drafts WHERE row_id = ?').get('record_1');
    draftsEditCommand({ list: listDir, draftId: draft.draft_id, body: 'Approved wording.' });
    assert.equal(draftsApproveCommand({ list: listDir, draftId: draft.draft_id }).approved, 1);

    // Tamper with the body after approval without touching the approved hash.
    db.prepare('UPDATE drafts SET body = ? WHERE draft_id = ?')
      .run('Substituted after the human approved it.', draft.draft_id);

    const sent = await runStep({ db, listDir, intent: 'send' });
    assert.equal(sent.status, 'skipped', JSON.stringify(sent));
    assert.match(String(sent.reason), /changed after approval/i);
    assert.equal(readdirSync(sinkDir).filter((file) => file.endsWith('.json')).length, 0);
    db.close();
  } finally {
    if (previousSink === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = previousSink;
  }
});

test('drafts refresh supersedes a diverged rendered draft and queues current content as pending_approval', async () => {
  const previousSink = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    const { listDir } = createList();
    const db = openListDb({ listDir, readonly: false });
    const drafted = await runStep({ db, listDir, intent: 'draft' });
    assert.equal(drafted.status, 'drafted', JSON.stringify(drafted));
    const draft = db.prepare('SELECT draft_id, body FROM drafts WHERE row_id = ?').get('record_1');
    assert.equal(draft.body, 'Old approved copy.');

    writeFileSync(join(listDir, 'outbound.yaml'), outboundYaml('New compliance copy.', 2));
    assert.equal(
      draftsListCommand({ list: listDir, status: 'pending_approval' }).rows[0].content_equivalence.status,
      'changed',
    );

    const result = draftsRefreshCommand({ list: listDir, draftId: draft.draft_id });
    assert.equal(result.refreshed, 1, JSON.stringify(result));
    assert.equal(result.results[0].outcome, 'refreshed');
    assert.equal(result.results[0].draft_id, draft.draft_id);
    assert.ok(result.results[0].new_draft_id);
    assert.notEqual(result.results[0].new_draft_id, draft.draft_id);

    const oldDraft = db.prepare('SELECT status FROM drafts WHERE draft_id = ?').get(draft.draft_id);
    assert.equal(oldDraft.status, 'superseded');

    const fresh = db.prepare('SELECT * FROM drafts WHERE draft_id = ?')
      .get(result.results[0].new_draft_id);
    assert.equal(fresh.status, 'pending_approval', 'refreshed draft must not inherit approval');
    assert.equal(fresh.body, 'New compliance copy.');
    assert.equal(fresh.content_source, 'rendered');
    assert.equal(fresh.template_id, 'outreach');
    assert.equal(fresh.template_version, 2);
    assert.ok(fresh.content_hash);

    const listed = draftsListCommand({ list: listDir, status: 'pending_approval' });
    assert.equal(listed.rows.length, 1);
    assert.equal(listed.rows[0].draft_id, fresh.draft_id);
    assert.equal(listed.rows[0].content_equivalence.status, 'matches');
    db.close();
  } finally {
    if (previousSink === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = previousSink;
  }
});

test('drafts refresh refuses a human_edited draft and leaves the body intact', async () => {
  const previousSink = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    const { listDir } = createList();
    const db = openListDb({ listDir, readonly: false });
    await runStep({ db, listDir, intent: 'draft' });
    const draft = db.prepare('SELECT draft_id FROM drafts WHERE row_id = ?').get('record_1');
    const humanBody = 'Hand-written copy the human intends to keep.';
    draftsEditCommand({ list: listDir, draftId: draft.draft_id, body: humanBody });

    writeFileSync(join(listDir, 'outbound.yaml'), outboundYaml('Config moved on.', 2));
    const result = draftsRefreshCommand({ list: listDir, draftId: draft.draft_id });
    assert.equal(result.refused, 1, JSON.stringify(result));
    assert.equal(result.refreshed, 0);
    assert.equal(result.results[0].outcome, 'refused');
    assert.match(String(result.results[0].reason), /human-edited|hand-written|discard/i);

    const after = db.prepare('SELECT status, body, content_source FROM drafts WHERE draft_id = ?')
      .get(draft.draft_id);
    assert.equal(after.status, 'pending_approval');
    assert.equal(after.body, humanBody);
    assert.equal(after.content_source, 'human_edited');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM drafts WHERE row_id = ?').get('record_1').n,
      1,
      'refresh must not supersede or queue a replacement for human-edited content',
    );
    db.close();
  } finally {
    if (previousSink === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = previousSink;
  }
});

test('drafts refresh is a no-op when content already matches', async () => {
  const previousSink = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    const { listDir } = createList();
    const db = openListDb({ listDir, readonly: false });
    await runStep({ db, listDir, intent: 'draft' });
    const draft = db.prepare('SELECT draft_id, status FROM drafts WHERE row_id = ?').get('record_1');
    assert.equal(
      draftsListCommand({ list: listDir, status: 'pending_approval' }).rows[0].content_equivalence.status,
      'matches',
    );

    const result = draftsRefreshCommand({ list: listDir, draftId: draft.draft_id });
    assert.equal(result.unchanged, 1, JSON.stringify(result));
    assert.equal(result.refreshed, 0);
    assert.equal(result.results[0].outcome, 'unchanged');
    assert.equal(result.results[0].draft_id, draft.draft_id);

    const after = db.prepare('SELECT draft_id, status FROM drafts WHERE draft_id = ?').get(draft.draft_id);
    assert.equal(after.draft_id, draft.draft_id);
    assert.equal(after.status, 'pending_approval');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM drafts WHERE row_id = ?').get('record_1').n,
      1,
      'matching draft must not be superseded',
    );
    db.close();
  } finally {
    if (previousSink === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = previousSink;
  }
});

test('CONTROL: after refresh, the send path accepts the new draft once approved', async () => {
  const previousSink = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    const { listDir, sinkDir } = createList();
    const db = openListDb({ listDir, readonly: false });
    const drafted = await runStep({ db, listDir, intent: 'draft' });
    assert.equal(drafted.status, 'drafted', JSON.stringify(drafted));
    const draft = db.prepare('SELECT draft_id FROM drafts WHERE row_id = ?').get('record_1');

    writeFileSync(join(listDir, 'outbound.yaml'), outboundYaml('New compliance copy.', 2));
    assert.equal(
      draftsListCommand({ list: listDir, status: 'pending_approval' }).rows[0].content_equivalence.status,
      'changed',
    );

    const refreshed = draftsRefreshCommand({ list: listDir, draftId: draft.draft_id });
    assert.equal(refreshed.refreshed, 1, JSON.stringify(refreshed));
    const newDraftId = refreshed.results[0].new_draft_id;
    assert.ok(newDraftId);

    const fresh = db.prepare('SELECT status FROM drafts WHERE draft_id = ?').get(newDraftId);
    assert.equal(fresh.status, 'pending_approval', 'refresh must not carry approval forward');

    assert.equal(draftsApproveCommand({ list: listDir, draftId: newDraftId }).approved, 1);
    const sent = await runStep({ db, listDir, intent: 'send' });
    assert.equal(sent.status, 'sent', JSON.stringify(sent));
    assert.equal(readdirSync(sinkDir).filter((file) => file.endsWith('.json')).length, 1);
    const payload = JSON.parse(readFileSync(join(sinkDir, readdirSync(sinkDir)[0]), 'utf8'));
    assert.equal(payload.body, 'New compliance copy.');
    assert.equal(db.prepare('SELECT status FROM drafts WHERE draft_id = ?').get(newDraftId).status, 'sent');
    db.close();
  } finally {
    if (previousSink === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = previousSink;
  }
});
