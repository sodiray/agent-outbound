/**
 * Real-path proofs for channel readiness, review gates, idempotency, and
 * forbidden channels. Drives shipped entry points only (executeChannelStep,
 * executeStepBatch, contact-campaign allocateMail, Unipile readiness contract).
 *
 * Channels covered:
 * - email: draft_approval_required + sink send + idempotent re-send
 * - phone: human_phone parks awaiting_manual; visit/sms rejected
 * - linkedin: linkedin_connect not forbidden; readiness gates before execute
 * - mail: standard_postcard / golden_ticket allowed; one-mail allocate
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRequire } from 'node:module';
import { openListDb, insertDraft, ensureRecordColumns } from '../dist/orchestrator/runtime/db.js';
import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';
import { draftsApproveCommand } from '../dist/commands/drafts.js';
import {
  evaluateUnipileReadiness,
  executeUnipileLinkedinConnect,
  isLinkedinConnectKind,
  UNIPILE_ENV_KEYS,
} from '../dist/orchestrator/channels/unipile.js';
import { executeStepBatch } from '../dist/orchestrator/pipeline/step-executor.js';
import {
  assertWorkAllowed,
  isForbiddenChannelKind,
  isForbiddenTaskType,
} from '../dist/orchestrator/policy/forbidden-channels.js';
import {
  buildContactPlan,
  allocateMail,
} from '../dist/orchestrator/policy/contact-campaign.js';
import { evaluateOutboundReadiness } from '../dist/orchestrator/policy/readiness.js';
import { guardChannelExecution, readinessInputFromRecord } from '../dist/orchestrator/policy/apply-record.js';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SMTP_SCRIPT = join(ROOT, 'scripts/smtp-send.mjs');

const projectYaml = `
list:
  name: Channel Real Path
business:
  name: Mission
  description: Test
  icp: Test
  offer: Test
pipeline:
  - kind: pipeline
    id: tier_a
    steps:
      - kind: send_email
        id: email_1
        side_effecting: true
        draft_approval_required: true
        config:
          action: tool_call
          tool:
            server: smtp
            tools:
              - SMTP_SEND
          args_map:
            to: contact_email
          args:
            subject: Operational snapshot
            body: Hello from channel real-path proof
          daily_cap: 10
          output_map:
            message_id: message_id
            provider_id: message_id
          idempotency:
            key_source:
              - _row_id
            scope: list
      - kind: linkedin_connect
        id: linkedin_1
        side_effecting: true
        draft_approval_required: true
        config:
          channel: linkedin
          invite_message: Hello — I would be glad to connect.
      - kind: manual_task
        id: phone_1
        config:
          task_type: human_phone
          channel: phone
      - kind: manual_task
        id: mail_golden
        config:
          task_type: golden_ticket
          channel: mail
  - kind: pipeline
    id: tier_b
    steps:
      - kind: manual_task
        id: mail_standard
        config:
          task_type: standard_postcard
          channel: mail
sequences:
  default:
    steps: []
policy:
  version: tv-pipeline-v1
  forbidden_channels: [send_sms, visit, field_visit, automated_voice]
  enforce_readiness: true
channels:
  email:
    draft_approval_required: true
  phone:
    sms: false
  mail:
    treatments:
      - standard_postcard
      - golden_ticket
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

/** Default outbound next_action so enforce_readiness fails closed only on real blockers. */
const defaultNextActionJson = (accountId) => JSON.stringify({
  action_id: `na_${accountId}`,
  action_type: 'prepare_outbound',
  account_id: accountId,
  contact_id: 'c_owner',
  lifecycle_stage: 'cold',
  sequence_state: 'active',
  work_state: 'executing_external_action',
  reason: 'channel real-path fixture',
  on_success: 'continue',
});

