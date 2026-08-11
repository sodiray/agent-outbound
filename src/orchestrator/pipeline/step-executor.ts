import { executeEnrichmentStepOnRecords } from '../enrichment/runner.js';
import { executeExtractStepOnRecords } from '../extract/runner.js';
import type { ComposeGenerator } from '../compose/runner.js';
import { evaluateFieldCheckGroup, evaluateSemanticFilterBatches } from '../lib/conditions.js';
import { resolveFieldCheckConditions } from '../lib/field-check-values.js';
import { isPresentDeclaredOutputValue } from '../lib/declared-outputs.js';
import { getRecordRowId } from '../lib/record.js';
import { randomUUID } from 'node:crypto';
import { insertDraft, upsertRecord } from '../runtime/db.js';
import {
  buildIdempotencyKey,
  claimIdempotency,
  completeIdempotency,
  failIdempotency,
} from '../runtime/idempotency.js';
import {
  flattenPipelineSteps,
  PIPELINE_ROUTE_TARGET,
  stepSubpipelineName,
  SUBPIPELINE_STEP_INDEX_FIELD,
} from '../lib/subpipelines.js';
import { isReviewRequired } from '../policy/stage-review-gate.js';
import {
  shouldRunForRecord,
  skippedWhenOutcome,
  stepConfigForWhen,
  whenPredicateForStep,
} from '../lib/step-when.js';
import { executePipelineSequenceAction } from './sequence-step-runtime.js';
import { promoteContactSource } from './contact-source.js';
import { stageInputRecord } from '../lib/stage-inputs.js';
import { runScoreStage, type ScoreStage } from '../scoring/stage-runner.js';
import type { EmailVerificationProvider } from '../runtime/providers/email-verification/index.js';
import { resolveReviewPresentation } from '../policy/review-presentation.js';

export type StepExecutionOutcome = {
  passed: boolean;
  reason: string;
  errored?: boolean;
  parked?: boolean;
  declaredOutputWrites?: Record<string, { provided: boolean; value: unknown }>;
};

export type StepExecutionContext = {
  db: unknown;
  listDir: string;
  config?: Record<string, unknown>;
  mcp?: unknown;
  toolCatalog?: unknown;
  aiConfig?: unknown;
  force?: boolean;
  now?: string;
  composeGenerateObject?: ComposeGenerator;
  emailVerificationProvider?: EmailVerificationProvider;
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
    get: (...params: string[]) => unknown;
  };
};

const textValue = (value: unknown, fallback = '') => {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text;
};

const CLAIM_ENGINE_OUTPUT_FIELDS = new Set([
  'claim_audit_passed',
  'claim_audit_json',
  'claim_audit_asset_hash',
  'permitted_claim_packet_json',
  'claim_packet_assemble_error',
  'catalog_evidence_json',
]);

const outcomeFor = (value: { passed?: unknown; reason?: unknown; errored?: unknown }): StepExecutionOutcome => ({
  passed: Boolean(value.passed),
  reason: String(value.reason || ''),
  errored: Boolean(value.errored),
});

const declaredOutputNames = (step: PipelineStepLike): string[] => {
  const config = step.config && typeof step.config === 'object' && !Array.isArray(step.config)
    ? step.config as Record<string, unknown>
    : {};
  const declaration = { ...step, ...config };
  const outputs = declaration.outputs && typeof declaration.outputs === 'object' && !Array.isArray(declaration.outputs)
    ? declaration.outputs as Record<string, unknown>
    : {};
  // An output is frequently persisted under a DIFFERENT column via `columns:`
  // — the email step declares `message_id` and stores it as
  // `email_last_message_id`. Checking the declared name against the record
  // marked a SUCCESSFUL live send as errored, which is the worst possible
  // false positive here: an errored send invites a retry, and a retry to a real
  // person is a duplicate email.
  const columns = declaration.columns && typeof declaration.columns === 'object' && !Array.isArray(declaration.columns)
    ? declaration.columns as Record<string, unknown>
    : {};
  const outputFields = declaration.output_fields && typeof declaration.output_fields === 'object' && !Array.isArray(declaration.output_fields)
    ? declaration.output_fields as Record<string, unknown>
    : {};
  return Object.keys(outputs).map((name) => {
    const mapped = String(columns[name] ?? outputFields[name] ?? '').trim();
    return mapped || name;
  });
};

const isPersistedOutputValue = isPresentDeclaredOutputValue;

export const declaredOutputsUnwritten = ({
  outputNames,
  record,
}: {
  outputNames: string[];
  record: Record<string, unknown>;
}): string[] => outputNames.filter((name) => !isPersistedOutputValue(record[name]));

const samePersistedValue = (left: unknown, right: unknown): boolean => {
  if (typeof left === 'number' && typeof right === 'number') return left === right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return left === right;
  // A value that survives a round trip through SQLite comes back in that
  // column's storage type, not the type the step produced. An INTEGER output of
  // 82 read back from a REAL column is 82.0, and comparing their string forms
  // ("82" vs "82.0") reported a correctly persisted value as dropped.
  //
  // Compare numerically whenever both sides are finite numbers; fall back to
  // string equality only for genuinely non-numeric values.
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const bothNumeric = String(left).trim() !== ''
    && String(right).trim() !== ''
    && Number.isFinite(leftNumber)
    && Number.isFinite(rightNumber);
  if (bothNumeric) return leftNumber === rightNumber;
  return String(left) === String(right);
};

