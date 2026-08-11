import { AgentOutboundError } from '../runtime/contract.js';
import {
  clearOverrides,
  getRecordById,
  inPlayWhere,
  insertOverride,
  OVERRIDE_GATE,
  resolveRecordRef,
} from '../runtime/db.js';
import { flattenPipelineSteps } from '../lib/subpipelines.js';
import { isAffirmativeFlag } from '../policy/booleanish.js';
import type { ReviewDetailSection } from '../../viz/review-detail.js';

export type ReviewStage = {
  id: string;
  label: string;
  description: string;
  fields: string[];
  title_field?: string;
  detail?: ReviewDetailSection[];
};

export type ReviewDecision = {
  row_id?: unknown;
  verdict?: unknown;
  reason?: unknown;
};

const quoteIdent = (value: string) => `"${String(value).replaceAll('"', '""')}"`;

const recordColumns = (db: any): Set<string> => new Set<string>(
  db.prepare('PRAGMA table_info(records)').all()
    .map((column: any) => String(column?.name || '').trim())
    .filter(Boolean),
);

const resolveReviewStageFields = ({
  stage,
  availableColumns,
}: {
  stage: ReviewStage;
  availableColumns: Set<string>;
}) => ({
  ...stage,
  fields: [...new Set(stage.fields)].filter((field) => availableColumns.has(field)),
});