const createList = (recordOverrides = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-channels-'));
  const sinkDir = join(listDir, 'smtp-sink');
  mkdirSync(sinkDir, { recursive: true });
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml);
  writeFileSync(join(listDir, 'operator.md'), 'channel real-path');
  writeFileSync(join(listDir, 'mcp.json'), smtpMcpJson(sinkDir));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  // Default fixture is readiness-ready for enforce_readiness:true happy paths
  // (email send, linkedin contract). Override for hard-readiness negative tests.
  const base = {
    _row_id: 'fixture_channel_1',
    business_name: 'Channel HVAC',
    contact_email: 'owner@example-channel-hvac.test',
    contact_name: 'Pat Owner',
    fit_score: 80,
    identity_confidence: 90,
    email_confidence: 80,
    email_verification_confidence: 80,
    treatment_tier: 'A',
    eligibility_outcome: 'eligible',
    preliminary_snapshot: 'seed snapshot for readiness',
    linkedin_url: 'https://www.linkedin.com/in/pat-owner-test',
    linkedin_confidence: 70,
    suppressed: 0,
    active_contact_id: 'c_owner',
    named_buyer_status: 'confirmed',
    observed_buyer_name: 'Pat Owner',
    buyer_affiliation_status: 'confirmed',
    buying_center_role: 'owner',
    email_last_from: 'sender@channel-real-path.test',
    next_action_json: defaultNextActionJson('fixture_channel_1'),
    ...recordOverrides,
  };
  ensureRecordColumns({
    db,
    columns: [
      'identity_confidence', 'email_confidence', 'email_verification_confidence',
      'treatment_tier', 'eligibility_outcome', 'preliminary_snapshot',
      'linkedin_url', 'linkedin_confidence', 'suppressed',
      'contact_email', 'contact_name', 'next_action_json', 'active_contact_id',
      'email_last_from',
      'named_buyer_status', 'observed_buyer_name', 'buyer_affiliation_status', 'buying_center_role',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, contact_email, contact_name,
      fit_score, identity_confidence, email_confidence, email_verification_confidence,
      treatment_tier, eligibility_outcome, preliminary_snapshot,
      linkedin_url, linkedin_confidence, suppressed, next_action_json, active_contact_id,
      named_buyer_status, observed_buyer_name, buyer_affiliation_status, buying_center_role,
      email_last_from,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, ?, 'default', 'idle', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    base._row_id,
    base.business_name,
    base.contact_email,
    base.contact_name,
    base.fit_score,
    base.identity_confidence,
    base.email_confidence,
    base.email_verification_confidence,
    base.treatment_tier,
    base.eligibility_outcome,
    base.preliminary_snapshot,
    base.linkedin_url,
    base.linkedin_confidence,
    base.suppressed,
    base.next_action_json,
    base.active_contact_id,
    base.named_buyer_status,
    base.observed_buyer_name,
    base.buyer_affiliation_status,
    base.buying_center_role,
    base.email_last_from,
    now,
    now,
    now,
    now,
  );
  db.close();
  return { listDir, sinkDir };
};

const emailStep = {
  kind: 'send_email',
  id: 'email_1',
  draft_approval_required: true,
  config: {
    action: 'tool_call',
    tool: { server: 'smtp', tools: ['SMTP_SEND'] },
    args_map: { to: 'contact_email' },
    args: {
      subject: 'Operational snapshot',
      body: 'Hello from channel real-path proof',
    },
    daily_cap: 10,
    output_map: { message_id: 'message_id', provider_id: 'message_id' },
    idempotency: { key_source: ['_row_id'], scope: 'list' },
  },
};

// ---------------------------------------------------------------------------
// Email: review gate + sink + idempotency
// ---------------------------------------------------------------------------

test('email: draft_approval_required blocks send without ready draft', async () => {
  const prev = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    const { listDir, sinkDir } = createList();
    const db = openListDb({ listDir, readonly: false });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_channel_1');

    const blocked = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Channel Real Path',
      toolCatalog: null,
      db,
      record,
      sequenceName: 'default',
      stepNumber: 1,
      step: emailStep,
      sequence: { steps: [] },
      channelHint: 'email',
      intent: 'send',
    });
    assert.equal(blocked.status, 'skipped');
    assert.match(String(blocked.reason), /draft approval required/i);
    assert.equal(existsSync(sinkDir) ? readdirSync(sinkDir).filter((f) => f.endsWith('.json')).length : 0, 0);

    // Pending draft alone still blocks send
    insertDraft({
      db,
      draft: {
        draft_id: 'draft_pending_1',
        row_id: 'fixture_channel_1',
        sequence_name: 'default',
        step_number: 1,
        step_id: 'email_1',
        channel: 'email',
        status: 'pending_approval',
        subject: 'Pending subject',
        body: 'Pending body',
      },
    });
    const stillBlocked = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Channel Real Path',
      db,
      record,
      sequenceName: 'default',
      stepNumber: 1,
      step: emailStep,
      sequence: { steps: [] },
      channelHint: 'email',
      intent: 'send',
    });
    assert.equal(stillBlocked.status, 'skipped');
    assert.match(String(stillBlocked.reason), /pending approval|approval required/i);
    db.close();
  } finally {
    if (prev === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = prev;
  }
});

