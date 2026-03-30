import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readCSV } from './csv.js';
import { getCanonicalCsvPath } from './runtime.js';
import { loadResolvedConfigFromOutbound, getOutputColumns } from '../enrichment/schema.js';

const buildSequenceCounts = (rows) => {
  const counts = { active: 0, engaged: 0, completed: 0, opted_out: 0, bounced: 0, untracked: 0 };
  for (const row of rows) {
    const status = String(row.sequence_status || '').trim();
    if (counts[status] != null) counts[status] += 1;
    else counts.untracked += 1;
  }
  return counts;
};

const buildFilterCounts = (rows) => {
  let passed = 0;
  let failed = 0;
  let unreviewed = 0;
  for (const row of rows) {
    const result = String(row.source_filter_result || '').trim().toLowerCase();
    if (result === 'passed') passed += 1;
    else if (result === 'failed') failed += 1;
    else unreviewed += 1;
  }
  return { passed, failed, unreviewed };
};

const buildEnrichmentFill = ({ rows, enrichmentColumns }) => {
  if (enrichmentColumns.length === 0) {
    return {
      columns_tracked: 0,
      filled_cells: 0,
      total_cells: 0,
      fill_rate: 0,
    };
  }

  const totalCells = rows.length * enrichmentColumns.length;
  let filledCells = 0;
  for (const row of rows) {
    for (const column of enrichmentColumns) {
      if (String(row[column] || '').trim()) {
        filledCells += 1;
      }
    }
  }

  return {
    columns_tracked: enrichmentColumns.length,
    filled_cells: filledCells,
    total_cells: totalCells,
    fill_rate: totalCells > 0 ? Math.round((filledCells / totalCells) * 100) : 0,
  };
};

export const getListSummary = ({ listDir }) => {
  const hasOutboundConfig = existsSync(join(listDir, 'outbound.yaml'));
  const csvPath = getCanonicalCsvPath(listDir);
  const { headers, rows } = existsSync(csvPath)
    ? readCSV(csvPath)
    : { headers: [], rows: [] };

  let enrichmentColumns = [];
  let configError = '';
  if (hasOutboundConfig) {
    try {
      const resolved = loadResolvedConfigFromOutbound(listDir);
      enrichmentColumns = [...new Set([
        ...Object.values(resolved.sources || {}).flatMap((source) => getOutputColumns(source)),
        ...(resolved.rubric
          ? [
            resolved.rubric.score_column,
            resolved.rubric.breakdown_column,
            ...resolved.rubric.criteria.map((criterion) => criterion.result_column),
          ]
          : []),
      ])];
    } catch (error) {
      configError = error.message;
    }
  }

  const enrichment = buildEnrichmentFill({ rows, enrichmentColumns });

  return {
    home: listDir,
    has_outbound_config: hasOutboundConfig,
    row_count: rows.length,
    columns: headers,
    sourced_count: rows.length,
    source_filters: buildFilterCounts(rows),
    enrichment: {
      ...enrichment,
      config_error: configError || undefined,
    },
    enrichment_fill_rate: enrichment.fill_rate,
    sequence: buildSequenceCounts(rows),
    config_error: configError || undefined,
  };
};