export const configuredReviewStages = (config: any): ReviewStage[] => (
  flattenPipelineSteps(config)
)
  .filter((step: any) => String(step?.kind || '') === 'review')
  .map((step: any) => {
    const id = String(step?.id || '').trim();
    const label = String(step?.label || '').trim();
    const titleField = String(step?.title_field || config?.record_title_field || '').trim();
    return {
      id,
      label: label || id,
      description: String(step?.description || ''),
      fields: Array.isArray(step?.fields)
        ? step.fields.map((field: unknown) => String(field || '').trim()).filter(Boolean)
        : [],
      ...(titleField ? { title_field: titleField } : {}),
      detail: Array.isArray(step?.detail) ? step.detail as ReviewDetailSection[] : undefined,
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

export const requireResolvedReviewStage = ({
  db,
  config,
  stageId,
}: {
  db: any;
  config: any;
  stageId: string;
}) => resolveReviewStageFields({
  stage: requireReviewStage({ config, stageId }),
  availableColumns: recordColumns(db),
});

const awaitingReviewWhere = (stageCondition = 'event.step_id = ?') => `
  event.kind = 'review'
  AND ${stageCondition}
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

export const countAwaitingReviewBySequence = ({ db, stageId }: { db: any; stageId: string }) => db.prepare(`
  SELECT
    COALESCE(NULLIF(TRIM(record.sequence_name), ''), 'default') AS sequence_name,
    COUNT(DISTINCT event.record_id) AS count
  FROM pipeline_events event
  JOIN records record ON record._row_id = event.record_id
  WHERE ${awaitingReviewWhere()}
  GROUP BY COALESCE(NULLIF(TRIM(record.sequence_name), ''), 'default')
  ORDER BY count DESC, sequence_name ASC
`).all(String(stageId)).map((row: any) => ({
  sequence_name: String(row?.sequence_name || 'default'),
  count: Number(row?.count || 0),
}));

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

export const reviewStageFieldWarnings = ({ db, config }: { db: any; config: any }) => {
  const availableColumns = recordColumns(db);
  return configuredReviewStages(config).flatMap((stage) => {
    const missing = [...new Set([
      ...stage.fields,
      ...(stage.title_field ? [stage.title_field] : []),
    ])].filter((field) => !availableColumns.has(field));
    if (missing.length === 0) return [];
    return [`Review step "${stage.id}" fields do not exist on records: ${missing.map((field) => `"${field}"`).join(', ')}.`];
  });
};

export const getReviewStages = ({ db, config }: { db: any; config: any }) => {
  const availableColumns = recordColumns(db);
  return configuredReviewStages(config)
    .map((stage) => resolveReviewStageFields({ stage, availableColumns }))
    .map((stage) => ({
      ...stage,
      awaiting_count: countAwaitingReviewAtStage({ db, stageId: stage.id }),
      sequence_counts: countAwaitingReviewBySequence({ db, stageId: stage.id }),
    }));
};

export const getReviewQueue = ({
  db,
  config,
  stageId,
  limit = 100,
  offset = 0,
  sort,
  dir,
}: {
  db: any;
  config: any;
  stageId: string;
  limit?: number;
  offset?: number;
  sort?: string;
  dir?: string;
}) => {
  const availableColumns = recordColumns(db);
  const stage = requireResolvedReviewStage({ db, config, stageId });
  const { pageLimit, pageOffset } = reviewPage({ limit, offset });
  const fields = [...new Set(['_row_id', ...stage.fields, ...(stage.title_field ? [stage.title_field] : [])])]
    .filter((field) => availableColumns.has(field));
  const orderBy = reviewOrderBy({
    sort,
    dir,
    availableColumns,
    stages: [stage],
    includeStageTiebreaker: false,
  });
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
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(stage.id, pageLimit, pageOffset);
  const total = countAwaitingReviewAtStage({ db, stageId: stage.id });
  return {
    stage: {
      ...stage,
      awaiting_count: total,
      sequence_counts: countAwaitingReviewBySequence({ db, stageId: stage.id }),
    },
    total,
    limit: pageLimit,
    offset: pageOffset,
    records: rows,
  };
};

const REVIEW_IDENTITY_FIELDS = ['_row_id'];

const reviewPage = ({ limit, offset }: { limit: number; offset: number }) => {
  const requestedLimit = Number(limit);
  const requestedOffset = Number(offset);
  return {
    pageLimit: Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(500, Math.floor(requestedLimit)))
      : 100,
    pageOffset: Number.isFinite(requestedOffset)
      ? Math.max(0, Math.floor(requestedOffset))
      : 0,
  };
};

const reviewOrderBy = ({
  sort,
  dir,
  availableColumns,
  stages,
  includeStageTiebreaker,
}: {
  sort?: string;
  dir?: string;
  availableColumns: Set<string>;
  stages: ReviewStage[];
  includeStageTiebreaker: boolean;
}) => {
  const requestedSort = String(sort || '').trim();
  const requestedDirection = String(dir || 'asc').trim().toLowerCase();
  if (requestedDirection !== 'asc' && requestedDirection !== 'desc') {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: 'Review sort direction must be "asc" or "desc".',
      retryable: false,
    });
  }
  if (!requestedSort) {
    return includeStageTiebreaker
      ? 'awaiting.parked_at ASC, awaiting.stage_id ASC, record._row_id ASC'
      : 'awaiting.parked_at ASC, record._row_id ASC';
  }
  const allowedFields = new Set([
    ...REVIEW_IDENTITY_FIELDS,
    ...stages.flatMap((stage) => stage.fields),
  ].filter((field) => availableColumns.has(field)));
  if (!allowedFields.has(requestedSort)) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: `Unknown review sort field "${requestedSort}".`,
      retryable: false,
    });
  }
  const tiebreaker = includeStageTiebreaker
    ? `awaiting.stage_id ASC, record._row_id ASC`
    : 'record._row_id ASC';
  return `record.${quoteIdent(requestedSort)} ${requestedDirection.toUpperCase()}, ${tiebreaker}`;
};

export const getAllReviewQueue = ({
  db,
  config,
  limit = 100,
  offset = 0,
  sort,
  dir,
}: {
  db: any;
  config: any;
  limit?: number;
  offset?: number;
  sort?: string;
  dir?: string;
}) => {
  const availableColumns = recordColumns(db);
  const stages = getReviewStages({ db, config });
  const stageIds = stages.map((stage) => stage.id);
  const { pageLimit, pageOffset } = reviewPage({ limit, offset });
  const fields = [...new Set([
    '_row_id',
    ...stages.flatMap((stage) => stage.fields),
    ...stages.flatMap((stage) => stage.title_field ? [stage.title_field] : []),
  ])].filter((field) => availableColumns.has(field));
  const uniqueTotal = countAwaitingReviewRecords({ db, config });
  const stage = {
    id: 'all',
    label: 'All stages',
    description: 'Records awaiting a decision at any configured review stage.',
    fields: [...new Set(stages.flatMap((candidate) => candidate.fields))]
      .filter((field) => !REVIEW_IDENTITY_FIELDS.includes(field) && availableColumns.has(field)),
    awaiting_count: uniqueTotal,
    sequence_counts: [],
  };
  if (stageIds.length === 0) {
    return {
      stage,
      total: 0,
      unique_total: 0,
      limit: pageLimit,
      offset: pageOffset,
      records: [],
    };
  }
  const placeholders = stageIds.map(() => '?').join(', ');
  const orderBy = reviewOrderBy({
    sort,
    dir,
    availableColumns,
    stages,
    includeStageTiebreaker: true,
  });
  const rows = db.prepare(`
    WITH awaiting AS (
      SELECT event.record_id, event.step_id AS stage_id, MAX(event.occurred_at) AS parked_at
      FROM pipeline_events event
      JOIN records record ON record._row_id = event.record_id
      WHERE ${awaitingReviewWhere(`event.step_id IN (${placeholders})`)}
      GROUP BY event.record_id, event.step_id
    )
    SELECT ${fields.map((field) => `record.${quoteIdent(field)}`).join(', ')},
      awaiting.stage_id AS _review_stage_id
    FROM awaiting
    JOIN records record ON record._row_id = awaiting.record_id
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...stageIds, pageLimit, pageOffset).map((row: any) => {
    const reviewStage = stages.find((candidate) => candidate.id === String(row._review_stage_id));
    return {
      ...row,
      _review_stage_label: reviewStage?.label || String(row._review_stage_id || ''),
    };
  });
  const total = Number(db.prepare(`
    SELECT COUNT(*) AS n
    FROM (
      SELECT event.record_id, event.step_id
      FROM pipeline_events event
      JOIN records record ON record._row_id = event.record_id
      WHERE ${awaitingReviewWhere(`event.step_id IN (${placeholders})`)}
      GROUP BY event.record_id, event.step_id
    )
  `).get(...stageIds)?.n || 0);
  return {
    stage,
    total,
    unique_total: uniqueTotal,
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
    in_play: disqualifiedAt === '' && !isAffirmativeFlag(record?.suppressed, { failClosed: true }),
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
  const stage = requireResolvedReviewStage({ db, config, stageId });
  const requestedVerdict = String(verdict || '').trim().toLowerCase();
  const normalizedVerdict = ({
    approve: 'pass',
    pass: 'pass',
    reject: 'drop',
    drop: 'drop',
  } as const)[requestedVerdict as 'approve' | 'pass' | 'reject' | 'drop'];
  if (!normalizedVerdict) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: `Unknown review verdict "${requestedVerdict}". Expected approve/pass or reject/drop.`,
      retryable: false,
    });
  }
  const normalizedReason = String(reason || '').trim();
  if (normalizedVerdict === 'drop' && !normalizedReason) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: 'A review reject requires a reason.',
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
  const stage = requireResolvedReviewStage({ db, config, stageId });
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
