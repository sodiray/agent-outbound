/**
 * RES-CAMPAIGN-ORCHESTRATION residual closures:
 * 1. Phone park / next_action=phone must not block Tier A/B mail allocate
 * 2. Pause / cancel / inbound honor on sequencer + execute + manual complete + call claim
 * 3. Rotation replay: clean next_action, held cannot receive, mail_allocated preserved
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openListDb, ensureRecordColumns } from '../dist/orchestrator/runtime/db.js';
import {
  shouldExecuteSequenceOutbound,
  isOptionalPhoneCapacityStep,
  laterStepsDependOn,
  PARALLEL_CHANNEL_ACTION_TYPES,
} from '../dist/orchestrator/policy/sequence-outbound.js';
import {
  buildContactPlan,
  allocateMail,
  applyContactRotation,
  assertActionTarget,
  parseAccountCampaignFromRecord,
  rotateContact,
} from '../dist/orchestrator/policy/contact-campaign.js';
import {
  advanceAfterSuccessfulAction,
  NEXT_ACTION_POLICY_VERSION,
} from '../dist/orchestrator/policy/lifecycle.js';
import { completeManualTask } from '../dist/orchestrator/pipeline/manual.js';
import { claimCallBoardEntry } from '../dist/orchestrator/operator/call-board.js';
import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';

const NOW = '2026-08-04T15:00:00.000Z';

const nextAction = (action_type, overrides = {}) => ({
  action_id: `na_${action_type}_1`,
  action_type,
  account_id: 'acct_1',
  contact_id: 'c_active',
  lifecycle_stage: 'contacted',
  sequence_state: 'active',
  work_state: action_type.includes('phone') || action_type === 'manual_task'
    ? 'executing_external_action'
    : 'executing_external_action',
  reason: `test ${action_type}`,
  on_success: 'continue',
  policy_version: NEXT_ACTION_POLICY_VERSION,
  ...overrides,
});

const record = (overrides = {}) => ({
  _row_id: 'acct_1',
  sequence_status: 'active',
  sequence_step: 0,
  next_action_date: '2026-08-04',
  account_sequence_state: 'active',
  work_state: 'executing_external_action',
  lifecycle_stage: 'contacted',
  next_action_json: JSON.stringify(nextAction('send_email')),
  ...overrides,
});

// ── 1. Phone must not block Tier A/B mail ─────────────────────────────────

test('phone next_action allows record-level outbound (account stays in play)', () => {
  for (const action_type of ['human_phone', 'phone_call', 'manual_task', 'phone']) {
    const d = shouldExecuteSequenceOutbound(record({
      next_action_json: JSON.stringify(nextAction(action_type, {
        work_state: action_type === 'manual_task' ? 'human_phone' : 'executing_external_action',
      })),
    }), NOW);
    assert.equal(d.execute, true, action_type);
    assert.ok(
      d.reason === 'parallel_phone_capacity' || d.reason === 'parallel_channel_action',
      `${action_type}: ${d.reason}`,
    );
  }
  assert.ok(PARALLEL_CHANNEL_ACTION_TYPES.has('human_phone'));
});

test('phone next_action does not block independent mail channel', () => {
  const d = shouldExecuteSequenceOutbound(
    record({
      next_action_json: JSON.stringify(nextAction('human_phone')),
    }),
    NOW,
    { channel: 'mail', stepKind: 'manual_task', taskType: 'standard_postcard' },
  );
  assert.equal(d.execute, true);
  assert.equal(d.channel_independent, true);
  assert.match(d.reason, /phone_does_not_block|parallel_phone/);
});

test('phone next_action does not block email or linkedin', () => {
  for (const channel of ['email', 'linkedin']) {
    const d = shouldExecuteSequenceOutbound(
      record({ next_action_json: JSON.stringify(nextAction('human_phone')) }),
      NOW,
      { channel },
    );
    assert.equal(d.execute, true, channel);
  }
});

test('paused_inbound still blocks mail even when next_action is phone', () => {
  const d = shouldExecuteSequenceOutbound(
    record({
      account_sequence_state: 'paused_inbound',
      next_action_json: JSON.stringify(nextAction('human_phone')),
    }),
    NOW,
    { channel: 'mail' },
  );
  assert.equal(d.execute, false);
  assert.equal(d.reason, 'sequence_state_paused_inbound');
});

test('optional phone capacity step helpers: TV mail does not depend_on phone', () => {
  const phone = {
    kind: 'manual_task',
    id: 'phone_1',
    config: { task_type: 'human_phone', channel: 'phone' },
  };
  const mail = {
    kind: 'manual_task',
    id: 'mail_standard',
    depends_on: ['email_2'],
    config: { task_type: 'standard_postcard', channel: 'mail' },
  };
  assert.equal(isOptionalPhoneCapacityStep(phone), true);
  assert.equal(isOptionalPhoneCapacityStep(mail), false);
  assert.equal(
    laterStepsDependOn([
      { id: 'email_2' },
      phone,
      mail,
    ], 'phone_1'),
    false,
    'mail depends on email_2 only — phone is optional capacity',
  );
  assert.equal(
    laterStepsDependOn([
      { id: 'phone_1' },
      { id: 'mail_after_phone', depends_on: ['phone_1'] },
    ], 'phone_1'),
    true,
  );
});

test('phone park does not block mail allocate via completeManualTask', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-res-phone-mail-'));
  writeFileSync(join(listDir, 'outbound.yaml'), 'list: { name: t }\npipeline: []\nscore: { criteria: [] }\n');
  writeFileSync(join(listDir, 'operator.md'), 'x');
  writeFileSync(join(listDir, 'mcp.json'), '{}');
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const campaign = buildContactPlan({
    account_id: 'pm1',
    campaign_id: 'camp_pm',
    contacts: [{ contact_id: 'c1', outbound_disposition: 'eligible_target', outreach_rank: 1 }],
    treatment_tier: 'B',
    mail_treatment: 'standard_postcard',
  });
  ensureRecordColumns({
    db,
    columns: [
      'account_contact_plan_json',
      'mail_treatment',
      'mail_allocated',
      'mail_allocated_at',
      'account_sequence_state',
      'next_action_json',
      'lifecycle_stage',
      'work_state',
      'call_claim_status',
    ],
  });
  // Active campaign with phone as next_action + open phone park + open mail park
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      account_contact_plan_json, mail_treatment, account_sequence_state, lifecycle_stage,
      work_state, next_action_json, call_claim_status, phone,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      'pm1', 'Phone Mail Co', 'default', 'active', 4,
      ?, 'standard_postcard', 'active', 'contacted',
      'executing_external_action', ?, 'claimed', '+12085550100',
      ?, ?, ?, ?
    )
  `).run(
    JSON.stringify(campaign),
    JSON.stringify(nextAction('human_phone', { account_id: 'pm1' })),
    now, now, now, now,
  );

  try {
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
  } catch { /* exists */ }

  db.prepare(`
    INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
    VALUES ('e_phone', 'pm1', 'phone_1', 'manual_task', 0, 'awaiting_manual', ?)
  `).run(now);
  db.prepare(`
    INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
    VALUES ('e_mail', 'pm1', 'mail_standard', 'manual_task', 0, 'awaiting_manual', ?)
  `).run(now);

  // Gate would have blocked mail complete when next_action=phone was unknown —
  // after residual fix, allocate succeeds while phone remains parked.
  const gate = shouldExecuteSequenceOutbound(
    db.prepare('SELECT * FROM records WHERE _row_id=?').get('pm1'),
    NOW,
    { channel: 'mail', stepKind: 'manual_task', taskType: 'standard_postcard' },
  );
  assert.equal(gate.execute, true, gate.reason);

  const result = await completeManualTask({
    db,
    recordId: 'pm1',
    stepId: 'mail_standard',
    note: 'postcard sent while phone parked',
  });
  assert.equal(result.status, 'manual_completed');
  assert.equal(result.mail_allocated, true);

  const row = db.prepare('SELECT * FROM records WHERE _row_id=?').get('pm1');
  assert.equal(Number(row.mail_allocated), 1);
  // Phone park still open
  const phonePark = db.prepare(`
    SELECT 1 AS ok FROM pipeline_events
    WHERE record_id='pm1' AND step_id='phone_1' AND passed=0 AND reason='awaiting_manual'
  `).get();
  assert.ok(phonePark, 'phone park must remain open after independent mail complete');
  db.close();
});

