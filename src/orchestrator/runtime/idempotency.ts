import { randomUUID } from 'node:crypto';
import { nowTimestamp } from './db.js';

/**
 * Build a stable send/idempotency key from key_source field tokens.
 *
 * Resolution order per token: execution `context` first, then `record`.
 * Context is required for tokens that are not columns on the record row —
 * notably the *executing* sequence `step_id` (records do not store the current
 * step id while a step runs) and campaign identity fields the caller wants
 * pinned for this send (active_contact_id, contact_id, …).
 *
 * Default identity pins (when YAML key_source omits them):
 * - `step_id` from context when present
 * - active contact (`active_contact_id` / `contact_id`) when a contact is targeted
 * - `channel` from context when present
 *
 * These pins prevent multi-step, multi-contact, and multi-channel sends from
 * collapsing onto the same key when the author only listed e.g. `[_row_id]`.
 * Tokens already listed in key_source keep their declared position and are not
 * double-appended.
 *
 * Scope is always a prefix (`list:…` by default) and is unchanged by context.
 */
export const buildIdempotencyKey = ({
  keySource = [],
  record,
  scope = 'list',
  context = {},
}: {
  keySource?: string[];
  record?: Record<string, unknown> | null;
  scope?: string;
  /** Execution-time values preferred over record columns (step_id, active_contact_id, channel, …). */
  context?: Record<string, unknown> | null;
} = {}) => {
  const parts = Array.isArray(keySource) ? keySource : [];
  const ctx = context && typeof context === 'object' ? context : {};
  const rec = (record && typeof record === 'object' ? record : {}) as Record<string, unknown>;

  const resolveToken = (field: string): string => {
    const key = String(field ?? '').trim();
    if (!key) return '';
    const fromContext = (ctx as Record<string, unknown>)[key];
    if (fromContext !== undefined && fromContext !== null && String(fromContext).trim() !== '') {
      return String(fromContext).trim();
    }
    return String(rec[key] ?? '').trim();
  };

  const values = parts.map((field) => resolveToken(String(field ?? '')));

  // Default-append identity when YAML omits it. Multi-channel completeness:
  // email / linkedin / phone / mail must not collide when they share a partial
  // key_source (e.g. only _row_id). step_id usually separates sequence steps;
  // channel separates parallel channel surfaces that share a row.
  const listed = new Set(
    parts.map((f) => String(f ?? '').trim().toLowerCase()).filter(Boolean),
  );
  const pins: string[] = [];

  if (!listed.has('step_id')) {
    const stepId = resolveToken('step_id');
    if (stepId) pins.push(stepId);
  }

  const hasContactToken = listed.has('active_contact_id') || listed.has('contact_id');
  if (!hasContactToken) {
    // Prefer active_contact_id, then contact_id — only pin when a contact is targeted.
    const contact = String(
      (ctx as Record<string, unknown>).active_contact_id
      ?? (ctx as Record<string, unknown>).contact_id
      ?? rec.active_contact_id
      ?? rec.contact_id
      ?? '',
    ).trim();
    if (contact) pins.push(contact);
  }

  if (!listed.has('channel') && !listed.has('channel_hint')) {
    const channel = String(
      (ctx as Record<string, unknown>).channel
      ?? (ctx as Record<string, unknown>).channel_hint
      ?? '',
    ).trim().toLowerCase();
    if (channel) pins.push(channel);
  }

  // Pin recipient + content version so a re-send of different copy/to is a new key.
  if (!listed.has('recipient') && !listed.has('to') && !listed.has('contact_email')) {
    const recipient = String(
      (ctx as Record<string, unknown>).recipient
      ?? (ctx as Record<string, unknown>).to
      ?? (ctx as Record<string, unknown>).contact_email
      ?? rec.contact_email
      ?? rec.email
      ?? '',
    ).trim().toLowerCase();
    if (recipient) pins.push(`to:${recipient}`);
  }
  if (!listed.has('content_version') && !listed.has('asset_version') && !listed.has('body_hash')) {
    const contentVer = String(
      (ctx as Record<string, unknown>).content_version
      ?? (ctx as Record<string, unknown>).asset_version
      ?? (ctx as Record<string, unknown>).body_hash
      ?? '',
    ).trim();
    if (contentVer) pins.push(`cv:${contentVer}`);
  }

  return `${scope}:${[...values, ...pins].join('|')}`;
};

export const getIdempotencyRecord = ({ db, idemKey, scope = 'list' }) =>
  db.prepare('SELECT * FROM idempotency WHERE idem_key = ? AND scope = ?').get(idemKey, scope);

/** Pending claims older than this are considered abandoned (worker crash). */
export const IDEMPOTENCY_PENDING_LEASE_MS = 15 * 60 * 1000;

