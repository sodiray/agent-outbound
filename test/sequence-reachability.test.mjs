import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openListDb, ensureRecordColumns, upsertContact } from '../dist/orchestrator/runtime/db.js';
import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';
import { runHealthChecks } from '../dist/orchestrator/operator/health.js';
import {
  evaluateSequenceReachability,
  unreachableSequencePatch,
} from '../dist/orchestrator/policy/sequence-reachability.js';

const projectYaml = `
list:
  name: Sequence Reachability
business:
  name: Test
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
      - kind: manual_task
        id: phone_2
        day: 1
        config:
          channel: phone
          task_type: human_phone
policy:
  version: test
  enforce_readiness: false
channels: {}
`;

const nextAction = (accountId) => JSON.stringify({
  action_id: `na_${accountId}`,
  action_type: 'prepare_outbound',
  account_id: accountId,
  lifecycle_stage: 'contacted',
  sequence_state: 'active',
  work_state: 'executing_external_action',
  reason: 'test sequence reachability',
  on_success: 'continue',
  policy_version: 'test',
});

const emailStep = {
  kind: 'send_email',
  id: 'email_1',
  config: { channel: 'email' },
};

const seedList = ({
  rowId = 'unreachable_1',
  accountSequenceState = 'active',
  sequenceStatus = 'active',
  readinessJson = JSON.stringify({ permitted_channels: [] }),
  suppressed = 0,
} = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-sequence-reachability-'));
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml);
  writeFileSync(join(listDir, 'operator.md'), 'test');
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: [
      'lifecycle_stage', 'account_sequence_state', 'work_state', 'next_action_json',
      'readiness_json', 'suppressed', 'active_contact_id', 'contact_name', 'phone', 'contact_phone', 'phone_confidence',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      lifecycle_stage, account_sequence_state, work_state, next_action_json,
      readiness_json, suppressed, _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, 'No Contact Co', 'default', ?, 0, 'contacted', ?,
      'executing_external_action', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rowId,
    sequenceStatus,
    accountSequenceState,
    nextAction(rowId),
    readinessJson,
    suppressed,
    now,
    now,
    now,
    now,
  );
  return { db, listDir, rowId };
};

const execute = ({ db, listDir, record, dryRun = false, sequence = { steps: [emailStep] } }) =>
  executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Sequence Reachability',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step: emailStep,
    sequence,
    channelHint: 'email',
    intent: 'draft',
    dryRun,
  });

test('authoritative terminal sequence states veto stale sequence_status in every health in-play predicate', () => {
  const { db } = seedList({ rowId: 'health_not_started', accountSequenceState: 'not_started', sequenceStatus: 'idle' });
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, lifecycle_stage,
      account_sequence_state, next_action_json, disqualified_at,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, ?, 'default', ?, 'disqualified', ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const state of ['not_started', 'cancelled', 'completed']) {
    insert.run(
      `veto_${state}`,
      `Veto ${state}`,
      'idle',
      state,
      nextAction(`veto_${state}`),
      now,
      now,
      now,
      now,
      now,
    );
  }
  insert.run(
    'genuinely_active',
    'Genuinely Active',
    'idle',
    'active',
    nextAction('genuinely_active'),
    now,
    now,
    now,
    now,
    now,
  );

  const report = runHealthChecks({ db, limit: 100 });
  const contradictions = report.issues.filter((issue) => issue.code === 'in_play_disqualified_contradiction');
  assert.deepEqual(contradictions.map((issue) => issue.record_id), ['genuinely_active']);
  assert.equal(contradictions[0].severity, 'error');
  assert.equal(report.counts.false_pipeline_health, 0);
  db.close();
});

test('sequence enrollment refuses a record with no reachable contact', async () => {
  const { db, listDir, rowId } = seedList();
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const result = await execute({ db, listDir, record });
  assert.equal(result.status, 'skipped');
  assert.match(String(result.reason), /^sequence_unreachable:no_reachable_contact$/);
  const parked = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  assert.equal(parked.sequence_status, 'unreachable');
  assert.equal(parked.account_sequence_state, 'unreachable');
  assert.match(String(parked.last_error), /no reachable contact/i);
  db.close();
});