export const declaredOutputWriteFailures = ({
  outputNames,
  record,
  declaredOutputWrites,
}: {
  outputNames: string[];
  record: Record<string, unknown>;
  declaredOutputWrites?: Record<string, { provided: boolean; value: unknown }>;
}): string[] => {
  if (!declaredOutputWrites) return declaredOutputsUnwritten({ outputNames, record });
  return outputNames.filter((name) => {
    const write = declaredOutputWrites[name];
    // A step that did not produce this output is not failing. Declaring an
    // output means "this step MAY write this field", not "every record must
    // receive a value". `linkedin_company_resolution` declares
    // `user_rating_count`, and 89 of 251 sourced businesses have no Google
    // reviews at all — blank is the correct answer, and requiring a value
    // errored 197 records in one pass.
    //
    // The defect this guard exists for is narrower and specific: the step
    // PRODUCED a value and the record does not reflect it, because something
    // dropped or overwrote it between the step and persistence. That is
    // checked below and still caught.
    if (!write?.provided) return false;
    if (!isPersistedOutputValue(write.value)) return false;
    return !isPersistedOutputValue(record[name]) || !samePersistedValue(record[name], write.value);
  });
};

const NON_EXECUTION_REASONS = /^(channel_not_permitted:|sequence_outbound_gated|skipped)/i;
const HARD_REJECTED_ACTION_SKIP = /\b(prohibits?|prohibited|forbidden)\b/i;

const WHEN_GATED_STEP_KINDS = new Set([
  'filter',
  'compose',
  'extract',
  'contact_source',
  'assign',
  'review',
  'wait',
  'send_email',
  'send_sms',
  'linkedin_connect',
  'manual_task',
  'score',
  'exit',
]);

/** Engine-owned send steps: must never re-run after a prior pass (double-contact guard). */
export const ENGINE_OWNED_TRANSMITTER_KINDS = new Set(['send_email', 'send_sms', 'linkedin_connect']);

const authorApprovalRequired = (step: PipelineStepLike): boolean => (
  step.draft_approval_required === true
  && !ENGINE_OWNED_TRANSMITTER_KINDS.has(textValue(step.kind))
);

const authorApprovalStepNumber = (config: unknown, stepId: string): number => {
  const index = flattenPipelineSteps(config).findIndex((candidate) => textValue(candidate.id) === stepId);
  return index >= 0 ? index + 1 : 0;
};

