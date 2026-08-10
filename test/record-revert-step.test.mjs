/**
 * record revert: any resolved pipeline step (not only enrich).
 * Clears outputs + staleness + passed pipeline_events. Never touches drafts /
 * live_interaction_ledger / interactions / suppression.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { recordRevertStepCommand } from '../dist/commands/safety.js';
import {
  ensureRecordColumns,
  hasPassedStep,
  insertPipelineEvent,
  openListDb,
  upsertRecord,
} from '../dist/orchestrator/runtime/db.js';
import { AgentOutboundError } from '../dist/orchestrator/runtime/contract.js';

const TRANSMIT_WARNING =
  'this step transmits; reverting only clears pipeline state, it does not undo anything that was sent';

const createList = (pipelineYaml) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-record-revert-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
list: { name: Record Revert }
business: { name: Test, description: Test, icp: Test, offer: Test }
pipeline:
${pipelineYaml}
sequences:
  default:
    steps: []
policy: { enforce_readiness: false }
`);
  writeFileSync(join(listDir, 'operator.md'), 'ops');
  writeFileSync(join(listDir, 'mcp.json'), '{}');
  return listDir;
};

const seedResolvedStep = ({
  listDir,
  recordId,
  stepId,
  kind,
  columns = {},
  sideEffecting = false,
}) => {
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const columnNames = Object.keys(columns);
  if (columnNames.length) ensureRecordColumns({ db, columns: columnNames });
  upsertRecord({
    db,
    row: {
      _row_id: recordId,
      business_name: 'Revert Co',
      ...columns,
    },
  });
  db.prepare(`
    INSERT INTO staleness (id, record_id, step_id, dep_hash, cache_ttl, cache_ttl_seconds, updated_at)
    VALUES (?, ?, ?, ?, '', 0, ?)
  `).run(randomUUID(), recordId, stepId, 'dep-hash-prior', now);
  insertPipelineEvent({
    db,
    event: {
      event_id: `passed_${stepId}_${recordId}`,
      record_id: recordId,
      step_id: stepId,
      kind,
      passed: true,
      reason: 'ok',
      side_effecting: sideEffecting,
      occurred_at: now,
    },
  });
  // A non-passed park event must not be treated as the resolution we clear for
  // re-run, but also must not be required for the three-surface contract.
  insertPipelineEvent({
    db,
    event: {
      event_id: `park_${stepId}_${recordId}`,
      record_id: recordId,
      step_id: stepId,
      kind,
      passed: false,
      reason: 'awaiting_manual',
      side_effecting: sideEffecting,
      occurred_at: now,
    },
  });
  return db;
};

test('record revert clears a resolved compose step: outputs, staleness, and passed events', () => {
  const listDir = createList(`
  - kind: compose
    id: compose_email_slots
    model: anthropic/claude-haiku-4-5-20251001
    structure:
      email_subject: Subject.
      email_body: Body.
    inputs:
      account: { from: business_name, required: true }
    length: { max_words: 80, max_sentences: 8 }
    outputs:
      email_subject: { type: string, description: Subject }
      email_body: { type: string, description: Body }
`);
  const recordId = 'compose_rec_1';
  const stepId = 'compose_email_slots';
  const db = seedResolvedStep({
    listDir,
    recordId,
    stepId,
    kind: 'compose',
    columns: {
      email_subject: 'Old subject',
      email_body: 'Old body',
    },
  });
  assert.equal(hasPassedStep({ db, recordId, stepId }), true);
  db.close();

  const result = recordRevertStepCommand({ list: listDir, rowId: recordId, stepId });
  assert.equal(result.status, 'reverted');
  assert.equal(result.row_id, recordId);
  assert.equal(result.step_id, stepId);
  assert.deepEqual(result.cleared_columns.sort(), ['email_body', 'email_subject']);
  assert.equal(result.staleness_rows_deleted, 1);
  assert.equal(result.events_deleted, 1);
  assert.equal(result.warning, undefined);

  const after = openListDb({ listDir, readonly: true });
  try {
    const row = after.prepare('SELECT email_subject, email_body FROM records WHERE _row_id = ?').get(recordId);
    assert.equal(row.email_subject, '');
    assert.equal(row.email_body, '');
    assert.equal(
      after.prepare('SELECT COUNT(*) AS n FROM staleness WHERE record_id = ? AND step_id = ?').get(recordId, stepId).n,
      0,
    );
    assert.equal(
      after.prepare('SELECT COUNT(*) AS n FROM pipeline_events WHERE record_id = ? AND step_id = ? AND passed = 1')
        .get(recordId, stepId).n,
      0,
    );
    // Non-passed park events remain; only passed resolution is cleared.
    assert.equal(
      after.prepare('SELECT COUNT(*) AS n FROM pipeline_events WHERE record_id = ? AND step_id = ? AND passed = 0')
        .get(recordId, stepId).n,
      1,
    );
    assert.equal(hasPassedStep({ db: after, recordId, stepId }), false);
  } finally {
    after.close();
  }
});

test('record revert on send_* clears pipeline state, warns, and leaves drafts + live ledger untouched', () => {
  const listDir = createList(`
  - kind: assign
    id: route_pipeline
    inputs: [sequence_status]
    target: pipeline_name
    fallback: tier_b
  - kind: pipeline
    id: tier_b
    manual: true
    steps:
      - kind: send_email
        id: email_1
        side_effecting: true
        config:
          channel: email
          action: tool_call
          args: { subject: Hello, body: World }
`);
  const recordId = 'send_rec_1';
  const stepId = 'tier_b.email_1';
  const now = new Date().toISOString();
  const db = seedResolvedStep({
    listDir,
    recordId,
    stepId,
    kind: 'send_email',
    sideEffecting: true,
  });
  db.prepare(`
    INSERT INTO drafts (
      draft_id, row_id, sequence_name, step_number, step_id, channel, status,
      subject, body, created_at, updated_at
    ) VALUES (?, ?, 'default', 1, ?, 'email', 'sent', 'Hello', 'World', ?, ?)
  `).run('draft_send_1', recordId, stepId, now, now);
  db.prepare(`
    INSERT INTO live_interaction_ledger (
      ledger_id, identity_key, record_id, contact_id, channel, step_id,
      sequence_name, step_number, provider_id, provider_message_id,
      delivery_mode, status, occurred_at, created_at, updated_at
    ) VALUES (?, ?, ?, '', 'email', ?, 'default', 1, 'smtp', 'msg-1',
      'live', 'sent', ?, ?, ?)
  `).run('ledger_1', `live:${recordId}:${stepId}`, recordId, stepId, now, now, now);
  db.prepare(`
    INSERT INTO interactions (
      interaction_id, record_id, contact, kind, summary, body, objections,
      follow_up_at, follow_up_done_at, follow_up_note,
      occurred_at, created_at, updated_at, deleted_at
    ) VALUES (?, ?, '', 'email_sent', 'sent', 'World', '', '', '', '', ?, ?, ?, '')
  `).run('ix_1', recordId, now, now, now);
  assert.equal(hasPassedStep({ db, recordId, stepId }), true);
  db.close();

  const result = recordRevertStepCommand({ list: listDir, rowId: recordId, stepId });
  assert.equal(result.status, 'reverted');
  assert.equal(result.step_id, stepId);
  assert.equal(result.staleness_rows_deleted, 1);
  assert.equal(result.events_deleted, 1);
  assert.equal(result.warning, TRANSMIT_WARNING);

  const after = openListDb({ listDir, readonly: true });
  try {
    assert.equal(hasPassedStep({ db: after, recordId, stepId }), false);
    assert.equal(
      after.prepare('SELECT COUNT(*) AS n FROM pipeline_events WHERE record_id = ? AND step_id = ? AND passed = 1')
        .get(recordId, stepId).n,
      0,
    );
    // The assertion that matters: revert is pipeline state only, not unsend.
    const draft = after.prepare('SELECT * FROM drafts WHERE draft_id = ?').get('draft_send_1');
    assert.ok(draft, 'draft must remain');
    assert.equal(draft.status, 'sent');
    assert.equal(draft.subject, 'Hello');
    assert.equal(draft.body, 'World');

    const ledger = after.prepare('SELECT * FROM live_interaction_ledger WHERE ledger_id = ?').get('ledger_1');
    assert.ok(ledger, 'live interaction ledger must remain');
    assert.equal(ledger.status, 'sent');
    assert.equal(ledger.provider_message_id, 'msg-1');
    assert.equal(ledger.step_id, stepId);

    const interaction = after.prepare('SELECT * FROM interactions WHERE interaction_id = ?').get('ix_1');
    assert.ok(interaction, 'interactions must remain');
    assert.equal(interaction.kind, 'email_sent');
  } finally {
    after.close();
  }
});

test('record revert on enrich still clears outputs, staleness, and passed events (control)', () => {
  const listDir = createList(`
  - kind: enrich
    id: hiring-check
    inputs: [business_name]
    outputs:
      hiring_signal: { type: string, description: Hiring signal }
    columns:
      hiring_signal: hiring
`);
  const recordId = 'enrich_rec_1';
  const stepId = 'hiring-check';
  const db = seedResolvedStep({
    listDir,
    recordId,
    stepId,
    kind: 'enrich',
    columns: {
      hiring_signal: 'hiring now',
    },
  });
  // Legacy columns remap: clear both declared outputs keys and columns values.
  ensureRecordColumns({ db, columns: ['hiring'] });
  db.prepare('UPDATE records SET hiring = ? WHERE _row_id = ?').run('hiring now', recordId);
  assert.equal(hasPassedStep({ db, recordId, stepId }), true);
  db.close();

  const result = recordRevertStepCommand({ list: listDir, rowId: recordId, stepId });
  assert.equal(result.status, 'reverted');
  assert.deepEqual(result.cleared_columns.sort(), ['hiring', 'hiring_signal']);
  assert.equal(result.staleness_rows_deleted, 1);
  assert.equal(result.events_deleted, 1);
  assert.equal(result.warning, undefined);

  const after = openListDb({ listDir, readonly: true });
  try {
    const row = after.prepare('SELECT hiring_signal, hiring FROM records WHERE _row_id = ?').get(recordId);
    assert.equal(row.hiring_signal, '');
    assert.equal(row.hiring, '');
    assert.equal(hasPassedStep({ db: after, recordId, stepId }), false);
  } finally {
    after.close();
  }
});

test('record revert unknown step id returns NOT_FOUND', () => {
  const listDir = createList(`
  - kind: enrich
    id: hiring-check
    inputs: [business_name]
    outputs:
      hiring_signal: { type: string, description: Hiring signal }
`);
  let thrown;
  try {
    recordRevertStepCommand({ list: listDir, rowId: 'any', stepId: 'does_not_exist' });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof AgentOutboundError);
  assert.equal(thrown.code, 'NOT_FOUND');
  assert.match(String(thrown.message || ''), /Step not found|not found/i);
});
