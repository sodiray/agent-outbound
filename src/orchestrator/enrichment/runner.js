import { parallel } from 'radash';
import { ensureColumns, readCSV, writeCSV } from '../lib/csv.js';
import { readCache, writeCache, checkStaleness, hashDeps, recordRun } from '../lib/hash.js';
import { readYaml } from '../lib/yaml.js';
import { executeStep } from '../actions/execute-step.js';
import { evaluateCondition } from '../actions/evaluate-condition.js';
import {
  loadResolvedConfigFromOutbound,
  getDependsOnColumns,
  getOutputColumns,
} from './schema.js';
import {
  ensureCanonicalCsvExists,
  ensureRuntimeDirs,
  getCachePath,
  getCanonicalCsvPath,
  resolveVirtualPath,
  syncDestinations,
} from '../lib/runtime.js';
import { getStepRuntimeOverrides } from '../lib/step-runtime.js';
import { applyStepOutputs } from '../lib/step-outputs.js';
import { emitActivity } from '../lib/activity.js';
export { getEnrichmentStatus } from './status.js';

const parseRowRange = (rowRange) => {
  if (!rowRange) return null;
  const [startRaw, endRaw] = String(rowRange).split('-');
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
};

const shouldSkipRow = (row) => String(row.source_filter_result || '').trim().toLowerCase() === 'failed';

