/**
 * Load campaign contacts from the list DB for applyOutboundPolicy.
 * Shared by CLI policy apply, enrich policy_apply, and scoring post-process.
 *
 * Also provides active-contact hydration for channel execution: sends must
 * resolve email/name/linkedin/phone from the campaign active contact, not
 * stale seniority-primary denormalized fields alone.
 */

import {
  parseAccountCampaignFromRecord,
  type CampaignContact,
  type ContactDisposition,
} from './contact-campaign.js';
import { deriveContactFirstName } from './contact-name.js';

export type ContactRow = {
  contact_id?: string;
  id?: string;
  name?: string;
  full_name?: string;
  title?: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;
  role?: string;
  is_primary?: number | boolean;
  dne_email?: number | boolean;
  dnc_phone?: number | boolean;
  email_verification_status?: string;
  email_verification_confidence?: number | string;
  email_verified_at?: string;
  /** Structural phone invalidation (wrong number) — not full-account DNC. */
  dne_phone?: number | boolean;
  /** Optional persisted disposition from contacts table / enrichment. */
  outbound_disposition?: string;
  suppression_state?: string | null;
};

/** Minimal better-sqlite3 surface used by contact loaders. */
type SqliteLike = {
  prepare: (sql: string) => {
    all: (...args: unknown[]) => ContactRow[];
    get: (...args: unknown[]) => ContactRow | undefined;
  };
};

const DISPOSITIONS = new Set<ContactDisposition>([
  'active_target',
  'eligible_target',
  'routing_only',
  'excluded',
  'unresolved',
]);

const truthyFlag = (value: unknown): boolean => {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null || value === '') return false;
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
};

/**
 * Derive outbound disposition from a contacts-table row.
 *
 * Eligibility reads the contacts table (identity, channels, suppression flags,
 * explicit disposition/role) — never invents eligible_target for every row.
 * Channel readiness for a specific send is still re-checked at execute time
 * (e.g. blank email fail-closed for email channel).
 */
export function dispositionFromContactRow(contact: ContactRow | null | undefined): ContactDisposition {
  if (!contact) return 'unresolved';

  const explicit = String(contact.outbound_disposition || '').trim().toLowerCase();
  if (explicit && DISPOSITIONS.has(explicit as ContactDisposition)) {
    return explicit as ContactDisposition;
  }

  const suppression = String(contact.suppression_state || '').trim().toLowerCase();
  if (suppression && suppression !== 'none') {
    return 'excluded';
  }

  const email = String(contact.email || '').trim();
  const phone = String(contact.phone || '').trim();
  const linkedin = String(contact.linkedin_url || '').trim();
  const name = String(contact.full_name || contact.name || '').trim();
  const contactId = String(contact.contact_id || contact.id || '').trim();
  const dneEmail = truthyFlag(contact.dne_email);
  const dncPhone = truthyFlag(contact.dnc_phone);
  const dnePhone = truthyFlag(contact.dne_phone);

  // Role-based routers never enter the named outreach queue.
  const role = String(contact.role || '').trim().toLowerCase();
  if (
    role === 'routing'
    || role === 'router'
    || role === 'routing_only'
    || role === 'route_only'
  ) {
    return 'routing_only';
  }

  // Fully suppressed on every named channel we track → excluded.
  if (dneEmail && (dncPhone || dnePhone) && !linkedin) {
    return 'excluded';
  }

  // No stable person id and no channel identifiers → unresolved candidate.
  if (!contactId && !name && !email && !phone && !linkedin) {
    return 'unresolved';
  }

  // No usable outreach channel left (email blocked + no phone/linkedin, or empty).
  const emailUsable = Boolean(email) && !dneEmail;
  const phoneUsable = Boolean(phone) && !dncPhone && !dnePhone;
  const linkedinUsable = Boolean(linkedin);
  if (!emailUsable && !phoneUsable && !linkedinUsable) {
    // Keep a named person with blocked channels as excluded (not eligible).
    if (name || contactId) return 'excluded';
    return 'unresolved';
  }

  return 'eligible_target';
}

/**
 * Map SQLite contact rows into CampaignContact[] for buildContactPlan.
 * Disposition and rank come from the contacts table, not a blanket eligible_target.
 */
