/**
 * Evidence / observation / source-snapshot / resolution contract helpers.
 * Production policy path persists these so consequential facts, conflicts,
 * unknowns, snapshots, and resolution history are inspectable and reproducible.
 *
 * Immutable retrieval architecture:
 * 1. Enrich/tool success writes a content-hashed retrieval snapshot BEFORE
 *    any observation is derived from that retrieval.
 * 2. Observations cite snapshot source_id (not live mutable field rereads)
 *    as the sole source of truth when a durable trail exists.
 * 3. Policy/classify/score prefer last_retrieval_snapshot_json + observations_json;
 *    mutable scalar fallbacks are marked provisional: true only when no snapshot
 *    / durable observation backs the field.
 * 4. Failure paths never erase prior good snapshots or non-blank evidence fields.
 */

import { createHash } from 'node:crypto';
import {
  DEFAULT_SCORE_BUYER_CONFIDENCE,
  DEFAULT_SCORE_IDENTITY_CONFIDENCE,
  DEFAULT_SCORE_MAIL_CONFIDENCE,
  DEFAULT_SCORE_PHONE_CONFIDENCE,
  type BuyerConfidenceConfig,
  type BuyerConfidenceConfigInput,
  type IdentityConfidenceConfig,
  type IdentityConfidenceConfigInput,
  type MailConfidenceConfig,
  type MailConfidenceConfigInput,
  type PhoneConfidenceConfig,
  type PhoneConfidenceConfigInput,
} from '../../schemas/config.js';
import { isAffirmativeFlag } from './booleanish.js';

export const EVIDENCE_CONTRACT_VERSION = 'tv-evidence-v1';

/** Record JSON columns used for durable evidence (ensureRecordColumns TEXT). */
export const EVIDENCE_RECORD_COLUMNS = [
  'observations_json',
  'identity_resolution_json',
  'contradictions_json',
  'evidence_resolution_json',
] as const;

/**
 * Weak authority sources — model / fixture / self must never be sole authority
 * for consequential fields. Observations from these sources are provisional;
 * policy prefers non-model durable observations over them.
 */
export const WEAK_AUTHORITY_SOURCES = new Set(['model', 'fixture', 'self']);

/** True when a source/provider/step label is model, fixture, or self (weak authority). */
export function isWeakAuthoritySource(source: unknown): boolean {
  const s = text(source).toLowerCase();
  if (!s) return false;
  if (WEAK_AUTHORITY_SOURCES.has(s)) return true;
  // Composite labels preserve weak-authority prefixes, such as fixture_* or model_*.
  for (const weak of WEAK_AUTHORITY_SOURCES) {
    if (s === weak || s.startsWith(`${weak}_`) || s.endsWith(`_${weak}`) || s.includes(`.${weak}`) || s.includes(`/${weak}`)) {
      return true;
    }
  }
  // Common patterns without pure token match
  if (/\b(model|fixture|self)\b/.test(s)) return true;
  return false;
}

/** True when a snapshot is weak-authority (model/fixture/self). */
export function isWeakAuthoritySnapshot(snap: SourceSnapshot | null | undefined): boolean {
  if (!snap) return false;
  return (
    isWeakAuthoritySource(snap.source)
    || isWeakAuthoritySource(snap.provider)
    || isWeakAuthoritySource(snap.step_id)
  );
}

export type SupportStatus =
  | 'literal_support'
  | 'inferred'
  | 'conflicted'
  | 'unknown'
  | 'stale'
  | 'tool_failure';

export type SourceSnapshot = {
  source_id: string;
  provider: string;
  /** Human/system source label (intake strategy, tool slug, step id). */
  source?: string;
  query?: string;
  retrieved_at: string;
  cost_usd?: number | null;
  freshness_hours?: number | null;
  body_ref?: string;
  /** Content hash of body/excerpt for immutability + idempotent snapshot ids. */
  content_hash?: string;
  /** Optional raw provider / object reference (distinct from body_ref storage key). */
  raw_ref?: string;
  record_id?: string;
  /** Enrich/tool step that produced this snapshot. */
  step_id?: string;
  /** Dot-path or field path into the tool result (e.g. markdown, place_id). */
  path?: string;
  /** Bounded operator-display excerpt; raw bytes live in raw_content. */
  excerpt?: string;
  kind?: 'intake' | 'retrieval' | 'tool_failure';
};

export type Observation = {
  evidence_id: string;
  predicate: string;
  value: unknown;
  support_status: SupportStatus;
  /** Snapshot source_id this observation was derived from (required for non-provisional). */
  source_id?: string;
  literal_support?: string;
  observed_at: string;
  /**
   * True when value was reconstructed from live mutable record fields without a
   * durable retrieval/observation trail. Downstream must not treat provisional
   * as equal authority to snapshot-backed observations.
   */
  provisional?: boolean;
};

export type FieldResolution = {
  field: string;
  value: unknown;
  evidence_ids: string[];
  alternatives: Array<{ value: unknown; evidence_ids: string[]; reason?: string }>;
  resolver: 'deterministic' | 'model' | 'human' | 'unknown';
  unknowns?: string[];
  contradictions?: Contradiction[];
  expires_at?: string | null;
  resolved_at: string;
};

export type Contradiction = {
  contradiction_id: string;
  field: string;
  values: unknown[];
  evidence_ids: string[];
  status: 'open' | 'resolved' | 'accepted';
  noted_at: string;
};

export type IdentityResolution = {
  account_id: string;
  place_id?: string | null;
  company_resolution?: string | null;
  identity_confidence?: number | null;
  resolutions: FieldResolution[];
  contract_version: string;
  generated_at: string;
};

const LEGACY_BUYER_NAME_FIELDS = ['observed_buyer_name', 'buyer_name', 'primary_buyer_name', 'named_buyer_name'];
const LEGACY_BUYER_STATUS_FIELDS = ['named_buyer_status', 'buyer_named_status', 'primary_buyer_status'];
const CANONICAL_CONTACT_NAME_FIELDS = ['decision_maker_name', 'contact_name', 'contact_name_primary'];
const BUYER_ROLE_FIELDS = [
  'decision_maker_title',
  'contact_title',
  'contact_title_primary',
  'buying_center_role',
  'buyer_role',
  'named_buyer_role',
];
const BUYER_AFFILIATION_FIELDS = ['buyer_affiliation_status', 'current_affiliation_status', 'affiliation_status'];
const CANONICAL_CONTACT_EMAIL_FIELDS = ['decision_maker_email', 'contact_email', 'email_primary'];

const hasLiteralSupport = (resolution: FieldResolution | undefined): boolean => (
  Boolean(
    resolution
    && resolution.value !== null
    && resolution.value !== undefined
    && text(resolution.value)
    && resolution.evidence_ids.length > 0,
  )
);

const unresolvedIdentityAlternatives = (resolution: FieldResolution): number => (
  resolution.alternatives.filter((alternative) => {
    const reason = text(alternative.reason);
    return !reason.startsWith('lower_precedence_than:');
  }).length
);

/**
 * Deterministic, fail-closed identity confidence from the persisted resolution.
 * Only literal-support-backed core fields earn points; unresolved identity is 0.
 */
export const deriveIdentityConfidence = (
  resolution: Omit<IdentityResolution, 'identity_confidence'> | IdentityResolution,
  config?: IdentityConfidenceConfigInput,
): number => {
  if (text(resolution.company_resolution).toLowerCase() !== 'resolved') return 0;

  const policy: IdentityConfidenceConfig = {
    weights: {
      ...DEFAULT_SCORE_IDENTITY_CONFIDENCE.weights,
      ...(config?.weights || {}),
    },
    penalties: {
      ...DEFAULT_SCORE_IDENTITY_CONFIDENCE.penalties,
      ...(config?.penalties || {}),
    },
  };
  const byField = new Map(resolution.resolutions.map((fieldResolution) => [fieldResolution.field, fieldResolution]));
  const supportedScore = Object.entries(policy.weights).reduce((total, [field, weight]) => (
    hasLiteralSupport(byField.get(field)) ? total + weight : total
  ), 0);
  const unresolvedCount = resolution.resolutions.reduce((total, fieldResolution) => (
    total
    + unresolvedIdentityAlternatives(fieldResolution)
  ), 0);
  const contradictionCount = resolution.resolutions.reduce((total, fieldResolution) => (
    total + (fieldResolution.contradictions || []).filter((contradiction) => contradiction.status === 'open').length
  ), 0);
  const penalty = Math.min(
    policy.penalties.maximum_total,
    unresolvedCount * policy.penalties.unresolved_alternative
      + contradictionCount * policy.penalties.open_contradiction,
  );
  return Math.max(0, Math.min(100, supportedScore - penalty));
};