// ── 2. Pause / cancel / inbound honor on child actions ────────────────────

test('pause blocks email via shouldExecuteSequenceOutbound + executeChannelStep', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-res-pause-email-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
list: { name: pause }
business: { name: M, description: t, icp: t, offer: t }
pipeline: []
sequences:
  default:
    steps:
      - kind: send_email
        id: email_1
        day: 0
policy:
  version: tv-pipeline-v1
  forbidden_channels: [send_sms, visit]
  enforce_readiness: false
channels:
  email:
    draft_approval_required: false
`);
  writeFileSync(join(listDir, 'operator.md'), 'x');
  writeFileSync(join(listDir, 'mcp.json'), '{}');
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: ['account_sequence_state', 'next_action_json', 'lifecycle_stage', 'work_state', 'active_contact_id'],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      contact_email, lifecycle_stage, account_sequence_state, work_state, next_action_json,
      active_contact_id, _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      'pause_email', 'Paused Co', 'default', 'active', 0,
      'a@b.test', 'contacted', 'paused_review', 'pending_human_review', ?,
      'c1', ?, ?, ?, ?
    )
  `).run(JSON.stringify(nextAction('send_email', { account_id: 'pause_email' })), now, now, now, now);

  const row = db.prepare('SELECT * FROM records WHERE _row_id=?').get('pause_email');
  const gate = shouldExecuteSequenceOutbound(row, NOW, { channel: 'email' });
  assert.equal(gate.execute, false);
  assert.match(gate.reason, /paused_review/);

  const out = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'pause',
    toolCatalog: null,
    db,
    record: row,
    sequenceName: 'default',
    stepNumber: 1,
    step: {
      kind: 'send_email',
      id: 'email_1',
      config: {
        action: 'tool_call',
        tool: { server: 'noop', tools: ['NOOP'] },
        daily_cap: 999,
      },
    },
    sequence: { steps: [] },
    channelHint: 'email',
    intent: 'send',
    dryRun: true,
  });
  assert.equal(out.status, 'skipped');
  assert.match(String(out.reason), /sequence_outbound_gated:.*paused_review/);
  db.close();
});