export function mapContactRowsToCampaignContacts(
  contacts: ContactRow[] | null | undefined,
): CampaignContact[] {
  const rows = Array.isArray(contacts) ? contacts : [];
  return rows.map((c, index) => {
    const disposition = dispositionFromContactRow(c);
    const suppression = String(c.suppression_state || '').trim();
    return {
      contact_id: String(c.contact_id || c.id || `c_${index}`),
      outbound_disposition: disposition,
      // Primary first; otherwise stable load order (+2 so primary stays 1).
      outreach_rank: c.is_primary ? 1 : index + 2,
      suppression_state: suppression && suppression !== 'none' ? suppression : null,
    };
  });
}

/**
 * Load contacts for a record from an open better-sqlite3 db handle.
 * Reads the contacts table (not denormalized record fields) for eligibility.
 */
export function loadCampaignContactsFromDb(
  db: SqliteLike,
  rowId: string,
): CampaignContact[] {
  const id = String(rowId || '').trim();
  if (!id || !db) return [];
  try {
    const contacts = db.prepare(`
      SELECT contact_id, id, name, full_name, title, email, phone, linkedin_url,
             role, is_primary, dne_email, dnc_phone, dne_phone
      FROM contacts WHERE row_id = ?
      ORDER BY is_primary DESC, created_at ASC, contact_id ASC
    `).all(id);
    return mapContactRowsToCampaignContacts(contacts);
  } catch {
    // Older schemas may lack some columns — fall back to a narrower select.
    try {
      const contacts = db.prepare(`
        SELECT contact_id, name, email, phone, linkedin_url, role, is_primary
        FROM contacts WHERE row_id = ?
        ORDER BY is_primary DESC, created_at ASC, contact_id ASC
      `).all(id);
      return mapContactRowsToCampaignContacts(contacts);
    } catch {
      return [];
    }
  }
}

/**
 * Resolve the campaign active contact id from plan JSON, then record columns.
 */
export function resolveActiveContactId(
  record: Record<string, unknown> | null | undefined,
): string | null {
  if (!record) return null;
  const campaign = parseAccountCampaignFromRecord(record);
  const fromPlan = String(campaign?.active_contact_id || '').trim();
  if (fromPlan) return fromPlan;
  const fromRecord = String(record.active_contact_id || record.contact_id || '').trim();
  return fromRecord || null;
}

/**
 * Project a contacts-table row onto denormalized record fields used by
 * args_map, templates, Unipile, and operator surfaces.
 *
 * Non-email fields only overlay when non-blank (preserve prior denorm).
 * Email is authoritative from the contact row when present: blank contact.email
 * clears contact_email so seniority-primary / email_primary cannot soft-pass.
 */
export function denormalizedFieldsFromContact(
  contact: ContactRow | null | undefined,
): Record<string, string> {
  if (!contact) return {};
  const name = String(contact.full_name || contact.name || '').trim();
  const title = String(contact.title || '').trim();
  const email = String(contact.email || '').trim();
  const phone = String(contact.phone || '').trim();
  const linkedin = String(contact.linkedin_url || '').trim();
  const emailVerificationStatus = String(contact.email_verification_status || '').trim();
  const emailVerificationConfidence = Number(contact.email_verification_confidence || 0);
  const emailVerifiedAt = String(contact.email_verified_at || '').trim();
  const out: Record<string, string> = {};
  if (name) {
    out.contact_name = name;
    out.contact_name_primary = name;
    out.owner_name = name;
  }
  out.contact_first_name = deriveContactFirstName(name);
  if (title) {
    out.contact_title = title;
    out.contact_title_primary = title;
  }
  // Always project email when a contact row is provided — blank means blank.
  out.contact_email = email;
  const hasVerificationFields = contact.email_verification_status !== undefined
    || contact.email_verification_confidence !== undefined
    || contact.email_verified_at !== undefined;
  if (hasVerificationFields) {
    out.email_verification_status = emailVerificationStatus;
    out.email_verification_confidence = Number.isFinite(emailVerificationConfidence)
      ? String(emailVerificationConfidence)
      : '0';
    out.email_verified_at = emailVerifiedAt;
  }
  if (phone) out.contact_phone = phone;
  if (linkedin) out.contact_linkedin_url = linkedin;
  return out;
}

