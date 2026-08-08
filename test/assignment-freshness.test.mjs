import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runPipelineDataflow } from '../dist/orchestrator/pipeline/dataflow.js';
import { ensureRecordColumns, openListDb, upsertContact, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { executePipelineSequenceAction } from '../dist/orchestrator/pipeline/sequence-step-runtime.js';

const assignmentConfig = `
list:
  name: assignment-freshness
source:
  identity: [routing_signal]
sequences:
  default: { steps: [] }
  holding_route: { steps: [] }
  qualified_route: { steps: [] }
pipeline:
  - kind: assign
    id: route_from_signal
    inputs: [sequence_status, routing_signal]
    target: sequence_name
    fallback: holding_route
    rules:
      - id: signal_is_ready
        sequence: qualified_route
        conditions:
          - field: routing_signal
            operator: eq
            value: ready
score:
  criteria: []
`;

const createAssignmentList = ({ routingSignal = '' } = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-assignment-freshness-'));
  writeFileSync(join(listDir, 'outbound.yaml'), assignmentConfig);
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({ db, columns: [{ name: 'routing_signal', type: 'TEXT' }] });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, routing_signal, sequence_name, sequence_status,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES ('account_route', 'Example Account', ?, 'default', 'idle', ?, ?, ?, ?)
  `).run(routingSignal, now, now, now, now);
  db.close();
  return listDir;
};

const recordFor = (listDir) => {
  const db = openListDb({ listDir, readonly: false });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('account_route');
  db.close();
  return record;
};

const passedAssignmentCount = (listDir) => {
  const db = openListDb({ listDir, readonly: false });
  const count = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM pipeline_events
    WHERE record_id = 'account_route' AND step_id = 'route_from_signal' AND passed = 1
  `).get().count);
  db.close();
  return count;
};

const updateRoutingSignal = ({ listDir, routingSignal }) => {
  const db = openListDb({ listDir, readonly: false });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('account_route');
  upsertRecord({ db, row: { ...record, routing_signal: routingSignal } });
  db.close();
};

test('assignment persists its configured destination to the record', async () => {
  const listDir = createAssignmentList({ routingSignal: 'ready' });

  await runPipelineDataflow({ listDir });

  assert.equal(recordFor(listDir).sequence_name, 'qualified_route');
  assert.equal(passedAssignmentCount(listDir), 1);
});

test('channel execution preserves the selected sequence instead of restoring stale state', async () => {
  const listDir = createAssignmentList();
  const db = openListDb({ listDir, readonly: false });
  try {
    ensureRecordColumns({
      db,
      columns: [
        { name: 'readiness_json', type: 'TEXT' },
        { name: 'phone', type: 'TEXT' },
        { name: 'phone_confidence', type: 'REAL' },
        { name: 'contact_name', type: 'TEXT' },
      ],
    });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('account_route');
    upsertRecord({
      db,
      row: {
        ...record,
        readiness_json: JSON.stringify({ permitted_channels: ['phone'] }),
        phone: '208-555-0100',
        phone_confidence: 100,
        contact_name: 'Pat Contact',
      },
    });
    upsertContact({
      db,
      contact: {
        row_id: 'account_route',
        contact_id: 'route_contact',
        name: 'Pat Contact',
        phone: '208-555-0100',
      },
    });
    const staleRecord = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('account_route');

    const result = await executePipelineSequenceAction({
      db,
      listDir,
      record: staleRecord,
      config: {},
      sequenceName: 'qualified_route',
      stepNumber: 1,
      step: { id: 'selected_route_email', kind: 'send_email' },
      sequence: { steps: [] },
      dryRun: false,
      channelHint: 'email',
      now: '2026-08-07T12:00:00.000Z',
    });

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'channel_not_permitted:email');
    assert.equal(
      db.prepare('SELECT sequence_name FROM records WHERE _row_id = ?').get('account_route').sequence_name,
      'qualified_route',
    );
  } finally {
    db.close();
  }
});

test('assignment re-runs when a rule input changes after a prior resolution', async () => {
  const listDir = createAssignmentList();

  await runPipelineDataflow({ listDir });
  updateRoutingSignal({ listDir, routingSignal: 'ready' });
  await runPipelineDataflow({ listDir });

  assert.equal(recordFor(listDir).sequence_name, 'qualified_route');
  assert.equal(passedAssignmentCount(listDir), 2);
});

test('assignment remains resolved when its rule inputs are unchanged', async () => {
  const listDir = createAssignmentList({ routingSignal: 'ready' });

  await runPipelineDataflow({ listDir });
  await runPipelineDataflow({ listDir });

  assert.equal(recordFor(listDir).sequence_name, 'qualified_route');
  assert.equal(passedAssignmentCount(listDir), 1);
});
