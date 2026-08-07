/**
 * Phase 7 — channel execution isolation suite.
 *
 * Plan Complete-when: each channel can independently prove readiness, review,
 * execution or human completion, provider outcome, failure, fallback, and
 * account-level stopping without inventing/duplicating another channel's state.
 *
 * This suite is phase-isolated (does not import other test files). Closures:
 *   1. email draft_approval gate
 *   2. SMS / visit forbidden
 *   3. human_phone park (awaiting_manual)
 *   4. mail park + allocateMail on manual complete
 *   5. LinkedIn Unipile live HTTP (unipileLiveInvite + fetch inject) + fixture
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { openListDb, insertDraft, ensureRecordColumns } from '../dist/orchestrator/runtime/db.js';
import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';
import {
  evaluateUnipileReadiness,
  executeUnipileLinkedinConnect,
  unipileLiveInvite,
  isLinkedinConnectKind,
  UNIPILE_ENV_KEYS,
} from '../dist/orchestrator/channels/unipile.js';
import { executeStepBatch } from '../dist/orchestrator/pipeline/step-executor.js';
import { completeManualTask } from '../dist/orchestrator/pipeline/manual.js';
import {
  assertWorkAllowed,
  isForbiddenChannelKind,
  isForbiddenTaskType,
} from '../dist/orchestrator/policy/forbidden-channels.js';
import {
  buildContactPlan,
  allocateMail,
  parseAccountCampaignFromRecord,
} from '../dist/orchestrator/policy/contact-campaign.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const projectYaml = `
list:
  name: Phase07 Channels
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
            subject: Phase 7 email
            body: Body
          daily_cap: 10
          idempotency:
            key_source:
              - _row_id
            scope: list
      - kind: linkedin_connect
        id: linkedin_1
        side_effecting: true
        config:
          channel: linkedin
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

/** Default outbound next_action so enforce_readiness fails closed only on real blockers. */
const defaultNextActionJson = (accountId) => JSON.stringify({
  action_id: `na_${accountId}`,
  action_type: 'prepare_outbound',
  account_id: accountId,
  contact_id: 'c_owner',
  lifecycle_stage: 'cold',
  sequence_state: 'active',
  work_state: 'executing_external_action',
  reason: 'phase-07 channel fixture',
  on_success: 'continue',
});

