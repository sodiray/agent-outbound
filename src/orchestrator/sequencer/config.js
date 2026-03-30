import { existsSync } from 'node:fs';
import { loadResolvedConfigFromOutbound } from '../enrichment/schema.js';
import { resolveVirtualPath } from '../lib/runtime.js';

const formatDate = (date = new Date()) => date.toISOString().slice(0, 10);

export const addDays = (yyyyMmDd, days) => {
  const base = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  if (isNaN(base.getTime())) {
    return formatDate(new Date(Date.now() + Number(days || 0) * 24 * 60 * 60 * 1000));
  }
  return new Date(base.getTime() + Number(days || 0) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
};

export const loadResolvedConfig = (listDir) => {
  const outboundPath = resolveVirtualPath({
    listDir,
    filePath: '@list/outbound.yaml',
    allowRelative: false,
  });
  if (!existsSync(outboundPath)) {
    throw new Error('No outbound.yaml found. Update outbound config first.');
  }
  return loadResolvedConfigFromOutbound(listDir);
};

export const getSequence = (listDir) => loadResolvedConfig(listDir).sequence;

export const getStep = (steps, stepNumber) => {
  if (!Array.isArray(steps) || stepNumber < 1) return null;
  return steps[stepNumber - 1] || null;
};

export const getLaunchDate = (row) => {
  const explicit = String(row.launch_date || '').trim();
  if (explicit) return explicit;

  const sentAt = String(row.sent_at || '').trim();
  if (sentAt) return sentAt.slice(0, 10);

  return formatDate();
};

export const getNextActionDate = ({ row, steps, completedStepNumber }) => {
  const nextStep = getStep(steps, Number(completedStepNumber || 0) + 1);
  if (!nextStep) return '';
  return addDays(getLaunchDate(row), Number(nextStep.day || 0));
};

export const appendOutcome = (existing, note) => {
  const base = String(existing || '').trim();
  return base ? `${base} | ${note}` : note;
};

export const shouldRunStep = (step, row) => {
  const condition = step?.config?.condition;
  if (!condition || typeof condition !== 'object') return true;

  const mode = String(condition.mode || 'only_when');
  const column = String(condition.column || '');
  const check = String(condition.check || 'equals').toLowerCase();
  const expected = String(condition.value || '').trim().toLowerCase();
  const actual = String(row?.[column] || '').trim().toLowerCase();

  let matched = false;
  if (check === 'not_equals') matched = actual !== expected;
  else if (check === 'contains') matched = actual.includes(expected);
  else if (check === 'not_contains') matched = !actual.includes(expected);
  else if (check === 'is_empty') matched = actual.length === 0;
  else if (check === 'not_empty') matched = actual.length > 0;
  else matched = actual === expected;

  return mode === 'skip_when' ? !matched : matched;
};
