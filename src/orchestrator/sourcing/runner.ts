import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  clearSearchState,
  ensureRecordColumns,
  getSearchState,
  listPendingSearchTasks,
  logSourcingEvent,
  openListDb,
  upsertRecord,
  upsertSearchState,
  upsertSearchTask,
  updateSearchTaskResult,
} from '../runtime/db.js';
import { readConfig } from '../lib/config.js';
import { getRecordRowId, isRecordScalarValue, makeRecordId, rowToRecordShape, stableHash } from '../lib/record.js';
import { executeStepAction } from '../actions/execute-step/index.js';
import { emitActivity } from '../runtime/activity.js';
import { beginRun, tickProgress, endRun, heartbeat } from '../runtime/progress.js';
import { recordCostEvent } from '../lib/costs.js';
import { getMcpClient } from '../runtime/mcp.js';
import { aiDedupLink, buildIdentityHash, buildIdentityString, getIdentityFields, upsertRecordEmbedding } from './dedup.js';
import { embed } from '../runtime/embeddings.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { readToolCatalog } from '../lib/tool-catalog.js';
import { assertPhaseModelReferences } from '../lib/model-validation.js';
import { loadTools } from '../runtime/tools.js';

const toSearchRows = async ({
  mcp,
  listDir,
  search,
  toolCatalog,
  aiConfig,
  paginationState = null,
}: {
  mcp: any;
  listDir: string;
  search: any;
  toolCatalog: any;
  aiConfig: any;
  paginationState?: any;
}) => {
  const manual = Array.isArray(search?.manual_results) ? search.manual_results : [];
  if (manual.length > 0) return { rows: manual, usage: null, pagination: null, model: '', provider: '' };

  const toolSpec = search?.tool || {};
  const hasToolSpec = (Array.isArray(toolSpec?.tools) && toolSpec.tools.length > 0)
    || (Array.isArray(toolSpec?.toolkits) && toolSpec.toolkits.length > 0);
  if (!hasToolSpec) {
    throw new Error(`source.search: no tool configured for this search step (id="${String(search?.id || '').trim() || 'source_search'}").`);
  }

  const resolvedTools = await loadTools(mcp, toolSpec, toolCatalog, { listDir });
  const resolvedToolSlugs = Object.keys(resolvedTools);
  if (resolvedToolSlugs.length === 0) {
    const configuredTools = Array.isArray(toolSpec?.tools) ? toolSpec.tools.join(', ') : '';
    const configuredToolkits = Array.isArray(toolSpec?.toolkits) ? toolSpec.toolkits.join(', ') : '';
    throw new Error(
      `source.search: could not resolve a tool for this search step ` +
      `(tool="${configuredTools || configuredToolkits || 'unspecified'}"). Check the config's tool slug against connected toolkits.`,
    );
  }

  const context: any = {
    query: search?.query || '',
    max_results: Number(search?.max_results || 100),
    pagination_instructions:
      'Return a "pagination" field: an object representing your current position for fetching the next page, or null if no more results exist.',
  };
  if (paginationState) {
    context.pagination_state = paginationState;
    context.resume_instructions = 'Resume searching from the pagination_state position. Do not repeat earlier results.';
  }

  const result = await executeStepAction({
    mcp,
    listDir,
    stepId: search?.id || 'source_search',
    description: search?.description || search?.query || 'source search',
    stepConfig: {
      ...(search || {}),
      columns: {},
      tool: search?.tool || {},
      prompt_args: {
        query: search?.query || '',
      },
    },
    record: {},
    context,
    toolCatalog,
    aiConfig,
    role: 'research',
  });

  const rows = Array.isArray(result?.artifacts?.results)
    ? result.artifacts.results
    : Array.isArray(result?.outputs?.results)
      ? result.outputs.results
      : [];
  if (result?.defer) {
    throw new Error(`source.search: ${String(result?.reason || 'search step deferred')}`);
  }
  const toolCalls = Array.isArray(result?.usage?.tool_calls) ? result.usage.tool_calls : [];
  if (toolCalls.length === 0) {
    throw new Error(`source.search: no live tool was called for this search step (id="${String(search?.id || '').trim() || 'source_search'}").`);
  }

  return {
    rows,
    usage: result.usage || null,
    model: String((result as any)?.model || ''),
    provider: String((result as any)?.provider || ''),
    pagination: Object.prototype.hasOwnProperty.call(result, 'pagination')
      ? (result as any).pagination
      : undefined,
  };
};

