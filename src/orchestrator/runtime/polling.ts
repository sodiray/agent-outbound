import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  addSuppression,
  insertChannelEvent,
  upsertRecord,
} from './db.js';
import { executeComposioTool } from './tools.js';
import { classifyReplyAction } from '../actions/classify-reply/index.js';
import { applyInboundReplyClassification } from '../policy/inbound-reply.js';
import { detectBounceFromText } from '../policy/bounce.js';
import { recordCostEvent } from '../lib/costs.js';
import { getRecordRowId } from '../lib/record.js';
import { emitActivity } from './activity.js';
import { isBudgetExceededError } from './contract.js';
import { processBounceEvent } from './bounce-process.js';
import { fetchInboxMessages } from './imap-client.js';
import { processInboundEmail } from './inbound-email.js';
import { loadMailboxesCatalog, resolveMailboxCredentials } from '../lib/mailboxes.js';

type PollContext = {
  mcp: Client;
  listDir: string;
  db: any;
  globalSuppressionDb: any;
  config: any;
};

export const runImapInboundPoll = async ({
  listDir,
  db,
  config,
}: Omit<PollContext, 'mcp' | 'globalSuppressionDb'>) => {
  const { assertListAccessForMutation } = await import('../policy/canary-isolation.js');
  assertListAccessForMutation(listDir);
  const catalog = loadMailboxesCatalog({ listDir, config });
  const enabledMailboxes = catalog?.mailboxes.filter((mailbox) => mailbox.enabled) || [];
  const summary = {
    scanned: 0,
    processed: 0,
    replies: 0,
    bounces: 0,
    auto_replies: 0,
    unmatched: 0,
    ambiguous: 0,
    errors: [] as string[],
  };
  for (const mailbox of enabledMailboxes) {
    try {
      const credentials = resolveMailboxCredentials(mailbox, catalog!.yamlDir).credentials;
      const host = String(credentials.IMAP_HOST || credentials.SMTP_HOST || '').trim();
      const user = String(credentials.IMAP_USER || credentials.SMTP_USER || '').trim();
      const password = String(credentials.IMAP_PASS || credentials.SMTP_PASS || '').trim();
      const port = Number(credentials.IMAP_PORT || 993);
      const missing = [
        !host ? 'IMAP_HOST/SMTP_HOST' : '',
        !user ? 'IMAP_USER/SMTP_USER' : '',
        !password ? 'IMAP_PASS/SMTP_PASS' : '',
      ].filter(Boolean);
      if (missing.length > 0 || !Number.isInteger(port) || port <= 0) {
        summary.errors.push(`Mailbox "${mailbox.id}" missing ${missing.join(', ') || 'a valid IMAP_PORT'}.`);
        continue;
      }
      const messages = await fetchInboxMessages({ host, port, user, password });
      summary.scanned += messages.length;
      for (const message of messages) {
        const processed = await processInboundEmail({
          db,
          mailboxId: mailbox.id,
          uid: message.uid,
          raw: message.source,
          receivedAt: (message.internalDate || new Date()).toISOString(),
        });
        if (!processed.processed) continue;
        summary.processed += 1;
        if (processed.classification === 'reply') summary.replies += 1;
        if (processed.classification === 'bounce') summary.bounces += 1;
        if (processed.classification === 'auto_reply') summary.auto_replies += 1;
        if (processed.correlation.status === 'unmatched') summary.unmatched += 1;
        if (processed.correlation.status === 'ambiguous') summary.ambiguous += 1;
      }
    } catch (error) {
      summary.errors.push(`Mailbox "${mailbox.id}": ${String((error as Error)?.message || error)}`);
    }
  }
  return summary;
};

const hasExplicitStopIntent = (text: string) => {
  const normalized = String(text || '').toLowerCase();
  if (!normalized.trim()) return false;
  return normalized.includes(' stop ')
    || normalized.includes('unsubscribe')
    || normalized.includes('do not contact')
    || normalized.includes('remove me');
};

const asArray = (value: any): any[] => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.messages)) return value.messages;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.results)) return value.results;
  return [];
};

const extractThreadId = (message: any): string =>
  String(message?.thread_id || message?.threadId || message?.thread?.id || '').trim();

const extractMessageId = (message: any): string =>
  String(message?.id || message?.message_id || message?.messageId || '').trim();

const extractSnippet = (message: any): string => {
  const snippet = message?.snippet
    || message?.body
    || message?.body_text
    || message?.text
    || message?.payload?.snippet
    || '';
  return String(snippet || '');
};

const extractOccurredAt = (message: any): string => {
  const raw = message?.internal_date
    || message?.internalDate
    || message?.received_at
    || message?.date
    || '';
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    // Gmail internalDate is milliseconds-since-epoch as a string.
    return new Date(asNumber).toISOString();
  }
  const parsed = Date.parse(String(raw || ''));
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return new Date().toISOString();
};