test('email: ready draft sends via sink; second send is idempotent skip', async () => {
  const prev = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    const { listDir, sinkDir } = createList();
    const db = openListDb({ listDir, readonly: false });
    let record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_channel_1');

    insertDraft({
      db,
      draft: {
        draft_id: 'draft_ready_1',
        row_id: 'fixture_channel_1',
        sequence_name: 'default',
        step_number: 1,
        step_id: 'email_1',
        channel: 'email',
        status: 'ready',
        subject: 'Approved subject',
        body: 'Approved body for sink send',
      },
    });
    record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_channel_1');

    const first = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Channel Real Path',
      db,
      record,
      sequenceName: 'default',
      stepNumber: 1,
      step: emailStep,
      sequence: { steps: [] },
      channelHint: 'email',
      intent: 'send',
    });
    assert.equal(first.status, 'sent', `first send failed: ${JSON.stringify(first)}`);
    assert.ok(first.provider_id);
    const sinkFiles = readdirSync(sinkDir).filter((f) => f.endsWith('.json'));
    assert.ok(sinkFiles.length >= 1, 'expected at least one SMTP sink file');
    const sent = JSON.parse(readFileSync(join(sinkDir, sinkFiles[0]), 'utf8'));
    assert.equal(sent.subject, 'Approved subject');
    assert.equal(sent.body, 'Approved body for sink send');

    const second = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Channel Real Path',
      db,
      record,
      sequenceName: 'default',
      stepNumber: 1,
      step: emailStep,
      sequence: { steps: [] },
      channelHint: 'email',
      intent: 'send',
    });
    assert.equal(second.status, 'skipped');
    assert.match(String(second.reason), /already sent/i);
    const sinkAfter = readdirSync(sinkDir).filter((f) => f.endsWith('.json'));
    assert.equal(sinkAfter.length, sinkFiles.length, 'idempotent re-send must not grow sink');
    db.close();
  } finally {
    if (prev === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = prev;
  }
});

test('email: a send with no derivable idempotency key refuses before transmission', async () => {
  const prev = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    const { listDir, sinkDir } = createList();
    const db = openListDb({ listDir, readonly: false });
    insertDraft({
      db,
      draft: {
        draft_id: 'draft_no_idempotency',
        row_id: 'fixture_channel_1',
        sequence_name: 'default',
        step_number: 1,
        step_id: 'email_no_idempotency',
        channel: 'email',
        status: 'ready',
        subject: 'Approved subject',
        body: 'Approved body',
      },
    });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_channel_1');
    const result = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Channel Real Path',
      db,
      record,
      sequenceName: 'default',
      stepNumber: 1,
      step: {
        ...emailStep,
        id: 'email_no_idempotency',
        config: { ...emailStep.config, idempotency: undefined },
      },
      sequence: { steps: [] },
      channelHint: 'email',
      intent: 'send',
    });
    assert.equal(result.status, 'failed');
    assert.match(String(result.reason), /idempotency key is required/i);
    assert.equal(readdirSync(sinkDir).filter((f) => f.endsWith('.json')).length, 0);
    db.close();
  } finally {
    if (prev === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = prev;
  }
});

test('email: concurrent same-record sends transmit exactly once', async () => {
  const prev = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    const { listDir, sinkDir } = createList();
    const db = openListDb({ listDir, readonly: false });
    insertDraft({
      db,
      draft: {
        draft_id: 'draft_concurrent_idempotency',
        row_id: 'fixture_channel_1',
        sequence_name: 'default',
        step_number: 1,
        step_id: 'email_1',
        channel: 'email',
        status: 'ready',
        subject: 'Approved subject',
        body: 'Approved body',
      },
    });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_channel_1');
    const send = () => executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Channel Real Path',
      db,
      record,
      sequenceName: 'default',
      stepNumber: 1,
      step: emailStep,
      sequence: { steps: [] },
      channelHint: 'email',
      intent: 'send',
    });
    const outcomes = await Promise.all([send(), send()]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'sent').length, 1);
    assert.equal(readdirSync(sinkDir).filter((f) => f.endsWith('.json')).length, 1);
    db.close();
  } finally {
    if (prev === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = prev;
  }
});

