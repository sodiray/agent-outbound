import { readConfig } from '../lib/config.js';
import { getRecordRowId, isRecordScalarValue, makeRecordId, rowToRecordShape } from '../lib/record.js';
import { readToolCatalog } from '../lib/tool-catalog.js';
import { ensureRecordColumns, getRecordById, openListDb, upsertRecord } from '../runtime/db.js';
import { getMcpClient } from '../runtime/mcp.js';
import { loadTools, toolSpecNeedsMcp, type ToolSpec } from '../runtime/tools.js';
import {
  dedupValueFor,
  extractRowsFromToolResult,
  loadExistingDedupValues,
  mapStrategyRow,
  normalizeDedupKey,
} from './runner.js';

type PlaceRow = Record<string, unknown>;
type ExecutableTool = {
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

export type MatchConfidence = 'exact' | 'strong' | 'weak';

export type SingleLeadCandidate = {
  rank: number;
  confidence: MatchConfidence;
  name_overlap: number;
  name: string;
  address: string;
  website: string;
  phone: string;
  place_id: string;
  primary_type: string;
  business_status: string;
  user_rating_count: number;
};

export type AddSingleLeadResult = {
  status: 'dry_run' | 'inserted' | 'duplicate' | 'not_found';
  dry_run: boolean;
  query: string;
  requested_name: string;
  confidence: MatchConfidence | '';
  confidence_note: string;
  candidates: SingleLeadCandidate[];
  alternatives: SingleLeadCandidate[];
  record: Record<string, unknown> | null;
  dedup: {
    status: 'none' | 'existing';
    key: string;
    value: string;
    existing_row_id: string;
  };
};

const GOOGLE_MAPS_TEXT_TOOL: ToolSpec = {
  server: 'googlemaps',
  tools: ['MAPS_TEXT_SEARCH'],
};

const tokenizeName = (value: unknown) => (
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
);

const normalizedName = (value: unknown) => tokenizeName(value).join(' ');

const stringAt = (row: PlaceRow, key: string) => String(row?.[key] || '').trim();

const candidateNameFor = (row: PlaceRow) => (
  stringAt(row, 'business_name')
    || stringAt(row, 'name')
    || String((row?.displayName as Record<string, unknown> | undefined)?.text || '').trim()
);

const placeIdFor = (row: PlaceRow) => (
  stringAt(row, 'place_id')
    || stringAt(row, 'placeId')
    || stringAt(row, 'google_place_id')
    || stringAt(row, 'id')
);

const userRatingCountFor = (row: PlaceRow) => {
  const value = Number(row?.user_rating_count ?? row?.userRatingCount ?? 0);
  return Number.isFinite(value) ? value : 0;
};

const overlapScore = ({ requestedName, candidateName }: { requestedName: string; candidateName: string }) => {
  const requested = [...new Set(tokenizeName(requestedName))];
  const candidate = new Set(tokenizeName(candidateName));
  if (requested.length === 0) return 0;
  const hits = requested.filter((token) => candidate.has(token)).length;
  return hits / requested.length;
};

const confidenceFor = ({ requestedName, candidateName, overlap }: {
  requestedName: string;
  candidateName: string;
  overlap: number;
}): MatchConfidence => {
  if (normalizedName(requestedName) === normalizedName(candidateName)) return 'exact';
  if (overlap >= 0.67) return 'strong';
  return 'weak';
};

const rankedCandidatesFor = ({ rows, name }: { rows: PlaceRow[]; name: string }) => {
  const scored = rows.map((row, index) => {
    const candidateName = candidateNameFor(row);
    const overlap = overlapScore({ requestedName: name, candidateName });
    const website = stringAt(row, 'website') || stringAt(row, 'websiteUri');
    const ratingCount = userRatingCountFor(row);
    return {
      row,
      index,
      overlap,
      hasWebsite: website ? 1 : 0,
      ratingCount,
      confidence: confidenceFor({ requestedName: name, candidateName, overlap }),
    };
  });
  return scored.sort((left, right) => (
    (right.overlap - left.overlap)
      || (right.hasWebsite - left.hasWebsite)
      || (right.ratingCount - left.ratingCount)
      || (left.index - right.index)
  ));
};

const summarizeCandidate = ({
  ranked,
  rank,
}: {
  ranked: ReturnType<typeof rankedCandidatesFor>[number];
  rank: number;
}): SingleLeadCandidate => {
  const row = ranked.row;
  return {
    rank,
    confidence: ranked.confidence,
    name_overlap: Number(ranked.overlap.toFixed(2)),
    name: candidateNameFor(row),
    address: stringAt(row, 'address') || stringAt(row, 'formattedAddress'),
    website: stringAt(row, 'website') || stringAt(row, 'websiteUri'),
    phone: stringAt(row, 'phone') || stringAt(row, 'nationalPhoneNumber'),
    place_id: placeIdFor(row),
    primary_type: stringAt(row, 'primary_type') || stringAt(row, 'primaryType'),
    business_status: stringAt(row, 'business_status') || stringAt(row, 'businessStatus'),
    user_rating_count: ranked.ratingCount,
  };
};

const confidenceNoteFor = ({
  best,
  second,
}: {
  best: ReturnType<typeof rankedCandidatesFor>[number] | undefined;
  second: ReturnType<typeof rankedCandidatesFor>[number] | undefined;
}) => {
  if (!best) return 'No candidates returned.';
  const nearTie = Boolean(second && Math.abs(best.overlap - second.overlap) <= 0.1);
  const prefix = best.confidence === 'exact'
    ? 'exact name match'
    : best.confidence === 'strong'
      ? 'strong name-token overlap'
      : 'weak name-token overlap';
  return nearTie ? `${prefix}; near-tie candidates present` : prefix;
};

const ensureDynamicRecordColumns = ({ db, row }: { db: ReturnType<typeof openListDb>; row: PlaceRow }) => {
  const existing = new Set(
    db.prepare('PRAGMA table_info(records)').all().map((column: { name?: string }) => String(column.name || '')),
  );
  const columns = Object.keys(row || {})
    .filter((key) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key))
    .filter((key) => !existing.has(key))
    .filter((key) => isRecordScalarValue(row[key]))
    .map((key) => ({ name: key, type: 'TEXT' }));
  if (columns.length === 0) return;
  ensureRecordColumns({ db, columns });
};