test('cancel blocks linkedin via executeChannelStep', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-res-cancel-li-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
list: { name: cancel }
business: { name: M, description: t, icp: t, offer: t }
pipeline: []
sequences:
  default:
    steps:
      - kind: linkedin_connect
        id: linkedin_1
        day: 0
policy:
  version: tv-pipeline-v1
  forbidden_channels: [send_sms, visit]
  enforce_readiness: false
`);
  writeFileSync(join(listDir, 'operator.md'), 'x');
  writeFileSync(join(listDir, 'mcp.json'), '{}');
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: ['account_sequence_state', 'next_action_json', 'lifecycle_stage', 'work_state', 'active_contact_id'],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      lifecycle_stage, account_sequence_state, work_state, next_action_json,
      active_contact_id, _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      'cancel_li', 'Cancel Co', 'default', 'cancelled', 0,
      'contacted', 'cancelled', 'idle', ?,
      'c1', ?, ?, ?, ?
    )
  `).run(JSON.stringify(nextAction('linkedin_connect', { account_id: 'cancel_li' })), now, now, now, now);

  const row = db.prepare('SELECT * FROM records WHERE _row_id=?').get('cancel_li');
  const out = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'cancel',
    toolCatalog: null,
    db,
    record: row,
    sequenceName: 'default',
    stepNumber: 1,
    step: { kind: 'linkedin_connect', id: 'linkedin_1', config: { channel: 'linkedin' } },
    sequence: { steps: [] },
    channelHint: 'linkedin',
    intent: 'send',
    dryRun: true,
  });
  assert.equal(out.status, 'skipped');
  assert.match(String(out.reason), /sequence_outbound_gated:.*cancelled/);
  db.close();
});

