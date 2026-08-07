import { AgentOutboundError } from '../runtime/contract.js';
import {
  clearOverrides,
  getRecordById,
  insertOverride,
  OVERRIDE_GATE,
  reconcileOverrides,
  resolveRecordRef,
} from '../runtime/db.js';
import { clearReviewDecision, configuredReviewStages } from './review.js';
import { flattenPipelineSteps } from '../lib/subpipelines.js';
import { isAffirmativeFlag } from '../policy/booleanish.js';

export const DEFAULT_REJECTED_RESTORE_REASON = 'restored by operator from rejected view';

export type RejectedSource = {
  id: string;
  label: string;
  count: number;
};

const quoteIdent = (value: string) => `"${String(value).replaceAll('"', '""')}"`;

const recordColumns = (db: any): Set<string> => new Set<string>(
  db.prepare('PRAGMA table_info(records)').all()
    .map((column: any) => String(column?.name || '').trim())
    .filter(Boolean),
);

const humanizeId = (value: string) => String(value || '')
  .replace(/^_+|_+$/g, '')
  .split(/[_\s-]+/)
  .filter(Boolean)
  .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
  .join(' ');

const sourceLabels = (config: any) => {
  const pipeline = flattenPipelineSteps(config);
  return new Map<string, string>([
    ['score_minimum', 'Score minimum'],
    [OVERRIDE_GATE, 'Manual or review rejection'],
    ...pipeline
      .map((step: any) => {
        const id = String(step?.id || '').trim();
        const label = String(step?.label || '').trim();
        return [id, label || humanizeId(id)] as [string, string];
      })
      .filter(([id]) => id),
  ]);
};

const reviewStageLabels = (config: any) => new Map(
  configuredReviewStages(config).map((stage) => [stage.id, stage.label]),
);

const activeDropOverride = ({ db, recordId }: { db: any; recordId: string }) => db.prepare(`
  SELECT *
  FROM overrides
  WHERE record_id = ?
    AND kind = 'drop'
    AND step_id = ''
    AND (cleared_at IS NULL OR cleared_at = '')
  ORDER BY created_at DESC, id DESC
  LIMIT 1
`).get(String(recordId));

const reviewStageIdFrom = (createdBy: unknown) => {
  const value = String(createdBy || '').trim();
  return value.startsWith('review:') ? value.slice('review:'.length) : '';
};

export const getRejectedSources = ({ db, config }: { db: any; config: any }) => {
  const labels = sourceLabels(config);
  const sources = db.prepare(`
    SELECT COALESCE(disqualified_gate, '') AS id, COUNT(*) AS count
    FROM records
    WHERE COALESCE(disqualified_at, '') != ''
    GROUP BY COALESCE(disqualified_gate, '')
    ORDER BY count DESC, id ASC
  `).all().map((row: any) => {
    const id = String(row?.id || '');
    return {
      id,
      label: labels.get(id) || humanizeId(id) || 'Unknown source',
      count: Number(row?.count || 0),
    };
  });
  return {
    total: sources.reduce((sum: number, source: RejectedSource) => sum + source.count, 0),
    sources,
  };
};

export const getRejectedRecords = ({
  db,
  config,
  source = '',
  limit = 100,
  offset = 0,
}: {
  db: any;
  config: any;
  source?: string;
  limit?: number;
  offset?: number;
}) => {
  const requestedLimit = Number(limit);
  const requestedOffset = Number(offset);
  const pageLimit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(500, Math.floor(requestedLimit)))
    : 100;
  const pageOffset = Number.isFinite(requestedOffset)
    ? Math.max(0, Math.floor(requestedOffset))
    : 0;
  const sourceId = String(source || '').trim();
  const availableColumns = recordColumns(db);
  const identityFields = ['_row_id', 'business_name', 'address', 'website', 'phone']
    .filter((field) => availableColumns.has(field));
  const where = [
    "COALESCE(record.disqualified_at, '') != ''",
    ...(sourceId ? ["COALESCE(record.disqualified_gate, '') = ?"] : []),
  ];
  const values = sourceId ? [sourceId] : [];
  const total = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM records record
    WHERE ${where.join(' AND ')}
  `).get(...values)?.count || 0);
  const rows = db.prepare(`
    SELECT
      ${identityFields.map((field) => `record.${quoteIdent(field)}`).join(', ')},
      COALESCE(record.disqualified_gate, '') AS rejection_source,
      COALESCE(NULLIF(active_drop.reason, ''), NULLIF(record.disqualify_reason, ''), '') AS rejection_reason,
      COALESCE(NULLIF(active_drop.created_at, ''), record.disqualified_at, '') AS rejected_at,
      COALESCE(active_drop.reason, '') AS override_reason,
      COALESCE(active_drop.created_by, '') AS override_created_by
    FROM records record
    LEFT JOIN overrides active_drop ON active_drop.id = (
      SELECT candidate.id
      FROM overrides candidate
      WHERE candidate.record_id = record._row_id
        AND candidate.kind = 'drop'
        AND candidate.step_id = ''
        AND (candidate.cleared_at IS NULL OR candidate.cleared_at = '')
      ORDER BY candidate.created_at DESC, candidate.id DESC
      LIMIT 1
    )
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(NULLIF(active_drop.created_at, ''), record.disqualified_at, '') DESC,
      record._row_id ASC
    LIMIT ? OFFSET ?
  `).all(...values, pageLimit, pageOffset);
  const labels = sourceLabels(config);
  const stageLabels = reviewStageLabels(config);
  return {
    source: sourceId,
    total,
    limit: pageLimit,
    offset: pageOffset,
    identity_fields: identityFields,
    records: rows.map((row: any) => {
      const rejectionSource = String(row?.rejection_source || '');
      const reviewStageId = reviewStageIdFrom(row?.override_created_by);
      return {
        ...row,
        rejection_source: rejectionSource,
        rejection_source_label: labels.get(rejectionSource) || humanizeId(rejectionSource) || 'Unknown source',
        review_stage_id: reviewStageId,
        review_stage_label: reviewStageId
          ? (stageLabels.get(reviewStageId) || humanizeId(reviewStageId))
          : '',
      };
    }),
  };
};

const clearOverrideDisqualification = ({ db, recordId }: { db: any; recordId: string }) => {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE records
    SET disqualified_at = '', disqualified_gate = '', disqualify_reason = '',
      needs_review = 0, review_reason = '', review_flagged_at = '', updated_at = ?
    WHERE _row_id = ?
  `).run(now, String(recordId));
};

