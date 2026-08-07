/**
 * Phase A4 — executeChannelStep sequence outbound gate (chokepoint).
 *
 * Bug class: paused_inbound / cancelled / paused_review (or non-outbound next_action)
 * still reach send/draft side effects because only the sequencer filter was gated,
 * not the shared executeChannelStep entry point used by nested pipeline + sequencer.
 *
 * dryRun proves gate before any provider work; no AO_PIPELINE_FIXTURE required.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openListDb, ensureRecordColumns } from '../dist/orchestrator/runtime/db.js';
import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';
import { NEXT_ACTION_POLICY_VERSION } from '../dist/orchestrator/policy/lifecycle.js';

const projectYaml = `
list:
  name: Execute Channel Sequence Gate
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
policy:
  version: tv-pipeline-v1
  forbidden_channels: [send_sms, visit, field_visit]
  enforce_readiness: false
channels:
  email:
    draft_approval_required: false
`;

const nextAction = (accountId, overrides = {}) => ({
  action_id: `na_send_${accountId}`,
  action_type: 'send_email',
  account_id: accountId,
  contact_id: 'c_owner',
  lifecycle_stage: 'contacted',
  sequence_state: 'active',
  work_state: 'executing_external_action',
  reason: 'test outbound',
  on_success: 'continue',
  policy_version: NEXT_ACTION_POLICY_VERSION,
  ...overrides,
});

const seedList = ({
  account_sequence_state = 'active',
  next_action_json,
  readiness_json,
  rowId = 'acct_gate_1',
} = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-exec-seq-gate-'));
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml);
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
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
      'treatment_tier',
      'suppressed',
      'readiness_json',
    ],
  });
  const na =
    next_action_json !== undefined
      ? next_action_json
      : JSON.stringify(nextAction(rowId));
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      contact_email, lifecycle_stage, account_sequence_state, work_state, next_action_json,
      active_contact_id, treatment_tier, suppressed, readiness_json,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      ?, 'Gate HVAC', 'default', 'active', 0,
      'owner@example-gate.test', 'contacted', ?, 'executing_external_action', ?,
      'c_owner', 'B', 0, ?,
      ?, ?, ?, ?
    )
  `).run(rowId, account_sequence_state, na, readiness_json || '', now, now, now, now);
  return { listDir, db, rowId };
};

const emailStep = {
  kind: 'send_email',
  id: 'email_1',
  config: {
    action: 'tool_call',
    tool: { server: 'noop', tools: ['NOOP'] },
    daily_cap: 999,
    idempotency: {
      key_source: ['_row_id', 'step_id'],
      scope: 'list',
    },
  },
};

const runExecute = async ({ listDir, db, record, dryRun = true }) =>
  executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Execute Channel Sequence Gate',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step: emailStep,
    sequence: { steps: [emailStep] },
    channelHint: 'email',
    intent: 'send',
    dryRun,
  });

const countChannelEvents = (db, rowId) =>
  Number(
    db.prepare('SELECT COUNT(*) AS n FROM channel_events WHERE row_id = ?').get(rowId)?.n || 0,
  );

const countIdempotency = (db) =>
  Number(db.prepare('SELECT COUNT(*) AS n FROM idempotency').get()?.n || 0);

const countDrafts = (db, rowId) =>
  Number(db.prepare('SELECT COUNT(*) AS n FROM drafts WHERE row_id = ?').get(rowId)?.n || 0);

const countModelCostEvents = (db, rowId) =>
  Number(db.prepare(`
    SELECT COUNT(*) AS n
    FROM cost_events
    WHERE record_id = ? AND provider NOT IN ('tool_call', 'smtp')
  `).get(rowId)?.n || 0);

// --- Blocked sequence states at executeChannelStep ------------------------

for (const blockedState of ['paused_inbound', 'cancelled', 'paused_review']) {
  test(`executeChannelStep: ${blockedState} returns sequence_outbound_gated; no send`, async () => {
    const accountId = `acct_${blockedState}`;
    const { listDir, db, rowId } = seedList({
      rowId: accountId,
      account_sequence_state: blockedState,
      // Even with an outbound next_action, blocked sequence state must win.
      next_action_json: JSON.stringify(nextAction(accountId, { action_type: 'send_email' })),
    });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);

    const out = await runExecute({ listDir, db, record, dryRun: true });
    assert.equal(out.status, 'skipped', JSON.stringify(out));
    assert.match(
      String(out.reason),
      new RegExp(`sequence_outbound_gated:.*sequence_state_${blockedState}`),
      String(out.reason),
    );
    assert.equal(out.provider_id, '');

    // Gate runs before claim and before channel events — no side effects.
    assert.equal(countChannelEvents(db, rowId), 0);
    assert.equal(countIdempotency(db), 0);

    // Non-dryRun path must also refuse (same early return).
    const live = await runExecute({ listDir, db, record, dryRun: false });
    assert.equal(live.status, 'skipped');
    assert.match(String(live.reason), /sequence_outbound_gated/);
    assert.equal(countChannelEvents(db, rowId), 0);
    assert.equal(countIdempotency(db), 0);

    db.close();
  });
}

// --- Active + outbound next_action allowed --------------------------------

test('executeChannelStep: active + outbound next_action is allowed (dryRun)', async () => {
  const accountId = 'acct_active_send';
  const { listDir, db, rowId } = seedList({
    rowId: accountId,
    account_sequence_state: 'active',
    next_action_json: JSON.stringify(nextAction(accountId, { action_type: 'send_email' })),
  });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);

  const out = await runExecute({ listDir, db, record, dryRun: true });
  assert.equal(out.status, 'sent', `expected past gate: ${JSON.stringify(out)}`);
  assert.ok(
    !/sequence_outbound_gated/.test(String(out.reason || '')),
    String(out.reason),
  );
  // dryRun does not write channel_events; gate pass is proven by status sent.
  assert.equal(countChannelEvents(db, rowId), 0);

  db.close();
});

test('executeChannelStep: active + prepare_outbound next_action is allowed (dryRun)', async () => {
  const accountId = 'acct_active_prepare';
  const { listDir, db, rowId } = seedList({
    rowId: accountId,
    account_sequence_state: 'active',
    next_action_json: JSON.stringify(
      nextAction(accountId, { action_type: 'prepare_outbound' }),
    ),
  });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);

  const out = await runExecute({ listDir, db, record, dryRun: true });
  assert.equal(out.status, 'sent', JSON.stringify(out));
  assert.ok(
    !/sequence_outbound_gated/.test(String(out.reason || '')),
    String(out.reason),
  );
  db.close();
});

test('executeChannelStep: unavailable readiness preserves legacy channel behavior', async () => {
  const accountId = 'acct_readiness_unavailable';
  const { listDir, db, rowId } = seedList({
    rowId: accountId,
    readiness_json: JSON.stringify({ ready: true }),
  });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);

  const out = await runExecute({ listDir, db, record, dryRun: true });
  assert.equal(out.status, 'sent', JSON.stringify(out));
  assert.doesNotMatch(String(out.reason || ''), /^channel_not_permitted:/);

  db.close();
});

test('executeChannelStep: explicitly permitted channel proceeds as before', async () => {
  const accountId = 'acct_readiness_permitted';
  const { listDir, db, rowId } = seedList({
    rowId: accountId,
    readiness_json: JSON.stringify({ permitted_channels: ['email'] }),
  });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);

  const out = await runExecute({ listDir, db, record, dryRun: true });
  assert.equal(out.status, 'sent', JSON.stringify(out));
  assert.doesNotMatch(String(out.reason || ''), /^channel_not_permitted:/);

  db.close();
});

test('executeChannelStep: unpermitted channel skips before model or draft creation', async () => {
  const accountId = 'acct_readiness_refused';
  const { listDir, db, rowId } = seedList({
    rowId: accountId,
    readiness_json: JSON.stringify({ permitted_channels: ['phone'] }),
  });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);

  const out = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Execute Channel Sequence Gate',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step: emailStep,
    sequence: { steps: [emailStep] },
    channelHint: 'email',
    intent: 'draft',
    dryRun: false,
  });

  assert.equal(out.status, 'skipped', JSON.stringify(out));
  assert.equal(out.reason, 'channel_not_permitted:email');
  assert.equal(countDrafts(db, rowId), 0);
  assert.equal(countModelCostEvents(db, rowId), 0);
  assert.equal(countChannelEvents(db, rowId), 0);

  db.close();
});

test('executeChannelStep: permitted channel proceeds and a skipped channel advances to it', async () => {
  const accountId = 'acct_readiness_advance';
  const sequenceSteps = [
    emailStep,
    {
      kind: 'manual_task',
      id: 'phone_followup',
      day: 0,
      config: { task_type: 'human_phone', channel: 'phone' },
    },
  ];
  const { listDir, db, rowId } = seedList({
    rowId: accountId,
    readiness_json: JSON.stringify({ permitted_channels: ['phone'] }),
  });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);

  const skipped = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Execute Channel Sequence Gate',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step: emailStep,
    sequence: { steps: sequenceSteps },
    channelHint: 'email',
    intent: 'draft',
    dryRun: false,
  });
  assert.equal(skipped.status, 'skipped', JSON.stringify(skipped));
  assert.equal(skipped.reason, 'channel_not_permitted:email');

  const advancedRecord = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  assert.equal(Number(advancedRecord.sequence_step), 1);
  assert.equal(String(advancedRecord.sequence_status), 'active');

  const permitted = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Execute Channel Sequence Gate',
    toolCatalog: null,
    db,
    record: advancedRecord,
    sequenceName: 'default',
    stepNumber: 2,
    step: sequenceSteps[1],
    sequence: { steps: sequenceSteps },
    channelHint: 'phone',
    intent: 'send',
    dryRun: false,
  });
  assert.equal(permitted.status, 'skipped', JSON.stringify(permitted));
  assert.equal(permitted.reason, 'awaiting_manual');

  db.close();
});
