/**
 * Production entrypoint: process one provider bounce / DSN event.
 * Durable + idempotent by provider_message_id on channel_events.
 *
 * Optional pipeline policy (config.policy.on_hard_bounce.suppress) may write
 * suppression-list rows via addSuppression after a hard bounce. Omission leaves
 * today's behaviour: structural bounce handling only, no suppression row.
 */
import {
  applyEmailBounce,
  buildHardBounceSuppressionEntries,
  detectBounceFromText,
  hardBounceSuppressIdentifiers,
  resolveBounceScope,
  resolveBounceType,
  type BounceSource,
  type BounceType,
} from '../policy/bounce.js';
import {
  parseAccountCampaignFromRecord,
  removeSuppressedContactsFromCampaign,
} from '../policy/contact-campaign.js';
import { evaluateReachability } from '../policy/timing-reachability.js';
import {
  addSuppression,
  ensureRecordColumns,
  insertChannelEvent,
  insertComplianceLog,
  projectContactOntoRecord,
  upsertRecord,
} from './db.js';

type BounceDb = {
  prepare: (sql: string) => {
    get: (...args: unknown[]) => Record<string, unknown> | undefined;
    run: (...args: unknown[]) => unknown;
  };
  transaction: <T>(operation: () => T) => () => T;
};

