import { getRecordRowId } from '../lib/record.js';
import { isAffirmativeFlag } from '../policy/booleanish.js';
import { upsertContact } from '../runtime/db.js';

type ContactSourceDb = {
  prepare: (sql: string) => {
    get: (...params: string[]) => Record<string, unknown> | undefined;
  };
};

export type ContactSourceResult = {
  promoted: boolean;
  reason: string;
};

const text = (value: unknown) => String(value || '').trim();

const contactRole = (value: unknown): 'primary' | 'secondary' => (
  text(value).toLowerCase() === 'secondary' ? 'secondary' : 'primary'
);

const settledVerificationStatus = (value: unknown) => {
  const status = text(value).toLowerCase();
  return Boolean(status) && !['pipeline_supplied', 'unchecked'].includes(status);
};

/**
 * Promote pipeline-declared record fields into a contact.
 * Pipeline values retain non-provider provenance and can never modify an
 * existing non-pipeline contact with the same email.
 */
export const promoteContactSource = ({
  db,
  record,
  field,
  nameField,
  titleField,
  role,
  stepId,
  contactPolicy,
}: {
  db: ContactSourceDb;
  record: Record<string, unknown>;
  field: string;
  nameField?: string;
  titleField?: string;
  role: unknown;
  stepId: string;
  contactPolicy?: Parameters<typeof upsertContact>[0]['contactPolicy'];
}): ContactSourceResult => {
  const recordId = getRecordRowId(record);
  const email = text(record[field]).toLowerCase();
  const fullName = text(nameField ? record[nameField] : '');
  const title = text(titleField ? record[titleField] : '');
  if (!recordId) return { promoted: false, reason: 'contact_source_missing_record_id' };
  if (!email) return { promoted: false, reason: 'contact_source_empty' };

  const existing = db.prepare(`
    SELECT source, email_verification_status, email_verification_confidence,
           email_verification_reason, email_verified_at
    FROM contacts
    WHERE row_id = ? AND lower(email) = ?
    LIMIT 1
  `).get(recordId, email);
  if (existing && text(existing.source).toLowerCase() !== 'pipeline') {
    return { promoted: false, reason: 'contact_source_existing_contact' };
  }

  upsertContact({
    db,
    contactPolicy,
    contact: {
      record_id: recordId,
      email,
      ...(fullName ? { full_name: fullName } : {}),
      ...(title ? { title } : {}),
      role: contactRole(role),
      source: 'pipeline',
      source_query: `pipeline:${stepId}:${field}`,
      confidence: 0,
      email_verification_status: settledVerificationStatus(existing?.email_verification_status)
        ? text(existing?.email_verification_status)
        : 'pipeline_supplied',
      email_verification_confidence: settledVerificationStatus(existing?.email_verification_status)
        ? Number(existing?.email_verification_confidence || 0)
        : 0,
      email_verification_reason: settledVerificationStatus(existing?.email_verification_status)
        ? text(existing?.email_verification_reason)
        : '',
      email_verified_at: settledVerificationStatus(existing?.email_verification_status)
        ? text(existing?.email_verified_at)
        : '',
      dne_email: isAffirmativeFlag(record.dne_email, { failClosed: true }),
      dnc_phone: isAffirmativeFlag(record.dnc_phone, { failClosed: true }),
      dne_phone: isAffirmativeFlag(record.dne_phone, { failClosed: true }),
    },
  });
  return { promoted: true, reason: 'contact_source_promoted' };
};
