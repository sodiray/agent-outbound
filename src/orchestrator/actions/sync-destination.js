import { AGENT_CONSTRAINTS } from './constraints.js';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { runClaude } from '../lib/claude.js';
import { readCSV, writeCSV } from '../lib/csv.js';
import { parseModelJsonObject, zStringish } from '../lib/model-json.js';
import { getInternalDir } from '../lib/runtime.js';

const SyncPullResultSchema = z.object({
  status: z.enum(['success', 'failed', 'empty']).default('success'),
  error: zStringish.default(''),
});

const SyncPushResultSchema = z.object({
  status: z.enum(['success', 'failed']).default('success'),
  rows_written: z.coerce.number().default(0),
  error: zStringish.default(''),
});

/**
 * Step 1: Pull the destination sheet into a local temp CSV file.
 * Claude reads the sheet via MCP tools and writes it to disk.
 */
const pullDestination = async ({ destinationConfig, tempPullPath }) => {
  const sheetId = String(destinationConfig?.sheet_id || '');
  const worksheet = String(destinationConfig?.worksheet || 'Sheet1');

  const prompt = [
    'You are the outbound sync-destination PULL action.',
    'Your job is to read a Google Sheet and save it as a local CSV file.',
    '',
    '## Task',
    '',
    `1. Read the Google Sheet with ID: ${sheetId} (worksheet: "${worksheet}")`,
    `2. Write the sheet contents as a CSV file to: ${tempPullPath}`,
    '',
    '## Rules',
    '',
    '- Read ALL rows and ALL columns from the sheet.',
    '- The first row of the sheet is the header row.',
    '- Write a standard CSV file with the header as the first line.',
    '- If the sheet is empty, write an empty file and return status "empty".',
    '- Use the Read and Write tools to write the file, or Bash to create it.',
    '- Do NOT modify any data. Just copy exactly what is in the sheet.',
    AGENT_CONSTRAINTS,
    '',
    '## Output',
    '',
    'When done, return ONLY JSON:',
    '{',
    '  "status": "success|failed|empty",',
    '  "error": "<error message if failed>"',
    '}',
  ].join('\n');

  const { output, exitCode, stderr } = await runClaude(prompt, { model: 'sonnet' });
  if (exitCode !== 0) {
    throw new Error(`sync pull failed: exit ${exitCode}. ${String(stderr || '').slice(0, 300)}`);
  }

  return parseModelJsonObject({
    output,
    schema: SyncPullResultSchema,
    label: 'sync-pull result',
  });
};

/**
 * Step 2: Deterministic patch.
 * Merge owned columns from the canonical CSV into the pulled sheet,
 * preserving non-owned columns and column order.
 */
const patchDestination = ({ canonicalCsvPath, pulledCsvPath, patchedCsvPath, ownedColumns }) => {
  const canonical = readCSV(canonicalCsvPath);
  const canonicalById = new Map();
  for (const row of canonical.rows) {
    const id = String(row._row_id || '').trim();
    if (id) canonicalById.set(id, row);
  }

  // If pulled sheet is empty or doesn't exist, just write owned columns from canonical
  if (!existsSync(pulledCsvPath)) {
    const headers = ownedColumns.filter((col) =>
      canonical.headers.includes(col) || col === '_row_id'
    );
    const rows = canonical.rows.map((row) => {
      const out = {};
      for (const col of headers) out[col] = String(row[col] ?? '');
      return out;
    });
    writeCSV(patchedCsvPath, headers, rows);
    return { rows_patched: rows.length, preserved_columns: 0 };
  }

  const pulled = readCSV(pulledCsvPath);
  const pulledById = new Map();
  for (const row of pulled.rows) {
    const id = String(row._row_id || '').trim();
    if (id) pulledById.set(id, row);
  }

  // Build merged header: preserve pulled column order, add any new owned columns
  const pulledHeaderSet = new Set(pulled.headers);
  const mergedHeaders = [...pulled.headers];
  for (const col of ownedColumns) {
    if (!pulledHeaderSet.has(col)) {
      mergedHeaders.push(col);
    }
  }

  const ownedSet = new Set(ownedColumns);

  // Build merged rows: canonical is source of truth for which rows exist
  const mergedRows = canonical.rows.map((canonicalRow) => {
    const rowId = String(canonicalRow._row_id || '').trim();
    const pulledRow = pulledById.get(rowId) || {};
    const merged = {};

    for (const col of mergedHeaders) {
      if (ownedSet.has(col)) {
        // Owned columns: always from canonical
        merged[col] = String(canonicalRow[col] ?? '');
      } else {
        // Non-owned columns: preserve from pulled sheet
        merged[col] = String(pulledRow[col] ?? '');
      }
    }

    return merged;
  });

  const preservedColumns = mergedHeaders.filter((col) => !ownedSet.has(col));
  writeCSV(patchedCsvPath, mergedHeaders, mergedRows);

  return { rows_patched: mergedRows.length, preserved_columns: preservedColumns.length };
};

