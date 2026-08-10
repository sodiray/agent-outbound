import { simpleParser } from 'mailparser';
import { detectBounceFromText, type BounceType } from '../policy/bounce.js';
import { processSequenceInterruption } from './interruption-process.js';
import { completeIdempotency, claimIdempotency, failIdempotency } from './idempotency.js';
import { nowIso } from '../lib/record.js';
import { processInboundReplyText } from './inbound-reply-process.js';
import { replyCheckSequenceForRecord, resolveReplyCheck } from '../lib/reply-check.js';
import { generateObjectWithTools } from './llm.js';

export type InboundEmailClassification = 'reply' | 'bounce' | 'auto_reply';
export type InboundCorrelationStatus = 'matched' | 'unmatched' | 'ambiguous';

type Database = {
  prepare: (sql: string) => {
    get: (...params: unknown[]) => Record<string, unknown> | undefined;
    all: (...params: unknown[]) => Record<string, unknown>[];
    run: (...params: unknown[]) => { changes?: number };
  };
  transaction: <T>(fn: () => T) => () => T;
};

export type ParsedInboundEmail = {
  messageId: string;
  correlationMessageIds: string[];
  senderEmail: string;
  recipientEmail: string;
  subject: string;
  snippet: string;
  classification: InboundEmailClassification;
  bounceType: BounceType | undefined;
};

export type InboundCorrelation = {
  status: InboundCorrelationStatus;
  record: Record<string, unknown> | null;
  contactId: string;
  via: 'headers' | 'sender' | 'none';
  reason: string;
};

const trim = (value: unknown) => String(value ?? '').trim();
const lower = (value: unknown) => trim(value).toLowerCase();

export const normalizeMessageId = (value: unknown): string => {
  const text = lower(value);
  const bracketed = text.match(/<([^>]+)>/);
  return bracketed ? bracketed[1].trim() : text.replace(/^<|>$/g, '').trim();
};

export const messageIdsFromHeader = (value: unknown): string[] => {
  const text = trim(value);
  const bracketed = [...text.matchAll(/<([^>]+)>/g)].map((match) => normalizeMessageId(match[1]));
  const values = bracketed.length > 0 ? bracketed : text.split(/[\s,]+/).map(normalizeMessageId);
  return [...new Set(values.filter(Boolean))];
};

const messageIdsFromRaw = (raw: Buffer): string[] => {
  const text = raw.toString('utf8');
  const values = [...text.matchAll(/^message-id:\s*([^\r\n]+(?:\r?\n[ \t]+[^\r\n]+)*)/gim)]
    .flatMap((match) => messageIdsFromHeader(match[1].replace(/\r?\n[ \t]+/g, ' ')));
  return [...new Set(values)];
};

const headerText = (headers: Map<string, unknown>, key: string) => {
  const value = headers.get(key);
  return typeof value === 'string' ? value : trim(value);
};

const senderFromParsed = (parsed: { from?: { value?: Array<{ address?: string }> } }) =>
  lower(parsed.from?.value?.[0]?.address);

const recipientFromDsn = (raw: Buffer) => {
  const match = raw.toString('utf8').match(/^final-recipient:\s*(?:[^;]+;\s*)?([^\s\r\n]+)/im);
  return lower(match?.[1]);
};

export const parseInboundEmail = async (raw: Buffer): Promise<ParsedInboundEmail> => {
  const parsed = await simpleParser(raw);
  const headers = parsed.headers as Map<string, unknown>;
  const senderEmail = senderFromParsed(parsed);
  const contentType = lower(headerText(headers, 'content-type'));
  const autoSubmitted = lower(headerText(headers, 'auto-submitted'));
  const hasAutoReplyHeader = headers.has('x-autoreply') || headers.has('x-auto-reply');
  const isDsn = contentType.includes('multipart/report')
    && /report-type\s*=\s*"?delivery-status/.test(contentType);
  const isMailerDaemon = /(^|@)(mailer-daemon|postmaster)(\.|@|$)/.test(senderEmail);
  const snippet = trim(parsed.text || parsed.html || '').slice(0, 2000);
  const detectedBounce = detectBounceFromText(`${headerText(headers, 'subject')}\n${snippet}`);
  const classification: InboundEmailClassification = isDsn || isMailerDaemon || Boolean(detectedBounce)
    ? 'bounce'
    : (autoSubmitted && autoSubmitted !== 'no') || hasAutoReplyHeader
      ? 'auto_reply'
      : 'reply';
  const headerIds = [
    ...messageIdsFromHeader(headerText(headers, 'in-reply-to')),
    ...messageIdsFromHeader(headerText(headers, 'references')),
  ];
  const correlationMessageIds = classification === 'bounce'
    ? [...new Set([...headerIds, ...messageIdsFromRaw(raw)])]
    : headerIds;
  return {
    messageId: normalizeMessageId(headerText(headers, 'message-id')),
    correlationMessageIds,
    senderEmail,
    recipientEmail: recipientFromDsn(raw),
    subject: trim(parsed.subject),
    snippet,
    classification,
    bounceType: classification === 'bounce' ? detectedBounce || 'hard' : undefined,
  };
};