export const restoreRejectedRecord = ({
  db,
  config,
  ref,
  reason = '',
  createdBy = '',
}: {
  db: any;
  config: any;
  ref: string;
  reason?: string;
  createdBy?: string;
}) => {
  const record = resolveRecordRef({ db, ref });
  const recordId = String(record._row_id || '');
  const source = String(record.disqualified_gate || '').trim();
  if (!String(record.disqualified_at || '').trim()) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: `Record "${recordId}" is not rejected.`,
      retryable: false,
    });
  }
  if (!source) {
    throw new AgentOutboundError({
      code: 'NOT_FOUND',
      message: `Record "${recordId}" has no recorded rejection source.`,
      retryable: false,
    });
  }

  const outcome = (() => {
    if (source !== OVERRIDE_GATE) {
      const normalizedReason = String(reason || '').trim();
      if (!normalizedReason) {
        throw new AgentOutboundError({
          code: 'INVALID_ARGUMENT',
          message: `Restoring a record rejected by "${source}" requires a reason.`,
          retryable: false,
        });
      }
      const override = insertOverride({
        db,
        recordId,
        kind: 'keep',
        stepId: source,
        reason: normalizedReason,
        createdBy,
      });
      reconcileOverrides({ db });
      return {
        mechanism: 'keep_override_created',
        review_stage_id: '',
        override,
        cleared: [],
      };
    }

    const dropOverride = activeDropOverride({ db, recordId });
    if (!dropOverride) {
      throw new AgentOutboundError({
        code: 'NOT_FOUND',
        message: `Record "${recordId}" has no active drop override to clear.`,
        retryable: false,
      });
    }
    const reviewStageId = reviewStageIdFrom(dropOverride.created_by);
    if (reviewStageId) {
      const result = clearReviewDecision({
        db,
        config,
        ref: recordId,
        stageId: reviewStageId,
        clearedBy: createdBy,
      });
      reconcileOverrides({ db });
      return {
        mechanism: 'review_override_cleared',
        review_stage_id: reviewStageId,
        override: null,
        cleared: result.cleared,
      };
    }

    const cleared = clearOverrides({
      db,
      recordId,
      stepId: '',
      kind: 'drop',
      createdBy: String(dropOverride.created_by || ''),
      clearedBy: createdBy,
    });
    if (cleared.length === 0) {
      throw new AgentOutboundError({
        code: 'NOT_FOUND',
        message: `Record "${recordId}" has no matching active manual drop override to clear.`,
        retryable: false,
      });
    }
    clearOverrideDisqualification({ db, recordId });
    reconcileOverrides({ db });
    return {
      mechanism: 'manual_drop_override_cleared',
      review_stage_id: '',
      override: null,
      cleared,
    };
  })();

  const after = getRecordById({ db, id: recordId }) || record;
  return {
    status: 'restore_applied',
    mechanism: outcome.mechanism,
    source,
    review_stage_id: outcome.review_stage_id,
    restored: !String(after.disqualified_at || '').trim(),
    override: outcome.override,
    cleared_count: outcome.cleared.length,
    cleared: outcome.cleared.map((override: any) => ({
      id: String(override.id || ''),
      kind: String(override.kind || ''),
      step_id: String(override.step_id || ''),
      reason: String(override.reason || ''),
      created_by: String(override.created_by || ''),
    })),
    record: {
      row_id: recordId,
      business_name: String(after.business_name || after.name || ''),
    },
    state: {
      in_play: !String(after.disqualified_at || '').trim()
        && !isAffirmativeFlag(after.suppressed, { failClosed: true }),
      disqualified_at: String(after.disqualified_at || ''),
      disqualified_gate: String(after.disqualified_gate || ''),
      disqualify_reason: String(after.disqualify_reason || ''),
    },
  };
};