const parsePayload = (raw: unknown): Record<string, unknown> => {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  try {
    const p = JSON.parse(String(raw || '{}'));
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  } catch {
    return {};
  }
};

/**
 * Exclusive claim for a send key.
 *
 * - `sent` → not claimed (idempotent skip; provider_id available for reconcile)
 * - `pending` with unexpired lease → not claimed (another worker owns it)
 * - `pending` with expired lease → uncertain (provider outcome was not observed)
 * - `failed` / missing → exclusive claim
 *
 * Uses INSERT OR ignore + conditional UPDATE so two concurrent workers cannot
 * both observe claimed:true for the same key.
 */
export const claimIdempotency = ({
  db,
  idemKey,
  scope = 'list',
  payload = {},
  leaseMs = IDEMPOTENCY_PENDING_LEASE_MS,
  nowMs = Date.now(),
}: {
  db: any;
  idemKey: string;
  scope?: string;
  payload?: Record<string, unknown>;
  leaseMs?: number;
  nowMs?: number;
}) => {
  const now = nowTimestamp();
  const nowIso = new Date(nowMs).toISOString();
  const leaseUntil = new Date(nowMs + Math.max(1000, Number(leaseMs) || IDEMPOTENCY_PENDING_LEASE_MS)).toISOString();
  const claimId = randomUUID();
  const envelope = {
    ...(payload || {}),
    _claim_id: claimId,
    _lease_until: leaseUntil,
    _claimed_at: nowIso,
  };

  const existing = getIdempotencyRecord({ db, idemKey, scope });
  if (existing?.status === 'sent') {
    return {
      claimed: false,
      status: 'sent' as const,
      provider_id: existing.provider_id || '',
      reason: 'already_sent',
      claim_id: '',
    };
  }

  // Durable uncertain: provider may have accepted — never auto-retry without reconcile.
  if (existing?.status === 'uncertain') {
    return {
      claimed: false,
      status: 'uncertain' as const,
      provider_id: existing.provider_id || '',
      reason: 'provider_uncertain_requires_reconcile',
      claim_id: String(parsePayload(existing.payload_json)._claim_id || ''),
    };
  }

  if (existing?.status === 'pending') {
    const prev = parsePayload(existing.payload_json);
    const leaseExpiry = String(prev._lease_until || '').trim();
    const leaseMsLeft = leaseExpiry ? Date.parse(leaseExpiry) - nowMs : NaN;
    // Active lease held by another worker — refuse exclusive claim.
    if (Number.isFinite(leaseMsLeft) && leaseMsLeft > 0) {
      return {
        claimed: false,
        status: 'pending' as const,
        provider_id: existing.provider_id || '',
        reason: 'lease_held',
        claim_id: String(prev._claim_id || ''),
      };
    }
    const quarantined = db.prepare(`
      UPDATE idempotency
      SET status = 'uncertain', updated_at = ?
      WHERE idem_key = ? AND scope = ? AND status = 'pending'
        AND payload_json = ?
    `).run(now, idemKey, scope, existing.payload_json);
    if (Number(quarantined?.changes || 0) === 1) {
      return {
        claimed: false,
        status: 'uncertain' as const,
        provider_id: existing.provider_id || '',
        reason: 'expired_pending_requires_reconcile',
        claim_id: String(prev._claim_id || ''),
      };
    }
    const again = getIdempotencyRecord({ db, idemKey, scope });
    return {
      claimed: false,
      status: String(again?.status || 'pending') as 'pending' | 'sent' | 'failed' | 'uncertain',
      provider_id: again?.provider_id || '',
      reason: 'race_lost',
      claim_id: String(parsePayload(again?.payload_json)._claim_id || ''),
    };
  }

  // Failed claim: exclusive reclaim via CAS on exact payload snapshot.
  // Two concurrent workers must not both observe claimed:true.
  if (existing?.status === 'failed') {
    const reclaimed = db.prepare(`
      UPDATE idempotency
      SET status = 'pending',
          payload_json = ?,
          provider_id = '',
          updated_at = ?
      WHERE idem_key = ? AND scope = ? AND status = 'failed'
        AND payload_json = ?
    `).run(
      JSON.stringify(envelope),
      now,
      idemKey,
      scope,
      existing.payload_json,
    );
    if (Number(reclaimed?.changes || 0) === 1) {
      return { claimed: true, status: 'pending' as const, provider_id: '', reason: 'reclaimed_failed', claim_id: claimId };
    }
    const again = getIdempotencyRecord({ db, idemKey, scope });
    return {
      claimed: false,
      status: String(again?.status || 'failed') as 'pending' | 'sent' | 'failed',
      provider_id: again?.provider_id || '',
      reason: 'race_lost',
      claim_id: String(parsePayload(again?.payload_json)._claim_id || ''),
    };
  }

  // Insert new pending claim. Concurrent insert races are re-read exclusively.
  try {
    db.prepare(`
      INSERT INTO idempotency (id, idem_key, scope, status, provider_id, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', '', ?, ?, ?)
    `).run(claimId, idemKey, scope, JSON.stringify(envelope), now, now);
    return { claimed: true, status: 'pending' as const, provider_id: '', reason: 'inserted', claim_id: claimId };
  } catch {
    // Concurrent insert — re-read and apply exclusive rules (never broad WHERE pending).
    const race = getIdempotencyRecord({ db, idemKey, scope });
    if (race?.status === 'sent') {
      return {
        claimed: false,
        status: 'sent' as const,
        provider_id: race.provider_id || '',
        reason: 'already_sent',
        claim_id: '',
      };
    }
    if (race?.status === 'pending') {
      const prev = parsePayload(race.payload_json);
      const leaseExpiry = String(prev._lease_until || '').trim();
      if (leaseExpiry && Date.parse(leaseExpiry) > nowMs) {
        return {
          claimed: false,
          status: 'pending' as const,
          provider_id: '',
          reason: 'lease_held',
          claim_id: String(prev._claim_id || ''),
        };
      }
      const quarantined = db.prepare(`
        UPDATE idempotency
        SET status = 'uncertain', updated_at = ?
        WHERE idem_key = ? AND scope = ? AND status = 'pending' AND payload_json = ?
      `).run(now, idemKey, scope, race.payload_json);
      if (Number(quarantined?.changes || 0) === 1) {
        return {
          claimed: false,
          status: 'uncertain' as const,
          provider_id: race.provider_id || '',
          reason: 'expired_pending_requires_reconcile',
          claim_id: String(prev._claim_id || ''),
        };
      }
    }
    if (race?.status === 'failed') {
      const reclaimed = db.prepare(`
        UPDATE idempotency
        SET status = 'pending', payload_json = ?, provider_id = '', updated_at = ?
        WHERE idem_key = ? AND scope = ? AND status = 'failed' AND payload_json = ?
      `).run(JSON.stringify(envelope), now, idemKey, scope, race.payload_json);
      if (Number(reclaimed?.changes || 0) === 1) {
        return { claimed: true, status: 'pending' as const, provider_id: '', reason: 'reclaimed_failed', claim_id: claimId };
      }
    }
    return {
      claimed: false,
      status: String(race?.status || 'pending') as 'pending' | 'sent' | 'failed',
      provider_id: race?.provider_id || '',
      reason: 'race_lost',
      claim_id: '',
    };
  }
};

