import { readConfig } from '../orchestrator/lib/config.js';
import {
  getRejectedRecords,
  getRejectedSources,
  restoreRejectedRecord,
} from '../orchestrator/pipeline/rejected.js';
import { openListDb } from '../orchestrator/runtime/db.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';
import { validateWhereSql } from '../orchestrator/lib/sql-safety.js';

export const rejectedSourcesCommand = ({ list }: { list: string }) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const db = openListDb({ listDir, readonly: true });
  try {
    return getRejectedSources({ db, config });
  } finally {
    db.close();
  }
};

export const rejectedListCommand = ({
  list,
  source = '',
  limit = 100,
  offset = 0,
}: {
  list: string;
  source?: string;
  limit?: number;
  offset?: number;
}) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const db = openListDb({ listDir, readonly: true });
  try {
    return getRejectedRecords({ db, config, source, limit, offset });
  } finally {
    db.close();
  }
};

export const rejectedRestoreCommand = ({
  list,
  ref,
  reason = '',
}: {
  list: string;
  ref: string;
  reason?: string;
}) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const db = openListDb({ listDir, readonly: false });
  try {
    return db.transaction(() => restoreRejectedRecord({
      db,
      config,
      ref,
      reason,
      createdBy: 'rejected:cli',
    }))();
  } finally {
    db.close();
  }
};

export const rejectedRestoreGateCommand = ({
  list,
  gate,
  where = '',
  reason = '',
}: {
  list: string;
  gate: string;
  where?: string;
  reason?: string;
}) => {
  if (!String(gate).trim() || !String(reason).trim()) throw new Error('Bulk restore requires --gate and --reason.');
  const whereSql = String(where || '').trim();
  const whereCheck = validateWhereSql(whereSql);
  if (!whereCheck.ok) throw new Error(whereCheck.error || 'Invalid --where SQL fragment.');
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const result = db.prepare(`
      UPDATE records
      SET disqualified_at = '', disqualified_gate = '', disqualify_reason = '', updated_at = ?
      WHERE COALESCE(disqualified_at, '') != ''
        AND disqualified_gate = ?
        ${whereSql ? `AND (${whereSql})` : ''}
    `).run(new Date().toISOString(), String(gate).trim());
    return { status: 'bulk_restore_applied', gate: String(gate).trim(), reason: String(reason).trim(), restored: Number(result.changes || 0), mechanism: 'automatic_rejection_cleared_no_override' };
  } finally {
    db.close();
  }
};