const mapSearchRow = ({ row, outputMap }) => {
  const mapped = { ...row };
  for (const [sourceKey, targetKey] of Object.entries(outputMap || {})) {
    mapped[String(targetKey)] = row[sourceKey];
  }
  return mapped;
};

const readJsonFromListDir = (listDir: string, path: string) => {
  const rawPath = String(path || '').trim();
  if (!rawPath) throw new Error('source.strategy: missing JSON path.');
  const resolved = isAbsolute(rawPath) ? rawPath : join(listDir, rawPath);
  if (!existsSync(resolved)) throw new Error(`source.strategy: JSON file not found: ${resolved}`);
  return JSON.parse(readFileSync(resolved, 'utf8'));
};

const asStringArray = (value: any) => (
  Array.isArray(value)
    ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
    : []
);

const loadKeywords = ({ listDir, strategy }: { listDir: string; strategy: any }) => {
  if (Array.isArray(strategy?.keywords)) return asStringArray(strategy.keywords);
  const raw = readJsonFromListDir(listDir, strategy?.keywords_from);
  if (Array.isArray(raw)) return asStringArray(raw);
  if (raw && typeof raw === 'object' && Array.isArray(raw.types)) {
    return raw.types
      .map((entry: any) => String(entry?.keyword || '').trim())
      .filter(Boolean);
  }
  throw new Error('source.strategy keyword_geo keywords_from must be a string[] or { types: [{ keyword }] }.');
};

const loadGeos = ({ listDir, strategy }: { listDir: string; strategy: any }) => {
  if (Array.isArray(strategy?.geos)) return asStringArray(strategy.geos);
  return asStringArray(readJsonFromListDir(listDir, strategy?.geos_from));
};

const normalizeTile = (tile: any) => ({
  lat: Number(tile?.lat),
  lng: Number(tile?.lng),
  radius_m: Number(tile?.radius_m),
});

const GOOGLE_PLACES_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.businessStatus',
  'places.userRatingCount',
  'places.googleMapsUri',
  'places.location',
  'places.types',
  'places.primaryType',
].join(',');

const isGoogleMapsNearbyTask = ({ toolSpec }: { toolSpec: any }) => {
  const server = String(toolSpec?.server || '').trim().toLowerCase();
  const tools = Array.isArray(toolSpec?.tools) ? toolSpec.tools : [];
  const hasNearbyTool = tools.some((tool: any) => String(tool || '').trim().toUpperCase() === 'MAPS_NEARBY_SEARCH');
  return hasNearbyTool && (server === 'googlemaps' || server === 'maps');
};

const loadTiles = ({ listDir, strategy }: { listDir: string; strategy: any }) => {
  const raw = Array.isArray(strategy?.tiles)
    ? strategy.tiles
    : readJsonFromListDir(listDir, strategy?.tiles_from);
  if (!Array.isArray(raw)) throw new Error('source.strategy geo_tiles tiles_from must be a JSON array.');
  return raw.map(normalizeTile).filter((tile) => (
    Number.isFinite(tile.lat) && Number.isFinite(tile.lng) && Number.isFinite(tile.radius_m)
  ));
};

const taskIdFor = ({ kind, params }: { kind: string; params: any }) => (
  `search_task_${stableHash({ kind, params }).slice(0, 32)}`
);

export const expandSourceStrategies = ({ listDir, strategies }: { listDir: string; strategies: any[] }) => {
  const tasks: any[] = [];
  for (const strategy of strategies || []) {
    const kind = String(strategy?.kind || '');
    if (kind === 'keyword_geo') {
      const keywords = loadKeywords({ listDir, strategy });
      const geos = loadGeos({ listDir, strategy });
      for (const keyword of keywords) {
        for (const geo of geos) {
          const query = [keyword, geo].map((part) => String(part || '').trim()).filter(Boolean).join(' ');
          const params = {
            strategy_id: strategy?.id || '',
            tool: strategy?.tool || {},
            query,
            keyword,
            geo,
            max_results: Number(strategy?.max_results || 100),
            max_pages: Number(strategy?.max_pages || 1),
            excluded_types: Array.isArray(strategy?.excluded_types) ? strategy.excluded_types : [],
            output_map: strategy?.output_map || {},
          };
          tasks.push({ id: taskIdFor({ kind, params }), kind, params });
        }
      }
      continue;
    }
    if (kind === 'geo_tiles') {
      const tiles = loadTiles({ listDir, strategy });
      for (const tile of tiles) {
        const params = {
          strategy_id: strategy?.id || '',
          tool: strategy?.tool || {},
          lat: tile.lat,
          lng: tile.lng,
          radius_m: tile.radius_m,
          rank: strategy?.rank || 'distance',
          types: Array.isArray(strategy?.types) ? strategy.types : [],
          excluded_types: Array.isArray(strategy?.excluded_types) ? strategy.excluded_types : [],
          max_results: Number(strategy?.max_results || 100),
          output_map: strategy?.output_map || {},
        };
        tasks.push({ id: taskIdFor({ kind, params }), kind, params });
      }
    }
  }
  return tasks;
};

