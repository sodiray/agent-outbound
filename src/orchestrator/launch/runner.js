import { existsSync } from 'node:fs';
import { parallel } from 'radash';
import { ensureColumns, readCSV, writeCSV } from '../lib/csv.js';
import { executeStep } from '../actions/execute-step.js';
import { getSequence, getStep, addDays } from '../sequencer/config.js';
import { readYaml } from '../lib/yaml.js';
import { getStepRuntimeOverrides } from '../lib/step-runtime.js';
import { getExecutionStepConfig } from '../lib/step-config.js';
import {
  ensureCanonicalCsvExists,
  ensureRuntimeDirs,
  getCanonicalCsvPath,
  resolveVirtualPath,
  syncDestinations,
} from '../lib/runtime.js';
import { emitActivity } from '../lib/activity.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getRowLabel = (row) => String(row._row_id || '').trim() || 'row';
const getPreviewId = (result, row) =>
  String(
    result?.artifacts?.preview_id
    || result?.artifacts?.artifact_id
    || result?.artifacts?.draft_id
    || result?.outputs?.preview_id
    || result?.outputs?.artifact_id
    || result?.outputs?.draft_id
    || row?.launch_preview_id
    || row?.draft_id
    || ''
  );
const getExecutionRef = (result, row) =>
  String(
    result?.artifacts?.execution_ref
    || result?.artifacts?.thread_id
    || result?.artifacts?.message_id
    || result?.outputs?.execution_ref
    || result?.outputs?.thread_id
    || result?.outputs?.message_id
    || row?.launch_execution_ref
    || row?.thread_id
    || ''
  );

const filterRows = (rows, { filter, rowRange }) => {
  let selected = rows.map((row, index) => ({ row, index }));

  if (rowRange) {
    const [start, end] = String(rowRange).split('-').map(Number);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      selected = selected.filter(({ index }) => index >= start && index <= end);
    }
  }

  if (filter && typeof filter === 'object') {
    for (const [key, value] of Object.entries(filter)) {
      selected = selected.filter(({ row }) => String(row[key] || '') === String(value));
    }
  }

  return selected;
};

const getLaunchStep = (listDir) => {
  const sequence = getSequence(listDir);
  const firstStep = getStep(sequence.steps, 1);
  if (!firstStep) {
    throw new Error('Sequence has no steps. Add sequence.steps in outbound.yaml.');
  }
  return { sequence, firstStep };
};

