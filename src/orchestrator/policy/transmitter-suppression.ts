import { hasSuppression, openGlobalSuppressionDb } from '../runtime/db.js';
import { stableHash } from '../lib/record.js';
import { isAffirmativeFlag } from './booleanish.js';

type SqliteLike = {
  close: () => void;
  prepare: (...args: unknown[]) => unknown;
};

export type TransmitterChannel = 'email' | 'linkedin' | 'mail';

export type TransmitterSuppressionResult = {
  blocked: boolean;
  reason: string;
};

const text = (value: unknown) => String(value ?? '').trim();

const hasListSuppression = ({ db, value, valueType }: {
  db: SqliteLike;
  value: string;
  valueType: string;
}): boolean => {
  try {
    return hasSuppression({ db, value, valueType });
  } catch (error) {
    if (/no such table: suppression/i.test(String((error as Error)?.message || error))) return false;
    throw error;
  }
};

const hasGlobalOrListSuppression = ({
  db,
  value,
  valueType,
}: {
  db: SqliteLike;
  value: string;
  valueType: string;
}): boolean => {
  if (!value) return false;
  const globalDb = openGlobalSuppressionDb({ readonly: true }) as SqliteLike;
  try {
    return hasListSuppression({ db, value, valueType })
      || hasSuppression({ db: globalDb, value, valueType });
  } finally {
    globalDb.close();
  }
};

export const evaluateTransmitterSuppression = ({
  db,
  record,
  channel,
}: {
  db: SqliteLike;
  record: Record<string, unknown>;
  channel: TransmitterChannel;
}): TransmitterSuppressionResult => {
  if (isAffirmativeFlag(record.suppressed, { failClosed: true })) {
    return { blocked: true, reason: 'record_suppressed' };
  }
  if (text(record.suppression_state).toLowerCase() !== ''
    && text(record.suppression_state).toLowerCase() !== 'none') {
    return { blocked: true, reason: 'contact_suppressed' };
  }

  if (channel === 'linkedin') {
    if (isAffirmativeFlag(record.linkedin_suppressed, { failClosed: true })) {
      return { blocked: true, reason: 'linkedin_suppressed' };
    }
    const linkedin = text(record.contact_linkedin_url);
    try {
      if (hasGlobalOrListSuppression({ db, value: linkedin, valueType: 'linkedin' })) {
        return { blocked: true, reason: 'linkedin_suppressed' };
      }
    } catch {
      return { blocked: true, reason: 'suppression_registry_unreadable' };
    }
    return { blocked: false, reason: '' };
  }

  if (channel === 'email') {
    if (
      isAffirmativeFlag(record.dne_email, { failClosed: true })
      || isAffirmativeFlag(record.email_suppressed, { failClosed: true })
    ) {
      return { blocked: true, reason: 'email_suppressed' };
    }
    const email = text(record.contact_email).toLowerCase();
    try {
      if (hasGlobalOrListSuppression({ db, value: email, valueType: 'email' })) {
        return { blocked: true, reason: 'email_suppressed' };
      }
    } catch {
      return { blocked: true, reason: 'suppression_registry_unreadable' };
    }
    return { blocked: false, reason: '' };
  }

  if (isAffirmativeFlag(record.mail_suppressed, { failClosed: true })) {
    return { blocked: true, reason: 'mail_suppressed' };
  }
  const address = [record.address, record.city, record.state, record.zip || record.postal_code]
    .map((part) => text(part).toLowerCase())
    .filter(Boolean)
    .join(', ');
  try {
    if (
      hasGlobalOrListSuppression({ db, value: address, valueType: 'address' })
      || hasGlobalOrListSuppression({ db, value: address ? stableHash(address) : '', valueType: 'address_hash' })
    ) {
      return { blocked: true, reason: 'address_suppressed' };
    }
  } catch {
    return { blocked: true, reason: 'suppression_registry_unreadable' };
  }
  return { blocked: false, reason: '' };
};
