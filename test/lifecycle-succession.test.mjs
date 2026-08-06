/**
 * Proves lifecycle next_action succession runs on the production channel success path
 * (executeChannelStep → advanceAfterSuccessfulAction → upsert), not pure in-memory only.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openListDb, ensureRecordColumns, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import {
  advanceAfterSuccessfulAction,
  checkStateIntegrity,
  completeActionAndCreateSuccessor,
  NEXT_ACTION_POLICY_VERSION,
  shouldApplyContactRotation,
} from '../dist/orchestrator/policy/lifecycle.js';
import {
  applyContactRotation,
  buildContactPlan,
  rotateContact,
} from '../dist/orchestrator/policy/contact-campaign.js';
import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';

const projectYaml = `
list:
  name: Lifecycle Succession Test
business:
  name: Mission
  description: Test
  icp: Test
  offer: Test
pipeline: []
sequences:
  default:
    steps:
      - kind: send_email
        id: email_1
        day: 0
        side_effecting: true
        config:
          action: tool_call
          daily_cap: 999
          tool:
            server: fake_smtp
            tools: [SEND_TEST]
          output_map:
            message_id: message_id
            provider_id: provider_id
      - kind: send_email
        id: email_2
        day: 3
        side_effecting: true
        config:
          action: tool_call
          daily_cap: 999
          tool:
            server: fake_smtp
            tools: [SEND_TEST]
policy:
  version: tv-pipeline-v1
  forbidden_channels: [send_sms, visit, field_visit]
  enforce_readiness: false
channels:
  email:
    draft_approval_required: false
`;

const mcpJson = {
  mcpServers: {
    fake_smtp: {
      type: 'command',
      command: 'node',
      args: ['-e', "process.stdout.write(JSON.stringify({ message_id: 'msg_lifecycle_1', provider_id: 'msg_lifecycle_1' }))"],
      tools: [
        {
          slug: 'SEND_TEST',
          description: 'Deterministic test send (no live API)',
          input_schema: { type: 'object', properties: {} },
          invoke: { argv: [], result: 'stdout_json' },
        },
      ],
    },
  },
};

const POLICY_COLUMNS = [
  'lifecycle_stage',
  'account_sequence_state',
  'work_state',
  'next_action_json',
  'active_contact_id',
  'account_contact_plan_json',
  'treatment_tier',
  'suppressed',
  'force_contact_rotate',
];

const sampleCampaign = (overrides = {}) =>
  buildContactPlan({
    account_id: 'acct_1',
    campaign_id: 'camp_1',
    treatment_tier: 'B',
    mail_treatment: 'none',
    contacts: [
      { contact_id: 'c_owner', outbound_disposition: 'eligible_target', outreach_rank: 1 },
      { contact_id: 'c_om', outbound_disposition: 'eligible_target', outreach_rank: 2 },
    ],
    ...overrides,
  });

const seedNextAction = (accountId, overrides = {}) => ({
  action_id: `na_send_${accountId}`,
  action_type: 'send_email',
  account_id: accountId,
  contact_id: 'c_owner',
  lifecycle_stage: 'cold',
  sequence_state: 'active',
  work_state: 'executing_external_action',
  reason: 'Tier treatment email 1',
  on_success: 'wait_or_followup',
  policy_version: NEXT_ACTION_POLICY_VERSION,
  ...overrides,
});

const createList = ({ withNextAction = true, lifecycle = 'cold' } = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-lifecycle-succ-'));
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml);
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify(mcpJson, null, 2));

  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({ db, columns: POLICY_COLUMNS });

  const rowId = 'fixture_succ_1';
  const nextAction = withNextAction ? seedNextAction(rowId, { lifecycle_stage: lifecycle }) : null;

  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      contact_email, lifecycle_stage, account_sequence_state, work_state, next_action_json,
      active_contact_id, treatment_tier, suppressed,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      ?, 'Boise Peak HVAC', 'default', 'active', 0,
      'owner@example-hvac.test', ?, 'active', 'executing_external_action', ?,
      'c_owner', 'B', 0,
      ?, ?, ?, ?
    )
  `).run(
    rowId,
    lifecycle,
    nextAction ? JSON.stringify(nextAction) : '',
    now,
    now,
    now,
    now,
  );
  db.close();
  return listDir;
};

test('advanceAfterSuccessfulAction completes matching next_action and installs exactly one successor', () => {
  const record = {
    _row_id: 'acct_1',
    lifecycle_stage: 'cold',
    account_sequence_state: 'active',
    work_state: 'executing_external_action',
    active_contact_id: 'c_owner',
    next_action_json: JSON.stringify(seedNextAction('acct_1')),
  };
  const result = advanceAfterSuccessfulAction({
    record,
    channel: 'email',
    stepKind: 'send_email',
    stepId: 'email_1',
    sequenceCompleted: false,
    evidence: { reason: 'email accepted by provider', evidence_ids: ['msg_1'] },
  });

  assert.equal(result.used_complete_action, true);
  assert.equal(result.patch.lifecycle_stage, 'contacted');
  assert.equal(result.patch.account_sequence_state, 'waiting');
  assert.equal(result.patch.work_state, 'waiting_time_or_event');
  assert.ok(!['won', 'lost'].includes(result.patch.lifecycle_stage));

  const next = JSON.parse(result.patch.next_action_json);
  assert.ok(next.action_id);
  assert.notEqual(next.action_id, 'na_send_acct_1');
  assert.equal(next.action_type, 'wait');
  assert.equal(next.lifecycle_stage, 'contacted');
  assert.equal(result.integrity_errors.length, 0);
  assert.equal(
    checkStateIntegrity(result.state).filter((i) => i.severity === 'error').length,
    0,
  );
});

test('advanceAfterSuccessfulAction wait successor has non-empty due_at', () => {
  const result = advanceAfterSuccessfulAction({
    record: {
      _row_id: 'acct_due',
      lifecycle_stage: 'cold',
      account_sequence_state: 'active',
      work_state: 'executing_external_action',
      active_contact_id: 'c_owner',
      next_action_date: '2026-08-10',
      next_action_json: JSON.stringify(seedNextAction('acct_due')),
    },
    channel: 'email',
    stepKind: 'send_email',
    stepId: 'email_1',
    sequenceCompleted: false,
    evidence: { reason: 'email accepted by provider', evidence_ids: ['msg_1'] },
  });

  const next = JSON.parse(result.patch.next_action_json);
  assert.equal(next.action_type, 'wait');
  assert.ok(next.due_at, 'next_action.due_at must be non-empty on wait successor');
  assert.equal(String(next.due_at).trim().length > 0, true);
  assert.equal(next.due_at, '2026-08-10');

  // Without next_action_date, still populates a default (now+2d ISO date)
  const fallback = advanceAfterSuccessfulAction({
    record: {
      _row_id: 'acct_due_fb',
      lifecycle_stage: 'contacted',
      account_sequence_state: 'active',
      work_state: 'executing_external_action',
      active_contact_id: 'c_owner',
      next_action_json: JSON.stringify(seedNextAction('acct_due_fb', {
        lifecycle_stage: 'contacted',
      })),
    },
    channel: 'email',
    stepKind: 'send_email',
    sequenceCompleted: false,
  });
  const waitFb = JSON.parse(fallback.patch.next_action_json);
  assert.equal(waitFb.action_type, 'wait');
  assert.ok(waitFb.due_at, 'default due_at required when no next_action_date');
  assert.match(String(waitFb.due_at), /^\d{4}-\d{2}-\d{2}/);
});

test('advanceAfterSuccessfulAction safe path when no next_action_json still yields one successor', () => {
  const result = advanceAfterSuccessfulAction({
    record: {
      _row_id: 'acct_bare',
      lifecycle_stage: 'cold',
      account_sequence_state: 'active',
      work_state: 'executing_external_action',
    },
    channel: 'email',
    stepKind: 'send_email',
    stepId: 'email_1',
    sequenceCompleted: false,
  });
  assert.equal(result.used_complete_action, false);
  assert.equal(result.patch.lifecycle_stage, 'contacted');
  const next = JSON.parse(result.patch.next_action_json);
  assert.ok(next.action_id);
  assert.equal(result.integrity_errors.length, 0);
});

test('advanceAfterSuccessfulAction on sequence complete clears next_action without terminal lifecycle jump', () => {
  const result = advanceAfterSuccessfulAction({
    record: {
      _row_id: 'acct_done',
      lifecycle_stage: 'contacted',
      account_sequence_state: 'active',
      work_state: 'executing_external_action',
      next_action_json: JSON.stringify(seedNextAction('acct_done', {
        lifecycle_stage: 'contacted',
        action_id: 'na_last',
      })),
    },
    channel: 'email',
    stepKind: 'send_email',
    stepId: 'email_2',
    sequenceCompleted: true,
  });
  assert.equal(result.patch.lifecycle_stage, 'contacted');
  assert.equal(result.patch.account_sequence_state, 'completed');
  assert.equal(result.patch.next_action_json, '');
  assert.ok(!['won', 'lost', 'disqualified'].includes(result.patch.lifecycle_stage));
  assert.equal(result.integrity_errors.length, 0);
});

test('executeChannelStep success path persists next_action succession via production code', async () => {
  const listDir = createList({ withNextAction: true, lifecycle: 'cold' });
  const db = openListDb({ listDir, readonly: false });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_succ_1');
  assert.equal(record.lifecycle_stage, 'cold');
  const before = JSON.parse(record.next_action_json);
  assert.equal(before.action_id, 'na_send_fixture_succ_1');

  const result = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Lifecycle Succession Test',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step: {
      kind: 'send_email',
      id: 'email_1',
      config: {
        action: 'tool_call',
        daily_cap: 999,
        tool: { server: 'fake_smtp', tools: ['SEND_TEST'] },
        output_map: { message_id: 'message_id', provider_id: 'provider_id' },
      },
    },
    sequence: {
      steps: [
        { kind: 'send_email', id: 'email_1', day: 0 },
        { kind: 'send_email', id: 'email_2', day: 3 },
      ],
    },
    channelHint: 'email',
    intent: 'send',
    dryRun: false,
  });

  assert.equal(result.status, 'sent', `expected sent, got ${result.status}: ${result.reason || ''}`);

  const updated = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_succ_1');
  assert.equal(updated.lifecycle_stage, 'contacted');
  assert.ok(!['won', 'lost'].includes(String(updated.lifecycle_stage)));
  assert.equal(updated.account_sequence_state, 'waiting');
  assert.equal(updated.work_state, 'waiting_time_or_event');

  const next = JSON.parse(String(updated.next_action_json || '{}'));
  assert.ok(next.action_id, 'exactly one next_action required after success');
  assert.notEqual(next.action_id, before.action_id);
  assert.equal(next.lifecycle_stage, 'contacted');

  const integrity = checkStateIntegrity({
    lifecycle_stage: updated.lifecycle_stage,
    sequence_state: updated.account_sequence_state,
    work_state: updated.work_state,
    next_action: next,
    suppressed: Boolean(updated.suppressed),
    treatment_tier: updated.treatment_tier,
    active_contact_id: updated.active_contact_id || null,
  });
  assert.equal(integrity.filter((i) => i.severity === 'error').length, 0);

  // Exactly one next action object (single JSON object, not an array)
  assert.equal(Array.isArray(next), false);
  assert.equal(typeof next.action_id, 'string');
  db.close();
});

test('executeChannelStep success without prior next_action still installs one successor', async () => {
  const listDir = createList({ withNextAction: false, lifecycle: 'cold' });
  const db = openListDb({ listDir, readonly: false });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_succ_1');

  const result = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Lifecycle Succession Test',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step: {
      kind: 'send_email',
      id: 'email_1',
      config: {
        action: 'tool_call',
        daily_cap: 999,
        tool: { server: 'fake_smtp', tools: ['SEND_TEST'] },
        output_map: { message_id: 'message_id', provider_id: 'provider_id' },
      },
    },
    sequence: {
      steps: [
        { kind: 'send_email', id: 'email_1', day: 0 },
        { kind: 'send_email', id: 'email_2', day: 3 },
      ],
    },
    channelHint: 'email',
    intent: 'send',
    dryRun: false,
  });

  assert.equal(result.status, 'sent', `expected sent, got ${result.status}: ${result.reason || ''}`);
  const updated = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_succ_1');
  assert.equal(updated.lifecycle_stage, 'contacted');
  const next = JSON.parse(String(updated.next_action_json || '{}'));
  assert.ok(next.action_id);
  assert.equal(
    checkStateIntegrity({
      lifecycle_stage: updated.lifecycle_stage,
      sequence_state: updated.account_sequence_state,
      work_state: updated.work_state,
      next_action: next,
      active_contact_id: updated.active_contact_id || null,
    }).filter((i) => i.severity === 'error').length,
    0,
  );
  db.close();
});

test('draft intent does not advance lifecycle or next_action', async () => {
  const listDir = createList({ withNextAction: true, lifecycle: 'cold' });
  const db = openListDb({ listDir, readonly: false });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_succ_1');
  const before = record.next_action_json;

  const result = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Lifecycle Succession Test',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step: {
      kind: 'send_email',
      id: 'email_1',
      config: {
        action: 'tool_call',
        tool: { server: 'fake_smtp', tools: ['SEND_TEST'] },
      },
    },
    sequence: { steps: [{ kind: 'send_email', id: 'email_1', day: 0 }] },
    channelHint: 'email',
    intent: 'draft',
    dryRun: false,
  });

  assert.equal(result.status, 'drafted');
  assert.equal(result.provider_id, '');
  assert.ok(result.draft_id);
  const updated = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_succ_1');
  assert.equal(updated.lifecycle_stage, 'cold');
  assert.equal(updated.next_action_json, before);
  db.close();
});

test('helper reuses completeActionAndCreateSuccessor semantics for matching action_id', () => {
  const state = {
    lifecycle_stage: 'cold',
    sequence_state: 'active',
    work_state: 'executing_external_action',
    next_action: seedNextAction('acct_cmp'),
    active_contact_id: 'c_owner',
  };
  const manual = completeActionAndCreateSuccessor({
    state,
    completed_action_id: state.next_action.action_id,
    outcome: 'success',
    evidence: { reason: 'email accepted' },
    lifecycle_to: 'contacted',
    sequence_to: 'waiting',
    work_to: 'waiting_time_or_event',
    successor: {
      action_id: 'na_wait_manual',
      action_type: 'wait',
      account_id: 'acct_cmp',
      contact_id: 'c_owner',
      lifecycle_stage: 'contacted',
      sequence_state: 'waiting',
      work_state: 'waiting_time_or_event',
      reason: 'email accepted',
      on_success: 'execute_next_sequence_step',
    },
  });
  const viaHelper = advanceAfterSuccessfulAction({
    record: {
      _row_id: 'acct_cmp',
      lifecycle_stage: 'cold',
      account_sequence_state: 'active',
      work_state: 'executing_external_action',
      active_contact_id: 'c_owner',
      next_action_json: JSON.stringify(state.next_action),
    },
    channel: 'email',
    stepKind: 'send_email',
    sequenceCompleted: false,
    evidence: { reason: 'email accepted' },
  });
  assert.equal(manual.lifecycle_stage, viaHelper.patch.lifecycle_stage);
  assert.equal(manual.sequence_state, viaHelper.patch.account_sequence_state);
  assert.equal(manual.work_state, viaHelper.patch.work_state);
  assert.equal(viaHelper.used_complete_action, true);
  assert.equal(viaHelper.rotated, false);
});

test('applyContactRotation uses rotateContact and returns plan + active_contact_id patch fields', () => {
  const plan = sampleCampaign();
  assert.equal(plan.active_contact_id, 'c_owner');
  assert.deepEqual(plan.held_contact_ids, ['c_om']);

  const result = applyContactRotation({
    _row_id: 'acct_1',
    active_contact_id: 'c_owner',
    account_contact_plan_json: JSON.stringify(plan),
  }, { reason: 'exhausted_c_owner' });

  assert.equal(result.rotated, true);
  assert.equal(result.previous_contact_id, 'c_owner');
  assert.equal(result.active_contact_id, 'c_om');
  assert.ok(result.account_contact_plan_json);
  const updated = JSON.parse(result.account_contact_plan_json);
  assert.equal(updated.active_contact_id, 'c_om');
  assert.deepEqual(updated.held_contact_ids, []);
  assert.equal(updated.mail_allocated, false);

  // Exhausted held queue → no further rotation
  const done = applyContactRotation({
    active_contact_id: 'c_om',
    account_contact_plan_json: result.account_contact_plan_json,
  });
  assert.equal(done.rotated, false);
  assert.equal(done.active_contact_id, null);

  // No plan → no-op
  const bare = applyContactRotation({ active_contact_id: 'c_x' });
  assert.equal(bare.rotated, false);
  assert.equal(bare.account_contact_plan_json, null);
  assert.equal(bare.reason, 'no_campaign_plan');
});

test('advanceAfterSuccessfulAction rotates on sequence complete when held contacts remain', () => {
  const plan = sampleCampaign();
  const result = advanceAfterSuccessfulAction({
    record: {
      _row_id: 'acct_rot',
      lifecycle_stage: 'contacted',
      account_sequence_state: 'active',
      work_state: 'executing_external_action',
      active_contact_id: 'c_owner',
      account_contact_plan_json: JSON.stringify(plan),
      next_action_json: JSON.stringify(seedNextAction('acct_rot', {
        lifecycle_stage: 'contacted',
        action_id: 'na_last',
        contact_id: 'c_owner',
      })),
    },
    channel: 'email',
    stepKind: 'send_email',
    stepId: 'email_2',
    sequenceCompleted: true,
  });

  assert.equal(result.rotated, true);
  assert.equal(result.previous_contact_id, 'c_owner');
  assert.equal(result.patch.active_contact_id, 'c_om');
  assert.equal(result.patch.account_sequence_state, 'active');
  assert.equal(result.patch.work_state, 'content_generation');
  assert.equal(result.patch.lifecycle_stage, 'contacted');
  assert.ok(!['won', 'lost'].includes(result.patch.lifecycle_stage));

  const next = JSON.parse(result.patch.next_action_json);
  assert.equal(next.action_type, 'send_email');
  assert.equal(next.contact_id, 'c_om');
  assert.equal(next.lifecycle_stage, 'contacted');

  const planOut = JSON.parse(result.patch.account_contact_plan_json);
  assert.equal(planOut.active_contact_id, 'c_om');
  assert.deepEqual(planOut.held_contact_ids, []);
  assert.equal(result.integrity_errors.length, 0);
  assert.equal(result.state.active_contact_id, 'c_om');
});

test('advanceAfterSuccessfulAction rotates when action_type is contact_rotation', () => {
  const plan = sampleCampaign();
  const result = advanceAfterSuccessfulAction({
    record: {
      _row_id: 'acct_cr',
      lifecycle_stage: 'contacted',
      account_sequence_state: 'active',
      work_state: 'contact_rotation',
      active_contact_id: 'c_owner',
      account_contact_plan_json: JSON.stringify(plan),
      next_action_json: JSON.stringify(seedNextAction('acct_cr', {
        action_id: 'na_rotate_1',
        action_type: 'contact_rotation',
        lifecycle_stage: 'contacted',
        work_state: 'contact_rotation',
        contact_id: 'c_owner',
        reason: 'prior contact exhausted',
        on_success: 'start_next_contact',
      })),
    },
    channel: 'email',
    stepKind: 'contact_rotation',
    sequenceCompleted: false,
  });

  assert.equal(result.rotated, true);
  assert.equal(result.patch.active_contact_id, 'c_om');
  assert.equal(result.patch.account_sequence_state, 'active');
  assert.equal(result.patch.work_state, 'content_generation');
  const next = JSON.parse(result.patch.next_action_json);
  assert.equal(next.contact_id, 'c_om');
  assert.equal(next.action_type, 'send_email');
  assert.equal(result.integrity_errors.length, 0);
});

test('advanceAfterSuccessfulAction rotates when rotate: true (explicit helper path)', () => {
  const plan = sampleCampaign();
  const result = advanceAfterSuccessfulAction({
    record: {
      _row_id: 'acct_explicit',
      lifecycle_stage: 'contacted',
      account_sequence_state: 'active',
      work_state: 'executing_external_action',
      active_contact_id: 'c_owner',
      account_contact_plan_json: JSON.stringify(plan),
      next_action_json: JSON.stringify(seedNextAction('acct_explicit', {
        lifecycle_stage: 'contacted',
        on_success: 'wait_or_followup',
      })),
    },
    channel: 'email',
    stepKind: 'send_email',
    sequenceCompleted: false,
    rotate: true,
  });

  assert.equal(result.rotated, true);
  assert.equal(result.patch.active_contact_id, 'c_om');
  // Mid-sequence explicit rotate still installs wait successor targeting new contact
  const next = JSON.parse(result.patch.next_action_json);
  assert.equal(next.action_type, 'wait');
  assert.equal(next.contact_id, 'c_om');
  assert.equal(result.patch.account_sequence_state, 'waiting');
});

test('advanceAfterSuccessfulAction does not rotate mid-sequence without explicit signal', () => {
  const plan = sampleCampaign();
  const result = advanceAfterSuccessfulAction({
    record: {
      _row_id: 'acct_stay',
      lifecycle_stage: 'contacted',
      account_sequence_state: 'active',
      work_state: 'executing_external_action',
      active_contact_id: 'c_owner',
      account_contact_plan_json: JSON.stringify(plan),
      next_action_json: JSON.stringify(seedNextAction('acct_stay', {
        lifecycle_stage: 'contacted',
      })),
    },
    channel: 'email',
    stepKind: 'send_email',
    sequenceCompleted: false,
  });
  assert.equal(result.rotated, false);
  assert.equal(result.patch.active_contact_id, undefined);
  const next = JSON.parse(result.patch.next_action_json);
  assert.equal(next.contact_id, 'c_owner');
});

test('shouldApplyContactRotation gates on held contacts and signals', () => {
  const plan = sampleCampaign();
  assert.equal(shouldApplyContactRotation({
    record: { account_contact_plan_json: JSON.stringify(plan) },
    next_action: null,
    sequenceCompleted: true,
  }), true);
  assert.equal(shouldApplyContactRotation({
    record: { account_contact_plan_json: JSON.stringify(plan) },
    next_action: { action_type: 'send_email', on_success: 'wait' },
    sequenceCompleted: false,
  }), false);
  assert.equal(shouldApplyContactRotation({
    record: { account_contact_plan_json: JSON.stringify(plan) },
    next_action: { action_type: 'send_email', on_success: 'evaluate_reply_or_rotate' },
    sequenceCompleted: false,
  }), true);
  assert.equal(shouldApplyContactRotation({
    record: { account_contact_plan_json: JSON.stringify(plan), force_contact_rotate: true },
    next_action: null,
    sequenceCompleted: false,
  }), true);
});

test('contact rotation patch persists via upsertRecord', () => {
  const listDir = createList({ withNextAction: true, lifecycle: 'contacted' });
  const db = openListDb({ listDir, readonly: false });
  const plan = sampleCampaign();
  ensureRecordColumns({ db, columns: ['account_contact_plan_json', 'active_contact_id', ...POLICY_COLUMNS] });

  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_succ_1');
  const advanced = advanceAfterSuccessfulAction({
    record: {
      ...record,
      active_contact_id: 'c_owner',
      account_contact_plan_json: JSON.stringify(plan),
      next_action_json: JSON.stringify(seedNextAction('fixture_succ_1', {
        lifecycle_stage: 'contacted',
        action_id: 'na_last_fixture',
        contact_id: 'c_owner',
      })),
    },
    channel: 'email',
    stepKind: 'send_email',
    stepId: 'email_2',
    sequenceCompleted: true,
  });

  assert.equal(advanced.rotated, true);
  upsertRecord({
    db,
    row: {
      ...record,
      ...advanced.patch,
    },
  });

  const updated = db.prepare(
    'SELECT active_contact_id, account_contact_plan_json, next_action_json, account_sequence_state, work_state, lifecycle_stage FROM records WHERE _row_id = ?',
  ).get('fixture_succ_1');

  assert.equal(updated.active_contact_id, 'c_om');
  assert.equal(updated.account_sequence_state, 'active');
  assert.equal(updated.work_state, 'content_generation');
  assert.equal(updated.lifecycle_stage, 'contacted');
  const storedPlan = JSON.parse(updated.account_contact_plan_json);
  assert.equal(storedPlan.active_contact_id, 'c_om');
  assert.deepEqual(storedPlan.held_contact_ids, []);
  const next = JSON.parse(updated.next_action_json);
  assert.equal(next.contact_id, 'c_om');
  assert.equal(next.action_type, 'send_email');

  // Parity with pure rotateContact
  const manual = rotateContact({ campaign: plan, reason: 'test' });
  assert.equal(manual.campaign.active_contact_id, storedPlan.active_contact_id);
  db.close();
});
