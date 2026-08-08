import { randomUUID } from 'node:crypto';
import { readConfig } from '../lib/config.js';
import { getRecordRowId } from '../lib/record.js';
import { assertPhaseModelReferences } from '../lib/model-validation.js';
import { validateWhereSql } from '../lib/sql-safety.js';
import { flattenPipelineSteps } from '../lib/subpipelines.js';
import {
  inPlayWhere,
  insertPipelineEvent,
  openListDb,
} from '../runtime/db.js';
import {
  assertListAccessForMutation,
  filterRecordsForCanary,
  loadCanaryConfig,
} from '../policy/canary-isolation.js';
import { runScoreStage, type ScoreStage } from './stage-runner.js';

const scoreStagesFrom = (config: Record<string, unknown>): ScoreStage[] => (
  flattenPipelineSteps(config)
    .filter((step) => String(step.kind || '').trim().toLowerCase() === 'score')
    .map((step) => ({
      id: String(step.id || '').trim(),
      key: String(step.key || '').trim(),
      model: String(step.model || '').trim(),
      criteria: Array.isArray(step.criteria) ? step.criteria as ScoreStage['criteria'] : [],
      inputs: step.inputs,
      outputs: step.outputs && typeof step.outputs === 'object' && !Array.isArray(step.outputs)
        ? step.outputs as ScoreStage['outputs']
        : {},
    }))
    .filter((step) => step.id && step.key)
);

const rowsForScoreStages = ({ db, where, limit }: {
  db: { prepare: (sql: string) => { all: () => Array<Record<string, unknown>> } };
  where: string;
  limit: number;
}) => {
  const sql = `
    SELECT * FROM records
    WHERE ${inPlayWhere()} ${where ? `AND (${where})` : ''}
    ORDER BY updated_at DESC
    ${limit > 0 ? `LIMIT ${limit}` : ''}
  `;
  return db.prepare(sql).all();
};

const refreshedRows = ({ db, rows }: {
  db: { prepare: (sql: string) => { get: (...values: unknown[]) => Record<string, unknown> | undefined } };
  rows: Array<Record<string, unknown>>;
}) => rows.flatMap((row) => {
  const id = getRecordRowId(row);
  const refreshed = db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1').get(id, id);
  return refreshed ? [refreshed] : [];
});

type ScoreStageRunSummary = {
  records: number;
  score_stages: string[];
  processed: number;
  skipped_unchanged: number;
  failed: number;
  errors: Array<{ stage: string; record_id: string; error: string }>;
  by_stage: Record<string, { processed: number; skipped_unchanged: number; failed: number }>;
};

type StageOutcomeSummary = Pick<ScoreStageRunSummary, 'processed' | 'skipped_unchanged' | 'failed' | 'errors'>;

type ScoreStageRunState = ScoreStageRunSummary & { rows: Array<Record<string, unknown>> };

export const runConfiguredScoreStages = async ({
  listDir,
  where = '',
  limit = 0,
  dryRun = false,
  force = false,
}: {
  listDir: string;
  where?: string;
  limit?: number;
  dryRun?: boolean;
  force?: boolean;
}) => {
  const whereSql = String(where || '').trim();
  const whereCheck = validateWhereSql(whereSql);
  if (!whereCheck.ok) throw new Error(whereCheck.error || 'Invalid --where SQL fragment.');
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) throw new Error(`Invalid config: ${errors.join('; ')}`);
  assertPhaseModelReferences({ config, phase: 'score' });
  const stages = scoreStagesFrom(config);
  const db = openListDb({ listDir, readonly: dryRun });
  try {
    const canary = loadCanaryConfig({ listDir });
    const rows = filterRecordsForCanary(
      rowsForScoreStages({ db, where: whereSql, limit: Math.max(0, Number(limit || 0)) }),
      canary,
    );
    if (dryRun) {
      return {
        dry_run: true,
        records: rows.length,
        score_stages: stages.map((stage) => stage.id),
        where: whereSql,
      };
    }
    assertListAccessForMutation(listDir);
    const initial: ScoreStageRunState = {
      records: rows.length,
      score_stages: stages.map((stage) => stage.id),
      processed: 0,
      skipped_unchanged: 0,
      failed: 0,
      errors: [],
      by_stage: {},
      rows,
    };
    const result = await stages.reduce<Promise<ScoreStageRunState>>(async (pending, stage) => {
      const state = await pending;
      const outcomes = await runScoreStage({
        db,
        listDir,
        config,
        step: stage,
        rows: state.rows,
        force,
      });
      const stageSummary = state.rows.reduce<StageOutcomeSummary>((summary, row) => {
        const recordId = getRecordRowId(row);
        const outcome = outcomes.get(recordId);
        const reason = String(outcome?.reason || 'score_stage_missing_outcome');
        const failed = Boolean(outcome?.errored || !outcome?.passed);
        insertPipelineEvent({
          db,
          event: {
            event_id: randomUUID(),
            record_id: recordId,
            step_id: stage.id,
            kind: 'score',
            passed: !failed,
            reason,
          },
        });
        return {
          processed: summary.processed + Number(!failed && !reason.startsWith('skipped_')),
          skipped_unchanged: summary.skipped_unchanged + Number(reason === 'skipped_unchanged_inputs'),
          failed: summary.failed + Number(failed),
          errors: failed
            ? [...summary.errors, { stage: stage.id, record_id: recordId, error: reason }]
            : summary.errors,
        };
      }, {
        processed: 0,
        skipped_unchanged: 0,
        failed: 0,
        errors: [] as ScoreStageRunSummary['errors'],
      });
      const currentRows = refreshedRows({ db, rows: state.rows });
      const nextRows = currentRows.filter((row) => {
        const outcome = outcomes.get(getRecordRowId(row));
        return !outcome?.errored;
      });
      return {
        ...state,
        processed: state.processed + stageSummary.processed,
        skipped_unchanged: state.skipped_unchanged + stageSummary.skipped_unchanged,
        failed: state.failed + stageSummary.failed,
        errors: [...state.errors, ...stageSummary.errors],
        by_stage: {
          ...state.by_stage,
          [stage.id]: {
            processed: stageSummary.processed,
            skipped_unchanged: stageSummary.skipped_unchanged,
            failed: stageSummary.failed,
          },
        },
        rows: nextRows,
      };
    }, Promise.resolve(initial));
    const { rows: _rows, ...summary } = result;
    return summary;
  } finally {
    db.close();
  }
};
