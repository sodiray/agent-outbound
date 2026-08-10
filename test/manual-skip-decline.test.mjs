/**
 * manual skip is a negative decision (decline), not an act.
 *
 * Bug class: skip shared complete's send-authorization gates (stage review,
 * sequence outbound / suppressed / paused / terminal). That froze operator
 * queues: tasks that could never be mailed could never be cleared either.
 *
 * Complete path gates stay fail-closed — these tests assert refusal explicitly.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  completeManualTask,
  listAwaitingManualTasks,
} from '../dist/orchestrator/pipeline/manual.js';
import { buildContactPlan } from '../dist/orchestrator/policy/contact-campaign.js';
import { NEXT_ACTION_POLICY_VERSION } from '../dist/orchestrator/policy/lifecycle.js';
import { openListDb, ensureRecordColumns } from '../dist/orchestrator/runtime/db.js';

const nextAction = (accountId, overrides = {}) => ({
  action_id: `na_${accountId}`,
  action_type: 'manual_task',
  account_id: accountId,
  contact_id: 'c1',
  lifecycle_stage: 'contacted',
  sequence_state: 'active',
  work_state: 'awaiting_manual',
  due_at: '',
  reason: 'parked_manual',
  on_success: 'advance',
  related_asset_id: null,
  policy_version: NEXT_ACTION_POLICY_VERSION,
  ...overrides,
});

const mailConfig = ({
  stepId = 'mail_golden',
  productType = 'golden_ticket',
  reviewRequiredFor = ['golden_ticket', 'mail'],
} = {}) => ({
  policy: {
    version: 'tv-pipeline-v1',
    review_required_for: reviewRequiredFor,
  },
  pipeline: [
    {
      kind: 'manual_task',
      id: stepId,
      config: { task_type: productType, channel: 'mail' },
    },
  ],
  channels: {
    mail: { template_id: 'postcard_v1' },
  },
  score: {
    treatment: {
      mail_programs: {
        [productType]: {
          template_id: 'postcard_v1',
          cost_cents: 149,
          format: 'postcard',
        },
      },
    },
  },
});

const seedParkedManual = ({
  rowId = 'skip_decline_1',
  stepId = 'mail_golden',
  productType = 'golden_ticket',
  sequenceState = 'active',
  suppressed = 0,
  stage_review_json = null,
  sequenceStep = 3,
  extras = {},
} = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-manual-skip-'));
  writeFileSync(join(listDir, 'outbound.yaml'), 'list: { name: t }\npipeline: []\nscore: { criteria: [] }\n');
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const campaign = buildContactPlan({
    account_id: rowId,
    campaign_id: `camp_${rowId}`,
    treatment_tier: 'A',
    mail_treatment: productType,
    contacts: [{ contact_id: 'c1', outbound_disposition: 'eligible_target', outreach_rank: 1 }],
  });
  ensureRecordColumns({
    db,
    columns: [
      'lifecycle_stage',
      'account_sequence_state',
      'work_state',
      'next_action_json',
      'active_contact_id',
      'contact_id',
      'treatment_tier',
      'suppressed',
      'stage_review_json',
      'related_review_id',
      'transition_audit_json',
      'account_contact_plan_json',
      'mail_treatment',
      'mail_allocated',
      'mail_allocated_at',
      'mail_provider_status',
      'mail_last_piece_id',
      'mail_copy',
      'address',
      'city',
      'state',
      'zip',
      'business_name',
      'sequence_step',
      'sequence_status',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      contact_email, lifecycle_stage, account_sequence_state, work_state, next_action_json,
      active_contact_id, treatment_tier, suppressed, stage_review_json,
      account_contact_plan_json, mail_treatment, mail_allocated, mail_copy,
      address, city, state, zip,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      ?, 'Skip Decline Co', 'default', 'active', ?,
      'owner@example-skip-decline.test', 'contacted', ?, 'awaiting_manual', ?,
      'c1', 'A', ?, ?,
      ?, ?, 0, 'postcard body',
      '1 Main St', 'Boise', 'ID', '83702',
      ?, ?, ?, ?
    )
  `).run(
    rowId,
    sequenceStep,
    sequenceState,
    JSON.stringify(nextAction(rowId, {
      sequence_state: sequenceState,
      ...(extras.nextAction || {}),
    })),
    suppressed,
    stage_review_json,
    JSON.stringify(campaign),
    productType,
    now,
    now,
    now,
    now,
  );
  try {
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at, contact_id)
      VALUES (?, ?, ?, 'manual_task', 0, 'awaiting_manual', ?, 'c1')
    `).run(`park_${rowId}`, rowId, stepId, now);
  } catch {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_events (
        event_id TEXT PRIMARY KEY,
        record_id TEXT,
        step_id TEXT,
        kind TEXT,
        passed INTEGER,
        reason TEXT,
        occurred_at TEXT,
        contact_id TEXT DEFAULT ''
      )
    `);
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at, contact_id)
      VALUES (?, ?, ?, 'manual_task', 0, 'awaiting_manual', ?, 'c1')
    `).run(`park_${rowId}`, rowId, stepId, now);
  }
  return { listDir, db, rowId, stepId, productType, now, sequenceStep, sequenceState };
};

const countingMailProvider = () => {
  const calls = [];
  return {
    calls,
    provider: {
      name: 'mail_skip_fixture',
      submit: async (request) => {
        calls.push(request);
        return {
          ok: true,
          piece_id: 'must-not-submit',
          status: 'submitted',
          reason: 'accepted',
          provider: 'mail_skip_fixture',
          cost_cents: 149,
        };
      },
      getStatus: async () => ({
        piece_id: '',
        status: 'unknown',
        reason: '',
        provider: 'mail_skip_fixture',
      }),
    },
  };
};

test('manual skip: parked task with NO authorized stage review CAN be skipped', async () => {
  const stepId = 'mail_golden';
  const productType = 'golden_ticket';
  const { db, rowId } = seedParkedManual({
    rowId: 'skip_no_review',
    stepId,
    productType,
    stage_review_json: null,
  });
  const config = mailConfig({ stepId, productType });
  const { calls, provider } = countingMailProvider();

  const result = await completeManualTask({
    db,
    config,
    recordId: rowId,
    stepId,
    note: 'wrong product for this lead',
    skip: true,
    mailProvider: provider,
  });

  assert.equal(result.status, 'manual_skipped');
  assert.equal(result.record_id, rowId);
  assert.equal(result.step_id, stepId);
  assert.equal(result.note, 'wrong product for this lead');
  assert.equal(calls.length, 0, 'skip must not call mail provider');
  db.close();
});

test('manual skip: same task without stage review still CANNOT be completed', async () => {
  const stepId = 'mail_golden';
  const productType = 'golden_ticket';
  const { db, rowId } = seedParkedManual({
    rowId: 'complete_still_gated',
    stepId,
    productType,
    stage_review_json: null,
  });
  const config = mailConfig({ stepId, productType });
  const { calls, provider } = countingMailProvider();

  await assert.rejects(
    () => completeManualTask({
      db,
      config,
      recordId: rowId,
      stepId,
      note: 'try complete without review',
      skip: false,
      mailProvider: provider,
    }),
    (err) => {
      const msg = String(err?.message || err);
      assert.match(
        msg,
        /Stage review required before completing mail task/i,
        `complete must still refuse without stage review: ${msg}`,
      );
      return true;
    },
  );
  assert.equal(calls.length, 0, 'refused complete must not submit mail');

  // Park must still be open after refused complete.
  const listed = listAwaitingManualTasks({ db, config });
  assert.ok(
    listed.tasks.some((t) => t.record_id === rowId && t.step_id === stepId),
    'refused complete must leave the park listed',
  );
  db.close();
});

test('manual skip: suppressed record can be skipped without resurrecting or unsuppressing', async () => {
  const stepId = 'mail_golden';
  const productType = 'golden_ticket';
  const sequenceStep = 4;
  const { db, rowId } = seedParkedManual({
    rowId: 'skip_suppressed',
    stepId,
    productType,
    suppressed: 1,
    sequenceState: 'active',
    sequenceStep,
    stage_review_json: null,
  });
  const config = mailConfig({ stepId, productType });
  const { calls, provider } = countingMailProvider();

  // Complete must still refuse suppressed records.
  await assert.rejects(
    () => completeManualTask({
      db,
      config,
      recordId: rowId,
      stepId,
      note: 'try complete suppressed',
      mailProvider: provider,
    }),
    /record_suppressed/,
  );

  const skipped = await completeManualTask({
    db,
    config,
    recordId: rowId,
    stepId,
    note: 'opted out — clear park',
    skip: true,
    mailProvider: provider,
  });
  assert.equal(skipped.status, 'manual_skipped');
  assert.equal(calls.length, 0);

  const row = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  assert.equal(Number(row.suppressed), 1, 'skip must not unsuppress');
  assert.equal(Number(row.sequence_step), sequenceStep, 'skip must not advance sequence cursor');
  assert.equal(String(row.account_sequence_state), 'active');
  assert.notEqual(Number(row.mail_allocated || 0), 1, 'skip must not allocate mail');
  assert.equal(String(row.mail_provider_status || ''), '', 'skip must not set provider status');
  assert.equal(String(row.mail_last_piece_id || ''), '', 'skip must not set piece id');

  const listed = listAwaitingManualTasks({ db, config });
  assert.equal(
    listed.tasks.filter((t) => t.record_id === rowId).length,
    0,
    'skipped task must leave manual list',
  );
  db.close();
});

test('manual skip: paused_repair sequence can be skipped without unpausing', async () => {
  const stepId = 'mail_golden';
  const productType = 'golden_ticket';
  const sequenceStep = 2;
  const { db, rowId } = seedParkedManual({
    rowId: 'skip_paused_repair',
    stepId,
    productType,
    sequenceState: 'paused_repair',
    sequenceStep,
    stage_review_json: null,
  });
  const config = mailConfig({ stepId, productType });
  const { calls, provider } = countingMailProvider();

  await assert.rejects(
    () => completeManualTask({
      db,
      config,
      recordId: rowId,
      stepId,
      note: 'try complete paused',
      mailProvider: provider,
    }),
    /sequence_state_paused_repair/,
  );

  const skipped = await completeManualTask({
    db,
    config,
    recordId: rowId,
    stepId,
    note: 'repair in progress — decline mail',
    skip: true,
    mailProvider: provider,
  });
  assert.equal(skipped.status, 'manual_skipped');
  assert.equal(calls.length, 0);

  const row = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  assert.equal(String(row.account_sequence_state), 'paused_repair', 'skip must not unpause');
  assert.equal(Number(row.sequence_step), sequenceStep, 'skip must not advance cursor');
  assert.notEqual(Number(row.mail_allocated || 0), 1);

  const listed = listAwaitingManualTasks({ db, config });
  assert.equal(listed.tasks.filter((t) => t.record_id === rowId).length, 0);
  db.close();
});

test('manual skip: terminal (completed) sequence can be skipped without resurrecting', async () => {
  const stepId = 'mail_golden';
  const productType = 'golden_ticket';
  const sequenceStep = 7;
  const { db, rowId } = seedParkedManual({
    rowId: 'skip_terminal',
    stepId,
    productType,
    sequenceState: 'completed',
    sequenceStep,
    stage_review_json: null,
  });
  const config = mailConfig({ stepId, productType });
  const { calls, provider } = countingMailProvider();

  await assert.rejects(
    () => completeManualTask({
      db,
      config,
      recordId: rowId,
      stepId,
      note: 'try complete terminal',
      mailProvider: provider,
    }),
    /sequence_state_completed/,
  );

  const skipped = await completeManualTask({
    db,
    config,
    recordId: rowId,
    stepId,
    note: 'campaign already ended',
    skip: true,
    mailProvider: provider,
  });
  assert.equal(skipped.status, 'manual_skipped');
  assert.equal(calls.length, 0);

  const row = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  assert.equal(String(row.account_sequence_state), 'completed', 'skip must not resurrect sequence');
  assert.equal(Number(row.sequence_step), sequenceStep, 'skip must not advance cursor');
  assert.equal(String(row.sequence_status), 'active'); // seed value; skip must not flip it to running
  assert.notEqual(Number(row.mail_allocated || 0), 1);

  const listed = listAwaitingManualTasks({ db, config });
  assert.equal(listed.tasks.filter((t) => t.record_id === rowId).length, 0);
  db.close();
});

test('manual skip: records operator note and clears manual list; no external action scheduled', async () => {
  const stepId = 'mail_golden';
  const productType = 'golden_ticket';
  const { db, rowId } = seedParkedManual({
    rowId: 'skip_records_note',
    stepId,
    productType,
    stage_review_json: null,
  });
  const config = mailConfig({ stepId, productType });
  const { calls, provider } = countingMailProvider();

  const before = listAwaitingManualTasks({ db, config });
  assert.ok(before.tasks.some((t) => t.record_id === rowId));

  const note = 'operator:alice — lead not in service area';
  const result = await completeManualTask({
    db,
    config,
    recordId: rowId,
    stepId,
    note,
    skip: true,
    mailProvider: provider,
  });

  assert.equal(result.status, 'manual_skipped');
  assert.equal(result.note, note);
  assert.equal(calls.length, 0, 'no provider submit');

  const after = listAwaitingManualTasks({ db, config });
  assert.equal(after.tasks.filter((t) => t.record_id === rowId).length, 0);

  const events = db.prepare(`
    SELECT * FROM pipeline_events
    WHERE record_id = ? AND step_id = ? AND kind = 'manual_task' AND passed = 1
    ORDER BY occurred_at DESC
  `).all(rowId, stepId);
  assert.equal(events.length, 1);
  assert.match(String(events[0].reason), new RegExp(`^skipped:${note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));

  // No channel_events for mail submit/allocate on skip.
  try {
    const channelEvents = db.prepare(
      `SELECT * FROM channel_events WHERE row_id = ? AND channel = 'mail'`,
    ).all(rowId);
    assert.equal(channelEvents.length, 0, 'skip must not write mail channel events');
  } catch {
    // harness without channel_events table is fine
  }

  const row = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  assert.notEqual(Number(row.mail_allocated || 0), 1);
  assert.equal(String(row.mail_provider_status || ''), '');
  assert.equal(String(row.mail_last_piece_id || ''), '');
  db.close();
});

test('manual skip: refuses when no park exists (legitimacy still required)', async () => {
  const stepId = 'mail_golden';
  const productType = 'golden_ticket';
  const { db, rowId } = seedParkedManual({
    rowId: 'skip_no_park',
    stepId,
    productType,
  });
  // Remove the park so skip has nothing legitimate to clear.
  db.prepare(`DELETE FROM pipeline_events WHERE record_id = ?`).run(rowId);
  const config = mailConfig({ stepId, productType });

  await assert.rejects(
    () => completeManualTask({
      db,
      config,
      recordId: rowId,
      stepId,
      note: 'nothing parked',
      skip: true,
    }),
    /No awaiting manual task/,
  );
  db.close();
});
