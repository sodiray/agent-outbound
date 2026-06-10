import { runBriefs } from '../orchestrator/briefs/runner.js';
import { getBriefForRecord, openListDb, resolveRecordRef } from '../orchestrator/runtime/db.js';
import { validateWhereSql } from '../orchestrator/lib/sql-safety.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';

const parseRoles = (value: any) => {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const briefView = (row: any) => ({
  brief_id: String(row.brief_id || ''),
  row_id: String(row.row_id || ''),
  summary: String(row.summary || ''),
  content: String(row.content || ''),
  roles: parseRoles(row.roles_json),
  model: String(row.model || ''),
  status: String(row.status || ''),
  updated_at: String(row.updated_at || ''),
});

export const briefCommand = async ({ list, where = '', limit = 0, force = false }: { list: string; where?: string; limit?: number; force?: boolean }) => {
  const listDir = resolveListDir(list);
  const whereSql = String(where || '').trim();
  if (whereSql) {
    const check = validateWhereSql(whereSql);
    if (!check.ok) throw new AgentOutboundError({ code: 'INVALID_ARGUMENT', message: check.error || 'Invalid --where SQL fragment.', retryable: false });
  }
  return runBriefs({ listDir, where: whereSql, limit, force });
};

export const briefShowCommand = ({ list, ref }: { list: string; ref: string }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    const record = resolveRecordRef({ db, ref });
    const brief = getBriefForRecord({ db, rowId: String(record._row_id) });
    if (!brief) {
      return {
        record: { row_id: String(record._row_id), business_name: String(record.business_name || '') },
        brief: null,
        note: 'No brief generated for this lead yet. Run `brief <list> --where ...` (requires brief.enabled).',
      };
    }
    return {
      record: { row_id: String(record._row_id), business_name: String(record.business_name || '') },
      brief: briefView(brief),
    };
  } finally {
    db.close();
  }
};
