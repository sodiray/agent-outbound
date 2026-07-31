import { executeEnrichmentStepOnRecords } from '../enrichment/runner.js';
import { evaluateFieldCheckGroup, evaluateSemanticFilterBatches } from '../lib/conditions.js';
import { resolveFieldCheckConditions } from '../lib/field-check-values.js';
import { getRecordRowId } from '../lib/record.js';
import { upsertRecord } from '../runtime/db.js';
import {
  flattenPipelineSteps,
  PIPELINE_ROUTE_TARGET,
  stepSubpipelineName,
  SUBPIPELINE_STEP_INDEX_FIELD,
} from '../lib/subpipelines.js';
import { executePipelineSequenceAction } from './sequence-step-runtime.js';

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

const executeFieldCheckBatch = async (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  rows: Array<Record<string, unknown>>,
) => {
  const conditions = Array.isArray(step.conditions) ? step.conditions : [];
  const resolvedConditions = conditions.some((condition) => String((condition as Record<string, unknown>)?.value_file || '').trim())
    ? resolveFieldCheckConditions({ conditions, listDir: ctx.listDir })
    : conditions;
  const outcomes = new Map<string, StepExecutionOutcome>();
  rows.forEach((row) => {
    const recordId = getRecordRowId(row);
    try {
      outcomes.set(recordId, outcomeFor(evaluateFieldCheckGroup({
        row,
        conditions: resolvedConditions,
        match: step.match || 'all',
        listDir: ctx.listDir,
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
      listDir: ctx.listDir,
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

const assignRuleName = (rule: Record<string, unknown>, index: number) => (
  textValue(rule.id) || textValue(rule.sequence) || textValue(rule.pipeline) || `rule_${index + 1}`
);

const executeAssignBatch = async (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  stepId: string,
  rows: Array<Record<string, unknown>>,
) => {
  const rules = Array.isArray(step.rules) ? step.rules as Array<Record<string, unknown>> : [];
  const fallback = textValue(step.fallback);
  const target = textValue(step.target, 'sequence_name');
  const destinationKey = target === PIPELINE_ROUTE_TARGET ? 'pipeline' : 'sequence';
  const outcomes = new Map<string, StepExecutionOutcome>();
  const idleRows = rows.filter((row) => {
    const recordId = getRecordRowId(row);
    const status = textValue(row.sequence_status, 'idle');
    if (status === 'idle') return true;
    outcomes.set(recordId, { passed: true, reason: `sequence_status_not_idle:${status}` });
    return false;
  });
  const remaining = new Map(idleRows.map((row) => [getRecordRowId(row), row]));

  const assignRows = (
    matchedRows: Array<Record<string, unknown>>,
    destination: string,
    routedBy: string,
  ) => {
    matchedRows.forEach((row) => {
      const recordId = getRecordRowId(row);
      try {
        upsertRecord({
          db: ctx.db,
          row: {
            ...row,
            [target]: destination,
            routed_by: routedBy,
          },
        });
        outcomes.set(recordId, { passed: true, reason: `assigned:${destination}:${routedBy}` });
      } catch (error) {
        outcomes.set(recordId, {
          passed: false,
          reason: String((error as Error)?.message || error),
          errored: true,
        });
      }
      remaining.delete(recordId);
    });
  };

  for (const [ruleIndex, rule] of rules.entries()) {
    const candidates = Array.from(remaining.values());
    if (candidates.length === 0) break;
    const destination = textValue(rule[destinationKey]);
    const routedBy = assignRuleName(rule, ruleIndex);
    const type = textValue(rule.type, 'field_check').toLowerCase();
    if (type === 'semantic') {
      const semanticOutcomes = await evaluateSemanticFilterBatches({
        db: ctx.db,
        listDir: ctx.listDir,
        filter: {
          ...rule,
          id: `${stepId}:${routedBy}`,
        },
        rows: candidates,
        aiConfig: ctx.aiConfig || ctx.config?.ai || {},
        batchSize: Number(step.batch_size || 10),
      });
      const matched = candidates.filter((row) => {
        const result = semanticOutcomes.get(getRecordRowId(row));
        return result?.passed && !result.errored;
      });
      candidates.forEach((row) => {
        const recordId = getRecordRowId(row);
        const result = semanticOutcomes.get(recordId);
        if (!result?.errored) return;
        outcomes.set(recordId, {
          passed: false,
          reason: String(result.reason || 'semantic_assignment_failed'),
          errored: true,
        });
        remaining.delete(recordId);
      });
      assignRows(matched, destination, routedBy);
      continue;
    }
    if (type !== 'field_check') {
      candidates.forEach((row) => {
        const recordId = getRecordRowId(row);
        outcomes.set(recordId, {
          passed: false,
          reason: `unsupported_assign_rule_type:${type}`,
          errored: true,
        });
        remaining.delete(recordId);
      });
      continue;
    }
    const matched = candidates.filter((row) => evaluateFieldCheckGroup({
      row,
      conditions: Array.isArray(rule.conditions) ? rule.conditions : [],
      match: textValue(rule.match, 'all'),
      listDir: ctx.listDir,
    }).passed);
    assignRows(matched, destination, routedBy);
  }

  assignRows(Array.from(remaining.values()), fallback, 'fallback');
  return outcomes;
};

const channelForPipelineKind = (kind: string) => ({
  send_email: 'email',
  send_sms: 'sms',
  linkedin_connect: 'linkedin',
  manual_task: 'manual',
})[kind] || 'manual';

const executeSequenceActionBatch = async (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  stepId: string,
  rows: Array<Record<string, unknown>>,
) => {
  const pipeline = flattenPipelineSteps(ctx.config);
  const configuredIndex = pipeline.findIndex((entry) => textValue(entry.id) === stepId);
  const nestedStepIndex = Number(step[SUBPIPELINE_STEP_INDEX_FIELD]);
  const stepNumber = Number.isInteger(nestedStepIndex)
    ? nestedStepIndex + 1
    : (configuredIndex >= 0 ? configuredIndex + 1 : 1);
  const kind = textValue(step.kind);
  const entries = await Promise.all(rows.map(async (row) => {
    const recordId = getRecordRowId(row);
    const sequenceName = stepSubpipelineName(step) || textValue(row.sequence_name, 'default');
    try {
      const result = await executePipelineSequenceAction({
        mcp: ctx.mcp,
        listDir: ctx.listDir,
        listName: textValue((ctx.config?.list as Record<string, unknown> | undefined)?.name),
        toolCatalog: ctx.toolCatalog,
        db: ctx.db,
        record: row,
        config: ctx.config,
        sequenceName,
        stepNumber,
        step,
        sequence: { steps: [] },
        aiConfig: ctx.aiConfig || ctx.config?.ai || {},
        dryRun: false,
        intent: 'send',
        channelHint: channelForPipelineKind(kind),
      });
      const status = textValue(result?.status);
      const reason = textValue(result?.reason);
      const idempotentSkip = status === 'skipped' && /already sent/i.test(reason);
      if (status === 'sent' || idempotentSkip) {
        return [recordId, { passed: true, reason }] as const;
      }
      return [
        recordId,
        {
          passed: false,
          reason: reason || `pipeline_${kind}_did_not_complete`,
          errored: true,
        },
      ] as const;
    } catch (error) {
      return [
        recordId,
        {
          passed: false,
          reason: String((error as Error)?.message || error),
          errored: true,
        },
      ] as const;
    }
  }));
  return new Map<string, StepExecutionOutcome>(entries);
};

export const executeStepBatch = async (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  stepId: string,
  rows: Array<Record<string, unknown>>,
): Promise<Map<string, StepExecutionOutcome>> => {
  const kind = textValue(step.kind);
  if (kind === 'filter' || kind === 'exit') {
    const filterType = textValue(step.type, 'semantic').toLowerCase();
    if (filterType === 'field_check') return executeFieldCheckBatch(ctx, step, rows);
    if (filterType === 'semantic') return executeSemanticFilterBatch(ctx, step, rows);
    throw new Error(`unsupported_pipeline_filter_type:${filterType}`);
  }

  if (kind === 'wait') {
    return new Map(rows.map((row) => [
      getRecordRowId(row),
      { passed: true, reason: '' },
    ]));
  }

  if (kind === 'manual_task') {
    // Always park — never LLM-execute a human task.
    return new Map(rows.map((row) => [
      getRecordRowId(row),
      { passed: false, reason: 'awaiting_manual' },
    ]));
  }

  if (['send_email', 'send_sms', 'linkedin_connect'].includes(kind)) {
    return executeSequenceActionBatch(ctx, step, stepId, rows);
  }

  if (kind === 'enrich') return executeEnrichBatch(ctx, step, stepId, rows);
  if (kind === 'assign') return executeAssignBatch(ctx, step, stepId, rows);
  if (kind === 'review') return executeReviewBatch(ctx, step, stepId, rows);

  throw new Error(`unsupported_pipeline_step_kind:${kind || 'unknown'}`);
};
