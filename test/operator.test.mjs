import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  monitorOnceCommand,
  pendingActionCommand,
  pendingListCommand,
  pendingShowCommand,
} from '../dist/commands/operator.js';
import { openListDb } from '../dist/orchestrator/runtime/db.js';

const projectConfig = ({ priority = 'high' } = {}) => `
list:
  name: Operator Test
business:
  name: Mission
  description: Test outbound
  icp: Test prospects
  offer: Test offer
pipeline: []
sequences:
  default:
    steps: []
operations:
  instructions: operator.md
  objectives:
    primary: Handle every reply.
  observations:
    - id: reply_received
      source: channel_events
      when:
        event_type: reply_detected
    - id: pipeline_blocked
      source: operator_monitor_state
      when:
        status: error
  pending:
    rules:
      - id: handle_reply
        observation: reply_received
        kind: reply
        priority: ${priority}
      - id: repair_pipeline
        observation: pipeline_blocked
        kind: pipeline_blocked
        priority: urgent
  notifications:
    notify_on:
      - pending_changed
    sinks:
      journal:
        type: file
        path: notifications.jsonl
watch:
  poll_replies_minutes: 1440
  poll_delivery_minutes: 1440
`;

const createProject = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'agent-outbound-operator-'));
  writeFileSync(join(listDir, 'outbound.yaml'), projectConfig());
  writeFileSync(join(listDir, 'operator.md'), 'Own this outbound pipeline.');
  const db = openListDb({ listDir, readonly: false });
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, pipeline_name, sequence_name,
      sequence_status, _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'prospect_1',
    'Acme',
    'default',
    'default',
    'active',
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  );
  db.prepare(`
    INSERT INTO channel_events (
      event_id, row_id, channel, event_type, action, disposition,
      occurred_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'event_1',
    'prospect_1',
    'email',
    'reply_detected',
    'reply_detected',
    'interested',
    timestamp,
    timestamp,
  );
  db.prepare(`
    INSERT INTO operator_monitor_state (
      phase, last_attempted_at, last_succeeded_at, last_error
    ) VALUES ('replies', ?, ?, ''), ('delivery', ?, ?, '')
  `).run(timestamp, timestamp, timestamp, timestamp);
  db.close();
  return listDir;
};

test('monitor creates durable pending work and emits one structured notification', async () => {
  const listDir = createProject();
  const first = await monitorOnceCommand({ list: listDir });
  assert.equal(first.projects[0].pending_created, 1);
  assert.deepEqual(first.projects[0].ingestion, {
    replies: { due: false },
    delivery: { due: false },
  });
  assert.equal(first.projects[0].notifications.delivered, 1);

  const payloads = readFileSync(join(listDir, 'notifications.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0].events, ['pending_created']);
  assert.equal(payloads[0].summary.by_priority.high, 1);

  const second = await monitorOnceCommand({ list: listDir });
  assert.equal(second.projects[0].pending_created, 0);
  assert.equal(second.projects[0].notifications.attempted, 0);
});

test('pending lifecycle enforces exclusive claims and records resolution evidence', () => {
  const listDir = createProject();
  const pending = pendingListCommand({ list: listDir });
  const pendingId = pending.projects[0].items[0].pending_id;

  const claimed = pendingActionCommand({
    list: listDir,
    pendingId,
    action: 'claim',
    owner: 'owner-agent',
    taskId: 'delegated-task',
    idemKey: 'wake-1',
  });
  assert.equal(claimed.item.status, 'claimed');
  assert.equal(claimed.item.owner_id, 'owner-agent');

  const repeated = pendingActionCommand({
    list: listDir,
    pendingId,
    action: 'claim',
    owner: 'owner-agent',
    taskId: 'delegated-task',
    idemKey: 'wake-1',
  });
  assert.equal(repeated.already_done, true);

  assert.throws(() => pendingActionCommand({
    list: listDir,
    pendingId,
    action: 'claim',
    owner: 'another-agent',
  }), /cannot be claimed/);

  pendingActionCommand({
    list: listDir,
    pendingId,
    action: 'resolve',
    owner: 'owner-agent',
    reason: 'Replied and verified the resulting state.',
    evidenceJson: '{"reply_sent":true}',
    actionsJson: '["reply sent","stage updated"]',
    idemKey: 'wake-1',
  });
  const resolved = pendingShowCommand({ list: listDir, pendingId }).item;
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolution_evidence.actor, 'owner-agent');
  assert.deepEqual(resolved.resolution_evidence.source_state, { reply_sent: true });
  assert.deepEqual(resolved.resolution_evidence.actions, ['reply sent', 'stage updated']);
  assert.deepEqual(
    resolved.history.map(event => event.action),
    ['created', 'claim', 'resolve'],
  );
});

test('an active pending priority change emits a coalesced operator event', async () => {
  const listDir = createProject();
  await monitorOnceCommand({ list: listDir });
  writeFileSync(join(listDir, 'outbound.yaml'), projectConfig({ priority: 'urgent' }));

  const result = await monitorOnceCommand({ list: listDir });
  assert.equal(result.projects[0].pending_priority_changed, 1);
  assert.equal(result.projects[0].notifications.delivered, 1);
  const payloads = readFileSync(join(listDir, 'notifications.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(payloads[1].events, ['pending_priority_changed']);
  assert.equal(payloads[1].summary.by_priority.urgent, 1);
});

test('provider polling failures become urgent pending work and clear after recovery', () => {
  const listDir = createProject();
  const db = openListDb({ listDir, readonly: false });
  db.prepare(`
    UPDATE operator_monitor_state
    SET last_error = 'Provider unavailable'
    WHERE phase = 'replies'
  `).run();
  db.close();

  const blocked = pendingListCommand({
    list: listDir,
    kind: 'pipeline_blocked',
  });
  assert.equal(blocked.summary.total, 1);
  assert.equal(blocked.projects[0].items[0].priority, 'urgent');

  const recoveredDb = openListDb({ listDir, readonly: false });
  recoveredDb.prepare(`
    UPDATE operator_monitor_state
    SET last_error = ''
    WHERE phase = 'replies'
  `).run();
  recoveredDb.close();
  const recovered = pendingListCommand({
    list: listDir,
    kind: 'pipeline_blocked',
  });
  assert.equal(recovered.summary.total, 0);
});
