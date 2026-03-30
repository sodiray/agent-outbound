import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { readCSV, writeCSV } from './csv.js';
import { runClaude } from './claude.js';
import { parseModelJsonObject, zBooleanish } from './model-json.js';

const INTERNAL_DIR_NAME = '.outbound';
const MAX_SHEET_BATCH_ROWS = 100;
const ComposioToolCallSchema = z.object({
  ok: zBooleanish,
  data: z.any().optional(),
  error: z.any().optional(),
}).passthrough();

const normalizeRef = (value) => String(value || '').trim();

export const getInternalDir = (listDir) => join(listDir, INTERNAL_DIR_NAME);
export const getInternalCacheDir = (listDir) => join(getInternalDir(listDir), '.cache');
export const getCanonicalCsvPath = (listDir) => join(getInternalDir(listDir), 'prospects.csv');
export const getCachePath = (listDir) => join(getInternalCacheDir(listDir), 'hashes.json');
export const getSourcingLogPath = (listDir) => join(getInternalDir(listDir), 'sourcing.log');

export const ensureRuntimeDirs = (listDir) => {
  mkdirSync(getInternalDir(listDir), { recursive: true });
  mkdirSync(getInternalCacheDir(listDir), { recursive: true });
};

export const resolveVirtualPath = ({ listDir, filePath, allowRelative = false }) => {
  const ref = normalizeRef(filePath);
  if (!ref) return '';

  if (ref.startsWith('@list/')) {
    return join(listDir, ref.slice('@list/'.length));
  }
  if (ref.startsWith('@internal/')) {
    return join(getInternalDir(listDir), ref.slice('@internal/'.length));
  }
  if (allowRelative) {
    return join(listDir, ref);
  }
  throw new Error(`Path "${ref}" must start with "@list/" or "@internal/".`);
};

export const toVirtualPath = ({ listDir, filePath, defaultRoot = '@list' }) => {
  const ref = normalizeRef(filePath);
  if (!ref) return '';
  if (ref.startsWith('@list/') || ref.startsWith('@internal/')) return ref;

  if (isAbsolute(ref)) {
    const listRelative = relative(listDir, ref);
    if (listRelative && !listRelative.startsWith('..') && !isAbsolute(listRelative)) {
      return `@list/${listRelative}`;
    }
    const internalRelative = relative(getInternalDir(listDir), ref);
    if (internalRelative && !internalRelative.startsWith('..') && !isAbsolute(internalRelative)) {
      return `@internal/${internalRelative}`;
    }
    throw new Error(`Absolute path "${ref}" is outside list scope.`);
  }

  return `${defaultRoot}/${ref.replace(/^\.?\//, '')}`;
};

export const ensureCanonicalCsvExists = (listDir) => {
  ensureRuntimeDirs(listDir);
  const csvPath = getCanonicalCsvPath(listDir);
  if (existsSync(csvPath)) {
    return;
  }

  const legacyCsvPath = join(listDir, 'prospects.csv');
  if (existsSync(legacyCsvPath)) {
    const { headers: legacyHeaders, rows: legacyRows } = readCSV(legacyCsvPath);
    const hasRowId = legacyHeaders.includes('_row_id');
    if (hasRowId) {
      writeCSV(csvPath, legacyHeaders, legacyRows);
      return;
    }

    const migratedHeaders = ['_row_id', ...legacyHeaders];
    const migratedRows = legacyRows.map((row, index) => ({
      _row_id: `legacy_${index + 1}`,
      ...row,
    }));
    writeCSV(csvPath, migratedHeaders, migratedRows);
    return;
  }

  writeCSV(csvPath, ['_row_id'], []);
};

const normalizeDestinations = (dataConfig = {}) => {
  const destination = dataConfig.destination;
  if (Array.isArray(destination)) {
    return destination.map((entry) => String(entry));
  }
  if (destination) {
    return [String(destination)];
  }
  if (Array.isArray(dataConfig.destinations)) {
    return dataConfig.destinations.map((entry) => String(entry));
  }
  return [];
};

const normalizeOwnedColumns = ({ headers, destinationConfig }) => {
  const include = destinationConfig?.columns?.include;
  if (Array.isArray(include) && include.length > 0) {
    const out = include.map((col) => String(col));
    return out.includes('_row_id') ? out : ['_row_id', ...out];
  }
  return [...headers];
};

const ensureParentDir = (filePath) => {
  mkdirSync(dirname(filePath), { recursive: true });
};

