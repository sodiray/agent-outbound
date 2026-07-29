import { hasPassedStep, inPlayWhere, isRecordCommitted, upsertRecord } from '../runtime/db.js';
import { evaluateFieldCheckGroup } from '../lib/conditions.js';
import { countEnrichWorkForStep, readStaleness } from '../enrichment/runner.js';
import { avgStepCostUsd } from '../lib/costs.js';
import { getRecordRowId, stableHash } from '../lib/record.js';
import { isRecordAwaitingReview } from './review.js';
import { resolveFieldCheckConditions } from '../lib/field-check-values.js';

const MATERIAL_FILTER_FIELDS = ['type', 'match', 'condition', 'conditions', 'value', 'operator', 'field', 'on_fail', 'model'] as const;

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

export const filterDefHash = (stepConfig: any, { listDir = '' }: { listDir?: string } = {}) => (
  stableHash({ config: filterMaterialConfig(stepConfig, { listDir }) })
);

export const filterStalenessStepId = (stepId: string) => `filter:${stepId}`;

export const isFilterDefFresh = ({ cached, stepConfig, listDir = '' }: { cached: any; stepConfig: any; listDir?: string }) => (
  !cached || String(cached.dep_hash || '') === filterDefHash(stepConfig, { listDir })
);

export const pipelineStepId = (step: any, index: number) => (
  String(step?.id || '').trim() || `pipeline_step_${index + 1}`
);

export const readInPlayRows = ({ db, where = '', limit = 0 }: { db: any; where?: string; limit?: number }) => {
  const whereSql = String(where || '').trim();
  const hasLimit = Number(limit || 0) > 0;
  const params = hasLimit ? [Number(limit || 0)] : [];
  const clauses = [
    `SELECT * FROM records WHERE ${inPlayWhere()} AND sequence_status != 'opted_out'`,
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

export const simulatePipeline = ({ db, listDir, steps, baseRows, force, reapply }: { db: any; listDir: string; steps: any[]; baseRows: any[]; force: boolean; reapply: boolean }) => {
  const state = {
    removed: new Set<string>(),
    parked: new Set<string>(),
    estTotalCostUsd: 0,
    stepReports: [] as any[],
  };
  const committedInScope = baseRows.filter((record) => isRecordCommitted(record)).length;

  steps.forEach((step, index) => {
    const stepId = pipelineStepId(step, index);
    const kind = String(step?.kind || '');
    const active = baseRows.filter((record) => (
      !state.removed.has(getRecordRowId(record))
      && !state.parked.has(getRecordRowId(record))
    ));

    if (kind === 'enrich') {
      const work = countEnrichWorkForStep({ db, listDir, step, stepId, rows: active, force });
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
        return !hasPassedStep({ db, recordId, stepId })
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

    if (kind !== 'filter') {
      state.stepReports.push({ id: stepId, kind, type: kind, note: `unsupported_pipeline_step_kind:${kind}` });
      return;
    }

    const filterType = String(step?.type || 'semantic').trim().toLowerCase();
    const onFail = String(step?.on_fail || 'drop').trim().toLowerCase() === 'flag' ? 'flag' : 'drop';
    const evalRows = reapply ? active : active.filter((record) => {
      const recordId = getRecordRowId(record);
      if (!hasPassedStep({ db, recordId, stepId })) return true;
      const cached = readStaleness({ db, recordId, stepId: filterStalenessStepId(stepId) });
      return !isFilterDefFresh({ cached, stepConfig: step, listDir });
    });
    const skippedPassed = active.length - evalRows.length;

    if (filterType === 'field_check') {
      const counts = evalRows.reduce((acc, record) => {
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
        would_evaluate: evalRows.length, would_skip_passed: skippedPassed,
        would_drop: counts.wouldDrop, would_review_flag: counts.wouldDropCommitted, est_cost_usd: 0,
      });
      return;
    }

    const estCost = avgStepCostUsd({ db, stepId }) * evalRows.length;
    state.estTotalCostUsd += estCost;
    state.stepReports.push({
      id: stepId, kind, type: 'semantic',
      would_evaluate: evalRows.length, would_skip_passed: skippedPassed,
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