/**
 * Mark send complete. Prefer matching claim_id when provided so a late worker
 * cannot complete another worker's in-flight claim after a steal.
 */
export const completeIdempotency = ({
  db,
  idemKey,
  scope = 'list',
  providerId = '',
  payload = {},
  claimId = '',
}: {
  db: any;
  idemKey: string;
  scope?: string;
  providerId?: string;
  payload?: Record<string, unknown>;
  claimId?: string;
}) => {
  const now = nowTimestamp();
  const want = String(claimId || '').trim();
  const existing = getIdempotencyRecord({ db, idemKey, scope });
  if (!existing) return { completed: false, reason: 'missing' as const };
  if (existing.status === 'sent') {
    return { completed: false, reason: 'already_sent' as const, provider_id: existing.provider_id || providerId };
  }
  const prev = parsePayload(existing.payload_json);
  const owner = String(prev._claim_id || '');
  if (want && owner && owner !== want) {
    return { completed: false, reason: 'not_owner' as const, owner, claim_id: want };
  }
  const body = JSON.stringify({
    ...prev,
    ...(payload || {}),
    ...(want ? { _claim_id: want } : {}),
    _completed_at: now,
  });
  // Single conditional UPDATE: ownership + status in one CAS (no TOCTOU race).
  // An uncertain send requires an explicit provider reconciliation, never a
  // normal completion path.
  const result = want
    ? db.prepare(`
        UPDATE idempotency
        SET status = 'sent', provider_id = ?, payload_json = ?, updated_at = ?
        WHERE idem_key = ? AND scope = ?
          AND status IN ('pending', 'failed')
          AND payload_json = ?
      `).run(providerId, body, now, idemKey, scope, existing.payload_json)
    : db.prepare(`
        UPDATE idempotency
        SET status = 'sent', provider_id = ?, payload_json = ?, updated_at = ?
        WHERE idem_key = ? AND scope = ? AND status IN ('pending', 'failed')
      `).run(providerId, body, now, idemKey, scope);
  if (Number(result?.changes || 0) !== 1) {
    return { completed: false, reason: 'race_lost' as const };
  }
  return { completed: true, reason: 'sent' as const, provider_id: providerId };
};

