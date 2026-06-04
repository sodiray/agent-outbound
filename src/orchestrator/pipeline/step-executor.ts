import { executeEnrichmentStepOnRecords } from '../enrichment/runner.js';
import { evaluateFieldCheckGroup, evaluateSemanticFilterBatches } from '../lib/conditions.js';
import { getRecordRowId } from '../lib/record.js';

export type StepExecutionOutcome = {
  passed: boolean;
  reason: string;
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
};

const textValue = (value: unknown, fallback = '') => {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text;
};

const outcomeFor = (value: { passed?: unknown; reason?: unknown }): StepExecutionOutcome => ({
  passed: Boolean(value.passed),
  reason: String(value.reason || ''),
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
      ? { passed: false, reason: failure }
      : { passed: true, reason: '' });
  });
  return outcomes;
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

  throw new Error(`unsupported_pipeline_step_kind:${kind || 'unknown'}`);
};
