import { randomUUID } from 'node:crypto';
import { nowTimestamp } from './db.js';
import { deliveryModeForChannel } from './delivery-mode.js';

export type LiveInteractionBudget = {
  max_accounts: number;
  max_interactions: number;
};

type LedgerStatus = 'reserved' | 'accepted' | 'released';

type LedgerRow = {
  ledger_id: string;
  identity_key: string;
  record_id: string;
  contact_id: string;
  channel: string;
  step_id: string;
  provider_id: string;
  provider_message_id: string;
  delivery_mode: 'live' | 'sink';
  status: LedgerStatus;
  occurred_at: string;
  created_at: string;
  updated_at: string;
};

const trim = (value: unknown) => String(value ?? '').trim();

const activeLiveWhere = "delivery_mode = 'live' AND status IN ('reserved', 'accepted')";

export const resolveLiveInteractionBudget = (config: Record<string, unknown> | null | undefined): LiveInteractionBudget | null => {
  const raw = config?.live_interaction_budget;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const maxAccounts = Number((raw as Record<string, unknown>).max_accounts);
  const maxInteractions = Number((raw as Record<string, unknown>).max_interactions);
  if (!Number.isInteger(maxAccounts) || maxAccounts < 0 || !Number.isInteger(maxInteractions) || maxInteractions < 0) {
    throw new Error('live_interaction_budget is invalid.');
  }
  return { max_accounts: maxAccounts, max_interactions: maxInteractions };
};

export const liveInteractionIdentity = ({
  recordId,
  stepId,
  contactId,
}: {
  recordId: string;
  stepId: string;
  contactId: string;
}) => `${trim(recordId)}|${trim(stepId)}|${trim(contactId)}`;

const liveInteractionCounts = (db: any) => {
  const interactions = db.prepare(`SELECT COUNT(*) AS n FROM live_interaction_ledger WHERE ${activeLiveWhere}`).get();
  const accounts = db.prepare(`SELECT COUNT(DISTINCT record_id) AS n FROM live_interaction_ledger WHERE ${activeLiveWhere}`).get();
  return {
    interactions: Number(interactions?.n || 0),
    accounts: Number(accounts?.n || 0),
  };
};

/**
 * Whether the provider hop for THIS channel is stubbed.
 *
 * Must mirror each channel's real stub test exactly, because a mismatch is
 * fail-open: the budget would treat a send as sink and skip the reservation
 * while the provider actually delivers to a human. A previous form of this
 * check matched any `AO_*SINK*`/`AO_*FIXTURE*` variable, so simulating
 * physical mail (`AO_MAIL_SINK=1`) silently uncapped live email.
 *
 * The providers and ledger share `deliveryModeForChannel`, so a live send
 * cannot be excused from the budget by a diverging sink predicate.
 */
export const isSinkOrFixtureMode = (
  channel: 'email' | 'linkedin' | 'mail',
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
) => {
  return deliveryModeForChannel(channel, env) === 'sink';
};

export const reserveLiveInteraction = ({
  db,
  budget,
  recordId,
  contactId,
  channel,
  stepId,
  at = nowTimestamp(),
}: {
  db: any;
  budget: LiveInteractionBudget;
  recordId: string;
  contactId: string;
  channel: string;
  stepId: string;
  at?: string;
}) => {
  const identityKey = liveInteractionIdentity({ recordId, stepId, contactId });
  const reserve = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM live_interaction_ledger WHERE identity_key = ?').get(identityKey) as LedgerRow | undefined;
    if (existing && existing.delivery_mode === 'live' && ['reserved', 'accepted'].includes(existing.status)) {
      return {
        allowed: true,
        reason: 'already_reserved',
        ledger_id: existing.ledger_id,
        counts: liveInteractionCounts(db),
      };
    }

    const counts = liveInteractionCounts(db);
    const accountAlreadyContacted = db.prepare(`
      SELECT 1 AS present FROM live_interaction_ledger
      WHERE record_id = ? AND ${activeLiveWhere}
      LIMIT 1
    `).get(recordId);
    if (counts.interactions >= budget.max_interactions) {
      return { allowed: false, reason: 'live_interaction_budget_exhausted', counts };
    }
    if (!accountAlreadyContacted && counts.accounts >= budget.max_accounts) {
      return { allowed: false, reason: 'live_interaction_budget_exhausted', counts };
    }

    const ledgerId = existing?.ledger_id || randomUUID();
    if (existing) {
      db.prepare(`
        UPDATE live_interaction_ledger
        SET record_id = ?, contact_id = ?, channel = ?, step_id = ?,
            provider_id = '', provider_message_id = '', delivery_mode = 'live',
            status = 'reserved', occurred_at = ?, updated_at = ?
        WHERE identity_key = ?
      `).run(recordId, contactId, channel, stepId, at, at, identityKey);
    } else {
      db.prepare(`
        INSERT INTO live_interaction_ledger (
          ledger_id, identity_key, record_id, contact_id, channel, step_id,
          provider_id, provider_message_id, delivery_mode, status,
          occurred_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '', '', 'live', 'reserved', ?, ?, ?)
      `).run(ledgerId, identityKey, recordId, contactId, channel, stepId, at, at, at);
    }
    return {
      allowed: true,
      reason: 'reserved',
      ledger_id: ledgerId,
      counts: {
        interactions: counts.interactions + 1,
        accounts: counts.accounts + (accountAlreadyContacted ? 0 : 1),
      },
    };
  });
  return reserve.immediate();
};