test('a record losing its last reachable contact leaves active for unreachable', async () => {
  const { db, listDir, rowId } = seedList({
    rowId: 'lost_contact',
    readinessJson: JSON.stringify({ permitted_channels: ['email'] }),
  });
  upsertContact({
    db,
    contact: {
      row_id: rowId,
      contact_id: 'c1',
      name: 'Pat Contact',
      email: 'pat@example.test',
    },
  });
  db.prepare('UPDATE records SET active_contact_id = ? WHERE _row_id = ?').run('c1', rowId);
  const withContact = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  assert.equal(evaluateSequenceReachability({
    record: withContact,
    contacts: [{ email: 'pat@example.test' }],
  }).reachable, true);
  upsertContact({
    db,
    contact: {
      row_id: rowId,
      contact_id: 'c1',
      name: 'Pat Contact',
      email: '',
    },
  });
  const withoutContact = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const result = await execute({ db, listDir, record: withoutContact });
  assert.equal(result.reason, 'sequence_unreachable:no_reachable_contact');
  const parked = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  assert.equal(parked.sequence_status, 'unreachable');
  assert.equal(parked.account_sequence_state, 'unreachable');
  db.close();
});

test('unreachable re-enters once a permitted reachable channel appears, without becoming suppression', async () => {
  const { db, listDir, rowId } = seedList({
    accountSequenceState: 'unreachable',
    sequenceStatus: 'unreachable',
    readinessJson: JSON.stringify({ permitted_channels: ['phone'] }),
  });
  db.prepare(`
    UPDATE records
    SET contact_name = 'Pat Contact', phone = '208-555-0100', contact_phone = '208-555-0100', phone_confidence = 100
    WHERE _row_id = ?
  `).run(rowId);
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const result = await execute({
    db,
    listDir,
    record,
    sequence: {
      steps: [
        emailStep,
        { kind: 'manual_task', id: 'phone_2', day: 1, config: { channel: 'phone', task_type: 'human_phone' } },
      ],
    },
  });
  assert.equal(result.reason, 'channel_not_permitted:email');
  const reentered = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  assert.equal(reentered.sequence_status, 'active');
  assert.equal(reentered.account_sequence_state, 'active');
  assert.equal(Number(reentered.suppressed), 0);
  db.close();
});

test('unreachable and suppression remain distinct facts', () => {
  const unreachable = evaluateSequenceReachability({
    record: { readiness_json: JSON.stringify({ permitted_channels: [] }) },
  });
  assert.equal(unreachable.reachable, false);
  assert.deepEqual(unreachableSequencePatch(), {
    sequence_status: 'unreachable',
    account_sequence_state: 'unreachable',
    next_action_date: '',
    last_error: 'No reachable contact on a permitted channel.',
  });
  const suppressed = evaluateSequenceReachability({
    record: { suppressed: 1, readiness_json: JSON.stringify({ permitted_channels: [] }) },
  });
  assert.equal(suppressed.applicable, false);
});

test('health reports active records with no reachable contact but not correctly parked records', () => {
  const { db } = seedList({ rowId: 'active_unreachable', readinessJson: JSON.stringify({ permitted_channels: [] }) });
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, lifecycle_stage,
      account_sequence_state, next_action_json, readiness_json,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES ('parked_unreachable', 'Parked', 'default', 'unreachable', 'contacted',
      'unreachable', ?, ?, ?, ?, ?, ?)
  `).run(nextAction('parked_unreachable'), JSON.stringify({ permitted_channels: [] }), now, now, now, now);
  const report = runHealthChecks({ db, limit: 100 });
  const issues = report.issues.filter((issue) => issue.code === 'active_without_reachable_contact');
  assert.deepEqual(issues.map((issue) => issue.record_id), ['active_unreachable']);
  assert.equal(issues[0].severity, 'warning');
  db.close();
});