test('email: compose outputs mapped by args_map become the pending draft content', async () => {
  const { listDir, sinkDir } = createList();
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: ['email_subject', 'email_body'] });
  db.prepare(`
    UPDATE records
    SET email_subject = ?, email_body = ?
    WHERE _row_id = ?
  `).run(
    'Composed subject',
    'Composed body from the prior compose step.',
    'fixture_channel_1',
  );
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_channel_1');
  const step = {
    ...emailStep,
    id: 'email_compose_map',
    config: {
      ...emailStep.config,
      args_map: {
        to: 'contact_email',
        to_name: 'contact_name',
        subject: 'email_subject',
        body: 'email_body',
      },
      args: {
        subject: 'Fallback subject',
        body: 'Fallback body',
      },
    },
  };

  const out = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Channel Real Path',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'draft-content',
    stepNumber: 2,
    step,
    sequence: { steps: [] },
    channelHint: 'email',
    intent: 'draft',
  });

  assert.equal(out.status, 'drafted', JSON.stringify(out));
  const draft = db.prepare(`
    SELECT draft_id, status, subject, body
    FROM drafts
    WHERE row_id = ? AND step_id = ?
  `).get('fixture_channel_1', 'email_compose_map');
  assert.equal(draft.status, 'pending_approval');
  assert.equal(draft.subject, 'Composed subject');
  assert.equal(draft.body, 'Composed body from the prior compose step.');
  db.prepare('UPDATE drafts SET status = ? WHERE draft_id = ?').run('ready', draft.draft_id);
  const sendRecord = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_channel_1');
  const sent = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Channel Real Path',
    toolCatalog: null,
    db,
    record: sendRecord,
    sequenceName: 'draft-content',
    stepNumber: 2,
    step,
    sequence: { steps: [] },
    channelHint: 'email',
    intent: 'send',
  });
  assert.equal(sent.status, 'sent', JSON.stringify(sent));
  const sinkFiles = readdirSync(sinkDir).filter((file) => file.endsWith('.json'));
  assert.equal(sinkFiles.length, 1);
  const delivered = JSON.parse(readFileSync(join(sinkDir, sinkFiles[0]), 'utf8'));
  assert.equal(delivered.subject, draft.subject);
  assert.equal(delivered.body, draft.body);
  db.close();
});

test('email: template draft content remains unchanged', async () => {
  const { listDir } = createList();
  const db = openListDb({ listDir, readonly: false });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_channel_1');
  const step = {
    ...emailStep,
    id: 'email_template_draft',
    config: {
      ...emailStep.config,
      args: {},
      template_context: {
        subject: 'Template subject',
        body: 'Template body preserved exactly.\n\nRay',
      },
    },
  };

  const out = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Channel Real Path',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'draft-content',
    stepNumber: 3,
    step,
    sequence: { steps: [] },
    channelHint: 'email',
    intent: 'draft',
  });

  assert.equal(out.status, 'drafted', JSON.stringify(out));
  const draft = db.prepare(`
    SELECT subject, body
    FROM drafts
    WHERE row_id = ? AND step_id = ?
  `).get('fixture_channel_1', 'email_template_draft');
  assert.deepEqual(draft, {
    subject: 'Template subject',
    body: 'Template body preserved exactly.\n\nRay',
  });
  db.close();
});

test('email: incomplete draft content fails without creating pending approval', async () => {
  const { listDir } = createList();
  const db = openListDb({ listDir, readonly: false });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_channel_1');
  const step = {
    ...emailStep,
    id: 'email_incomplete_draft',
    config: {
      ...emailStep.config,
      args: {},
      template_context: {},
    },
  };

  const out = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Channel Real Path',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'draft-content',
    stepNumber: 4,
    step,
    sequence: { steps: [] },
    channelHint: 'email',
    intent: 'draft',
  });

  assert.equal(out.status, 'failed', JSON.stringify(out));
  assert.match(String(out.reason), /missing subject and body/i);
  const pending = db.prepare(`
    SELECT COUNT(*) AS n
    FROM drafts
    WHERE row_id = ? AND step_id = ? AND status = 'pending_approval'
  `).get('fixture_channel_1', 'email_incomplete_draft');
  assert.equal(Number(pending.n), 0);
  const failedRecord = db.prepare('SELECT last_error FROM records WHERE _row_id = ?')
    .get('fixture_channel_1');
  assert.match(String(failedRecord.last_error), /draft content incomplete/i);
  db.close();
});

test('email: missing subject and body fail closed before SMTP receives anything', async () => {
  const prev = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    const { listDir, sinkDir } = createList();
    const db = openListDb({ listDir, readonly: false });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_channel_1');
    const step = {
      ...emailStep,
      id: 'email_missing_copy',
      draft_approval_required: false,
      config: {
        ...emailStep.config,
        args: {},
      },
    };
    const out = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Channel Real Path',
      toolCatalog: null,
      db,
      record,
      sequenceName: 'missing-copy',
      stepNumber: 1,
      step,
      sequence: { steps: [] },
      channelHint: 'email',
      intent: 'send',
    });

    assert.equal(out.status, 'failed');
    assert.match(String(out.reason), /email_missing_copy.*subject and body/i);
    assert.equal(readdirSync(sinkDir).filter((file) => file.endsWith('.json')).length, 0);
    db.close();
  } finally {
    if (prev === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = prev;
  }
});

