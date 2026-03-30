import { existsSync } from 'node:fs';
import { resolveListDir } from '../lib.js';
import { getCanonicalCsvPath } from '../orchestrator/lib/runtime.js';
import { readCSV } from '../orchestrator/lib/csv.js';

export const csvStatsTool = {
  name: 'outbound_csv_stats',
  description:
    'Get statistics for a list\'s CSV: column inventory with fill rates, row count, and empty/populated counts per column.',
  inputSchema: {
    type: 'object',
    required: ['list'],
    properties: {
      list: { type: 'string', description: 'Path to the list directory (absolute or relative to cwd).' },
    },
  },
  run: async (args) => {
    const listDir = resolveListDir(args.list);
    const csvPath = getCanonicalCsvPath(listDir);
    if (!existsSync(csvPath)) {
      return { error: `No canonical prospects CSV found for list "${args.list}".` };
    }

    const { headers, rows } = readCSV(csvPath);
    if (headers.length === 0) {
      return { list: args.list, row_count: 0, columns: [] };
    }

    const rowCount = rows.length;
    const fillCounts = headers.map(() => 0);
    for (const row of rows) {
      for (let j = 0; j < headers.length; j++) {
        const value = row[headers[j]];
        if (String(value || '').trim() !== '') {
          fillCounts[j]++;
        }
      }
    }

    const columns = headers.map((name, i) => ({
      name,
      filled: fillCounts[i],
      empty: rowCount - fillCounts[i],
      fill_rate: rowCount > 0 ? Math.round((fillCounts[i] / rowCount) * 100) : 0,
    }));

    return {
      list: args.list,
      row_count: rowCount,
      column_count: headers.length,
      columns,
    };
  },
};
