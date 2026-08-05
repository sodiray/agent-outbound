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
import { isReviewRequired } from '../policy/stage-review-gate.js';
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

/** Production generate path: classification / content packs via generate runner (not fixture). */
const executeGenerateBatch = async (
  ctx: StepExecutionContext,
  step: PipelineStepLike,
  stepId: string,
  rows: Array<Record<string, unknown>>,
) => {
  const { runGenerateStep } = await import('../generate/runner.js');
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
        channelHint: channelForPipelineKind(kind),
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
          }] as const;
        }
        return [recordId, { passed: true, reason }] as const;
      }
      if (draftCreated || /pending approval|approval required/i.test(reason)) {
        return [recordId, {
          passed: false,
          reason: reason || 'Draft pending approval.',
          errored: false,
        }] as const;
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
    // Reject forbidden work types (visit/SMS/voice) before parking.
    const { isForbiddenTaskType, isForbiddenChannelKind } = await import('../policy/index.js');
    if (isForbiddenTaskType(taskType) || isForbiddenChannelKind(kind) || isForbiddenTaskType(stepId)) {
      return new Map(rows.map((row) => [
        getRecordRowId(row),
        { passed: false, reason: `forbidden_work:${taskType || stepId}`, errored: true },
      ]));
    }
    // Always park — never LLM-execute a human task.
    return new Map(rows.map((row) => [
      getRecordRowId(row),
      { passed: false, reason: 'awaiting_manual' },
    ]));
  }

  if (kind === 'send_sms') {
    return new Map(rows.map((row) => [
      getRecordRowId(row),
      { passed: false, reason: 'forbidden_work:send_sms', errored: true },
    ]));
  }

  if (['send_email', 'linkedin_connect'].includes(kind)) {
    return executeSequenceActionBatch(ctx, step, stepId, rows);
  }

  if (kind === 'enrich') return executeEnrichBatch(ctx, step, stepId, rows);
  if (kind === 'assign') return executeAssignBatch(ctx, step, stepId, rows);
  if (kind === 'review') return executeReviewBatch(ctx, step, stepId, rows);

  // Deterministic fixture path for generate / geo / profile-search under AO_PIPELINE_FIXTURE.
  // Generate fixtures must persist declared outputs (and claim audit for content packs) so the
  // full unmodified TV graph can be exercised without model spend.
  if (
    String(process.env.AO_PIPELINE_FIXTURE || '').trim() === '1'
    && ['generate', 'geo_tiles', 'linkedin_profile_search'].includes(kind)
  ) {
    if (kind === 'generate') {
      const { ensureRecordColumns } = await import('../runtime/db.js');
      const {
        assemblePermittedClaimPacket,
        auditClaims,
        calculateEconomicScenario,
        claimAuditAssetHash,
      } = await import('../policy/index.js');
      const declared = (step.outputs && typeof step.outputs === 'object')
        ? step.outputs as Record<string, unknown>
        : {};
      const outcomes = new Map<string, StepExecutionOutcome>();
      for (const row of rows) {
        const recordId = getRecordRowId(row);
        try {
          const name = String(row.business_name || 'business').trim() || 'business';
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
            const existing = row[key];
            if (existing !== undefined && existing !== null && String(existing).trim() !== '') {
              outputs[key] = coerceFixture(key, existing);
              continue;
            }
            switch (key) {
              case 'vertical':
                outputs[key] = row.vertical || 'trades_field_services';
                break;
              case 'sub_vertical':
                outputs[key] = row.sub_vertical || 'hvac';
                break;
              case 'regulatory_context':
                outputs[key] = row.regulatory_context || 'none';
                break;
              case 'ownership_type':
                outputs[key] = row.ownership_type || 'independent';
                break;
              case 'owner_operated':
                outputs[key] = row.owner_operated || 'yes';
                break;
              case 'local_buying_authority':
                outputs[key] = row.local_buying_authority || 'yes';
                break;
              case 'primary_buyer_role':
                outputs[key] = row.primary_buyer_role || 'owner';
                break;
              case 'likely_champion_role':
                outputs[key] = row.likely_champion_role || 'office_manager';
                break;
              case 'size_tier':
                outputs[key] = row.size_tier || 'small';
                break;
              case 'is_franchise':
                outputs[key] = false;
                break;
              case 'locally_accessible':
                outputs[key] = true;
                break;
              case 'franchise_brand':
                outputs[key] = '';
                break;
              case 'accessibility_reasoning':
                outputs[key] = 'Fixture: independent local business with on-site buyer access.';
                break;
              case 'classification_confidence':
                outputs[key] = Number(row.classification_confidence ?? row.fit_evidence_confidence ?? 85);
                break;
              case 'identity_confidence':
                outputs[key] = Number(row.identity_confidence ?? 90);
                break;
              case 'classification_evidence':
                outputs[key] = `Fixture public evidence for ${name}`;
                break;
              case 'account_classification_json':
                outputs[key] = JSON.stringify({
                  vertical: row.vertical || 'trades_field_services',
                  sub_vertical: row.sub_vertical || 'hvac',
                  ownership_type: row.ownership_type || 'independent',
                  local_buying_authority: row.local_buying_authority || 'yes',
                  primary_buyer_role: row.primary_buyer_role || 'owner',
                  likely_champion_role: row.likely_champion_role || 'office_manager',
                  size_tier: row.size_tier || 'small',
                  regulatory_context: row.regulatory_context || 'none',
                  confidence: 85,
                  source: 'fixture_account_intelligence',
                });
                break;
              case 'preliminary_snapshot':
                outputs[key] = `Fixture preliminary operational snapshot for ${name}: public evidence of inquiry follow-up and scheduling friction in the Treasure Valley.`;
                break;
              case 'diagnostic_hypotheses_json':
                outputs[key] = JSON.stringify([
                  { hypothesis: 'missed inquiry follow-up', falsifier: 'CRM reply latency data', class: 'hypothesis' },
                ]);
                break;
              case 'economic_scenarios_json':
                outputs[key] = JSON.stringify([
                  calculateEconomicScenario({
                    scenario_id: 'admin_labor_leak',
                    weekly_admin_hours: 10,
                    hourly_loaded_cost: 45,
                  }),
                ]);
                break;
              case 'proof_match_ids':
                outputs[key] = JSON.stringify([]);
                break;
              case 'permitted_claim_packet_json':
                // Filled below via assembler (prevents self-approval of free text).
                break;
              default:
                outputs[key] = declaredType(key) === 'boolean'
                  ? false
                  : declaredType(key) === 'number' || declaredType(key) === 'integer'
                    ? 0
                    : `fixture_${key}`;
            }
            outputs[key] = coerceFixture(key, outputs[key]);
          }

          // Claim packet + audit for diagnostic content packs (production path under fixture inputs).
          if (
            Object.prototype.hasOwnProperty.call(declared, 'permitted_claim_packet_json')
            || Object.prototype.hasOwnProperty.call(declared, 'preliminary_snapshot')
            || String(stepId).includes('diagnostic')
          ) {
            const snapshot = String(
              outputs.preliminary_snapshot
              || row.preliminary_snapshot
              || `Fixture preliminary operational snapshot for ${name}.`,
            );
            outputs.preliminary_snapshot = snapshot;
            const packet = assemblePermittedClaimPacket({
              account_id: recordId,
              family_id: String(row.diagnostic_family || row.vertical || outputs.vertical || ''),
              vertical: String(row.vertical || outputs.vertical || ''),
              economic_inputs: {
                weekly_admin_hours: 10,
                hourly_loaded_cost: 45,
              },
              preliminary_snapshot: snapshot,
              listDir: ctx.listDir,
            });
            outputs.permitted_claim_packet_json = JSON.stringify(packet);
            const extracted = snapshot
              .split(/[.!?\n]+/)
              .map((t) => t.trim())
              .filter((t) => t.length >= 3)
              .map((text) => ({ text }));
            const audit = auditClaims({ packet, extracted, assetText: snapshot });
            outputs.claim_audit_passed = audit.passed ? 1 : 0;
            outputs.claim_audit_json = JSON.stringify(audit);
            // RES-CONTENT: persist hash of exact assetText audited.
            const assetHash = claimAuditAssetHash(snapshot);
            if (assetHash) outputs.claim_audit_asset_hash = assetHash;
          }

          ensureRecordColumns({
            db: ctx.db as any,
            columns: [...Object.keys(outputs), 'claim_audit_passed', 'claim_audit_json', 'claim_audit_asset_hash'],
          });
          upsertRecord({
            db: ctx.db as any,
            row: { ...row, ...outputs },
          });
          outcomes.set(recordId, { passed: true, reason: `fixture_generate:${stepId}` });
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
  // - critical-path generates (e.g. account_intelligence → treatment_assignment)
  // - honest opt-in via run_in_pipeline (e.g. TV diagnostic_content_pack for A/B/C)
  // Fixture branch above is only for $0 deterministic tests.
  if (kind === 'generate') {
    return executeGenerateBatch(ctx, step, stepId, rows);
  }

  // Nested pipeline containers are flattened by subpipelines; never execute the parent kind.
  if (kind === 'pipeline') {
    return new Map(rows.map((row) => [
      getRecordRowId(row),
      { passed: true, reason: 'pipeline_container_flattened' },
    ]));
  }

  throw new Error(`unsupported_pipeline_step_kind:${kind || 'unknown'}`);
};