const determineSince = (db: any, lookbackMinutes: number): Date => {
  const row = db
    .prepare(`
      SELECT MAX(occurred_at) AS latest
      FROM channel_events
      WHERE channel = 'email' AND action = 'reply_detected'
    `)
    .get();
  const latest = String(row?.latest || '').trim();
  if (latest) {
    const parsed = Date.parse(latest);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return new Date(Date.now() - Math.max(1, Number(lookbackMinutes || 60)) * 60 * 1000);
};

const alreadyRecorded = (db: any, providerMessageId: string) => {
  if (!providerMessageId) return false;
  const row = db
    .prepare(`
      SELECT 1 AS hit FROM channel_events
      WHERE channel = 'email'
        AND action IN ('reply_detected', 'bounce_detected')
        AND provider_message_id = ?
      LIMIT 1
    `)
    .get(providerMessageId);
  return Boolean(row?.hit);
};

const findRecordByThreadId = (db: any, threadId: string) => {
  if (!threadId) return null;
  return db
    .prepare(`
      SELECT * FROM records
      WHERE email_thread_id = ? OR email_last_thread_id = ?
      LIMIT 1
    `)
    .get(threadId, threadId);
};

export const runReplyPoll = async ({ mcp, listDir, db, globalSuppressionDb, config }: PollContext) => {
  const {
    assertListAccessForMutation,
    filterRecordsForCanary,
    loadCanaryConfig,
  } = await import('../policy/canary-isolation.js');
  assertListAccessForMutation(listDir);
  const canaryConfig = loadCanaryConfig({ listDir });
  const sequenceConfig = config?.sequences?.default || {};
  const replyCheck = sequenceConfig?.reply_check || {};
  const toolSpec = replyCheck?.tool || {};
  const listTool = String(
    toolSpec?.list_tool
      || toolSpec?.list
      || (Array.isArray(toolSpec?.tools) ? toolSpec.tools[0] : '')
      || 'GMAIL_LIST_MESSAGES',
  );

  const lookbackMinutes = Number(replyCheck?.lookback_minutes || config?.watch?.poll_replies_minutes || 60);
  const since = determineSince(db, lookbackMinutes);
  const sinceUnix = Math.floor(since.getTime() / 1000);
  const maxResults = Number(replyCheck?.max_results || 100);

  emitActivity({ event: 'poll_start', phase: 'replies', since: since.toISOString(), tool: listTool });

  let rawResult: any;
  try {
    rawResult = await executeComposioTool(mcp, listTool, {
      query: `after:${sinceUnix} in:inbox`,
      q: `after:${sinceUnix} in:inbox`,
      max_results: maxResults,
      maxResults,
    });
  } catch (error) {
    emitActivity({ event: 'poll_error', phase: 'replies', error: String((error as any)?.message || error) });
    return { replied: 0, engaged: 0, opted_out: 0, scanned: 0, errors: [String((error as any)?.message || error)] };
  }

  const messages = asArray(rawResult);
  const summary = { replied: 0, engaged: 0, opted_out: 0, scanned: messages.length, errors: [] as string[] };

  for (const message of messages) {
    try {
      const threadId = extractThreadId(message);
      const messageId = extractMessageId(message);
      if (!threadId || !messageId) continue;
      if (alreadyRecorded(db, messageId)) continue;

      const record = findRecordByThreadId(db, threadId);
      if (!record) continue;
      if (filterRecordsForCanary([record], canaryConfig).length === 0) continue;

      const recordId = getRecordRowId(record);
      const snippet = extractSnippet(message);
      const replyAt = extractOccurredAt(message);

      // Production path: processInboundReplyText pauses before classification.
      // Do NOT classify inline here — that left accounts outbound-active during
      // model latency and was not canary-scoped as a single mutation path.
      const { processInboundReplyText } = await import('./inbound-reply-process.js');
      let processed;
      try {
        processed = await processInboundReplyText({
          db,
          recordId,
          replyText: snippet,
          messageId,
          threadId,
          model: config?.sequences?.default?.reply_check?.model || '',
          aiConfig: config?.ai || {},
        });
      } catch (err) {
        // Canary isolation / transient classifier errors — skip record, do not send.
        continue;
      }
      const classification = String(processed.classification || 'unknown');
      const explicitStop = hasExplicitStopIntent(` ${snippet} `)
        || classification === 'unsubscribe';

      if (explicitStop) {
        const email = String(record?.email_primary || record?.contact_email || '').trim().toLowerCase();
        if (email) {
          const entry = {
            id: randomUUID(),
            value: email,
            value_type: 'email',
            scope: 'global',
            reason: 'opt_out',
            source: 'reply_stop',
            record_id: recordId,
            created_at: new Date().toISOString(),
          };
          addSuppression({ db, entry });
          addSuppression({ db: globalSuppressionDb, entry });
        }
      }

      const nextStatus = String(processed.sequence_status || '');
      summary.replied += 1;
      if (nextStatus === 'engaged') summary.engaged += 1;
      if (nextStatus === 'opted_out' || explicitStop) summary.opted_out += 1;
    } catch (error) {
      if (isBudgetExceededError(error)) throw error;
      summary.errors.push(String((error as any)?.message || error));
    }
  }

  emitActivity({
    event: 'poll_complete',
    phase: 'replies',
    scanned: summary.scanned,
    replied: summary.replied,
    engaged: summary.engaged,
    opted_out: summary.opted_out,
    errors: summary.errors.length,
  });

  return summary;
};

const FINAL_MAIL_STATES = new Set(['delivered', 'returned', 'failed', 'canceled']);

export const runDeliveryPoll = async ({ mcp, listDir, db, config }: Omit<PollContext, 'globalSuppressionDb'>) => {
  const mailTool = String(
    config?.channels?.mail?.tool?.get_tool
      || (Array.isArray(config?.channels?.mail?.tool?.tools) ? config.channels.mail.tool.tools[0] : '')
      || 'LOB_GET_POSTCARD',
  );

  const rawRows = db
    .prepare(`
      SELECT * FROM records
      WHERE mail_last_piece_id != '' AND mail_last_delivered_at = '' AND mail_last_returned_at = ''
      ORDER BY updated_at DESC
      LIMIT 100
    `)
    .all();
  const {
    assertListAccessForMutation,
    filterRecordsForCanary,
    loadCanaryConfig,
  } = await import('../policy/canary-isolation.js');
  assertListAccessForMutation(listDir);
  const rows = filterRecordsForCanary(rawRows, loadCanaryConfig({ listDir }));

  const summary = { refreshed: 0, delivered: 0, returned: 0, errors: [] as string[] };
  if (rows.length === 0) return summary;

  emitActivity({ event: 'poll_start', phase: 'delivery', rows: rows.length, tool: mailTool });

  for (const record of rows) {
    const pieceId = String(record?.mail_last_piece_id || '').trim();
    if (!pieceId) continue;
    try {
      const result = await executeComposioTool(mcp, mailTool, { id: pieceId, piece_id: pieceId });
      const status = String(
        result?.status
          || result?.delivery_status
          || result?.events?.[0]?.name
          || '',
      ).toLowerCase();
      const expected = String(result?.expected_delivery_date || result?.expectedDeliveryDate || '').trim();

      const nextRecord: Record<string, any> = {
        ...record,
        mail_last_expected_delivery: expected || record.mail_last_expected_delivery,
      };

      if (status === 'delivered' || status === 'in_local_area' || status === 'processed_for_delivery') {
        nextRecord.mail_last_delivered_at = new Date().toISOString();
        summary.delivered += 1;
      }
      if (status === 'returned_to_sender' || status === 'returned' || status === 'undeliverable') {
        nextRecord.mail_last_returned_at = new Date().toISOString();
        summary.returned += 1;
      }

      upsertRecord({ db, row: nextRecord });

      if (FINAL_MAIL_STATES.has(status)) {
        insertChannelEvent({
          db,
          event: {
            id: randomUUID(),
            row_id: getRecordRowId(record),
            channel: 'mail',
            event_type: status === 'returned' || status === 'returned_to_sender' ? 'returned' : 'delivered',
            action: 'delivery_polled',
            provider_id: pieceId,
            payload: { status, expected },
            occurred_at: new Date().toISOString(),
          },
        });
      }

      summary.refreshed += 1;
    } catch (error) {
      if (isBudgetExceededError(error)) throw error;
      summary.errors.push(String((error as any)?.message || error));
    }
  }

  emitActivity({
    event: 'poll_complete',
    phase: 'delivery',
    refreshed: summary.refreshed,
    delivered: summary.delivered,
    returned: summary.returned,
    errors: summary.errors.length,
  });
  return summary;
};

export type PollingSchedulerHandle = {
  stop: () => Promise<void>;
};

export const startPollingScheduler = ({
  mcp,
  listDir,
  db,
  globalSuppressionDb,
  config,
}: PollContext): PollingSchedulerHandle => {
  const replyIntervalMs = Math.max(1, Number(config?.watch?.poll_inbound_minutes || config?.watch?.poll_replies_minutes || 5)) * 60 * 1000;
  const deliveryIntervalMs = Math.max(1, Number(config?.watch?.poll_delivery_minutes || 15)) * 60 * 1000;

  let running = true;
  let replyInFlight = false;
  let deliveryInFlight = false;

  const runReplies = async () => {
    if (!running || replyInFlight) return;
    replyInFlight = true;
    try {
      await runImapInboundPoll({ listDir, db, config });
    } catch (error) {
      emitActivity({ event: 'poll_error', phase: 'replies', error: String((error as any)?.message || error) });
    } finally {
      replyInFlight = false;
    }
  };

  const runDelivery = async () => {
    if (!running || deliveryInFlight) return;
    deliveryInFlight = true;
    try {
      await runDeliveryPoll({ mcp, listDir, db, config });
    } catch (error) {
      emitActivity({ event: 'poll_error', phase: 'delivery', error: String((error as any)?.message || error) });
    } finally {
      deliveryInFlight = false;
    }
  };

  const replyTimer = setInterval(runReplies, replyIntervalMs);
  const deliveryTimer = setInterval(runDelivery, deliveryIntervalMs);
  // Kick off an initial pass so the scheduler doesn't idle for a full interval on startup.
  void runReplies();
  void runDelivery();

  return {
    stop: async () => {
      running = false;
      clearInterval(replyTimer);
      clearInterval(deliveryTimer);
    },
  };
};