const valueAtPath = (row: any, path: string) => {
  const parts = String(path || '').split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.reduce((current, part) => (
    current === null || current === undefined ? undefined : current?.[part]
  ), row);
};

const mapStrategyRow = ({ row, outputMap }: { row: any; outputMap: Record<string, string> }) => {
  const mapped = { ...row };
  for (const [targetKey, sourcePath] of Object.entries(outputMap || {})) {
    const value = valueAtPath(row, sourcePath);
    if (value !== undefined) mapped[String(targetKey)] = value;
  }
  if (mapped.business_name === undefined && row?.displayName?.text !== undefined) mapped.business_name = row.displayName.text;
  if (mapped.address === undefined && row?.formattedAddress !== undefined) mapped.address = row.formattedAddress;
  if (mapped.phone === undefined && row?.nationalPhoneNumber !== undefined) mapped.phone = row.nationalPhoneNumber;
  if (mapped.website === undefined && row?.websiteUri !== undefined) mapped.website = row.websiteUri;
  if (mapped.business_status === undefined && row?.businessStatus !== undefined) mapped.business_status = row.businessStatus;
  if (mapped.user_rating_count === undefined && row?.userRatingCount !== undefined) mapped.user_rating_count = row.userRatingCount;
  if (mapped.primary_type === undefined && row?.primaryType !== undefined) mapped.primary_type = row.primaryType;
  if (!mapped.place_id && row?.placeId) mapped.place_id = row.placeId;
  if (!mapped.place_id && row?.id) mapped.place_id = row.id;
  if (!mapped.google_place_id && mapped.place_id) mapped.google_place_id = mapped.place_id;
  if (mapped.lat === undefined && row?.location?.lat !== undefined) mapped.lat = row.location.lat;
  if (mapped.lng === undefined && row?.location?.lng !== undefined) mapped.lng = row.location.lng;
  if (mapped.lat === undefined && row?.location?.latitude !== undefined) mapped.lat = row.location.latitude;
  if (mapped.lng === undefined && row?.location?.longitude !== undefined) mapped.lng = row.location.longitude;
  if (mapped.latitude === undefined && mapped.lat !== undefined) mapped.latitude = mapped.lat;
  if (mapped.longitude === undefined && mapped.lng !== undefined) mapped.longitude = mapped.lng;
  return mapped;
};

const extractRowsFromToolResult = (result: any) => {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.results)) {
    const rawPlaces = Array.isArray(result?.raw?.places) ? result.raw.places : [];
    if (rawPlaces.length === 0) return result.results;
    const rawById = new Map(rawPlaces.map((place: any) => [String(place?.id || '').trim(), place]));
    return result.results.map((row: any) => {
      const raw = rawById.get(String(row?.placeId || row?.place_id || row?.id || '').trim()) as any;
      return raw ? { ...raw, ...row } : row;
    });
  }
  if (Array.isArray(result?.data?.results)) return result.data.results;
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result?.data)) return result.data;
  return [];
};

const executeStrategyTask = async ({
  mcp,
  listDir,
  task,
  toolCatalog,
}: {
  mcp: any;
  listDir: string;
  task: any;
  toolCatalog: any;
}) => {
  const params = typeof task?.params === 'string' ? JSON.parse(task.params || '{}') : task.params || {};
  const toolSpec = params?.tool || {};
  const resolvedTools = await loadTools(mcp, toolSpec, toolCatalog, { listDir });
  const toolEntries = Object.entries(resolvedTools);
  if (toolEntries.length === 0) throw new Error(`source.strategy: no tool resolved for task ${task?.id || ''}.`);
  const [, toolDef] = toolEntries[0] as [string, any];
  const googleMapsNearby = task.kind === 'geo_tiles' && isGoogleMapsNearbyTask({ toolSpec });
  const args = task.kind === 'geo_tiles'
    ? {
      lat: params.lat,
      lng: params.lng,
      radius_m: params.radius_m,
      rank: params.rank || 'distance',
      types: Array.isArray(params.types) ? params.types.join(',') : params.types,
      excluded_types: Array.isArray(params.excluded_types) ? params.excluded_types.join(',') : params.excluded_types,
      max_results: Number(params.max_results || 100),
      ...(googleMapsNearby ? {
        field_mask: GOOGLE_PLACES_FIELD_MASK,
        fields: GOOGLE_PLACES_FIELD_MASK,
        raw: true,
      } : {}),
    }
    : {
      query: params.query || '',
      max_results: Number(params.max_results || 100),
      max_pages: Number(params.max_pages || 1),
      excluded_types: Array.isArray(params.excluded_types) ? params.excluded_types.join(',') : params.excluded_types,
    };
  const result = await toolDef.execute(args);
  return { rows: extractRowsFromToolResult(result), params };
};

