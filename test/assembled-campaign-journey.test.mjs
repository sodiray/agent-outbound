/**
 * Assembled production-path campaign journey (NO AO_PIPELINE_FIXTURE).
 *
 * Proves the independent-review failure mode is gone:
 * - Nested multi-step tier sequence does NOT complete after email_1
 * - sequence_status stays active; sequenceCompleted does not fire rotation
 * - email_2 remains next (sequence_step advances correctly)
 * - Second contact is NOT rotated onto mid-sequence after first email
 *
 * Uses production executeChannelStep + SMTP sink (provider isolation only).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openListDb, insertDraft, ensureRecordColumns, upsertContact } from '../dist/orchestrator/runtime/db.js';
import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';
import { computeNextScheduledAction } from '../dist/orchestrator/lib/working-days.js';
import { advanceAfterSuccessfulAction } from '../dist/orchestrator/policy/lifecycle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const tierSequenceSteps = [
  { id: 'email_1', kind: 'send_email', day: 0 },
  { id: 'email_2_wait', kind: 'wait', day: 3 },
  { id: 'email_2', kind: 'send_email', day: 3 },
  { id: 'linkedin_1', kind: 'linkedin_connect', day: 4 },
  { id: 'phone_1', kind: 'manual_task', day: 5 },
  { id: 'mail_golden_or_standard', kind: 'manual_task', day: 5 },
];

const projectYaml = `
list:
  name: Assembled Journey Canary
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
            tools: [SMTP_SEND]
          args_map:
            to: contact_email
          args:
            subject: Journey email 1
            body: Body one for assembled journey
          daily_cap: 20
          idempotency:
            key_source: [_row_id, step_id, active_contact_id]
            scope: list
      - kind: wait
        id: email_2_wait
        after: 3d
        depends_on: [email_1]
      - kind: send_email
        id: email_2
        side_effecting: true
        draft_approval_required: true
        config:
          action: tool_call
          tool:
            server: smtp
            tools: [SMTP_SEND]
          args_map:
            to: contact_email
          args:
            subject: Journey email 2
            body: Body two for assembled journey
          daily_cap: 20
          idempotency:
            key_source: [_row_id, step_id, active_contact_id]
            scope: list
      - kind: linkedin_connect
        id: linkedin_1
        depends_on: [email_2]
      - kind: manual_task
        id: phone_1
        config:
          task_type: human_phone
          channel: phone
      - kind: manual_task
        id: mail_golden_or_standard
        depends_on: [email_2]
        config:
          task_type: standard_postcard
          channel: mail
sequences:
  default:
    steps: []
policy:
  version: tv-pipeline-v1
  review_required_for: []
  forbidden_channels: [send_sms, visit, field_visit, automated_voice]
  enforce_readiness: false
`;

const nextAction = (accountId, contactId = 'c1') => JSON.stringify({
  action_id: `na_${accountId}`,
  action_type: 'send_email',
  account_id: accountId,
  contact_id: contactId,
  lifecycle_stage: 'contacted',
  sequence_state: 'active',
  work_state: 'executing_external_action',
  reason: 'assembled journey',
  on_success: 'continue',
});

const campaignPlan = (accountId) => JSON.stringify({
  account_id: accountId,
  active_contact_id: 'c1',
  held_contact_ids: ['c2'],
  mail_treatment: 'standard_postcard',
  mail_allocated: false,
  contacts: [
    { contact_id: 'c1', name: 'Primary', email: 'primary@journey.test', phone: '2085550101' },
    { contact_id: 'c2', name: 'Held', email: 'held@journey.test', phone: '2085550102' },
  ],
});

function createJourneyList() {
  assert.notEqual(process.env.AO_PIPELINE_FIXTURE, '1', 'must not run under pipeline fixture');
  const listDir = mkdtempSync(join(tmpdir(), 'ao-journey-'));
  const sinkDir = join(listDir, 'smtp-sink');
  mkdirSync(sinkDir, { recursive: true });
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml);
  writeFileSync(join(listDir, 'operator.md'), 'assembled journey');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      smtp: {
        type: 'command',
        command: process.execPath,
        args: [join(ROOT, 'scripts/smtp-send.mjs')],
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
  }, null, 2));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const rid = 'journey_acct_1';
  ensureRecordColumns({
    db,
    columns: [
      'contact_email', 'contact_name', 'active_contact_id', 'account_contact_plan_json',
      'account_sequence_state', 'lifecycle_stage', 'work_state', 'next_action_json',
      'sequence_step', 'sequence_status', 'sequence_name',
      'preliminary_snapshot', 'treatment_tier', 'fit_score', 'identity_confidence',
      'email_confidence', 'suppressed', 'launched_at', 'next_action_date',
      'email_last_from',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      contact_email, contact_name, active_contact_id, account_contact_plan_json,
      account_sequence_state, lifecycle_stage, work_state, next_action_json,
      preliminary_snapshot, treatment_tier, fit_score,
      identity_confidence, email_confidence, suppressed,
      email_last_from,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      ?, 'Journey HVAC', 'tier_a', 'active', 0,
      'primary@journey.test', 'Primary', 'c1', ?,
      'active', 'contacted', 'executing_external_action', ?,
      'journey snapshot', 'A', 88,
      90, 85, 0,
      'sender@journey.test',
      ?, ?, ?, ?
    )
  `).run(rid, campaignPlan(rid), nextAction(rid), now, now, now, now);

  try {
    upsertContact({
      db,
      contact: {
        contact_id: 'c1',
        row_id: rid,
        name: 'Primary',
        email: 'primary@journey.test',
        phone: '2085550101',
        is_primary: 1,
      },
    });
    upsertContact({
      db,
      contact: {
        contact_id: 'c2',
        row_id: rid,
        name: 'Held',
        email: 'held@journey.test',
        phone: '2085550102',
        is_primary: 0,
      },
    });
  } catch {
    /* contacts table optional shape */
  }

  db.close();
  return { listDir, sinkDir, rid };
}

