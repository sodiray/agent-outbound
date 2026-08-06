import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import {
  correlateInboundEmail,
  parseInboundEmail,
  processInboundEmail,
} from '../dist/orchestrator/runtime/inbound-email.js';

const fixture = (name) => readFileSync(join(process.cwd(), 'test/fixtures', name));

const createDb = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'agent-outbound-inbound-'));
  const db = openListDb({ listDir, readonly: false });
  return { db, listDir };
};

const insertRecord = (db, { id, messageId, email = 'alex@example.com' }) => {
  upsertRecord({
    db,
    row: {
      _row_id: id,
      business_name: `Business ${id}`,
      contact_email: email,
      email_primary: email,
      email_last_message_id: messageId,
      lifecycle_stage: 'contacted',
      sequence_status: 'active',
      account_sequence_state: 'active',
    },
  });
};

test('inbound correlation matches In-Reply-To and References headers', async () => {
  const { db } = createDb();
  try {
    insertRecord(db, { id: 'inreply', messageId: '<outbound-1@example.com>' });
    insertRecord(db, { id: 'references', messageId: '<outbound-2@example.com>' });
    const inReplyTo = await parseInboundEmail(fixture('inbound-reply-in-reply-to.eml'));
    const references = await parseInboundEmail(fixture('inbound-reply-references.eml'));
    assert.equal(correlateInboundEmail({ db, ...inReplyTo }).record._row_id, 'inreply');
    assert.equal(correlateInboundEmail({ db, ...references }).record._row_id, 'references');
  } finally {
    db.close();
  }
});

test('RFC 3464 delivery-status report is classified as a bounce and correlates original Message-ID', async () => {
  const { db } = createDb();
  try {
    insertRecord(db, { id: 'bounce', messageId: '<outbound-bounce@example.com>' });
    const parsed = await parseInboundEmail(fixture('inbound-bounce.eml'));
    const correlation = correlateInboundEmail({ db, ...parsed });
    assert.equal(parsed.classification, 'bounce');
    assert.equal(parsed.bounceType, 'hard');
    assert.equal(correlation.status, 'matched');
    assert.equal(correlation.record._row_id, 'bounce');
  } finally {
    db.close();
  }
});

test('auto-reply is persisted distinctly and does not interrupt the sequence', async () => {
  const { db } = createDb();
  try {
    insertRecord(db, { id: 'auto', messageId: '<outbound-auto@example.com>' });
    const result = await processInboundEmail({
      db,
      mailboxId: 'mailbox-a',
      uid: 7,
      raw: fixture('inbound-auto-reply.eml'),
    });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('auto');
    const inbound = db.prepare('SELECT * FROM inbound_messages WHERE mailbox_id = ? AND imap_uid = ?').get('mailbox-a', 7);
    assert.equal(result.classification, 'auto_reply');
    assert.equal(record.sequence_status, 'active');
    assert.equal(inbound.classification, 'auto_reply');
  } finally {
    db.close();
  }
});

test('unmatched inbound sender fails closed and remains visible to operators', async () => {
  const { db } = createDb();
  try {
    const result = await processInboundEmail({
      db,
      mailboxId: 'mailbox-a',
      uid: 8,
      raw: fixture('inbound-unmatched.eml'),
    });
    const inbound = db.prepare('SELECT * FROM inbound_messages WHERE mailbox_id = ? AND imap_uid = ?').get('mailbox-a', 8);
    assert.equal(result.correlation.status, 'unmatched');
    assert.equal(inbound.correlation_status, 'unmatched');
    assert.equal(inbound.record_id, '');
  } finally {
    db.close();
  }
});

test('reprocessing an IMAP UID is idempotent and emits one interruption', async () => {
  const { db } = createDb();
  try {
    insertRecord(db, { id: 'idempotent', messageId: '<outbound-1@example.com>' });
    const first = await processInboundEmail({
      db,
      mailboxId: 'mailbox-a',
      uid: 9,
      raw: fixture('inbound-reply-in-reply-to.eml'),
    });
    const second = await processInboundEmail({
      db,
      mailboxId: 'mailbox-a',
      uid: 9,
      raw: fixture('inbound-reply-in-reply-to.eml'),
    });
    const events = db.prepare(`
      SELECT COUNT(*) AS count FROM channel_events
      WHERE row_id = ? AND action = 'reply_detected'
    `).get('idempotent');
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('idempotent');
    assert.equal(first.processed, true);
    assert.equal(second.duplicate, true);
    assert.equal(events.count, 1);
    assert.equal(record.account_sequence_state, 'paused_inbound');
  } finally {
    db.close();
  }
});
