import { recordCostEvent } from '../../lib/costs.js';
import { getRecordRowId } from '../../lib/record.js';
import {
  syncPrimaryContactProjection,
  upsertContact,
  upsertRecord,
} from '../../runtime/db.js';
import { getEnv } from '../../runtime/env.js';
import {
  aiDedupLink,
  upsertRecordEmbedding,
} from '../../sourcing/dedup.js';
import {
  confirmResolution,
  parseCompanyFromHeadline,
} from '../../sourcing/linkedin.js';

const PLACES_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const PLACES_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.primaryType',
  'places.websiteUri',
  'places.formattedAddress',
  'places.userRatingCount',
].join(',');

type ResolutionDb = Parameters<typeof upsertRecord>[0]['db'];

type PlacesCandidate = {
  id: string;
  displayName: string;
  primaryType: string;
  websiteUri: string;
  formattedAddress: string;
  userRatingCount: number;
};

type DedupResult = Awaited<ReturnType<typeof aiDedupLink>>;

type LinkedinResolutionInput = {
  db: ResolutionDb;
  listDir: string;
  record: Record<string, unknown>;
  aiConfig?: Record<string, unknown>;
  identityFields?: string[];
  apiKey?: string;
  fetchImpl?: typeof fetch;
  dedupe?: typeof aiDedupLink;
};

const text = (value: unknown) => String(value || '').trim();

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const placesCandidateFrom = (value: unknown): PlacesCandidate => {
  const candidate = asRecord(value);
  const displayName = asRecord(candidate.displayName);
  const userRatingCount = Number(candidate.userRatingCount);
  return {
    id: text(candidate.id),
    displayName: text(displayName.text) || text(candidate.displayName),
    primaryType: text(candidate.primaryType),
    websiteUri: text(candidate.websiteUri),
    formattedAddress: text(candidate.formattedAddress),
    userRatingCount: Number.isFinite(userRatingCount) ? userRatingCount : 0,
  };
};

const queryPlaces = async ({
  company,
  city,
  apiKey,
  fetchImpl,
}: {
  company: string;
  city: string;
  apiKey: string;
  fetchImpl: typeof fetch;
}) => {
  if (!apiKey) {
    throw new Error('linkedin_company_resolution requires GOOGLE_MAPS_API_KEY.');
  }
  const response = await fetchImpl(PLACES_TEXT_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': PLACES_FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: [company, city].filter(Boolean).join(' '),
    }),
  });
  if (!response.ok) {
    const detail = text(await response.text());
    throw new Error(`Google Places text search failed (${response.status}): ${detail || 'empty response'}`);
  }
  const payload = asRecord(await response.json());
  const places = Array.isArray(payload.places) ? payload.places : [];
  return places.length > 0 ? placesCandidateFrom(places[0]) : null;
};

const attachLinkedinContact = ({
  db,
  record,
}: {
  db: ResolutionDb;
  record: Record<string, unknown>;
}) => {
  const recordId = getRecordRowId(record);
  upsertContact({
    db,
    contact: {
      record_id: recordId,
      full_name: text(record.linkedin_name),
      title: text(record.linkedin_headline),
      linkedin_urn: text(record.linkedin_urn),
      source: 'harvestapi',
      source_query: text(record.source_query),
      sourced_at: text(record.sourced_at) || new Date().toISOString(),
    },
  });
  syncPrimaryContactProjection({ db, recordId });
};

const quarantine = ({
  db,
  record,
  businessName = '',
  reason,
  candidateName = '',
  headToken = '',
}: {
  db: ResolutionDb;
  record: Record<string, unknown>;
  businessName?: string;
  reason: string;
  candidateName?: string;
  headToken?: string;
}) => {
  upsertRecord({
    db,
    row: {
      ...record,
      business_name: businessName || text(record.business_name),
      company_resolution: 'unresolvable',
      resolution_source: '',
      resolution_reason: reason,
      resolution_candidate_name: candidateName,
      resolution_head_token: headToken,
    },
  });
  return {
    status: 'unresolvable' as const,
    reason,
    candidate_name: candidateName,
    head_token: headToken,
  };
};

const exactPlaceDuplicate = ({
  db,
  recordId,
  placeId,
}: {
  db: ResolutionDb;
  recordId: string;
  placeId: string;
}) => {
  if (!placeId) return null;
  const candidate = db.prepare(`
    SELECT *
    FROM records
    WHERE _row_id != ?
      AND (place_id = ? OR google_place_id = ?)
    ORDER BY
      CASE WHEN COALESCE(duplicate_of, '') = '' THEN 0 ELSE 1 END,
      CASE
        WHEN lower(source) LIKE '%place%'
          OR lower(source) LIKE '%google%'
          OR lower(source) LIKE '%maps%'
        THEN 0 ELSE 1
      END,
      created_at ASC,
      _row_id ASC
    LIMIT 1
  `).get(recordId, placeId, placeId);
  if (!candidate) return null;
  const canonicalId = text(candidate.duplicate_of) || text(candidate._row_id);
  return canonicalId && canonicalId !== recordId ? canonicalId : null;
};

const writeResolvedRecord = ({
  db,
  record,
  company,
  candidate,
  duplicateOf,
  duplicateStatus,
  persist = true,
}: {
  db: ResolutionDb;
  record: Record<string, unknown>;
  company: string;
  candidate: PlacesCandidate;
  duplicateOf: string;
  duplicateStatus: string;
  persist?: boolean;
}) => {
  const resolved = {
    ...record,
    business_name: company,
    place_id: candidate.id,
    google_place_id: candidate.id,
    primary_type: candidate.primaryType,
    website: candidate.websiteUri,
    address: candidate.formattedAddress,
    user_rating_count: candidate.userRatingCount,
    company_resolution: 'resolved',
    resolution_source: 'places',
    resolution_reason: '',
    resolution_candidate_name: candidate.displayName,
    resolution_head_token: '',
    duplicate_of: duplicateOf,
    duplicate_status: duplicateStatus,
  };
  if (persist) upsertRecord({ db, row: resolved });
  return resolved;
};

