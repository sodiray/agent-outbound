import { resolveListDir } from '../orchestrator/runtime/paths.js';
import { openListDb } from '../orchestrator/runtime/db.js';
import { processSequenceInterruption } from '../orchestrator/runtime/interruption-process.js';

const trim = (value: unknown) => String(value ?? '').trim();

export const inboundListCommand = ({
  list,
  status = '',
  classification = '',
  limit = 100,
}: {
  list: string;
  status?: string;
  classification?: string;
  limit?: number;
}) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    const rows = db.prepare(`
      SELECT * FROM inbound_messages
      WHERE (? = '' OR correlation_status = ?)
        AND (? = '' OR classification = ?)
      ORDER BY datetime(received_at) DESC, mailbox_id, imap_uid DESC
      LIMIT ?
    `).all(trim(status), trim(status), trim(classification), trim(classification), Math.max(1, Number(limit) || 100));
    return {
      items: rows.map((row: Record<string, unknown>) => ({
        ...row,
        operator_action: ['unmatched', 'ambiguous'].includes(trim(row.correlation_status))
          ? `inbound resolve ${trim(row.inbound_message_id)} --record RECORD_ID`
          : '',
      })),
    };
  } finally {
    db.close();
  }
};

export const inboundResolveCommand = ({
  list,
  inboundMessageId,
  recordId,
}: {
  list: string;
  inboundMessageId: string;
  recordId: string;
}) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const message = db.prepare('SELECT * FROM inbound_messages WHERE inbound_message_id = ?').get(trim(inboundMessageId));
    if (!message) throw new Error(`Inbound message "${inboundMessageId}" was not found.`);
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(trim(recordId));
    if (!record) throw new Error(`Record "${recordId}" was not found.`);
    const contact = db.prepare(`
      SELECT contact_id, email FROM contacts
      WHERE row_id = ? AND lower(trim(email)) = lower(trim(?))
      LIMIT 1
    `).get(trim(recordId), trim(message.sender_email));
    const classification = trim(message.classification);
    const applied = db.transaction(() => {
      if (classification === 'reply') {
        processSequenceInterruption({
          db,
          recordId: trim(recordId),
          kind: 'inbound_opportunity',
          reason: 'operator_matched_imap_inbound_reply',
        });
      }
      if (classification === 'bounce') {
        processSequenceInterruption({
          db,
          recordId: trim(recordId),
          kind: 'email_bounce',
          reason: 'operator_matched_imap_inbound_bounce',
          messageId: trim(message.rfc_message_id) || trim(message.inbound_message_id),
          email: trim(contact?.email || record.contact_email || record.email_primary),
          contactId: trim(contact?.contact_id),
          snippet: trim(message.snippet),
        });
      }
      db.prepare(`
        UPDATE inbound_messages
        SET correlation_status = 'matched', record_id = ?, contact_id = ?
        WHERE inbound_message_id = ?
      `).run(trim(recordId), trim(contact?.contact_id), trim(inboundMessageId));
      return { classification };
    })();
    return {
      inbound_message_id: trim(inboundMessageId),
      record_id: trim(recordId),
      contact_id: trim(contact?.contact_id),
      classification: applied.classification,
      interrupted: ['reply', 'bounce'].includes(applied.classification),
    };
  } finally {
    db.close();
  }
};

/**
 * Force an IMAP inbound poll now.
 *
 * Ingestion otherwise only runs inside the `serve` polling scheduler, so
 * "has anyone replied?" — the question an operator asks most after a send —
 * was unanswerable without a daemon running. Same reads as the scheduled
 * poll: read-only mailbox access, no flags set, idempotent on re-run.
 */
export const inboundPollCommand = async ({ list }: { list: string }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  const { runImapInboundPoll } = await import('../orchestrator/runtime/polling.js');
  const { readConfig } = await import('../orchestrator/lib/config.js');
  const config = readConfig(listDir)?.config;
  try {
    const result = await runImapInboundPoll({ listDir, db, config });
    return { status: 'polled', result };
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
};
