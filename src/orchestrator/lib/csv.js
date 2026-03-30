/**
 * CSV parsing and writing. Handles quoted fields with commas and newlines.
 * Every row gets a stable `_row_id` column (UUID) on first parse if missing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const ROW_ID_COLUMN = '_row_id';

const parseLine = (line) => {
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (const c of line) {
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) { fields.push(field); field = ''; }
    else field += c;
  }
  fields.push(field);
  return fields;
};

const splitLines = (text) => {
  const lines = [];
  let current = '';
  let inQuotes = false;
  for (const char of text) {
    if (char === '"') { inQuotes = !inQuotes; current += char; }
    else if (char === '\n' && !inQuotes) { lines.push(current); current = ''; }
    else current += char;
  }
  if (current.trim()) lines.push(current);
  return lines;
};

/**
 * Parse a CSV file into { headers: string[], rows: Record<string, string>[] }
 * Each row includes a `_row_id` field for stable identity.
 */
export const readCSV = (filePath) => {
  const text = readFileSync(filePath, 'utf-8');
  const lines = splitLines(text);
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = parseLine(lines[0]);
  const hasRowId = headers.includes(ROW_ID_COLUMN);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseLine(lines[i]);
    const row = {};
    headers.forEach((h, j) => { row[h] = values[j] || ''; });

    // Assign stable row ID if missing
    if (!hasRowId || !row[ROW_ID_COLUMN]) {
      row[ROW_ID_COLUMN] = randomUUID();
    }
    rows.push(row);
  }

  // Add _row_id to headers if it wasn't there
  if (!hasRowId) headers.unshift(ROW_ID_COLUMN);

  return { headers, rows };
};

/**
 * Write rows back to a CSV file. Preserves column order from headers.
 * Quotes fields that contain commas, newlines, or quotes.
 */
export const writeCSV = (filePath, headers, rows) => {
  const escape = (val) => {
    const str = String(val ?? '');
    if (str.includes(',') || str.includes('\n') || str.includes('"')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [headers.map(escape).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  writeFileSync(filePath, lines.join('\n') + '\n');
};

/**
 * Add new columns to an existing CSV. Preserves existing data.
 * Returns updated headers.
 */
export const ensureColumns = (headers, newColumns) => {
  const updated = [...headers];
  for (const col of newColumns) {
    if (!updated.includes(col)) updated.push(col);
  }
  return updated;
};
