/**
 * Send-path silent catch closures — approved envelope parse + pre-claim idempotency.
 *
 * Bug classes:
 * 1. Malformed content_binding_json on a ready draft silently left draftEnvelope
 *    null; send rebuilt authorization from the current invocation (forbidden).
 * 2. Malformed prior idempotency payload_json silently emptied knownPid, weakening
 *    duplicate-send reconcile before claim.
 *
 * Visibility model: stage_review_open_failed: — a reason / readiness_blocker an
 * operator can find, never a bare catch.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { openListDb, insertDraft, ensureRecordColumns } from '../dist/orchestrator/runtime/db.js';
import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';
import {
  buildIdempotencyKey,
  getIdempotencyRecord,
} from '../dist/orchestrator/runtime/idempotency.js';
import { treasureValleyEnrichmentBudget } from './fixtures/treatment-strategy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SMTP_SCRIPT = join(ROOT, 'scripts/smtp-send.mjs');

const projectYaml = `
list:
  name: Send Path Silent Catch
business:
  name: Mission
  description: Test
  icp: Test
  offer: Test
pipeline: []
sequences:
  default:
    steps: []
policy:
  version: tv-pipeline-v1
  prohibited_channels: [sms]
  prohibited_task_types: [visit, field_visit]
  enforce_readiness: false
score:
  enrichment_budget: ${JSON.stringify(treasureValleyEnrichmentBudget)}
channels:
  email:
    draft_approval_required: true
`;

const smtpMcpJson = (sinkDir) => JSON.stringify({
  mcpServers: {
    smtp: {
      type: 'command',
      command: process.execPath,
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
            subject: { type: 'string' },
            body: { type: 'string' },
            from: { type: 'string' },
          },
          required: ['to'],
        },
        invoke: {
          argv: [
            'send', '--to', '{{to}}', '--subject', '{{subject}}',
            '--body', '{{body}}', '--from', '{{from}}', '--json',
          ],
          result: 'stdout_json',
        },
      }],
    },
  },
}, null, 2);

const nextAction = (accountId) => JSON.stringify({
  action_id: `na_${accountId}`,
  action_type: 'send_email',
  account_id: accountId,
  contact_id: 'c_owner',
  lifecycle_stage: 'contacted',
  sequence_state: 'active',
  work_state: 'executing_external_action',
  reason: 'send-path silent catch fixture',
  on_success: 'continue',
});

const emailStep = {
  kind: 'send_email',
  id: 'email_1',
  draft_approval_required: true,
  config: {
    action: 'tool_call',
    tool: {
      server: 'smtp',
      tools: ['SMTP_SEND'],
      effect: { class: 'human_contact', channel: 'email' },
    },
    args_map: { to: 'contact_email' },
    args: {
      subject: 'Rebuilt would be wrong',
      body: 'This body must not ship if the approved envelope is unreadable.',
    },
    daily_cap: 999,
    output_map: { message_id: 'message_id', provider_id: 'message_id' },
    idempotency: { key_source: ['_row_id'], scope: 'list' },
  },
};

const readyDraft = ({ draftId, rowId, subject, body, envelope }) => ({
  draft_id: draftId,
  row_id: rowId,
  sequence_name: 'default',
  step_number: 0,
  step_id: 'email_1',
  channel: 'email',
  status: 'ready',
  subject,
  body,
  // Hand-edited path: isolate envelope/idempotency from re-render gate.
  content_source: 'human_edited',
  content_binding: {
    provider_envelope: envelope || {
      subject,
      body,
      from: 'sender@silent-catch.test',
      recipient: 'owner@example-silent.test',
    },
  },
});

const seedList = ({ rowId = 'acct_silent_1' } = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-silent-catch-'));
  const sinkDir = join(listDir, 'smtp-sink');
  mkdirSync(sinkDir, { recursive: true });
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml);
  writeFileSync(join(listDir, 'operator.md'), 'silent catch tests');
  writeFileSync(join(listDir, 'mcp.json'), smtpMcpJson(sinkDir));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: [
      'lifecycle_stage',
      'account_sequence_state',
      'work_state',
      'next_action_json',
      'active_contact_id',
      'contact_email',
      'contact_name',
      'treatment_tier',
      'suppressed',
      'email_last_from',
      'last_error',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      contact_email, contact_name, lifecycle_stage, account_sequence_state, work_state,
      next_action_json, active_contact_id, treatment_tier, suppressed, email_last_from,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      ?, 'Silent Catch HVAC', 'default', 'active', 0,
      'owner@example-silent.test', 'Pat Owner', 'contacted', 'active', 'executing_external_action',
      ?, 'c_owner', 'B', 0, 'sender@silent-catch.test',
      ?, ?, ?, ?
    )
  `).run(rowId, nextAction(rowId), now, now, now, now);
  return { listDir, sinkDir, db, rowId };
};

const runSend = async ({ listDir, db, rowId, step = emailStep }) => {
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  return executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Send Path Silent Catch',
    db,
    record,
    sequenceName: 'default',
    stepNumber: 0,
    step,
    sequence: { steps: [step] },
    channelHint: 'email',
    intent: 'send',
    dryRun: false,
  });
};

const withSmtpSink = async (fn) => {
  const prev = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = prev;
  }
};

const buildSendIdemKey = (record) => buildIdempotencyKey({
  keySource: ['_row_id'],
  record,
  scope: 'list',
  context: {
    step_id: 'email_1',
    active_contact_id: 'c_owner',
    contact_id: 'c_owner',
    channel: 'email',
    recipient: 'owner@example-silent.test',
  },
});

// ---------------------------------------------------------------------------
// 1 & 2 — approved draft envelope parse
// ---------------------------------------------------------------------------

test('malformed content_binding_json on ready draft refuses send (no rebuilt envelope)', async () => {
  await withSmtpSink(async () => {
    const { listDir, sinkDir, db, rowId } = seedList({ rowId: 'acct_malformed_bind' });
    insertDraft({
      db,
      draft: readyDraft({
        draftId: 'draft_malformed',
        rowId,
        subject: 'Approved subject',
        body: 'Approved body that a human reviewed.',
      }),
    });
    // Corrupt the frozen binding after insert (insertDraft always safeJson-encodes).
    db.prepare(`
      UPDATE drafts SET content_binding_json = ? WHERE draft_id = ?
    `).run('{not-valid-json', 'draft_malformed');

    const sinkBefore = readdirSync(sinkDir).filter((f) => f.endsWith('.json'));
    const result = await runSend({ listDir, db, rowId });

    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.match(String(result.reason || ''), /approved_envelope_unreadable/);
    assert.ok(
      Array.isArray(result.readiness_blockers)
        && result.readiness_blockers.includes('approved_envelope_unreadable'),
      `expected readiness_blocker approved_envelope_unreadable, got ${JSON.stringify(result)}`,
    );
    assert.match(String(result.reason || ''), /refusing to send a rebuilt envelope/i);

    const sinkAfter = readdirSync(sinkDir).filter((f) => f.endsWith('.json'));
    assert.equal(sinkAfter.length, sinkBefore.length, 'must not transmit after unreadable envelope');
    db.close();
  });
});

test('well-formed content_binding_json sends the approved envelope (no regression)', async () => {
  await withSmtpSink(async () => {
    const { listDir, sinkDir, db, rowId } = seedList({ rowId: 'acct_good_bind' });
    const approvedSubject = 'Exact approved subject';
    const approvedBody = 'Exact approved body from frozen envelope.';
    insertDraft({
      db,
      draft: readyDraft({
        draftId: 'draft_good',
        rowId,
        subject: approvedSubject,
        body: approvedBody,
      }),
    });

    const result = await runSend({ listDir, db, rowId });
    assert.equal(result.status, 'sent', JSON.stringify(result));
    assert.ok(result.provider_id);

    const sinkFiles = readdirSync(sinkDir).filter((f) => f.endsWith('.json'));
    assert.ok(sinkFiles.length >= 1, 'expected SMTP sink file');
    const sent = JSON.parse(readFileSync(join(sinkDir, sinkFiles[0]), 'utf8'));
    assert.equal(sent.subject, approvedSubject);
    assert.equal(sent.body, approvedBody);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 3 — prior idempotency payload parse
// ---------------------------------------------------------------------------

test('malformed prior idempotency payload refuses resend when provider_id column empty', async () => {
  await withSmtpSink(async () => {
    const { listDir, sinkDir, db, rowId } = seedList({ rowId: 'acct_idem_bad_payload' });
    insertDraft({
      db,
      draft: readyDraft({
        draftId: 'draft_idem_bad',
        rowId,
        subject: 'Idem subject',
        body: 'Idem body',
      }),
    });

    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
    const idemKey = buildSendIdemKey(record);
    // Prior failed attempt: provider acceptance may live only in payload_json.
    // Malformed payload + empty provider_id column must not re-claim / re-send.
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO idempotency (id, idem_key, scope, status, provider_id, payload_json, created_at, updated_at)
      VALUES (?, ?, 'list', 'failed', '', ?, ?, ?)
    `).run(
      `idem_${rowId}`,
      idemKey,
      '{not-json-but-may-have-held-provider-id',
      now,
      now,
    );

    const sinkBefore = readdirSync(sinkDir).filter((f) => f.endsWith('.json'));
    const result = await runSend({ listDir, db, rowId });

    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.match(String(result.reason || ''), /idempotency_payload_unreadable/);
    assert.ok(
      Array.isArray(result.readiness_blockers)
        && result.readiness_blockers.includes('idempotency_payload_unreadable'),
      JSON.stringify(result),
    );
    assert.match(String(result.reason || ''), /refusing resend/i);

    const sinkAfter = readdirSync(sinkDir).filter((f) => f.endsWith('.json'));
    assert.equal(sinkAfter.length, sinkBefore.length, 'must not re-transmit when payload unreadable');

    const prior = getIdempotencyRecord({ db, idemKey, scope: 'list' });
    assert.equal(prior.status, 'failed', 'must not re-claim over unreadable prior payload');
    db.close();
  });
});

test('malformed prior payload still reconciles when provider_id column is known', async () => {
  await withSmtpSink(async () => {
    const { listDir, sinkDir, db, rowId } = seedList({ rowId: 'acct_idem_col_pid' });
    insertDraft({
      db,
      draft: readyDraft({
        draftId: 'draft_idem_col',
        rowId,
        subject: 'Idem subject',
        body: 'Idem body',
      }),
    });

    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
    const idemKey = buildSendIdemKey(record);
    const knownProviderId = 'smtp_already_accepted_abc';
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO idempotency (id, idem_key, scope, status, provider_id, payload_json, created_at, updated_at)
      VALUES (?, ?, 'list', 'pending', ?, ?, ?, ?)
    `).run(
      `idem_${rowId}`,
      idemKey,
      knownProviderId,
      '{broken-payload',
      now,
      now,
    );

    const sinkBefore = readdirSync(sinkDir).filter((f) => f.endsWith('.json'));
    const result = await runSend({ listDir, db, rowId });

    assert.equal(result.status, 'skipped', JSON.stringify(result));
    assert.match(String(result.reason || ''), /already sent/i);
    assert.match(String(result.reason || ''), /idempotency_payload_unreadable/);
    assert.equal(result.provider_id, knownProviderId);

    const sinkAfter = readdirSync(sinkDir).filter((f) => f.endsWith('.json'));
    assert.equal(sinkAfter.length, sinkBefore.length, 'reconcile must not re-transmit');

    const after = getIdempotencyRecord({ db, idemKey, scope: 'list' });
    assert.equal(after.status, 'sent');
    assert.equal(after.provider_id, knownProviderId);
    db.close();
  });
});

test('normal idempotency: second send skips without re-transmission', async () => {
  await withSmtpSink(async () => {
    const { listDir, sinkDir, db, rowId } = seedList({ rowId: 'acct_idem_normal' });
    insertDraft({
      db,
      draft: readyDraft({
        draftId: 'draft_idem_ok',
        rowId,
        subject: 'Normal idem subject',
        body: 'Normal idem body',
      }),
    });

    const first = await runSend({ listDir, db, rowId });
    assert.equal(first.status, 'sent', JSON.stringify(first));
    const sinkAfterFirst = readdirSync(sinkDir).filter((f) => f.endsWith('.json'));
    assert.ok(sinkAfterFirst.length >= 1);

    const second = await runSend({ listDir, db, rowId });
    assert.equal(second.status, 'skipped', JSON.stringify(second));
    assert.match(String(second.reason || ''), /already sent/i);
    const sinkAfterSecond = readdirSync(sinkDir).filter((f) => f.endsWith('.json'));
    assert.equal(sinkAfterSecond.length, sinkAfterFirst.length);
    db.close();
  });
});
