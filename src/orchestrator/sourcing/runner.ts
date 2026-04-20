import { z } from 'zod';
import {
  clearSearchState,
  getSearchState,
  logSourcingEvent,
  openListDb,
  upsertRecord,
  upsertSearchState,
} from '../runtime/db.js';
import { readConfig } from '../lib/config.js';
import { getRecordRowId, makeRecordId, rowToRecordShape, stableHash } from '../lib/record.js';
import { executeStepAction } from '../actions/execute-step/index.js';
import { evaluateConditionAction } from '../actions/evaluate-condition/index.js';
import { emitActivity } from '../runtime/activity.js';
import { recordCostEvent } from '../lib/costs.js';
import { getMcpClient } from '../runtime/mcp.js';
import { aiDedupLink, buildIdentityHash, buildIdentityString, getIdentityFields, upsertRecordEmbedding } from './dedup.js';
import { embed } from '../runtime/embeddings.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { generateObjectWithTools } from '../runtime/llm.js';
import { readToolCatalog } from '../lib/tool-catalog.js';

const toSearchRows = async ({
  mcp,
  listDir,
  search,
  toolCatalog,
  paginationState = null,
}: {
  mcp: any;
  listDir: string;
  search: any;
  toolCatalog: any;
  paginationState?: any;
}) => {
  const manual = Array.isArray(search?.manual_results) ? search.manual_results : [];
  if (manual.length > 0) return { rows: manual, usage: null, pagination: null };

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
  });

  const rows = Array.isArray(result?.artifacts?.results)
    ? result.artifacts.results
    : Array.isArray(result?.outputs?.results)
      ? result.outputs.results
      : [];

  return {
    rows,
    usage: result.usage || null,
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

const SemanticFilterBatchSchema = z.object({
  results: z.array(z.object({
    row_id: z.string(),
    passed: z.boolean(),
    reason: z.string().default(''),
  })).default([]),
});

const chunk = <T>(items: T[], size: number): T[][] => {
  if (!Array.isArray(items) || items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

const asNumber = (value: any) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
};

const evaluateFieldCheck = ({ row, condition }: { row: any; condition: any }) => {
  const field = String(condition?.field || '').trim();
  const operator = String(condition?.operator || '').trim();
  const target = condition?.value;
  const actual = field ? row?.[field] : undefined;

  if (!field || !operator) {
    return { passed: false, reason: 'invalid_field_check_condition' };
  }

  if (operator === 'is_not_empty') {
    const passed = !(actual === null || actual === undefined || String(actual).trim() === '');
    return { passed, reason: passed ? '' : `${field} is empty` };
  }
  if (operator === 'is_empty') {
    const passed = actual === null || actual === undefined || String(actual).trim() === '';
    return { passed, reason: passed ? '' : `${field} is not empty` };
  }
  if (operator === 'contains') {
    const haystack = Array.isArray(actual)
      ? actual.map((v) => String(v).toLowerCase()).join(' ')
      : String(actual || '').toLowerCase();
    const needle = String(target || '').toLowerCase();
    const passed = needle ? haystack.includes(needle) : false;
    return { passed, reason: passed ? '' : `${field} does not contain "${needle}"` };
  }

  const leftNum = asNumber(actual);
  const rightNum = asNumber(target);
  const left = Number.isFinite(leftNum) && Number.isFinite(rightNum) ? leftNum : actual;
  const right = Number.isFinite(leftNum) && Number.isFinite(rightNum) ? rightNum : target;

  if (operator === 'eq') return { passed: left === right, reason: left === right ? '' : `${field} != expected value` };
  if (operator === 'neq') return { passed: left !== right, reason: left !== right ? '' : `${field} == unexpected value` };
  if (operator === 'gt') return { passed: Number(left) > Number(right), reason: Number(left) > Number(right) ? '' : `${field} is not greater than target` };
  if (operator === 'gte') return { passed: Number(left) >= Number(right), reason: Number(left) >= Number(right) ? '' : `${field} is not greater than or equal to target` };
  if (operator === 'lt') return { passed: Number(left) < Number(right), reason: Number(left) < Number(right) ? '' : `${field} is not less than target` };
  if (operator === 'lte') return { passed: Number(left) <= Number(right), reason: Number(left) <= Number(right) ? '' : `${field} is not less than or equal to target` };

  return { passed: false, reason: `unsupported_operator:${operator}` };
};

const evaluateSemanticFilterBatches = async ({
  db,
  listDir,
  filter,
  rows,
  batchSize = 10,
}: {
  db: any;
  listDir: string;
  filter: any;
  rows: any[];
  batchSize?: number;
}) => {
  const chunks = chunk(rows, Math.max(1, Number(batchSize || 10)));
  const results = new Map<string, { passed: boolean; reason: string }>();
  const filterId = String(filter?.id || 'filter');
  const description = String(filter?.description || '').trim();
  const conditionText = String(filter?.condition || '').trim();

  for (let i = 0; i < chunks.length; i += 1) {
    const batch = chunks[i];
    const systemPrompt = [
      'Evaluate this sourcing filter condition for each record.',
      'Return one result per row_id in the provided list.',
      '',
      `Filter description: ${description || '(none)'}`,
      `Filter condition: ${conditionText || '(none)'}`,
    ].join('\n');
    const userPrompt = [
      'Records:',
      JSON.stringify(batch.map((row) => ({
        row_id: String(getRecordRowId(row)),
        record: row,
      })), null, 2),
    ].join('\n');

    try {
      const llm = await generateObjectWithTools({
        task: `sourcing-filter-batch:${filterId}`,
        model: 'haiku',
        schema: SemanticFilterBatchSchema,
        prompt: userPrompt,
        systemPrompt,
        userPrompt,
        toolSpec: {},
        maxSteps: 2,
      });
      recordCostEvent({
        db,
        listDir,
        stepId: `sourcing_filter_batch:${filterId}`,
        model: 'haiku',
        usage: llm.usage,
      });
      const parsed = SemanticFilterBatchSchema.parse(llm.object);
      for (const item of parsed.results) {
        const rowId = String(item?.row_id || '').trim();
        if (!rowId) continue;
        results.set(rowId, {
          passed: Boolean(item?.passed),
          reason: String(item?.reason || ''),
        });
      }
    } catch (error) {
      for (const row of batch) {
        const rowId = String(getRecordRowId(row));
        try {
          const fallback = await evaluateConditionAction({
            conditionText,
            row,
            stepOutput: row,
          });
          recordCostEvent({
            db,
            listDir,
            recordId: rowId,
            stepId: `sourcing_filter:${filterId}`,
            model: 'haiku',
            usage: fallback.usage,
          });
          results.set(rowId, {
            passed: Boolean(fallback.passed),
            reason: String(fallback.reason || ''),
          });
        } catch {
          results.set(rowId, {
            passed: false,
            reason: String((error as any)?.message || error),
          });
        }
      }
    }
  }

  return results;
};

const refreshEmbeddingsAndLinks = async ({
  db,
  listDir,
  identityFields,
}: {
  db: any;
  listDir: string;
  identityFields: string[];
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
      model: 'haiku',
      usage: relink.usage || null,
    });

    const linkedChildren = db.prepare('SELECT * FROM records WHERE duplicate_of = ?').all(recordId);
    for (const child of linkedChildren) {
      const childRelink = await aiDedupLink({
        db,
        row: child,
        identityFields,
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
  filters,
  identityFields,
  listName,
  listDir,
  limit = 0,
}: {
  db: any;
  rows: any[];
  filters: any[];
  identityFields: string[];
  listName: string;
  listDir: string;
  limit?: number;
}) => {
  const rowsToProcess = Number(limit || 0) > 0 ? rows.slice(0, Number(limit || 0)) : rows;
  const filterStateByRow = new Map<string, {
    passes: boolean;
    failures: Array<{ id: string; description: string; reason: string }>;
  }>();
  for (const row of rowsToProcess) {
    const id = getRecordRowId(row);
    filterStateByRow.set(id, { passes: true, failures: [] });
  }

  for (const filter of filters) {
    const filterId = String(filter?.id || 'filter');
    const filterDesc = String(filter?.description || '').trim();
    const filterType = String(filter?.type || 'semantic').trim().toLowerCase();

    if (filterType === 'field_check') {
      const condition = (filter?.condition && typeof filter.condition === 'object' && !Array.isArray(filter.condition))
        ? filter.condition
        : null;
      if (!condition) continue;
      for (const row of rowsToProcess) {
        const id = getRecordRowId(row);
        const state = filterStateByRow.get(id);
        if (!state) continue;
        const evalResult = evaluateFieldCheck({ row, condition });
        if (!evalResult.passed) {
          state.passes = false;
          state.failures.push({
            id: filterId,
            description: filterDesc || JSON.stringify(condition),
            reason: String(evalResult.reason || 'failed'),
          });
        }
      }
      continue;
    }

    const conditionText = typeof filter?.condition === 'string'
      ? String(filter.condition || '').trim()
      : String(filterDesc || '').trim();
    if (!conditionText) continue;

    const semanticResults = await evaluateSemanticFilterBatches({
      db,
      listDir,
      filter: { ...filter, condition: conditionText },
      rows: rowsToProcess,
      batchSize: Number((filter as any)?.config?.batch_size || 10),
    });

    for (const row of rowsToProcess) {
      const id = getRecordRowId(row);
      const state = filterStateByRow.get(id);
      if (!state) continue;
      const outcome = semanticResults.get(id) || { passed: false, reason: 'no_result' };
      if (!outcome.passed) {
        state.passes = false;
        state.failures.push({
          id: filterId,
          description: filterDesc || conditionText,
          reason: String(outcome.reason || 'failed'),
        });
      }
    }
  }

  const insertedIds: string[] = [];
  const errors: string[] = [];
  let deduped = 0;
  let filtered = 0;

  await mapWithConcurrency<any, void>(rowsToProcess as any[], async (row) => {
    const id = getRecordRowId(row);
    const filterState = filterStateByRow.get(id) || { passes: true, failures: [] };
    const passes = Boolean(filterState.passes);
    const filterFailures = filterState.failures || [];

    try {
      const shape = rowToRecordShape({
        listName,
        row: {
          ...row,
          _row_id: id,
          id,
          source_filter_result: passes ? 'passed' : 'failed',
          source_filter_failures: filterFailures.length > 0 ? JSON.stringify(filterFailures) : '',
          sequence_status: 'idle',
          sequence_step: 0,
        },
      });

      if (!passes) filtered += 1;

      const dedup = await aiDedupLink({
        db,
        row: shape,
        identityFields,
      });
      if (dedup.duplicate_of) {
        shape.duplicate_of = dedup.duplicate_of;
        shape.duplicate_status = dedup.duplicate_status;
        deduped += 1;
      }

      upsertRecord({ db, row: shape });
      if (!dedup.duplicate_of && passes) {
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
        model: 'haiku',
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

  const listName = config?.list?.name || 'list';
  const searches = Array.isArray(config?.source?.searches) ? config.source.searches : [];
  const filters = Array.isArray(config?.source?.filters) ? config.source.filters : [];
  const db = openListDb({ listDir, readonly: false });
  const mcp = await getMcpClient();
  const toolCatalog = readToolCatalog(listDir);
  const identityFields = getIdentityFields(config);

  emitActivity({ event: 'phase_start', phase: 'sourcing', searches: searches.length });

  const summary: any = {
    searches_run: 0,
    found_total: 0,
    inserted_total: 0,
    inserted_ids: [],
    deduped_total: 0,
    filtered_out: 0,
    errors: [],
  };

  try {
    await refreshEmbeddingsAndLinks({ db, listDir, identityFields });

    const allRows = [];
    for (const search of searches) {
      const stepName = search?.id || search?.description || 'search';
      emitActivity({ event: 'step_start', phase: 'sourcing_search', step: stepName });
      summary.searches_run += 1;
      const searchResult = await toSearchRows({
        mcp,
        listDir,
        search,
        toolCatalog,
      });
      recordCostEvent({
        db,
        listDir,
        stepId: `sourcing:${search?.id || 'search'}`,
        model: String((search as any)?.model || 'sonnet'),
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

    summary.found_total = allRows.length;
    const processed = await processAndInsertRows({
      db,
      rows: allRows,
      filters,
      identityFields,
      listName,
      listDir,
      limit: Number(limit || 0),
    });
    summary.inserted_ids = processed.insertedIds;
    summary.inserted_total = processed.insertedIds.length;
    summary.deduped_total = processed.deduped;
    summary.filtered_out = processed.filtered;
    summary.errors.push(...processed.errors);

    logSourcingEvent({ listDir, payload: summary });
    emitActivity({
      event: 'phase_complete',
      phase: 'sourcing',
      found_total: summary.found_total,
      inserted_total: summary.inserted_total,
      filtered_out: summary.filtered_out,
      deduped_total: summary.deduped_total,
    });
    return summary;
  } catch (error) {
    summary.errors.push(String((error as any)?.message || error));
    emitActivity({ event: 'error', phase: 'sourcing', message: String((error as any)?.message || error) });
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
  const filters = Array.isArray(config?.source?.filters) ? config.source.filters : [];
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

  try {
    await refreshEmbeddingsAndLinks({ db, listDir, identityFields });

    for (const search of searches) {
      if (summary.inserted_total >= target) break;
      summary.searches_run += 1;
      const searchId = stableSearchId(search);
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
          paginationState,
        });
        recordCostEvent({
          db,
          listDir,
          stepId: `sourcing_more:${searchId}`,
          model: String((search as any)?.model || 'sonnet'),
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
          filters,
          identityFields,
          listName,
          listDir,
          limit: remaining,
        });

        summary.inserted_ids.push(...processed.insertedIds);
        summary.inserted_total += processed.insertedIds.length;
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
    return summary;
  } catch (error) {
    summary.errors.push(String((error as any)?.message || error));
    emitActivity({ event: 'error', phase: 'sourcing_more', message: String((error as any)?.message || error) });
    throw error;
  } finally {
    db.close();
  }
};