export const runLaunchDraft = async ({
  listDir,
  listName,
  filter,
  rows,
}) => {
  ensureRuntimeDirs(listDir);
  ensureCanonicalCsvExists(listDir);

  const csvPath = getCanonicalCsvPath(listDir);
  const outboundConfig = readYaml(resolveVirtualPath({
    listDir,
    filePath: '@list/outbound.yaml',
    allowRelative: false,
  }));
  if (outboundConfig._raw) {
    throw new Error('Could not parse outbound.yaml.');
  }

  const { headers: csvHeaders, rows: csvRows } = readCSV(csvPath);
  const headers = ensureColumns(csvHeaders, [
    'launch_preview_id',
    'launch_preview_status',
    'launch_preview_error',
    'launch_preview_created_at',
    'launch_preview_label',
    'draft_id',
    'draft_message_id',
    'draft_status',
    'draft_error',
    'draft_created_at',
    'draft_label',
  ]);

  const { firstStep } = getLaunchStep(listDir);
  const selected = filterRows(csvRows, { filter, rowRange: rows });

  const summary = {
    rows_considered: selected.length,
    previewed: 0,
    skipped_existing_preview: 0,
    drafted: 0,
    skipped_existing_draft: 0,
    failed: 0,
    errors: [],
  };
  emitActivity({
    event: 'phase_start',
    phase: 'launch_draft',
    rows: selected.length,
  });

  const toDraft = selected.filter(({ row }) => {
    const hasExistingPreview = String(row.launch_preview_id || row.draft_id || '').trim();
    if (hasExistingPreview) {
      row.launch_preview_status = 'skipped_existing_preview';
      row.draft_status = 'skipped_existing_draft';
      summary.skipped_existing_preview += 1;
      summary.skipped_existing_draft += 1;
      return false;
    }
    return true;
  });

  await parallel(10, toDraft, async ({ row, index }) => {
    try {
      const stepConfig = getExecutionStepConfig(firstStep);
      const result = await executeStep({
        listDir,
        phase: 'sequence_launch_draft',
        stepId: 'sequence_step_1',
        description: String(firstStep.description || 'launch draft'),
        stepConfig,
        row,
        context: {
          mode: 'preview',
          legacy_mode: 'draft',
          list_name: String(listName || ''),
        },
        ...getStepRuntimeOverrides(stepConfig),
      });

      const draftId = getPreviewId(result, row);
      const messageId = String(result.artifacts?.message_id || result.outputs?.message_id || '');
      const label = String(result.artifacts?.label || result.outputs?.label || '');

      row.launch_preview_id = draftId;
      row.launch_preview_label = label;
      row.launch_preview_created_at = new Date().toISOString();
      row.launch_preview_status = draftId ? 'created' : 'failed';
      row.launch_preview_error = draftId ? '' : (result.error || 'Missing preview_id/artifact_id in execute-step result.');
      row.draft_id = draftId;
      row.draft_message_id = messageId;
      row.draft_label = label;
      row.draft_created_at = row.launch_preview_created_at;
      row.draft_status = draftId ? 'created' : 'failed';
      row.draft_error = draftId ? '' : (result.error || 'Missing draft_id in execute-step result.');

      if (draftId) {
        summary.previewed += 1;
        summary.drafted += 1;
        emitActivity({
          event: 'row_complete',
          phase: 'launch_draft',
          row: String(row.business_name || row.name || row._row_id || ''),
          drafted: true,
        });
      } else {
        summary.failed += 1;
        summary.errors.push({ index, row: getRowLabel(row), error: row.draft_error });
        emitActivity({
          event: 'error',
          phase: 'launch_draft',
          row: String(row.business_name || row.name || row._row_id || ''),
          detail: row.draft_error,
        });
      }
    } catch (error) {
      row.launch_preview_status = 'failed';
      row.launch_preview_error = error.message;
      row.draft_status = 'failed';
      row.draft_error = error.message;
      summary.failed += 1;
      summary.errors.push({ index, row: getRowLabel(row), error: error.message });
      emitActivity({
        event: 'error',
        phase: 'launch_draft',
        row: String(row.business_name || row.name || row._row_id || ''),
        detail: error.message,
      });
    }
  });

  writeCSV(csvPath, headers, csvRows);
  try {
    summary.destination_sync = await syncDestinations({
      listDir,
      outboundConfig,
      headers,
      rows: csvRows,
    });
  } catch (error) {
    summary.destination_sync = { synced: false, error: error.message };
    summary.errors.push({ error: error.message });
  }
  emitActivity({
    event: 'phase_complete',
    phase: 'launch_draft',
    drafted: summary.drafted,
    failed: summary.failed,
    errors: summary.errors.length,
  });

  return summary;
};

