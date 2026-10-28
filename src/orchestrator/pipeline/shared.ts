import { hasPassedStep, inPlayWhere, isRecordCommitted, upsertRecord } from '../runtime/db.js';
import { evaluateFieldCheckGroup } from '../lib/conditions.js';
import { countEnrichWorkForStep, readStaleness } from '../enrichment/runner.js';
import { avgStepCostUsd } from '../lib/costs.js';
import { getRecordRowId, stableHash } from '../lib/record.js';
import { isRecordAwaitingReview } from './review.js';
import { resolveFieldCheckConditions } from '../lib/field-check-values.js';
import {
  PIPELINE_ROUTE_TARGET,
  stepSubpipelineName,
} from '../lib/subpipelines.js';
import { pipelineNameForRecord } from '../lib/sequence-resolution.js';

const MATERIAL_FILTER_FIELDS = ['type', 'match', 'condition', 'conditions', 'value', 'operator', 'field', 'on_fail', 'model', 'when'] as const;

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const stringArray = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
    : []
);

const conditionFieldNames = (value: unknown): string[] => {
  const conditions = Array.isArray(value) ? value : [];
  return conditions
    .map((condition) => String(asRecord(condition).field || '').trim())
    .filter(Boolean);
};

/**
 * Fields whose current values participate in a filter/exit freshness hash.
 * Declared `inputs` plus any field referenced by conditions / when / single-field checks.
 */
export const filterInputFields = (stepConfig: any): string[] => {
  const cfg = asRecord(stepConfig);
  const when = asRecord(cfg.when);
  return [...new Set([
    ...stringArray(cfg.inputs),
    ...conditionFieldNames(cfg.conditions),
    ...conditionFieldNames(when.conditions),
    String(cfg.field || '').trim(),
  ].filter(Boolean))];
};

export const filterMaterialConfig = (stepConfig: any, { listDir = '' }: { listDir?: string } = {}): Record<string, any> => {
  const cfg = stepConfig && typeof stepConfig === 'object' ? stepConfig : {};
  const material: Record<string, any> = {};
  for (const field of [...MATERIAL_FILTER_FIELDS].sort()) {
    if (Object.prototype.hasOwnProperty.call(cfg, field) && cfg[field] !== undefined) {
      material[field] = cfg[field];
    }
  }
  if (listDir && Array.isArray(material.conditions)) {
    material.conditions = resolveFieldCheckConditions({
      conditions: material.conditions,
      listDir,
    });
  }
  return material;
};

/** Definition-only hash (config material). Prefer filterDepHash when a record is available. */
export const filterDefHash = (stepConfig: any, { listDir = '' }: { listDir?: string } = {}) => (
  stableHash({ config: filterMaterialConfig(stepConfig, { listDir }) })
);

/**
 * Full filter/exit dependency hash: material config + current declared-input values.
 * Same staleness table / dep_hash column as before — inputs are folded into the hash so
 * a regenerated field invalidates a prior pass without a second freshness system.
 */
export const filterDepHash = ({
  stepConfig,
  record,
  listDir = '',
}: {
  stepConfig: any;
  record?: Record<string, unknown> | null;
  listDir?: string;
}) => {
  const row = record && typeof record === 'object' ? record : {};
  const inputs = Object.fromEntries(
    filterInputFields(stepConfig).map((field) => [field, row[field]]),
  );
  return stableHash({
    config: filterMaterialConfig(stepConfig, { listDir }),
    inputs,
  });
};

export const filterStalenessStepId = (stepId: string) => `filter:${stepId}`;

export const isFilterDefFresh = ({
  cached,
  stepConfig,
  listDir = '',
  record,
}: {
  cached: any;
  stepConfig: any;
  listDir?: string;
  record?: Record<string, unknown> | null;
}) => {
  if (!cached) return false;
  const expected = record
    ? filterDepHash({ stepConfig, record, listDir })
    : filterDefHash(stepConfig, { listDir });
  return String(cached.dep_hash || '') === expected;
};

