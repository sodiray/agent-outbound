import { randomUUID } from 'node:crypto';
import { hasPassedStep, inPlayWhere, insertPipelineEvent, isRecordCommitted, logPipelineEvent, openListDb, upsertRecord } from '../runtime/db.js';
import { readConfig } from '../lib/config.js';
import { emitActivity } from '../runtime/activity.js';
import { getRecordRowId } from '../lib/record.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { getMcpClient } from '../runtime/mcp.js';
import { readToolCatalog } from '../lib/tool-catalog.js';
import { assertPhaseModelReferences } from '../lib/model-validation.js';
import { evaluateFieldCheckGroup, evaluateSemanticFilterBatches } from '../lib/conditions.js';
import { countEnrichWorkForStep, executeEnrichmentStepOnRecords } from '../enrichment/runner.js';
import { avgStepCostUsd } from '../lib/costs.js';

const pipelineStepId = (step: any, index: number) => (
  String(step?.id || '').trim() || `pipeline_step_${index + 1}`
);

const readInPlayRows = ({ db, where = '', limit = 0 }: { db: any; where?: string; limit?: number }) => {
  const whereSql = String(where || '').trim();
  const params: any[] = [];
  let sql = `SELECT * FROM records WHERE ${inPlayWhere()} AND sequence_status != 'opted_out'`;
  if (whereSql) sql += ` AND (${whereSql})`;
  sql += ' ORDER BY updated_at DESC';
  if (Number(limit || 0) > 0) {
    sql += ' LIMIT ?';
    params.push(Number(limit || 0));
  }
  return db.prepare(sql).all(...params);
};

// Returns what actually happened to the record so the caller can count correctly:
// 'dropped' (hard-disqualified), 'review_flagged' (committed → soft-drop, never
// disqualified), or 'flagged' (on_fail: flag).
const writeFilterFailure = ({ db, record, stepId, reason, drop }: { db: any; record: any; stepId: string; reason: string; drop: boolean }): 'dropped' | 'review_flagged' | 'flagged' => {
  const now = new Date().toISOString();
  const extra = (() => {
    try {
      return record?.extra_json && typeof record.extra_json === 'string' ? JSON.parse(record.extra_json) : (record?.extra_json || {});
    } catch {
      return {};
    }
  })();
  // A filter must never destroy work already invested in a committed record. Past
  // the commit line a would-be DROP becomes a review flag instead.
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

// Non-writing simulation of a pipeline run: reports what a real run WOULD do
// (re-enrich counts + estimated cost, would-drop counts incl. committed records
// that would be soft-dropped) so a config change's blast radius is visible first.
const simulatePipeline = ({ db, steps, baseRows, force, reapply }: { db: any; steps: any[]; baseRows: any[]; force: boolean; reapply: boolean }) => {
  const removed = new Set<string>();
  const committedInScope = baseRows.filter((r) => isRecordCommitted(r)).length;
  const stepReports: any[] = [];
  let estTotalCostUsd = 0;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const stepId = pipelineStepId(step, index);
    const kind = String(step?.kind || '');
    const active = baseRows.filter((r) => !removed.has(getRecordRowId(r)));

    if (kind === 'enrich') {
      const work = countEnrichWorkForStep({ db, step, stepId, rows: active, force });
      const estCost = avgStepCostUsd({ db, stepId }) * work.would_enrich;
      estTotalCostUsd += estCost;
      stepReports.push({
        id: stepId, kind, type: 'enrich',
        would_enrich: work.would_enrich,
        would_skip_fresh: work.skip_fresh,
        would_skip_when: work.skip_when,
        est_cost_usd: Number(estCost.toFixed(4)),
      });
      continue;
    }

    if (kind !== 'filter') {
      stepReports.push({ id: stepId, kind, type: kind, note: `unsupported_pipeline_step_kind:${kind}` });
      continue;
    }

    const filterType = String(step?.type || 'semantic').trim().toLowerCase();
    const onFail = String(step?.on_fail || 'drop').trim().toLowerCase() === 'flag' ? 'flag' : 'drop';
    const evalRows = reapply ? active : active.filter((r) => !hasPassedStep({ db, recordId: getRecordRowId(r), stepId }));
    const skippedPassed = active.length - evalRows.length;

    if (filterType === 'field_check') {
      let wouldDrop = 0;
      let wouldDropCommitted = 0;
      for (const record of evalRows) {
        const outcome = evaluateFieldCheckGroup({
          row: record,
          conditions: Array.isArray(step?.conditions) ? step.conditions : [],
          match: step?.match || 'all',
        });
        if (!outcome.passed && onFail === 'drop') {
          if (isRecordCommitted(record)) {
            wouldDropCommitted += 1; // becomes a review flag, stays in play
          } else {
            wouldDrop += 1;
            removed.add(getRecordRowId(record));
          }
        }
      }
      stepReports.push({
        id: stepId, kind, type: 'field_check',
        would_evaluate: evalRows.length, would_skip_passed: skippedPassed,
        would_drop: wouldDrop, would_review_flag: wouldDropCommitted, est_cost_usd: 0,
      });
      continue;
    }

    // semantic: do not spend LLM calls in a dry-run; report scope + estimated cost.
    const estCost = avgStepCostUsd({ db, stepId }) * evalRows.length;
    estTotalCostUsd += estCost;
    stepReports.push({
      id: stepId, kind, type: 'semantic',
      would_evaluate: evalRows.length, would_skip_passed: skippedPassed,
      would_drop: null, note: 'semantic verdicts not simulated', est_cost_usd: Number(estCost.toFixed(4)),
    });
  }

  return {
    dry_run: true,
    records_in_scope: baseRows.length,
    committed_in_scope: committedInScope,
    steps: stepReports,
    est_total_cost_usd: Number(estTotalCostUsd.toFixed(4)),
    note: 'Dry-run performs no writes. Committed records would be review-flagged, not dropped.',
  };
};