const contactSoftBounceCount = ({
  db,
  recordId,
  contactId,
}: {
  db: BounceDb;
  recordId: string;
  contactId: string;
}) => {
  if (!contactId) return 0;
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM channel_events
      WHERE row_id = ?
        AND contact_id = ?
        AND channel = 'email'
        AND action = 'bounce_detected'
        AND disposition = 'soft'
    `).get(recordId, contactId);
    return Math.max(0, Number(row?.count) || 0);
  } catch {
    return 0;
  }
};

/** True when this provider message id was already recorded as a bounce. */
export function bounceAlreadyRecorded(db: BounceDb, providerMessageId: string): boolean {
  const mid = String(providerMessageId || '').trim();
  if (!mid) return false;
  try {
    const row = db.prepare(`
      SELECT 1 AS hit FROM channel_events
      WHERE channel = 'email'
        AND (
          action = 'bounce_detected'
          OR event_type = 'bounced'
          OR disposition IN ('hard', 'soft', 'bounce', 'hard_bounce', 'soft_bounce')
        )
        AND provider_message_id = ?
      LIMIT 1
    `).get(mid);
    return Boolean(row?.hit);
  } catch {
    return false;
  }
}

export type ProcessBounceEventInput = {
  db: BounceDb;
  recordId: string;
  /** Provider / DSN message id — required for durable idempotency when present. */
  messageId?: string;
  threadId?: string;
  bounceType?: BounceType | string;
  source?: BounceSource;
  snippet?: string;
  email?: string;
  contactId?: string;
  /** Provider-confirmed scope. Omit when the delivery report is ambiguous. */
  scope?: 'contact' | 'account';
  bounceAt?: string;
  softBounceThreshold?: number;
  /**
   * Pipeline config. Only policy.on_hard_bounce.suppress is read for optional
   * suppression-list writes. When omitted, no suppression row is written.
   */
  config?: {
    policy?: {
      on_hard_bounce?: {
        suppress?: unknown;
      };
    };
  };
  /** Optional global suppression DB (same dual-write pattern as opt-out). */
  globalSuppressionDb?: BounceDb;
};

export type ProcessBounceEventResult = {
  record: Record<string, unknown>;
  bounce_type: BounceType;
  sequence_status: string;
  already_applied: boolean;
  hardened_from_soft: boolean;
  channel_event_id: string;
  scope: 'contact' | 'account';
  rotated: boolean;
};

const resolvedContactIdForBounce = ({
  db,
  recordId,
  record,
  contactId,
}: {
  db: BounceDb;
  recordId: string;
  record: Record<string, unknown>;
  contactId?: string;
}) => {
  const candidateId = String(
    contactId || record.active_contact_id || record.contact_id || record.primary_contact_id || '',
  ).trim();
  if (!candidateId) return '';
  try {
    const contact = db.prepare(`
      SELECT contact_id, id
      FROM contacts
      WHERE row_id = ? AND (contact_id = ? OR id = ?)
      ORDER BY CASE WHEN contact_id = ? THEN 0 ELSE 1 END
      LIMIT 1
    `).get(recordId, candidateId, candidateId, candidateId);
    return String(contact?.contact_id || contact?.id || '').trim();
  } catch {
    return '';
  }
};

/** Resolve the address that bounced from evidence, not by guessing email_primary. */
const resolvedEmailForBounce = ({
  db,
  recordId,
  record,
  contactId,
  email,
}: {
  db: BounceDb;
  recordId: string;
  record: Record<string, unknown>;
  contactId?: string;
  email?: string;
}) => {
  const explicit = String(email || '').trim().toLowerCase();
  if (explicit) return explicit;
  const cid = String(contactId || '').trim();
  if (cid) {
    try {
      const contact = db.prepare(`
        SELECT email
        FROM contacts
        WHERE row_id = ? AND (contact_id = ? OR id = ?)
        ORDER BY CASE WHEN contact_id = ? THEN 0 ELSE 1 END
        LIMIT 1
      `).get(recordId, cid, cid, cid);
      const fromContact = String(contact?.email || '').trim().toLowerCase();
      if (fromContact) return fromContact;
    } catch {
      /* contacts table may be missing in pure in-memory harnesses */
    }
  }
  // Active-contact projection only — not email_primary (multi-contact records).
  return String(record.contact_email || '').trim().toLowerCase();
};

const persistContactBounceRotation = ({
  db,
  record,
  patch,
  contactId,
  bouncedAt,
}: {
  db: BounceDb;
  record: Record<string, unknown>;
  patch: Record<string, unknown>;
  contactId: string;
  bouncedAt: string;
}) => {
  const campaign = parseAccountCampaignFromRecord(record);
  if (!campaign) return { patch, rotated: false };
  const existingSuppressedContactIds: string[] =
    Array.isArray(patch.suppressed_contact_ids)
      ? (patch.suppressed_contact_ids as unknown[]).map((value) => String(value))
      : [contactId];
  const suppressedContactIds = new Set<string>(existingSuppressedContactIds);
  suppressedContactIds.add(contactId);
  const rotation = removeSuppressedContactsFromCampaign({
    campaign,
    suppressedContactIds,
  });
  const activeContactId = rotation.campaign.active_contact_id || '';
  const nextAction = {
    action_id: `na_contact_bounce_${String(record._row_id || record.id || '')}`,
    action_type: 'prepare_outbound',
    account_id: String(record._row_id || record.id || ''),
    contact_id: activeContactId,
    lifecycle_stage: String(record.lifecycle_stage || 'contacted'),
    sequence_state: 'active',
    work_state: 'content_generation',
    reason: activeContactId ? 'contact_email_bounce_rotated' : 'contact_email_bounce_no_eligible_contact',
    on_success: 'execute_or_review',
  };
  return {
    patch: {
      ...patch,
      account_contact_plan_json: JSON.stringify(rotation.campaign),
      active_contact_id: activeContactId,
      contact_id: activeContactId,
      automated_actions_used: rotation.rotated ? 0 : record.automated_actions_used,
      last_contact_rotation_at: rotation.rotated ? bouncedAt : record.last_contact_rotation_at,
      next_action_json: JSON.stringify(nextAction),
    },
    rotated: rotation.rotated,
  };
};

/**
 * Apply a provider bounce event to a record and persist.
 * Safe to call twice with the same messageId — second call is a no-op.
 */
export function processBounceEvent(input: ProcessBounceEventInput): ProcessBounceEventResult {
  const recordId = String(input.recordId || '').trim();
  if (!recordId) throw new Error('processBounceEvent: recordId required');

  const record = input.db.prepare('SELECT * FROM records WHERE _row_id = ?').get(recordId) as
    | Record<string, unknown>
    | undefined;
  if (!record) throw new Error(`Record not found: ${recordId}`);

  const messageId = String(input.messageId || '').trim()
    || `bounce_${recordId}_${String(input.bounceAt || Date.now())}`;

  const already = bounceAlreadyRecorded(input.db, messageId);
  if (already) {
    return {
      record,
      bounce_type: (String(record.email_bounce_type || 'hard') === 'soft' ? 'soft' : 'hard'),
      sequence_status: String(record.sequence_status || 'bounced'),
      already_applied: true,
      hardened_from_soft: false,
      channel_event_id: '',
      scope: 'account',
      rotated: false,
    };
  }

  const contactId = resolvedContactIdForBounce({
    db: input.db,
    recordId,
    record,
    contactId: input.contactId,
  });
  const bouncedEmail = resolvedEmailForBounce({
    db: input.db,
    recordId,
    record,
    contactId,
    email: input.email,
  });
  const scope = resolveBounceScope({
    scope: input.scope,
    contactId,
    snippet: input.snippet,
  });
  const priorSoftBounceCount = scope === 'contact'
    ? contactSoftBounceCount({ db: input.db, recordId, contactId })
    : Math.max(0, Number(record.email_soft_bounce_count) || 0);

  const applied = applyEmailBounce({
    record,
    bounceType: resolveBounceType({
      bounceType: input.bounceType,
      snippet: input.snippet,
    }),
    source: input.source || 'dsn',
    bounceAt: input.bounceAt,
    messageId,
    threadId: input.threadId,
    email: bouncedEmail,
    contactId,
    snippet: input.snippet,
    scope,
    softBounceThreshold: input.softBounceThreshold,
    priorSoftBounceCount,
  });

  ensureRecordColumns({
    db: input.db,
    columns: [...Object.keys(applied.patch), 'reachability_json', 'email_bounced_address'],
  });

  // Pipeline-declared hard-bounce suppression only — never implied, never on soft.
  const suppressEntries = applied.bounce_type === 'hard'
    ? buildHardBounceSuppressionEntries({
      email: bouncedEmail || String(applied.patch.email_bounced_address || ''),
      identifiers: hardBounceSuppressIdentifiers(input.config?.policy),
      recordId,
      createdAt: applied.channel_event.occurred_at,
      source: `hard_bounce_policy:${applied.channel_event.payload?.source || input.source || 'dsn'}`,
    })
    : [];

  const persisted = input.db.transaction(() => {
    // Durable per-contact DNE only on hard (or soft-hardened) contact-scope bounce.
    if (applied.scope === 'contact' && applied.bounce_type === 'hard' && contactId) {
      input.db.prepare(`
        UPDATE contacts
        SET dne_email = 1, updated_at = ?
        WHERE row_id = ? AND (contact_id = ? OR id = ?)
      `).run(applied.channel_event.occurred_at, recordId, contactId, contactId);
    }
    const rotated = applied.scope === 'contact' && applied.bounce_type === 'hard'
      ? persistContactBounceRotation({
          db: input.db,
          record,
          patch: applied.patch,
          contactId,
          bouncedAt: applied.channel_event.occurred_at,
        })
      : { patch: applied.patch, rotated: false };
    upsertRecord({ db: input.db, row: rotated.patch });
    if (rotated.patch.active_contact_id) {
      projectContactOntoRecord({
        db: input.db,
        recordId,
        contactId: String(rotated.patch.active_contact_id),
      });
    }
    const projected = input.db.prepare('SELECT * FROM records WHERE _row_id = ?').get(recordId);
    if (projected) {
      upsertRecord({
        db: input.db,
        row: {
          ...projected,
          reachability_json: JSON.stringify(evaluateReachability(projected)),
        },
      });
    }
    insertChannelEvent({ db: input.db, event: applied.channel_event });
    // Factual audit of AO's hard-bounce handling (channel invalidation). Soft
    // bounces without harden are not logged here — they are delivery retries,
    // not a durable compliance action.
    if (applied.bounce_type === 'hard') {
      insertComplianceLog({
        db: input.db,
        entry: {
          record_id: recordId,
          action: 'hard_bounce',
          reason: String(applied.channel_event.payload?.reason
            || `${applied.scope}_hard_bounce`),
          payload: {
            bounce_type: applied.bounce_type,
            scope: applied.scope,
            source: applied.channel_event.payload?.source || input.source || 'dsn',
            email: String(applied.channel_event.payload?.email || bouncedEmail || ''),
            contact_id: String(applied.channel_event.contact_id || contactId || ''),
            message_id: String(applied.channel_event.provider_message_id || messageId || ''),
            hardened_from_soft: Boolean(applied.hardened_from_soft),
          },
          occurred_at: applied.channel_event.occurred_at,
        },
      });
    }
    for (const entry of suppressEntries) {
      addSuppression({ db: input.db, entry });
      if (input.globalSuppressionDb && input.globalSuppressionDb !== input.db) {
        addSuppression({ db: input.globalSuppressionDb, entry });
      }
    }
    return rotated;
  })();

  const next = input.db.prepare('SELECT * FROM records WHERE _row_id = ?').get(recordId) as
    Record<string, unknown>;

  return {
    record: next,
    bounce_type: applied.bounce_type,
    sequence_status: applied.sequence_status,
    already_applied: false,
    hardened_from_soft: applied.hardened_from_soft,
    channel_event_id: applied.channel_event.id,
    scope: applied.scope,
    rotated: persisted.rotated,
  };
}

/**
 * If text looks like a DSN/bounce, process as bounce; otherwise return null.
 * Used by inbound-reply process to route mailer-daemon traffic.
 */
export function tryProcessBounceFromText(input: {
  db: any;
  recordId: string;
  text: string;
  messageId?: string;
  threadId?: string;
  source?: BounceSource;
  config?: ProcessBounceEventInput['config'];
  globalSuppressionDb?: ProcessBounceEventInput['globalSuppressionDb'];
}): ProcessBounceEventResult | null {
  const bounceType = detectBounceFromText(input.text);
  if (!bounceType) return null;
  return processBounceEvent({
    db: input.db,
    recordId: input.recordId,
    messageId: input.messageId,
    threadId: input.threadId,
    bounceType,
    source: input.source || 'dsn',
    snippet: input.text,
    config: input.config,
    globalSuppressionDb: input.globalSuppressionDb,
  });
}