const phoneIsWellFormed = (value: unknown): boolean => {
  const phone = text(value);
  if (!phone || !/^\+?[\d().\-\s]+$/u.test(phone)) return false;
  const digits = phone.replace(/\D/gu, '');
  return digits.length >= 7 && digits.length <= 15;
};

/**
 * Deterministic, fail-closed phone confidence from persisted channel evidence.
 * A canonical phone needs both a well-formed value and structured-field provenance;
 * free text alone cannot satisfy the reachability threshold.
 */
export const derivePhoneConfidence = (
  record: Record<string, unknown>,
  config?: PhoneConfidenceConfigInput,
): number => {
  const phone = text(record.phone) || text(record.contact_phone);
  if (!phone) return 0;
  if (
    isAffirmativeFlag(record.dne_phone, { failClosed: true })
    || isAffirmativeFlag(record.phone_suppressed, { failClosed: true })
  ) return 0;

  const policy: PhoneConfidenceConfig = {
    weights: {
      ...DEFAULT_SCORE_PHONE_CONFIDENCE.weights,
      ...(config?.weights || {}),
    },
    penalties: {
      ...DEFAULT_SCORE_PHONE_CONFIDENCE.penalties,
      ...(config?.penalties || {}),
    },
  };
  const present = policy.weights.present;
  if (!phoneIsWellFormed(phone)) return present;

  const structuredSource = text(record.phone_source_kind).toLowerCase() === 'structured';
  const evidenceScore = present
    + policy.weights.well_formed
    + (structuredSource ? policy.weights.structured_source : 0);
  const cappedScore = structuredSource
    ? evidenceScore
    : Math.min(evidenceScore, policy.penalties.unstructured_maximum);
  return Math.max(0, Math.min(100, cappedScore));
};

const resolvedBuyerStatus = (value: unknown): boolean => (
  ['confirmed', 'likely', 'resolved'].includes(text(value).toLowerCase())
);

const confirmedAffiliation = (value: unknown): boolean => (
  ['confirmed', 'likely'].includes(text(value).toLowerCase())
);

const affirmative = (value: unknown): boolean => isAffirmativeFlag(value, {
  affirmativeAliases: ['confirmed', 'verified'],
});

const verifiedEmailStatus = (value: unknown): boolean => (
  ['valid', 'verified', 'deliverable'].includes(text(value).toLowerCase())
);

const positiveNumber = (value: unknown): boolean => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
};

const fieldValue = (record: Record<string, unknown>, fields: string[]): string => {
  for (const field of fields) {
    const value = text(record[field]);
    if (value) return value;
  }
  return '';
};

const durableLiteralSupport = (input: {
  observations: Observation[];
  fields: string[];
  value: string;
}): boolean => {
  const expected = input.value.toLowerCase();
  if (!expected) return false;
  return input.observations.some((observation) => (
    input.fields.includes(observation.predicate)
    && observation.provisional !== true
    && observation.support_status === 'literal_support'
    && Boolean(text(observation.source_id))
    && text(observation.value).toLowerCase() === expected
  ));
};

const roleIndicatesDecisionAuthority = (role: string): boolean => (
  /\b(owner|founder|principal|partner|chief|president|vice[ -]?president|vp|director|head|general manager|managing|executive)\b/iu.test(role)
);

export type BuyerEvidenceResolution = {
  status: string | null;
  name: string | null;
  affiliationStatus: string | null;
  role: string | null;
  source: 'legacy' | 'canonical' | null;
};

const domainFromValue = (value: unknown): string => {
  const raw = text(value).toLowerCase();
  if (!raw) return '';
  const candidate = raw.includes('://') ? raw : `https://${raw}`;
  try {
    return new URL(candidate).hostname.replace(/^www\./u, '');
  } catch {
    return '';
  }
};

const canonicalBuyerAffiliationConfirmed = (input: {
  record: Record<string, unknown>;
  buyerEmail: string;
  roleSupported: boolean;
}): boolean => {
  if (!input.roleSupported || !input.buyerEmail.includes('@')) return false;
  const buyerDomain = domainFromValue(input.buyerEmail.split('@').at(-1));
  const accountDomain = domainFromValue(fieldValue(input.record, ['domain', 'website', 'site_url']));
  return Boolean(buyerDomain && accountDomain && buyerDomain === accountDomain);
};

/**
 * Resolve a buyer from either legacy buyer fields or the durable canonical
 * decision-maker projection. Canonical affiliation requires a titled,
 * provider-backed person whose email domain matches the resolved account.
 */
export const resolveBuyerEvidenceFromRecord = (
  record: Record<string, unknown>,
): BuyerEvidenceResolution => {
  const observations = parseStoredObservations(record.observations_json);
  const legacyStatus = fieldValue(record, LEGACY_BUYER_STATUS_FIELDS).toLowerCase() || null;
  const legacyName = fieldValue(record, LEGACY_BUYER_NAME_FIELDS) || null;
  const legacyAffiliation = fieldValue(record, BUYER_AFFILIATION_FIELDS).toLowerCase() || null;
  const legacyRole = fieldValue(record, ['buying_center_role', 'buyer_role', 'named_buyer_role']) || null;

  if (legacyStatus && !resolvedBuyerStatus(legacyStatus)) {
    return {
      status: legacyStatus,
      name: legacyName,
      affiliationStatus: legacyAffiliation,
      role: legacyRole,
      source: 'legacy',
    };
  }
  if (legacyStatus && legacyName) {
    return {
      status: legacyStatus,
      name: legacyName,
      affiliationStatus: legacyAffiliation,
      role: legacyRole,
      source: 'legacy',
    };
  }

  const canonicalName = fieldValue(record, CANONICAL_CONTACT_NAME_FIELDS);
  const canonicalNameSupported = durableLiteralSupport({
    observations,
    fields: CANONICAL_CONTACT_NAME_FIELDS,
    value: canonicalName,
  });
  const canonicalResolved = Boolean(canonicalName)
    && canonicalNameSupported
    && (
      positiveNumber(record.decision_maker_confidence)
      || verifiedEmailStatus(record.email_verification_status)
    );
  if (!canonicalResolved) {
    return {
      status: legacyStatus,
      name: legacyName,
      affiliationStatus: legacyAffiliation,
      role: legacyRole,
      source: legacyStatus || legacyName || legacyAffiliation || legacyRole ? 'legacy' : null,
    };
  }

  const canonicalRole = fieldValue(record, BUYER_ROLE_FIELDS);
  const canonicalRoleSupported = durableLiteralSupport({
    observations,
    fields: BUYER_ROLE_FIELDS,
    value: canonicalRole,
  });
  const canonicalEmail = fieldValue(record, CANONICAL_CONTACT_EMAIL_FIELDS);
  const affiliationStatus = legacyAffiliation || (
    canonicalBuyerAffiliationConfirmed({
      record,
      buyerEmail: canonicalEmail,
      roleSupported: canonicalRoleSupported,
    }) ? 'confirmed' : null
  );

  return {
    status: 'confirmed',
    name: canonicalName,
    affiliationStatus,
    role: legacyRole || (canonicalRoleSupported ? canonicalRole : null),
    source: 'canonical',
  };
};

/**
 * Deterministic buyer confidence from named-person evidence already persisted on
 * a record. A name needs either an explicit resolved status or a primary-contact
 * projection with durable provider-backed literal support plus independent
 * resolution evidence. Unresolved contradictions distinguish a researched
 * decision-maker from an unverified contact string.
 */
