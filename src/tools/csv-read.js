import { existsSync, readFileSync } from 'node:fs';
import { resolveListDir } from '../lib.js';
import { getCanonicalCsvPath } from '../orchestrator/lib/runtime.js';

const parseCSV = (text) => {
  const lines = [];
  let current = '';
  let inQuotes = false;
  for (const char of text) {
    if (char === '"') { inQuotes = !inQuotes; current += char; }
    else if (char === '\n' && !inQuotes) { lines.push(current); current = ''; }
    else { current += char; }
  }
  if (current.trim()) lines.push(current);

  const parseRow = (line) => {
    const fields = [];
    let field = '';
    let q = false;
    for (const c of line) {
      if (c === '"') q = !q;
      else if (c === ',' && !q) { fields.push(field); field = ''; }
      else field += c;
    }
    fields.push(field);
    return fields;
  };

  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseRow(lines[0]);
  const rows = lines.slice(1).map((line, i) => {
    const values = parseRow(line);
    const row = { _index: i };
    headers.forEach((h, j) => { row[h] = values[j] || ''; });
    return row;
  });
  return { headers, rows };
};

export const csvReadTool = {
  name: 'outbound_csv_read',
  description:
    'Read rows from a list\'s CSV. Supports filtering by column values, selecting specific columns, and row ranges. Returns structured JSON.',
  inputSchema: {
    type: 'object',
    required: ['list'],
    properties: {
      list: { type: 'string', description: 'Path to the list directory (absolute or relative to cwd).' },
      columns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only return these columns. Omit to return all.',
      },
      range: {
        type: 'string',
        description: 'Row range (e.g. "0-10"). Omit for all rows.',
      },
      filter: {
        type: 'object',
        description: 'Filter rows where column equals value. E.g. {"status": "ready"}',
        additionalProperties: { type: 'string' },
      },
      limit: {
        type: 'number',
        description: 'Max rows to return. Defaults to 50.',
      },
    },
  },
  run: async (args) => {
    const listDir = resolveListDir(args.list);
    const csvPath = getCanonicalCsvPath(listDir);
    if (!existsSync(csvPath)) {
      return { error: `No canonical prospects CSV found for list "${args.list}".` };
    }

    const content = readFileSync(csvPath, 'utf-8');
    const { headers, rows } = parseCSV(content);

    let filtered = rows;

    // Apply range
    if (args.range) {
      const [start, end] = args.range.split('-').map(Number);
      filtered = filtered.filter((r) => r._index >= start && r._index <= end);
    }

    // Apply filter
    if (args.filter) {
      for (const [col, val] of Object.entries(args.filter)) {
        filtered = filtered.filter((r) => r[col] === val);
      }
    }

    // Apply limit
    const limit = args.limit || 50;
    filtered = filtered.slice(0, limit);

    // Select columns (handle both array and JSON string input)
    const requestedColumns = args.columns
      ? (typeof args.columns === 'string' ? JSON.parse(args.columns) : args.columns)
      : null;

    if (requestedColumns) {
      filtered = filtered.map((r) => {
        const selected = { _index: r._index };
        for (const col of requestedColumns) {
          selected[col] = r[col] ?? '';
        }
        return selected;
      });
    }

    return {
      list: args.list,
      total_rows: rows.length,
      returned_rows: filtered.length,
      columns: requestedColumns || headers,
      rows: filtered,
    };
  },
};
