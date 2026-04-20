import { randomUUID } from 'node:crypto';
import { nowTimestamp } from './db.js';

export const buildIdempotencyKey = ({ keySource = [], record, scope = 'list' }) => {
  const parts = Array.isArray(keySource) ? keySource : [];
  const values = parts.map((field) => String(record?.[field] || '').trim());
  return `${scope}:${values.join('|')}`;
};

export const getIdempotencyRecord = ({ db, idemKey, scope = 'list' }) =>
  db.prepare('SELECT * FROM idempotency WHERE idem_key = ? AND scope = ?').get(idemKey, scope);

export const claimIdempotency = ({ db, idemKey, scope = 'list', payload = {} }) => {
  const existing = getIdempotencyRecord({ db, idemKey, scope });
  if (existing?.status === 'sent') {
    return { claimed: false, status: 'sent', provider_id: existing.provider_id || '' };
  }

  const now = nowTimestamp();
  const id = existing?.id || randomUUID();
  db.prepare(`
    INSERT INTO idempotency (id, idem_key, scope, status, provider_id, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(idem_key, scope) DO UPDATE SET
      status = excluded.status,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(id, idemKey, scope, 'pending', '', JSON.stringify(payload || {}), existing?.created_at || now, now);

  return { claimed: true, status: 'pending' };
};

export const completeIdempotency = ({ db, idemKey, scope = 'list', providerId = '', payload = {} }) => {
  db.prepare(`
    UPDATE idempotency
    SET status = ?, provider_id = ?, payload_json = ?, updated_at = ?
    WHERE idem_key = ? AND scope = ?
  `).run('sent', providerId, JSON.stringify(payload || {}), nowTimestamp(), idemKey, scope);
};

export const failIdempotency = ({ db, idemKey, scope = 'list', payload = {} }) => {
  db.prepare(`
    UPDATE idempotency
    SET status = ?, payload_json = ?, updated_at = ?
    WHERE idem_key = ? AND scope = ?
  `).run('failed', JSON.stringify(payload || {}), nowTimestamp(), idemKey, scope);
};
