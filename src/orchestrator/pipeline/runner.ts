import { randomUUID } from 'node:crypto';
import { inPlayWhere, insertPipelineEvent, logPipelineEvent, openListDb, upsertRecord } from '../runtime/db.js';
import { readConfig } from '../lib/config.js';
import { emitActivity } from '../runtime/activity.js';
import { getRecordRowId } from '../lib/record.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { getMcpClient } from '../runtime/mcp.js';
import { readToolCatalog } from '../lib/tool-catalog.js';
import { assertPhaseModelReferences } from '../lib/model-validation.js';
import { evaluateFieldCheckGroup, evaluateSemanticFilterBatches } from '../lib/conditions.js';
import { executeEnrichmentStepOnRecords } from '../enrichment/runner.js';

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

const writeFilterFailure = ({ db, record, stepId, reason, drop }: { db: any; record: any; stepId: string; reason: string; drop: boolean }) => {
  const now = new Date().toISOString();
  const extra = (() => {
    try {
      return record?.extra_json && typeof record.extra_json === 'string' ? JSON.parse(record.extra_json) : (record?.extra_json || {});
    } catch {
      return {};
    }
  })();
  const pipelineFlags = Array.isArray(extra.pipeline_flags) ? extra.pipeline_flags : [];
  const nextExtra = {
    ...extra,
    pipeline_flags: [
      ...pipelineFlags,
      { step_id: stepId, reason, occurred_at: now },
    ],
  };
  upsertRecord({
    db,
    row: {
      ...record,
      ...(drop ? {
        disqualified_at: now,
        disqualified_gate: stepId,
        disqualify_reason: reason,
      } : {}),
      extra_json: nextExtra,
    },
  });
};

export const runPipeline = async ({ listDir, where = '', limit = 0, dryRun = false }) => {
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
    errors: [] as any[],
  };

  emitActivity({ event: 'phase_start', phase: 'pipeline', rows: recordsIn, steps: steps.length });

  try {
    if (dryRun) {
      return { ...summary, dry_run: true, note: 'Dry-run performs no writes.' };
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

      if (filterType === 'field_check') {
        await mapWithConcurrency<any, void>(rows as any[], async (record) => {
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
          rows,
          aiConfig: config?.ai || {},
          batchSize: Number(step?.batch_size || 10),
        });
        for (const [recordId, outcome] of semantic.entries()) outcomes.set(recordId, outcome);
      }

      let dropped = 0;
      const now = new Date().toISOString();
      for (const record of rows) {
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
          if (drop) dropped += 1;
          writeFilterFailure({ db, record, stepId, reason, drop });
        }
      }

      byStep[stepId] = dropped;
      emitActivity({ event: 'step_complete', phase: 'pipeline', step: stepId, kind, dropped, rows: rows.length });
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