const normalizeDedupKey = (dedupKey: string) => String(dedupKey || 'place_id').trim() || 'place_id';

const dedupValueFor = (row: any, dedupKey: string) => {
  const key = normalizeDedupKey(dedupKey);
  if (key === 'place_id') return String(row?.place_id || row?.placeId || row?.google_place_id || '').trim();
  return String(valueAtPath(row, key) ?? row?.[key] ?? '').trim();
};

export const dedupRowsByKey = ({
  rows,
  dedupKey = 'place_id',
  seen = new Set<string>(),
}: {
  rows: any[];
  dedupKey?: string;
  seen?: Set<string>;
}) => {
  const unique: any[] = [];
  let duplicates = 0;
  for (const row of rows || []) {
    const value = dedupValueFor(row, dedupKey);
    if (value && seen.has(value)) {
      duplicates += 1;
      continue;
    }
    if (value) seen.add(value);
    unique.push(row);
  }
  return { unique, duplicates, seen };
};

const loadExistingDedupValues = ({ db, dedupKey }: { db: any; dedupKey: string }) => {
  const key = normalizeDedupKey(dedupKey);
  const seen = new Set<string>();
  if (key === 'place_id') {
    const rows = db.prepare("SELECT google_place_id FROM records WHERE google_place_id != ''").all();
    for (const row of rows) seen.add(String(row.google_place_id || '').trim());
    return seen;
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) return seen;
  const columns = new Set(db.prepare('PRAGMA table_info(records)').all().map((row: any) => String(row.name || '')));
  if (!columns.has(key)) return seen;
  const rows = db.prepare(`SELECT ${key} AS value FROM records WHERE ${key} != ''`).all();
  for (const row of rows) seen.add(String(row.value || '').trim());
  return seen;
};

const strategyStatusFor = ({ kind, totalSeen, maxResults }: { kind: string; totalSeen: number; maxResults: number }) => {
  if (kind === 'geo_tiles') return totalSeen >= 20 ? 'saturated' : 'done';
  return totalSeen >= Number(maxResults || 100) ? 'capped' : 'done';
};

const refreshEmbeddingsAndLinks = async ({
  db,
  listDir,
  identityFields,
  aiConfig,
}: {
  db: any;
  listDir: string;
  identityFields: string[];
  aiConfig: any;
}) => {
  const refreshRows = db.prepare(`
    SELECT r.*, re.identity_hash
    FROM records r
    LEFT JOIN record_embeddings re ON re.row_id = r._row_id
  `).all();

  await mapWithConcurrency<any, void>(refreshRows as any[], async (row) => {
    const recordId = getRecordRowId(row);
    const identityText = buildIdentityString({ row, identityFields });
    const nextHash = buildIdentityHash({ row, identityFields });
    if (!identityText) return;
    if (String(row.identity_hash || '') === nextHash) return;
    const vector = await embed(identityText);
    if (vector.length === 0) return;
    upsertRecordEmbedding({
      db,
      rowId: recordId,
      embedding: vector,
      identityHash: nextHash,
    });
    const relink = await aiDedupLink({
      db,
      row: { ...row, _row_id: recordId },
      identityFields,
      aiConfig,
    });
    upsertRecord({
      db,
      row: {
        ...row,
        _row_id: recordId,
        id: recordId,
        duplicate_of: relink.duplicate_of || '',
        duplicate_status: relink.duplicate_status || '',
      },
    });
    recordCostEvent({
      db,
      listDir,
      recordId,
      stepId: 'sourcing:dedup_relink',
      model: String((relink as any)?.model || ''),
      provider: String((relink as any)?.provider || ''),
      usage: relink.usage || null,
    });

    const linkedChildren = db.prepare('SELECT * FROM records WHERE duplicate_of = ?').all(recordId);
    for (const child of linkedChildren) {
      const childRelink = await aiDedupLink({
        db,
        row: child,
        identityFields,
        aiConfig,
      });
      upsertRecord({
        db,
        row: {
          ...child,
          duplicate_of: childRelink.duplicate_of || '',
          duplicate_status: childRelink.duplicate_status || '',
        },
      });
    }
  }, 3);
};

