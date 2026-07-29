import { AgentOutboundError } from '../runtime/contract.js';
import {
  clearOverrides,
  getRecordById,
  inPlayWhere,
  insertOverride,
  OVERRIDE_GATE,
  resolveRecordRef,
} from '../runtime/db.js';

export type ReviewStage = {
  id: string;
  label: string;
  description: string;
  fields: string[];
};

export type ReviewDecision = {
  row_id?: unknown;
  verdict?: unknown;
  reason?: unknown;
};

const quoteIdent = (value: string) => `"${String(value).replaceAll('"', '""')}"`;

const recordColumns = (db: any) => new Set(
  db.prepare('PRAGMA table_info(records)').all()
    .map((column: any) => String(column?.name || '').trim())
    .filter(Boolean),
);

export const configuredReviewStages = (config: any): ReviewStage[] => (
  Array.isArray(config?.pipeline) ? config.pipeline : []
)
  .filter((step: any) => String(step?.kind || '') === 'review')
  .map((step: any) => {
    const id = String(step?.id || '').trim();
    const label = String(step?.label || '').trim();
    return {
      id,
      label: label || id,
      description: String(step?.description || ''),
      fields: Array.isArray(step?.fields)
        ? step.fields.map((field: unknown) => String(field || '').trim()).filter(Boolean)
        : [],
    };
  })
  .filter((stage) => stage.id);

export const requireReviewStage = ({ config, stageId }: { config: any; stageId: string }) => {
  const stages = configuredReviewStages(config);
  const id = String(stageId || '').trim();
  const stage = stages.find((candidate) => candidate.id === id);
  if (stage) return stage;
  throw new AgentOutboundError({
    code: 'NOT_FOUND',
    message: `Unknown review stage "${id}". Review stages: ${stages.map((candidate) => candidate.id).join(', ') || '(none)'}`,
    retryable: false,
  });
};

const awaitingReviewWhere = () => `
  event.kind = 'review'
  AND event.step_id = ?
  AND event.passed = 0
  AND event.reason = 'awaiting_review'
  AND ${inPlayWhere('record')}
  AND COALESCE(record.sequence_status, '') != 'opted_out'
  AND NOT EXISTS (
    SELECT 1
    FROM overrides verdict
    WHERE verdict.record_id = event.record_id
      AND (verdict.cleared_at IS NULL OR verdict.cleared_at = '')
      AND (
        (verdict.kind = 'keep' AND (verdict.step_id = event.step_id OR verdict.step_id = ''))
        OR (
          verdict.kind = 'drop'
          AND verdict.step_id = ''
          AND verdict.created_by = 'review:' || event.step_id
        )
      )
  )
`;

export const countAwaitingReviewAtStage = ({ db, stageId }: { db: any; stageId: string }) => Number(db.prepare(`
  SELECT COUNT(DISTINCT event.record_id) AS n
  FROM pipeline_events event
  JOIN records record ON record._row_id = event.record_id
  WHERE ${awaitingReviewWhere()}
`).get(String(stageId))?.n || 0);

export const isRecordAwaitingReview = ({
  db,
  recordId,
  stageId,
}: {
  db: any;
  recordId: string;
  stageId: string;
}) => Boolean(db.prepare(`
  SELECT 1
  FROM pipeline_events event
  JOIN records record ON record._row_id = event.record_id
  WHERE event.record_id = ?
    AND ${awaitingReviewWhere()}
  LIMIT 1
`).get(String(recordId), String(stageId)));

export const countAwaitingReviewRecords = ({ db, config }: { db: any; config: any }) => {
  const stageIds = configuredReviewStages(config).map((stage) => stage.id);
  if (stageIds.length === 0) return 0;
  const placeholders = stageIds.map(() => '?').join(', ');
  return Number(db.prepare(`
    SELECT COUNT(DISTINCT event.record_id) AS n
    FROM pipeline_events event
    JOIN records record ON record._row_id = event.record_id
    WHERE event.kind = 'review'
      AND event.step_id IN (${placeholders})
      AND event.passed = 0
      AND event.reason = 'awaiting_review'
      AND ${inPlayWhere('record')}
      AND COALESCE(record.sequence_status, '') != 'opted_out'
      AND NOT EXISTS (
        SELECT 1
        FROM overrides verdict
        WHERE verdict.record_id = event.record_id
          AND (verdict.cleared_at IS NULL OR verdict.cleared_at = '')
          AND (
            (verdict.kind = 'keep' AND (verdict.step_id = event.step_id OR verdict.step_id = ''))
            OR (
              verdict.kind = 'drop'
              AND verdict.step_id = ''
              AND verdict.created_by = 'review:' || event.step_id
            )
          )
      )
  `).get(...stageIds)?.n || 0);
};

export const getReviewStages = ({ db, config }: { db: any; config: any }) => configuredReviewStages(config)
  .map((stage) => ({
    ...stage,
    awaiting_count: countAwaitingReviewAtStage({ db, stageId: stage.id }),
  }));