test('email: incomplete pending draft cannot be approved', () => {
  const { listDir } = createList();
  const db = openListDb({ listDir, readonly: false });
  insertDraft({
    db,
    draft: {
      draft_id: 'draft_incomplete_approval',
      row_id: 'fixture_channel_1',
      sequence_name: 'draft-content',
      step_number: 5,
      step_id: 'email_incomplete_approval',
      channel: 'email',
      status: 'pending_approval',
      subject: '',
      body: 'A body without a subject cannot be approved.',
    },
  });
  db.close();

  assert.throws(
    () => draftsApproveCommand({ list: listDir, draftId: 'draft_incomplete_approval' }),
    /draft_content_incomplete:missing_subject/i,
  );
  const verified = openListDb({ listDir, readonly: true });
  const draft = verified.prepare('SELECT status FROM drafts WHERE draft_id = ?')
    .get('draft_incomplete_approval');
  assert.equal(draft.status, 'pending_approval');
  verified.close();
});

// ---------------------------------------------------------------------------
// Hard readiness (enforce_readiness: true)
// ---------------------------------------------------------------------------

test('enforce_readiness: low identity confidence / no email → send_email skipped with blockers', async () => {
  const prev = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    const { listDir, sinkDir } = createList({
      contact_email: '',
      identity_confidence: 40,
      email_confidence: 0,
      email_verification_confidence: 0,
    });
    const db = openListDb({ listDir, readonly: false });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_channel_1');
    assert.equal(Number(record.identity_confidence), 40);
    assert.equal(String(record.contact_email || ''), '');

    // Unit-level: readiness from record fields is not ready
    const readiness = evaluateOutboundReadiness(readinessInputFromRecord({
      record,
      stepKind: 'send_email',
      channel: 'email',
      stepId: 'email_1',
    }));
    assert.equal(readiness.ready, false);
    assert.ok(readiness.blockers.some((b) => b.includes('identity_confidence') || b === 'identity_confidence_below_80'));
    assert.ok(
      readiness.blockers.some((b) => b.includes('email_not_ready') || b.includes('confidence:email') || b.includes('no_ready_channel')),
    );

    const guard = guardChannelExecution({
      config: { policy: { forbidden_channels: ['send_sms', 'visit'], enforce_readiness: true } },
      record,
      stepKind: 'send_email',
      channel: 'email',
      stepId: 'email_1',
      intent: 'send',
      dryRun: false,
    });
    assert.equal(guard.allowed, false);
    assert.match(String(guard.reason), /readiness_not_ready/);
    assert.ok(Array.isArray(guard.blockers) && guard.blockers.length > 0);

    // Production path: executeChannelStep skips (does not send)
    insertDraft({
      db,
      draft: {
        draft_id: 'draft_ready_blocked',
        row_id: 'fixture_channel_1',
        sequence_name: 'default',
        step_number: 1,
        step_id: 'email_1',
        channel: 'email',
        status: 'ready',
        subject: 'Should not send',
        body: 'Blocked by readiness',
      },
    });
    const out = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Channel Real Path',
      db,
      record,
      sequenceName: 'default',
      stepNumber: 1,
      step: emailStep,
      sequence: { steps: [] },
      channelHint: 'email',
      intent: 'send',
    });
    assert.equal(out.status, 'skipped');
    // Fail-closed: either readiness hard-block or active-contact email gate (order is product).
    assert.match(
      String(out.reason),
      /readiness_not_ready|no email for send|refuse email send|identity_confidence/i,
    );
    assert.equal(existsSync(sinkDir) ? readdirSync(sinkDir).filter((f) => f.endsWith('.json')).length : 0, 0);

    // Draft intent is NOT hard-blocked by readiness
    const draftOk = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Channel Real Path',
      db,
      record,
      sequenceName: 'default',
      stepNumber: 1,
      step: emailStep,
      sequence: { steps: [] },
      channelHint: 'email',
      intent: 'draft',
    });
    assert.equal(draftOk.status, 'drafted');
    assert.equal(draftOk.provider_id, '');
    assert.ok(draftOk.draft_id);
    assert.notEqual(String(draftOk.reason || ''), 'readiness_not_ready');
    assert.doesNotMatch(String(draftOk.reason || ''), /^readiness_not_ready/);

    // human_phone still parks awaiting_manual (not readiness-blocked)
    const phone = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Channel Real Path',
      db,
      record,
      sequenceName: 'default',
      stepNumber: 3,
      step: {
        kind: 'manual_task',
        id: 'phone_1',
        config: { task_type: 'human_phone', channel: 'phone' },
      },
      sequence: { steps: [] },
      channelHint: 'phone',
      intent: 'send',
    });
    assert.equal(phone.status, 'skipped');
    assert.equal(phone.reason, 'awaiting_manual');

    db.close();
  } finally {
    if (prev === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = prev;
  }
});

