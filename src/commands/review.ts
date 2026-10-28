import { readConfig } from '../orchestrator/lib/config.js';
import {
  clearReviewDecision,
  getReviewQueue,
  getReviewStages,
  insertReviewDecision,
  reviewDecisionResult,
  reviewRecordDecisionState,
  reviewRecordLabel,
} from '../orchestrator/pipeline/review.js';
import { ensureRecordColumns, getRecordById, openListDb, reconcileOverrides, upsertRecord } from '../orchestrator/runtime/db.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';

type EventReviewStep = Record<string, unknown> & { block_id: string };

const eventReviewStep = (config: Record<string, unknown>, stage: string): EventReviewStep | undefined => (Array.isArray(config.pipeline) ? config.pipeline : [])
  .flatMap((rawBlock) => {
    const block = rawBlock && typeof rawBlock === 'object' && !Array.isArray(rawBlock) ? rawBlock as Record<string, unknown> : {};
    return block.kind === 'on_event' && Array.isArray(block.steps)
      ? block.steps.flatMap((rawStep) => {
        const step = rawStep && typeof rawStep === 'object' && !Array.isArray(rawStep) ? rawStep as Record<string, unknown> : null;
        return step ? [{ ...step, block_id: String(block.id || '') } as EventReviewStep] : [];
      }) : [];
  })
  .find((step) => step.kind === 'review' && String(step.id || '') === stage);

const eventReviewQueue = ({ db, config, stage, limit, offset }: { db: any; config: Record<string, unknown>; stage: string; limit: number; offset: number }) => {
  const review = eventReviewStep(config, stage);
  if (!review) return null;
  const rows = db.prepare(`SELECT record.*, turn.turn_index AS _turn_index, turn.block_id AS _turn_block_id
    FROM event_turn_steps step JOIN event_turns turn ON turn.turn_id = step.turn_id
    JOIN records record ON record._row_id = turn.record_id
    WHERE step.step_id = ? AND step.status = 'awaiting_review' AND turn.status = 'open'
    ORDER BY turn.opened_at, turn.turn_index LIMIT ? OFFSET ?`).all(stage, limit, offset);
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM event_turn_steps step JOIN event_turns turn ON turn.turn_id = step.turn_id
    WHERE step.step_id = ? AND step.status = 'awaiting_review' AND turn.status = 'open'`).get(stage)?.n || 0);
  return { stage: { id: stage, label: String(review.label || stage), fields: review.fields || [], edit_fields: review.edit_fields || [] }, total, limit, offset, records: rows };
};

export const reviewStagesCommand = ({ list }: { list: string }) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const db = openListDb({ listDir, readonly: true });
  try {
    const stages = getReviewStages({ db, config });
    return { count: stages.length, stages };
  } finally {
    db.close();
  }
};

export const reviewListCommand = ({
  list,
  stage,
  limit = 100,
  offset = 0,
}: {
  list: string;
  stage: string;
  limit?: number;
  offset?: number;
}) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const db = openListDb({ listDir, readonly: true });
  try {
    const eventQueue = eventReviewQueue({ db, config, stage, limit, offset });
    if (eventQueue) return eventQueue;
    return getReviewQueue({ db, config, stageId: stage, limit, offset });
  } finally {
    db.close();
  }
};

const reviewVerdictCommand = ({
  list,
  ref,
  stage,
  verdict,
  reason = '',
  edits = {},
}: {
  list: string;
  ref: string;
  stage: string;
  verdict: 'pass' | 'drop';
  reason?: string;
  edits?: Record<string, string>;
}) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const db = openListDb({ listDir, readonly: false });
  try {
    const eventStep = eventReviewStep(config, stage);
    if (eventStep) {
      const record = getRecordById({ db, id: ref });
      if (!record) throw new Error('Record not found.');
      const turn = db.prepare(`SELECT turn.* FROM event_turns turn JOIN event_turn_steps step ON step.turn_id = turn.turn_id
        WHERE turn.record_id = ? AND turn.status = 'open' AND step.step_id = ? AND step.status = 'awaiting_review'
        ORDER BY turn.turn_index DESC LIMIT 1`).get(ref, stage);
      if (!turn) throw new Error('Record is not awaiting review at this event turn stage.');
      const editable = new Set(Array.isArray(eventStep.edit_fields) ? eventStep.edit_fields.map(String) : []);
      if (Object.keys(edits).some((field) => !editable.has(field))) throw new Error('Review edits must name configured edit_fields.');
      ensureRecordColumns({ db, columns: Object.keys(edits) });
      if (Object.keys(edits).length > 0) upsertRecord({ db, row: { ...record, ...edits } });
      db.prepare('UPDATE event_turn_steps SET status = ?, reason = ?, occurred_at = ? WHERE turn_id = ? AND step_id = ?')
        .run(verdict === 'pass' ? 'passed' : 'dropped', verdict === 'pass' ? 'review: approved' : 'review: dropped', new Date().toISOString(), turn.turn_id, stage);
      if (verdict === 'drop') db.prepare("UPDATE event_turns SET status = 'completed', completed_at = ? WHERE turn_id = ?").run(new Date().toISOString(), turn.turn_id);
      return { status: verdict === 'pass' ? 'review_approved' : 'review_rejected', stage, turn_index: turn.turn_index, note: 'Run `pipeline` to advance this event turn.' };
    }
    const decision = insertReviewDecision({ db, config, ref, stageId: stage, verdict, reason, edits });
    reconcileOverrides({ db });
    return {
      status: verdict === 'pass' ? 'review_approved' : 'review_rejected',
      stage: decision.stage,
      override: decision.override,
      ...reviewDecisionResult({ db, decision }),
      note: verdict === 'pass' ? 'Run `pipeline` to advance this lead through the remaining steps.' : undefined,
    };
  } finally {
    db.close();
  }
};

export const reviewPassCommand = ({ list, ref, stage, reason = '', edits = {} }: { list: string; ref: string; stage: string; reason?: string; edits?: Record<string, string> }) => (
  reviewVerdictCommand({ list, ref, stage, verdict: 'pass', reason, edits })
);

export const reviewDropCommand = ({ list, ref, stage, reason = '' }: { list: string; ref: string; stage: string; reason?: string }) => (
  reviewVerdictCommand({ list, ref, stage, verdict: 'drop', reason })
);

export const reviewClearCommand = ({
  list,
  ref,
  stage,
  clearedBy = '',
}: {
  list: string;
  ref: string;
  stage: string;
  clearedBy?: string;
}) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const db = openListDb({ listDir, readonly: false });
  try {
    const result = clearReviewDecision({ db, config, ref, stageId: stage, clearedBy });
    reconcileOverrides({ db });
    const record = getRecordById({ db, id: String(result.record._row_id) }) || result.record;
    if (result.cleared.length === 0) {
      return {
        status: 'noop',
        stage: result.stage,
        record: reviewRecordLabel(record),
        state: reviewRecordDecisionState(record),
        note: 'No active verdict exists for this record at this review stage.',
      };
    }
    return {
      status: 'review_cleared',
      stage: result.stage,
      cleared_count: result.cleared.length,
      cleared: result.cleared.map((override: any) => ({
        id: String(override.id || ''),
        kind: String(override.kind || ''),
        step_id: String(override.step_id || ''),
        reason: String(override.reason || ''),
      })),
      record: reviewRecordLabel(record),
      state: reviewRecordDecisionState(record),
    };
  } finally {
    db.close();
  }
};
