import { OVERRIDE_GATE } from './db.js';
import { recordScore } from '../lib/record.js';

// The lead lifecycle, derived — never stored. One function (and its SQL mirror)
// answers "where does this lead stand?" for the CLI, reports, exports, and viz.
//
//   unscored          sourced/enriched, no score yet
//   qualified         in play and scored
//   dropped_low_score dropped by the score_minimum floor
//   dropped_gate      dropped by a pipeline filter gate
//   dropped_manual    dropped by a human override
export const LEAD_STATUSES = ['unscored', 'qualified', 'dropped_low_score', 'dropped_gate', 'dropped_manual'] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

const SCORE_MINIMUM_GATE = 'score_minimum';

const nonEmpty = (value: any) => String(value || '').trim() !== '';

const isScored = (record: any) => (
  nonEmpty(record?.score_updated_at)
    || nonEmpty(record?.fit_score_updated_at)
    || Number(recordScore(record) || 0) > 0
);

export const leadStatus = (record: any): LeadStatus => {
  const gate = String(record?.disqualified_gate || '').trim();
  const dropped = nonEmpty(record?.disqualified_at);
  if (dropped && gate === OVERRIDE_GATE) return 'dropped_manual';
  if (dropped && gate === SCORE_MINIMUM_GATE) return 'dropped_low_score';
  if (dropped) return 'dropped_gate';
  return isScored(record) ? 'qualified' : 'unscored';
};

// SQL mirror of leadStatus for push-down filtering/grouping. Keep in lockstep
// with the function above. `score_updated_at` is added dynamically by the first
// scoring run, so callers pass the columns that actually exist on their db.
export const leadStatusCaseSql = ({ alias = '', availableColumns }: { alias?: string; availableColumns?: Set<string> } = {}) => {
  const has = (name: string) => !availableColumns || availableColumns.has(name);
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  const scoredClauses = [
    has('score_updated_at') ? `COALESCE(${col('score_updated_at')}, '') != ''` : '',
    has('fit_score_updated_at') ? `COALESCE(${col('fit_score_updated_at')}, '') != ''` : '',
    has('fit_score') ? `COALESCE(${col('fit_score')}, 0) > 0` : '',
    has('priority_rank') ? `COALESCE(${col('priority_rank')}, 0) > 0` : '',
  ].filter(Boolean);
  return `CASE
    WHEN COALESCE(${col('disqualified_at')}, '') != '' AND ${col('disqualified_gate')} = '${OVERRIDE_GATE}' THEN 'dropped_manual'
    WHEN COALESCE(${col('disqualified_at')}, '') != '' AND ${col('disqualified_gate')} = '${SCORE_MINIMUM_GATE}' THEN 'dropped_low_score'
    WHEN COALESCE(${col('disqualified_at')}, '') != '' THEN 'dropped_gate'
    WHEN ${scoredClauses.length > 0 ? scoredClauses.join('\n      OR ') : '0'} THEN 'qualified'
    ELSE 'unscored'
  END`;
};

export const leadStatusLabel = (status: string) => ({
  unscored: 'Unscored',
  qualified: 'Qualified',
  dropped_low_score: 'Dropped: low score',
  dropped_gate: 'Dropped: gate',
  dropped_manual: 'Dropped: manual',
}[String(status)] || String(status));