test('enforce_readiness: linkedin_connect blocked when identity low; not forbidden', async () => {
  const { listDir } = createList({
    identity_confidence: 20,
    linkedin_url: '',
    linkedin_confidence: 0,
  });
  const db = openListDb({ listDir, readonly: false });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_channel_1');

  const guard = guardChannelExecution({
    config: { policy: { forbidden_channels: ['send_sms', 'visit'], enforce_readiness: true } },
    record,
    stepKind: 'linkedin_connect',
    channel: 'linkedin',
    stepId: 'linkedin_1',
    intent: 'send',
  });
  assert.equal(guard.allowed, false);
  assert.match(String(guard.reason), /readiness_not_ready/);
  assert.doesNotMatch(String(guard.reason), /forbidden/i);

  const out = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Channel Real Path',
    db,
    record,
    sequenceName: 'default',
    stepNumber: 2,
    step: {
      kind: 'linkedin_connect',
      id: 'linkedin_1',
      config: { channel: 'linkedin' },
    },
    sequence: { steps: [] },
    channelHint: 'linkedin',
    intent: 'send',
  });
  assert.equal(out.status, 'skipped');
  assert.match(String(out.reason), /readiness_not_ready/);
  assert.doesNotMatch(String(out.reason), /forbidden/i);
  db.close();
});

// ---------------------------------------------------------------------------
// Phone + forbidden work
// ---------------------------------------------------------------------------

test('phone: human_phone parks as awaiting_manual; visit/field_visit/send_sms rejected', async () => {
  const { listDir } = createList();
  const db = openListDb({ listDir, readonly: false });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_channel_1');

  const phone = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Channel Real Path',
    db,
    record,
    sequenceName: 'default',
    stepNumber: 3,
    step: {
      kind: 'manual_task',
      id: 'phone_1',
      config: { task_type: 'human_phone', channel: 'phone' },
    },
    sequence: { steps: [] },
    channelHint: 'phone',
    intent: 'send',
  });
  assert.equal(phone.status, 'skipped');
  assert.equal(phone.reason, 'awaiting_manual');

  for (const bad of [
    { kind: 'manual_task', id: 'visit_x', config: { task_type: 'visit' }, channelHint: 'visit' },
    { kind: 'manual_task', id: 'field_visit', config: { task_type: 'field_visit' }, channelHint: 'visit' },
    { kind: 'send_sms', id: 'sms_1', config: {}, channelHint: 'sms' },
  ]) {
    const out = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Channel Real Path',
      db,
      record,
      sequenceName: 'default',
      stepNumber: 9,
      step: bad,
      sequence: { steps: [] },
      channelHint: bad.channelHint,
      intent: 'send',
    });
    assert.equal(out.status, 'skipped', JSON.stringify(bad));
    assert.match(String(out.reason), /forbidden|not permitted|sms|visit/i, String(out.reason));
  }

  // Pipeline batch path mirrors execute guard for manual + sms
  const rows = [record];
  const ctx = {
    db,
    listDir,
    config: require('js-yaml').load(
      (await import('node:fs')).readFileSync(join(listDir, 'outbound.yaml'), 'utf8'),
    ),
    aiConfig: {},
    mcp: null,
    toolCatalog: null,
  };
  const phoneBatch = await executeStepBatch(
    ctx,
    { kind: 'manual_task', id: 'phone_1', config: { task_type: 'human_phone', channel: 'phone' } },
    'phone_1',
    rows,
  );
  assert.equal(phoneBatch.get('fixture_channel_1').reason, 'awaiting_manual');
  assert.equal(phoneBatch.get('fixture_channel_1').errored, undefined);

  const smsBatch = await executeStepBatch(ctx, { kind: 'send_sms', id: 'sms_x' }, 'sms_x', rows);
  assert.equal(smsBatch.get('fixture_channel_1').errored, true);
  assert.match(smsBatch.get('fixture_channel_1').reason, /forbidden/);

  const visitBatch = await executeStepBatch(
    ctx,
    { kind: 'manual_task', id: 'field_visit', config: { task_type: 'visit' } },
    'field_visit',
    rows,
  );
  assert.equal(visitBatch.get('fixture_channel_1').errored, true);
  db.close();
});

