import { existsSync } from 'node:fs';
import { readCSV } from '../lib/csv.js';
import { checkStaleness, readCache } from '../lib/hash.js';
import { getCachePath, getCanonicalCsvPath } from '../lib/runtime.js';
import {
  getDependsOnColumns,
  getOutputColumns,
  loadResolvedConfigFromOutbound,
} from './schema.js';

const shouldSkipRow = (row) => String(row.source_filter_result || '').trim().toLowerCase() === 'failed';

export const getEnrichmentStatus = ({ listDir }) => {
  const csvPath = getCanonicalCsvPath(listDir);
  if (!existsSync(csvPath)) {
    throw new Error('No canonical prospects CSV found. Run sourcing first.');
  }

  const config = loadResolvedConfigFromOutbound(listDir);
  const { rows } = readCSV(csvPath);
  const cache = readCache(getCachePath(listDir));

  const sources = {};
  for (const [sourceName, sourceConfig] of Object.entries(config.sources || {})) {
    const produced = getOutputColumns(sourceConfig);
    const dependsOn = getDependsOnColumns(sourceConfig);
    const extraHashValues = [JSON.stringify(sourceConfig || {})];

    const counts = {
      total: rows.length,
      complete: 0,
      stale: 0,
      pending: 0,
      skipped: 0,
    };

    for (const row of rows) {
      if (shouldSkipRow(row)) {
        counts.skipped += 1;
        continue;
      }

      const { stale, reason } = checkStaleness({
        row,
        rowId: row._row_id,
        sourceName,
        dependsOn,
        outputColumns: produced,
        extraHashValues,
        cacheTTL: sourceConfig.cache,
        cache,
      });

      if (!stale) counts.complete += 1;
      else if (reason === 'no_cache_entry') counts.pending += 1;
      else counts.stale += 1;
    }

    sources[sourceName] = {
      produced_columns: produced,
      depends_on_columns: dependsOn,
      ...counts,
      needs_run: counts.stale + counts.pending,
      progress_percent: counts.total > 0
        ? Math.round((counts.complete / counts.total) * 100)
        : 0,
    };
  }

  let rubric;
  if (config.rubric) {
    const criteria = Array.isArray(config.rubric.criteria) ? config.rubric.criteria : [];
    const scoreColumn = String(config.rubric.score_column || 'lead_score');
    const breakdownColumn = String(config.rubric.breakdown_column || 'lead_score_breakdown');
    const resultColumns = criteria.map((criterion, index) =>
      String(criterion?.config?.result_column || `rubric_${index + 1}`)
    );

    const dependsOn = [...new Set(criteria.flatMap((criterion) => criterion?.config?.columns || []))];
    const rubricHash = [
      JSON.stringify({
        scoreColumn,
        breakdownColumn,
        criteria,
      }),
    ];

    const counts = {
      total: rows.length,
      complete: 0,
      stale: 0,
      pending: 0,
      skipped: 0,
    };

    for (const row of rows) {
      if (shouldSkipRow(row)) {
        counts.skipped += 1;
        continue;
      }

      const { stale, reason } = checkStaleness({
        row,
        rowId: row._row_id,
        sourceName: 'rubric',
        dependsOn,
        outputColumns: [scoreColumn, breakdownColumn, ...resultColumns],
        extraHashValues: rubricHash,
        cacheTTL: config.rubric.cache,
        cache,
      });

      if (!stale) counts.complete += 1;
      else if (reason === 'no_cache_entry') counts.pending += 1;
      else counts.stale += 1;
    }

    rubric = {
      criteria_count: criteria.length,
      score_column: scoreColumn,
      breakdown_column: breakdownColumn,
      ...counts,
      needs_run: counts.stale + counts.pending,
    };
  }

  return {
    rows_total: rows.length,
    source_count: Object.keys(sources).length,
    sources,
    rubric,
  };
};