test('pause blocks completeManualTask mail allocate', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-res-pause-mail-'));
  writeFileSync(join(listDir, 'outbound.yaml'), 'list: { name: t }\npipeline: []\nscore: { criteria: [] }\n');
  writeFileSync(join(listDir, 'operator.md'), 'x');
  writeFileSync(join(listDir, 'mcp.json'), '{}');
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const campaign = buildContactPlan({
    account_id: 'pause_mail',
    campaign_id: 'camp_pm',
    contacts: [{ contact_id: 'c1', outbound_disposition: 'eligible_target', outreach_rank: 1 }],
    treatment_tier: 'A',
    mail_treatment: 'golden_ticket',
  });
  ensureRecordColumns({
    db,
    columns: [
      'account_contact_plan_json', 'mail_treatment', 'mail_allocated',
      'account_sequence_state', 'next_action_json', 'lifecycle_stage', 'work_state',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status,
      account_contact_plan_json, mail_treatment, account_sequence_state, lifecycle_stage,
      work_state, next_action_json, _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      'pause_mail', 'Paused Mail', 'default', 'active',
      ?, 'golden_ticket', 'paused_inbound', 'engaged',
      'human_commercial_followup', ?, ?, ?, ?, ?
    )
  `).run(
    JSON.stringify(campaign),
    JSON.stringify(nextAction('send_mail', {
      account_id: 'pause_mail',
      sequence_state: 'paused_inbound',
      work_state: 'human_commercial_followup',
    })),
    now, now, now, now,
  );
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_events (
        event_id TEXT PRIMARY KEY,
        record_id TEXT, step_id TEXT, kind TEXT, passed INTEGER, reason TEXT, occurred_at TEXT
      )
    `);
  } catch { /* */ }
  db.prepare(`
    INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
    VALUES ('e_pm', 'pause_mail', 'mail_golden_or_standard', 'manual_task', 0, 'awaiting_manual', ?)
  `).run(now);

  await assert.rejects(
    () => completeManualTask({
      db,
      recordId: 'pause_mail',
      stepId: 'mail_golden_or_standard',
      note: 'should refuse',
    }),
    /Cannot complete outbound manual task.*paused_inbound/,
  );
  const row = db.prepare('SELECT * FROM records WHERE _row_id=?').get('pause_mail');
  assert.notEqual(Number(row.mail_allocated || 0), 1, 'must not allocate under pause');
  db.close();
});