/**
 * Step 3: Push the patched CSV to the destination sheet.
 * Claude reads the local file and writes it to the sheet.
 */
const pushDestination = async ({ destinationConfig, patchedCsvPath, rowCount }) => {
  const sheetId = String(destinationConfig?.sheet_id || '');
  const worksheet = String(destinationConfig?.worksheet || 'Sheet1');

  const prompt = [
    'You are the outbound sync-destination PUSH action.',
    'Your job is to write a local CSV file to a Google Sheet.',
    '',
    '## Task',
    '',
    `1. Read the local CSV file at: ${patchedCsvPath}`,
    `2. Write its contents to the Google Sheet with ID: ${sheetId} (worksheet: "${worksheet}")`,
    '',
    '## Rules',
    '',
    '- The CSV file has a header row and data rows.',
    `- There are ${rowCount} data rows to write.`,
    '- Write the header as row 1 of the sheet.',
    '- Write all data rows starting at row 2.',
    '- Write IN PLACE by updating the cell range that covers the header + data rows. Do NOT clear, delete, or remove any rows or columns first.',
    '- NEVER call any clear, delete, or batch-clear operation on the sheet. Only write/update values.',
    '- If the sheet previously had more rows than the CSV, leave the extra rows as-is — do NOT delete them.',
    '- Preserve the exact column order from the CSV file.',
    '- Do NOT add, remove, or reorder any columns.',
    AGENT_CONSTRAINTS,
    '',
    '## Output',
    '',
    'When done, return ONLY JSON:',
    '{',
    '  "status": "success|failed",',
    '  "rows_written": <number of data rows written>,',
    '  "error": "<error message if failed>"',
    '}',
  ].join('\n');

  const { output, exitCode, stderr } = await runClaude(prompt, { model: 'sonnet' });
  if (exitCode !== 0) {
    throw new Error(`sync push failed: exit ${exitCode}. ${String(stderr || '').slice(0, 300)}`);
  }

  return parseModelJsonObject({
    output,
    schema: SyncPushResultSchema,
    label: 'sync-push result',
  });
};

/**
 * LLM boundary action: sync local CSV data to a configured destination.
 *
 * Three-step process:
 * 1. PULL: Claude reads the destination into a temp CSV
 * 2. PATCH: Orchestrator merges owned columns deterministically
 * 3. PUSH: Claude writes the patched CSV to the destination
 */
export const syncDestination = async ({
  listDir,
  csvPath,
  destinationType,
  destinationConfig,
  ownedColumns,
}) => {
  if (destinationType !== 'google_sheets') {
    throw new Error(`sync-destination does not support destination type "${destinationType}".`);
  }

  const internalDir = getInternalDir(listDir);
  mkdirSync(internalDir, { recursive: true });
  const tempPullPath = join(internalDir, '.sync-pull.csv');
  const tempPatchedPath = join(internalDir, '.sync-patched.csv');

  try {
    // Step 1: Pull
    const pullResult = await pullDestination({ destinationConfig, tempPullPath });
    if (pullResult.status === 'failed') {
      throw new Error(`Pull failed: ${pullResult.error}`);
    }

    // Step 2: Patch (deterministic)
    const patchResult = patchDestination({
      canonicalCsvPath: csvPath,
      pulledCsvPath: pullResult.status === 'empty' ? null : tempPullPath,
      patchedCsvPath: tempPatchedPath,
      ownedColumns,
    });

    // Step 3: Push
    const pushResult = await pushDestination({
      destinationConfig,
      patchedCsvPath: tempPatchedPath,
      rowCount: patchResult.rows_patched,
    });

    if (pushResult.status === 'failed') {
      throw new Error(`Push failed: ${pushResult.error}`);
    }

    return {
      status: 'success',
      rows_synced: pushResult.rows_written || patchResult.rows_patched,
      preserved_columns: patchResult.preserved_columns,
    };
  } finally {
    // Clean up temp files
    try { if (existsSync(tempPullPath)) unlinkSync(tempPullPath); } catch { /* */ }
    try { if (existsSync(tempPatchedPath)) unlinkSync(tempPatchedPath); } catch { /* */ }
  }
};