/**
 * Resolve the email address that may be used for an email send targeting the
 * active contact. Contacts-table email is preferred when a row was loaded;
 * never falls back to denormalized email_primary when the contact row exists
 * with a blank email (fail closed).
 */
export function resolveActiveContactEmailForSend(input: {
  contact?: ContactRow | null;
  record?: Record<string, unknown> | null;
}): { email: string; source: 'contacts_table' | 'record_contact_email' | 'none' } {
  if (input.contact) {
    const email = String(input.contact.email || '').trim();
    return email
      ? { email, source: 'contacts_table' }
      : { email: '', source: 'contacts_table' };
  }
  const fromRecord = String(input.record?.contact_email || '').trim();
  // Intentionally ignore record.email_primary — that is often seniority-primary
  // denorm and must not soft-pass when the active contact has no email.
  if (fromRecord) return { email: fromRecord, source: 'record_contact_email' };
  return { email: '', source: 'none' };
}

/**
 * Load a single contact by contact_id (or legacy id), optionally scoped to a record.
 */
export function loadContactRowById(
  db: SqliteLike | null | undefined,
  contactId: string | null | undefined,
  rowId?: string | null,
): ContactRow | null {
  const id = String(contactId || '').trim();
  if (!id || !db) return null;
  try {
    const scopedRowId = String(rowId || '').trim();
    if (scopedRowId) {
      const scoped = db.prepare(`
        SELECT *
        FROM contacts
        WHERE (contact_id = ? OR id = ?) AND row_id = ?
        ORDER BY CASE WHEN contact_id = ? THEN 0 ELSE 1 END
        LIMIT 1
      `).get(id, id, scopedRowId, id);
      if (scoped) return scoped;
    }
    const any = db.prepare(`
      SELECT *
      FROM contacts
      WHERE contact_id = ? OR id = ?
      ORDER BY CASE WHEN contact_id = ? THEN 0 ELSE 1 END
      LIMIT 1
    `).get(id, id, id);
    return any || null;
  } catch {
    return null;
  }
}

export type HydrateActiveContactResult = {
  /** Record with active-contact identity fields overlaid (never mutates input). */
  record: Record<string, unknown>;
  /** Resolved active contact id, or empty when none. */
  active_contact_id: string;
  /** Contact row when found in the contacts table. */
  contact: ContactRow | null;
  /** Denormalized fields that were overlaid (empty when no contact row). */
  projected: Record<string, string>;
};

/**
 * Overlay the campaign active contact onto a record copy for channel execution.
 * When the contact row is missing, still stamps active_contact_id / contact_id
 * so assertActionTarget and idempotency see the campaign identity.
 *
 * When the contact row exists, its email is authoritative — blank clears any
 * stale denormalized contact_email so email sends cannot soft-pass via
 * seniority-primary / email_primary.
 */
export function hydrateActiveContactOntoRecord(input: {
  db?: SqliteLike | null;
  record: Record<string, unknown>;
}): HydrateActiveContactResult {
  const record = input.record || {};
  const active_contact_id = resolveActiveContactId(record) || '';
  const rowId = String(record._row_id || record.id || '').trim();
  const contact = active_contact_id
    ? loadContactRowById(input.db, active_contact_id, rowId)
    : null;
  const projected = denormalizedFieldsFromContact(contact);
  const next: Record<string, unknown> = {
    ...record,
    ...projected,
  };
  if (active_contact_id) {
    next.active_contact_id = active_contact_id;
    next.contact_id = active_contact_id;
  }
  return {
    record: next,
    active_contact_id,
    contact,
    projected,
  };
}

/**
 * Load denormalized contact_* fields for a contact id (post-rotation re-project).
 */
export function projectActiveContactFields(input: {
  db?: SqliteLike | null;
  contactId: string | null | undefined;
  rowId?: string | null;
}): Record<string, string> {
  const contact = loadContactRowById(input.db, input.contactId, input.rowId);
  return denormalizedFieldsFromContact(contact);
}