export const runLaunchSend = async ({
  listDir,
  filter,
  staggerSeconds,
}) => {
  ensureRuntimeDirs(listDir);
  ensureCanonicalCsvExists(listDir);

  const csvPath = getCanonicalCsvPath(listDir);
  const outboundConfig = readYaml(resolveVirtualPath({
    listDir,
    filePath: '@list/outbound.yaml',
    allowRelative: false,
  }));
  if (outboundConfig._raw) {
    throw new Error('Could not parse outbound.yaml.');
  }

  const { headers: csvHeaders, rows: csvRows } = readCSV(csvPath);
  const headers = ensureColumns(csvHeaders, [
    'launch_execution_ref',
    'launch_execute_status',
    'launch_execute_error',
    'launch_executed_at',
    'thread_id',
    'message_id',
    'sent_at',
    'send_status',
    'send_error',
    'last_outreach_date',
    'sequence_step',
    'next_action_date',
    'sequence_status',
    'launch_date',
  ]);

  const { sequence, firstStep } = getLaunchStep(listDir);
  const secondStep = getStep(sequence.steps, 2);

  const selected = filterRows(csvRows, { filter }).filter(({ row }) => {
    const previewId = String(row.launch_preview_id || row.draft_id || '').trim();
    const alreadySent = String(row.launch_execution_ref || row.thread_id || '').trim()
      || String(row.launch_executed_at || row.sent_at || '').trim();
    return previewId && !alreadySent;
  });

  const summary = {
    rows_considered: selected.length,
    executed: 0,
    sent: 0,
    failed_send: 0,
    sequence_initialized: 0,
    errors: [],
  };
  emitActivity({
    event: 'phase_start',
    phase: 'launch_send',
    rows: selected.length,
  });

  for (let i = 0; i < selected.length; i += 1) {
    const { row, index } = selected[i];

    try {
      const stepConfig = getExecutionStepConfig(firstStep);
      const previewId = String(row.launch_preview_id || row.draft_id || '');
      const result = await executeStep({
        listDir,
        phase: 'sequence_launch_send',
        stepId: 'sequence_step_1_send',
        description: String(firstStep.description || 'launch send'),
        stepConfig,
        row,
        context: {
          mode: 'execute',
          legacy_mode: 'send',
          preview_id: previewId,
          draft_id: previewId,
        },
        ...getStepRuntimeOverrides(stepConfig),
      });

      const executedFlag = String(
        result.artifacts?.executed
        || result.outputs?.executed
        || result.artifacts?.sent
        || result.outputs?.sent
        || 'true'
      ).toLowerCase() !== 'false';
      if (!executedFlag) {
        throw new Error(result.error || 'execute-step returned executed=false');
      }

      const sentAtIso = new Date().toISOString();
      const executionRef = getExecutionRef(result, row);
      const messageId = String(result.artifacts?.message_id || result.outputs?.message_id || '');

      row.launch_execution_ref = executionRef;
      row.launch_executed_at = sentAtIso;
      row.launch_execute_status = 'sent';
      row.launch_execute_error = '';
      row.thread_id = executionRef;
      row.message_id = messageId;
      row.sent_at = sentAtIso;
      row.send_status = 'sent';
      row.send_error = '';
      row.last_outreach_date = sentAtIso.slice(0, 10);
      row.launch_date = sentAtIso.slice(0, 10);
      row.sequence_step = '1';

      if (secondStep) {
        row.next_action_date = addDays(row.launch_date, Number(secondStep.day || 0));
        row.sequence_status = 'active';
      } else {
        row.next_action_date = '';
        row.sequence_status = 'completed';
      }

      summary.sent += 1;
      summary.executed += 1;
      summary.sequence_initialized += 1;
      emitActivity({
        event: 'row_complete',
        phase: 'launch_send',
        row: String(row.business_name || row.name || row._row_id || ''),
        sent: true,
      });
    } catch (error) {
      row.launch_execute_status = 'failed';
      row.launch_execute_error = error.message;
      row.send_status = 'failed';
      row.send_error = error.message;
      summary.failed_send += 1;
      summary.errors.push({ index, row: getRowLabel(row), error: error.message });
      emitActivity({
        event: 'error',
        phase: 'launch_send',
        row: String(row.business_name || row.name || row._row_id || ''),
        detail: error.message,
      });
    }

    if (i < selected.length - 1 && staggerSeconds > 0) {
      await sleep(Number(staggerSeconds) * 1000);
    }
  }

  writeCSV(csvPath, headers, csvRows);
  try {
    summary.destination_sync = await syncDestinations({
      listDir,
      outboundConfig,
      headers,
      rows: csvRows,
    });
  } catch (error) {
    summary.destination_sync = { synced: false, error: error.message };
    summary.errors.push({ error: error.message });
  }
  emitActivity({
    event: 'phase_complete',
    phase: 'launch_send',
    sent: summary.sent,
    failed_send: summary.failed_send,
    errors: summary.errors.length,
  });

  return summary;
};

export const getLaunchStatus = ({ listDir }) => {
  const csvPath = getCanonicalCsvPath(listDir);
  if (!existsSync(csvPath)) {
    throw new Error('No canonical prospects CSV found.');
  }

  const { rows } = readCSV(csvPath);
  const summary = {
    rows_total: rows.length,
    previewed: 0,
    executed: 0,
    drafted: 0,
    sent: 0,
    pending: 0,
    failed_draft: 0,
    failed_send: 0,
  };

  for (const row of rows) {
    const sendStatus = String(row.launch_execute_status || row.send_status || '').trim();
    const draftStatus = String(row.launch_preview_status || row.draft_status || '').trim();
    const hasDraft = String(row.launch_preview_id || row.draft_id || '').trim();
    const hasSent = String(row.launch_execution_ref || row.thread_id || '').trim()
      || String(row.launch_executed_at || row.sent_at || '').trim();

    if (hasSent || sendStatus === 'sent') {
      summary.executed += 1;
      summary.sent += 1;
      continue;
    }
    if (sendStatus === 'failed') {
      summary.failed_send += 1;
      continue;
    }
    if (hasDraft || draftStatus === 'created') {
      summary.previewed += 1;
      summary.drafted += 1;
      continue;
    }
    if (draftStatus === 'failed') {
      summary.failed_draft += 1;
      continue;
    }
    summary.pending += 1;
  }

  return summary;
};
