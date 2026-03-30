import { existsSync } from 'node:fs';
import { parallel } from 'radash';
import { ensureColumns, readCSV, writeCSV } from '../lib/csv.js';
import { executeStep } from '../actions/execute-step.js';
import { readYaml } from '../lib/yaml.js';
import { getStepRuntimeOverrides } from '../lib/step-runtime.js';
import { getExecutionStepConfig } from '../lib/step-config.js';
import {
  appendOutcome,
  getLaunchDate,
  getNextActionDate,
  getSequence,
  getStep,
  shouldRunStep,
} from './config.js';
import {
  ensureCanonicalCsvExists,
  ensureRuntimeDirs,
  getCanonicalCsvPath,
  resolveVirtualPath,
  syncDestinations,
} from '../lib/runtime.js';
import { emitActivity } from '../lib/activity.js';

const formatDate = (date = new Date()) => date.toISOString().slice(0, 10);
const getRowLabel = (row) => String(row?._row_id || '').trim() || 'row';
const isOperatorAction = (action) => {
  const normalized = String(action || '').trim().toLowerCase();
  return ['operator', 'manual', 'call'].includes(normalized);
};
const rowSearchText = (row) =>
  Object.entries(row || {})
    .filter(([key]) => !String(key).startsWith('_'))
    .map(([, value]) => String(value || '').toLowerCase())
    .join(' ');
const getFollowupPreviewId = (row) => String(row.followup_preview_id || row.followup_draft_id || '');
const getFollowupPreviewStatus = (row) => String(row.followup_preview_status || row.followup_draft_status || '');
const getFollowupPreviewStep = (row) => Number(row.followup_preview_step || row.followup_draft_step || 0);