export const pipelineStepId = (step: any, index: number) => (
  String(step?.id || '').trim() || `pipeline_step_${index + 1}`
);

export const readInPlayRows = ({
  db,
  where = '',
  limit = 0,
  includeOptedOut = false,
}: {
  db: any;
  where?: string;
  limit?: number;
  includeOptedOut?: boolean;
}) => {
  const whereSql = String(where || '').trim();
  const hasLimit = Number(limit || 0) > 0;
  const params = hasLimit ? [Number(limit || 0)] : [];
  const clauses = [
    `SELECT * FROM records WHERE ${inPlayWhere()}${includeOptedOut ? '' : " AND sequence_status != 'opted_out'"}`,
    whereSql ? `AND (${whereSql})` : '',
    'ORDER BY updated_at DESC',
    hasLimit ? 'LIMIT ?' : '',
  ].filter(Boolean);
  return db.prepare(clauses.join(' ')).all(...params);
};

export const writeFilterFailure = ({ db, record, stepId, reason, drop }: { db: any; record: any; stepId: string; reason: string; drop: boolean }): 'dropped' | 'review_flagged' | 'flagged' => {
  const now = new Date().toISOString();
  const extra = (() => {
    try {
      return record?.extra_json && typeof record.extra_json === 'string' ? JSON.parse(record.extra_json) : (record?.extra_json || {});
    } catch {
      return {};
    }
  })();
  const committed = isRecordCommitted(record);
  const softDrop = drop && committed;
  const severity = softDrop ? 'review' : (drop ? 'drop' : 'flag');
  const pipelineFlags = Array.isArray(extra.pipeline_flags) ? extra.pipeline_flags : [];
  const nextExtra = {
    ...extra,
    pipeline_flags: [
      ...pipelineFlags,
      { step_id: stepId, reason, severity, occurred_at: now },
    ],
  };
  upsertRecord({
    db,
    row: {
      ...record,
      ...(softDrop ? {
        needs_review: 1,
        review_reason: `${stepId}: ${reason}`,
        review_flagged_at: now,
      } : {}),
      ...(drop && !committed ? {
        disqualified_at: now,
        disqualified_gate: stepId,
        disqualify_reason: reason,
      } : {}),
      extra_json: nextExtra,
    },
  });
  return softDrop ? 'review_flagged' : (drop ? 'dropped' : 'flagged');
};

