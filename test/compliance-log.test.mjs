/**
 * compliance_log writer: AO's audit trail of its own compliance-relevant actions.
 *
 * Proves:
 * - addSuppression writes a row naming identifier + source
 * - outbound refused for suppression writes a row
 * - opt-out classification writes a row
 * - hard bounce writes a row
 * - entries appear on records_timeline beside channel events
 * - log write failure does not break the underlying action, and is surfaced
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  addSuppression,
  ensureRecordColumns,
  insertChannelEvent,
  insertComplianceLog,
  logOutboundSuppressionRefusal,
  openListDb,
  upsertContact,
  upsertRecord,
} from '../dist/orchestrator/runtime/db.js';
import { processBounceEvent } from '../dist/orchestrator/runtime/bounce-process.js';
import { processInboundReplyText } from '../dist/orchestrator/runtime/inbound-reply-process.js';
import { evaluateTransmitterSuppression } from '../dist/orchestrator/policy/transmitter-suppression.js';

const projectYaml = `
list:
  name: Compliance Log
business:
  name: Test
  description: Test
  icp: Test
  offer: Test
pipeline: []
sequences:
  default:
    steps: []
policy:
  enforce_readiness: false
`;

const createList = (recordOverrides = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-compliance-log-'));
  mkdirSync(join(listDir, '.outbound'), { recursive: true });
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml);
  writeFileSync(join(listDir, 'operator.md'), 'compliance log');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  const now = '2026-08-10T12:00:00.000Z';
  const base = {
    _row_id: 'cl_rec_1',
    business_name: 'Compliance Co',
    contact_email: 'owner@acme.example',
    email_primary: 'owner@acme.example',
    contact_name: 'Pat Owner',
    lifecycle_stage: 'contacted',
    account_sequence_state: 'active',
    sequence_status: 'active',
    sequence_name: 'default',
    active_contact_id: 'c_owner',
    contact_id: 'c_owner',
    _created_at: now,
    _updated_at: now,
    created_at: now,
    updated_at: now,
    ...recordOverrides,
  };
  ensureRecordColumns({ db, columns: Object.keys(base) });
  const cols = Object.keys(base);
  db.prepare(
    `INSERT INTO records (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
  ).run(...cols.map((k) => base[k]));
  return { listDir, db, now, recordId: String(base._row_id) };
};

const listCompliance = (db, recordId) => db.prepare(`
  SELECT id, record_id, action, reason, payload_json, occurred_at
  FROM compliance_log
  WHERE record_id = ? OR record_id = ''
  ORDER BY occurred_at ASC, id ASC
`).all(recordId);

const parsePayload = (row) => {
  try {
    return JSON.parse(String(row.payload_json || '{}'));
  } catch {
    return {};
  }
};

// ---------------------------------------------------------------------------
// Suppression registry write
// ---------------------------------------------------------------------------

test('addSuppression writes a compliance_log row naming the identifier and source', () => {
  const { db, recordId } = createList();
  try {
    addSuppression({
      db,
      entry: {
        id: 'sup_email_1',
        value: 'owner@acme.example',
        value_type: 'email',
        scope: 'global',
        reason: 'opt_out',
        source: 'inbound_reply_classifier',
        record_id: recordId,
        created_at: '2026-08-10T12:01:00.000Z',
      },
    });

    const rows = db.prepare(`
      SELECT * FROM compliance_log WHERE action = 'suppress' ORDER BY occurred_at
    `).all();
    assert.equal(rows.length, 1, 'expected one suppress compliance row');
    assert.equal(rows[0].record_id, recordId);
    assert.equal(rows[0].action, 'suppress');
    assert.equal(rows[0].reason, 'opt_out');
    const payload = parsePayload(rows[0]);
    assert.equal(payload.identifier, 'owner@acme.example');
    assert.equal(payload.identifier_type, 'email');
    assert.equal(payload.source, 'inbound_reply_classifier');
  } finally {
    db.close();
  }
});

test('addSuppression with domain identifier names domain in compliance_log payload', () => {
  const { db } = createList({ _row_id: 'cl_domain' });
  try {
    addSuppression({
      db,
      entry: {
        id: 'sup_domain_1',
        value: 'acme.example',
        value_type: 'domain',
        scope: 'global',
        reason: 'hard_bounce',
        source: 'hard_bounce_policy:dsn',
        record_id: 'cl_domain',
      },
    });
    const row = db.prepare(`SELECT * FROM compliance_log WHERE action = 'suppress' LIMIT 1`).get();
    assert.ok(row);
    const payload = parsePayload(row);
    assert.equal(payload.identifier, 'acme.example');
    assert.equal(payload.identifier_type, 'domain');
    assert.equal(payload.source, 'hard_bounce_policy:dsn');
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Outbound refused because suppressed
// ---------------------------------------------------------------------------

test('outbound action refused because record/address was suppressed writes a compliance_log row', () => {
  const { db, recordId } = createList({
    _row_id: 'cl_refuse',
    suppressed: 1,
    suppressed_reason: 'opt_out',
  });
  try {
    const gate = evaluateTransmitterSuppression({
      db,
      record: db.prepare('SELECT * FROM records WHERE _row_id = ?').get('cl_refuse'),
      channel: 'email',
    });
    assert.equal(gate.blocked, true);
    assert.equal(gate.reason, 'record_suppressed');

    const result = logOutboundSuppressionRefusal({
      db,
      recordId: 'cl_refuse',
      reason: gate.reason,
      channel: 'email',
      payload: { step_id: 'email_1' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);

    const rows = db.prepare(`
      SELECT * FROM compliance_log WHERE action = 'outbound_refused' AND record_id = ?
    `).all('cl_refuse');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, 'record_suppressed');
    const payload = parsePayload(rows[0]);
    assert.equal(payload.channel, 'email');
    assert.equal(payload.step_id, 'email_1');
  } finally {
    db.close();
  }
});

test('logOutboundSuppressionRefusal ignores non-suppression gate reasons', () => {
  const { db } = createList({ _row_id: 'cl_verif' });
  try {
    const result = logOutboundSuppressionRefusal({
      db,
      recordId: 'cl_verif',
      reason: 'email_verification_gate_failed',
      channel: 'email',
    });
    assert.equal(result.skipped, true);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM compliance_log`).get().n;
    assert.equal(count, 0);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Opt-out from inbound reply
// ---------------------------------------------------------------------------

test('opt-out classified from an inbound reply writes a compliance_log row', async () => {
  const { db } = createList({
    _row_id: 'cl_optout',
    contact_email: 'stop@acme.example',
    email_primary: 'stop@acme.example',
  });
  try {
    const result = await processInboundReplyText({
      db,
      recordId: 'cl_optout',
      replyText: 'Please remove me from your list',
      messageId: 'msg_optout_1',
      replyAt: '2026-08-10T13:00:00.000Z',
      classifier: {
        model: 'test/reply-classifier',
        prompt: 'Classify the inbound reply. Reply: {{reply_text}}',
        output: {
          classifications: ['unsubscribe', 'question'],
          opt_out_classifications: ['unsubscribe'],
        },
      },
      generate: async () => ({
        object: {
          classification: 'unsubscribe',
          reason: 'explicit unsubscribe request',
        },
      }),
    });

    assert.equal(result.classification, 'unsubscribe');
    assert.equal(Number(result.record.suppressed), 1);

    const optOutRows = db.prepare(`
      SELECT * FROM compliance_log WHERE action = 'opt_out' AND record_id = ?
    `).all('cl_optout');
    assert.equal(optOutRows.length, 1, 'expected opt_out compliance row');
    assert.equal(optOutRows[0].reason, 'opt_out');
    const optPayload = parsePayload(optOutRows[0]);
    assert.equal(optPayload.classification, 'unsubscribe');
    assert.equal(optPayload.source, 'inbound_reply_classifier');

    // Suppression registry write is also audited.
    const suppressRows = db.prepare(`
      SELECT * FROM compliance_log WHERE action = 'suppress' AND record_id = ?
    `).all('cl_optout');
    assert.equal(suppressRows.length, 1);
    const supPayload = parsePayload(suppressRows[0]);
    assert.equal(supPayload.identifier, 'stop@acme.example');
    assert.equal(supPayload.source, 'inbound_reply_classifier');
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Hard bounce
// ---------------------------------------------------------------------------

test('hard bounce writes a compliance_log row', () => {
  const { db } = createList({
    _row_id: 'cl_bounce',
    contact_email: 'gone@acme.example',
    email_primary: 'gone@acme.example',
  });
  try {
    upsertContact({
      db,
      contact: {
        row_id: 'cl_bounce',
        contact_id: 'c_owner',
        name: 'Pat',
        email: 'gone@acme.example',
        is_primary: 1,
      },
    });

    const applied = processBounceEvent({
      db,
      recordId: 'cl_bounce',
      messageId: 'bounce_msg_1',
      bounceType: 'hard',
      source: 'dsn',
      snippet: '550 5.1.1 User unknown',
      email: 'gone@acme.example',
    });

    assert.equal(applied.bounce_type, 'hard');
    assert.equal(applied.already_applied, false);

    const rows = db.prepare(`
      SELECT * FROM compliance_log WHERE action = 'hard_bounce' AND record_id = ?
    `).all('cl_bounce');
    assert.equal(rows.length, 1, 'expected hard_bounce compliance row');
    const payload = parsePayload(rows[0]);
    assert.equal(payload.bounce_type, 'hard');
    assert.equal(payload.email, 'gone@acme.example');
    assert.ok(payload.source);
  } finally {
    db.close();
  }
});

test('soft bounce without harden does not write a hard_bounce compliance_log row', () => {
  const { db } = createList({
    _row_id: 'cl_soft',
    contact_email: 'full@acme.example',
  });
  try {
    processBounceEvent({
      db,
      recordId: 'cl_soft',
      messageId: 'soft_msg_1',
      bounceType: 'soft',
      source: 'dsn',
      snippet: 'mailbox full try again later',
    });
    const hard = db.prepare(`
      SELECT COUNT(*) AS n FROM compliance_log WHERE action = 'hard_bounce' AND record_id = ?
    `).get('cl_soft').n;
    assert.equal(hard, 0);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// records_timeline view
// ---------------------------------------------------------------------------

test('compliance_log entries render through records_timeline alongside channel events', () => {
  const { db, recordId, now } = createList({ _row_id: 'cl_timeline' });
  try {
    insertChannelEvent({
      db,
      event: {
        event_id: 'ce_sent_1',
        row_id: 'cl_timeline',
        channel: 'email',
        event_type: 'executed',
        action: 'executed',
        disposition: 'ok',
        occurred_at: '2026-08-10T11:00:00.000Z',
      },
    });

    addSuppression({
      db,
      entry: {
        id: 'sup_timeline',
        value: 'owner@acme.example',
        value_type: 'email',
        scope: 'global',
        reason: 'opt_out',
        source: 'operator',
        record_id: 'cl_timeline',
        created_at: '2026-08-10T12:30:00.000Z',
      },
    });

    insertComplianceLog({
      db,
      entry: {
        id: 'cl_opt_timeline',
        record_id: 'cl_timeline',
        action: 'opt_out',
        reason: 'opt_out',
        payload: { source: 'test' },
        occurred_at: '2026-08-10T12:30:01.000Z',
      },
    });

    const timeline = db.prepare(`
      SELECT timeline_id, row_id, event_family, event_type, channel, notes, payload_json, occurred_at
      FROM records_timeline
      WHERE row_id = ?
      ORDER BY occurred_at ASC, timeline_id ASC
    `).all('cl_timeline');

    const families = timeline.map((r) => r.event_family);
    assert.ok(families.includes('channel'), `expected channel events: ${JSON.stringify(timeline)}`);
    assert.ok(families.includes('compliance'), `expected compliance events: ${JSON.stringify(timeline)}`);

    const compliance = timeline.filter((r) => r.event_family === 'compliance');
    assert.ok(compliance.length >= 2, `expected suppress + opt_out on timeline, got ${compliance.length}`);
    assert.ok(compliance.some((r) => r.event_type === 'suppress'));
    assert.ok(compliance.some((r) => r.event_type === 'opt_out'));

    const channel = timeline.find((r) => r.event_family === 'channel' && r.timeline_id === 'ce_sent_1');
    assert.ok(channel);
    assert.equal(channel.channel, 'email');

    // Compliance rows map action → event_type and reason → notes.
    const suppressOnView = compliance.find((r) => r.event_type === 'suppress');
    assert.equal(suppressOnView.notes, 'opt_out');
    assert.equal(suppressOnView.row_id, 'cl_timeline');
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Failure isolation + surfacing
// ---------------------------------------------------------------------------

test('failure to write compliance_log does not break addSuppression and is surfaced on last_error', () => {
  const { db, recordId } = createList({ _row_id: 'cl_fail_sup' });
  try {
    // Force INSERT failure without removing the table (table-missing is a skip).
    db.exec(`
      CREATE TRIGGER compliance_log_block_insert
      BEFORE INSERT ON compliance_log
      BEGIN
        SELECT RAISE(ABORT, 'forced compliance_log failure');
      END;
    `);

    addSuppression({
      db,
      entry: {
        id: 'sup_despite_log_fail',
        value: 'still-suppressed@acme.example',
        value_type: 'email',
        scope: 'global',
        reason: 'opt_out',
        source: 'test_failure_path',
        record_id: 'cl_fail_sup',
      },
    });

    // Underlying suppression write still landed.
    const sup = db.prepare(`
      SELECT identifier_value FROM suppression WHERE identifier_value = ?
    `).get('still-suppressed@acme.example');
    assert.ok(sup, 'suppression row must exist despite log failure');

    // No compliance row (insert aborted).
    const logCount = db.prepare(`SELECT COUNT(*) AS n FROM compliance_log`).get().n;
    assert.equal(logCount, 0);

    // Surfaced, not swallowed.
    const record = db.prepare(`SELECT last_error FROM records WHERE _row_id = ?`).get('cl_fail_sup');
    assert.ok(
      String(record.last_error || '').includes('compliance_log_write_failed:'),
      `expected surfaced last_error, got: ${record.last_error}`,
    );
    assert.ok(
      String(record.last_error || '').includes('forced compliance_log failure'),
      `expected failure detail in last_error, got: ${record.last_error}`,
    );
  } finally {
    db.close();
  }
});

test('failure to write compliance_log does not break processBounceEvent and is surfaced', () => {
  const { db } = createList({
    _row_id: 'cl_fail_bounce',
    contact_email: 'bounce-fail@acme.example',
  });
  try {
    db.exec(`
      CREATE TRIGGER compliance_log_block_bounce
      BEFORE INSERT ON compliance_log
      BEGIN
        SELECT RAISE(ABORT, 'forced bounce log failure');
      END;
    `);

    const applied = processBounceEvent({
      db,
      recordId: 'cl_fail_bounce',
      messageId: 'bounce_fail_1',
      bounceType: 'hard',
      source: 'dsn',
      snippet: '550 user unknown',
      email: 'bounce-fail@acme.example',
    });

    assert.equal(applied.bounce_type, 'hard');
    assert.equal(applied.already_applied, false);
    // Structural bounce still applied.
    const record = db.prepare(`SELECT * FROM records WHERE _row_id = ?`).get('cl_fail_bounce');
    assert.equal(Number(record.dne_email), 1);
    assert.ok(
      String(record.last_error || '').includes('compliance_log_write_failed:'),
      `expected surfaced last_error, got: ${record.last_error}`,
    );
  } finally {
    db.close();
  }
});

test('insertComplianceLog returns ok:false with error and never throws', () => {
  const { db } = createList({ _row_id: 'cl_direct' });
  try {
    db.exec(`
      CREATE TRIGGER compliance_log_block_direct
      BEFORE INSERT ON compliance_log
      BEGIN
        SELECT RAISE(ABORT, 'direct insert forced fail');
      END;
    `);
    const result = insertComplianceLog({
      db,
      entry: {
        record_id: 'cl_direct',
        action: 'opt_out',
        reason: 'opt_out',
        payload: { source: 'test' },
      },
    });
    assert.equal(result.ok, false);
    assert.ok(String(result.error || '').includes('direct insert forced fail'));
    assert.equal(result.skipped, false);
  } finally {
    db.close();
  }
});

test('insertComplianceLog is the generic extension point for pipeline-authored entries', () => {
  const { db } = createList({ _row_id: 'cl_pipeline' });
  try {
    const result = insertComplianceLog({
      db,
      entry: {
        id: 'cl_author_policy_1',
        record_id: 'cl_pipeline',
        action: 'policy_event',
        reason: 'pipeline_declared_quiet_hours_skip',
        payload: {
          source: 'pipeline_author',
          step_id: 'check_quiet_hours',
        },
        occurred_at: '2026-08-10T15:00:00.000Z',
      },
    });
    assert.equal(result.ok, true);
    const row = db.prepare(`SELECT * FROM compliance_log WHERE id = ?`).get('cl_author_policy_1');
    assert.equal(row.action, 'policy_event');
    assert.equal(row.reason, 'pipeline_declared_quiet_hours_skip');
    const onTimeline = db.prepare(`
      SELECT event_family, event_type, notes FROM records_timeline
      WHERE timeline_id = ?
    `).get('cl_author_policy_1');
    assert.equal(onTimeline.event_family, 'compliance');
    assert.equal(onTimeline.event_type, 'policy_event');
    assert.equal(onTimeline.notes, 'pipeline_declared_quiet_hours_skip');
  } finally {
    db.close();
  }
});