test('cancel blocks call-board claim', () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-res-cancel-claim-'));
  writeFileSync(join(listDir, 'outbound.yaml'), 'list: { name: t }\npipeline: []\nscore: { criteria: [] }\n');
  writeFileSync(join(listDir, 'operator.md'), 'x');
  writeFileSync(join(listDir, 'mcp.json'), '{}');
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: [
      'account_sequence_state', 'lifecycle_stage', 'phone', 'suppressed',
      'call_claim_status', 'treatment_tier', 'next_action_json',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status,
      treatment_tier, phone, lifecycle_stage, account_sequence_state, suppressed,
      call_claim_status, next_action_json, _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      'cancel_claim', 'Cancel Claim Co', 'default', 'cancelled',
      'A', '+12085550999', 'contacted', 'cancelled', 0,
      'open', ?, ?, ?, ?, ?
    )
  `).run(JSON.stringify(nextAction('human_phone', { account_id: 'cancel_claim' })), now, now, now, now);

  assert.throws(
    () => claimCallBoardEntry({ db, recordId: 'cancel_claim', claimedBy: 'op1' }),
    /not call-board eligible|sequence_state=cancelled/,
  );
  db.close();
});

// ── 3. Rotation replay completeness ───────────────────────────────────────

test('rotation: successor gets clean next_action; held cannot receive; mail_allocated preserved', () => {
  let campaign = buildContactPlan({
    account_id: 'rot1',
    campaign_id: 'camp_rot',
    contacts: [
      { contact_id: 'c_owner', outbound_disposition: 'eligible_target', outreach_rank: 1 },
      { contact_id: 'c_ops', outbound_disposition: 'eligible_target', outreach_rank: 2 },
      { contact_id: 'c_office', outbound_disposition: 'eligible_target', outreach_rank: 3 },
    ],
    treatment_tier: 'A',
    mail_treatment: 'golden_ticket',
  });
  assert.equal(campaign.active_contact_id, 'c_owner');
  assert.deepEqual(campaign.held_contact_ids, ['c_ops', 'c_office']);

  campaign = allocateMail({ campaign, mail_treatment: 'golden_ticket' });
  assert.equal(campaign.mail_allocated, true);

  const rotated = rotateContact({ campaign, reason: 'contact_exhausted' });
  assert.equal(rotated.rotated, true);
  assert.equal(rotated.previous_contact_id, 'c_owner');
  assert.equal(rotated.campaign.active_contact_id, 'c_ops');
  assert.deepEqual(rotated.campaign.held_contact_ids, ['c_office']);
  assert.equal(rotated.campaign.mail_allocated, true, 'mail_allocated is account-level across rotation');

  // Held contact cannot receive outreach
  assert.throws(
    () => assertActionTarget({
      campaign: rotated.campaign,
      contact_id: 'c_owner',
      channel: 'email',
    }),
    /not the active contact/,
  );
  assert.throws(
    () => assertActionTarget({
      campaign: rotated.campaign,
      contact_id: 'c_office',
      channel: 'email',
    }),
    /Held contact cannot receive|not the active contact/,
  );
  // Active can receive; mail already allocated blocks second mail
  assertActionTarget({
    campaign: rotated.campaign,
    contact_id: 'c_ops',
    channel: 'email',
  });
  assert.throws(
    () => assertActionTarget({
      campaign: rotated.campaign,
      contact_id: 'c_ops',
      channel: 'mail',
    }),
    /Mail already sent/,
  );

  // Production succession installs clean send_email next_action on successor
  const advanced = advanceAfterSuccessfulAction({
    record: {
      _row_id: 'rot1',
      lifecycle_stage: 'contacted',
      account_sequence_state: 'active',
      work_state: 'executing_external_action',
      active_contact_id: 'c_owner',
      account_contact_plan_json: JSON.stringify(campaign),
      next_action_json: JSON.stringify(nextAction('send_email', {
        account_id: 'rot1',
        contact_id: 'c_owner',
        on_success: 'rotate',
      })),
      automated_actions_used: 2,
    },
    channel: 'email',
    stepKind: 'send_email',
    sequenceCompleted: true,
    rotate: true,
  });
  assert.equal(advanced.rotated, true);
  assert.equal(advanced.patch.active_contact_id, 'c_ops');
  assert.equal(advanced.patch.account_sequence_state, 'active');
  assert.equal(advanced.patch.work_state, 'content_generation');
  assert.equal(advanced.patch.automated_actions_used, 0);
  assert.ok(advanced.patch.last_contact_rotation_at);
  const na = JSON.parse(String(advanced.patch.next_action_json));
  assert.equal(na.action_type, 'send_email');
  assert.equal(na.contact_id, 'c_ops');
  assert.ok(na.action_id);
  assert.notEqual(na.contact_id, 'c_owner');

  const planAfter = parseAccountCampaignFromRecord({
    account_contact_plan_json: advanced.patch.account_contact_plan_json,
  });
  assert.equal(planAfter.mail_allocated, true);
  assert.equal(planAfter.active_contact_id, 'c_ops');
  assert.ok(!planAfter.held_contact_ids.includes('c_ops'));
});

test('applyContactRotation preserves mail_allocated and switches active contact', () => {
  const campaign = allocateMail({
    campaign: buildContactPlan({
      account_id: 'rot2',
      campaign_id: 'c2',
      contacts: [
        { contact_id: 'a', outbound_disposition: 'eligible_target', outreach_rank: 1 },
        { contact_id: 'b', outbound_disposition: 'eligible_target', outreach_rank: 2 },
      ],
      treatment_tier: 'B',
      mail_treatment: 'standard_postcard',
    }),
    mail_treatment: 'standard_postcard',
  });
  const result = applyContactRotation({
    account_contact_plan_json: JSON.stringify(campaign),
    active_contact_id: 'a',
  });
  assert.equal(result.rotated, true);
  assert.equal(result.active_contact_id, 'b');
  assert.equal(result.campaign.mail_allocated, true);
  assert.equal(result.previous_contact_id, 'a');
});