export const simulatePipeline = ({ db, listDir, config, steps, baseRows, force, reapply, rerunSteps = [] }: { db: any; listDir: string; config: unknown; steps: any[]; baseRows: any[]; force: boolean; reapply: boolean; rerunSteps?: string[] }) => {
  const holdingPipelines = new Set(
    steps
      .filter((step) => (
        String(step?.kind || '') === 'assign'
        && String(step?.target || '') === PIPELINE_ROUTE_TARGET
      ))
      .map((step) => String(step?.fallback || '').trim())
      .filter(Boolean),
  );
  const state = {
    removed: new Set<string>(),
    parked: new Set<string>(),
    selectedPipelines: new Map(baseRows.map((record) => [
      getRecordRowId(record),
      pipelineNameForRecord({ config, record }) || 'default',
    ])),
    estTotalCostUsd: 0,
    stepReports: [] as any[],
  };
  const committedInScope = baseRows.filter((record) => isRecordCommitted(record)).length;

  steps.forEach((step, index) => {
    const stepId = pipelineStepId(step, index);
    const kind = String(step?.kind || '');
    const subpipeline = stepSubpipelineName(step);
    const active = baseRows.filter((record) => (
      !state.removed.has(getRecordRowId(record))
      && !state.parked.has(getRecordRowId(record))
      && (
        !subpipeline
        || (
          !holdingPipelines.has(subpipeline)
          && state.selectedPipelines.get(getRecordRowId(record)) === subpipeline
        )
      )
    ));

    if (kind === 'enrich') {
      const work = countEnrichWorkForStep({ db, listDir, step, stepId, rows: active, force: force || rerunSteps.includes(stepId) });
      const estCost = avgStepCostUsd({ db, stepId }) * work.would_enrich;
      state.estTotalCostUsd += estCost;
      state.stepReports.push({
        id: stepId, kind, type: 'enrich',
        would_enrich: work.would_enrich,
        would_skip_fresh: work.skip_fresh,
        would_skip_when: work.skip_when,
        est_cost_usd: Number(estCost.toFixed(4)),
      });
      return;
    }

    if (kind === 'review') {
      const evalRows = active.filter((record) => {
        const recordId = getRecordRowId(record);
        const contactId = String((record as any).active_contact_id || (record as any).contact_id || '') || null;
        return !hasPassedStep({ db, recordId, stepId, contactId })
          || isRecordAwaitingReview({ db, recordId, stageId: stepId });
      });
      const skippedPassed = active.length - evalRows.length;
      const matchingRows = evalRows.filter((record) => {
        if (!step?.when || typeof step.when !== 'object') return true;
        return evaluateFieldCheckGroup({
          row: record,
          conditions: Array.isArray(step.when.conditions) ? step.when.conditions : [],
          match: step.when.match || 'all',
          listDir,
        }).passed;
      });
      const skippedWhen = evalRows.length - matchingRows.length;
      const recordIds = matchingRows.map((record) => getRecordRowId(record));
      const placeholders = recordIds.map(() => '?').join(', ');
      const verdictRows = recordIds.length === 0
        ? []
        : db.prepare(`
          SELECT record_id, kind
          FROM overrides
          WHERE (cleared_at IS NULL OR cleared_at = '')
            AND record_id IN (${placeholders})
            AND (
              (kind = 'keep' AND (step_id = ? OR step_id = ''))
              OR (kind = 'drop' AND step_id = '' AND created_by = 'review:' || ?)
            )
        `).all(...recordIds, stepId, stepId);
      const verdicts = verdictRows.reduce((map: Map<string, 'pass' | 'drop'>, row: any) => {
        const recordId = String(row.record_id || '').trim();
        const kindValue = String(row.kind || '').trim();
        const existing = map.get(recordId);
        map.set(recordId, kindValue === 'drop' || existing === 'drop' ? 'drop' : 'pass');
        return map;
      }, new Map<string, 'pass' | 'drop'>());
      const counts = matchingRows.reduce((acc, record) => {
        const recordId = getRecordRowId(record);
        const verdict = verdicts.get(recordId);
        if (verdict === 'pass') return { ...acc, wouldPass: acc.wouldPass + 1 };
        if (verdict === 'drop') {
          state.removed.add(recordId);
          return { ...acc, wouldDrop: acc.wouldDrop + 1 };
        }
        state.parked.add(recordId);
        return { ...acc, wouldAwait: acc.wouldAwait + 1 };
      }, { wouldPass: 0, wouldDrop: 0, wouldAwait: 0 });
      state.stepReports.push({
        id: stepId, kind, type: 'review',
        would_evaluate: evalRows.length, would_skip_passed: skippedPassed, would_skip_when: skippedWhen,
        would_pass: counts.wouldPass, would_drop: counts.wouldDrop, awaiting_review: counts.wouldAwait,
        est_cost_usd: 0,
      });
      return;
    }

    if (kind === 'assign') {
      const rules = Array.isArray(step?.rules) ? step.rules : [];
      const deterministic = rules.every((rule: any) => String(rule?.type || 'field_check') === 'field_check');
      const idle = active.filter((record) => String(record?.sequence_status || 'idle') === 'idle');
      const target = String(step?.target || 'sequence_name');
      const destinationKey = target === PIPELINE_ROUTE_TARGET ? 'pipeline' : 'sequence';
      const bySequence = deterministic
        ? idle.reduce((counts: Record<string, number>, record) => {
          const matched = rules.find((rule: any) => evaluateFieldCheckGroup({
            row: record,
            conditions: Array.isArray(rule?.conditions) ? rule.conditions : [],
            match: rule?.match || 'all',
            listDir,
          }).passed);
          const destination = String(matched?.[destinationKey] || step?.fallback || '');
          if (target === PIPELINE_ROUTE_TARGET) {
            state.selectedPipelines.set(getRecordRowId(record), destination);
          }
          return { ...counts, [destination]: Number(counts[destination] || 0) + 1 };
        }, {})
        : {};
      state.stepReports.push({
        id: stepId,
        kind,
        type: deterministic ? 'field_check' : 'semantic',
        would_evaluate: idle.length,
        would_skip_launched: active.length - idle.length,
        [target === PIPELINE_ROUTE_TARGET ? 'by_pipeline' : 'by_sequence']: deterministic ? bySequence : null,
        note: deterministic ? undefined : 'semantic assignments are not simulated',
        est_cost_usd: 0,
      });
      return;
    }

    if (kind !== 'filter') {
      state.stepReports.push({ id: stepId, kind, type: kind, note: `unsupported_pipeline_step_kind:${kind}` });
      return;
    }

    const filterType = String(step?.type || 'semantic').trim().toLowerCase();
    const onFail = String(step?.on_fail || 'drop').trim().toLowerCase() === 'flag' ? 'flag' : 'drop';
    const evalRows = reapply ? active : active.filter((record) => {
      const recordId = getRecordRowId(record);
      const contactId = String((record as any).active_contact_id || (record as any).contact_id || '') || null;
      if (!hasPassedStep({ db, recordId, stepId, contactId })) return true;
      const cached = readStaleness({ db, recordId, stepId: filterStalenessStepId(stepId) });
      return !isFilterDefFresh({ cached, stepConfig: step, listDir, record });
    });
    const skippedPassed = active.length - evalRows.length;
    // A filter skipped by `when` passes the record through at runtime, so the preview must not evaluate or drop it.
    const whenRows = evalRows.filter((record) => {
      if (!step?.when || typeof step.when !== 'object') return true;
      return evaluateFieldCheckGroup({
        row: record,
        conditions: Array.isArray(step.when.conditions) ? step.when.conditions : [],
        match: step.when.match || 'all',
        listDir,
      }).passed;
    });
    const skippedWhen = evalRows.length - whenRows.length;

    if (filterType === 'field_check') {
      const counts = whenRows.reduce((acc, record) => {
        const outcome = evaluateFieldCheckGroup({
          row: record,
          conditions: Array.isArray(step?.conditions) ? step.conditions : [],
          match: step?.match || 'all',
          listDir,
        });
        if (outcome.passed || onFail !== 'drop') return acc;
        if (isRecordCommitted(record)) return { ...acc, wouldDropCommitted: acc.wouldDropCommitted + 1 };
        state.removed.add(getRecordRowId(record));
        return { ...acc, wouldDrop: acc.wouldDrop + 1 };
      }, { wouldDrop: 0, wouldDropCommitted: 0 });
      state.stepReports.push({
        id: stepId, kind, type: 'field_check',
        would_evaluate: whenRows.length, would_skip_passed: skippedPassed, would_skip_when: skippedWhen,
        would_drop: counts.wouldDrop, would_review_flag: counts.wouldDropCommitted, est_cost_usd: 0,
      });
      return;
    }

    const estCost = avgStepCostUsd({ db, stepId }) * whenRows.length;
    state.estTotalCostUsd += estCost;
    state.stepReports.push({
      id: stepId, kind, type: 'semantic',
      would_evaluate: whenRows.length, would_skip_passed: skippedPassed, would_skip_when: skippedWhen,
      would_drop: null, note: 'semantic verdicts not simulated', est_cost_usd: Number(estCost.toFixed(4)),
    });
  });

  return {
    dry_run: true,
    records_in_scope: baseRows.length,
    committed_in_scope: committedInScope,
    steps: state.stepReports,
    est_total_cost_usd: Number(state.estTotalCostUsd.toFixed(4)),
    note: 'Dry-run performs no writes. Committed records would be review-flagged, not dropped.',
  };
};