export const runEnrichment = async ({ listDir, sourceName, rowRange, concurrencyOverride }) => {
  ensureRuntimeDirs(listDir);
  ensureCanonicalCsvExists(listDir);

  const parsedConfig = loadResolvedConfigFromOutbound(listDir);
  const outboundConfig = readYaml(resolveVirtualPath({
    listDir,
    filePath: '@list/outbound.yaml',
    allowRelative: false,
  }));
  if (outboundConfig._raw) {
    throw new Error('Could not parse outbound.yaml.');
  }

  const csvPath = getCanonicalCsvPath(listDir);
  const cachePath = getCachePath(listDir);
  const cache = readCache(cachePath);

  const { headers: csvHeaders, rows: allRows } = readCSV(csvPath);
  let headers = csvHeaders;

  const range = parseRowRange(rowRange);
  const rows = range
    ? allRows.filter((_, index) => index >= range.start && index <= range.end)
    : allRows;

  const depOrder = parsedConfig.dependency_order.length > 0
    ? parsedConfig.dependency_order
    : [Object.keys(parsedConfig.sources || {})];

  const touchedRowIds = new Set();
  const failedRowIds = new Set();
  const summary = {
    sources_run: [],
    rows_total: rows.length,
    rows_enriched: 0,
    rows_skipped: 0,
    rows_failed: 0,
    rubric: undefined,
    errors: [],
  };
  const enrichmentStepCount = depOrder
    .map((level) => (Array.isArray(level) ? level.length : 1))
    .reduce((sum, count) => sum + count, 0);
  emitActivity({
    event: 'phase_start',
    phase: 'enrichment',
    steps: enrichmentStepCount,
    rows: rows.length,
  });

  for (const level of depOrder) {
    const levelSources = Array.isArray(level) ? level : [level];
    const sourcesToRun = sourceName
      ? levelSources.filter((name) => String(name) === String(sourceName))
      : levelSources;

    // Pre-ensure all output columns for this level before parallel execution
    for (const srcName of sourcesToRun) {
      const srcConfig = parsedConfig.sources[srcName];
      if (srcConfig) {
        headers = ensureColumns(headers, getOutputColumns(srcConfig));
      }
    }

    // Run all sources in this level in parallel — they are independent by definition
    await parallel(sourcesToRun.length, sourcesToRun, async (srcName) => {
      const srcConfig = parsedConfig.sources[srcName];
      if (!srcConfig) {
        summary.errors.push({ source: srcName, error: 'Source not found in config.' });
        emitActivity({
          event: 'error',
          phase: 'enrichment',
          step: String(srcName),
          detail: 'Source not found in config.',
        });
        return;
      }

      const outputColumns = getOutputColumns(srcConfig);
      const dependsOnColumns = getDependsOnColumns(srcConfig);

      const staleRows = [];
      for (const row of rows) {
        if (shouldSkipRow(row)) continue;

        const { stale } = checkStaleness({
          row,
          rowId: row._row_id,
          sourceName: srcName,
          dependsOn: dependsOnColumns,
          outputColumns,
          extraHashValues: [JSON.stringify(srcConfig || {})],
          cacheTTL: srcConfig.cache,
          cache,
        });

        if (stale) staleRows.push(row);
      }
      emitActivity({
        event: 'step_start',
        phase: 'enrichment',
        step: String(srcName),
        rows: staleRows.length,
        skipped: rows.length - staleRows.length,
      });

      let processed = 0;
      let failed = 0;
      const concurrency = Number(concurrencyOverride || srcConfig.concurrency || 10);

      await parallel(concurrency, staleRows, async (row) => {
        try {
          const result = await executeStep({
            listDir,
            phase: 'enrichment',
            stepId: srcName,
            description: String(srcConfig.description || srcName),
            stepConfig: srcConfig,
            row,
            ...getStepRuntimeOverrides(srcConfig),
          });

          applyStepOutputs({
            row,
            stepConfig: srcConfig,
            stepOutputs: result.outputs,
            headers,
          });

          const depHash = hashDeps(row, dependsOnColumns, [JSON.stringify(srcConfig || {})]);
          recordRun(cache, row._row_id, srcName, depHash);
          touchedRowIds.add(row._row_id);
          processed += 1;
          emitActivity({
            event: 'row_complete',
            phase: 'enrichment',
            step: String(srcName),
            row: String(row.business_name || row.name || row._row_id || ''),
            progress: `${processed}/${staleRows.length || 0}`,
          });
        } catch (error) {
          failed += 1;
          failedRowIds.add(row._row_id);
          summary.errors.push({
            source: srcName,
            row: row._row_id,
            error: error.message,
          });
          emitActivity({
            event: 'error',
            phase: 'enrichment',
            step: String(srcName),
            row: String(row.business_name || row.name || row._row_id || ''),
            detail: error.message,
          });
        }
      });

      summary.sources_run.push({
        source: srcName,
        processed,
        failed,
        skipped: rows.length - staleRows.length,
      });
      emitActivity({
        event: 'step_complete',
        phase: 'enrichment',
        step: String(srcName),
        processed,
        failed,
      });
    });
  }

  const shouldRunRubric = Boolean(parsedConfig.rubric) && (!sourceName || String(sourceName) === 'rubric');
  if (shouldRunRubric) {
    const rubric = parsedConfig.rubric;
    const criteria = Array.isArray(rubric.criteria) ? rubric.criteria : [];

    const scoreColumn = String(rubric.score_column || 'lead_score');
    const breakdownColumn = String(rubric.breakdown_column || 'lead_score_breakdown');
    const resultColumns = criteria.map((criterion, index) =>
      String(criterion?.config?.result_column || `rubric_${index + 1}`)
    );

    headers = ensureColumns(headers, [scoreColumn, breakdownColumn, ...resultColumns]);

    const dependsOnColumns = [...new Set(criteria.flatMap((criterion) => criterion?.config?.columns || []))];
    const rubricHash = [
      JSON.stringify({
        scoreColumn,
        breakdownColumn,
        criteria,
      }),
    ];

    const staleRubricRows = [];
    let skipped = 0;

    for (const row of rows) {
      if (shouldSkipRow(row)) {
        skipped += 1;
        continue;
      }

      const { stale } = checkStaleness({
        row,
        rowId: row._row_id,
        sourceName: 'rubric',
        dependsOn: dependsOnColumns,
        outputColumns: [scoreColumn, breakdownColumn, ...resultColumns],
        extraHashValues: rubricHash,
        cacheTTL: rubric.cache,
        cache,
      });

      if (!stale) {
        skipped += 1;
        continue;
      }

      staleRubricRows.push(row);
    }
    emitActivity({
      event: 'phase_start',
      phase: 'rubric',
      rows: staleRubricRows.length,
      criteria: criteria.length,
    });

    let processed = 0;
    let failed = 0;

    await parallel(10, staleRubricRows, async (row) => {
      try {
        // Evaluate all criteria for this row in parallel
        const indexedCriteria = criteria.map((criterion, i) => ({ criterion, i }));
        const criteriaResults = await parallel(criteria.length, indexedCriteria, async ({ criterion, i }) => {
          const criterionColumns = Array.isArray(criterion?.config?.columns)
            ? criterion.config.columns
            : [];

          const criterionData = Object.fromEntries(
            criterionColumns.map((column) => [column, String(row[column] ?? '')])
          );

          const result = await evaluateCondition({
            conditionText: String(criterion.description || ''),
            row: criterionData,
            stepOutput: {},
          });

          return { index: i, passed: Boolean(result.passed) };
        });

        // Apply results and compute score
        let earned = 0;
        const breakdown = [];

        for (const { index, passed } of criteriaResults) {
          const resultColumn = resultColumns[index];
          row[resultColumn] = passed ? 'true' : 'false';

          if (passed) {
            const score = Number(criteria[index].score || 0);
            earned += score;
            breakdown.push(`${score >= 0 ? '+' : ''}${score} ${resultColumn}`);
          }
        }

        const maxPossible = Number(rubric.max_possible || 0);
        const percentage = maxPossible > 0
          ? Math.max(0, Math.min(100, Math.round((earned / maxPossible) * 100)))
          : 0;

        row[scoreColumn] = String(percentage);
        row[breakdownColumn] = breakdown.join(', ');

        const depHash = hashDeps(row, dependsOnColumns, rubricHash);
        recordRun(cache, row._row_id, 'rubric', depHash);
        touchedRowIds.add(row._row_id);
        processed += 1;
        emitActivity({
          event: 'row_complete',
          phase: 'rubric',
          row: String(row.business_name || row.name || row._row_id || ''),
          progress: `${processed}/${staleRubricRows.length || 0}`,
        });
      } catch (error) {
        failed += 1;
        failedRowIds.add(row._row_id);
        summary.errors.push({ source: 'rubric', row: row._row_id, error: error.message });
        emitActivity({
          event: 'error',
          phase: 'rubric',
          row: String(row.business_name || row.name || row._row_id || ''),
          detail: error.message,
        });
      }
    });

    summary.rubric = {
      criteria_count: criteria.length,
      processed,
      failed,
      skipped,
    };
    emitActivity({
      event: 'phase_complete',
      phase: 'rubric',
      processed,
      failed,
      skipped,
    });
  }

  writeCSV(csvPath, headers, allRows);
  writeCache(cachePath, cache);

  try {
    summary.destination_sync = await syncDestinations({
      listDir,
      outboundConfig,
      headers,
      rows: allRows,
    });
  } catch (error) {
    summary.destination_sync = { synced: false, error: error.message };
    summary.errors.push({ source: 'destination_sync', error: error.message });
  }

  summary.rows_enriched = touchedRowIds.size;
  summary.rows_failed = failedRowIds.size;
  summary.rows_skipped = summary.rows_total - touchedRowIds.size - failedRowIds.size;
  emitActivity({
    event: 'phase_complete',
    phase: 'enrichment',
    rows_enriched: summary.rows_enriched,
    rows_failed: summary.rows_failed,
    rows_skipped: summary.rows_skipped,
    errors: summary.errors.length,
  });

  return summary;
};