const toColumnLabel = (index) => {
  let n = Number(index) + 1;
  let out = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

const rangeForMatrix = ({ startRow, colCount, rowCount }) => {
  const start = `${toColumnLabel(0)}${startRow}`;
  const end = `${toColumnLabel(Math.max(colCount - 1, 0))}${startRow + rowCount - 1}`;
  return `${start}:${end}`;
};

const collectFirstMatrix = (value) => {
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    if (value.every((row) => Array.isArray(row))) {
      return value.map((row) => row.map((cell) => String(cell ?? '')));
    }
    for (const child of value) {
      const matrix = collectFirstMatrix(child);
      if (matrix.length > 0) return matrix;
    }
    return [];
  }
  if (!value || typeof value !== 'object') return [];
  for (const child of Object.values(value)) {
    const matrix = collectFirstMatrix(child);
    if (matrix.length > 0) return matrix;
  }
  return [];
};

const executeComposioToolViaClaude = async ({ tool, argumentsPayload }) => {
  const prompt = [
    'Use Composio MCP to execute exactly one tool call.',
    `Tool: ${tool}`,
    'Arguments JSON:',
    JSON.stringify(argumentsPayload || {}),
    '',
    'Return ONLY JSON:',
    '{',
    '  "ok": true|false,',
    '  "data": <tool response object/array/null>,',
    '  "error": "<error message if any>"',
    '}',
  ].join('\n');

  const { output, exitCode, stderr } = await runClaude(prompt, {
    model: 'haiku',
  });

  if (exitCode !== 0) {
    throw new Error(`Composio MCP call failed for "${tool}": ${stderr.slice(0, 300)}`);
  }

  const parsed = parseModelJsonObject({
    output,
    schema: ComposioToolCallSchema,
    label: `Composio MCP call (${tool})`,
  });

  if (!parsed.ok) {
    throw new Error(String(parsed.error || `Composio MCP call failed for "${tool}".`));
  }

  return parsed.data;
};