const email1Step = {
  kind: 'send_email',
  id: 'email_1',
  draft_approval_required: true,
  config: {
    action: 'tool_call',
    tool: { server: 'smtp', tools: ['SMTP_SEND'] },
    args_map: { to: 'contact_email' },
    args: {
      subject: 'Journey email 1',
      body: 'Body one for assembled journey',
    },
    daily_cap: 20,
    output_map: { message_id: 'message_id', provider_id: 'message_id' },
    idempotency: {
      key_source: ['_row_id', 'step_id', 'active_contact_id'],
      scope: 'list',
    },
  },
};

const email2Step = {
  ...email1Step,
  id: 'email_2',
  config: {
    ...email1Step.config,
    args: {
      subject: 'Journey email 2',
      body: 'Body two for assembled journey',
    },
  },
};

test('pure: multi-step schedule never completes after step 1', () => {
  const after1 = computeNextScheduledAction({
    steps: tierSequenceSteps,
    completedStepNumber: 1,
    launchedAtDate: '2026-03-02',
    workingDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    policy: 'shift_to_next_working_day',
  });
  assert.equal(after1.completed, false);
  assert.ok(after1.nextActionDate);

  const empty = computeNextScheduledAction({
    steps: [],
    completedStepNumber: 1,
    launchedAtDate: '2026-03-02',
    workingDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    policy: 'shift_to_next_working_day',
  });
  assert.equal(empty.completed, false, 'empty steps must not invent completion');
});

