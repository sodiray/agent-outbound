import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { normalizeConfig } from '../dist/schemas/config.js';
import {
  approveDraftForViz,
  getDraftDetailForViz,
  getDraftsForViz,
  rejectDraftForViz,
} from '../dist/viz/drafts.js';
import { executePipelineSequenceAction } from '../dist/orchestrator/pipeline/sequence-step-runtime.js';
import { openListDb, ensureRecordColumns } from '../dist/orchestrator/runtime/db.js';
import { readConfig } from '../dist/orchestrator/lib/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SMTP_SCRIPT = join(__dirname, '..', 'scripts/smtp-send.mjs');

const outboundYaml = ({
  body = 'Old approved copy.',
  templateVersion = 1,
  withDetail = true,
} = {}) => `
list:
  name: Draft approval UI
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
${withDetail ? `        detail:
          - title: Prospect
            items:
              - field: business_name
              - field: contact_email
                as: email
              - field: website
                as: link
                show_when_empty: true
` : ''}        config:
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

const createList = ({ withDetail = true } = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-drafts-ui-'));
  const sinkDir = join(listDir, 'smtp-sink');
  mkdirSync(sinkDir, { recursive: true });
  writeFileSync(join(listDir, 'outbound.yaml'), outboundYaml({ withDetail }));
  writeFileSync(join(listDir, 'mcp.json'), smtpMcp(sinkDir));
  writeFileSync(join(listDir, 'operator.md'), 'test');

  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: [
      'contact_email',
      'contact_name',
      'website',
      'active_contact_id',
      'email_last_from',
      'assigned_mailbox_id',
      'account_sequence_state',
      'treatment_tier',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, contact_email, contact_name, website, active_contact_id,
      email_last_from, assigned_mailbox_id, account_sequence_state,
      treatment_tier,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'record_1',
    'Example Co',
    'owner@example.test',
    'Pat Owner',
    'https://example.test',
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
    listName: 'Draft approval UI',
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

const seedPendingDraft = async () => {
  const { listDir, sinkDir } = createList();
  const db = openListDb({ listDir, readonly: false });
  const drafted = await runStep({ db, listDir, intent: 'draft' });
  assert.equal(drafted.status, 'drafted', JSON.stringify(drafted));
  const draft = db.prepare('SELECT * FROM drafts WHERE row_id = ?').get('record_1');
  assert.ok(draft?.draft_id);
  return { listDir, sinkDir, db, draft };
};

test('draft approval detail validates closed renderer vocabulary and warns when absent', () => {
  const unknownRenderer = normalizeConfig({
    sequences: {
      default: {
        steps: [{
          id: 'email_1',
          kind: 'send_email',
          side_effecting: true,
          draft_approval_required: true,
          detail: [{ title: 'Overview', items: [{ field: 'business_name', as: 'badge' }] }],
        }],
      },
    },
  });
  assert.ok(unknownRenderer.errors.length > 0 || unknownRenderer.warnings.some((w) => /badge|detail|as/i.test(w)));
  // Zod rejects unknown enum values for sequence steps as errors when parse fails,
  // or strips/errors via the detail schema.
  assert.match(
    [...unknownRenderer.errors, ...unknownRenderer.warnings, unknownRenderer.error || ''].join('\n'),
    /badge|Invalid enum|detail/i,
  );

  const noDetail = normalizeConfig({
    sequences: {
      default: {
        steps: [{
          id: 'email_1',
          kind: 'send_email',
          side_effecting: true,
          draft_approval_required: true,
          template: 'outreach',
        }],
      },
    },
    templates: {
      outreach: { versions: [{ version: 1, subject: 'Hi', body: 'Body' }] },
    },
  });
  assert.deepEqual(noDetail.errors, []);
  assert.ok(
    noDetail.warnings.some((warning) => (
      warning.includes('email_1')
      && warning.includes('draft_approval_required')
      && warning.includes('detail')
    )),
    JSON.stringify(noDetail.warnings),
  );

  const declared = normalizeConfig({
    sequences: {
      default: {
        steps: [{
          id: 'email_1',
          kind: 'send_email',
          side_effecting: true,
          draft_approval_required: true,
          template: 'outreach',
          detail: [
            { title: 'Prospect', items: [{ field: 'business_name' }, { field: 'contact_email', as: 'email' }] },
            { title: 'Website', as: 'embed', from: 'website' },
          ],
        }],
      },
    },
    templates: {
      outreach: { versions: [{ version: 1, subject: 'Hi', body: 'Body' }] },
    },
  });
  assert.deepEqual(declared.errors, []);
  assert.equal(declared.config.sequences.default.steps[0].detail[0].items[1].as, 'email');
  assert.equal(declared.config.sequences.default.steps[0].detail[1].as, 'embed');
});

test('drafts API returns declared detail sections for pending approval', async () => {
  const { listDir, db, draft } = await seedPendingDraft();
  try {
    const list = getDraftsForViz(listDir, 'pending_approval', 50, 0);
    assert.equal(list.status, 'pending_approval');
    assert.ok(list.counts.pending_approval >= 1);
    assert.equal(list.drafts.length, 1);
    assert.equal(list.drafts[0].draft_id, draft.draft_id);
    assert.ok(Array.isArray(list.drafts[0].detail_declaration));
    assert.equal(list.drafts[0].detail_declaration[0].title, 'Prospect');
    assert.ok(Array.isArray(list.drafts[0].detail_sections));
    const prospect = list.drafts[0].detail_sections.find((section) => section.title === 'Prospect');
    assert.ok(prospect);
    assert.equal(prospect.kind, 'fields');
    assert.equal(
      prospect.items.find((item) => item.field === 'business_name')?.value,
      'Example Co',
    );
    assert.equal(
      prospect.items.find((item) => item.field === 'contact_email')?.renderer,
      'email',
    );

    const detail = getDraftDetailForViz(listDir, draft.draft_id);
    assert.equal(detail.draft.draft_id, draft.draft_id);
    assert.equal(detail.record.business_name, 'Example Co');
    assert.deepEqual(
      detail.detail_sections.map((section) => section.title),
      detail.draft.detail_sections.map((section) => section.title),
    );
    assert.match(String(detail.draft.subject || ''), /Hello/);
    assert.match(String(detail.draft.body || ''), /Old approved copy/);
  } finally {
    db.close();
  }
});

test('draft approve and reject go through the integrity-preserving command path', async () => {
  const { listDir, sinkDir, db, draft } = await seedPendingDraft();
  const previousSink = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    // Reject path: command layer updates status, not ad-hoc SQL from the UI server.
    const rejectOther = await (async () => {
      const second = createList();
      const secondDb = openListDb({ listDir: second.listDir, readonly: false });
      try {
        await runStep({ db: secondDb, listDir: second.listDir, intent: 'draft' });
        const other = secondDb.prepare('SELECT draft_id FROM drafts WHERE row_id = ?').get('record_1');
        const rejected = rejectDraftForViz(second.listDir, other.draft_id, 'not a fit');
        assert.equal(rejected.ok, true);
        assert.equal(rejected.status, 'rejected');
        const row = secondDb.prepare('SELECT status, reason FROM drafts WHERE draft_id = ?')
          .get(other.draft_id);
        assert.equal(row.status, 'rejected');
        assert.equal(row.reason, 'not a fit');
      } finally {
        secondDb.close();
      }
    })();
    assert.equal(rejectOther, undefined);

    // Approve via the viz path (same module the HTTP server calls).
    const approved = approveDraftForViz(listDir, draft.draft_id);
    assert.equal(approved.ok, true);
    assert.equal(approved.approved, 1);
    const ready = db.prepare('SELECT status, content_binding_json FROM drafts WHERE draft_id = ?')
      .get(draft.draft_id);
    assert.equal(ready.status, 'ready');
    const binding = JSON.parse(String(ready.content_binding_json || '{}'));
    assert.ok(binding.provider_envelope);
    assert.equal(binding.provider_envelope.recipient, 'owner@example.test');
    assert.equal(binding.provider_envelope.from, 'sender@example.test');
    assert.equal(binding.provider_envelope.mailbox_id, 'mailbox_1');

    // Content divergence after approval via the NEW path must still refuse send.
    writeFileSync(join(listDir, 'outbound.yaml'), outboundYaml({
      body: 'New compliance copy.',
      templateVersion: 2,
      withDetail: true,
    }));
    const attempted = await runStep({ db, listDir, intent: 'send' });
    assert.equal(attempted.status, 'skipped', JSON.stringify(attempted));
    assert.match(String(attempted.reason), /content changed|superseded/i);
    assert.equal(readdirSync(sinkDir).filter((file) => file.endsWith('.json')).length, 0);
    const drafts = db.prepare('SELECT status, body FROM drafts ORDER BY created_at').all();
    assert.deepEqual(drafts, [
      { status: 'superseded', body: 'Old approved copy.' },
      { status: 'pending_approval', body: 'New compliance copy.' },
    ]);
  } finally {
    db.close();
    if (previousSink === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = previousSink;
  }
});

test('drafts list defaults to pending_approval and exposes status counts', async () => {
  const { listDir, db, draft } = await seedPendingDraft();
  try {
    approveDraftForViz(listDir, draft.draft_id);
    // Insert a rejected sibling by drafting again is blocked; reject a hand-made draft.
    ensureRecordColumns({ db, columns: [] });
    db.prepare(`
      INSERT INTO drafts (
        draft_id, row_id, sequence_name, step_number, step_id, channel, status,
        subject, body, reason, artifacts_json, content_binding_json,
        content_hash, template_id, template_version, content_source,
        created_at, updated_at
      ) VALUES (
        'd_rejected', 'record_1', 'default', 1, 'email_1', 'email', 'rejected',
        'No', 'Nope', 'manual', '{}', '{}',
        'abc', 'outreach', 1, 'rendered',
        datetime('now'), datetime('now')
      )
    `).run();

    const pending = getDraftsForViz(listDir);
    assert.equal(pending.status, 'pending_approval');
    assert.equal(pending.counts.ready, 1);
    assert.equal(pending.counts.rejected, 1);
    assert.equal(pending.counts.pending_approval, 0);

    const ready = getDraftsForViz(listDir, 'ready');
    assert.equal(ready.drafts.length, 1);
    assert.equal(ready.drafts[0].draft_id, draft.draft_id);

    const rejected = getDraftsForViz(listDir, 'rejected');
    assert.equal(rejected.drafts.some((row) => row.draft_id === 'd_rejected'), true);
  } finally {
    db.close();
  }
});
