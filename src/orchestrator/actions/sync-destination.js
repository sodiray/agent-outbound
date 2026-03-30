import { z } from 'zod';
import { runClaude } from '../lib/claude.js';
import { parseModelJsonObject, zStringish } from '../lib/model-json.js';

const SyncResultSchema = z.object({
  status: z.enum(['success', 'failed']).default('success'),
  rows_synced: z.coerce.number().default(0),
  error: zStringish.default(''),
});

/**
 * LLM boundary action: sync local CSV data to a configured destination.
 *
 * Delegates the entire sync operation to Claude in a single subprocess.
 * Claude reads the local CSV file, reads the remote destination, and
 * syncs owned columns — preserving any additional data in the destination.
 */
export const syncDestination = async ({
  csvPath,
  destinationType,
  destinationConfig,
  ownedColumns,
}) => {
  const prompt = buildSyncPrompt({
    csvPath,
    destinationType,
    destinationConfig,
    ownedColumns,
  });

  const { output, exitCode, stderr } = await runClaude(prompt, {
    model: 'sonnet',
  });

  if (exitCode !== 0) {
    throw new Error(`sync-destination failed: exit ${exitCode}. ${String(stderr || '').slice(0, 300)}`);
  }

  const parsed = parseModelJsonObject({
    output,
    schema: SyncResultSchema,
    label: 'sync-destination result',
  });

  if (parsed.status === 'failed') {
    throw new Error(String(parsed.error || 'Sync failed with no error details.'));
  }

  return {
    status: parsed.status,
    rows_synced: parsed.rows_synced,
  };
};

const buildSyncPrompt = ({
  csvPath,
  destinationType,
  destinationConfig,
  ownedColumns,
}) => {
  if (destinationType === 'google_sheets') {
    return buildGoogleSheetsSyncPrompt({ csvPath, destinationConfig, ownedColumns });
  }

  throw new Error(`sync-destination does not support destination type "${destinationType}".`);
};

const buildGoogleSheetsSyncPrompt = ({ csvPath, destinationConfig, ownedColumns }) => {
  const sheetId = String(destinationConfig?.sheet_id || '');
  const worksheet = String(destinationConfig?.worksheet || 'Sheet1');

  return [
    'You are the outbound sync-destination action.',
    'Your job is to sync local CSV data to a Google Sheet.',
    '',
    '## Task',
    '',
    `1. Read the local CSV file at: ${csvPath}`,
    `2. Open the Google Sheet with ID: ${sheetId} (worksheet: "${worksheet}")`,
    '3. Sync the data from the CSV to the sheet following the rules below.',
    '',
    '## Rules',
    '',
    '- These are the **owned columns** that the outbound system manages:',
    ownedColumns.map((col) => `  - ${col}`).join('\n'),
    '- Write owned column data from the CSV to the sheet. Owned column values from the CSV always overwrite what is in the sheet.',
    '- If the sheet has additional columns beyond the owned columns, **preserve them**. Do not delete, clear, or overwrite any column that is not in the owned columns list.',
    '- If the sheet has additional rows beyond what is in the CSV, remove them (the CSV is the source of truth for which rows exist).',
    '- Match rows between the CSV and sheet using the `_row_id` column.',
    '- The first row of the sheet should be the header row with column names.',
    '- Data rows start at row 2.',
    '',
    '## Approach',
    '',
    '- Read the CSV file to get the headers and row data.',
    '- Read the current sheet state to see what columns and rows already exist.',
    '- Build the updated sheet content: owned columns from CSV + any preserved columns from the existing sheet.',
    '- Write the headers and data to the sheet. You may batch writes if needed for large datasets.',
    '- If the sheet is empty (new sheet), just write headers + all rows.',
    '',
    '## Output',
    '',
    'When done, return ONLY JSON:',
    '{',
    '  "status": "success|failed",',
    '  "rows_synced": <number of data rows written>,',
    '  "error": "<error message if failed>"',
    '}',
  ].join('\n');
};
