import { appendFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { parallel } from 'radash';
import { ensureColumns, readCSV, writeCSV } from '../lib/csv.js';
import { readCache, writeCache, checkStaleness, hashDeps, recordRun } from '../lib/hash.js';
import { evaluateCondition } from '../actions/evaluate-condition.js';
import { executeStep } from '../actions/execute-step.js';
import { readYaml } from '../lib/yaml.js';
import { loadResolvedConfigFromOutbound, getDependsOnColumns, getOutputColumns } from '../enrichment/schema.js';
import { getStepRuntimeOverrides } from '../lib/step-runtime.js';
import { applyStepOutputs } from '../lib/step-outputs.js';
import { emitActivity } from '../lib/activity.js';
import { getSearchPagination, setSearchPagination, isSearchExhausted } from '../lib/search-state.js';
import {
  ensureCanonicalCsvExists,
  ensureRuntimeDirs,
  getCachePath,
  getCanonicalCsvPath,
  getSourcingLogPath,
  resolveVirtualPath,
  syncDestinations,
} from '../lib/runtime.js';

const normalizeValue = (value) =>
  String(value || '')
    .trim()
    .toLowerCase();

const normalizeKey = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const firstNonEmptyByAliases = (row, aliases) => {
  if (!row || typeof row !== 'object') return '';
  const aliasSet = new Set((aliases || []).map((item) => normalizeKey(item)).filter(Boolean));
  if (aliasSet.size === 0) return '';
  for (const [key, value] of Object.entries(row)) {
    if (!aliasSet.has(normalizeKey(key))) continue;
    const normalized = normalizeValue(value);
    if (normalized) return normalized;
  }
  return '';
};

const normalizeDomain = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    const withProtocol = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`;
    const host = new URL(withProtocol).hostname.toLowerCase().replace(/^www\./, '');
    return host;
  } catch {
    return raw
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
      .trim();
  }
};

const valueFingerprint = (row) => {
  const stable = Object.entries(row || {})
    .filter(([key, value]) => !key.startsWith('_') && String(value || '').trim() !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${normalizeValue(value)}`)
    .join('|');

  return createHash('sha256').update(stable).digest('hex');
};

const customDedupFingerprint = (row, dedupKeys) => {
  if (!Array.isArray(dedupKeys) || dedupKeys.length === 0) return '';
  const parts = [];
  for (const key of dedupKeys) {
    const column = String(key || '').trim();
    if (!column) continue;
    const value = normalizeValue(row?.[column]);
    if (!value) return '';
    parts.push(`${column}=${value}`);
  }
  if (parts.length === 0) return '';
  return createHash('sha256').update(parts.join('|')).digest('hex');
};

const dedupSignatures = (row, search) => {
  const signatures = [];
  const add = (signature) => {
    if (!signature) return;
    signatures.push(signature);
  };

  const custom = customDedupFingerprint(row, search?.dedup_keys);
  if (custom) add(`custom:${custom}`);

  const placeId = firstNonEmptyByAliases(row, ['place_id', 'google_place_id', 'googlePlaceId']);
  if (placeId) add(`place_id:${placeId}`);

  const domain = normalizeDomain(
    firstNonEmptyByAliases(row, ['domain', 'website', 'site', 'url'])
  );
  if (domain) add(`domain:${domain}`);

  const name = firstNonEmptyByAliases(row, ['business_name', 'name', 'company_name']);
  const address = firstNonEmptyByAliases(row, ['address', 'formatted_address', 'street_address']);
  if (name && address) add(`name_address:${name}|${address}`);

  add(`full:${valueFingerprint(row)}`);
  return [...new Set(signatures)];
};

const mergeRows = (current, incoming) => {
  const next = { ...current };
  let mergedFields = 0;
  for (const [key, value] of Object.entries(incoming || {})) {
    if (key === '_row_id') continue;
    if (String(next[key] || '').trim() === '' && String(value || '').trim() !== '') {
      next[key] = String(value);
      mergedFields += 1;
    }
  }
  return { row: next, mergedFields };
};