const existingRecordForDedup = ({
  db,
  dedupKey,
  dedupValue,
}: {
  db: ReturnType<typeof openListDb>;
  dedupKey: string;
  dedupValue: string;
}) => {
  if (!dedupValue) return null;
  if (dedupKey === 'place_id') {
    return db.prepare('SELECT * FROM records WHERE google_place_id = ? LIMIT 1').get(dedupValue) || null;
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dedupKey)) return null;
  const columns = new Set(
    db.prepare('PRAGMA table_info(records)').all().map((column: { name?: string }) => String(column.name || '')),
  );
  if (!columns.has(dedupKey)) return null;
  return db.prepare(`SELECT * FROM records WHERE ${dedupKey} = ? LIMIT 1`).get(dedupValue) || null;
};

const recordSummary = (record: Record<string, unknown> | null) => {
  if (!record) return null;
  return {
    row_id: getRecordRowId(record),
    business_name: String(record.business_name || ''),
    address: String(record.address || ''),
    website: String(record.website || ''),
    phone: String(record.phone || ''),
    google_place_id: String(record.google_place_id || ''),
    source: String(record.source || ''),
    source_query: String(record.source_query || ''),
    sourced_at: String(record.sourced_at || ''),
  };
};

export const addSingleLead = async ({
  listDir,
  name,
  near = '',
  query = '',
  max = 5,
  dryRun = false,
}: {
  listDir: string;
  name: string;
  near?: string;
  query?: string;
  max?: number;
  dryRun?: boolean;
}): Promise<AddSingleLeadResult> => {
  const requestedName = String(name || '').trim();
  if (!requestedName) throw new Error('lead add requires --name.');

  const searchQuery = String(query || '').trim() || [requestedName, String(near || '').trim()].filter(Boolean).join(' ');
  const maxResults = Math.max(1, Math.floor(Number(max || 5)));
  const loaded = readConfig(listDir);
  if (loaded.errors.length > 0) throw new Error(`Invalid config: ${loaded.errors.join('; ')}`);

  const toolCatalog = readToolCatalog(listDir);
  const mcp = toolSpecNeedsMcp(GOOGLE_MAPS_TEXT_TOOL, { listDir }) ? await getMcpClient() : undefined;
  const resolvedTools = await loadTools(mcp, GOOGLE_MAPS_TEXT_TOOL, toolCatalog, { listDir });
  const toolEntries = Object.entries(resolvedTools);
  if (toolEntries.length === 0) {
    throw new Error('lead add: could not resolve googlemaps MAPS_TEXT_SEARCH. Check this list mcp.json and refresh tools.');
  }

  const [, toolDef] = toolEntries[0] as [string, ExecutableTool];
  const result = await toolDef.execute({
    query: searchQuery,
    max_results: maxResults,
    max_pages: 1,
    excluded_types: '',
  });
  const rows = extractRowsFromToolResult(result) as PlaceRow[];
  const outputMap = Array.isArray(loaded.config?.source?.strategies) && loaded.config.source.strategies.length > 0
    ? loaded.config.source.strategies[0]?.output_map || {}
    : {};
  const mappedRows = rows.map((row) => mapStrategyRow({ row, outputMap }) as PlaceRow);
  const ranked = rankedCandidatesFor({ rows: mappedRows, name: requestedName });
  const candidates = ranked.map((candidate, index) => summarizeCandidate({ ranked: candidate, rank: index + 1 }));
  const best = ranked[0];
  const confidenceNote = confidenceNoteFor({ best, second: ranked[1] });

  if (!best) {
    return {
      status: 'not_found',
      dry_run: Boolean(dryRun),
      query: searchQuery,
      requested_name: requestedName,
      confidence: '',
      confidence_note: confidenceNote,
      candidates,
      alternatives: [],
      record: null,
      dedup: {
        status: 'none',
        key: 'place_id',
        value: '',
        existing_row_id: '',
      },
    };
  }

  if (dryRun) {
    return {
      status: 'dry_run',
      dry_run: true,
      query: searchQuery,
      requested_name: requestedName,
      confidence: best.confidence,
      confidence_note: confidenceNote,
      candidates,
      alternatives: candidates.slice(1),
      record: null,
      dedup: {
        status: 'none',
        key: 'place_id',
        value: candidates[0]?.place_id || '',
        existing_row_id: '',
      },
    };
  }

  const dedupKey = normalizeDedupKey('place_id');
  const bestRow = best.row;
  const dedupValue = dedupValueFor(bestRow, dedupKey);
  const db = openListDb({ listDir, readonly: false });
  try {
    const seen = loadExistingDedupValues({ db, dedupKey });
    const existing = seen.has(dedupValue)
      ? existingRecordForDedup({ db, dedupKey, dedupValue })
      : null;
    if (existing) {
      const existingRecord = existing as Record<string, unknown>;
      return {
        status: 'duplicate',
        dry_run: false,
        query: searchQuery,
        requested_name: requestedName,
        confidence: best.confidence,
        confidence_note: confidenceNote,
        candidates,
        alternatives: candidates.slice(1),
        record: recordSummary(existingRecord),
        dedup: {
          status: 'existing',
          key: dedupKey,
          value: dedupValue,
          existing_row_id: getRecordRowId(existingRecord),
        },
      };
    }

    const now = new Date().toISOString();
    const rowId = String(bestRow._row_id || bestRow.id || bestRow.place_id || bestRow.google_place_id || makeRecordId(bestRow));
    const stampedRow = {
      ...bestRow,
      _row_id: rowId,
      id: rowId,
      source: 'manual',
      sourced_at: now,
      source_query: searchQuery,
      sequence_status: 'idle',
      sequence_step: 0,
      extra_json: {
        ...(
          bestRow.extra_json && typeof bestRow.extra_json === 'object' && !Array.isArray(bestRow.extra_json)
            ? bestRow.extra_json as Record<string, unknown>
            : {}
        ),
        intake: 'manual',
      },
    };
    const recordShape = rowToRecordShape({
      listName: String(loaded.config?.list?.name || 'list'),
      row: stampedRow,
    });
    ensureDynamicRecordColumns({ db, row: recordShape });
    upsertRecord({ db, row: recordShape });
    const inserted = getRecordById({ db, id: getRecordRowId(recordShape) }) as Record<string, unknown> | null;

    return {
      status: 'inserted',
      dry_run: false,
      query: searchQuery,
      requested_name: requestedName,
      confidence: best.confidence,
      confidence_note: confidenceNote,
      candidates,
      alternatives: candidates.slice(1),
      record: recordSummary(inserted || recordShape),
      dedup: {
        status: 'none',
        key: dedupKey,
        value: dedupValue,
        existing_row_id: '',
      },
    };
  } finally {
    db.close();
  }
};
