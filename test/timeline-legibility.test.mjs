import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { recordShowCommand } from '../dist/commands/data-access.js';
import { getAccountTimeline } from '../dist/orchestrator/operator/timeline.js';
import {
  insertChannelEvent,
  insertPipelineEvent,
  openListDb,
} from '../dist/orchestrator/runtime/db.js';

const createList = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-timeline-legibility-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
list:
  name: Timeline legibility
business:
  name: Test
  description: Test
  icp: Test
  offer: Test
pipeline: []
sequences:
  default:
    steps: []
`);
  return listDir;
};

test('record show never presents future successful channel events as occurred for an opted-out lead', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  const now = '2026-08-09T14:44:00.000Z';
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, suppressed, suppressed_reason, sequence_status,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, ?, 1, 'opt_out', 'opted_out', ?, ?, ?, ?)
  `).run('opted_out_lead', 'Opted Out Lead', now, now, now, now);
  db.prepare(`
    INSERT INTO channel_events (
      event_id, row_id, channel, event_type, action, disposition, occurred_at, created_at
    ) VALUES
      ('planned_draft', 'opted_out_lead', 'email', 'draft_created', 'draft_created', 'ok', '2026-08-11T16:00:00.000Z', ?),
      ('planned_send_1', 'opted_out_lead', 'email', 'executed', 'executed', 'ok', '2026-08-11T17:00:00.000Z', ?),
      ('planned_send_2', 'opted_out_lead', 'email', 'executed', 'executed', 'ok', '2026-08-15T16:00:00.000Z', ?)
  `).run(now, now, now);
  db.prepare(`
    INSERT INTO routes (id, route_date, status, total_drive_minutes, summary_json, created_at, updated_at)
    VALUES ('route_1', '2026-08-11', 'planned', 0, '{}', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO route_stops (
      id, route_id, record_id, stop_order, scheduled_time, created_at, updated_at
    ) VALUES ('planned_visit', 'route_1', 'opted_out_lead', 1, '2026-08-11T18:00:00.000Z', ?, ?)
  `).run(now, now);
  db.close();

  const shown = recordShowCommand({ list: listDir, rowId: 'opted_out_lead', include: 'events' });
  const futureSuccesses = shown.sections.events.filter((event) => (
    event.occurred_at > now && event.disposition === 'ok'
  ));
  const plans = shown.sections.events.filter((event) => event.tense === 'planned');

  assert.deepEqual(futureSuccesses, []);
  assert.deepEqual(plans, []);
});

test('record show reports planned entries by tense and keeps their disposition non-successful', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  const now = '2026-08-08T14:44:00.000Z';
  db.prepare(`
    INSERT INTO records (_row_id, business_name, sequence_status, _created_at, _updated_at, created_at, updated_at)
    VALUES ('active_lead', 'Active Lead', 'active', ?, ?, ?, ?)
  `).run(now, now, now, now);
  insertChannelEvent({
    db,
    event: {
      event_id: 'planned_email',
      row_id: 'active_lead',
      channel: 'email',
      event_type: 'executed',
      disposition: 'ok',
      occurred_at: '2026-08-11T17:00:00.000Z',
    },
  });
  const stored = db.prepare(`
    SELECT tense, disposition, provider_message_id
    FROM channel_events
    WHERE event_id = 'planned_email'
  `).get();
  db.close();

  const shown = recordShowCommand({ list: listDir, rowId: 'active_lead', include: 'events' });
  const planned = shown.sections.events.find((event) => event.timeline_id === 'planned_email');

  assert.equal(planned.tense, 'planned');
  assert.equal(planned.disposition, '');
  assert.deepEqual(stored, {
    tense: 'planned',
    disposition: '',
    provider_message_id: '',
  });
});

test('timeline distinguishes evidenced engine sends from author-declared dispatches', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  const at = '2026-08-08T14:44:00.000Z';
  db.prepare(`
    INSERT INTO records (_row_id, business_name, sequence_status, _created_at, _updated_at, created_at, updated_at)
    VALUES ('provenance_lead', 'Provenance Lead', 'active', ?, ?, ?, ?)
  `).run(at, at, at, at);
  insertChannelEvent({
    db,
    event: {
      event_id: 'engine_send',
      row_id: 'provenance_lead',
      channel: 'email',
      event_type: 'executed',
      disposition: 'ok',
      provider_message_id: 'provider-message-1',
      provenance: 'performed_and_evidenced',
      occurred_at: at,
    },
  });
  insertPipelineEvent({
    db,
    event: {
      event_id: 'author_dispatch',
      record_id: 'provenance_lead',
      step_id: 'purchase_gift_card',
      kind: 'author_tool',
      passed: true,
      reason: 'tool invocation returned',
      side_effecting: true,
      occurred_at: at,
    },
  });

  const timeline = getAccountTimeline({ db, recordId: 'provenance_lead' });
  db.close();
  const shown = recordShowCommand({ list: listDir, rowId: 'provenance_lead', include: 'events' });
  const engineSend = timeline.events.find((event) => event.source === 'channel_events');
  const authorDispatch = timeline.events.find((event) => (
    event.source === 'pipeline_events' && event.detail.step_id === 'purchase_gift_card'
  ));
  const shownEngineSend = shown.sections.events.find((event) => event.timeline_id === 'engine_send');
  const shownAuthorDispatch = shown.sections.events.find((event) => event.timeline_id === 'author_dispatch');

  assert.equal(engineSend.tense, 'occurred');
  assert.equal(engineSend.provenance, 'performed_and_evidenced');
  assert.equal(authorDispatch.provenance, 'dispatched_unverified');
  assert.equal(shownEngineSend.provenance, 'performed_and_evidenced');
  assert.equal(shownAuthorDispatch.provenance, 'dispatched_unverified');
});