const extractCityFromAddress = (address) => {
  const parts = String(address || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return '';
  return parts[1];
};

const getCanonicalSearchFieldValue = ({ discoveredRecord, expectedField }) => {
  const expected = String(expectedField || '').trim();
  if (!expected) return '';

  const exact = String(discoveredRecord?.[expected] ?? '').trim();
  if (exact) return exact;

  const expectedKey = normalizeKey(expected);
  const aliasMap = {
    businessname: ['name', 'company_name', 'company', 'title'],
    address: ['formatted_address', 'street_address', 'location', 'vicinity'],
    googleplaceid: ['place_id', 'google_placeid', 'googleplaceid'],
    rating: ['google_review_rating', 'google_rating', 'review_rating'],
    reviewcount: ['google_review_count', 'user_ratings_total', 'userratingcount', 'rating_count', 'reviews_count'],
    phone: ['phone_number', 'formatted_phone_number', 'telephone'],
    website: ['website_url', 'url', 'site', 'domain'],
    city: ['locality', 'town', 'municipality'],
    category: ['type', 'types', 'primary_type', 'categories'],
  };

  const aliases = aliasMap[expectedKey] || [];
  for (const alias of aliases) {
    const normalizedAlias = normalizeKey(alias);
    for (const [rawKey, rawValue] of Object.entries(discoveredRecord || {})) {
      if (normalizeKey(rawKey) !== normalizedAlias) continue;
      const candidate = String(rawValue ?? '').trim();
      if (candidate) return candidate;
    }
  }

  if (expectedKey === 'city') {
    const fromAddress = extractCityFromAddress(discoveredRecord?.address || discoveredRecord?.formatted_address);
    if (fromAddress) return fromAddress;
  }

  return '';
};

export const runSourcing = async ({ listDir, limit, searchIndex }) => {
  ensureRuntimeDirs(listDir);
  ensureCanonicalCsvExists(listDir);

  const outboundConfig = readYaml(resolveVirtualPath({
    listDir,
    filePath: '@list/outbound.yaml',
    allowRelative: false,
  }));
  if (outboundConfig._raw) {
    throw new Error('Could not parse outbound.yaml.');
  }

  const searches = Array.isArray(outboundConfig.source?.searches) ? outboundConfig.source.searches : [];
  const selectedSearches = Number.isInteger(searchIndex)
    ? searches.filter((_, index) => index === searchIndex)
    : searches;

  const csvPath = getCanonicalCsvPath(listDir);
  const { headers: csvHeaders, rows } = readCSV(csvPath);

  let headers = ensureColumns(csvHeaders, [
    '_row_id',
    'source',
    'source_query',
    'sourced_at',
    'source_filter_result',
    'source_filter_failures',
  ]);

  const summary = {
    searches_total: selectedSearches.length,
    searches_run: [],
    found_total: 0,
    added_total: 0,
    deduped_total: 0,
    merged_fields_total: 0,
    filter_count: 0,
    filter_results: [],
    rows_passed_all_filters: 0,
    rows_failed_any_filter: 0,
    errors: [],
  };
  emitActivity({
    event: 'phase_start',
    phase: 'sourcing',
    searches: selectedSearches.length,
  });

  const newRowIds = new Set();

  // Run all searches in parallel (expensive LLM calls), then process results sequentially (dedup)
  const indexedSearches = selectedSearches.map((search, i) => ({ search, i }));
  const searchResults = await parallel(selectedSearches.length, indexedSearches, async ({ search, i }) => {
    const index = Number.isInteger(searchIndex) ? searchIndex : i;
    const searchId = String(search.id || `search_${index + 1}`);

    // Check if this search is exhausted (no more pages)
    if (isSearchExhausted(listDir, searchId)) {
      emitActivity({
        event: 'step_start',
        phase: 'sourcing_search',
        step: searchId,
        detail: 'exhausted — no more pages',
      });
      return { index, search, result: { status: 'skipped', rows: [] }, error: null, exhausted: true };
    }

    // Load stored pagination from previous runs
    const storedPagination = getSearchPagination(listDir, searchId);

    emitActivity({
      event: 'step_start',
      phase: 'sourcing_search',
      step: searchId,
      detail: storedPagination ? 'continuing from stored pagination' : 'first page',
    });

    try {
      const result = await executeStep({
        listDir,
        phase: 'sourcing_search',
        stepId: searchId,
        description: String(search.description || search.query || `search ${index + 1}`),
        stepConfig: search,
        row: {},
        context: {
          limit: limit == null ? null : Number(limit),
          expected_output_fields: Array.isArray(search.output_fields)
            ? search.output_fields.map((field) => String(field || '').trim()).filter(Boolean)
            : [],
          pagination: storedPagination,
        },
        ...getStepRuntimeOverrides(search),
      });

      // Store the pagination state returned by the sourcer
      const returnedPagination = result.pagination ?? null;
      setSearchPagination(listDir, searchId, returnedPagination);

      emitActivity({
        event: 'step_complete',
        phase: 'sourcing_search',
        step: searchId,
        detail: returnedPagination
          ? 'has more pages'
          : 'no more pages (exhausted)',
      });

      return { index, search, result, error: null };
    } catch (error) {
      emitActivity({
        event: 'error',
        phase: 'sourcing_search',
        step: searchId,
        detail: error.message,
      });
      return { index, search, result: null, error };
    }
  });

  // Process search results sequentially: normalize, dedup, enforce limit
  for (const { index, search, result, error, exhausted } of searchResults) {
    if (error) {
      summary.errors.push({ index, error: error.message });
      summary.searches_run.push({ index, query: String(search.query || ''), status: 'failed' });
      continue;
    }

    if (exhausted) {
      summary.searches_run.push({ index, query: String(search.query || ''), status: 'exhausted' });
      continue;
    }

    if (limit != null && summary.added_total >= Number(limit)) {
      summary.searches_run.push({ index, query: String(search.query || ''), status: 'skipped_limit' });
      continue;
    }

    const existingSignatureToIndex = new Map();
    const indexRowForSearch = (row, indexValue) => {
      for (const signature of dedupSignatures(row, search)) {
        if (!existingSignatureToIndex.has(signature)) {
          existingSignatureToIndex.set(signature, indexValue);
        }
      }
    };

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      indexRowForSearch(rows[rowIndex], rowIndex);
    }

    const discoveredRows = Array.isArray(result.rows) ? result.rows : [];
    const configuredOutputFields = Array.isArray(search.output_fields)
      ? search.output_fields.map((field) => String(field || '').trim()).filter(Boolean)
      : [];
    const expectedOutputFields = configuredOutputFields.includes('city')
      ? configuredOutputFields
      : (configuredOutputFields.includes('address')
        ? [...configuredOutputFields, 'city']
        : configuredOutputFields);
    let added = 0;
    let deduped = 0;

    for (const discovered of discoveredRows) {
      if (limit != null && summary.added_total >= Number(limit)) break;

      const discoveredRecord = Object.fromEntries(
        Object.entries(discovered || {})
          .map(([key, value]) => [String(key), String(value ?? '')])
      );
      const projectedRecord = expectedOutputFields.length > 0
        ? Object.fromEntries(
          expectedOutputFields.map((field) => [
            field,
            getCanonicalSearchFieldValue({
              discoveredRecord,
              expectedField: field,
            }),
          ])
        )
        : Object.fromEntries(
          Object.entries(discoveredRecord).filter(([, value]) => String(value || '').trim() !== '')
        );

      const nextRow = {
        _row_id: randomUUID(),
        ...projectedRecord,
        source: String(search.source || search.id || `search_${index + 1}`),
        source_query: String(search.query || search.description || ''),
        sourced_at: new Date().toISOString(),
      };

      headers = ensureColumns(headers, Object.keys(nextRow));

      const signatures = dedupSignatures(nextRow, search);
      const existingIndex = signatures
        .map((signature) => existingSignatureToIndex.get(signature))
        .find((indexValue) => Number.isInteger(indexValue));

      if (!Number.isInteger(existingIndex)) {
        rows.push(nextRow);
        indexRowForSearch(nextRow, rows.length - 1);
        newRowIds.add(nextRow._row_id);
        summary.added_total += 1;
        added += 1;
        continue;
      }

      const merged = mergeRows(rows[existingIndex], nextRow);
      rows[existingIndex] = merged.row;
      indexRowForSearch(merged.row, existingIndex);
      summary.merged_fields_total += merged.mergedFields;
      summary.deduped_total += 1;
      deduped += 1;
    }

    summary.found_total += discoveredRows.length;
    summary.searches_run.push({
      index,
      query: String(search.query || ''),
      found: discoveredRows.length,
      added,
      deduped,
      status: result.status === 'failed' ? 'failed' : 'completed',
    });
    emitActivity({
      event: 'step_complete',
      phase: 'sourcing_search',
      step: String(search.id || search.description || `search_${index + 1}`),
      found: discoveredRows.length,
      added,
      deduped,
    });
  }

  const resolvedConfig = loadResolvedConfigFromOutbound(listDir);
  const filterEntries = Object.entries(resolvedConfig.filters || {});
  summary.filter_count = filterEntries.length;

  if (filterEntries.length > 0 && rows.length > 0) {
    emitActivity({
      event: 'phase_start',
      phase: 'sourcing_filter',
      filters: filterEntries.length,
    });
    const cachePath = getCachePath(listDir);
    const cache = readCache(cachePath);
    const reevaluatedRowIds = new Set();

    for (const [filterName, filterConfig] of filterEntries) {
      emitActivity({
        event: 'step_start',
        phase: 'sourcing_filter',
        step: String(filterName),
      });
      const passedColumn = String(
        filterConfig?.writes?.passed_column || `filter_${String(filterName).replace(/^filter_/, '')}_passed`
      );
      const outputColumns = getOutputColumns(filterConfig);
      const dependsOnColumns = getDependsOnColumns(filterConfig);

      headers = ensureColumns(headers, [passedColumn, ...outputColumns]);

      const staleRows = [];
      for (const row of rows) {
        const { stale } = checkStaleness({
          row,
          rowId: row._row_id,
          sourceName: `filter:${filterName}`,
          dependsOn: dependsOnColumns,
          outputColumns: [...outputColumns, passedColumn],
          extraHashValues: [JSON.stringify(filterConfig || {})],
          cacheTTL: filterConfig.cache,
          cache,
        });
        if (stale) staleRows.push(row);
      }

      let processed = 0;
      let passed = 0;
      let failed = 0;

      await parallel(Number(filterConfig.concurrency || 10), staleRows, async (row) => {
        try {
          const result = await executeStep({
            listDir,
            phase: 'sourcing_filter',
            stepId: filterName,
            description: String(filterConfig.description || filterName),
            stepConfig: filterConfig,
            row,
            context: {
              condition: String(filterConfig.condition || ''),
            },
            ...getStepRuntimeOverrides(filterConfig),
          });

          headers = applyStepOutputs({
            row,
            stepConfig: filterConfig,
            stepOutputs: result.outputs,
            headers,
          });

          // Scope condition evaluation to only filter-relevant columns
          const filterOutputColumns = Object.values(filterConfig.columns || {}).map((c) => String(c));
          const conditionRow = {};
          for (const col of filterOutputColumns) {
            if (col in row) conditionRow[col] = row[col];
          }

          const decision = await evaluateCondition({
            conditionText: String(filterConfig.condition || ''),
            row: conditionRow,
            stepOutput: result.outputs,
          });

          row[passedColumn] = decision.passed ? 'true' : 'false';
          reevaluatedRowIds.add(row._row_id);

          if (!decision.passed) {
            failed += 1;
          } else {
            passed += 1;
          }
          emitActivity({
            event: 'row_complete',
            phase: 'sourcing_filter',
            step: String(filterName),
            row: String(row.business_name || row.name || row._row_id || ''),
            passed: decision.passed,
          });

          const depHash = hashDeps(row, dependsOnColumns, [JSON.stringify(filterConfig || {})]);
          recordRun(cache, row._row_id, `filter:${filterName}`, depHash);
          processed += 1;
        } catch (error) {
          row[passedColumn] = 'false';
          reevaluatedRowIds.add(row._row_id);
          failed += 1;
          processed += 1;
          summary.errors.push({ phase: 'filter', filter: filterName, row: row._row_id, error: error.message });
          emitActivity({
            event: 'error',
            phase: 'sourcing_filter',
            step: String(filterName),
            row: String(row.business_name || row.name || row._row_id || ''),
            detail: error.message,
          });
        }
      });

      summary.filter_results.push({
        filter: filterName,
        rows_processed: processed,
        rows_passed: passed,
        rows_failed: failed,
        rows_skipped: rows.length - staleRows.length,
      });
      emitActivity({
        event: 'step_complete',
        phase: 'sourcing_filter',
        step: String(filterName),
        processed,
        passed,
        failed,
      });
    }

    // Recompute aggregate filter result for ALL rows — filter set may have changed
    // (filter added/removed), so aggregates must reflect the current filter set
    const filterNames = filterEntries.map(([name]) => name);
    const passedColumnsByFilter = new Map(
      filterEntries.map(([name, config]) => [
        name,
        String(config?.writes?.passed_column || `filter_${String(name).replace(/^filter_/, '')}_passed`),
      ])
    );

    for (const row of rows) {
      const failures = filterNames.filter((name) => {
        const col = passedColumnsByFilter.get(name);
        return String(row[col] || '').trim().toLowerCase() !== 'true';
      });

      const newResult = failures.length === 0 ? 'passed' : 'failed';
      const oldResult = String(row.source_filter_result || '').trim();

      row.source_filter_failures = failures.join(',');
      row.source_filter_result = newResult;

      // Only count in summary if this row was re-evaluated or status changed
      if (reevaluatedRowIds.has(row._row_id) || newRowIds.has(row._row_id) || newResult !== oldResult) {
        if (newResult === 'passed') summary.rows_passed_all_filters += 1;
        else summary.rows_failed_any_filter += 1;
      }
    }

    writeCache(cachePath, cache);
  }

  writeCSV(csvPath, headers, rows);

  try {
    summary.destination_sync = await syncDestinations({
      listDir,
      outboundConfig,
      headers,
      rows,
    });
  } catch (error) {
    summary.destination_sync = { synced: false, error: error.message };
    summary.errors.push({ phase: 'destination_sync', error: error.message });
  }

  const logPath = getSourcingLogPath(listDir);
  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...summary })}\n`);
  emitActivity({
    event: 'phase_complete',
    phase: 'sourcing',
    found_total: summary.found_total,
    added_total: summary.added_total,
    rows_failed_any_filter: summary.rows_failed_any_filter,
    errors: summary.errors.length,
  });

  return summary;
};
