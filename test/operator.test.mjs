import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

const projectConfig = ({
  priority = 'high',
  coalesceFor,
  sinkYaml,
} = {}) => `
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
${coalesceFor ? `    coalesce_for: ${coalesceFor}\n` : ''}\
    notify_on:
      - pending_changed
    sinks:
${sinkYaml || `      journal:
        type: file
        path: notifications.jsonl`}
watch:
  poll_replies_minutes: 1440
  poll_delivery_minutes: 1440
`;

const createProject = (configOptions = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'agent-outbound-operator-'));
  writeFileSync(join(listDir, 'outbound.yaml'), projectConfig(configOptions));
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

const notificationDeliveries = (listDir) => {
  const db = openListDb({ listDir, readonly: true });
  const rows = db.prepare(`
    SELECT * FROM notification_deliveries
    ORDER BY datetime(created_at) ASC
  `).all();
  db.close();
  return rows;
};

const forceDeliveryDue = (listDir) => {
  const db = openListDb({ listDir, readonly: false });
  db.prepare(`
    UPDATE notification_deliveries
    SET available_at = '2000-01-01T00:00:00.000Z'
    WHERE status IN ('pending', 'failed')
  `).run();
  db.close();
};

const addReplyPending = (listDir, { rowId, eventId }) => {
  const db = openListDb({ listDir, readonly: false });
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, pipeline_name, sequence_name,
      sequence_status, _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rowId,
    `Biz ${rowId}`,
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
    eventId,
    rowId,
    'email',
    'reply_detected',
    'reply_detected',
    'interested',
    timestamp,
    timestamp,
  );
  db.close();
};

const readNotificationPayloads = (listDir) => {
  const path = join(listDir, 'notifications.jsonl');
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map((line) => JSON.parse(line));
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

test('coalescing does not deliver before the first-enqueue deadline', async () => {
  const listDir = createProject({ coalesceFor: '2m' });
  const first = await monitorOnceCommand({ list: listDir });
  assert.equal(first.projects[0].queued_notifications.enqueued, 1);
  assert.equal(first.projects[0].notifications.attempted, 0);
  assert.equal(first.projects[0].notifications.delivered, 0);
  assert.equal(readNotificationPayloads(listDir).length, 0);

  const [delivery] = notificationDeliveries(listDir);
  assert.equal(delivery.status, 'pending');
  assert.ok(
    new Date(delivery.available_at).getTime() > Date.now() + 60_000,
    `expected available_at far enough in the future, got ${delivery.available_at}`,
  );
});

test('a recurring condition still delivers after repeated coalesces past the first deadline', async () => {
  // Regression: each coalesce used to reset available_at = now + coalesce_for,
  // so a condition that kept recurring never became due.
  const listDir = createProject({ coalesceFor: '2m' });
  const first = await monitorOnceCommand({ list: listDir });
  assert.equal(first.projects[0].queued_notifications.enqueued, 1);
  assert.equal(first.projects[0].notifications.delivered, 0);

  const originalAvailableAt = notificationDeliveries(listDir)[0].available_at;

  // Simulate time advancing across several monitor ticks that keep coalescing
  // new work into the same pending delivery.
  for (let i = 0; i < 4; i += 1) {
    addReplyPending(listDir, {
      rowId: `prospect_recur_${i}`,
      eventId: `event_recur_${i}`,
    });
    const tick = await monitorOnceCommand({ list: listDir });
    assert.equal(tick.projects[0].queued_notifications.coalesced, 1);
    assert.equal(tick.projects[0].notifications.delivered, 0);
    assert.equal(
      notificationDeliveries(listDir)[0].available_at,
      originalAvailableAt,
      'coalesce must not slide the first-enqueue deadline',
    );
  }

  // The first-enqueue deadline has arrived. A further recurring event must
  // still merge into the same row and then deliver — not push the due time
  // forward again (the live five-hour starvation failure mode).
  forceDeliveryDue(listDir);
  addReplyPending(listDir, {
    rowId: 'prospect_recur_due',
    eventId: 'event_recur_due',
  });
  const dueTick = await monitorOnceCommand({ list: listDir });
  assert.equal(dueTick.projects[0].queued_notifications.coalesced, 1);
  assert.equal(dueTick.projects[0].notifications.attempted, 1);
  assert.equal(dueTick.projects[0].notifications.delivered, 1);

  const payloads = readNotificationPayloads(listDir);
  assert.equal(payloads.length, 1);
  assert.ok(payloads[0].pendingIds.length >= 5);
  assert.deepEqual(payloads[0].events, ['pending_created']);
});

test('a burst of events inside the coalesce window produces one merged delivery', async () => {
  const listDir = createProject({ coalesceFor: '5m' });
  const first = await monitorOnceCommand({ list: listDir });
  assert.equal(first.projects[0].queued_notifications.enqueued, 1);
  assert.equal(first.projects[0].notifications.delivered, 0);

  const beforeCoalesce = notificationDeliveries(listDir)[0];
  const firmDeadline = beforeCoalesce.available_at;

  addReplyPending(listDir, { rowId: 'prospect_2', eventId: 'event_2' });
  addReplyPending(listDir, { rowId: 'prospect_3', eventId: 'event_3' });
  const mid = await monitorOnceCommand({ list: listDir });
  assert.equal(mid.projects[0].pending_created, 2);
  assert.equal(mid.projects[0].queued_notifications.coalesced, 1);
  assert.equal(mid.projects[0].queued_notifications.enqueued, 0);
  assert.equal(mid.projects[0].notifications.delivered, 0);

  const afterCoalesce = notificationDeliveries(listDir)[0];
  assert.equal(afterCoalesce.available_at, firmDeadline);
  assert.equal(notificationDeliveries(listDir).length, 1);

  const payload = JSON.parse(afterCoalesce.payload_json);
  assert.equal(payload.pendingIds.length, 3);
  assert.deepEqual(payload.events, ['pending_created']);

  forceDeliveryDue(listDir);
  const delivered = await monitorOnceCommand({ list: listDir });
  assert.equal(delivered.projects[0].notifications.delivered, 1);
  assert.equal(delivered.projects[0].notifications.attempted, 1);

  const payloads = readNotificationPayloads(listDir);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].pendingIds.length, 3);
  assert.equal(payloads[0].summary.total, 3);
});

