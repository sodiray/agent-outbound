/**
 * Work-item applicability: drafts and parked manual tasks must leave the
 * operator queue when the step they represent is no longer applicable —
 * without deleting the audit trail, and without revoking still-valid work.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  draftsListCommand,
} from '../dist/commands/drafts.js';
import {
  closeInapplicableManualParksForRecord,
  listAwaitingManualTasks,
} from '../dist/orchestrator/pipeline/manual.js';
import {
  draftInapplicabilityReason,
  manualParkInapplicabilityReason,
  recordTerminalWorkReason,
} from '../dist/orchestrator/lib/work-item-applicability.js';
import {
  ensureRecordColumns,
  insertDraft,
  openListDb,
  revokeInapplicableDraftsForRecord,
  upsertRecord,
} from '../dist/orchestrator/runtime/db.js';

const createList = (yamlExtra = '') => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-work-item-app-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
list:
  name: Work Item Applicability
business:
  name: Test
  description: Test
  icp: Test
  offer: Test
pipeline:
  - kind: assign
    id: route
    target: pipeline_name
    fallback: holding
    rules:
      - pipeline: tier_b
        conditions: [{ field: treatment_tier, operator: eq, value: B }]
      - pipeline: tier_c
        conditions: [{ field: treatment_tier, operator: eq, value: C }]
  - kind: pipeline
    id: tier_b
    steps:
      - kind: send_email
        id: email_1
        side_effecting: true
      - kind: manual_task
        id: mail_1
        config: { task_type: golden_ticket, channel: mail }
        when:
          match: all
          conditions:
            - field: mail_treatment
              operator: eq
              value: golden_ticket
  - kind: pipeline
    id: tier_c
    steps:
      - kind: send_email
        id: email_1
        side_effecting: true
  - kind: pipeline
    id: holding
    manual: true
    steps: []
sequences:
  tier_b:
    steps:
      - kind: send_email
        id: tier_b_email_1
        day: 0
  tier_c:
    steps:
      - kind: send_email
        id: tier_c_email_1
        day: 0
policy:
  enforce_readiness: false
${yamlExtra}
`);
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({
    db,
    columns: [
      'lifecycle_stage',
      'account_sequence_state',
      'work_state',
      'pipeline_name',
      'mail_treatment',
      'treatment_tier',
      'suppressed',
      'suppressed_reason',
      'disqualified_at',
    ],
  });
  return { listDir, db };
};

const seedRecord = ({
  db,
  rowId,
  sequenceName = 'tier_b',
  pipelineName = 'tier_b',
  sequenceState = 'active',
  suppressed = 0,
  mailTreatment = 'golden_ticket',
  treatmentTier = 'B',
  extras = {},
}) => {
  const now = new Date().toISOString();
  upsertRecord({
    db,
    row: {
      _row_id: rowId,
      business_name: `Biz ${rowId}`,
      sequence_name: sequenceName,
      pipeline_name: pipelineName,
      sequence_status: sequenceState === 'completed' || sequenceState === 'cancelled'
        ? sequenceState
        : 'active',
      account_sequence_state: sequenceState,
      lifecycle_stage: 'contacted',
      suppressed,
      mail_treatment: mailTreatment,
      treatment_tier: treatmentTier,
      contact_email: `${rowId}@example.test`,
      _created_at: now,
      _updated_at: now,
      created_at: now,
      updated_at: now,
      ...extras,
    },
  });
};

const pendingDraft = ({
  db,
  rowId,
  draftId,
  sequenceName = 'tier_b',
  stepId = 'tier_b_email_1',
}) => {
  insertDraft({
    db,
    draft: {
      draft_id: draftId,
      row_id: rowId,
      sequence_name: sequenceName,
      step_number: 1,
      step_id: stepId,
      channel: 'email',
      status: 'pending_approval',
      subject: 'Subject',
      body: 'Body',
    },
  });
};

const parkManual = ({
  db,
  rowId,
  stepId = 'tier_b.mail_1',
  at = '2026-08-01T10:00:00.000Z',
}) => {
  db.prepare(`
    INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
    VALUES (?, ?, ?, 'manual_task', 0, 'awaiting_manual', ?)
  `).run(`park_${rowId}_${stepId}`, rowId, stepId, at);
};

const pipelineConfig = {
  pipeline: [
    {
      kind: 'assign',
      id: 'route',
      target: 'pipeline_name',
      fallback: 'holding',
      rules: [
        { pipeline: 'tier_b', conditions: [{ field: 'treatment_tier', operator: 'eq', value: 'B' }] },
        { pipeline: 'tier_c', conditions: [{ field: 'treatment_tier', operator: 'eq', value: 'C' }] },
      ],
    },
    {
      kind: 'pipeline',
      id: 'tier_b',
      steps: [
        {
          kind: 'manual_task',
          id: 'mail_1',
          config: { task_type: 'golden_ticket', channel: 'mail' },
          when: {
            match: 'all',
            conditions: [{ field: 'mail_treatment', operator: 'eq', value: 'golden_ticket' }],
          },
        },
      ],
    },
    {
      kind: 'pipeline',
      id: 'tier_c',
      steps: [{ kind: 'send_email', id: 'email_1', side_effecting: true }],
    },
    { kind: 'pipeline', id: 'holding', manual: true, steps: [] },
  ],
};

// ── pure reason helpers ──────────────────────────────────────────────────────

test('recordTerminalWorkReason: suppressed and terminal sequence are clear-cut', () => {
  assert.equal(recordTerminalWorkReason({ suppressed: 1, suppressed_reason: 'hard_bounce' }), 'record_suppressed');
  assert.equal(recordTerminalWorkReason({ account_sequence_state: 'completed' }), 'sequence_terminal:completed');
  assert.equal(
    recordTerminalWorkReason({ account_sequence_state: 'completed' }, { includeCompletedSequence: false }),
    null,
  );
  assert.equal(recordTerminalWorkReason({ account_sequence_state: 'cancelled' }), 'sequence_terminal:cancelled');
  assert.equal(recordTerminalWorkReason({ account_sequence_state: 'active', suppressed: 0 }), null);
  // Temporary holds must not revoke work.
  assert.equal(recordTerminalWorkReason({ account_sequence_state: 'paused_review' }), null);
});

test('draftInapplicabilityReason: left sequence vs still a member', () => {
  const record = { sequence_name: 'tier_c', pipeline_name: 'tier_c', account_sequence_state: 'active' };
  assert.equal(
    draftInapplicabilityReason({
      draft: { sequence_name: 'tier_b', channel: 'email' },
      record,
    }),
    'left_sequence:tier_b',
  );
  assert.equal(
    draftInapplicabilityReason({
      draft: { sequence_name: 'tier_c', channel: 'email' },
      record,
    }),
    null,
  );
  // Bound to nested pipeline name still matches pipeline_name.
  assert.equal(
    draftInapplicabilityReason({
      draft: { sequence_name: 'tier_c', channel: 'email' },
      record: { sequence_name: 'default', pipeline_name: 'tier_c' },
    }),
    null,
  );
  // Author-step approvals are not sequence-membership bound.
  assert.equal(
    draftInapplicabilityReason({
      draft: { sequence_name: 'pipeline', channel: 'author_step' },
      record,
    }),
    null,
  );
});

// ── Case 1: draft from a sequence the record has left ────────────────────────

test('pending draft for a sequence the record has left is revoked with reason and no longer offered', () => {
  const { listDir, db } = createList();
  const rowId = 'left_seq_record';
  seedRecord({ db, rowId, sequenceName: 'tier_b', pipelineName: 'tier_b' });
  pendingDraft({ db, rowId, draftId: 'draft_tier_b', sequenceName: 'tier_b' });
  // Still-applicable sibling on the current sequence must survive.
  pendingDraft({ db, rowId, draftId: 'draft_tier_c', sequenceName: 'tier_c', stepId: 'tier_c_email_1' });

  // Re-tier B → C (the live validation case).
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  upsertRecord({
    db,
    row: {
      ...record,
      sequence_name: 'tier_c',
      pipeline_name: 'tier_c',
      treatment_tier: 'C',
    },
  });

  const left = db.prepare('SELECT status, reason FROM drafts WHERE draft_id = ?').get('draft_tier_b');
  assert.equal(left.status, 'revoked');
  assert.match(String(left.reason), /left_sequence:tier_b/);

  // Audit trail: row still findable, not deleted.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE draft_id = 'draft_tier_b'").get().n, 1);

  // Still-applicable draft on the new sequence is untouched.
  const kept = db.prepare('SELECT status, reason FROM drafts WHERE draft_id = ?').get('draft_tier_c');
  assert.equal(kept.status, 'pending_approval');

  // Operator list (pending_approval) no longer offers the left-sequence draft.
  const listed = draftsListCommand({ list: listDir, status: 'pending_approval' });
  const ids = listed.rows.map((r) => r.draft_id);
  assert.ok(!ids.includes('draft_tier_b'), `stale draft still listed: ${ids.join(',')}`);
  assert.ok(ids.includes('draft_tier_c'), 'still-applicable draft missing from list');

  db.close();
});

test('genuinely pending still-applicable draft is untouched by reconcile', () => {
  const { db } = createList();
  const rowId = 'still_valid_draft';
  seedRecord({ db, rowId, sequenceName: 'tier_b', pipelineName: 'tier_b' });
  pendingDraft({ db, rowId, draftId: 'draft_ok', sequenceName: 'tier_b' });

  const before = db.prepare('SELECT status, reason, updated_at FROM drafts WHERE draft_id = ?').get('draft_ok');
  const result = revokeInapplicableDraftsForRecord({
    db,
    record: db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId),
  });
  assert.equal(result.revoked, 0);
  const after = db.prepare('SELECT status, reason, updated_at FROM drafts WHERE draft_id = ?').get('draft_ok');
  assert.deepEqual(
    { status: after.status, reason: after.reason },
    { status: 'pending_approval', reason: before.reason },
  );
  db.close();
});

// ── Case 2: parked manual task no longer applicable ──────────────────────────

test('parked manual task for a step that now evaluates not-applicable is closed and not offered', () => {
  const { db } = createList();
  const rowId = 'mail_when_changed';
  seedRecord({
    db,
    rowId,
    sequenceName: 'tier_b',
    pipelineName: 'tier_b',
    mailTreatment: 'golden_ticket',
  });
  parkManual({ db, rowId, stepId: 'tier_b.mail_1' });

  // mail_treatment changed — when: no longer matches.
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  upsertRecord({
    db,
    row: { ...record, mail_treatment: 'standard_postcard' },
  });
  const refreshed = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);

  const reason = manualParkInapplicabilityReason({
    record: refreshed,
    step: {
      kind: 'manual_task',
      id: 'tier_b.mail_1',
      __subpipeline: 'tier_b',
      config: { task_type: 'golden_ticket', channel: 'mail' },
      when: {
        match: 'all',
        conditions: [{ field: 'mail_treatment', operator: 'eq', value: 'golden_ticket' }],
      },
    },
    config: pipelineConfig,
  });
  assert.ok(reason, 'expected when_not_matched reason');
  assert.match(String(reason), /when_not_matched|mail_treatment|golden_ticket|standard_postcard/i);

  const closed = closeInapplicableManualParksForRecord({
    db,
    config: pipelineConfig,
    record: refreshed,
  });
  assert.equal(closed.closed, 1);
  assert.match(closed.reasons[0].reason, /^skipped:not_applicable:/);

  // Original park event still present (audit trail).
  const parkEvents = db.prepare(`
    SELECT event_id, passed, reason FROM pipeline_events
    WHERE record_id = ? AND step_id = 'tier_b.mail_1' AND kind = 'manual_task'
    ORDER BY occurred_at ASC
  `).all(rowId);
  assert.ok(parkEvents.length >= 2, 'park + close events expected');
  assert.equal(parkEvents[0].passed, 0);
  assert.equal(parkEvents[0].reason, 'awaiting_manual');
  assert.equal(parkEvents[parkEvents.length - 1].passed, 1);
  assert.match(String(parkEvents[parkEvents.length - 1].reason), /^skipped:not_applicable:/);

  // No longer offered on the manual list.
  const listed = listAwaitingManualTasks({ db, config: pipelineConfig, reconcile: true });
  assert.equal(listed.tasks.filter((t) => t.record_id === rowId).length, 0);

  // Nothing deleted.
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM pipeline_events WHERE record_id = ? AND step_id = 'tier_b.mail_1'`).get(rowId).n,
    parkEvents.length,
  );

  db.close();
});

test('parked task on a suppressed or terminal-sequence record is not offered', () => {
  const { db } = createList();

  seedRecord({ db, rowId: 'suppressed_park', sequenceName: 'tier_b', pipelineName: 'tier_b' });
  parkManual({ db, rowId: 'suppressed_park', stepId: 'tier_b.mail_1' });
  const sup = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('suppressed_park');
  upsertRecord({
    db,
    row: { ...sup, suppressed: 1, suppressed_reason: 'hard_bounce' },
  });

  seedRecord({ db, rowId: 'terminal_park', sequenceName: 'tier_b', pipelineName: 'tier_b' });
  parkManual({ db, rowId: 'terminal_park', stepId: 'tier_b.mail_1' });
  const term = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('terminal_park');
  upsertRecord({
    db,
    row: {
      ...term,
      account_sequence_state: 'completed',
      sequence_status: 'completed',
    },
  });

  const listed = listAwaitingManualTasks({ db, config: pipelineConfig, reconcile: true });
  const ids = listed.tasks.map((t) => t.record_id);
  assert.ok(!ids.includes('suppressed_park'), 'suppressed park still offered');
  assert.ok(!ids.includes('terminal_park'), 'terminal park still offered');

  // Audit: close reasons recorded.
  const supClose = db.prepare(`
    SELECT reason FROM pipeline_events
    WHERE record_id = 'suppressed_park' AND passed = 1 AND reason LIKE 'skipped:not_applicable:%'
  `).get();
  assert.match(String(supClose?.reason || ''), /record_suppressed/);

  const termClose = db.prepare(`
    SELECT reason FROM pipeline_events
    WHERE record_id = 'terminal_park' AND passed = 1 AND reason LIKE 'skipped:not_applicable:%'
  `).get();
  assert.match(String(termClose?.reason || ''), /sequence_terminal:completed/);

  db.close();
});

test('parked task after record left the pipeline subpipeline is closed with left_pipeline reason', () => {
  const { db } = createList();
  const rowId = 'left_pipeline_park';
  seedRecord({ db, rowId, sequenceName: 'tier_b', pipelineName: 'tier_b' });
  parkManual({ db, rowId, stepId: 'tier_b.mail_1' });

  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  upsertRecord({
    db,
    row: {
      ...record,
      sequence_name: 'tier_c',
      pipeline_name: 'tier_c',
      treatment_tier: 'C',
    },
  });
  const refreshed = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);

  const closed = closeInapplicableManualParksForRecord({
    db,
    config: pipelineConfig,
    record: refreshed,
  });
  assert.equal(closed.closed, 1);
  assert.match(closed.reasons[0].reason, /left_pipeline:tier_b/);

  const listed = listAwaitingManualTasks({ db, config: pipelineConfig });
  assert.equal(listed.tasks.filter((t) => t.record_id === rowId).length, 0);
  db.close();
});

test('genuinely pending still-applicable parked task is untouched', () => {
  const { db } = createList();
  const rowId = 'still_valid_park';
  seedRecord({
    db,
    rowId,
    sequenceName: 'tier_b',
    pipelineName: 'tier_b',
    mailTreatment: 'golden_ticket',
    sequenceState: 'active',
  });
  parkManual({ db, rowId, stepId: 'tier_b.mail_1' });

  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const closed = closeInapplicableManualParksForRecord({
    db,
    config: pipelineConfig,
    record,
  });
  assert.equal(closed.closed, 0);

  const listed = listAwaitingManualTasks({ db, config: pipelineConfig, reconcile: true });
  assert.equal(listed.tasks.filter((t) => t.record_id === rowId).length, 1);

  // Only the original park event — no close event written.
  const events = db.prepare(`
    SELECT passed, reason FROM pipeline_events
    WHERE record_id = ? AND step_id = 'tier_b.mail_1' AND kind = 'manual_task'
  `).all(rowId);
  assert.equal(events.length, 1);
  assert.equal(events[0].passed, 0);
  assert.equal(events[0].reason, 'awaiting_manual');
  db.close();
});

test('inconclusive re-evaluation does not revoke: missing config leaves park alone', () => {
  const { db } = createList();
  const rowId = 'no_config_park';
  seedRecord({ db, rowId, sequenceName: 'tier_b', pipelineName: 'tier_b' });
  parkManual({ db, rowId, stepId: 'tier_b.mail_1' });

  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  // Without config we cannot judge when:/membership — only terminal would fire.
  const closed = closeInapplicableManualParksForRecord({
    db,
    config: undefined,
    record,
  });
  assert.equal(closed.closed, 0);
  const listed = listAwaitingManualTasks({ db, reconcile: false });
  assert.equal(listed.tasks.filter((t) => t.record_id === rowId).length, 1);
  db.close();
});