const executeWithArgumentFallbacks = async ({
  tool,
  candidateArguments,
}) => {
  let lastError = null;
  for (const args of candidateArguments) {
    try {
      return await executeComposioToolViaClaude({
        tool,
        argumentsPayload: args,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Unable to execute Composio tool "${tool}".`);
};

const readSheetMatrix = async ({ destinationConfig, readTool, worksheet, sheetId }) => {
  const candidateArguments = [
    { spreadsheet_id: sheetId, sheet_name: worksheet },
    { spreadsheet_id: sheetId, worksheet },
    { spreadsheet_id: sheetId, range: worksheet },
    { sheet_id: sheetId, worksheet },
    { sheet_id: sheetId, sheet_name: worksheet },
  ];
  const result = await executeWithArgumentFallbacks({
    tool: readTool,
    candidateArguments,
  });
  return collectFirstMatrix(result);
};

const writeSheetBatch = async ({
  destinationConfig,
  updateTool,
  sheetId,
  worksheet,
  range,
  values,
}) => {
  const candidateArguments = [
    { spreadsheet_id: sheetId, sheet_name: worksheet, range, values },
    { spreadsheet_id: sheetId, worksheet, range, values },
    { sheet_id: sheetId, sheet_name: worksheet, range, values },
    { sheet_id: sheetId, worksheet, range, values },
    { spreadsheet_id: sheetId, range, values },
    { sheet_id: sheetId, range, values },
  ];

  await executeWithArgumentFallbacks({
    tool: updateTool,
    candidateArguments,
  });
};

const syncCsvDestination = ({ listDir, destinationConfig, headers, rows }) => {
  const targetRef = destinationConfig?.path || '@list/prospects.csv';
  const targetPath = resolveVirtualPath({ listDir, filePath: targetRef });
  const ownedColumns = normalizeOwnedColumns({ headers, destinationConfig });

  ensureParentDir(targetPath);

  let existingHeaders = [];
  let existingRows = [];
  if (existsSync(targetPath)) {
    const existing = readCSV(targetPath);
    existingHeaders = existing.headers;
    existingRows = existing.rows;
  }

  const preservedColumns = existingHeaders.filter((col) => !ownedColumns.includes(col));
  const mergedHeaders = [...ownedColumns, ...preservedColumns];
  const existingById = new Map(existingRows.map((row) => [String(row._row_id || ''), row]));

  const mergedRows = rows.map((row) => {
    const rowId = String(row._row_id || '');
    const existingRow = existingById.get(rowId) || {};
    const merged = {};
    for (const col of ownedColumns) {
      merged[col] = String(row[col] ?? '');
    }
    for (const col of preservedColumns) {
      merged[col] = String(existingRow[col] ?? '');
    }
    return merged;
  });

  writeCSV(targetPath, mergedHeaders, mergedRows);
  return {
    destination: 'csv',
    path: targetRef,
    synced_rows: mergedRows.length,
    owned_columns: ownedColumns.length,
    preserved_columns: preservedColumns.length,
  };
};

const syncGoogleSheetsDestination = async ({ destinationConfig, headers, rows }) => {
  const sheetId = normalizeRef(destinationConfig?.sheet_id);
  const worksheet = normalizeRef(destinationConfig?.worksheet || 'Prospects');
  const readTool = normalizeRef(destinationConfig?.composio_read_tool);
  const updateTool = normalizeRef(destinationConfig?.composio_update_tool);
  if (!sheetId) {
    throw new Error('Google Sheets sync requires data.google_sheets.sheet_id.');
  }
  if (!readTool || !updateTool) {
    throw new Error(
      'Google Sheets destination is missing bound Composio tools. Re-run outbound_config_update to bind destination tools.'
    );
  }

  const ownedColumns = normalizeOwnedColumns({ headers, destinationConfig });
  const existingMatrix = await readSheetMatrix({
    destinationConfig,
    readTool,
    worksheet,
    sheetId,
  });

  const existingHeaders = existingMatrix[0] ? existingMatrix[0].map((v) => String(v || '')) : [];
  const preservedColumns = existingHeaders.filter((col) => col && !ownedColumns.includes(col));
  const mergedHeaders = [...ownedColumns, ...preservedColumns];
  const existingRows = existingMatrix.slice(1);
  const existingById = new Map();
  const rowIdHeaderIndex = existingHeaders.indexOf('_row_id');
  if (rowIdHeaderIndex >= 0) {
    for (const sheetRow of existingRows) {
      const rowId = String(sheetRow[rowIdHeaderIndex] ?? '').trim();
      if (!rowId) continue;
      const rowObj = {};
      for (let i = 0; i < existingHeaders.length; i += 1) {
        const header = existingHeaders[i];
        rowObj[header] = String(sheetRow[i] ?? '');
      }
      existingById.set(rowId, rowObj);
    }
  }

  const mergedRows = rows.map((row) => {
    const rowId = String(row._row_id ?? '');
    const existingRow = existingById.get(rowId) || {};
    const merged = {};
    for (const col of ownedColumns) merged[col] = String(row[col] ?? '');
    for (const col of preservedColumns) merged[col] = String(existingRow[col] ?? '');
    return merged;
  });

  const fullMatrix = [
    mergedHeaders,
    ...mergedRows.map((row) => mergedHeaders.map((col) => String(row[col] ?? ''))),
  ];

  const batches = [];
  if (fullMatrix.length > 0) {
    batches.push({
      startRow: 1,
      values: [fullMatrix[0]],
    });
  }
  for (let rowIndex = 1; rowIndex < fullMatrix.length; rowIndex += MAX_SHEET_BATCH_ROWS) {
    batches.push({
      startRow: rowIndex + 1,
      values: fullMatrix.slice(rowIndex, rowIndex + MAX_SHEET_BATCH_ROWS),
    });
  }

  for (const batch of batches) {
    if (batch.values.length === 0) continue;
    const range = rangeForMatrix({
      startRow: batch.startRow,
      colCount: mergedHeaders.length,
      rowCount: batch.values.length,
    });
    await writeSheetBatch({
      destinationConfig,
      updateTool,
      sheetId,
      worksheet,
      range,
      values: batch.values,
    });
  }

  return {
    destination: 'google_sheets',
    sheet_id: sheetId,
    worksheet,
    status: 'ok',
    synced_rows: mergedRows.length,
    preserved_columns: preservedColumns.length,
    read_tool: readTool,
    update_tool: updateTool,
    batches_written: batches.length,
  };
};

export const syncDestinations = async ({ listDir, outboundConfig, headers, rows }) => {
  const destinations = normalizeDestinations(outboundConfig?.data || {});
  if (destinations.length === 0) return { synced: false, destinations: [] };

  const results = [];
  for (const destination of destinations) {
    if (destination === 'csv') {
      results.push(
        syncCsvDestination({
          listDir,
          destinationConfig: outboundConfig?.data?.csv || {},
          headers,
          rows,
        })
      );
      continue;
    }

    if (destination === 'google_sheets') {
      const result = await syncGoogleSheetsDestination({
        destinationConfig: outboundConfig?.data?.google_sheets || {},
        headers,
        rows,
      });
      results.push(result);
      continue;
    }

    throw new Error(`Unsupported destination "${destination}".`);
  }

  return {
    synced: true,
    destinations: results,
  };
};