const createList = (recordOverrides = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-phase07-'));
  const sinkDir = join(listDir, 'smtp-sink');
  mkdirSync(sinkDir, { recursive: true });
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml);
  writeFileSync(join(listDir, 'operator.md'), 'phase-07 channels');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const base = {
    _row_id: 'phase07_fixture_1',
    business_name: 'Phase07 HVAC',
    contact_email: 'owner@example-phase07.test',
    contact_name: 'Pat Owner',
    fit_score: 80,
    identity_confidence: 90,
    email_confidence: 80,
    email_verification_confidence: 80,
    treatment_tier: 'A',
    eligibility_outcome: 'eligible',
    preliminary_snapshot: 'phase07 readiness snapshot',
    claim_audit_passed: 1,
    linkedin_url: 'https://www.linkedin.com/in/pat-owner-phase07',
    linkedin_confidence: 70,
    suppressed: 0,
    active_contact_id: 'c_owner',
    named_buyer_status: 'confirmed',
    observed_buyer_name: 'Pat Owner',
    buyer_affiliation_status: 'confirmed',
    buying_center_role: 'owner',
    next_action_json: defaultNextActionJson('phase07_fixture_1'),
    ...recordOverrides,
  };
  ensureRecordColumns({
    db,
    columns: [
      'identity_confidence', 'email_confidence', 'email_verification_confidence',
      'treatment_tier', 'eligibility_outcome', 'preliminary_snapshot',
      'claim_audit_passed', 'linkedin_url', 'linkedin_confidence', 'suppressed',
      'contact_email', 'contact_name', 'next_action_json', 'active_contact_id',
      'named_buyer_status', 'observed_buyer_name', 'buyer_affiliation_status', 'buying_center_role',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, contact_email, contact_name,
      fit_score, identity_confidence, email_confidence, email_verification_confidence,
      treatment_tier, eligibility_outcome, preliminary_snapshot, claim_audit_passed,
      linkedin_url, linkedin_confidence, suppressed, next_action_json, active_contact_id,
      named_buyer_status, observed_buyer_name, buyer_affiliation_status, buying_center_role,
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
    base.claim_audit_passed,
    base.linkedin_url,
    base.linkedin_confidence,
    base.suppressed,
    base.next_action_json,
    base.active_contact_id,
    base.named_buyer_status,
    base.observed_buyer_name,
    base.buyer_affiliation_status,
    base.buying_center_role,
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
    args: { subject: 'Phase 7 email', body: 'Body' },
    daily_cap: 10,
    idempotency: { key_source: ['_row_id'], scope: 'list' },
  },
};

// ---------------------------------------------------------------------------
// 1. Email — draft_approval block
// ---------------------------------------------------------------------------

test('phase-07 email: draft_approval_required blocks send without ready draft', async () => {
  const { listDir, sinkDir } = createList();
  const db = openListDb({ listDir, readonly: false });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('phase07_fixture_1');

  const blocked = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Phase07 Channels',
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
  assert.equal(
    existsSync(sinkDir) ? readdirSync(sinkDir).filter((f) => f.endsWith('.json')).length : 0,
    0,
  );

  insertDraft({
    db,
    draft: {
      draft_id: 'p07_draft_pending',
      row_id: 'phase07_fixture_1',
      sequence_name: 'default',
      step_number: 1,
      step_id: 'email_1',
      channel: 'email',
      status: 'pending_approval',
      subject: 'Pending',
      body: 'Pending body',
    },
  });
  const stillBlocked = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Phase07 Channels',
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
});

// ---------------------------------------------------------------------------
// 2. SMS / visit forbidden
// ---------------------------------------------------------------------------

test('phase-07 forbidden: SMS and visit/field_visit cannot execute', async () => {
  assert.equal(isForbiddenChannelKind('send_sms'), true);
  assert.equal(isForbiddenChannelKind('field_visit'), true);
  assert.equal(isForbiddenTaskType('visit'), true);
  assert.throws(() => assertWorkAllowed({ kind: 'send_sms', channel: 'sms' }));
  assert.throws(() => assertWorkAllowed({
    kind: 'manual_task',
    taskType: 'field_visit',
    channel: 'visit',
    stepId: 'field_visit',
  }));

  const { listDir } = createList();
  const db = openListDb({ listDir, readonly: false });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('phase07_fixture_1');

  for (const bad of [
    { kind: 'send_sms', id: 'sms_1', config: {}, channelHint: 'sms' },
    { kind: 'manual_task', id: 'visit_x', config: { task_type: 'visit' }, channelHint: 'visit' },
    { kind: 'manual_task', id: 'field_visit', config: { task_type: 'field_visit' }, channelHint: 'visit' },
  ]) {
    const out = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Phase07 Channels',
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

  const ctx = { db, listDir, config: {}, aiConfig: {}, mcp: null, toolCatalog: null };
  const smsBatch = await executeStepBatch(ctx, { kind: 'send_sms', id: 'sms_x' }, 'sms_x', [record]);
  assert.equal(smsBatch.get('phase07_fixture_1').errored, true);
  assert.match(smsBatch.get('phase07_fixture_1').reason, /forbidden/);

  const visitBatch = await executeStepBatch(
    ctx,
    { kind: 'manual_task', id: 'field_visit', config: { task_type: 'visit' } },
    'field_visit',
    [record],
  );
  assert.equal(visitBatch.get('phase07_fixture_1').errored, true);
  db.close();
});

// ---------------------------------------------------------------------------
// 3. human_phone park
// ---------------------------------------------------------------------------

test('phase-07 phone: human_phone parks as awaiting_manual (no auto-call)', async () => {
  assert.equal(isForbiddenTaskType('human_phone'), false);
  assert.doesNotThrow(() => assertWorkAllowed({
    kind: 'manual_task',
    taskType: 'human_phone',
    channel: 'phone',
    stepId: 'phone_1',
  }));

  const { listDir } = createList();
  const db = openListDb({ listDir, readonly: false });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('phase07_fixture_1');

  const phone = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Phase07 Channels',
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

  const batch = await executeStepBatch(
    { db, listDir, config: {}, aiConfig: {}, mcp: null, toolCatalog: null },
    { kind: 'manual_task', id: 'phone_1', config: { task_type: 'human_phone', channel: 'phone' } },
    'phone_1',
    [record],
  );
  assert.equal(batch.get('phase07_fixture_1').reason, 'awaiting_manual');
  assert.equal(batch.get('phase07_fixture_1').errored, undefined);
  db.close();
});

// ---------------------------------------------------------------------------
// 4. Mail park + one-mail allocate (+ production allocate on manual complete)
// ---------------------------------------------------------------------------

test('phase-07 mail: park + allocate once only + allocateMail on manual complete', async () => {
  const { listDir } = createList();
  const db = openListDb({ listDir, readonly: false });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('phase07_fixture_1');

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
      listName: 'Phase07 Channels',
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
    account_id: 'phase07_fixture_1',
    campaign_id: 'camp_mail_p07',
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
    account_id: 'phase07_fixture_1',
    campaign_id: 'camp_mail_gt_p07',
    treatment_tier: 'A',
    mail_treatment: 'golden_ticket',
    contacts: [
      { contact_id: 'c1', outbound_disposition: 'eligible_target', outreach_rank: 1 },
    ],
  });
  const gt = allocateMail({ campaign: goldenPlan, mail_treatment: 'golden_ticket' });
  assert.equal(gt.mail_allocated, true);
  assert.throws(() => allocateMail({ campaign: gt, mail_treatment: 'golden_ticket' }));

  // Production path: completeManualTask allocates mail on mail step complete.
  const now = new Date().toISOString();
  const campComplete = buildContactPlan({
    account_id: 'phase07_fixture_1',
    campaign_id: 'camp_mail_complete_p07',
    treatment_tier: 'A',
    mail_treatment: 'standard_postcard',
    contacts: [
      { contact_id: 'c1', outbound_disposition: 'eligible_target', outreach_rank: 1 },
    ],
  });
  ensureRecordColumns({
    db,
    columns: ['account_contact_plan_json', 'mail_treatment', 'mail_allocated', 'mail_allocated_at'],
  });
  db.prepare(`
    UPDATE records
    SET account_contact_plan_json = ?, mail_treatment = 'standard_postcard', mail_allocated = 0
    WHERE _row_id = ?
  `).run(JSON.stringify(campComplete), 'phase07_fixture_1');
  try {
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
      VALUES ('p07_mail_park', 'phase07_fixture_1', 'mail_standard', 'manual_task', 0, 'awaiting_manual', ?)
    `).run(now);
  } catch {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_events (
        event_id TEXT PRIMARY KEY,
        record_id TEXT,
        step_id TEXT,
        kind TEXT,
        passed INTEGER,
        reason TEXT,
        occurred_at TEXT
      )
    `);
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
      VALUES ('p07_mail_park', 'phase07_fixture_1', 'mail_standard', 'manual_task', 0, 'awaiting_manual', ?)
    `).run(now);
  }
  const completed = await completeManualTask({
    db,
    recordId: 'phase07_fixture_1',
    stepId: 'mail_standard',
    note: 'mailed',
  });
  assert.equal(completed.status, 'manual_completed');
  assert.equal(completed.mail_allocated, true);
  const after = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('phase07_fixture_1');
  assert.equal(Number(after.mail_allocated), 1);
  const afterPlan = parseAccountCampaignFromRecord(after);
  assert.equal(afterPlan.mail_allocated, true);
  assert.throws(() => allocateMail({ campaign: afterPlan, mail_treatment: 'standard_postcard' }));
  db.close();
});

// ---------------------------------------------------------------------------
// 5. LinkedIn not forbidden + Unipile live HTTP (fetch inject) + fixture
// ---------------------------------------------------------------------------

test('phase-07 linkedin: not forbidden; live invite + fixture + failure isolation', async () => {
  assert.equal(isForbiddenChannelKind('linkedin_connect'), false);
  assert.equal(isForbiddenTaskType('linkedin_connect'), false);
  assert.equal(isLinkedinConnectKind('linkedin_connect'), true);
  assert.doesNotThrow(() => assertWorkAllowed({ kind: 'linkedin_connect', channel: 'linkedin' }));
  assert.deepEqual(UNIPILE_ENV_KEYS.slice().sort(), ['UNIPILE_API_KEY', 'UNIPILE_DSN'].sort());
  assert.equal(typeof unipileLiveInvite, 'function');

  const missing = evaluateUnipileReadiness({ UNIPILE_API_KEY: '', UNIPILE_DSN: '' });
  assert.equal(missing.ready, false);
  assert.match(missing.reason, /unipile_not_configured/);

  const ready = evaluateUnipileReadiness({
    UNIPILE_API_KEY: 'test-key',
    UNIPILE_DSN: 'https://api.unipile.example',
  });
  assert.equal(ready.ready, true);

  // Live path requires linkedin URL; without it, honest skip (not fake success).
  const missingUrl = await executeUnipileLinkedinConnect({
    record: { _row_id: 'phase07_li' },
    step: { id: 'linkedin_1' },
    env: { UNIPILE_API_KEY: 'k', UNIPILE_DSN: 'https://x' },
  });
  assert.equal(missingUrl.status, 'skipped');
  assert.equal(missingUrl.reason, 'unipile_missing_linkedin_url');

  // Live HTTP path with injected fetch — unipileLiveInvite adapter.
  const liveOk = await executeUnipileLinkedinConnect({
    record: { _row_id: 'phase07_li', linkedin_url: 'https://www.linkedin.com/in/x' },
    step: { id: 'linkedin_1' },
    env: { UNIPILE_API_KEY: 'k', UNIPILE_DSN: 'https://api.unipile.test' },
    fetchImpl: async (_url, init) =>
      (init?.method === 'GET'
        ? {
          status: 200,
          statusText: 'OK',
          json: async () => ({ provider_id: 'target_phase07' }),
        }
        : {
        status: 200,
        statusText: 'OK',
        json: async () => ({ id: 'inv_live_1' }),
        }),
  });
  assert.equal(liveOk.status, 'sent');
  assert.equal(liveOk.reason, 'unipile_live_invite_sent');
  assert.equal(liveOk.provider_id, 'inv_live_1');

  // Live HTTP failure is failed (not skipped, not fake success).
  const liveFail = await executeUnipileLinkedinConnect({
    record: { _row_id: 'phase07_li', linkedin_url: 'https://www.linkedin.com/in/x' },
    step: { id: 'linkedin_1' },
    env: { UNIPILE_API_KEY: 'k', UNIPILE_DSN: 'https://api.unipile.test' },
    fetchImpl: async (_url, init) =>
      (init?.method === 'GET'
        ? {
          status: 200,
          statusText: 'OK',
          json: async () => ({ provider_id: 'target_phase07' }),
        }
        : {
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({ message: 'rate limited' }),
        }),
  });
  assert.equal(liveFail.status, 'failed');
  assert.match(liveFail.reason, /unipile_live_http_429/);

  // Fixture path (validation harness only)
  const fixture = await executeUnipileLinkedinConnect({
    record: { _row_id: 'phase07_li' },
    step: { id: 'linkedin_1' },
    env: {
      UNIPILE_API_KEY: 'test-key',
      UNIPILE_DSN: 'https://api.unipile.test',
      AO_UNIPILE_FIXTURE: '1',
    },
  });
  assert.equal(fixture.status, 'sent');
  assert.equal(fixture.reason, 'unipile_fixture_success');
  assert.match(String(fixture.provider_id), /^unipile_fixture_/);

  // Production executeChannelStep path without pipeline credentials
  const prevKey = process.env.UNIPILE_API_KEY;
  const prevDsn = process.env.UNIPILE_DSN;
  const prevFix = process.env.AO_UNIPILE_FIXTURE;
  delete process.env.UNIPILE_API_KEY;
  delete process.env.UNIPILE_DSN;
  delete process.env.AO_UNIPILE_FIXTURE;
  try {
    const { listDir } = createList();
    const db = openListDb({ listDir, readonly: false });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('phase07_fixture_1');

    const out = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Phase07 Channels',
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
    assert.equal(out.status, 'failed');
    assert.match(String(out.reason), /unipile/i);
    assert.doesNotMatch(String(out.reason), /forbidden/i);

    // Fixture success through executeChannelStep records linkedin channel_event only.
    process.env.UNIPILE_API_KEY = 'test-key';
    process.env.UNIPILE_DSN = 'https://api.unipile.test';
    process.env.AO_UNIPILE_FIXTURE = '1';
    const sent = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Phase07 Channels',
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
    assert.equal(sent.status, 'sent');
    assert.equal(sent.reason, 'unipile_fixture_success');
    assert.match(String(sent.provider_id), /^unipile_fixture_/);
    const events = db.prepare(
      `SELECT channel, action, provider_id, provider_message_id FROM channel_events WHERE row_id = ?`,
    ).all('phase07_fixture_1');
    assert.ok(events.some((e) => e.channel === 'linkedin' && (e.action === 'executed' || e.action === 'sent')));
    assert.ok(!events.some((e) => e.channel === 'email' || e.channel === 'mail'));
    const row = db.prepare('SELECT linkedin_last_provider_id FROM records WHERE _row_id = ?').get('phase07_fixture_1');
    assert.match(String(row.linkedin_last_provider_id || ''), /^unipile_fixture_/);
    db.close();
  } finally {
    if (prevKey === undefined) delete process.env.UNIPILE_API_KEY;
    else process.env.UNIPILE_API_KEY = prevKey;
    if (prevDsn === undefined) delete process.env.UNIPILE_DSN;
    else process.env.UNIPILE_DSN = prevDsn;
    if (prevFix === undefined) delete process.env.AO_UNIPILE_FIXTURE;
    else process.env.AO_UNIPILE_FIXTURE = prevFix;
  }
});

// Smoke: phase-07 suite file is loadable independently of ROOT tree shape.
test('phase-07 suite root resolves agent-outbound package', () => {
  assert.ok(existsSync(join(ROOT, 'package.json')));
  assert.ok(existsSync(join(ROOT, 'dist/orchestrator/channels/execute.js')));
  assert.ok(existsSync(join(ROOT, 'dist/orchestrator/channels/unipile.js')));
});