// ---------------------------------------------------------------------------
// LinkedIn: not forbidden; readiness gate on production path
// ---------------------------------------------------------------------------

test('linkedin: not forbidden; production path fails clearly without configured credentials', async () => {
  assert.equal(isForbiddenChannelKind('linkedin_connect'), false);
  assert.equal(isForbiddenTaskType('linkedin_connect'), false);
  assert.equal(isLinkedinConnectKind('linkedin_connect'), true);
  assert.doesNotThrow(() => assertWorkAllowed({ kind: 'linkedin_connect', channel: 'linkedin' }));

  // Contract: missing env → not ready
  const missing = evaluateUnipileReadiness({
    UNIPILE_API_KEY: '',
    UNIPILE_DSN: '',
  });
  assert.equal(missing.ready, false);
  assert.match(missing.reason, /unipile_not_configured/);
  assert.ok(missing.env_keys_missing.length >= 1);
  assert.deepEqual(UNIPILE_ENV_KEYS.slice().sort(), ['UNIPILE_API_KEY', 'UNIPILE_DSN'].sort());

  // Contract: both keys present → ready (live API still not faked)
  const ready = evaluateUnipileReadiness({
    UNIPILE_API_KEY: 'test-key',
    UNIPILE_DSN: 'https://api.unipile.example',
  });
  assert.equal(ready.ready, true);

  const liveSkip = await executeUnipileLinkedinConnect({
    env: { UNIPILE_API_KEY: 'test-key', UNIPILE_DSN: 'https://api.unipile.example' },
  });
  assert.equal(liveSkip.status, 'skipped');
  assert.match(liveSkip.reason, /not_implemented|dry_run|unipile/i);

  const unconfigured = await executeUnipileLinkedinConnect({
    env: {},
  });
  assert.equal(unconfigured.status, 'skipped');
  assert.match(unconfigured.reason, /unipile_not_configured/);

  // Production executeChannelStep path
  const prevKey = process.env.UNIPILE_API_KEY;
  const prevDsn = process.env.UNIPILE_DSN;
  delete process.env.UNIPILE_API_KEY;
  delete process.env.UNIPILE_DSN;
  try {
    const { listDir } = createList();
    const db = openListDb({ listDir, readonly: false });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_channel_1');

    const guard = guardChannelExecution({
      config: { policy: { forbidden_channels: ['send_sms', 'visit'], enforce_readiness: true } },
      record,
      stepKind: 'linkedin_connect',
      channel: 'linkedin',
      stepId: 'linkedin_1',
    });
    assert.equal(guard.allowed, true);

    const out = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Channel Real Path',
      db,
      record,
      sequenceName: 'default',
      stepNumber: 2,
      step: {
        kind: 'linkedin_connect',
        id: 'linkedin_1',
        draft_approval_required: true,
        config: {
          channel: 'linkedin',
          invite_message: 'Hello — I would be glad to connect.',
          idempotency: { key_source: ['_row_id'], scope: 'list' },
        },
      },
      sequence: { steps: [] },
      channelHint: 'linkedin',
      intent: 'send',
    });
    assert.equal(out.status, 'failed');
    assert.match(String(out.reason), /unipile/i);
    assert.match(String(out.reason), /UNIPILE_API_KEY.*UNIPILE_DSN/);
    assert.doesNotMatch(String(out.reason), /forbidden/i);

    // Pipeline batch also routes linkedin_connect (not forbidden short-circuit)
    const rows = [record];
    const ctx = {
      db,
      listDir,
      config: require('js-yaml').load(
        (await import('node:fs')).readFileSync(join(listDir, 'outbound.yaml'), 'utf8'),
      ),
      aiConfig: {},
      mcp: null,
      toolCatalog: null,
    };
    const batch = await executeStepBatch(
      ctx,
      { kind: 'linkedin_connect', id: 'linkedin_1', config: { channel: 'linkedin' } },
      'linkedin_1',
      rows,
    );
    const batchOut = batch.get('fixture_channel_1');
    assert.ok(batchOut);
    assert.equal(batchOut.errored, true); // skipped without sent → errored true in batch mapping
    assert.doesNotMatch(String(batchOut.reason), /forbidden/i);
    assert.match(String(batchOut.reason), /unipile|linkedin|did_not_complete|provider/i);

    // Readiness policy: linkedin channel not ready blocks proposed action
    const readiness = evaluateOutboundReadiness({
      eligible: true,
      suppressed: false,
      identityConfidence: 90,
      materialContradiction: false,
      treatmentTier: 'A',
      channels: { linkedin: { ready: false, confidence: 10 } },
      contentReady: true,
      withinBudget: true,
      hasNextAction: true,
      namedBuyerStatus: 'confirmed',
      namedBuyerName: 'Pat Owner',
      buyerAffiliationStatus: 'confirmed',
      buyingCenterRole: 'owner',
      proposedAction: { channel: 'linkedin', kind: 'linkedin_connect' },
    });
    assert.equal(readiness.ready, false);
    assert.ok(readiness.blockers.some((b) => b.includes('linkedin_not_ready')));

    db.close();
  } finally {
    if (prevKey === undefined) delete process.env.UNIPILE_API_KEY;
    else process.env.UNIPILE_API_KEY = prevKey;
    if (prevDsn === undefined) delete process.env.UNIPILE_DSN;
    else process.env.UNIPILE_DSN = prevDsn;
  }
});