export const commitLiveInteraction = ({
  db,
  recordId,
  contactId,
  channel,
  stepId,
  providerId,
  at = nowTimestamp(),
}: {
  db: any;
  recordId: string;
  contactId: string;
  channel: string;
  stepId: string;
  providerId: string;
  at?: string;
}) => {
  const identityKey = liveInteractionIdentity({ recordId, stepId, contactId });
  const updated = db.prepare(`
    UPDATE live_interaction_ledger
    SET channel = ?, provider_id = ?, provider_message_id = ?, status = 'accepted',
        occurred_at = ?, updated_at = ?
    WHERE identity_key = ? AND delivery_mode = 'live' AND status IN ('reserved', 'accepted')
  `).run(channel, providerId, providerId, at, at, identityKey);
  if (Number(updated?.changes || 0) !== 1) throw new Error('Live interaction ledger reservation was not found.');
};

export const recordUnbudgetedLiveInteraction = ({
  db,
  recordId,
  contactId,
  channel,
  stepId,
  providerId,
  at = nowTimestamp(),
}: {
  db: any;
  recordId: string;
  contactId: string;
  channel: string;
  stepId: string;
  providerId: string;
  at?: string;
}) => {
  const identityKey = liveInteractionIdentity({ recordId, stepId, contactId });
  db.prepare(`
    INSERT INTO live_interaction_ledger (
      ledger_id, identity_key, record_id, contact_id, channel, step_id,
      provider_id, provider_message_id, delivery_mode, status,
      occurred_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', 'accepted', ?, ?, ?)
    ON CONFLICT(identity_key) DO UPDATE SET
      record_id = excluded.record_id,
      contact_id = excluded.contact_id,
      channel = excluded.channel,
      step_id = excluded.step_id,
      provider_id = excluded.provider_id,
      provider_message_id = excluded.provider_message_id,
      delivery_mode = 'live',
      status = 'accepted',
      occurred_at = excluded.occurred_at,
      updated_at = excluded.updated_at
  `).run(
    randomUUID(), identityKey, recordId, contactId, channel, stepId,
    providerId, providerId, at, at, at,
  );
};

export const releaseLiveInteractionReservation = ({
  db,
  recordId,
  contactId,
  stepId,
  at = nowTimestamp(),
}: {
  db: any;
  recordId: string;
  contactId: string;
  stepId: string;
  at?: string;
}) => {
  const identityKey = liveInteractionIdentity({ recordId, stepId, contactId });
  db.prepare(`
    UPDATE live_interaction_ledger
    SET status = 'released', updated_at = ?
    WHERE identity_key = ? AND delivery_mode = 'live' AND status = 'reserved'
  `).run(at, identityKey);
};

export const recordSinkInteraction = ({
  db,
  recordId,
  contactId,
  channel,
  stepId,
  providerId,
  at = nowTimestamp(),
}: {
  db: any;
  recordId: string;
  contactId: string;
  channel: string;
  stepId: string;
  providerId: string;
  at?: string;
}) => {
  const identityKey = liveInteractionIdentity({ recordId, stepId, contactId });
  db.prepare(`
    INSERT INTO live_interaction_ledger (
      ledger_id, identity_key, record_id, contact_id, channel, step_id,
      provider_id, provider_message_id, delivery_mode, status,
      occurred_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sink', 'accepted', ?, ?, ?)
    ON CONFLICT(identity_key) DO NOTHING
  `).run(
    randomUUID(), identityKey, recordId, contactId, channel, stepId,
    providerId, providerId, at, at, at,
  );
};

export const getLiveInteractionBudgetStatus = ({
  db,
  budget,
  limit = 100,
}: {
  db: any;
  budget: LiveInteractionBudget | null;
  limit?: number;
}) => {
  const counts = liveInteractionCounts(db);
  const items = db.prepare(`
    SELECT ledger_id, record_id, contact_id, channel, step_id, provider_id,
      provider_message_id, delivery_mode, status, occurred_at, created_at, updated_at
    FROM live_interaction_ledger
    ORDER BY datetime(occurred_at) DESC, ledger_id DESC
    LIMIT ?
  `).all(Math.max(1, Number(limit) || 100));
  if (!budget) {
    return {
      budget: { configured: false, max_accounts: null, max_interactions: null },
      usage: { accounts: counts.accounts, interactions: counts.interactions },
      remaining: { accounts: null, interactions: null },
      items,
    };
  }
  return {
    budget: { configured: true, ...budget },
    usage: { accounts: counts.accounts, interactions: counts.interactions },
    remaining: {
      accounts: Math.max(0, budget.max_accounts - counts.accounts),
      interactions: Math.max(0, budget.max_interactions - counts.interactions),
    },
    items,
  };
};