/**
 * Reconcile a provider-accepted send after a crash: if status is pending but we
 * have a provider id from the provider, mark sent without re-sending.
 */
export const reconcileIdempotencyProviderAccepted = ({
  db,
  idemKey,
  scope = 'list',
  providerId,
  payload = {},
}: {
  db: any;
  idemKey: string;
  scope?: string;
  providerId: string;
  payload?: Record<string, unknown>;
}) => {
  const pid = String(providerId || '').trim();
  if (!pid) return { reconciled: false, reason: 'no_provider_id' };
  const existing = getIdempotencyRecord({ db, idemKey, scope });
  if (!existing) return { reconciled: false, reason: 'missing' };
  if (existing.status === 'sent') {
    return { reconciled: false, reason: 'already_sent', provider_id: existing.provider_id || pid };
  }
  // Authoritative path out of uncertain/pending/failed after provider acceptance.
  const now = nowTimestamp();
  const body = JSON.stringify({
    ...parsePayload(existing.payload_json),
    ...payload,
    reconciled: true,
    _reconciled_at: now,
  });
  const result = db.prepare(`
    UPDATE idempotency
    SET status = 'sent', provider_id = ?, payload_json = ?, updated_at = ?
    WHERE idem_key = ? AND scope = ?
      AND status IN ('pending', 'failed', 'uncertain')
  `).run(pid, body, now, idemKey, scope);
  if (Number(result?.changes || 0) !== 1) {
    return { reconciled: false, reason: 'race_lost' };
  }
  return { reconciled: true, reason: 'provider_accepted', provider_id: pid };
};

/**
 * Mark claim failed. When claimId is provided, only the owning claim may fail —
 * a stale worker must not poison a newer exclusive claim after lease expiry/steal.
 */
export const failIdempotency = ({
  db,
  idemKey,
  scope = 'list',
  payload = {},
  claimId = '',
}: {
  db: any;
  idemKey: string;
  scope?: string;
  payload?: Record<string, unknown>;
  claimId?: string;
}) => {
  const now = nowTimestamp();
  const existing = getIdempotencyRecord({ db, idemKey, scope });
  if (!existing) return { failed: false, reason: 'missing' as const };
  if (existing.status === 'sent') {
    return { failed: false, reason: 'already_sent' as const };
  }
  const prev = parsePayload(existing.payload_json);
  const owner = String(prev._claim_id || '');
  const want = String(claimId || '').trim();
  if (want && owner && owner !== want) {
    return { failed: false, reason: 'not_owner' as const, owner, claim_id: want };
  }
  // Ambiguous provider acceptance → durable non-retryable `uncertain` status.
  // Lease expiry must NOT allow another send; only reconcileIdempotencyProviderAccepted
  // (or explicit human clear) may move the row to sent/failed.
  if ((payload as any)?.provider_uncertain === true) {
    if (existing.status === 'uncertain') {
      return { failed: false, reason: 'provider_uncertain' as const, claim_id: want || owner };
    }
    const uncertainBody = JSON.stringify({
      ...prev,
      ...(payload || {}),
      ...(want ? { _claim_id: want } : {}),
      _uncertain_at: now,
      provider_uncertain: true,
    });
    const u = db.prepare(`
      UPDATE idempotency
      SET status = 'uncertain', payload_json = ?, updated_at = ?
      WHERE idem_key = ? AND scope = ?
        AND status IN ('pending', 'failed')
        AND payload_json = ?
    `).run(uncertainBody, now, idemKey, scope, existing.payload_json);
    if (Number(u?.changes || 0) !== 1) {
      return { failed: false, reason: 'race_lost' as const };
    }
    return { failed: false, reason: 'provider_uncertain' as const, claim_id: want || owner, status: 'uncertain' as const };
  }
  if (existing.status === 'uncertain') {
    return { failed: false, reason: 'provider_uncertain' as const, claim_id: want || owner };
  }
  const body = JSON.stringify({
    ...prev,
    ...(payload || {}),
    ...(want ? { _claim_id: want } : {}),
    _failed_at: now,
  });
  // Atomic CAS on payload_json snapshot — concurrent stealer loses.
  const result = db.prepare(`
    UPDATE idempotency
    SET status = 'failed', payload_json = ?, updated_at = ?
    WHERE idem_key = ? AND scope = ?
      AND status IN ('pending', 'failed')
      AND payload_json = ?
  `).run(body, now, idemKey, scope, existing.payload_json);
  if (Number(result?.changes || 0) !== 1) {
    return { failed: false, reason: 'race_lost' as const };
  }
  return { failed: true, reason: 'marked_failed' as const };
};