const distinctRecords = (rows: Record<string, unknown>[]) => [...rows.reduce((byId, row) => {
  const rowId = trim(row._row_id || row.id);
  const current = byId.get(rowId);
  if (rowId && (!current || (!trim(current.inbound_contact_id) && trim(row.inbound_contact_id)))) {
    byId.set(rowId, row);
  }
  return byId;
}, new Map<string, Record<string, unknown>>()).values()];

const contactForRecord = (db: Database, recordId: string, senderEmail: string) => {
  if (!senderEmail) return '';
  const contact = db.prepare(`
    SELECT contact_id FROM contacts
    WHERE row_id = ? AND lower(trim(email)) = ?
    LIMIT 1
  `).get(recordId, senderEmail);
  return trim(contact?.contact_id);
};

const emailForContact = (db: Database, recordId: string, contactId: string, fallback: Record<string, unknown> | null) => {
  const contact = contactId ? db.prepare('SELECT email FROM contacts WHERE row_id = ? AND contact_id = ?').get(recordId, contactId) : undefined;
  return trim(contact?.email || fallback?.contact_email || fallback?.email_primary);
};

export const correlateInboundEmail = ({
  db,
  correlationMessageIds,
  senderEmail,
  recipientEmail,
}: {
  db: Database;
  correlationMessageIds: string[];
  senderEmail: string;
  recipientEmail?: string;
}): InboundCorrelation => {
  const messageIds = [...new Set(correlationMessageIds.map(normalizeMessageId).filter(Boolean))];
  if (messageIds.length > 0) {
    const placeholders = messageIds.map(() => '?').join(', ');
    const rows = distinctRecords(db.prepare(`
      SELECT r.*
      FROM live_interaction_ledger l
      JOIN records r ON r._row_id = l.record_id
      WHERE l.channel = 'email'
        AND l.delivery_mode = 'live'
        AND l.status = 'accepted'
        AND trim(lower(l.provider_message_id), '<> ') IN (${placeholders})
      UNION ALL
      SELECT * FROM records
      WHERE trim(lower(email_last_message_id), '<> ') IN (${placeholders})
    `).all(...messageIds, ...messageIds));
    if (rows.length === 1) {
      const record = rows[0];
      return {
        status: 'matched',
        record,
        contactId: contactForRecord(
          db,
          trim(record._row_id || record.id),
          lower(recipientEmail || senderEmail),
        ),
        via: 'headers',
        reason: '',
      };
    }
    if (rows.length > 1) {
      return {
        status: 'ambiguous',
        record: null,
        contactId: '',
        via: 'none',
        reason: 'headers_ambiguous',
      };
    }
  }
  if (!lower(senderEmail)) {
    return {
      status: 'unmatched',
      record: null,
      contactId: '',
      via: 'none',
      reason: messageIds.length > 0 ? 'headers_unmatched_sender_missing' : 'sender_missing',
    };
  }
  const rows = distinctRecords(db.prepare(`
    SELECT r.*, c.contact_id AS inbound_contact_id
    FROM contacts c
    JOIN records r ON r._row_id = c.row_id
    WHERE lower(trim(c.email)) = ?
    UNION ALL
    SELECT r.*, '' AS inbound_contact_id
    FROM records r
    WHERE lower(trim(r.contact_email)) = ? OR lower(trim(r.email_primary)) = ?
  `).all(lower(senderEmail), lower(senderEmail), lower(senderEmail)));
  if (rows.length !== 1) {
    return {
      status: rows.length > 1 ? 'ambiguous' : 'unmatched',
      record: null,
      contactId: '',
      via: 'none',
      reason: rows.length > 1
        ? 'sender_ambiguous'
        : messageIds.length > 0 ? 'headers_unmatched_sender_unmatched' : 'sender_unmatched',
    };
  }
  const record = rows[0];
  return {
    status: 'matched',
    record,
    contactId: trim(record.inbound_contact_id) || contactForRecord(
      db,
      trim(record._row_id || record.id),
      lower(recipientEmail || senderEmail),
    ),
    via: 'sender',
    reason: messageIds.length > 0 ? 'headers_unmatched_sender_matched' : '',
  };
};