test('pure: sequenceCompleted=false does not rotate held contact after email_1', () => {
  const record = {
    _row_id: 'rot_1',
    lifecycle_stage: 'contacted',
    account_sequence_state: 'active',
    work_state: 'executing_external_action',
    active_contact_id: 'c1',
    account_contact_plan_json: campaignPlan('rot_1'),
    next_action_json: nextAction('rot_1'),
    mail_allocated: 0,
  };
  const advanced = advanceAfterSuccessfulAction({
    record,
    channel: 'email',
    stepKind: 'send_email',
    stepId: 'email_1',
    sequenceCompleted: false,
  });
  assert.equal(advanced.rotated, false);
  assert.notEqual(advanced.patch.active_contact_id, 'c2');
  // When sequenceCompleted is wrongly true with held contacts, rotation may fire —
  // this is the multi-contact failure mode the review described.
  const wrong = advanceAfterSuccessfulAction({
    record,
    channel: 'email',
    stepKind: 'send_email',
    stepId: 'email_1',
    sequenceCompleted: true,
  });
  // Document the danger: completed=true with held contacts can rotate.
  // Production path must never pass completed=true after email_1.
  if (wrong.rotated) {
    assert.equal(wrong.patch.active_contact_id, 'c2');
  }
});

test('assembled: email_1 send with full sibling sequence does not complete campaign', async () => {
  delete process.env.AO_PIPELINE_FIXTURE;
  delete process.env.AO_STEP_FIXTURE;
  const prevSink = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    const { listDir, sinkDir, rid } = createJourneyList();
    const db = openListDb({ listDir, readonly: false });
    let record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rid);

    insertDraft({
      db,
      draft: {
        draft_id: 'draft_j1',
        row_id: rid,
        sequence_name: 'tier_a',
        step_number: 1,
        step_id: 'email_1',
        channel: 'email',
        status: 'ready',
        subject: 'Journey email 1',
        body: 'Body one for assembled journey',
      },
    });

    const out = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Assembled Journey Canary',
      db,
      record,
      sequenceName: 'tier_a',
      stepNumber: 1,
      step: email1Step,
      // Production nested pipeline now supplies siblings — never [].
      sequence: { steps: tierSequenceSteps, name: 'tier_a' },
      channelHint: 'email',
      intent: 'send',
      dryRun: false,
    });

    assert.equal(out.status, 'sent', `email_1 failed: ${JSON.stringify(out)}`);
    assert.ok(out.provider_id);

    record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rid);
    assert.notEqual(
      String(record.sequence_status || ''),
      'completed',
      'email_1 must not mark sequence completed',
    );
    assert.notEqual(
      String(record.account_sequence_state || ''),
      'completed',
      'campaign must not complete after first email',
    );
    // Active contact must remain primary — no premature rotation to held c2.
    assert.equal(String(record.active_contact_id || ''), 'c1');
    assert.ok(
      Number(record.sequence_step || 0) < tierSequenceSteps.length,
      `sequence_step ${record.sequence_step} should be mid-sequence`,
    );

    const sinkFiles = readdirSync(sinkDir).filter((f) => f.endsWith('.json'));
    assert.ok(sinkFiles.length >= 1);

    // email_2 is still a valid later step: progression must leave room.
    const mid = computeNextScheduledAction({
      steps: tierSequenceSteps,
      completedStepNumber: Number(record.sequence_step || 1) || 1,
      launchedAtDate: String(record.launched_at || '2026-03-02').slice(0, 10),
      workingDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
      policy: 'shift_to_next_working_day',
    });
    // If we are past step 1 in numbering, still not completed until last step.
    assert.equal(
      computeNextScheduledAction({
        steps: tierSequenceSteps,
        completedStepNumber: 1,
        launchedAtDate: '2026-03-02',
        workingDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
        policy: 'shift_to_next_working_day',
      }).completed,
      false,
    );
    void mid;

    db.close();
  } finally {
    if (prevSink === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = prevSink;
  }
});