const authorApprovalOutcome = ({
  ctx,
  step,
  stepId,
  record,
}: {
  ctx: StepExecutionContext;
  step: PipelineStepLike;
  stepId: string;
  record: Record<string, unknown>;
}): StepExecutionOutcome | null => {
  if (!authorApprovalRequired(step)) return null;
  const recordId = getRecordRowId(record);
  const db = ctx.db as QueryableDb;
  const existing = db.prepare(`
    SELECT *
    FROM drafts
    WHERE row_id = ? AND step_id = ? AND channel = 'author_step'
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(recordId, stepId) as Record<string, unknown> | undefined;
  const status = textValue(existing?.status).toLowerCase();
  if (status === 'ready') return null;
  if (status === 'pending_approval') {
    return { passed: false, parked: true, reason: 'Awaiting author step approval.' };
  }
  if (status === 'rejected') {
    return { passed: false, parked: true, reason: 'Author step approval rejected.' };
  }

  const presentation = resolveReviewPresentation({
    step,
    record: stageInputRecord({ step, record }),
  });
  insertDraft({
    db: ctx.db,
    draft: {
      draft_id: `approval_${randomUUID()}`,
      row_id: recordId,
      sequence_name: stepSubpipelineName(step) || 'pipeline',
      step_number: authorApprovalStepNumber(ctx.config, stepId),
      step_id: stepId,
      channel: 'author_step',
      status: 'pending_approval',
      subject: `Approval required: ${stepId}`,
      body: textValue(step.description, `Author-declared ${textValue(step.kind, 'pipeline')} step.`),
      reason: 'Author-declared step approval required before invocation.',
      artifacts: {
        approval_type: 'author_step',
        kind: textValue(step.kind),
        side_effecting: step.side_effecting === true,
        review_presentation: presentation,
      },
    },
  });
  return { passed: false, parked: true, reason: 'Awaiting author step approval.' };
};

/**
 * The author's duplicate-execution declaration, if any.
 *
 * Steps whose transmission the engine owns claim their own key inside the send
 * path (`config.idempotency`); guarding them here too would open a second,
 * unrelated key for the same effect.
 */
const authorIdempotency = (
  step: PipelineStepLike,
): { keySource: string[]; scope: string } | null => {
  const kind = textValue(step.kind);
  if (kind.startsWith('send_') || kind === 'linkedin_connect') return null;
  const declared = (step as Record<string, unknown>).idempotency;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return null;
  const spec = declared as Record<string, unknown>;
  return {
    keySource: Array.isArray(spec.key_source) ? spec.key_source.map((field) => String(field)) : [],
    scope: textValue(spec.scope, 'list'),
  };
};

/**
 * Execute rows under author-declared idempotency: one completed execution per
 * key, ever. A failure leaves the claim retryable; an execution whose outcome
 * was never observed becomes `uncertain` and requires a human, because the
 * engine cannot ask an author's tool whether it already spent the money.
 */
const executeWithIdempotency = async (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  stepId: string,
  rows: Array<Record<string, unknown>>,
  spec: { keySource: string[]; scope: string },
): Promise<Map<string, StepExecutionOutcome>> => {
  const outcomes = new Map<string, StepExecutionOutcome>();
  const claimed: Array<{
    record: Record<string, unknown>;
    idemKey: string;
    claimId: string;
  }> = [];

  for (const record of rows) {
    const recordId = getRecordRowId(record);
    const idemKey = buildIdempotencyKey({
      keySource: spec.keySource,
      record,
      scope: spec.scope,
      context: { step_id: stepId },
    });
    const claim = claimIdempotency({
      db: ctx.db,
      idemKey,
      scope: spec.scope,
      payload: { step_id: stepId, kind: textValue(step.kind) },
    });
    if (claim.claimed) {
      claimed.push({ record, idemKey, claimId: claim.claim_id });
      continue;
    }
    if (claim.status === 'sent') {
      outcomes.set(recordId, { passed: true, reason: 'skipped_idempotent_already_executed' });
      continue;
    }
    if (claim.status === 'uncertain') {
      outcomes.set(recordId, {
        passed: false,
        errored: true,
        reason: `idempotency_requires_reconcile:${claim.reason}`,
      });
      continue;
    }
    outcomes.set(recordId, { passed: false, reason: `skipped_idempotency_${claim.reason}` });
  }

  if (claimed.length === 0) return outcomes;

  let executed: Map<string, StepExecutionOutcome>;
  try {
    executed = await executeStepBatchUnchecked(ctx, step, stepId, claimed.map((entry) => entry.record));
  } catch (error) {
    // The batch died mid-flight: we cannot tell which effects landed. Never
    // silently re-run an author's effect on the strength of a thrown error.
    for (const entry of claimed) {
      failIdempotency({
        db: ctx.db,
        idemKey: entry.idemKey,
        scope: spec.scope,
        claimId: entry.claimId,
        payload: { provider_uncertain: true, error: String((error as Error)?.message || error) },
      });
    }
    throw error;
  }

  for (const entry of claimed) {
    const recordId = getRecordRowId(entry.record);
    const outcome = executed.get(recordId) || {
      passed: false,
      errored: true,
      reason: 'step_outcome_missing',
    };
    const ran = outcome.passed && !outcome.errored;
    if (ran) {
      completeIdempotency({
        db: ctx.db,
        idemKey: entry.idemKey,
        scope: spec.scope,
        claimId: entry.claimId,
        payload: { reason: textValue(outcome.reason) },
      });
    } else {
      // A failing step the author declared world-touching did not necessarily
      // fail to touch the world — the engine cannot ask an author's tool
      // whether the money left. Recording `failed` would assert it did not and
      // hand the next run a licence to do it again, so this stays `uncertain`
      // until a person reconciles it. Steps that touch nothing retry freely.
      failIdempotency({
        db: ctx.db,
        idemKey: entry.idemKey,
        scope: spec.scope,
        claimId: entry.claimId,
        payload: step.side_effecting === true
          ? { provider_uncertain: true, reason: textValue(outcome.reason) }
          : { reason: textValue(outcome.reason) },
      });
    }
    outcomes.set(recordId, outcome);
  }
  return outcomes;
};

const executeWithAuthorApproval = async (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  stepId: string,
  rows: Array<Record<string, unknown>>,
): Promise<Map<string, StepExecutionOutcome>> => {
  const gated = new Map<string, StepExecutionOutcome>();
  const approvedRows = rows.filter((record) => {
    const outcome = authorApprovalOutcome({ ctx, step, stepId, record });
    if (!outcome) return true;
    gated.set(getRecordRowId(record), outcome);
    return false;
  });
  if (approvedRows.length === 0) return gated;
  const idempotency = authorIdempotency(step);
  const executed = idempotency
    ? await executeWithIdempotency(ctx, step, stepId, approvedRows, idempotency)
    : await executeStepBatchUnchecked(ctx, step, stepId, approvedRows);
  return new Map(rows.map((record) => {
    const recordId = getRecordRowId(record);
    return [recordId, gated.get(recordId) || executed.get(recordId) || {
      passed: false,
      errored: true,
      reason: 'step_outcome_missing',
    }];
  }));
};

export const shouldGuardDeclaredOutputWrites = (outcome: StepExecutionOutcome): boolean => (
  outcome.passed && !outcome.errored && !NON_EXECUTION_REASONS.test(String(outcome.reason || ''))
);

const guardDeclaredOutputWrites = (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  outcomes: Map<string, StepExecutionOutcome>,
): Map<string, StepExecutionOutcome> => {
  const outputNames = declaredOutputNames(step);
  if (outputNames.length === 0) return outcomes;
  const db = ctx.db as QueryableDb;
  const guarded = new Map<string, StepExecutionOutcome>();
  for (const [recordId, outcome] of outcomes) {
    const guardCachedGenerate = step.kind === 'generate'
      && String(outcome.reason || '') === 'skipped_unchanged_inputs';
    if (!guardCachedGenerate && !shouldGuardDeclaredOutputWrites(outcome)) {
      guarded.set(recordId, outcome);
      continue;
    }
    const persisted = db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1').get(recordId, recordId);
    const row = persisted && typeof persisted === 'object' && !Array.isArray(persisted)
      ? persisted as Record<string, unknown>
      : {};
    const missing = declaredOutputWriteFailures({
      outputNames,
      record: row,
      declaredOutputWrites: outcome.declaredOutputWrites,
    });
    guarded.set(recordId, missing.length > 0
      ? {
        passed: false,
        errored: true,
        reason: `declared_outputs_unwritten:${missing.join(',')}`,
      }
      : outcome);
  }
  return guarded;
};

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
        row: stageInputRecord({ step, record: row }),
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
  const modelContextConfig = ctx.config && typeof ctx.config === 'object'
    ? ctx.config as { source?: { identity?: string[] }; model_context?: unknown }
    : {};
  const semantic = await evaluateSemanticFilterBatches({
    db: ctx.db,
    listDir: ctx.listDir,
    filter: step,
    rows,
    aiConfig: ctx.aiConfig || ctx.config?.ai || {},
    batchSize: Number(step.batch_size || 10),
    identityFields: modelContextConfig.source?.identity || [],
    contextBudget: modelContextConfig.model_context,
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
    emailVerificationProvider: ctx.emailVerificationProvider,
  });
  const failures = new Map((Array.isArray(result.errors) ? result.errors : []).map((error) => [
    String(error.record_id || '').trim(),
    String(error.error || ''),
  ]));
  const handledErrors = new Set(
    Array.isArray(result.handled_errors)
      ? result.handled_errors.map((recordId) => String(recordId || '').trim()).filter(Boolean)
      : [],
  );
  const outcomes = new Map<string, StepExecutionOutcome>();
  const declaredOutputWrites = result.declared_output_writes && typeof result.declared_output_writes === 'object'
    ? result.declared_output_writes as Record<string, Record<string, { provided: boolean; value: unknown }>>
    : {};
  const nonExecutionReasons = result.non_execution_reasons && typeof result.non_execution_reasons === 'object'
    ? result.non_execution_reasons as Record<string, string>
    : {};
  const recordedNonSuccess = result.recorded_non_success && typeof result.recorded_non_success === 'object'
    ? result.recorded_non_success as Record<string, string>
    : {};
  rows.forEach((row) => {
    const recordId = getRecordRowId(row);
    const failure = failures.get(recordId);
    if (failure) {
      outcomes.set(recordId, {
        passed: false,
        reason: failure,
        errored: !handledErrors.has(recordId),
      });
      return;
    }
    // Soft non-pass (e.g. provider_returned_no_content): not a hard error, not a pass.
    // Dependents still resolve; hasPassedStep stays false; declared outputs unwritten.
    const nonSuccessReason = String(recordedNonSuccess[recordId] || '').trim();
    if (nonSuccessReason) {
      outcomes.set(recordId, {
        passed: false,
        reason: nonSuccessReason,
        errored: false,
        declaredOutputWrites: declaredOutputWrites[recordId],
      });
      return;
    }
    outcomes.set(recordId, {
      passed: true,
      reason: nonExecutionReasons[recordId] || '',
      declaredOutputWrites: declaredOutputWrites[recordId],
    });
  });
  return outcomes;
};

const executeExtractBatch = async (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  rows: Array<Record<string, unknown>>,
) => executeExtractStepOnRecords({
  db: ctx.db,
  step,
  rows,
  force: Boolean(ctx.force),
});

/** Production generate path: classification / content packs via generate runner (not fixture). */
const executeGenerateBatch = async (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  stepId: string,
  rows: Array<Record<string, unknown>>,
) => {
  const { runGenerateStep } = await import('../generate/runner.js');
  // Tests inject a model result via step.__executeAction (same seam pattern as enrich __tryTool).
  const injectedExecute = typeof (step as { __executeAction?: unknown }).__executeAction === 'function'
    ? (step as { __executeAction: typeof import('../enrichment/runner.js').executeEnrichmentAction }).__executeAction
    : undefined;
  const result = await runGenerateStep({
    db: ctx.db as any,
    listDir: ctx.listDir,
    config: (ctx.config || { ai: ctx.aiConfig || {} }) as Record<string, unknown>,
    mcp: (ctx.mcp || null) as any,
    toolCatalog: ctx.toolCatalog as any,
    step,
    rows,
    stepId,
    force: Boolean(ctx.force),
    ...(injectedExecute ? { executeAction: injectedExecute } : {}),
  });
  const failures = new Map((Array.isArray(result.errors) ? result.errors : []).map((error) => [
    String(error.record_id || '').trim(),
    String(error.error || ''),
  ]));
  const declaredOutputWrites = result.declared_output_writes && typeof result.declared_output_writes === 'object'
    ? result.declared_output_writes as Record<string, Record<string, { provided: boolean; value: unknown }>>
    : {};
  const nonExecutionReasons = result.non_execution_reasons && typeof result.non_execution_reasons === 'object'
    ? result.non_execution_reasons as Record<string, string>
    : {};
  const recordedNonSuccess = result.recorded_non_success && typeof result.recorded_non_success === 'object'
    ? result.recorded_non_success as Record<string, string>
    : {};
  const outcomes = new Map<string, StepExecutionOutcome>();
  rows.forEach((row) => {
    const recordId = getRecordRowId(row);
    const failure = failures.get(recordId);
    if (failure) {
      outcomes.set(recordId, { passed: false, reason: failure, errored: true });
      return;
    }
    // Structural emptiness under on_error: empty is recorded non-success: not a pass,
    // not a hard error. Dependents still resolve; hasPassedStep is false.
    const nonSuccessReason = String(recordedNonSuccess[recordId] || '').trim();
    if (nonSuccessReason) {
      outcomes.set(recordId, {
        passed: false,
        reason: nonSuccessReason,
        errored: false,
        declaredOutputWrites: declaredOutputWrites[recordId],
      });
      return;
    }
    outcomes.set(recordId, {
      passed: true,
      reason: nonExecutionReasons[recordId] || '',
      declaredOutputWrites: declaredOutputWrites[recordId],
    });
  });
  return outcomes;
};

const executeScoreBatch = async (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  stepId: string,
  rows: Array<Record<string, unknown>>,
) => {
  const scoreStep: ScoreStage = {
    ...step,
    id: stepId,
    key: textValue(step.key),
    model: textValue(step.model),
    criteria: Array.isArray(step.criteria) ? step.criteria as ScoreStage['criteria'] : [],
    inputs: step.inputs,
    outputs: step.outputs && typeof step.outputs === 'object' && !Array.isArray(step.outputs)
      ? step.outputs as ScoreStage['outputs']
      : {},
    memoize: step.memoize === false
      ? false
      : step.memoize && typeof step.memoize === 'object' && !Array.isArray(step.memoize)
        ? step.memoize as ScoreStage['memoize']
        : undefined,
  };
  return runScoreStage({
    db: ctx.db as Parameters<typeof runScoreStage>[0]['db'],
    listDir: ctx.listDir,
    config: (ctx.config || { ai: ctx.aiConfig || {} }) as Record<string, unknown>,
    step: scoreStep,
    rows,
    stepId,
    force: Boolean(ctx.force),
  });
};

const executeComposeBatch = async (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  stepId: string,
  rows: Array<Record<string, unknown>>,
) => {
  const { runComposeStep } = await import('../compose/runner.js');
  const result = await runComposeStep({
    db: ctx.db as { prepare: (sql: string) => { get: (...params: unknown[]) => unknown; run: (...params: unknown[]) => unknown } },
    listDir: ctx.listDir,
    config: (ctx.config || { ai: ctx.aiConfig || {} }) as Record<string, unknown>,
    step,
    rows,
    stepId,
    force: Boolean(ctx.force),
    generateObject: ctx.composeGenerateObject,
  });
  const failures = new Map(result.errors.map((error) => [error.record_id, error.error]));
  const outcomes = new Map<string, StepExecutionOutcome>();
  rows.forEach((row) => {
    const recordId = getRecordRowId(row);
    const failure = failures.get(recordId);
    outcomes.set(recordId, failure
      ? { passed: false, reason: failure, errored: true }
      : {
        passed: true,
        reason: result.non_execution_reasons[recordId] || '',
        declaredOutputWrites: result.declared_output_writes[recordId],
      });
  });
  return outcomes;
};

const executeReviewBatch = async (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  stepId: string,
  rows: Array<Record<string, unknown>>,
) => {
  const recordIds = rows.map((row) => getRecordRowId(row));
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
  return new Map(rows.map((row) => {
    const recordId = getRecordRowId(row);
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
      const modelContextConfig = ctx.config && typeof ctx.config === 'object'
        ? ctx.config as { source?: { identity?: string[] }; model_context?: unknown }
        : {};
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
        identityFields: modelContextConfig.source?.identity || [],
        contextBudget: modelContextConfig.model_context,
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

const executeContactSourceBatch = (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  stepId: string,
  rows: Array<Record<string, unknown>>,
) => {
  const field = textValue(step.field);
  const nameField = textValue(step.name_field);
  const titleField = textValue(step.title_field);
  const outcomes = new Map<string, StepExecutionOutcome>();
  rows.forEach((row) => {
    const recordId = getRecordRowId(row);
    try {
      const result = promoteContactSource({
        db: ctx.db as Parameters<typeof promoteContactSource>[0]['db'],
        record: row,
        field,
        nameField,
        titleField,
        role: step.role,
        stepId,
        contactPolicy: ctx.config?.contact_policy as Parameters<typeof promoteContactSource>[0]['contactPolicy'],
      });
      outcomes.set(recordId, { passed: true, reason: result.reason });
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

const channelForPipelineStep = (step: PipelineStepLike) => {
  const configuredChannel = textValue((step.config as Record<string, unknown> | undefined)?.channel);
  if (configuredChannel) return configuredChannel;
  const kind = textValue(step.kind);
  if (kind.startsWith('send_')) return kind.slice('send_'.length);
  if (kind === 'linkedin_connect') return 'linkedin';
  return 'manual';
};

/**
 * Sibling steps for sequence advancement when a nested tier pipeline action runs.
 * Nested dataflow previously passed `{ steps: [] }`, which made the first email
 * look like sequence completion. Build a day-offset sequence from the same
 * subpipeline (or the flat pipeline) so multi-step campaigns advance correctly.
 */
const sequenceStepsForPipelineAction = (
  config: unknown,
  step: PipelineStepLike,
): Array<Record<string, unknown>> => {
  const flat = flattenPipelineSteps(config);
  const scope = stepSubpipelineName(step);
  const siblings = scope
    ? flat.filter((entry) => stepSubpipelineName(entry) === scope)
    : flat.filter((entry) => {
      const k = textValue(entry.kind);
      return ['send_email', 'send_sms', 'linkedin_connect', 'manual_task', 'wait'].includes(k);
    });
  // Order by nested index when present so step numbers match nestedStepIndex + 1.
  const ordered = [...siblings].sort((a, b) => {
    const ai = Number((a as any)[SUBPIPELINE_STEP_INDEX_FIELD]);
    const bi = Number((b as any)[SUBPIPELINE_STEP_INDEX_FIELD]);
    if (Number.isInteger(ai) && Number.isInteger(bi)) return ai - bi;
    return 0;
  });
  let cumulativeDay = 0;
  return ordered.map((entry, index) => {
    const after = textValue((entry as any).after);
    const afterMatch = after.match(/^((?:\d+(?:\.\d+)?|\.\d+))([dhw])$/i);
    if (afterMatch) {
      const amount = Number(afterMatch[1]);
      const unit = afterMatch[2].toLowerCase();
      if (unit === 'd') cumulativeDay += amount;
      else if (unit === 'w') cumulativeDay += amount * 7;
      else if (unit === 'h') cumulativeDay += amount / 24;
    } else if (Number.isFinite(Number((entry as any).day))) {
      cumulativeDay = Number((entry as any).day);
    } else if (index > 0 && textValue(entry.kind) !== 'wait') {
      // Non-wait action after prior steps: keep same calendar day unless wait advanced it.
    }
    return {
      ...entry,
      id: textValue(entry.id) || `step_${index + 1}`,
      kind: textValue(entry.kind),
      // Day offset for computeNextScheduledAction (from cumulative wait after:).
      day: cumulativeDay,
    };
  });
};

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
  const sequenceSteps = sequenceStepsForPipelineAction(ctx.config, step);
  const entries = await Promise.all(rows.map(async (row) => {
    const recordId = getRecordRowId(row);
    const sequenceName = stepSubpipelineName(step) || textValue(row.sequence_name, 'default');
    try {
      // Mirror sequencer: when draft approval is required and no ready draft exists,
      // first create a pending draft (intent=draft); operator approves, then a later
      // pipeline run sends with intent=send.
      // Also treat policy.review_required_for including send_email as requiring a
      // draft-or-stage path (draft create first when no ready draft).
      const taskType = String(
        (step.config as any)?.task_type || (step.config as any)?.taskType || '',
      ).trim();
      const approvalRequired = kind === 'send_email' && (
        step.draft_approval_required === true
        || Boolean((step.config as any)?.draft_approval_required)
        || isReviewRequired(ctx.config, 'send_email', taskType)
        || isReviewRequired(ctx.config, kind, taskType)
      );
      let sequenceIntent: 'send' | 'draft' = 'send';
      if (approvalRequired) {
        const readyDraft = (ctx.db as any).prepare(`
          SELECT draft_id
          FROM drafts
          WHERE row_id = ?
            AND sequence_name = ?
            AND step_number = ?
            AND status = 'ready'
          ORDER BY updated_at DESC
          LIMIT 1
        `).get(recordId, sequenceName, stepNumber);
        if (!readyDraft) {
          const pendingDraft = (ctx.db as any).prepare(`
            SELECT draft_id
            FROM drafts
            WHERE row_id = ?
              AND sequence_name = ?
              AND step_number = ?
              AND status = 'pending_approval'
            ORDER BY updated_at DESC
            LIMIT 1
          `).get(recordId, sequenceName, stepNumber);
          if (pendingDraft) {
            return [recordId, {
              passed: false,
              reason: 'Draft pending approval.',
              errored: false,
              parked: true,
            }] as const;
          }
          sequenceIntent = 'draft';
        }
      }

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
        // Full sibling step list — empty steps previously marked every first
        // successful email as sequence completion (campaign break / wrong rotation).
        sequence: { steps: sequenceSteps, name: sequenceName },
        aiConfig: ctx.aiConfig || ctx.config?.ai || {},
        dryRun: false,
        intent: sequenceIntent,
        channelHint: channelForPipelineStep(step),
        now: ctx.now,
      });
      const status = textValue(result?.status);
      const reason = textValue(result?.reason);
      const idempotentSkip = status === 'skipped' && /already sent/i.test(reason);
      const draftCreated = sequenceIntent === 'draft' && (status === 'sent' || status === 'drafted' || /draft/i.test(reason));
      if (status === 'sent' || idempotentSkip) {
        // Draft creation parks the lead until approval — do not mark the send step passed.
        if (sequenceIntent === 'draft') {
          return [recordId, {
            passed: false,
            reason: reason || 'Draft pending approval.',
            errored: false,
            parked: true,
          }] as const;
        }
        return [recordId, { passed: true, reason }] as const;
      }
      if (draftCreated || /pending approval|approval required/i.test(reason)) {
        return [recordId, {
          passed: false,
          reason: reason || 'Draft pending approval.',
          errored: false,
          parked: true,
        }] as const;
      }
      if (status === 'skipped' && /^channel_not_permitted:/i.test(reason)) {
        return [
          recordId,
          {
            passed: true,
            reason,
            errored: false,
          },
        ] as const;
      }
      if (status === 'skipped') {
        const hardRejected = HARD_REJECTED_ACTION_SKIP.test(reason);
        return [
          recordId,
          {
            passed: false,
            reason: reason || `pipeline_${kind}_skipped`,
            errored: hardRejected,
            parked: !hardRejected,
          },
        ] as const;
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

const executeStepBatchUnchecked = async (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  stepId: string,
  rows: Array<Record<string, unknown>>,
): Promise<Map<string, StepExecutionOutcome>> => {
  const kind = textValue(step.kind);
  if (kind === 'filter' || kind === 'exit') {
    const filterType = textValue(step.type, 'semantic').toLowerCase();
    if (filterType === 'field_check') return executeFieldCheckBatch(ctx, step, rows);
    if (filterType === 'semantic') {
      // Deterministic substitute: pass semantic filters without model spend.
      if (String(process.env.AO_PIPELINE_FIXTURE || process.env.AO_STEP_FIXTURE || '').trim() === '1') {
        return new Map(rows.map((row) => [
          getRecordRowId(row),
          { passed: true, reason: 'fixture_semantic_filter_pass' },
        ]));
      }
      return executeSemanticFilterBatch(ctx, step, rows);
    }
    throw new Error(`unsupported_pipeline_filter_type:${filterType}`);
  }

  if (kind === 'wait') {
    return new Map(rows.map((row) => [
      getRecordRowId(row),
      { passed: true, reason: '' },
    ]));
  }

  if (kind === 'manual_task') {
    const taskType = textValue((step.config as any)?.task_type || (step.config as any)?.taskType);
    const { assertWorkAllowed } = await import('../policy/index.js');
    try {
      assertWorkAllowed({
        policy: (ctx.config as { policy?: unknown } | undefined)?.policy,
        kind,
        taskType,
        channel: (step.config as Record<string, unknown> | undefined)?.channel,
      });
    } catch (error) {
      return new Map(rows.map((row) => [
        getRecordRowId(row),
        { passed: false, reason: String((error as Error).message), errored: true },
      ]));
    }
    // Always park — never LLM-execute a human task.
    return new Map(rows.map((row) => [
      getRecordRowId(row),
      { passed: false, reason: 'awaiting_manual' },
    ]));
  }

  if (kind.startsWith('send_') || kind === 'linkedin_connect') {
    return executeSequenceActionBatch(ctx, step, stepId, rows);
  }

  if (kind === 'enrich') return executeEnrichBatch(ctx, step, stepId, rows);
  if (kind === 'extract') return executeExtractBatch(ctx, step, rows);
  if (kind === 'contact_source') return executeContactSourceBatch(ctx, step, stepId, rows);
  if (kind === 'compose') return executeComposeBatch(ctx, step, stepId, rows);
  if (kind === 'assign') return executeAssignBatch(ctx, step, stepId, rows);
  if (kind === 'review') return executeReviewBatch(ctx, step, stepId, rows);

  // Deterministic fixture path for generate / geo / profile-search under AO_PIPELINE_FIXTURE.
  // Generate fixtures persist declared outputs so the full graph can be exercised without model spend.
  if (
    String(process.env.AO_PIPELINE_FIXTURE || '').trim() === '1'
    && ['generate', 'geo_tiles', 'linkedin_profile_search'].includes(kind)
  ) {
    if (kind === 'generate') {
      const { ensureRecordColumns } = await import('../runtime/db.js');
      const declared = (step.outputs && typeof step.outputs === 'object')
        ? step.outputs as Record<string, unknown>
        : {};
      const fixtureOutputs = step.fixture_outputs && typeof step.fixture_outputs === 'object'
        && !Array.isArray(step.fixture_outputs)
        ? step.fixture_outputs as Record<string, unknown>
        : {};
      const outcomes = new Map<string, StepExecutionOutcome>();
      for (const row of rows) {
        const recordId = getRecordRowId(row);
        try {
          const outputs: Record<string, unknown> = {};
          const declaredType = (key: string) => {
            const spec = declared[key];
            if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
              return String((spec as any).type || 'string').toLowerCase();
            }
            return 'string';
          };
          const coerceFixture = (key: string, value: unknown) => {
            const t = declaredType(key);
            if (t === 'boolean') {
              if (typeof value === 'boolean') return value;
              if (value === 1 || value === '1' || value === 'true' || value === true) return true;
              return false;
            }
            if (t === 'number' || t === 'integer') {
              const n = Number(value);
              return Number.isFinite(n) ? n : 0;
            }
            if (value === undefined || value === null) return '';
            return value;
          };
          for (const key of Object.keys(declared)) {
            if (CLAIM_ENGINE_OUTPUT_FIELDS.has(key)) continue;
            const existing = row[key];
            if (existing !== undefined && existing !== null && String(existing).trim() !== '') {
              outputs[key] = coerceFixture(key, existing);
              continue;
            }
            outputs[key] = Object.prototype.hasOwnProperty.call(fixtureOutputs, key)
              ? fixtureOutputs[key]
              : declaredType(key) === 'boolean'
                ? false
                : declaredType(key) === 'number' || declaredType(key) === 'integer'
                  ? 0
                  : `fixture_${key}`;
            outputs[key] = coerceFixture(key, outputs[key]);
          }

          ensureRecordColumns({
            db: ctx.db as any,
            columns: Object.keys(outputs),
          });
          upsertRecord({
            db: ctx.db as any,
            row: { ...row, ...outputs },
          });
          outcomes.set(recordId, {
            passed: true,
            reason: `fixture_generate:${stepId}`,
            declaredOutputWrites: Object.fromEntries(Object.keys(outputs).map((key) => [key, {
              provided: true,
              value: outputs[key],
            }])),
          });
        } catch (error) {
          outcomes.set(recordId, {
            passed: false,
            reason: String((error as Error)?.message || error),
            errored: true,
          });
        }
      }
      return outcomes;
    }

    return new Map(rows.map((row) => [
      getRecordRowId(row),
      { passed: true, reason: `fixture_${kind}` },
    ]));
  }

  // Production generate on the normal path (no AO_PIPELINE_FIXTURE required):
  // - critical-path generates that feed a non-generate policy step
  // - honest opt-in via run_in_pipeline for non-critical generated assets
  // Fixture branch above is only for $0 deterministic tests.
  if (kind === 'generate') {
    return executeGenerateBatch(ctx, step, stepId, rows);
  }

  if (kind === 'score') return executeScoreBatch(ctx, step, stepId, rows);

  // Nested pipeline containers are flattened by subpipelines; never execute the parent kind.
  if (kind === 'pipeline') {
    return new Map(rows.map((row) => [
      getRecordRowId(row),
      { passed: true, reason: 'pipeline_container_flattened' },
    ]));
  }

  throw new Error(`unsupported_pipeline_step_kind:${kind || 'unknown'}`);
};

export const executeStepBatch = async (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  stepId: string,
  rows: Array<Record<string, unknown>>,
): Promise<Map<string, StepExecutionOutcome>> => {
  const kind = textValue(step.kind);
  if (!WHEN_GATED_STEP_KINDS.has(kind)) {
    return guardDeclaredOutputWrites(ctx, step, await executeWithAuthorApproval(ctx, step, stepId, rows));
  }
  const predicate = whenPredicateForStep({ step, stepConfig: stepConfigForWhen(step) });
  if (!predicate) {
    return guardDeclaredOutputWrites(ctx, step, await executeWithAuthorApproval(ctx, step, stepId, rows));
  }
  const matchingRows: Array<Record<string, unknown>> = [];
  const skippedOutcomes = new Map<string, StepExecutionOutcome>();
  rows.forEach((row) => {
    const whenOutcome = shouldRunForRecord({
      record: stageInputRecord({ step, record: row }),
      predicate,
      listDir: ctx.listDir,
    });
    if (whenOutcome.passed) {
      matchingRows.push(row);
      return;
    }
    skippedOutcomes.set(getRecordRowId(row), skippedWhenOutcome(whenOutcome));
  });
  const executed = matchingRows.length > 0
    ? await executeWithAuthorApproval(ctx, step, stepId, matchingRows)
    : new Map<string, StepExecutionOutcome>();
  const outcomes = new Map(rows.map((row) => {
    const recordId = getRecordRowId(row);
    return [recordId, skippedOutcomes.get(recordId) || executed.get(recordId) || {
      passed: false,
      errored: true,
      reason: 'step_outcome_missing',
    }];
  }));
  return guardDeclaredOutputWrites(ctx, step, outcomes);
};