test('failed notification delivery backs off available_at and retries later', async () => {
  const listDir = createProject({
    sinkYaml: `      failing:
        type: command
        command: "false"`,
  });
  const first = await monitorOnceCommand({ list: listDir });
  assert.equal(first.projects[0].notifications.attempted, 1);
  assert.equal(first.projects[0].notifications.delivered, 0);
  assert.equal(first.projects[0].notifications.failed, 1);

  const failed = notificationDeliveries(listDir)[0];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 1);
  const backoffAt = new Date(failed.available_at).getTime();
  assert.ok(
    backoffAt > Date.now() + 2_000,
    `expected failure backoff to push available_at forward, got ${failed.available_at}`,
  );

  // Not yet due — monitor must not re-attempt while backoff is active.
  const waiting = await monitorOnceCommand({ list: listDir });
  assert.equal(waiting.projects[0].notifications.attempted, 0);
  assert.equal(notificationDeliveries(listDir)[0].attempts, 1);

  // Switch to a working sink and force the backoff deadline due.
  writeFileSync(join(listDir, 'outbound.yaml'), projectConfig({
    sinkYaml: `      failing:
        type: file
        path: notifications.jsonl`,
  }));
  forceDeliveryDue(listDir);
  const retried = await monitorOnceCommand({ list: listDir });
  assert.equal(retried.projects[0].notifications.attempted, 1);
  assert.equal(retried.projects[0].notifications.delivered, 1);

  const delivered = notificationDeliveries(listDir)[0];
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.attempts, 2);
  assert.equal(readNotificationPayloads(listDir).length, 1);
});

test('coalesce payload merge keeps prior pending ids when new events arrive', async () => {
  const listDir = createProject({ coalesceFor: '5m' });
  await monitorOnceCommand({ list: listDir });

  const firstPendingIds = JSON.parse(
    notificationDeliveries(listDir)[0].payload_json,
  ).pendingIds;
  assert.equal(firstPendingIds.length, 1);

  writeFileSync(join(listDir, 'outbound.yaml'), projectConfig({
    priority: 'urgent',
    coalesceFor: '5m',
  }));
  const result = await monitorOnceCommand({ list: listDir });
  assert.equal(result.projects[0].pending_priority_changed, 1);
  assert.equal(result.projects[0].queued_notifications.coalesced, 1);
  assert.equal(result.projects[0].notifications.delivered, 0);

  const merged = JSON.parse(notificationDeliveries(listDir)[0].payload_json);
  assert.deepEqual(merged.pendingIds, firstPendingIds);
  assert.ok(merged.events.includes('pending_priority_changed'));
  assert.ok(merged.events.includes('pending_created'));
  assert.equal(merged.summary.by_priority.urgent, 1);
});