const processAndInsertRows = async ({
  db,
  rows,
  identityFields,
  listName,
  listDir,
  aiConfig,
  limit = 0,
}: {
  db: any;
  rows: any[];
  identityFields: string[];
  listName: string;
  listDir: string;
  aiConfig: any;
  limit?: number;
}) => {
  const rowsToProcess = Number(limit || 0) > 0 ? rows.slice(0, Number(limit || 0)) : rows;
  const dynamicColumns = new Map<string, { name: string; type: string }>();
  const existingColumns = new Set(
    db.prepare('PRAGMA table_info(records)').all().map((column: any) => String(column.name || '')),
  );
  for (const row of rowsToProcess || []) {
    for (const key of Object.keys(row || {})) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
      if (existingColumns.has(key)) continue;
      if (!isRecordScalarValue(row[key])) continue;
      if (!dynamicColumns.has(key)) dynamicColumns.set(key, { name: key, type: 'TEXT' });
    }
  }
  if (dynamicColumns.size > 0) {
    ensureRecordColumns({ db, columns: [...dynamicColumns.values()] });
  }
  const insertedIds: string[] = [];
  const errors: string[] = [];
  let deduped = 0;
  let filtered = 0;

  await mapWithConcurrency<any, void>(rowsToProcess as any[], async (row) => {
    const id = getRecordRowId(row);

    try {
      const shape = rowToRecordShape({
        listName,
        row: {
          ...row,
          _row_id: id,
          id,
          sequence_status: 'idle',
          sequence_step: 0,
        },
      });

      const dedup = await aiDedupLink({
        db,
        row: shape,
        identityFields,
        aiConfig,
      });
      if (dedup.duplicate_of) {
        shape.duplicate_of = dedup.duplicate_of;
        shape.duplicate_status = dedup.duplicate_status;
        deduped += 1;
      }

      upsertRecord({ db, row: shape });
      if (!dedup.duplicate_of) {
        insertedIds.push(getRecordRowId(shape));
      }
      if (dedup.embedding && dedup.embedding.length > 0) {
        upsertRecordEmbedding({
          db,
          rowId: getRecordRowId(shape),
          embedding: dedup.embedding,
          identityHash: dedup.identity_hash,
        });
      }
      recordCostEvent({
        db,
        listDir,
        recordId: getRecordRowId(shape),
        stepId: 'sourcing:dedup',
        model: String((dedup as any)?.model || ''),
        provider: String((dedup as any)?.provider || ''),
        usage: dedup.usage || null,
      });
      emitActivity({ event: 'row_complete', phase: 'sourcing', row: shape.business_name || shape.id });
    } catch (error) {
      errors.push(String((error as any)?.message || error));
    }
  }, 3);

  return {
    rows_found: rowsToProcess.length,
    insertedIds,
    deduped,
    filtered,
    errors,
  };
};

const stableSearchId = (search: any) => {
  const explicit = String(search?.id || '').trim();
  if (explicit) return explicit;
  return `search_${stableHash({
    query: search?.query || '',
    description: search?.description || '',
    tool: search?.tool || {},
    args: search?.args || {},
  }).slice(0, 16)}`;
};

const searchConfigHash = (search: any) => stableHash({
  query: search?.query || '',
  description: search?.description || '',
  tool: search?.tool || {},
  args: search?.args || {},
  output_map: search?.output_map || {},
  max_results: Number(search?.max_results || 0),
});

