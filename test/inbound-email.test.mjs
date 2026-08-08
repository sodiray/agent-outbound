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

const insertContact = (db, { recordId, contactId, email = 'alex@example.com' }) => {
  db.prepare(`
    INSERT INTO contacts (contact_id, id, row_id, email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(contactId, contactId, recordId, email, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
};

const insertLiveEmailHistory = (db, { recordId, messageId, stepId = 'email_1' }) => {
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(`
    INSERT INTO live_interaction_ledger (
      ledger_id, identity_key, record_id, contact_id, channel, step_id,
      provider_id, provider_message_id, delivery_mode, status,
      occurred_at, created_at, updated_at
    ) VALUES (?, ?, ?, '', 'email', ?, ?, ?, 'live', 'accepted', ?, ?, ?)
  `).run(
    `ledger-${recordId}-${stepId}`,
    `${recordId}|${stepId}|`,
    recordId,
    stepId,
    messageId,
    messageId,
    now,
    now,
    now,
  );
};

const withClock = async (value, run) => {
  const previous = process.env.AO_NOW;
  process.env.AO_NOW = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.AO_NOW;
    else process.env.AO_NOW = previous;
  }
};

const replyClassifier = {
  model: 'test/inbound-classifier',
  prompt: 'Classify this reply: {{reply_text}}',
  output: {
    classifications: ['needs_review'],
    opt_out_classifications: [],
  },
};

const classifyForReview = async () => ({
  object: { classification: 'needs_review', reason: 'Fixture classifier.' },
});

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

test('inbound correlation matches an earlier live email in thread history', async () => {
  const { db } = createDb();
  try {
    insertRecord(db, { id: 'older-send', messageId: '<outbound-2@example.com>' });
    insertLiveEmailHistory(db, {
      recordId: 'older-send',
      messageId: '<outbound-1@example.com>',
    });
    const parsed = await parseInboundEmail(fixture('inbound-reply-in-reply-to.eml'));
    const correlation = correlateInboundEmail({ db, ...parsed });
    assert.equal(correlation.status, 'matched');
    assert.equal(correlation.via, 'headers');
    assert.equal(correlation.record._row_id, 'older-send');
  } finally {
    db.close();
  }
});

test('unmatched headers fall through to a unique sender match', async () => {
  const { db } = createDb();
  try {
    insertRecord(db, { id: 'sender-fallback', messageId: '<different-outbound@example.com>' });
    const parsed = await parseInboundEmail(fixture('inbound-reply-header-unmatched.eml'));
    const correlation = correlateInboundEmail({ db, ...parsed });
    assert.equal(correlation.status, 'matched');
    assert.equal(correlation.via, 'sender');
    assert.equal(correlation.reason, 'headers_unmatched_sender_matched');
    assert.equal(correlation.record._row_id, 'sender-fallback');
  } finally {
    db.close();
  }
});

test('an unmatched header remains ambiguous when the sender identifies multiple records', async () => {
  const { db } = createDb();
  try {
    insertRecord(db, { id: 'sender-ambiguous-a', messageId: '<different-outbound-a@example.com>' });
    insertRecord(db, { id: 'sender-ambiguous-b', messageId: '<different-outbound-b@example.com>' });
    const parsed = await parseInboundEmail(fixture('inbound-reply-header-unmatched.eml'));
    const correlation = correlateInboundEmail({ db, ...parsed });
    assert.equal(correlation.status, 'ambiguous');
    assert.equal(correlation.reason, 'sender_ambiguous');
    assert.equal(correlation.record, null);
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
    assert.notEqual(record.account_sequence_state, 'paused_inbound');
    assert.equal(inbound.classification, 'auto_reply');
  } finally {
    db.close();
  }
});

test('matched reply writes the injected receipt time as a record projection and contact-keyed evidence', async () => {
  const { db } = createDb();
  try {
    insertRecord(db, { id: 'reply-evidence', messageId: '<outbound-1@example.com>' });
    insertContact(db, { recordId: 'reply-evidence', contactId: 'contact-alex' });
    await withClock('2026-08-07T22:15:00.000Z', () => processInboundEmail({
      db,
      mailboxId: 'mailbox-a',
      uid: 10,
      raw: fixture('inbound-reply-in-reply-to.eml'),
      classifier: replyClassifier,
      generate: classifyForReview,
    }));
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('reply-evidence');
    const event = db.prepare(`
      SELECT contact_id, provider_message_id, disposition, payload_json, occurred_at
      FROM channel_events
      WHERE row_id = ? AND action = 'reply_detected'
    `).get('reply-evidence');
    const inbound = db.prepare('SELECT * FROM inbound_messages WHERE mailbox_id = ? AND imap_uid = ?').get('mailbox-a', 10);
    assert.equal(record.email_last_reply_at, '2026-08-07T22:15:00.000Z');
    assert.equal(record.email_reply_classification, 'needs_review');
    assert.equal(record.reply_classification_latest, 'needs_review');
    assert.equal(event.contact_id, 'contact-alex');
    assert.equal(event.provider_message_id, 'reply-1@example.com');
    assert.equal(event.disposition, 'needs_review');
    assert.equal(event.occurred_at, '2026-08-07T22:15:00.000Z');
    assert.deepEqual(JSON.parse(event.payload_json), {
      snippet: 'Thanks, please tell me more.',
      classification: 'needs_review',
      proposed_only: true,
      explicit_stop: false,
      source: 'inbound_reply_handler',
      pause_first: true,
      classifier_reason: 'Fixture classifier.',
    });
    assert.equal(inbound.contact_id, 'contact-alex');
    assert.equal(inbound.received_at, '2026-08-07T22:15:00.000Z');
  } finally {
    db.close();
  }
});

test('matched bounce suppresses only the delivery-failed contact', async () => {
  const { db } = createDb();
  try {
    insertRecord(db, { id: 'bounce-contact', messageId: '<outbound-bounce@example.com>' });
    insertContact(db, { recordId: 'bounce-contact', contactId: 'contact-alex' });
    const result = await processInboundEmail({
      db,
      mailboxId: 'mailbox-a',
      uid: 11,
      raw: fixture('inbound-bounce.eml'),
      receivedAt: '2026-08-07T23:00:00.000Z',
    });
    const contact = db.prepare('SELECT dne_email FROM contacts WHERE contact_id = ?').get('contact-alex');
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('bounce-contact');
    const events = db.prepare(`
      SELECT contact_id, provider_message_id, occurred_at
      FROM channel_events
      WHERE row_id = ? AND action = 'bounce_detected'
    `).all('bounce-contact');
    assert.equal(result.classification, 'bounce');
    assert.equal(Number(contact.dne_email), 1);
    assert.equal(record.account_sequence_state, 'active');
    assert.deepEqual(events, [{
      contact_id: 'contact-alex',
      provider_message_id: 'dsn-1@example.net',
      occurred_at: '2026-08-07T23:00:00.000Z',
    }]);
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
    assert.equal(inbound.correlation_reason, 'sender_unmatched');
    assert.equal(inbound.sender_email, 'unknown@example.com');
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
      classifier: replyClassifier,
      generate: classifyForReview,
    });
    const second = await processInboundEmail({
      db,
      mailboxId: 'mailbox-a',
      uid: 9,
      raw: fixture('inbound-reply-in-reply-to.eml'),
      classifier: replyClassifier,
      generate: classifyForReview,
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