const persistAiDedup = ({
  db,
  listDir,
  record,
  result,
}: {
  db: ResolutionDb;
  listDir: string;
  record: Record<string, unknown>;
  result: DedupResult;
}) => {
  const recordId = getRecordRowId(record);
  upsertRecord({
    db,
    row: {
      ...record,
      duplicate_of: result.duplicate_of || '',
      duplicate_status: result.duplicate_status || '',
    },
  });
  if (result.embedding && result.embedding.length > 0) {
    upsertRecordEmbedding({
      db,
      rowId: recordId,
      embedding: result.embedding,
      identityHash: result.identity_hash,
    });
  }
  recordCostEvent({
    db,
    listDir,
    recordId,
    stepId: 'sourcing:dedup',
    model: text(result.model),
    provider: text(result.provider),
    usage: result.usage || null,
  });
};

export const resolveLinkedinCompany = async ({
  db,
  listDir,
  record,
  aiConfig = {},
  identityFields = ['business_name', 'address'],
  apiKey = getEnv('GOOGLE_MAPS_API_KEY'),
  fetchImpl = fetch,
  dedupe = aiDedupLink,
}: LinkedinResolutionInput) => {
  if (text(record.company_resolution) === 'resolved') {
    return { status: 'already_resolved' as const, reason: '' };
  }

  attachLinkedinContact({ db, record });

  const parsed = parseCompanyFromHeadline(text(record.linkedin_headline));
  if (!parsed.company) {
    return quarantine({
      db,
      record,
      reason: parsed.reason,
    });
  }

  const candidate = await queryPlaces({
    company: parsed.company,
    city: text(record.city) || text(record.linkedin_location),
    apiKey,
    fetchImpl,
  });
  if (!candidate) {
    return quarantine({
      db,
      record,
      businessName: parsed.company,
      reason: 'absent from Places',
    });
  }

  const confirmation = confirmResolution({
    parsedCompany: parsed.company,
    candidateName: candidate.displayName,
  });
  if (!confirmation.confirmed) {
    return quarantine({
      db,
      record,
      businessName: parsed.company,
      reason: `rejected Places candidate "${candidate.displayName}": head token "${confirmation.headToken}" not found`,
      candidateName: candidate.displayName,
      headToken: confirmation.headToken,
    });
  }

  const recordId = getRecordRowId(record);
  const duplicateOf = exactPlaceDuplicate({
    db,
    recordId,
    placeId: candidate.id,
  });
  const resolved = writeResolvedRecord({
    db,
    record,
    company: candidate.displayName,
    candidate,
    duplicateOf: duplicateOf || '',
    duplicateStatus: duplicateOf ? 'confirmed' : '',
    persist: Boolean(duplicateOf),
  });
  if (duplicateOf) {
    return {
      status: 'resolved' as const,
      reason: '',
      place_id: candidate.id,
      duplicate_of: duplicateOf,
      dedupe: 'exact_place_id' as const,
    };
  }

  const dedupResult = await dedupe({
    db,
    row: resolved,
    identityFields,
    aiConfig,
  });
  persistAiDedup({
    db,
    listDir,
    record: resolved,
    result: dedupResult,
  });
  return {
    status: 'resolved' as const,
    reason: '',
    place_id: candidate.id,
    duplicate_of: dedupResult.duplicate_of || '',
    dedupe: 'ai' as const,
  };
};

export const executeLinkedinCompanyResolutionAction = async ({
  db,
  listDir,
  stepConfig,
  record,
  aiConfig,
  identityFields = [],
}: {
  db?: ResolutionDb;
  listDir: string;
  stepConfig: Record<string, unknown>;
  record: Record<string, unknown>;
  aiConfig?: Record<string, unknown>;
  identityFields?: string[];
}) => {
  if (!db) throw new Error('linkedin_company_resolution requires a database handle.');
  const args = asRecord(stepConfig.args);
  const configuredIdentityFields = Array.isArray(args.identity_fields)
    ? args.identity_fields.map(text).filter(Boolean)
    : [];
  const resolvedIdentityFields = configuredIdentityFields.length > 0
    ? configuredIdentityFields
    : identityFields.map(text).filter(Boolean);
  const result = await resolveLinkedinCompany({
    db,
    listDir,
    record,
    aiConfig,
    identityFields: resolvedIdentityFields.length > 0
      ? resolvedIdentityFields
      : ['business_name', 'address'],
  });

  // Re-read after resolve/quarantine so outputs reflect durable resolution fields
  // (immutable retrieval snapshot is written by the enrich runner from these).
  const recordId = getRecordRowId(record);
  const current = db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1').get(recordId, recordId)
    || record;
  const status = text((result as any)?.status);
  const outputs: Record<string, unknown> = {
    company_resolution: text(current.company_resolution) || (status === 'resolved' || status === 'already_resolved' ? 'resolved' : status === 'unresolvable' ? 'unresolvable' : ''),
    place_id: text(current.place_id) || text((result as any)?.place_id),
    business_name: text(current.business_name),
    address: text(current.address),
    website: text(current.website),
    resolution_source: text(current.resolution_source),
    resolution_reason: text(current.resolution_reason) || text((result as any)?.reason),
    primary_type: text(current.primary_type),
    google_place_id: text(current.google_place_id) || text(current.place_id),
  };

  return {
    outputs,
    usage: null,
    model: '',
    provider: 'places',
  };
};
