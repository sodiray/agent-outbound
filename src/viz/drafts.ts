/**
 * Operator-UI draft approval surface.
 *
 * List/detail resolve config-declared detail sections via the same review-detail
 * vocabulary used by review stages. Mutations go through the drafts command
 * layer (approve/reject/edit) so content_hash, provider envelopes, and stage
 * authorization stay on the integrity-preserving path.
 */
import {
  draftsApproveCommand,
  draftsEditCommand,
  draftsListCommand,
  draftsRejectCommand,
  draftsShowCommand,
} from '../commands/drafts.js';
import { draftDetailDeclaration } from '../orchestrator/lib/draft-content.js';
import { readConfig } from '../orchestrator/lib/config.js';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';
import { openListDb } from '../orchestrator/runtime/db.js';
import {
  resolveReviewDetail,
  type ReviewDetailSection,
  type ResolvedReviewDetailSection,
} from './review-detail.js';

export const DRAFT_STATUS_FILTERS = [
  'pending_approval',
  'ready',
  'rejected',
  'sent',
] as const;

export type DraftStatusFilter = typeof DRAFT_STATUS_FILTERS[number];

const DEFAULT_STATUS: DraftStatusFilter = 'pending_approval';

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const normalizeStatus = (status: string): DraftStatusFilter | '' => {
  const raw = String(status || '').trim().toLowerCase();
  if (!raw) return DEFAULT_STATUS;
  if ((DRAFT_STATUS_FILTERS as readonly string[]).includes(raw)) {
    return raw as DraftStatusFilter;
  }
  throw new AgentOutboundError({
    code: 'INVALID_ARGUMENT',
    message: `Unknown draft status filter "${status}". Expected one of: ${DRAFT_STATUS_FILTERS.join(', ')}.`,
    retryable: false,
  });
};

const countDraftsByStatus = (db: any): Record<string, number> => {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM drafts
    GROUP BY status
  `).all() as Array<{ status?: string; count?: number }>;
  const counts: Record<string, number> = Object.fromEntries(
    DRAFT_STATUS_FILTERS.map((status) => [status, 0]),
  );
  for (const row of rows) {
    const status = String(row.status || '').trim();
    if (!status) continue;
    counts[status] = Number(row.count || 0);
  }
  return counts;
};

const loadConfig = (listDir: string): Record<string, unknown> | null => {
  try {
    return (readConfig(listDir).config || {}) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const detailForDraft = ({
  config,
  draft,
  record,
}: {
  config: Record<string, unknown> | null;
  draft: Record<string, unknown>;
  record: Record<string, unknown>;
}): {
  detail_declaration: ReviewDetailSection[] | undefined;
  detail_sections: ResolvedReviewDetailSection[] | null;
} => {
  if (!config) {
    return { detail_declaration: undefined, detail_sections: null };
  }
  const declaration = draftDetailDeclaration({
    config,
    sequenceName: String(draft.sequence_name || 'default'),
    stepId: String(draft.step_id || ''),
  }) as ReviewDetailSection[] | undefined;
  if (!declaration) {
    return { detail_declaration: undefined, detail_sections: null };
  }
  return {
    detail_declaration: declaration,
    detail_sections: resolveReviewDetail({ detail: declaration, record }),
  };
};

const loadRecord = (db: any, rowId: string): Record<string, unknown> => {
  if (!rowId) return {};
  const row = db.prepare('SELECT * FROM records WHERE _row_id = ? LIMIT 1')
    .get(rowId) as Record<string, unknown> | undefined;
  return row || {};
};

export const getDraftCountsForViz = (listDir: string) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    return { counts: countDraftsByStatus(db) };
  } finally {
    db.close();
  }
};

export const getDraftsForViz = (
  listDir: string,
  status: string = DEFAULT_STATUS,
  limit = 100,
  offset = 0,
) => {
  const normalizedStatus = normalizeStatus(status);
  const pageLimit = Math.max(1, Math.min(1000, Number(limit || 100)));
  const pageOffset = Math.max(0, Number(offset || 0));
  const listed = draftsListCommand({
    list: listDir,
    status: normalizedStatus,
    limit: pageLimit,
    // list command uses cursor; encode offset the same way for pagination.
    cursor: pageOffset > 0
      ? Buffer.from(JSON.stringify({ offset: pageOffset }), 'utf8').toString('base64url')
      : '',
  });
  const db = openListDb({ listDir, readonly: true });
  try {
    const config = loadConfig(listDir);
    const counts = countDraftsByStatus(db);
    const drafts = (listed.rows || []).map((draft: Record<string, unknown>) => {
      const record = loadRecord(db, String(draft.row_id || ''));
      const { detail_declaration, detail_sections } = detailForDraft({ config, draft, record });
      return {
        ...draft,
        detail_declaration,
        detail_sections,
      };
    });
    const totalForStatus = Number(counts[normalizedStatus] || drafts.length);
    return {
      status: normalizedStatus,
      total: totalForStatus,
      limit: pageLimit,
      offset: pageOffset,
      next_cursor: listed.next_cursor ?? null,
      counts,
      drafts,
    };
  } finally {
    db.close();
  }
};

export const getDraftDetailForViz = (listDir: string, draftId: string) => {
  const { draft } = draftsShowCommand({ list: listDir, draftId });
  const db = openListDb({ listDir, readonly: true });
  try {
    const config = loadConfig(listDir);
    const record = loadRecord(db, String(asRecord(draft).row_id || ''));
    const { detail_declaration, detail_sections } = detailForDraft({
      config,
      draft: asRecord(draft),
      record,
    });
    return {
      draft: {
        ...asRecord(draft),
        detail_declaration,
        detail_sections,
      },
      record,
      detail_declaration,
      detail_sections,
    };
  } finally {
    db.close();
  }
};

export const approveDraftForViz = (listDir: string, draftId: string) => {
  const result = draftsApproveCommand({ list: listDir, draftId: String(draftId || '').trim() });
  return {
    ok: true,
    action: 'approve',
    draft_id: String(draftId || '').trim(),
    ...result,
  };
};

export const rejectDraftForViz = (listDir: string, draftId: string, reason = '') => {
  const result = draftsRejectCommand({
    list: listDir,
    draftId: String(draftId || '').trim(),
    reason: String(reason || ''),
  });
  return {
    ok: true,
    action: 'reject',
    ...result,
  };
};

export const editDraftForViz = (
  listDir: string,
  draftId: string,
  patch: { subject?: string; body?: string },
) => {
  const result = draftsEditCommand({
    list: listDir,
    draftId: String(draftId || '').trim(),
    subject: String(patch?.subject || ''),
    body: String(patch?.body || ''),
  });
  return {
    ok: true,
    action: 'edit',
    ...result,
  };
};