// ---------------------------------------------------------------------------
// Mail: manual tasks allowed + one-mail allocate
// ---------------------------------------------------------------------------

test('mail: standard_postcard and golden_ticket manual tasks allowed; second allocate fails', async () => {
  const { listDir } = createList();
  const db = openListDb({ listDir, readonly: false });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_channel_1');

  for (const taskType of ['standard_postcard', 'golden_ticket']) {
    assert.equal(isForbiddenTaskType(taskType), false);
    assert.doesNotThrow(() => assertWorkAllowed({
      kind: 'manual_task',
      taskType,
      channel: 'mail',
      stepId: `mail_${taskType}`,
    }));

    const out = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Channel Real Path',
      db,
      record,
      sequenceName: 'default',
      stepNumber: 4,
      step: {
        kind: 'manual_task',
        id: `mail_${taskType}`,
        config: { task_type: taskType, channel: 'mail' },
      },
      sequence: { steps: [] },
      channelHint: 'mail',
      intent: 'send',
    });
    assert.equal(out.status, 'skipped');
    assert.equal(out.reason, 'awaiting_manual', taskType);
  }

  const plan = buildContactPlan({
    account_id: 'fixture_channel_1',
    campaign_id: 'camp_mail_1',
    treatment_tier: 'A',
    mail_treatment: 'standard_postcard',
    contacts: [
      { contact_id: 'c1', outbound_disposition: 'eligible_target', outreach_rank: 1 },
    ],
  });
  const mailed = allocateMail({ campaign: plan, mail_treatment: 'standard_postcard' });
  assert.equal(mailed.mail_allocated, true);
  assert.throws(
    () => allocateMail({ campaign: mailed, mail_treatment: 'standard_postcard' }),
    /already allocated/i,
  );

  const goldenPlan = buildContactPlan({
    account_id: 'fixture_channel_1',
    campaign_id: 'camp_mail_gt',
    treatment_tier: 'A',
    mail_treatment: 'golden_ticket',
    contacts: [
      { contact_id: 'c1', outbound_disposition: 'eligible_target', outreach_rank: 1 },
    ],
  });
  const gt = allocateMail({ campaign: goldenPlan, mail_treatment: 'golden_ticket' });
  assert.equal(gt.mail_allocated, true);
  assert.throws(() => allocateMail({ campaign: gt, mail_treatment: 'golden_ticket' }));

  db.close();
});

test('unipile fixture adapter returns sent when AO_UNIPILE_FIXTURE=1 and credentials present', async () => {
  const env = {
    UNIPILE_API_KEY: 'test-key',
    UNIPILE_DSN: 'https://api.unipile.test',
    AO_UNIPILE_FIXTURE: '1',
  };
  const readiness = evaluateUnipileReadiness(env);
  assert.equal(readiness.ready, true);
  const result = await executeUnipileLinkedinConnect({
    record: { _row_id: 'fixture_li_1' },
    step: { id: 'linkedin_1' },
    env,
  });
  assert.equal(result.status, 'sent');
  assert.equal(result.reason, 'unipile_fixture_success');
  assert.match(String(result.provider_id), /^unipile_fixture_/);

  // Without fixture flag, still honest not-implemented
  const liveGap = await executeUnipileLinkedinConnect({
    record: { _row_id: 'fixture_li_1' },
    step: { id: 'linkedin_1' },
    env: { UNIPILE_API_KEY: 'k', UNIPILE_DSN: 'https://x' },
  });
  assert.equal(liveGap.status, 'skipped');
  // Live adapter requires a LinkedIn URL (honest skip, not fake success).
  assert.ok(
    liveGap.reason === 'unipile_missing_linkedin_url'
      || liveGap.reason.startsWith('unipile_live_')
      || liveGap.reason === 'unipile_live_adapter_not_implemented',
    `unexpected live gap reason: ${liveGap.reason}`,
  );
});
