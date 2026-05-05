import { validateWhereSql } from '../orchestrator/lib/sql-safety.js';
import { listDrafts, openListDb, updateDraft } from '../orchestrator/runtime/db.js';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');

const decodeCursor = (cursor: string) => {
  const raw = String(cursor || '').trim();
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return Math.max(0, Number(parsed?.offset || 0));
  } catch {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: 'Invalid cursor.',
      retryable: false,
    });
  }
};

export const draftsListCommand = ({ list, status = '', step = 0, cursor = '', limit = 100 }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    const clauses = ['1=1'];
    const params: any[] = [];
    if (status) {
      clauses.push('d.status = ?');
      params.push(String(status));
    }
    if (Number(step || 0) > 0) {
      clauses.push('d.step_number = ?');
      params.push(Number(step));
    }
    const offset = decodeCursor(cursor || '');
    const pageLimit = Math.max(1, Math.min(1000, Number(limit || 100)));
    const rows = listDrafts({
      db,
      whereSql: clauses.join(' AND '),
      params,
      limit: pageLimit + 1,
      offset,
    });
    const hasMore = rows.length > pageLimit;
    const pageRows = hasMore ? rows.slice(0, pageLimit) : rows;
    return {
      rows: pageRows,
      count: pageRows.length,
      next_cursor: hasMore ? encodeCursor(offset + pageLimit) : null,
    };
  } finally {
    db.close();
  }
};

export const draftsShowCommand = ({ list, draftId }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    const row = db.prepare(`
      SELECT d.*, r.business_name, r.sequence_status, r.priority_rank
      FROM drafts d
      LEFT JOIN records r ON r._row_id = d.row_id
      WHERE d.draft_id = ?
      LIMIT 1
    `).get(String(draftId || '').trim());
    if (!row) {
      throw new AgentOutboundError({
        code: 'NOT_FOUND',
        message: `Draft not found: ${draftId}`,
        retryable: false,
      });
    }
    return { draft: row };
  } finally {
    db.close();
  }
};

const findDraftIdsByWhere = ({ db, where = '' }: { db: any; where?: string }) => {
  const whereSql = String(where || '').trim();
  if (!whereSql) return [];
  const check = validateWhereSql(whereSql);
  if (!check.ok) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: check.error || 'Invalid --where SQL fragment.',
      retryable: false,
    });
  }
  return db.prepare(`
    SELECT d.draft_id
    FROM drafts d
    LEFT JOIN records r ON r._row_id = d.row_id
    WHERE ${whereSql}
  `).all().map((item: any) => String(item.draft_id || '')).filter(Boolean);
};

export const draftsApproveCommand = ({ list, draftId = '', all = false, where = '' }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    let ids: string[] = [];
    if (all) ids = findDraftIdsByWhere({ db, where });
    else if (draftId) ids = [String(draftId).trim()];
    if (ids.length === 0) {
      throw new AgentOutboundError({
        code: 'INVALID_ARGUMENT',
        message: 'Provide --id <draft_id> or --all --where "<sql>".',
        retryable: false,
      });
    }
    let updated = 0;
    for (const id of ids) {
      const next = updateDraft({ db, draftId: id, patch: { status: 'ready' } });
      if (next) updated += 1;
    }
    return { approved: updated, requested: ids.length };
  } finally {
    db.close();
  }
};

export const draftsRejectCommand = ({ list, draftId, reason = '' }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const next = updateDraft({
      db,
      draftId: String(draftId || '').trim(),
      patch: {
        status: 'rejected',
        reason: String(reason || ''),
      },
    });
    if (!next) {
      throw new AgentOutboundError({
        code: 'NOT_FOUND',
        message: `Draft not found: ${draftId}`,
        retryable: false,
      });
    }
    return { status: 'rejected', draft_id: next.draft_id };
  } finally {
    db.close();
  }
};

export const draftsEditCommand = ({ list, draftId, subject = '', body = '' }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const patch: Record<string, any> = {};
    if (subject) patch.subject = String(subject);
    if (body) patch.body = String(body);
    if (Object.keys(patch).length === 0) {
      throw new AgentOutboundError({
        code: 'INVALID_ARGUMENT',
        message: 'Provide at least one of --subject or --body.',
        retryable: false,
      });
    }
    patch.status = 'pending_approval';
    const next = updateDraft({ db, draftId: String(draftId || '').trim(), patch });
    if (!next) {
      throw new AgentOutboundError({
        code: 'NOT_FOUND',
        message: `Draft not found: ${draftId}`,
        retryable: false,
      });
    }
    return {
      status: 'edited',
      draft_id: next.draft_id,
    };
  } finally {
    db.close();
  }
};