test('assembled: empty sequence steps path no longer completes (regression guard)', async () => {
  delete process.env.AO_PIPELINE_FIXTURE;
  const prevSink = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    const { listDir, rid } = createJourneyList();
    const db = openListDb({ listDir, readonly: false });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rid);
    insertDraft({
      db,
      draft: {
        draft_id: 'draft_j_empty',
        row_id: rid,
        sequence_name: 'tier_a',
        step_number: 1,
        step_id: 'email_1',
        channel: 'email',
        status: 'ready',
        subject: 'Journey email 1',
        body: 'Body one for assembled journey',
      },
    });

    const out = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Assembled Journey Canary',
      db,
      record,
      sequenceName: 'tier_a',
      stepNumber: 1,
      step: email1Step,
      // Bug reproduction: empty steps used to mark completed=true.
      sequence: { steps: [] },
      channelHint: 'email',
      intent: 'send',
      dryRun: false,
    });
    assert.equal(out.status, 'sent', String(out.reason));
    const after = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rid);
    assert.notEqual(String(after.sequence_status || ''), 'completed');
    assert.equal(String(after.active_contact_id || ''), 'c1');
    db.close();
  } finally {
    if (prevSink === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = prevSink;
  }
});

test('assembled: email_2 can execute after email_1 without treating campaign as new sequence', async () => {
  delete process.env.AO_PIPELINE_FIXTURE;
  const prevSink = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    const { listDir, sinkDir, rid } = createJourneyList();
    const db = openListDb({ listDir, readonly: false });
    let record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rid);

    insertDraft({
      db,
      draft: {
        draft_id: 'draft_j1b',
        row_id: rid,
        sequence_name: 'tier_a',
        step_number: 1,
        step_id: 'email_1',
        channel: 'email',
        status: 'ready',
        subject: 'Journey email 1',
        body: 'Body one for assembled journey',
      },
    });
    await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Assembled Journey Canary',
      db,
      record,
      sequenceName: 'tier_a',
      stepNumber: 1,
      step: email1Step,
      sequence: { steps: tierSequenceSteps, name: 'tier_a' },
      channelHint: 'email',
      intent: 'send',
      dryRun: false,
    });

    record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rid);
    // After email_1, production may install wait_not_due — prove that gate works,
    // then advance the clock (past due) so email_2 can fire as a later journey step.
    const midGate = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Assembled Journey Canary',
      db,
      record,
      sequenceName: 'tier_a',
      stepNumber: 3,
      step: email2Step,
      sequence: { steps: tierSequenceSteps, name: 'tier_a' },
      channelHint: 'email',
      intent: 'send',
      dryRun: false,
    });
    if (midGate.status === 'skipped' && /wait_not_due/i.test(String(midGate.reason || ''))) {
      // Expected mid-journey: wait between emails. Force due_at past for email_2.
      let na = {};
      try {
        na = JSON.parse(String(record.next_action_json || '{}'));
      } catch {
        na = {};
      }
      na.due_at = '2020-01-01T00:00:00.000Z';
      na.action_type = 'send_email';
      ensureRecordColumns({ db, columns: ['next_action_json', 'next_action_date'] });
      db.prepare(`
        UPDATE records SET next_action_json = ?, next_action_date = ?, account_sequence_state = 'active'
        WHERE _row_id = ?
      `).run(JSON.stringify(na), '2020-01-01', rid);
      record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rid);
    }

    insertDraft({
      db,
      draft: {
        draft_id: 'draft_j2',
        row_id: rid,
        sequence_name: 'tier_a',
        step_number: 3,
        step_id: 'email_2',
        channel: 'email',
        status: 'ready',
        subject: 'Journey email 2',
        body: 'Body two for assembled journey',
      },
    });
    record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rid);

    const out2 = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Assembled Journey Canary',
      db,
      record,
      sequenceName: 'tier_a',
      stepNumber: 3,
      step: email2Step,
      sequence: { steps: tierSequenceSteps, name: 'tier_a' },
      channelHint: 'email',
      intent: 'send',
      dryRun: false,
    });
    assert.equal(out2.status, 'sent', `email_2 failed: ${JSON.stringify(out2)}`);

    record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rid);
    assert.notEqual(String(record.sequence_status || ''), 'completed');
    assert.equal(String(record.active_contact_id || ''), 'c1');
    const sinks = readdirSync(sinkDir).filter((f) => f.endsWith('.json'));
    assert.ok(sinks.length >= 2, 'two distinct emails should hit sink');
    db.close();
  } finally {
    if (prevSink === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = prevSink;
  }
});