const filterRows = (rows, { filter, rowRange }) => {
  let selected = rows.map((row, index) => ({ row, index }));

  if (rowRange) {
    const [startRaw, endRaw] = String(rowRange).split('-');
    const start = Number(startRaw);
    const end = Number(endRaw);
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

const advanceAfterSkip = ({ row, sequenceSteps, skippedStepNumber }) => {
  row.sequence_step = String(skippedStepNumber);
  const nextActionDate = getNextActionDate({
    row,
    steps: sequenceSteps,
    completedStepNumber: skippedStepNumber,
  });

  if (!nextActionDate) {
    row.sequence_status = 'completed';
    row.next_action_date = '';
    return null;
  }

  row.sequence_status = 'active';
  row.next_action_date = nextActionDate;
  return getStep(sequenceSteps, skippedStepNumber + 1);
};

const getDueStep = ({ row, sequenceSteps, today }) => {
  let dueStepNumber = Number(row.sequence_step || 0) + 1;
  let step = getStep(sequenceSteps, dueStepNumber);

  while (step) {
    if (shouldRunStep(step, row)) {
      return { step, stepNumber: dueStepNumber };
    }

    step = advanceAfterSkip({ row, sequenceSteps, skippedStepNumber: dueStepNumber });
    if (!step) return { step: null, stepNumber: null };
    dueStepNumber += 1;

    const nextActionDate = String(row.next_action_date || '').trim();
    if (nextActionDate && today && nextActionDate > today) {
      return { step: null, stepNumber: null };
    }
  }

  row.sequence_status = 'completed';
  row.next_action_date = '';
  return { step: null, stepNumber: null };
};

const buildStepEntry = ({ row, step, stepNumber }) => ({
  row_id: String(row._row_id || ''),
  step: stepNumber,
  action: step.action,
  next_action_date: row.next_action_date || '',
  description: String(step.description || ''),
});

const completeStepAndAdvance = ({ row, stepNumber, steps, statusIfComplete = 'completed' }) => {
  row.sequence_step = String(stepNumber);
  row.last_outreach_date = formatDate();

  const nextActionDate = getNextActionDate({
    row,
    steps,
    completedStepNumber: stepNumber,
  });

  if (!nextActionDate) {
    row.sequence_status = statusIfComplete;
    row.next_action_date = '';
    return;
  }

  row.sequence_status = 'active';
  row.next_action_date = nextActionDate;
};

const maybeDetectReply = async ({ listDir, sequenceConfig, row }) => {
  const replyConfig = sequenceConfig?.reply_check;
  if (!replyConfig || typeof replyConfig !== 'object') {
    return { replied: false, reply_date: '', snippet: '' };
  }

  const result = await executeStep({
    listDir,
    phase: 'sequence_reply_check',
    stepId: 'sequence_reply_check',
    description: 'reply detection',
    stepConfig: replyConfig,
    row,
    context: {
      mode: 'reply_check',
      after_date: String(row.last_outreach_date || row.sent_at || '').slice(0, 10) || '1970-01-01',
    },
    ...getStepRuntimeOverrides(replyConfig),
  });

  const replied = String(result.outputs?.replied || result.artifacts?.replied || 'false').toLowerCase() === 'true';
  const content = String(
    result.outputs?.content
    || result.outputs?.text
    || result.outputs?.snippet
    || result.artifacts?.content
    || result.artifacts?.text
    || result.artifacts?.snippet
    || ''
  );
  return {
    replied,
    reply_date: String(result.outputs?.reply_date || result.artifacts?.reply_date || ''),
    content,
  };
};

export const runSequencer = async ({ listDir, dryRun = false }) => {
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

  const sequence = getSequence(listDir);
  const sequenceSteps = Array.isArray(sequence.steps) ? sequence.steps : [];
  if (sequenceSteps.length === 0) {
    throw new Error('Resolved sequence has no steps.');
  }

  const { headers: csvHeaders, rows } = readCSV(csvPath);
  const headers = ensureColumns(csvHeaders, [
    'sequence_step',
    'sequence_status',
    'next_action_date',
    'sequence_outcome',
    'last_outreach_date',
    'followup_draft_id',
    'followup_draft_message_id',
    'followup_draft_status',
    'followup_draft_error',
    'followup_draft_created_at',
    'followup_draft_step',
    'followup_preview_id',
    'followup_preview_ref',
    'followup_preview_status',
    'followup_preview_error',
    'followup_preview_created_at',
    'followup_preview_step',
    'last_reply_date',
    'last_reply_snippet',
    'last_reply_content',
    'launch_date',
  ]);

  const today = formatDate();
  const dueRows = rows.filter((row) =>
    String(row.sequence_status || '').trim() === 'active'
    && String(row.next_action_date || '').trim()
    && String(row.next_action_date).trim() <= today
  );

  const summary = {
    dry_run: dryRun,
    rows_due: dueRows.length,
    replies_detected: 0,
    paused_as_engaged: 0,
    operator_due: 0,
    automated_due: 0,
    calls_due: 0,
    manuals_due: 0,
    followup_candidates: 0,
    followup_drafts_created: 0,
    followup_already_drafted: 0,
    followup_failures: 0,
    call_list: [],
    manual_list: [],
    operator_list: [],
    followup_list: [],
    errors: [],
  };
  emitActivity({
    event: 'phase_start',
    phase: 'sequencer',
    due_rows: dueRows.length,
    dry_run: Boolean(dryRun),
  });

  for (const row of dueRows) {
    row.launch_date = getLaunchDate(row);
  }

  // Phase 1: Reply detection in parallel
  if (sequence.on_reply === 'pause' && !dryRun) {
    emitActivity({
      event: 'step_start',
      phase: 'reply_detection',
      rows: dueRows.length,
    });
    await parallel(10, dueRows, async (row) => {
      try {
        const reply = await maybeDetectReply({ listDir, sequenceConfig: outboundConfig.sequence, row });
        if (reply.replied) {
          row._reply_detected = true;
          row.sequence_status = 'engaged';
          row.next_action_date = '';
          row.last_reply_date = reply.reply_date || today;
          row.last_reply_content = reply.content;
          row.last_reply_snippet = reply.content;
          row.sequence_outcome = appendOutcome(
            row.sequence_outcome,
            `[${today}] reply_detected: ${reply.content || 'Prospect replied'}`
          );
          emitActivity({
            event: 'row_complete',
            phase: 'reply_detection',
            row: String(row.business_name || row.name || row._row_id || ''),
            replied: true,
          });
        }
      } catch (error) {
        summary.errors.push({
          row: getRowLabel(row),
          step: row.sequence_step || '',
          error: error.message,
        });
        emitActivity({
          event: 'error',
          phase: 'reply_detection',
          row: String(row.business_name || row.name || row._row_id || ''),
          detail: error.message,
        });
      }
    });

    for (const row of dueRows) {
      if (row._reply_detected) {
        summary.replies_detected += 1;
        summary.paused_as_engaged += 1;
        delete row._reply_detected;
      }
    }
    emitActivity({
      event: 'step_complete',
      phase: 'reply_detection',
      replies_detected: summary.replies_detected,
      paused_as_engaged: summary.paused_as_engaged,
    });
  }

  // Phase 2: Classify due rows (sequential — cheap, no LLM calls)
  const rowsToDraft = [];

  for (const row of dueRows) {
    if (row.sequence_status === 'engaged') continue;

    const rowForEvaluation = dryRun ? { ...row } : row;
    const { step, stepNumber } = getDueStep({ row: rowForEvaluation, sequenceSteps, today });
    if (!step || !stepNumber) continue;

    if (isOperatorAction(step.action)) {
      summary.operator_due += 1;
      const entry = buildStepEntry({ row, step, stepNumber });
      summary.operator_list.push(entry);
      if (String(step.action || '').trim().toLowerCase() === 'call') {
        summary.calls_due += 1;
        summary.call_list.push(entry);
      }
      if (String(step.action || '').trim().toLowerCase() === 'manual') {
        summary.manuals_due += 1;
        summary.manual_list.push(entry);
      }
      continue;
    }

    summary.automated_due += 1;
    summary.followup_candidates += 1;
    summary.followup_list.push(buildStepEntry({ row, step, stepNumber }));

    const existingDraftForStep =
      getFollowupPreviewId(row).trim()
      && getFollowupPreviewStatus(row).trim() === 'created'
      && getFollowupPreviewStep(row) === stepNumber;

    if (existingDraftForStep) {
      summary.followup_already_drafted += 1;
      continue;
    }

    if (!dryRun) {
      rowsToDraft.push({ row, step, stepNumber });
    }
  }

  // Phase 3: Follow-up drafting in parallel
  if (rowsToDraft.length > 0) {
    emitActivity({
      event: 'step_start',
      phase: 'followup_draft',
      rows: rowsToDraft.length,
    });
    await parallel(10, rowsToDraft, async ({ row, step, stepNumber }) => {
      try {
        const stepConfig = getExecutionStepConfig(step);
        const result = await executeStep({
          listDir,
          phase: 'sequence_followup_draft',
          stepId: `sequence_step_${stepNumber}_draft`,
          description: String(step.description || `step ${stepNumber} draft`),
          stepConfig,
          row,
          context: {
            mode: 'draft_followup',
            step_number: stepNumber,
          },
          ...getStepRuntimeOverrides(stepConfig),
        });

        const draftId = String(result.artifacts?.draft_id || result.outputs?.draft_id || '');
        const messageId = String(result.artifacts?.message_id || result.outputs?.message_id || '');

        row.followup_preview_id = draftId;
        row.followup_preview_ref = messageId;
        row.followup_preview_status = draftId ? 'created' : 'failed';
        row.followup_preview_error = draftId ? '' : (result.error || 'Preview response missing preview_id');
        row.followup_preview_created_at = new Date().toISOString();
        row.followup_preview_step = String(stepNumber);
        row.followup_draft_id = draftId;
        row.followup_draft_message_id = messageId;
        row.followup_draft_status = draftId ? 'created' : 'failed';
        row.followup_draft_error = draftId ? '' : (result.error || 'Draft response missing draft_id');
        row.followup_draft_created_at = row.followup_preview_created_at;
        row.followup_draft_step = String(stepNumber);

        if (draftId) summary.followup_drafts_created += 1;
        else summary.followup_failures += 1;
        emitActivity({
          event: 'row_complete',
          phase: 'followup_draft',
          step: String(stepNumber),
          row: String(row.business_name || row.name || row._row_id || ''),
          drafted: Boolean(draftId),
        });
      } catch (error) {
        summary.followup_failures += 1;
        row.followup_preview_status = 'failed';
        row.followup_preview_error = error.message;
        row.followup_preview_step = String(stepNumber);
        row.followup_draft_status = 'failed';
        row.followup_draft_error = error.message;
        row.followup_draft_step = String(stepNumber);
        summary.errors.push({
          row: getRowLabel(row),
          step: stepNumber,
          error: error.message,
        });
        emitActivity({
          event: 'error',
          phase: 'followup_draft',
          step: String(stepNumber),
          row: String(row.business_name || row.name || row._row_id || ''),
          detail: error.message,
        });
      }
    });
    emitActivity({
      event: 'step_complete',
      phase: 'followup_draft',
      drafted: summary.followup_drafts_created,
      failed: summary.followup_failures,
    });
  }

  if (!dryRun) {
    writeCSV(csvPath, headers, rows);
    try {
      summary.destination_sync = await syncDestinations({
        listDir,
        outboundConfig,
        headers,
        rows,
      });
    } catch (error) {
      summary.destination_sync = { synced: false, error: error.message };
      summary.errors.push({ error: error.message });
    }
  }
  emitActivity({
    event: 'phase_complete',
    phase: 'sequencer',
    rows_due: summary.rows_due,
    replies_detected: summary.replies_detected,
    followup_drafts_created: summary.followup_drafts_created,
    followup_failures: summary.followup_failures,
    errors: summary.errors.length,
  });

  return summary;
};

export const getSequenceStatus = ({ listDir }) => {
  const csvPath = getCanonicalCsvPath(listDir);
  if (!existsSync(csvPath)) {
    throw new Error('No canonical prospects CSV found.');
  }

  const sequence = getSequence(listDir);
  const sequenceSteps = Array.isArray(sequence.steps) ? sequence.steps : [];
  const { rows } = readCSV(csvPath);
  const today = formatDate();
  const counts = { active: 0, engaged: 0, completed: 0, opted_out: 0, bounced: 0, no_sequence: 0 };
  const due = { calls: [], manuals: [], operators: [], followups: [] };

  for (const row of rows) {
    const status = String(row.sequence_status || '').trim();
    if (!status) counts.no_sequence += 1;
    else if (counts[status] != null) counts[status] += 1;
    else counts.no_sequence += 1;

    if (status !== 'active') continue;
    const dueDate = String(row.next_action_date || '').trim();
    if (!dueDate || dueDate > today) continue;

    const { step, stepNumber } = getDueStep({ row: { ...row }, sequenceSteps, today });
    if (!step) continue;

    const entry = buildStepEntry({ row, step, stepNumber });
    if (isOperatorAction(step.action)) {
      due.operators.push(entry);
      if (String(step.action || '').trim().toLowerCase() === 'call') due.calls.push(entry);
      else if (String(step.action || '').trim().toLowerCase() === 'manual') due.manuals.push(entry);
    } else {
      due.followups.push(entry);
    }
  }

  return {
    total_rows: rows.length,
    sequence_steps: sequenceSteps.length,
    counts,
    due_today: {
      calls: due.calls.length,
      manuals: due.manuals.length,
      operators: due.operators.length,
      followups: due.followups.length,
      call_list: due.calls,
      manual_list: due.manuals,
      operator_list: due.operators,
      followup_list: due.followups,
    },
  };
};

export const runFollowupSend = async ({
  listDir,
  filter,
  rowRange,
  staggerSeconds = 3,
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

  const sequence = getSequence(listDir);
  const sequenceSteps = Array.isArray(sequence.steps) ? sequence.steps : [];
  if (sequenceSteps.length === 0) {
    throw new Error('Resolved sequence has no steps.');
  }

  const { headers: csvHeaders, rows } = readCSV(csvPath);
  const headers = ensureColumns(csvHeaders, [
    'followup_draft_id',
    'followup_draft_status',
    'followup_draft_error',
    'followup_draft_step',
    'followup_preview_id',
    'followup_preview_status',
    'followup_preview_error',
    'followup_preview_step',
    'followup_sent_at',
    'thread_id',
    'message_id',
    'sequence_step',
    'sequence_status',
    'next_action_date',
    'last_outreach_date',
    'launch_date',
  ]);

  const selected = filterRows(rows, { filter, rowRange }).filter(({ row }) =>
    getFollowupPreviewId(row).trim()
    && String(row.sequence_status || '').trim() === 'active'
  );

  const summary = {
    rows_considered: selected.length,
    sent: 0,
    skipped_invalid_step: 0,
    failed_send: 0,
    sequence_advanced: 0,
    errors: [],
  };
  emitActivity({
    event: 'phase_start',
    phase: 'followup_send',
    rows: selected.length,
  });

  for (let i = 0; i < selected.length; i += 1) {
    const { row, index } = selected[i];
    row.launch_date = getLaunchDate(row);

    const stepNumber = getFollowupPreviewStep(row) || (Number(row.sequence_step || 0) + 1);
    const step = getStep(sequenceSteps, stepNumber);

    if (!step) {
      summary.skipped_invalid_step += 1;
      const error = `Invalid follow-up step (${stepNumber}).`;
      row.followup_draft_error = error;
      row.followup_preview_error = error;
      summary.errors.push({ index, row: getRowLabel(row), error });
      continue;
    }

    try {
      const stepConfig = getExecutionStepConfig(step);
      const result = await executeStep({
        listDir,
        phase: 'sequence_followup_send',
        stepId: `sequence_step_${stepNumber}_send`,
        description: String(step.description || `step ${stepNumber} send`),
        stepConfig,
        row,
        context: {
          mode: 'send_followup',
          step_number: stepNumber,
          preview_id: getFollowupPreviewId(row),
          draft_id: String(row.followup_draft_id || ''),
        },
        ...getStepRuntimeOverrides(stepConfig),
      });

      const sent = String(result.artifacts?.sent || result.outputs?.sent || 'true').toLowerCase() !== 'false';
      if (!sent) {
        throw new Error(result.error || 'execute-step returned sent=false');
      }

      const sentAtIso = new Date().toISOString();
      row.thread_id = String(result.artifacts?.thread_id || result.outputs?.thread_id || row.thread_id || '');
      row.message_id = String(result.artifacts?.message_id || result.outputs?.message_id || row.message_id || '');
      row.followup_sent_at = sentAtIso;
      row.last_outreach_date = sentAtIso.slice(0, 10);

      completeStepAndAdvance({
        row,
        stepNumber,
        steps: sequenceSteps,
        statusIfComplete: 'completed',
      });

      row.followup_preview_status = '';
      row.followup_preview_error = '';
      row.followup_preview_id = '';
      row.followup_preview_step = '';
      row.followup_draft_status = '';
      row.followup_draft_error = '';
      row.followup_draft_id = '';
      row.followup_draft_step = '';

      summary.sent += 1;
      summary.sequence_advanced += 1;
      emitActivity({
        event: 'row_complete',
        phase: 'followup_send',
        step: String(stepNumber),
        row: String(row.business_name || row.name || row._row_id || ''),
        sent: true,
      });
    } catch (error) {
      row.followup_preview_status = 'failed';
      row.followup_preview_error = error.message;
      row.followup_draft_status = 'failed';
      row.followup_draft_error = error.message;
      summary.failed_send += 1;
      summary.errors.push({ index, row: getRowLabel(row), error: error.message });
      emitActivity({
        event: 'error',
        phase: 'followup_send',
        step: String(stepNumber),
        row: String(row.business_name || row.name || row._row_id || ''),
        detail: error.message,
      });
    }

    if (i < selected.length - 1 && staggerSeconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, Number(staggerSeconds) * 1000));
    }
  }

  writeCSV(csvPath, headers, rows);
  try {
    summary.destination_sync = await syncDestinations({
      listDir,
      outboundConfig,
      headers,
      rows,
    });
  } catch (error) {
    summary.destination_sync = { synced: false, error: error.message };
    summary.errors.push({ error: error.message });
  }
  emitActivity({
    event: 'phase_complete',
    phase: 'followup_send',
    sent: summary.sent,
    failed_send: summary.failed_send,
    errors: summary.errors.length,
  });

  return summary;
};

export const logOutcome = async ({ listDir, prospect, action, note, transition }) => {
  ensureRuntimeDirs(listDir);
  ensureCanonicalCsvExists(listDir);

  const csvPath = getCanonicalCsvPath(listDir);
  if (!existsSync(csvPath)) {
    throw new Error('No canonical prospects CSV found.');
  }

  const outboundConfig = readYaml(resolveVirtualPath({
    listDir,
    filePath: '@list/outbound.yaml',
    allowRelative: false,
  }));
  if (outboundConfig._raw) {
    throw new Error('Could not parse outbound.yaml.');
  }

  const sequence = getSequence(listDir);
  const sequenceSteps = Array.isArray(sequence.steps) ? sequence.steps : [];

  const { headers: csvHeaders, rows } = readCSV(csvPath);
  const headers = ensureColumns(csvHeaders, [
    'sequence_status',
    'sequence_outcome',
    'sequence_step',
    'next_action_date',
    'last_outreach_date',
    'followup_draft_id',
    'followup_draft_status',
    'followup_draft_error',
    'followup_draft_step',
    'followup_preview_id',
    'followup_preview_status',
    'followup_preview_error',
    'followup_preview_step',
    'launch_date',
  ]);

  const searchTerm = String(prospect || '').toLowerCase().trim();
  const matches = rows.filter((row) => rowSearchText(row).includes(searchTerm));
  if (matches.length === 0) {
    return { error: `No prospect matching "${prospect}" found.` };
  }
  if (matches.length > 1) {
    return {
      error: `Multiple prospects match "${prospect}". Be more specific.`,
      matches: matches.map((row) => String(row._row_id || '')),
    };
  }

  const row = matches[0];
  row.launch_date = getLaunchDate(row);
  const today = formatDate();
  row.sequence_outcome = appendOutcome(row.sequence_outcome, `[${today}] ${action}: ${note || ''}`.trim());
  emitActivity({
    event: 'log_outcome',
    phase: 'operator',
    prospect: String(row.business_name || row.name || row._row_id || ''),
    action: String(action || ''),
    transition: String(transition || ''),
  });

  const actionText = String(action || '').trim();
  const transitionText = String(transition || '').trim().toLowerCase();
  const transitionState = ['engaged', 'opted_out', 'bounced', 'completed', 'step_advanced'].includes(transitionText)
    ? transitionText
    : '';

  if (transitionState === 'engaged') {
    row.sequence_status = 'engaged';
    row.next_action_date = '';
  } else if (transitionState === 'opted_out') {
    row.sequence_status = 'opted_out';
    row.next_action_date = '';
  } else if (transitionState === 'bounced') {
    row.sequence_status = 'bounced';
    row.next_action_date = '';
  } else if (transitionState === 'completed') {
    row.sequence_status = 'completed';
    row.next_action_date = '';
  } else if (transitionState === 'step_advanced') {
    const currentStepNumber = Number(row.sequence_step || 0) + 1;

    completeStepAndAdvance({
      row,
      stepNumber: currentStepNumber || Number(row.sequence_step || 0),
      steps: sequenceSteps,
      statusIfComplete: 'completed',
    });

    row.followup_preview_status = '';
    row.followup_preview_error = '';
    row.followup_preview_id = '';
    row.followup_preview_step = '';
    row.followup_draft_status = '';
    row.followup_draft_error = '';
    row.followup_draft_id = '';
    row.followup_draft_step = '';
  }

  writeCSV(csvPath, headers, rows);
  let destinationSync;
  try {
    destinationSync = await syncDestinations({
      listDir,
      outboundConfig,
      headers,
      rows,
    });
  } catch (error) {
    destinationSync = { synced: false, error: error.message };
  }

  return {
    status: 'updated',
    prospect: String(row._row_id || ''),
    sequence_status: row.sequence_status,
    sequence_step: row.sequence_step,
    next_action_date: row.next_action_date,
    destination_sync: destinationSync,
  };
};