export const runPipeline = async ({ listDir, where = '', limit = 0, dryRun = false, force = false, reapply = false }) => {
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) throw new Error(`Invalid config: ${errors.join('; ')}`);
  assertPhaseModelReferences({ config, phase: 'pipeline' });

  const steps: any[] = Array.isArray(config?.pipeline) ? config.pipeline as any[] : [];
  const db = openListDb({ listDir, readonly: false });
  let mcp: any = null;
  let toolCatalog: any = null;
  const recordsIn = readInPlayRows({ db, where, limit }).length;
  const byStep: Record<string, number> = {};
  const summary = {
    records_in: recordsIn,
    by_step: byStep,
    survivors: recordsIn,
    steps: steps.length,
    processed: 0,
    failed: 0,
    review_flagged: 0,
    skipped_passed: 0,
    errors: [] as any[],
  };

  emitActivity({ event: 'phase_start', phase: 'pipeline', rows: recordsIn, steps: steps.length });

  try {
    if (dryRun) {
      return simulatePipeline({ db, steps, baseRows: readInPlayRows({ db, where, limit }), force, reapply });
    }

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const stepId = pipelineStepId(step, index);
      const kind = String(step?.kind || '');
      const rows = readInPlayRows({ db, where, limit });
      emitActivity({ event: 'step_start', phase: 'pipeline', step: stepId, kind, rows: rows.length });

      if (kind === 'enrich') {
        if (!mcp) mcp = await getMcpClient();
        if (!toolCatalog) toolCatalog = readToolCatalog(listDir);
        const result = await executeEnrichmentStepOnRecords({
          db,
          listDir,
          config,
          mcp,
          toolCatalog,
          step,
          rows,
          stepId,
          force,
        });
        summary.processed += result.processed;
        summary.failed += result.failed;
        summary.errors.push(...result.errors.map((error) => ({ step: stepId, ...error })));
        const now = new Date().toISOString();
        for (const recordId of result.record_ids) {
          insertPipelineEvent({
            db,
            event: {
              event_id: randomUUID(),
              record_id: recordId,
              step_id: stepId,
              kind,
              passed: true,
              reason: '',
              occurred_at: now,
            },
          });
        }
        emitActivity({ event: 'step_complete', phase: 'pipeline', step: stepId, kind, processed: result.processed, failed: result.failed });
        continue;
      }

      if (kind !== 'filter') {
        summary.errors.push({ step: stepId, error: `unsupported_pipeline_step_kind:${kind}` });
        continue;
      }

      const filterType = String(step?.type || 'semantic').trim().toLowerCase();
      const onFail = String(step?.on_fail || 'drop').trim().toLowerCase() === 'flag' ? 'flag' : 'drop';
      const outcomes = new Map<string, { passed: boolean; reason: string }>();

      // Idempotent by default: a record that already PASSED this step is not
      // re-judged (and, for semantic filters, not re-charged) unless --reapply.
      // New/changed filters still evaluate records that never passed.
      const evalRows = reapply
        ? rows
        : (rows as any[]).filter((record) => !hasPassedStep({ db, recordId: getRecordRowId(record), stepId }));
      const skippedPassed = rows.length - evalRows.length;
      summary.skipped_passed += skippedPassed;

      if (filterType === 'field_check') {
        await mapWithConcurrency<any, void>(evalRows as any[], async (record) => {
          const outcome = evaluateFieldCheckGroup({
            row: record,
            conditions: Array.isArray(step?.conditions) ? step.conditions : [],
            match: step?.match || 'all',
          });
          outcomes.set(getRecordRowId(record), outcome);
        }, Number(step?.concurrency || 10));
      } else {
        const semantic = await evaluateSemanticFilterBatches({
          db,
          listDir,
          filter: step,
          rows: evalRows,
          aiConfig: config?.ai || {},
          batchSize: Number(step?.batch_size || 10),
        });
        for (const [recordId, outcome] of semantic.entries()) outcomes.set(recordId, outcome);
      }

      let dropped = 0;
      let reviewFlagged = 0;
      const now = new Date().toISOString();
      for (const record of evalRows) {
        const recordId = getRecordRowId(record);
        const outcome = outcomes.get(recordId) || { passed: false, reason: 'no_result' };
        const reason = outcome.passed ? '' : (String(outcome.reason || '').trim() || 'failed');
        insertPipelineEvent({
          db,
          event: {
            event_id: randomUUID(),
            record_id: recordId,
            step_id: stepId,
            kind,
            passed: outcome.passed,
            reason,
            occurred_at: now,
          },
        });
        if (!outcome.passed) {
          const drop = onFail === 'drop';
          const action = writeFilterFailure({ db, record, stepId, reason, drop });
          if (action === 'dropped') dropped += 1;
          else if (action === 'review_flagged') reviewFlagged += 1;
        }
      }

      byStep[stepId] = dropped;
      summary.review_flagged += reviewFlagged;
      emitActivity({ event: 'step_complete', phase: 'pipeline', step: stepId, kind, dropped, review_flagged: reviewFlagged, skipped_passed: skippedPassed, rows: evalRows.length });
    }

    summary.survivors = Number(db.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${inPlayWhere()}`).get()?.n || 0);
    const funnel = {
      records_in: summary.records_in,
      by_step: summary.by_step,
      survivors: summary.survivors,
    };
    logPipelineEvent({ listDir, payload: funnel });
    emitActivity({ event: 'phase_complete', phase: 'pipeline', ...funnel });
    return summary;
  } finally {
    db.close();
  }
};