const parsePaginationJson = (text: string) => {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const runSourcing = async ({ listDir, limit = 0 }) => {
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) {
    throw new Error(`Invalid config: ${errors.join('; ')}`);
  }
  assertPhaseModelReferences({ config, phase: 'source' });

  const listName = config?.list?.name || 'list';
  const searches = Array.isArray(config?.source?.searches) ? config.source.searches : [];
  const strategies = Array.isArray(config?.source?.strategies) ? config.source.strategies : [];
  const dedupKey = normalizeDedupKey(config?.source?.dedup_key || 'place_id');
  const maxCalls = config?.source?.budget?.max_calls === undefined
    ? null
    : Math.max(0, Number(config.source.budget.max_calls || 0));
  const db = openListDb({ listDir, readonly: false });
  const mcp = await getMcpClient();
  const toolCatalog = readToolCatalog(listDir);
  const identityFields = getIdentityFields(config);

  emitActivity({ event: 'phase_start', phase: 'sourcing', searches: searches.length, strategies: strategies.length });

  const summary: any = {
    searches_run: 0,
    strategies_expanded: 0,
    search_tasks_created: 0,
    search_tasks_run: 0,
    search_tasks_pending: 0,
    search_calls_made: 0,
    found_total: 0,
    inserted_total: 0,
    inserted_ids: [],
    deduped_total: 0,
    filtered_out: 0,
    errors: [],
  };

  const sourceTarget = (Array.isArray(searches) ? searches : []).reduce((sum: number, search: any) => sum + Number(search?.max_results || 0), 0);
  const runId = beginRun(db, { phase: 'sourcing', target: sourceTarget, message: 'Sourcing started' });

  try {
    await refreshEmbeddingsAndLinks({ db, listDir, identityFields, aiConfig: config?.ai || {} });

    const allRows = [];
    for (const search of searches) {
      const stepName = search?.id || search?.description || 'search';
      emitActivity({ event: 'step_start', phase: 'sourcing_search', step: stepName });
      tickProgress(db, runId, { activeStep: stepName, message: `Searching: ${stepName}`, done: summary.inserted_total });
      summary.searches_run += 1;
      const searchResult = await toSearchRows({
        mcp,
        listDir,
        search,
        toolCatalog,
        aiConfig: config?.ai || {},
      });
      recordCostEvent({
        db,
        listDir,
        stepId: `sourcing:${search?.id || 'search'}`,
        model: String((searchResult as any)?.model || ''),
        provider: String((searchResult as any)?.provider || ''),
        usage: searchResult.usage,
      });
      for (const row of searchResult.rows || []) {
        const mapped = mapSearchRow({ row, outputMap: search?.output_map || {} });
        mapped._row_id = mapped._row_id || mapped.id || makeRecordId(mapped);
        mapped.id = mapped._row_id;
        allRows.push(mapped);
      }
      const searchId = stableSearchId(search);
      const configHash = searchConfigHash(search);
      const pagination = Object.prototype.hasOwnProperty.call(searchResult, 'pagination')
        ? searchResult.pagination
        : undefined;
      const exhausted = pagination === null || pagination === undefined || (searchResult.rows || []).length === 0;
      upsertSearchState({
        db,
        searchId,
        configHash,
        paginationJson: JSON.stringify(pagination || {}),
        exhausted,
        lastResultCount: Number((searchResult.rows || []).length),
        totalResultsFetched: Number((searchResult.rows || []).length),
      });
      emitActivity({ event: 'step_complete', phase: 'sourcing_search', step: stepName, rows: searchResult.rows.length });
    }

    if (strategies.length > 0) {
      const tasks = expandSourceStrategies({ listDir, strategies });
      summary.strategies_expanded = strategies.length;
      summary.search_tasks_created = tasks.length;
      for (const task of tasks) {
        upsertSearchTask({ db, task });
      }

      const seenDedupValues = loadExistingDedupValues({ db, dedupKey });
      const pendingTasks = listPendingSearchTasks({ db });
      summary.search_tasks_pending = pendingTasks.length;
      tickProgress(db, runId, { stepTotal: pendingTasks.length, done: summary.inserted_total });
      let callsMade = 0;

      for (const task of pendingTasks) {
        if (maxCalls !== null && callsMade >= maxCalls) break;
        if (Number(limit || 0) > 0 && Number(summary.inserted_total || 0) >= Number(limit || 0)) break;
        callsMade += 1;
        summary.search_calls_made = callsMade;
        summary.search_tasks_run += 1;
        emitActivity({ event: 'step_start', phase: 'sourcing_task', step: task.id });
        tickProgress(db, runId, { stepIndex: summary.search_tasks_run, stepTotal: pendingTasks.length, activeStep: String(task.id), message: `Sourcing tile ${summary.search_tasks_run}/${pendingTasks.length}`, done: summary.inserted_total });

        try {
          const taskHeartbeat = setInterval(() => heartbeat(db, runId), 3000);
          const taskResult = await executeStrategyTask({
            mcp,
            listDir,
            task,
            toolCatalog,
          }).finally(() => clearInterval(taskHeartbeat));
          const rows = Array.isArray(taskResult.rows) ? taskResult.rows : [];
          const mappedRows = rows.map((row: any) => {
            const mapped = mapStrategyRow({ row, outputMap: taskResult.params?.output_map || {} });
            mapped._row_id = mapped._row_id || mapped.id || mapped.place_id || mapped.google_place_id || makeRecordId(mapped);
            mapped.id = mapped._row_id;
            return mapped;
          });
          const deduped = dedupRowsByKey({ rows: mappedRows, dedupKey, seen: seenDedupValues });
          summary.found_total += rows.length;
          summary.deduped_total += deduped.duplicates;

          const hasLimit = Number(limit || 0) > 0;
          const remaining = hasLimit
            ? Math.max(0, Number(limit || 0) - Number(summary.inserted_total || 0))
            : 0;
          if (hasLimit && remaining <= 0) {
            break;
          }
          const processed = await processAndInsertRows({
            db,
            rows: deduped.unique,
            identityFields,
            listName,
            listDir,
            aiConfig: config?.ai || {},
            limit: remaining,
          });
          summary.inserted_ids.push(...processed.insertedIds);
          summary.inserted_total += processed.insertedIds.length;
          tickProgress(db, runId, { done: summary.inserted_total });
          summary.deduped_total += processed.deduped;
          summary.filtered_out += processed.filtered;
          summary.errors.push(...processed.errors);

          const params = typeof task?.params === 'string' ? JSON.parse(task.params || '{}') : task.params || {};
          updateSearchTaskResult({
            db,
            id: task.id,
            status: strategyStatusFor({ kind: task.kind, totalSeen: rows.length, maxResults: Number(params?.max_results || 100) }),
            pagesFetched: task.kind === 'keyword_geo' ? Number(params?.max_pages || 1) : 1,
            totalSeen: rows.length,
            newUnique: processed.insertedIds.length,
          });
          emitActivity({ event: 'step_complete', phase: 'sourcing_task', step: task.id, rows: rows.length });
        } catch (error) {
          const message = String((error as any)?.message || error);
          summary.errors.push(message);
          updateSearchTaskResult({
            db,
            id: task.id,
            status: 'error',
            pagesFetched: 0,
            totalSeen: 0,
            newUnique: 0,
          });
          emitActivity({ event: 'error', phase: 'sourcing_task', step: task.id, message });
        }
      }
      summary.search_tasks_pending = listPendingSearchTasks({ db }).length;
    }

    if (allRows.length > 0 && !(Number(limit || 0) > 0 && Number(summary.inserted_total || 0) >= Number(limit || 0))) {
      summary.found_total += allRows.length;
      const legacyLimit = Number(limit || 0) > 0
        ? Math.max(0, Number(limit || 0) - Number(summary.inserted_total || 0))
        : 0;
      const processed = await processAndInsertRows({
        db,
        rows: allRows,
        identityFields,
        listName,
        listDir,
        aiConfig: config?.ai || {},
        limit: legacyLimit,
      });
      summary.inserted_ids.push(...processed.insertedIds);
      summary.inserted_total += processed.insertedIds.length;
      tickProgress(db, runId, { done: summary.inserted_total });
      summary.deduped_total += processed.deduped;
      summary.filtered_out += processed.filtered;
      summary.errors.push(...processed.errors);
    }

    logSourcingEvent({ listDir, payload: summary });
    emitActivity({
      event: 'phase_complete',
      phase: 'sourcing',
      found_total: summary.found_total,
      inserted_total: summary.inserted_total,
      filtered_out: summary.filtered_out,
      deduped_total: summary.deduped_total,
    });
    endRun(db, runId, { status: 'done', message: `Sourced ${summary.inserted_total} records` });
    return summary;
  } catch (error) {
    summary.errors.push(String((error as any)?.message || error));
    emitActivity({ event: 'error', phase: 'sourcing', message: String((error as any)?.message || error) });
    endRun(db, runId, { status: 'error', error: String((error as any)?.message || error) });
    throw error;
  } finally {
    db.close();
  }
};

