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
import { getRecordById, openListDb, reconcileOverrides } from '../orchestrator/runtime/db.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';

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
}: {
  list: string;
  ref: string;
  stage: string;
  verdict: 'pass' | 'drop';
  reason?: string;
}) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const db = openListDb({ listDir, readonly: false });
  try {
    const decision = insertReviewDecision({ db, config, ref, stageId: stage, verdict, reason });
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

export const reviewPassCommand = ({ list, ref, stage, reason = '' }: { list: string; ref: string; stage: string; reason?: string }) => (
  reviewVerdictCommand({ list, ref, stage, verdict: 'pass', reason })
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