export const deriveBuyerConfidence = (
  record: Record<string, unknown>,
  config?: BuyerConfidenceConfigInput,
): number => {
  const observations = parseStoredObservations(record.observations_json);
  const policy: BuyerConfidenceConfig = {
    weights: {
      ...DEFAULT_SCORE_BUYER_CONFIDENCE.weights,
      ...(config?.weights || {}),
    },
    penalties: {
      ...DEFAULT_SCORE_BUYER_CONFIDENCE.penalties,
      ...(config?.penalties || {}),
    },
  };
  const buyer = resolveBuyerEvidenceFromRecord(record);
  const buyerName = buyer.name || '';
  const nameFields = buyer.source === 'legacy'
    ? LEGACY_BUYER_NAME_FIELDS
    : CANONICAL_CONTACT_NAME_FIELDS;
  if (!buyerName) return 0;

  const buyerRole = fieldValue(record, BUYER_ROLE_FIELDS);
  const affiliation = fieldValue(record, BUYER_AFFILIATION_FIELDS);
  const authorityConfirmed = affirmative(record.local_buying_authority);
  const decisionAuthority = authorityConfirmed || roleIndicatesDecisionAuthority(buyerRole);
  const score =
    policy.weights.named
    + (durableLiteralSupport({ observations, fields: nameFields, value: buyerName })
      ? policy.weights.named_literal_support
      : 0)
    + (decisionAuthority ? policy.weights.decision_authority : 0)
    + (buyerRole && durableLiteralSupport({ observations, fields: BUYER_ROLE_FIELDS, value: buyerRole })
      ? policy.weights.role_literal_support
      : 0)
    + (confirmedAffiliation(affiliation) ? policy.weights.affiliation : 0)
    + (confirmedAffiliation(affiliation)
      && durableLiteralSupport({ observations, fields: BUYER_AFFILIATION_FIELDS, value: affiliation })
      ? policy.weights.affiliation_literal_support
      : 0);
  const openContradictions = detectContradictions({ record, observations })
    .filter((contradiction) => contradiction.status === 'open').length;
  const penalty = Math.min(
    policy.penalties.maximum_total,
    openContradictions * policy.penalties.open_contradiction,
  );
  return Math.max(0, Math.min(100, score - penalty));
};

const completeAddress = (record: Record<string, unknown>, address: string): boolean => {
  if (!address) return false;
  if (affirmative(record.address_normalized) || affirmative(record.address_normalised)) return true;
  if (text(record.formatted_address)) return true;
  return Boolean(
    /\d/u.test(address)
    && text(record.city)
    && text(record.state)
    && (text(record.postal_code) || text(record.zip)),
  );
};

const validatedAddress = (record: Record<string, unknown>): boolean => {
  const status = fieldValue(record, ['address_validation_status', 'address_verification_status']);
  return affirmative(record.address_validated)
    || affirmative(record.address_verified)
    || affirmative(record.address_cass_validated)
    || ['valid', 'verified', 'deliverable'].includes(status.toLowerCase());
};

/**
 * Derive a record-level mail confidence without using it to authorize mail
 * reachability. RDI is one independently observed delivery signal; a high score
 * additionally requires a complete normalized address and validation evidence.
 */
export const deriveMailConfidence = (
  record: Record<string, unknown>,
  config?: MailConfidenceConfigInput,
): number => {
  const address = fieldValue(record, ['mailing_address', 'address']);
  if (!address) return 0;
  const policy: MailConfidenceConfig = {
    weights: {
      ...DEFAULT_SCORE_MAIL_CONFIDENCE.weights,
      ...(config?.weights || {}),
    },
    penalties: {
      ...DEFAULT_SCORE_MAIL_CONFIDENCE.penalties,
      ...(config?.penalties || {}),
    },
  };
  const commercial = text(record.address_rdi).toLowerCase() === 'commercial';
  const score =
    policy.weights.address_present
    + (completeAddress(record, address) ? policy.weights.address_complete : 0)
    + (commercial ? policy.weights.commercial_delivery_indicator : 0)
    + (validatedAddress(record) ? policy.weights.validation_evidence : 0);
  const openContradictions = detectContradictions({
    record,
    observations: parseStoredObservations(record.observations_json),
  }).filter((contradiction) => contradiction.status === 'open').length;
  const penalty = Math.min(
    policy.penalties.maximum_total,
    openContradictions * policy.penalties.open_contradiction,
  );
  return Math.max(0, Math.min(100, score - penalty));
};

/** The persisted mail-ready field mirrors the existing commercial-RDI readiness evidence. */
export function deriveMailAddressReady(record: Record<string, unknown>): boolean {
  return Boolean(fieldValue(record, ['mailing_address', 'address']))
    && text(record.address_rdi).toLowerCase() === 'commercial';
}

export type ObservationStore = {
  account_id: string;
  snapshots: SourceSnapshot[];
  observations: Observation[];
  contradictions: Contradiction[];
  identity_resolution?: IdentityResolution | null;
  contract_version: string;
  generated_at: string;
};

const text = (v: unknown) => String(v ?? '').trim();

const EXCERPT_MAX = 2000;