export const getReviewQueue = ({
  db,
  config,
  stageId,
  limit = 100,
  offset = 0,
}: {
  db: any;
  config: any;
  stageId: string;
  limit?: number;
  offset?: number;
}) => {
  const stage = requireReviewStage({ config, stageId });
  const requestedLimit = Number(limit);
  const requestedOffset = Number(offset);
  const pageLimit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(500, Math.floor(requestedLimit)))
    : 100;
  const pageOffset = Number.isFinite(requestedOffset)
    ? Math.max(0, Math.floor(requestedOffset))
    : 0;
  const availableColumns = recordColumns(db);
  const fields = [...new Set(['_row_id', 'business_name', ...stage.fields])]
    .filter((field) => availableColumns.has(field));
  const rows = db.prepare(`
    WITH awaiting AS (
      SELECT event.record_id, MAX(event.occurred_at) AS parked_at
      FROM pipeline_events event
      JOIN records record ON record._row_id = event.record_id
      WHERE ${awaitingReviewWhere()}
      GROUP BY event.record_id
    )
    SELECT ${fields.map((field) => `record.${quoteIdent(field)}`).join(', ')}
    FROM awaiting
    JOIN records record ON record._row_id = awaiting.record_id
    ORDER BY awaiting.parked_at ASC, record._row_id ASC
    LIMIT ? OFFSET ?
  `).all(stage.id, pageLimit, pageOffset);
  const total = countAwaitingReviewAtStage({ db, stageId: stage.id });
  return {
    stage: { ...stage, awaiting_count: total },
    total,
    limit: pageLimit,
    offset: pageOffset,
    records: rows,
  };
};

export const reviewRecordLabel = (record: any) => ({
  row_id: String(record?._row_id || record?.id || ''),
  business_name: String(record?.business_name || record?.name || ''),
});

export const reviewRecordDecisionState = (record: any) => {
  const disqualifiedAt = String(record?.disqualified_at || '').trim();
  const extra = (() => {
    try {
      return record?.extra_json && typeof record.extra_json === 'string'
        ? JSON.parse(record.extra_json)
        : (record?.extra_json || {});
    } catch {
      return {};
    }
  })();
  return {
    in_play: disqualifiedAt === '' && !record?.suppressed,
    disqualified_at: disqualifiedAt,
    disqualified_gate: String(record?.disqualified_gate || ''),
    disqualify_reason: String(record?.disqualify_reason || ''),
    needs_review: Boolean(record?.needs_review),
    review_reason: String(record?.review_reason || ''),
    pipeline_flags: Array.isArray(extra.pipeline_flags) ? extra.pipeline_flags : [],
  };
};

export const insertReviewDecision = ({
  db,
  config,
  ref,
  stageId,
  verdict,
  reason = '',
}: {
  db: any;
  config: any;
  ref: string;
  stageId: string;
  verdict: string;
  reason?: string;
}) => {
  const stage = requireReviewStage({ config, stageId });
  const normalizedVerdict = String(verdict || '').trim().toLowerCase();
  if (!['pass', 'drop'].includes(normalizedVerdict)) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: `Unknown review verdict "${normalizedVerdict}". Expected pass or drop.`,
      retryable: false,
    });
  }
  const normalizedReason = String(reason || '').trim();
  if (normalizedVerdict === 'drop' && !normalizedReason) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: 'A review drop requires a reason.',
      retryable: false,
    });
  }
  const record = resolveRecordRef({ db, ref });
  const override = insertOverride({
    db,
    recordId: String(record._row_id),
    kind: normalizedVerdict === 'pass' ? 'keep' : 'drop',
    stepId: normalizedVerdict === 'pass' ? stage.id : '',
    reason: normalizedReason,
    createdBy: `review:${stage.id}`,
  });
  return { stage, verdict: normalizedVerdict as 'pass' | 'drop', record, override };
};

export const clearReviewDecision = ({
  db,
  config,
  ref,
  stageId,
  clearedBy = '',
}: {
  db: any;
  config: any;
  ref: string;
  stageId: string;
  clearedBy?: string;
}) => {
  const stage = requireReviewStage({ config, stageId });
  const record = resolveRecordRef({ db, ref });
  const passOverrides = clearOverrides({
    db,
    recordId: String(record._row_id),
    stepId: stage.id,
    kind: 'keep',
    clearedBy,
  });
  const dropOverrides = clearOverrides({
    db,
    recordId: String(record._row_id),
    stepId: '',
    kind: 'drop',
    createdBy: `review:${stage.id}`,
    clearedBy,
  });
  if (dropOverrides.length > 0 && String(record.disqualified_gate || '') === OVERRIDE_GATE) {
    db.prepare(`
      UPDATE records
      SET disqualified_at = '', disqualified_gate = '', disqualify_reason = '',
        needs_review = 0, review_reason = '', review_flagged_at = '', updated_at = ?
      WHERE _row_id = ?
    `).run(new Date().toISOString(), String(record._row_id));
  }
  return {
    stage,
    record,
    cleared: [...passOverrides, ...dropOverrides],
  };
};

export const reviewDecisionResult = ({ db, decision }: { db: any; decision: ReturnType<typeof insertReviewDecision> }) => {
  const record = getRecordById({ db, id: String(decision.record._row_id) }) || decision.record;
  return {
    row_id: String(record._row_id || ''),
    verdict: decision.verdict,
    override_id: String(decision.override.id || ''),
    record: reviewRecordLabel(record),
    state: reviewRecordDecisionState(record),
  };
};