export const runSourcingMore = async ({ listDir, targetNew = 0 }) => {
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) {
    throw new Error(`Invalid config: ${errors.join('; ')}`);
  }
  assertPhaseModelReferences({ config, phase: 'source' });

  const target = Math.max(0, Number(targetNew || 0));
  if (target <= 0) {
    return {
      status: 'ok',
      target_new: 0,
      inserted_total: 0,
      inserted_ids: [],
      searches_run: 0,
      exhausted_searches: [],
      deduped_total: 0,
      filtered_out: 0,
      errors: [],
    };
  }

  const listName = config?.list?.name || 'list';
  const searches = Array.isArray(config?.source?.searches) ? config.source.searches : [];
  const db = openListDb({ listDir, readonly: false });
  const mcp = await getMcpClient();
  const toolCatalog = readToolCatalog(listDir);
  const identityFields = getIdentityFields(config);

  const summary: any = {
    status: 'ok',
    target_new: target,
    inserted_total: 0,
    inserted_ids: [],
    searches_run: 0,
    exhausted_searches: [],
    deduped_total: 0,
    filtered_out: 0,
    errors: [],
  };

  const MAX_ITERATIONS = 5;

  emitActivity({ event: 'phase_start', phase: 'sourcing_more', target_new: target, searches: searches.length });

  const runId = beginRun(db, { phase: 'sourcing', target, message: `Sourcing ${target} additional leads` });

  try {
    await refreshEmbeddingsAndLinks({ db, listDir, identityFields, aiConfig: config?.ai || {} });

    for (const search of searches) {
      if (summary.inserted_total >= target) break;
      summary.searches_run += 1;
      const searchId = stableSearchId(search);
      tickProgress(db, runId, { activeStep: String(searchId), message: `Searching: ${searchId}`, done: summary.inserted_total });
      const configHash = searchConfigHash(search);
      const stored = getSearchState({ db, searchId });
      if (stored && String(stored.config_hash || '') !== configHash) {
        clearSearchState({ db, searchId });
      }
      const fresh = stored && String(stored.config_hash || '') === configHash ? stored : null;
      let paginationState = fresh ? parsePaginationJson(String(fresh.pagination_json || '{}')) : null;
      let exhausted = fresh ? Boolean(fresh.exhausted) : false;
      let totalFetched = fresh ? Number(fresh.total_results_fetched || 0) : 0;
      if (exhausted) {
        summary.exhausted_searches.push(searchId);
        continue;
      }

      for (let i = 0; i < MAX_ITERATIONS; i += 1) {
        if (summary.inserted_total >= target) break;

        const searchResult = await toSearchRows({
          mcp,
          listDir,
          search,
          toolCatalog,
          aiConfig: config?.ai || {},
          paginationState,
        });
        recordCostEvent({
          db,
          listDir,
          stepId: `sourcing_more:${searchId}`,
          model: String((searchResult as any)?.model || ''),
          provider: String((searchResult as any)?.provider || ''),
          usage: searchResult.usage,
        });

        const rows = Array.isArray(searchResult.rows) ? searchResult.rows : [];
        const mappedRows = rows.map((row: any) => {
          const mapped = mapSearchRow({ row, outputMap: search?.output_map || {} });
          mapped._row_id = mapped._row_id || mapped.id || makeRecordId(mapped);
          mapped.id = mapped._row_id;
          return mapped;
        });
        const remaining = Math.max(0, target - Number(summary.inserted_total || 0));
        const processed = await processAndInsertRows({
          db,
          rows: mappedRows,
          identityFields,
          listName,
          listDir,
          aiConfig: config?.ai || {},
          limit: remaining,
        });

        summary.inserted_ids.push(...processed.insertedIds);
        summary.inserted_total += processed.insertedIds.length;
        tickProgress(db, runId, { done: summary.inserted_total });
        summary.deduped_total += processed.deduped;
        summary.filtered_out += processed.filtered;
        summary.errors.push(...processed.errors);

        totalFetched += rows.length;
        const pagination = Object.prototype.hasOwnProperty.call(searchResult, 'pagination')
          ? searchResult.pagination
          : undefined;
        if (pagination === null || pagination === undefined || rows.length === 0) {
          exhausted = true;
        }
        paginationState = pagination === undefined ? null : pagination;

        upsertSearchState({
          db,
          searchId,
          configHash,
          paginationJson: JSON.stringify(paginationState || {}),
          exhausted,
          lastResultCount: rows.length,
          totalResultsFetched: totalFetched,
        });

        if (exhausted) {
          summary.exhausted_searches.push(searchId);
          break;
        }
      }
    }

    logSourcingEvent({ listDir, payload: { ...summary, mode: 'more' } });
    emitActivity({
      event: 'phase_complete',
      phase: 'sourcing_more',
      target_new: target,
      inserted_total: summary.inserted_total,
      exhausted_searches: summary.exhausted_searches,
    });
    endRun(db, runId, { status: 'done', message: `Sourced ${summary.inserted_total} new leads` });
    return summary;
  } catch (error) {
    summary.errors.push(String((error as any)?.message || error));
    emitActivity({ event: 'error', phase: 'sourcing_more', message: String((error as any)?.message || error) });
    endRun(db, runId, { status: 'error', error: String((error as any)?.message || error) });
    throw error;
  } finally {
    db.close();
  }
};
