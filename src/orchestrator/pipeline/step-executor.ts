import { executeEnrichmentStepOnRecords } from '../enrichment/runner.js';
import { evaluateFieldCheckGroup, evaluateSemanticFilterBatches } from '../lib/conditions.js';
import { getRecordRowId } from '../lib/record.js';

export type StepExecutionOutcome = {
  passed: boolean;
  reason: string;
  errored?: boolean;
};

export type StepExecutionContext = {
  db: unknown;
  listDir: string;
  config?: Record<string, unknown>;
  mcp?: unknown;
  toolCatalog?: unknown;
  aiConfig?: unknown;
  force?: boolean;
};

type PipelineStepLike = Record<string, unknown> & {
  kind?: string;
  id?: string;
  type?: string;
  match?: string;
  conditions?: unknown;
  batch_size?: unknown;
  when?: unknown;
};

type QueryableDb = {
  prepare: (sql: string) => {
    all: (...params: string[]) => Array<Record<string, unknown>>;
  };
};

const textValue = (value: unknown, fallback = '') => {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text;
};

const outcomeFor = (value: { passed?: unknown; reason?: unknown; errored?: unknown }): StepExecutionOutcome => ({
  passed: Boolean(value.passed),
  reason: String(value.reason || ''),
  errored: Boolean(value.errored),
});

const executeFieldCheckBatch = async (step: PipelineStepLike, rows: Array<Record<string, unknown>>) => {
  const outcomes = new Map<string, StepExecutionOutcome>();
  rows.forEach((row) => {
    const recordId = getRecordRowId(row);
    try {
      outcomes.set(recordId, outcomeFor(evaluateFieldCheckGroup({
        row,
        conditions: Array.isArray(step.conditions) ? step.conditions : [],
        match: step.match || 'all',
      })));
    } catch (error) {
      outcomes.set(recordId, {
        passed: false,
        reason: String((error as Error)?.message || error),
        errored: true,
      });
    }
  });
  return outcomes;
};

const executeSemanticFilterBatch = async (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  rows: Array<Record<string, unknown>>,
) => {
  const semantic = await evaluateSemanticFilterBatches({
    db: ctx.db,
    listDir: ctx.listDir,
    filter: step,
    rows,
    aiConfig: ctx.aiConfig || ctx.config?.ai || {},
    batchSize: Number(step.batch_size || 10),
  });
  const outcomes = new Map<string, StepExecutionOutcome>();
  semantic.forEach((outcome, recordId) => {
    outcomes.set(recordId, outcomeFor(outcome));
  });
  return outcomes;
};

const executeEnrichBatch = async (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  stepId: string,
  rows: Array<Record<string, unknown>>,
) => {
  const result = await executeEnrichmentStepOnRecords({
    db: ctx.db,
    listDir: ctx.listDir,
    config: ctx.config || { ai: ctx.aiConfig || {} },
    mcp: ctx.mcp,
    toolCatalog: ctx.toolCatalog,
    step,
    rows,
    stepId,
    force: Boolean(ctx.force),
  });
  const failures = new Map((Array.isArray(result.errors) ? result.errors : []).map((error) => [
    String(error.record_id || '').trim(),
    String(error.error || ''),
  ]));
  const outcomes = new Map<string, StepExecutionOutcome>();
  rows.forEach((row) => {
    const recordId = getRecordRowId(row);
    const failure = failures.get(recordId);
    outcomes.set(recordId, failure
      ? { passed: false, reason: failure, errored: true }
      : { passed: true, reason: '' });
  });
  return outcomes;
};

const executeReviewBatch = async (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  stepId: string,
  rows: Array<Record<string, unknown>>,
) => {
  const matchingRows = rows.filter((row) => {
    if (!step.when || typeof step.when !== 'object') return true;
    const predicate = step.when as Record<string, unknown>;
    return evaluateFieldCheckGroup({
      row,
      conditions: Array.isArray(predicate.conditions) ? predicate.conditions : [],
      match: String(predicate.match || 'all'),
    }).passed;
  });
  const recordIds = matchingRows.map((row) => getRecordRowId(row));
  const placeholders = recordIds.map(() => '?').join(', ');
  const verdictRows = recordIds.length === 0
    ? []
    : (ctx.db as QueryableDb).prepare(`
      SELECT record_id, kind
      FROM overrides
      WHERE (cleared_at IS NULL OR cleared_at = '')
        AND record_id IN (${placeholders})
        AND (
          (kind = 'keep' AND (step_id = ? OR step_id = ''))
          OR (kind = 'drop' AND step_id = '' AND created_by = 'review:' || ?)
        )
    `).all(...recordIds, stepId, stepId);
  const verdicts = verdictRows.reduce((map, row) => {
    const recordId = String(row.record_id || '').trim();
    const kind = String(row.kind || '').trim();
    const existing = map.get(recordId);
    map.set(recordId, kind === 'drop' || existing === 'drop' ? 'drop' : 'pass');
    return map;
  }, new Map<string, 'pass' | 'drop'>());
  const matchingIds = new Set(recordIds);
  return new Map(rows.map((row) => {
    const recordId = getRecordRowId(row);
    if (!matchingIds.has(recordId)) return [recordId, { passed: true, reason: '' }];
    const verdict = verdicts.get(recordId);
    if (verdict === 'pass') return [recordId, { passed: true, reason: '' }];
    if (verdict === 'drop') return [recordId, { passed: false, reason: 'review: dropped' }];
    return [recordId, { passed: false, reason: 'awaiting_review' }];
  }));
};

export const executeStepBatch = async (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  stepId: string,
  rows: Array<Record<string, unknown>>,
): Promise<Map<string, StepExecutionOutcome>> => {
  const kind = textValue(step.kind);
  if (kind === 'filter') {
    const filterType = textValue(step.type, 'semantic').toLowerCase();
    if (filterType === 'field_check') return executeFieldCheckBatch(step, rows);
    if (filterType === 'semantic') return executeSemanticFilterBatch(ctx, step, rows);
    throw new Error(`unsupported_pipeline_filter_type:${filterType}`);
  }

  if (kind === 'enrich') return executeEnrichBatch(ctx, step, stepId, rows);
  if (kind === 'review') return executeReviewBatch(ctx, step, stepId, rows);

  throw new Error(`unsupported_pipeline_step_kind:${kind || 'unknown'}`);
};