export function excerptFromBody(body: unknown, maxLen = EXCERPT_MAX): string {
  const raw = String(body ?? '');
  if (!raw) return '';
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, maxLen)}…`;
}

/** Stable content hash for retrieval bodies (sha256 hex). Empty body → empty string. */
export function contentHashFromBody(body: unknown): string {
  const raw = String(body ?? '');
  if (!raw) return '';
  return createHash('sha256').update(raw).digest('hex');
}

/** True when record already carries a durable retrieval or observation trail. */
export function hasDurableEvidenceTrail(record: Record<string, unknown>): boolean {
  if (collectRetrievalSnapshots(record).some((s) => s.kind === 'retrieval')) return true;
  const obs = parseStoredObservations(record.observations_json);
  return obs.some((o) => o && !o.provisional && text(o.source_id) && !isWeakAuthoritySource(o.source_id));
}

export function parseJsonValue(raw: unknown): unknown {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseSnapshotList(raw: unknown): SourceSnapshot[] {
  const parsed = parseJsonValue(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((s) => s && typeof s === 'object' && text((s as SourceSnapshot).source_id || (s as SourceSnapshot).provider))
    .map((s) => compactSourceSnapshot(s as SourceSnapshot & { body?: unknown }));
}

/** Remove legacy inline bytes while retaining a verifiable hash and bounded display excerpt. */
export function compactSourceSnapshot(snapshot: SourceSnapshot & { body?: unknown }): SourceSnapshot {
  const body = snapshot.body == null ? '' : String(snapshot.body);
  const existingExcerpt = text(snapshot.excerpt);
  const excerpt = body ? excerptFromBody(body) : existingExcerpt ? excerptFromBody(existingExcerpt) : '';
  const hash = body
    ? contentHashFromBody(body)
    : text(snapshot.content_hash) || (excerpt ? contentHashFromBody(excerpt) : '');
  const { body: _body, excerpt: _excerpt, content_hash: _contentHash, ...rest } = snapshot;
  return {
    ...rest,
    ...(hash ? { content_hash: hash } : {}),
    ...(excerpt ? { excerpt } : {}),
  };
}

/** Snapshot history lives authoritatively in observations_json.snapshots. */
export function parseAuthoritativeSnapshots(raw: unknown): SourceSnapshot[] {
  const parsed = parseJsonValue(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  return parseSnapshotList((parsed as ObservationStore).snapshots);
}

/**
 * Merge all retrieval-history arrays on a record (source_snapshots_json,
 * retrieval_snapshots_json, last_retrieval_snapshot_json) into one list.
 * Never drops prior retrievals in favor of only last_*.
 */
export function collectRetrievalSnapshots(record: Record<string, unknown>): SourceSnapshot[] {
  const authoritative = parseAuthoritativeSnapshots(record.observations_json);
  if (authoritative.length > 0) return authoritative;
  let list: SourceSnapshot[] = [];
  for (const s of parseSnapshotList(record.retrieval_snapshots_json)) {
    list = appendSourceSnapshot(list, s);
  }
  for (const s of parseSnapshotList(record.source_snapshots_json)) {
    list = appendSourceSnapshot(list, s);
  }
  const last = parseLastRetrievalSnapshot(record.last_retrieval_snapshot_json);
  if (last) list = appendSourceSnapshot(list, last);
  return list;
}

/** Retrieval-kind (or unknown-kind with body) snapshots only — history list for policy. */
export function retrievalHistoryFromList(snaps: SourceSnapshot[]): SourceSnapshot[] {
  return (snaps || []).filter(
    (s) => s && (s.kind === 'retrieval' || s.kind === 'tool_failure' || (!s.kind && (s.content_hash || s.excerpt))),
  );
}

/** Latest retrieval is derived from the authoritative snapshot history. */
export function latestRetrievalSnapshot(record: Record<string, unknown>): SourceSnapshot | null {
  const history = retrievalHistoryFromList(collectRetrievalSnapshots(record));
  const successful = history.filter((snapshot) => snapshot.kind !== 'tool_failure');
  if (successful.length > 0) return successful[successful.length - 1];
  return history.length > 0 ? history[history.length - 1] : null;
}

export function parseStoredObservations(raw: unknown): Observation[] {
  const parsed = parseJsonValue(raw);
  if (!parsed) return [];
  if (Array.isArray(parsed)) {
    return parsed.filter((o) => o && typeof o === 'object' && text((o as Observation).evidence_id)) as Observation[];
  }
  if (typeof parsed === 'object' && Array.isArray((parsed as ObservationStore).observations)) {
    return ((parsed as ObservationStore).observations || []).filter(
      (o) => o && typeof o === 'object' && text(o.evidence_id),
    );
  }
  return [];
}

export function parseLastRetrievalSnapshot(raw: unknown): SourceSnapshot | null {
  const parsed = parseJsonValue(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const s = parsed as SourceSnapshot;
  if (!text(s.source_id) && !text(s.provider)) return null;
  return s;
}

/** Build a source snapshot from record intake fields. */
export function buildSourceSnapshotFromRecord(record: Record<string, unknown>): SourceSnapshot | null {
  const provider = text(record.source) || text(record.source_provider);
  if (!provider && !text(record.source_query) && !text(record.sourced_at)) return null;
  const sourceId =
    text(record.source_id) ||
    `src_${text(record._row_id || record.id || 'unknown')}_${provider || 'unknown'}`;
  return {
    source_id: sourceId,
    provider: provider || 'unknown',
    source: provider || 'unknown',
    query: text(record.source_query) || undefined,
    retrieved_at: text(record.sourced_at) || new Date().toISOString(),
    cost_usd: record.source_cost_usd != null ? Number(record.source_cost_usd) : null,
    freshness_hours: record.source_freshness_hours != null ? Number(record.source_freshness_hours) : null,
    body_ref: text(record.source_body_ref) || undefined,
    record_id: text(record._row_id || record.id) || undefined,
    kind: 'intake',
  };
}

/**
 * Immutable retrieval snapshot written when enrich/tool_call succeeds.
 * Shape: { source, retrieved_at, path, content_hash, excerpt, provider, ... }
 * content_hash is always set when body/excerpt material exists. Full bytes are
 * persisted by the write path in raw_content and are never embedded in a snapshot.
 * source_id is content-addressed when hash is available so identical retrievals dedupe.
 */
export function buildRetrievalSnapshot(input: {
  source: string;
  provider?: string;
  retrieved_at?: string;
  path?: string;
  body?: unknown;
  excerpt?: string;
  record_id?: string;
  step_id?: string;
  query?: string;
  cost_usd?: number | null;
  source_id?: string;
  body_ref?: string;
  raw_ref?: string;
  kind?: SourceSnapshot['kind'];
}): SourceSnapshot {
  const provider = text(input.provider) || text(input.source) || 'unknown';
  const source = text(input.source) || provider;
  const recordId = text(input.record_id) || 'unknown';
  const stepId = text(input.step_id);
  const path = text(input.path);
  const retrievedAt = text(input.retrieved_at) || new Date().toISOString();
  const bodyRaw = input.body != null ? String(input.body) : '';
  const excerptMaterial = text(input.excerpt) || bodyRaw;
  const excerpt = excerptMaterial ? excerptFromBody(excerptMaterial) : undefined;
  const hashMaterial = bodyRaw || excerpt || '';
  const contentHash = hashMaterial ? contentHashFromBody(hashMaterial) : undefined;
  const bodyRef = text(input.body_ref) || undefined;
  const rawRef = text(input.raw_ref) || bodyRef || undefined;
  const sourceId =
    text(input.source_id)
    || (contentHash
      ? `ret_${recordId}_${stepId || source}_${path || 'body'}_${contentHash.slice(0, 16)}`
      : `ret_${recordId}_${stepId || source}_${path || 'body'}_${retrievedAt}`);
  return {
    source_id: sourceId,
    provider,
    source,
    query: text(input.query) || undefined,
    retrieved_at: retrievedAt,
    cost_usd: input.cost_usd != null && Number.isFinite(Number(input.cost_usd)) ? Number(input.cost_usd) : null,
    content_hash: contentHash,
    body_ref: bodyRef,
    raw_ref: rawRef,
    record_id: recordId || undefined,
    step_id: stepId || undefined,
    path: path || undefined,
    excerpt: excerpt || undefined,
    kind: input.kind || 'retrieval',
  };
}

/** Append snapshot by source_id (idempotent); newest last. */
export function appendSourceSnapshot(
  existing: SourceSnapshot[] | unknown,
  snap: SourceSnapshot | null | undefined,
): SourceSnapshot[] {
  const list = Array.isArray(existing)
    ? existing.map((item) => compactSourceSnapshot(item as SourceSnapshot & { body?: unknown }))
    : parseSnapshotList(existing);
  if (!snap || !text(snap.source_id)) return list;
  const compact = compactSourceSnapshot(snap);
  const idx = list.findIndex((s) => text(s.source_id) === text(compact.source_id));
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...compact };
    return list;
  }
  list.push(compact);
  return list;
}

const SUPPORT_RANK: Record<SupportStatus, number> = {
  literal_support: 60,
  inferred: 40,
  conflicted: 30,
  stale: 20,
  unknown: 10,
  tool_failure: 5,
};

const isProvisional = (o: Observation | null | undefined): boolean => Boolean(o?.provisional);

/** Merge observations: same evidence_id keeps higher-support / durable / newer non-blank. */
export function mergeObservationLists(existing: Observation[], next: Observation[]): Observation[] {
  const map = new Map<string, Observation>();
  for (const o of existing || []) {
    if (!o?.evidence_id) continue;
    map.set(o.evidence_id, o);
  }
  for (const o of next || []) {
    if (!o?.evidence_id) continue;
    const prior = map.get(o.evidence_id);
    if (!prior) {
      map.set(o.evidence_id, o);
      continue;
    }
    // Durable (non-provisional) always beats provisional for the same evidence_id.
    if (isProvisional(o) && !isProvisional(prior)) continue;
    if (!isProvisional(o) && isProvisional(prior)) {
      map.set(o.evidence_id, o);
      continue;
    }
    const priorRank = SUPPORT_RANK[prior.support_status] ?? 0;
    const nextRank = SUPPORT_RANK[o.support_status] ?? 0;
    // Never let tool_failure replace a literal/inferred fact for the same id.
    if (o.support_status === 'tool_failure' && prior.support_status !== 'tool_failure') {
      continue;
    }
    // Prefer higher support; on tie prefer non-blank value and later observed_at.
    if (nextRank > priorRank) {
      map.set(o.evidence_id, o);
      continue;
    }
    if (nextRank < priorRank) continue;
    const priorBlank = prior.value === null || prior.value === undefined || prior.value === '';
    const nextBlank = o.value === null || o.value === undefined || o.value === '';
    if (priorBlank && !nextBlank) {
      map.set(o.evidence_id, o);
      continue;
    }
    if (!priorBlank && nextBlank) continue;
    if (text(o.observed_at) >= text(prior.observed_at)) {
      map.set(o.evidence_id, o);
    }
  }
  return [...map.values()];
}

/** Predicates that are singleton business facts (at most one canonical observation). */
const SINGLETON_PREDICATES = new Set([
  'business_name',
  'place_id',
  'address',
  'company_resolution',
  'is_a_business',
  'business_status',
  'vertical',
  'sub_vertical',
  'identity_confidence',
  'website',
  'site_text',
  'linkedin_company_url',
  'identity_unresolved',
  'google_place_id',
  'primary_type',
  'resolution_source',
  'resolution_reason',
]);

/**
 * Merge by predicate: durable non-provisional observations win over provisional
 * live rereads even when evidence_ids differ (policy rebuild vs enrich trail).
 * Multi-instance predicates (tool_failure, free-form) keep all evidence_ids.
 */
export function mergeObservationsPreferDurable(
  durable: Observation[],
  provisionalOrOther: Observation[],
): Observation[] {
  const byPredicate = new Map<string, Observation>();
  const multi: Observation[] = [];

  const considerSingleton = (o: Observation) => {
    const pred = text(o.predicate);
    const prior = byPredicate.get(pred);
    if (!prior) {
      byPredicate.set(pred, o);
      return;
    }
    // Prefer non-provisional.
    if (isProvisional(o) && !isProvisional(prior)) return;
    if (!isProvisional(o) && isProvisional(prior)) {
      byPredicate.set(pred, o);
      return;
    }
    // Prefer higher support.
    const priorRank = SUPPORT_RANK[prior.support_status] ?? 0;
    const nextRank = SUPPORT_RANK[o.support_status] ?? 0;
    if (nextRank > priorRank) {
      byPredicate.set(pred, o);
      return;
    }
    if (nextRank < priorRank) return;
    // Prefer snapshot-backed (has source_id).
    if (text(o.source_id) && !text(prior.source_id)) {
      byPredicate.set(pred, o);
      return;
    }
    if (!text(o.source_id) && text(prior.source_id)) return;
    // Prefer later observed_at.
    if (text(o.observed_at) >= text(prior.observed_at)) {
      byPredicate.set(pred, o);
    }
  };

  const take = (list: Observation[]) => {
    for (const o of list || []) {
      if (!o?.evidence_id) continue;
      const pred = text(o.predicate);
      if (!pred || !SINGLETON_PREDICATES.has(pred)) {
        multi.push(o);
        continue;
      }
      considerSingleton(o);
    }
  };

  // Seed with durable first so provisional cannot displace unless no durable.
  take(durable || []);
  take(provisionalOrOther || []);

  const winners = [...byPredicate.values()];
  return mergeObservationLists(winners, multi);
}

/**
 * Extract atomic observations from common public record fields.
 *
 * These are live mutable-field rereads. They are ALWAYS provisional unless
 * the caller has already written durable snapshot-backed observations. Policy
 * and classify paths must prefer stored observations / last_retrieval_snapshot
 * over these extracts.
 */
export function extractObservationsFromRecord(record: Record<string, unknown>): Observation[] {
  const now = new Date().toISOString();
  const accountId = text(record._row_id || record.id || 'unknown');
  const snap = buildSourceSnapshotFromRecord(record);
  const lastRet = latestRetrievalSnapshot(record);
  // Prefer retrieval snapshot id when present; intake snap is metadata-only.
  const sourceId = lastRet?.source_id || snap?.source_id;
  // Mutable rereads are provisional even when an intake snap exists — the snap
  // does not store field values. Only enrich-written observations are durable.
  const durableTrail = hasDurableEvidenceTrail(record);
  const out: Observation[] = [];

  const push = (
    predicate: string,
    value: unknown,
    support: SupportStatus,
    literal?: string,
    opts?: { provisional?: boolean; source_id?: string },
  ) => {
    if (value === null || value === undefined || value === '') return;
    out.push({
      evidence_id: `obs_${accountId}_${predicate}`,
      predicate,
      value,
      support_status: support,
      source_id: opts?.source_id || sourceId,
      literal_support: literal,
      observed_at: now,
      // Explicit provisional when no durable trail, or always for scalar reread.
      provisional: opts?.provisional ?? true,
    });
  };

  push('business_name', text(record.business_name) || text(record.name), 'literal_support', text(record.business_name));
  push('place_id', text(record.place_id), 'literal_support', text(record.place_id));
  push('address', text(record.address), 'literal_support', text(record.address));
  push('company_resolution', text(record.company_resolution), text(record.company_resolution) ? 'literal_support' : 'unknown');
  push('is_a_business', record.is_a_business, 'inferred');
  push('business_status', text(record.business_status), 'literal_support');
  push('vertical', text(record.vertical), text(record.classification_evidence) ? 'inferred' : 'unknown');
  push('sub_vertical', text(record.sub_vertical), 'inferred');
  push('identity_confidence', numOrNull(record.identity_confidence), 'inferred');
  push('website', text(record.website) || text(record.website_url), 'literal_support');

  // Prefer last retrieval excerpt for site_text when present
  // (immutable trail) over live site_text scalar.
  if (lastRet?.excerpt && (lastRet.path === 'markdown' || lastRet.path === 'site_text' || !lastRet.path || text(lastRet.step_id).includes('site') || text(lastRet.path).includes('site'))) {
    const excerpt = excerptFromBody(lastRet.excerpt, 400);
    push('site_text', excerpt, 'literal_support', excerpt, {
      provisional: false,
      source_id: lastRet.source_id,
    });
  } else {
    const siteText = text(record.site_text) || text(record.markdown);
    if (siteText) {
      const excerpt = excerptFromBody(siteText, 400);
      // Provisional when no retrieval snapshot backs the scalar.
      push('site_text', excerpt, 'literal_support', excerpt, {
        provisional: !durableTrail || !lastRet,
      });
    }
  }

  if (text(record.linkedin_company_url) || text(record.linkedin_url)) {
    push(
      'linkedin_company_url',
      text(record.linkedin_company_url) || text(record.linkedin_url),
      'literal_support',
      text(record.linkedin_company_url) || text(record.linkedin_url),
    );
  }

  if (text(record.company_resolution) === 'unresolvable') {
    push('identity_unresolved', true, 'literal_support', 'company_resolution=unresolvable');
  }

  // Tool failure must never invent a negative business fact.
  if (text(record.last_tool_error) || text(record.enrichment_error) || text(record.last_error)) {
    const err = text(record.last_tool_error) || text(record.enrichment_error) || text(record.last_error);
    push(
      'tool_failure',
      err,
      'tool_failure',
      'tool error preserved; not a negative business fact',
      { provisional: false },
    );
  }

  return out;
}

/**
 * Literal observations from successful enrich outputs (written at apply time).
 * Snapshot-backed and durable unless the source is model/fixture/self (weak
 * authority) — those are always provisional so they cannot be sole authority.
 * Call only after buildRetrievalSnapshot so source_id points at the retrieval.
 */
export function extractObservationsFromOutputs(input: {
  record: Record<string, unknown>;
  outputs: Record<string, unknown>;
  source_id?: string;
  step_id?: string;
  observed_at?: string;
  /** Provider / source / resolution_source labels — weak authority → provisional. */
  source?: string;
  provider?: string;
}): Observation[] {
  const now = text(input.observed_at) || new Date().toISOString();
  const accountId = text(input.record._row_id || input.record.id || 'unknown');
  const sourceId = text(input.source_id) || undefined;
  const stepId = text(input.step_id);
  const out: Observation[] = [];
  const outputs = input.outputs || {};
  const weak =
    isWeakAuthoritySource(input.source)
    || isWeakAuthoritySource(input.provider)
    || isWeakAuthoritySource(stepId)
    || isWeakAuthoritySource(outputs.resolution_source)
    || isWeakAuthoritySource((input.record as any)?.resolution_source);

  const push = (predicate: string, value: unknown, support: SupportStatus, literal?: string) => {
    if (value === null || value === undefined || value === '') return;
    out.push({
      evidence_id: stepId
        ? `obs_${accountId}_${stepId}_${predicate}`
        : `obs_${accountId}_${predicate}`,
      predicate,
      value,
      support_status: support,
      source_id: sourceId,
      literal_support: literal != null ? String(literal).slice(0, 500) : undefined,
      observed_at: now,
      // Durable only when not weak authority (model/fixture/self).
      provisional: weak,
    });
  };

  for (const [key, raw] of Object.entries(outputs)) {
    if (raw === null || raw === undefined || raw === '') continue;
    if (key === 'site_text' || key === 'markdown') {
      const excerpt = excerptFromBody(raw, 400);
      push(key === 'markdown' ? 'site_text' : key, excerpt, 'literal_support', excerpt);
      continue;
    }
    if (
      key === 'place_id'
      || key === 'google_place_id'
      || key === 'company_resolution'
      || key === 'business_name'
      || key === 'address'
      || key === 'website'
      || key === 'linkedin_company_url'
      || key === 'resolution_source'
      || key === 'resolution_reason'
      || key === 'primary_type'
    ) {
      push(key, raw, 'literal_support', String(raw).slice(0, 500));
      continue;
    }
    // Skip status / large opaque blobs as free-form predicates
    if (key.endsWith('_json') || key.endsWith('__status')) continue;
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      push(key, raw, 'literal_support', String(raw).slice(0, 200));
    }
  }

  return out;
}

export function buildToolFailureObservation(input: {
  record: Record<string, unknown>;
  step_id: string;
  error: string;
  source_id?: string;
  observed_at?: string;
}): Observation {
  const accountId = text(input.record._row_id || input.record.id || 'unknown');
  const stepId = text(input.step_id) || 'unknown_step';
  const err = text(input.error) || 'tool_failure';
  return {
    evidence_id: `obs_${accountId}_${stepId}_tool_failure`,
    predicate: 'tool_failure',
    value: err,
    support_status: 'tool_failure',
    source_id: text(input.source_id) || undefined,
    literal_support: `step=${stepId}; tool error preserved; not a negative business fact`,
    observed_at: text(input.observed_at) || new Date().toISOString(),
    provisional: false,
  };
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Detect simple field conflicts across observations + record scalars. */
export function detectContradictions(input: {
  record: Record<string, unknown>;
  observations?: Observation[];
}): Contradiction[] {
  const contradictions: Contradiction[] = [];
  const now = new Date().toISOString();
  const record = input.record || {};
  const obs = input.observations || extractObservationsFromRecord(record);

  // Explicit material contradiction flag from record.
  if (record.material_contradiction === true || record.material_contradiction === 1 || text(record.material_contradiction) === 'true') {
    contradictions.push({
      contradiction_id: `ctr_${text(record._row_id || 'x')}_material`,
      field: 'material_contradiction',
      values: [true],
      evidence_ids: obs.map((o) => o.evidence_id).slice(0, 5),
      status: 'open',
      noted_at: now,
    });
  }

  // Name vs alternate name conflict.
  const name = text(record.business_name) || text(record.name);
  const alt = text(record.alternate_name) || text(record.dba_name);
  if (name && alt && name.toLowerCase() !== alt.toLowerCase() && record.name_conflict) {
    contradictions.push({
      contradiction_id: `ctr_${text(record._row_id || 'x')}_name`,
      field: 'business_name',
      values: [name, alt],
      evidence_ids: obs.filter((o) => o.predicate === 'business_name').map((o) => o.evidence_id),
      status: 'open',
      noted_at: now,
    });
  }

  // Closed vs open business_status vs is_a_business.
  const status = text(record.business_status).toLowerCase();
  const isBiz = record.is_a_business;
  if ((status === 'permanently_closed' || status === 'closed') && (isBiz === true || isBiz === 1 || isBiz === 'yes')) {
    contradictions.push({
      contradiction_id: `ctr_${text(record._row_id || 'x')}_status_biz`,
      field: 'business_status',
      values: [status, isBiz],
      evidence_ids: obs
        .filter((o) => o.predicate === 'business_status' || o.predicate === 'is_a_business')
        .map((o) => o.evidence_id),
      status: 'open',
      noted_at: now,
    });
  }

  // Parse stored contradiction list if present.
  try {
    const raw = record.contradictions_json;
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        contradictions.push({
          contradiction_id: text(item.contradiction_id) || `ctr_stored_${contradictions.length}`,
          field: text(item.field) || 'unknown',
          values: Array.isArray(item.values) ? item.values : [item.value],
          evidence_ids: Array.isArray(item.evidence_ids) ? item.evidence_ids.map(String) : [],
          status: (item.status as Contradiction['status']) || 'open',
          noted_at: text(item.noted_at) || now,
        });
      }
    }
  } catch {
    /* ignore */
  }

  return contradictions;
}

/** Field-specific precedence: Places/place_id > LinkedIn company resolve > free text. */
export function resolveFieldWithPrecedence(input: {
  field: string;
  candidates: Array<{ value: unknown; source: string; evidence_ids?: string[]; authority?: number }>;
}): FieldResolution {
  const now = new Date().toISOString();
  const ranked = [...input.candidates]
    .filter((c) => c.value !== null && c.value !== undefined && c.value !== '')
    .sort((a, b) => {
      const auth = (x: typeof a) =>
        x.authority ??
        (x.source.includes('place') ? 100 : x.source.includes('linkedin') ? 70 : x.source.includes('model') ? 40 : 50);
      return auth(b) - auth(a);
    });
  if (!ranked.length) {
    return {
      field: input.field,
      value: null,
      evidence_ids: [],
      alternatives: [],
      resolver: 'unknown',
      unknowns: [input.field],
      resolved_at: now,
    };
  }
  const winner = ranked[0];
  const alternatives = ranked.slice(1).map((c) => ({
    value: c.value,
    evidence_ids: c.evidence_ids || [],
    reason: `lower_precedence_than:${winner.source}`,
  }));
  return {
    field: input.field,
    value: winner.value,
    evidence_ids: winner.evidence_ids || [],
    alternatives,
    resolver: winner.source.includes('model') ? 'model' : 'deterministic',
    resolved_at: now,
  };
}

export type FieldEvidenceResolution = {
  value: unknown;
  evidence_ids: string[];
  source: string;
  /** True when value came from mutable fields without durable snapshot/observation. */
  provisional: boolean;
  /**
   * 0–100 confidence derived from observation support when durable evidence exists.
   * null when no observation backs the field (never invent high confidence).
   */
  confidence?: number | null;
  /** Snapshot / source ids cited by observations (durable trail). */
  source_ids?: string[];
};

/** Map observation support_status → confidence band (fail closed for unknowns). */
export function confidenceFromSupportStatus(
  status: SupportStatus | string | undefined,
  provisional?: boolean,
): number {
  if (provisional) return 35;
  switch (status) {
    case 'literal_support':
      return 95;
    case 'inferred':
      return 70;
    case 'stale':
      return 45;
    case 'conflicted':
      return 25;
    case 'unknown':
      return 15;
    case 'tool_failure':
      return 0;
    default:
      return 40;
  }
}

/** Snapshot lookup used to detect weak-authority backing of an observation. */
function snapshotMapForRecord(record: Record<string, unknown>): Map<string, SourceSnapshot> {
  const map = new Map<string, SourceSnapshot>();
  for (const s of collectRetrievalSnapshots(record)) {
    if (text(s.source_id)) map.set(text(s.source_id), s);
  }
  return map;
}

function observationIsWeakAuthority(
  o: Observation,
  snaps: Map<string, SourceSnapshot>,
): boolean {
  if (isWeakAuthoritySource(o.source_id)) return true;
  const snap = text(o.source_id) ? snaps.get(text(o.source_id)) : undefined;
  if (snap && isWeakAuthoritySnapshot(snap)) return true;
  return false;
}

/**
 * Resolve a field preferring stored literal observations / retrieval snapshots
 * over inventing from blank mutable scalars. Mutable fallbacks are provisional.
 * Non-model durable observations beat model/fixture/self (even if those claim
 * non-provisional) so weak authority is never sole authority when alternatives exist.
 */
export function resolveFieldPreferringEvidence(input: {
  field: string;
  record: Record<string, unknown>;
  observations?: Observation[];
}): FieldEvidenceResolution {
  const field = text(input.field);
  const record = input.record || {};
  const obs = input.observations || parseStoredObservations(record.observations_json);
  const snaps = snapshotMapForRecord(record);

  // 1. Prefer durable non-provisional, non-weak-authority stored observations.
  if (obs.length) {
    const candidates = obs
      .filter((o) => o.predicate === field && o.support_status !== 'tool_failure')
      .filter((o) => o.value !== null && o.value !== undefined && o.value !== '');

    const durableStrong = candidates
      .filter((o) => !isProvisional(o) && !observationIsWeakAuthority(o, snaps))
      .sort((a, b) => (SUPPORT_RANK[b.support_status] ?? 0) - (SUPPORT_RANK[a.support_status] ?? 0));
    if (durableStrong[0]) {
      const source_ids = text(durableStrong[0].source_id) ? [text(durableStrong[0].source_id)] : [];
      return {
        value: durableStrong[0].value,
        evidence_ids: [durableStrong[0].evidence_id],
        source: 'stored_observation',
        provisional: false,
        confidence: confidenceFromSupportStatus(durableStrong[0].support_status, false),
        source_ids,
      };
    }

    // Durable-but-weak (model/fixture/self) — provisional authority only.
    const durableWeak = candidates
      .filter((o) => !isProvisional(o) && observationIsWeakAuthority(o, snaps))
      .sort((a, b) => (SUPPORT_RANK[b.support_status] ?? 0) - (SUPPORT_RANK[a.support_status] ?? 0));
    if (durableWeak[0]) {
      const source_ids = text(durableWeak[0].source_id) ? [text(durableWeak[0].source_id)] : [];
      return {
        value: durableWeak[0].value,
        evidence_ids: [durableWeak[0].evidence_id],
        source: 'stored_observation_weak_authority',
        provisional: true,
        confidence: confidenceFromSupportStatus(durableWeak[0].support_status, true),
        source_ids,
      };
    }

    // Stored provisional still preferred over fresh extract (inspectable trail).
    const provisionalStored = candidates
      .filter((o) => isProvisional(o))
      .sort((a, b) => (SUPPORT_RANK[b.support_status] ?? 0) - (SUPPORT_RANK[a.support_status] ?? 0));
    if (provisionalStored[0]) {
      const source_ids = text(provisionalStored[0].source_id)
        ? [text(provisionalStored[0].source_id)]
        : [];
      return {
        value: provisionalStored[0].value,
        evidence_ids: [provisionalStored[0].evidence_id],
        source: 'stored_observation_provisional',
        provisional: true,
        confidence: confidenceFromSupportStatus(provisionalStored[0].support_status, true),
        source_ids,
      };
    }
  }

  // 2. Snapshot excerpt for site_text / markdown style fields (immutable).
  // Prefer non-weak retrieval snapshots over model/fixture/self.
  if (field === 'site_text' || field === 'markdown') {
    const allSnaps = collectRetrievalSnapshots(record);
    const pickSnap = (preferStrong: boolean): SourceSnapshot | null => {
      const last = latestRetrievalSnapshot(record);
      const ordered = [
        ...(last ? [last] : []),
        ...[...allSnaps].reverse(),
      ];
      for (const s of ordered) {
        if (!s || s.kind === 'tool_failure') continue;
        if (!s.excerpt) continue;
        const siteLike =
          s.path === 'markdown'
          || s.path === 'site_text'
          || !s.path
          || text(s.step_id).includes('site')
          || text(s.path).includes('site');
        if (field === 'site_text' || field === 'markdown') {
          if (!siteLike && field === 'site_text' && last && s !== last) {
            // still accept body-bearing retrievals
          }
        }
        const weak = isWeakAuthoritySnapshot(s);
        if (preferStrong && weak) continue;
        if (!preferStrong && !weak) continue;
        return s;
      }
      return null;
    };
    const strong = pickSnap(true);
    if (strong) {
      return {
        value: strong.excerpt,
        evidence_ids: [strong.source_id],
        source: 'retrieval_snapshot',
        provisional: false,
        confidence: 90,
        source_ids: text(strong.source_id) ? [text(strong.source_id)] : [],
      };
    }
    const weakSnap = pickSnap(false);
    if (weakSnap) {
      return {
        value: weakSnap.excerpt,
        evidence_ids: [weakSnap.source_id],
        source: 'retrieval_snapshot_weak_authority',
        provisional: true,
        confidence: 35,
        source_ids: text(weakSnap.source_id) ? [text(weakSnap.source_id)] : [],
      };
    }
  }

  // 3. Fall back to extract from mutable fields — always provisional.
  const extracted = extractObservationsFromRecord(record);
  const hit = extracted.find((o) => o.predicate === field && o.support_status !== 'tool_failure');
  if (hit && hit.value !== null && hit.value !== undefined && hit.value !== '') {
    return {
      value: hit.value,
      evidence_ids: [hit.evidence_id],
      source: 'extracted_observation_provisional',
      provisional: true,
      confidence: confidenceFromSupportStatus(hit.support_status, true),
      source_ids: text(hit.source_id) ? [text(hit.source_id)] : [],
    };
  }

  const scalar = record[field];
  if (scalar !== null && scalar !== undefined && scalar !== '') {
    return {
      value: scalar,
      evidence_ids: [],
      source: 'record_scalar_provisional',
      provisional: true,
      confidence: null,
      source_ids: [],
    };
  }
  return {
    value: null,
    evidence_ids: [],
    source: 'unknown',
    provisional: true,
    confidence: null,
    source_ids: [],
  };
}

export function buildIdentityResolution(
  record: Record<string, unknown>,
  identityConfidenceConfig?: IdentityConfidenceConfigInput,
): IdentityResolution {
  const accountId = text(record._row_id || record.id || 'unknown');
  const placeId = text(record.place_id) || null;
  const companyRes = text(record.company_resolution) || null;
  const storedObs = parseStoredObservations(record.observations_json);
  const nameFromObs = resolveFieldPreferringEvidence({ field: 'business_name', record, observations: storedObs });
  const addrFromObs = resolveFieldPreferringEvidence({ field: 'address', record, observations: storedObs });
  const websiteFromObs = resolveFieldPreferringEvidence({ field: 'website', record, observations: storedObs });
  const nameRes = resolveFieldWithPrecedence({
    field: 'business_name',
    candidates: [
      { value: text(record.business_name), source: 'places_name', evidence_ids: placeId ? [`place:${placeId}`] : [], authority: 100 },
      {
        value: nameFromObs.value,
        source: nameFromObs.source === 'stored_observation' ? 'observation_literal' : 'observation',
        evidence_ids: nameFromObs.evidence_ids,
        authority: nameFromObs.source.startsWith('stored') ? 95 : 55,
      },
      { value: text(record.linkedin_company_name), source: 'linkedin_company', authority: 70 },
      { value: text(record.name), source: 'record_name', authority: 50 },
    ],
  });
  const addrRes = resolveFieldWithPrecedence({
    field: 'address',
    candidates: [
      { value: text(record.address), source: 'places_address', evidence_ids: placeId ? [`place:${placeId}`] : [], authority: 100 },
      {
        value: addrFromObs.value,
        source: addrFromObs.source === 'stored_observation' ? 'observation_literal' : 'observation',
        evidence_ids: addrFromObs.evidence_ids,
        authority: addrFromObs.source.startsWith('stored') ? 95 : 55,
      },
      { value: text(record.formatted_address), source: 'places_formatted', authority: 90 },
    ],
  });
  const websiteRes = resolveFieldWithPrecedence({
    field: 'website',
    candidates: [
      {
        value: websiteFromObs.value,
        source: websiteFromObs.source === 'stored_observation' ? 'observation_literal' : 'observation',
        evidence_ids: websiteFromObs.evidence_ids,
        authority: websiteFromObs.source.startsWith('stored') ? 95 : 55,
      },
      { value: text(record.website) || text(record.website_url), source: 'record_website', authority: 50 },
    ],
  });
  const placeRes = resolveFieldWithPrecedence({
    field: 'place_id',
    candidates: [
      { value: placeId, source: 'places_id', evidence_ids: placeId ? [`place:${placeId}`] : [], authority: 100 },
    ],
  });
  const resolutions = [nameRes, addrRes, websiteRes, placeRes];
  const identityConfidence = deriveIdentityConfidence({
    account_id: accountId,
    place_id: placeId,
    company_resolution: companyRes,
    resolutions,
    contract_version: EVIDENCE_CONTRACT_VERSION,
    generated_at: new Date().toISOString(),
  }, identityConfidenceConfig);
  return {
    account_id: accountId,
    place_id: placeId,
    company_resolution: companyRes,
    identity_confidence: identityConfidence,
    resolutions,
    contract_version: EVIDENCE_CONTRACT_VERSION,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Full observation store for inspectability / reproducibility.
 *
 * Default: **append** history — prior observations_json entries are preserved
 * via mergeObservationLists (by evidence_id). Live extracts only fill gaps /
 * update same evidence_id; they never wholesale replace prior history.
 *
 * Pass `rebuildObservations: true` (or record.rebuild_observations) to collapse
 * to durable-preferring singletons (explicit rebuild path only).
 */
export function buildObservationStore(
  record: Record<string, unknown>,
  opts?: {
    rebuildObservations?: boolean;
    identityConfidenceConfig?: IdentityConfidenceConfigInput;
  },
): ObservationStore {
  const accountId = text(record._row_id || record.id || 'unknown');
  const rebuild =
    opts?.rebuildObservations === true
    || record.rebuild_observations === true
    || record.rebuild_observations === 1
    || record.rebuild_observations === '1';

  // Preserve full retrieval history (retrieval_snapshots_json + source_snapshots + last_*).
  let snapshots = collectRetrievalSnapshots(record);
  const intake = buildSourceSnapshotFromRecord(record);
  if (intake) snapshots = appendSourceSnapshot(snapshots, intake);

  const storedObs = parseStoredObservations(record.observations_json);
  // Live mutable rereads are provisional and must not clobber durable stored obs.
  const extracted = extractObservationsFromRecord(record);
  // Append history by default; only collapse on explicit rebuild.
  const observations = rebuild
    ? mergeObservationsPreferDurable(storedObs, extracted)
    : mergeObservationLists(storedObs, extracted);
  const contradictions = detectContradictions({ record, observations });
  // Identity resolution must also see the durable-preferring observation set for resolution,
  // but the store itself keeps full history unless rebuild.
  const forIdentity = rebuild
    ? observations
    : mergeObservationsPreferDurable(storedObs, extracted);
  const identityRecord = {
    ...record,
    observations_json: JSON.stringify({ observations: forIdentity }),
  };
  return {
    account_id: accountId,
    snapshots,
    observations,
    contradictions,
    identity_resolution: buildIdentityResolution(identityRecord, opts?.identityConfidenceConfig),
    contract_version: EVIDENCE_CONTRACT_VERSION,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Build a record patch that persists retrieval evidence after enrich/tool apply.
 * Success: immutable snapshot + literal observations.
 * Failure: tool_failure observation only — never empty success overwriting good site_text.
 */
export function buildEnrichEvidencePatch(input: {
  record: Record<string, unknown>;
  step_id: string;
  step_config?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  provider?: string;
  usage?: Record<string, unknown> | null;
  error?: string | null;
  /** When true, treat as failed retrieval even if outputs partially present. */
  failed?: boolean;
  /** Persists full retrieval bytes while snapshots retain only a bounded excerpt. */
  storeRawContent?: (input: {
    content_hash: string;
    body: string;
    raw_ref?: string;
    source_provider?: string;
  }) => void;
}): Record<string, unknown> {
  const record = input.record || {};
  const stepId = text(input.step_id) || 'enrich';
  const recordId = text(record._row_id || record.id || 'unknown');
  const now = new Date().toISOString();
  const outputs = input.outputs || {};
  const failed = Boolean(input.failed) || Boolean(text(input.error));
  const action = text(input.step_config?.action).toLowerCase();
  const toolSpec = (input.step_config?.tool && typeof input.step_config.tool === 'object'
    ? input.step_config.tool
    : {}) as Record<string, unknown>;
  const toolName = Array.isArray(toolSpec.tools) && toolSpec.tools[0]
    ? text(toolSpec.tools[0])
    : text(toolSpec.server) || action || stepId;
  const provider = text(input.provider) || text(toolSpec.server) || (action === 'linkedin_company_resolution' ? 'places' : 'enrich');
  const costUsd = (() => {
    const u = input.usage || {};
    const n = Number((u as any).usd_cost);
    return Number.isFinite(n) ? n : null;
  })();

  // Preserve full prior history (both list columns + last_*).
  let snapshots = collectRetrievalSnapshots(record);
  const rebuild =
    record.rebuild_observations === true
    || record.rebuild_observations === 1
    || record.rebuild_observations === '1';
  const priorObs = parseStoredObservations(record.observations_json);
  let observations = priorObs;
  let lastSnap: SourceSnapshot | null = latestRetrievalSnapshot(record);

  if (failed) {
    const failObs = buildToolFailureObservation({
      record,
      step_id: stepId,
      error: text(input.error) || 'enrichment_tool_failure',
      observed_at: now,
    });
    observations = rebuild
      ? mergeObservationsPreferDurable(observations, [failObs])
      : mergeObservationLists(observations, [failObs]);
    const failSnap = buildRetrievalSnapshot({
      source: toolName || stepId,
      provider,
      step_id: stepId,
      record_id: recordId,
      retrieved_at: now,
      path: 'error',
      excerpt: text(input.error).slice(0, 500),
      cost_usd: costUsd,
      kind: 'tool_failure',
      source_id: `fail_${recordId}_${stepId}_${now}`,
    });
    snapshots = appendSourceSnapshot(snapshots, failSnap);
    // Do not set last_retrieval_snapshot to failure when a good retrieval already exists.
    if (!lastSnap || lastSnap.kind === 'tool_failure') {
      lastSnap = failSnap;
    }
  } else {
    // Prefer body-bearing outputs for the retrieval snapshot (site scrape markdown, etc.).
    const outputMap = (input.step_config?.output_map && typeof input.step_config.output_map === 'object'
      ? input.step_config.output_map
      : {}) as Record<string, string>;
    let bodyKey = '';
    let bodyVal: unknown = '';
    let path = '';
    for (const [outName, mapPath] of Object.entries(outputMap)) {
      if (outputs[outName] != null && String(outputs[outName]).trim() !== '') {
        bodyKey = outName;
        bodyVal = outputs[outName];
        path = text(mapPath) || outName;
        break;
      }
    }
    if (!bodyKey) {
      for (const key of ['site_text', 'markdown', 'body', 'content']) {
        if (outputs[key] != null && String(outputs[key]).trim() !== '') {
          bodyKey = key;
          bodyVal = outputs[key];
          path = key;
          break;
        }
      }
    }
    // LinkedIn / scalar-only success: snapshot resolution fields.
    if (!bodyKey) {
      const scalarParts: string[] = [];
      for (const key of ['company_resolution', 'place_id', 'business_name', 'address', 'website', 'resolution_source', 'resolution_reason']) {
        if (outputs[key] != null && String(outputs[key]).trim() !== '') {
          scalarParts.push(`${key}=${String(outputs[key]).slice(0, 120)}`);
        }
      }
      if (scalarParts.length) {
        bodyKey = 'resolution';
        bodyVal = scalarParts.join('; ');
        path = 'resolution';
      }
    }

    const hasMaterial = Boolean(bodyKey && bodyVal != null && String(bodyVal).trim() !== '');
    const hasOutputs = Object.keys(outputs).length > 0;

    if (hasMaterial || hasOutputs) {
      const bodyRaw = hasMaterial
        ? String(bodyVal)
        : JSON.stringify(
          Object.fromEntries(
            Object.entries(outputs).filter(([, v]) => v != null && String(v).trim() !== ''),
          ),
        );
      // Always write immutable snapshot BEFORE deriving observations (production-honest).
      const snap = buildRetrievalSnapshot({
        source: toolName || stepId,
        provider,
        step_id: stepId,
        record_id: recordId,
        retrieved_at: now,
        path: path || (hasMaterial ? bodyKey : 'outputs'),
        body: bodyRaw,
        query: text(record.website) || text(record.website_url) || text(record.source_query) || undefined,
        cost_usd: costUsd,
        kind: 'retrieval',
        raw_ref: text(record.website) || text(record.website_url) || undefined,
      });
      if (snap.content_hash && bodyRaw) {
        input.storeRawContent?.({
          content_hash: snap.content_hash,
          body: bodyRaw,
          raw_ref: snap.raw_ref,
          source_provider: provider,
        });
      }
      snapshots = appendSourceSnapshot(snapshots, snap);
      lastSnap = snap;
      const outObs = extractObservationsFromOutputs({
        record,
        outputs,
        source_id: snap.source_id,
        step_id: stepId,
        observed_at: now,
        source: toolName || stepId,
        provider,
      });
      // Append history by default — never wholesale replace prior observations.
      observations = rebuild
        ? mergeObservationsPreferDurable(observations, outObs)
        : mergeObservationLists(observations, outObs);
    }
  }

  const store: ObservationStore = {
    account_id: recordId,
    snapshots,
    observations,
    contradictions: detectContradictions({ record: { ...record, ...outputs }, observations }),
    identity_resolution: buildIdentityResolution({ ...record, ...outputs, observations_json: JSON.stringify({ observations }) }),
    contract_version: EVIDENCE_CONTRACT_VERSION,
    generated_at: now,
  };

  const patch: Record<string, unknown> = {
    observations_json: JSON.stringify(store),
    source_snapshots_json: '',
    retrieval_snapshots_json: '',
    last_retrieval_snapshot_json: '',
  };
  if (store.identity_resolution) {
    patch.identity_resolution_json = JSON.stringify(store.identity_resolution);
    patch.identity_confidence = store.identity_resolution.identity_confidence;
  }
  // Always persist contradictions_json (may be empty) so prior open conflicts are not silently dropped.
  patch.contradictions_json = JSON.stringify(store.contradictions || []);
  return patch;
}

/**
 * Drop blank output fields that would clobber prior non-blank record values.
 * Tool failure / empty success must never wipe good site_text (or similar).
 */
export function preservePriorNonBlankFields(input: {
  record: Record<string, unknown>;
  patch: Record<string, unknown>;
  /** Extra keys always allowed to write even if blank (status, errors). */
  allowBlankKeys?: string[];
}): Record<string, unknown> {
  const allow = new Set([
    'last_error',
    'retry_count',
    ...(input.allowBlankKeys || []),
  ]);
  const out: Record<string, unknown> = { ...input.patch };
  for (const [key, value] of Object.entries(out)) {
    if (allow.has(key) || key.endsWith('__status')) continue;
    const blank =
      value === null
      || value === undefined
      || (typeof value === 'string' && value.trim() === '');
    if (!blank) continue;
    const prior = input.record?.[key];
    const priorBlank =
      prior === null
      || prior === undefined
      || (typeof prior === 'string' && prior.trim() === '');
    if (!priorBlank) {
      delete out[key];
    }
  }
  return out;
}