const inboundMessageId = (mailboxId: string, uid: number) => `imap:${mailboxId}:${uid}`;

const insertInboundMessage = ({
  db,
  mailboxId,
  uid,
  parsed,
  correlation,
  receivedAt,
}: {
  db: Database;
  mailboxId: string;
  uid: number;
  parsed: ParsedInboundEmail;
  correlation: InboundCorrelation;
  receivedAt: string;
}) => {
  const now = nowIso();
  db.prepare(`
    INSERT OR IGNORE INTO inbound_messages (
      inbound_message_id, mailbox_id, imap_uid, rfc_message_id, classification,
      correlation_status, correlation_reason, record_id, contact_id, sender_email, subject, snippet,
      references_json, received_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    inboundMessageId(mailboxId, uid),
    mailboxId,
    uid,
    parsed.messageId,
    parsed.classification,
    correlation.status,
    correlation.reason,
    trim(correlation.record?._row_id || correlation.record?.id),
    correlation.contactId,
    parsed.senderEmail,
    parsed.subject,
    parsed.snippet,
    JSON.stringify(parsed.correlationMessageIds),
    receivedAt,
    now,
  );
};

export const processInboundEmail = async ({
  db,
  mailboxId,
  uid,
  raw,
  receivedAt = nowIso(),
  config,
  aiConfig,
  classifier,
  generate,
}: {
  db: Database;
  mailboxId: string;
  uid: number;
  raw: Buffer;
  receivedAt?: string;
  config?: Record<string, unknown>;
  aiConfig?: Record<string, unknown>;
  classifier?: Record<string, unknown>;
  generate?: typeof generateObjectWithTools;
}) => {
  const parsed = await parseInboundEmail(raw);
  const idemKey = `${mailboxId}:${uid}`;
  const scope = 'imap_inbound';
  const claimed = claimIdempotency({
    db,
    idemKey,
    scope,
    payload: { mailbox_id: mailboxId, imap_uid: uid, source: 'imap_inbound' },
  });
  if (!claimed.claimed) return { processed: false as const, duplicate: true, classification: parsed.classification };
  try {
    const result = db.transaction(() => {
      const correlation = correlateInboundEmail({
        db,
        correlationMessageIds: parsed.correlationMessageIds,
        senderEmail: parsed.senderEmail,
        recipientEmail: parsed.recipientEmail,
      });
      insertInboundMessage({ db, mailboxId, uid, parsed, correlation, receivedAt });
      const recordId = trim(correlation.record?._row_id || correlation.record?.id);
      if (correlation.status === 'matched' && recordId && parsed.classification === 'bounce') {
        // Prefer RFC 3464 Final-Recipient (the address that actually bounced)
        // over the active contact projection / email_primary.
        const bouncedAddress = lower(parsed.recipientEmail)
          || emailForContact(db, recordId, correlation.contactId, correlation.record);
        processSequenceInterruption({
          db,
          recordId,
          kind: 'email_bounce',
          reason: 'imap_inbound_bounce',
          asOf: receivedAt,
          bounceType: parsed.bounceType,
          messageId: parsed.messageId || inboundMessageId(mailboxId, uid),
          email: bouncedAddress,
          contactId: correlation.contactId,
          snippet: parsed.snippet,
        });
      }
      return { correlation, recordId };
    })();
    const resolvedClassifier = classifier || (result.recordId
      ? resolveReplyCheck({
        config,
        sequenceName: replyCheckSequenceForRecord({ config, record: result.correlation.record || {} }),
      }).classifier as Record<string, unknown>
      : undefined);
    const replyResult = parsed.classification === 'reply' && result.correlation.status === 'matched' && result.recordId
      ? await processInboundReplyText({
        db,
        recordId: result.recordId,
        replyText: parsed.snippet,
        messageId: parsed.messageId,
        replyAt: receivedAt,
        contactId: result.correlation.contactId,
        classifier: resolvedClassifier,
        aiConfig: aiConfig || {},
        generate,
      })
      : null;
    completeIdempotency({
      db,
      idemKey,
      scope,
      claimId: claimed.claim_id,
      providerId: inboundMessageId(mailboxId, uid),
      payload: { classification: parsed.classification, correlation_status: result.correlation.status },
    });
    return {
      processed: true as const,
      duplicate: false,
      classification: parsed.classification,
      correlation: result.correlation,
      reply: replyResult,
    };
  } catch (error) {
    failIdempotency({
      db,
      idemKey,
      scope,
      claimId: claimed.claim_id,
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
};
