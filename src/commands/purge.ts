import { copyFileSync } from 'node:fs';
import { openListDb } from '../orchestrator/runtime/db.js';
import { readConfig } from '../orchestrator/lib/config.js';
import { getDbPath, resolveListDir } from '../orchestrator/runtime/paths.js';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';
import { getRecordRowId } from '../orchestrator/lib/record.js';
import { matchExcludeRule, normalizeExcludeRules } from '../orchestrator/lib/source-exclude.js';

const CHUNK = 400;

const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
};

// A matched record is protected from deletion only when a HUMAN has touched it:
// logged interactions, field overrides, decision overrides, or live sequence
// activity. A machine-generated score is not protection — early pipeline runs
// scored junk before the exclusion rules existed.
const isProtected = ({ db, record }: { db: any; record: any }) => {
  const recordId = getRecordRowId(record);
  const reasons: string[] = [];
  const sequenceStatus = String(record.sequence_status || '').trim();
  if (sequenceStatus && sequenceStatus !== 'idle') reasons.push(`sequence_${sequenceStatus}`);
  const interaction = db.prepare("SELECT 1 FROM interactions WHERE record_id = ? AND COALESCE(deleted_at,'') = '' LIMIT 1").get(recordId);
  if (interaction) reasons.push('interactions');
  const fieldOverride = db.prepare("SELECT 1 FROM field_overrides WHERE record_id = ? AND (cleared_at IS NULL OR cleared_at = '') LIMIT 1").get(recordId);
  if (fieldOverride) reasons.push('field_overrides');
  const override = db.prepare("SELECT 1 FROM overrides WHERE record_id = ? AND (cleared_at IS NULL OR cleared_at = '') LIMIT 1").get(recordId);
  if (override) reasons.push('decision_overrides');
  return reasons;
};

// Every table that references records by id, discovered by introspection so new
// tables are covered automatically. records itself is handled separately.
const referencingTables = (db: any) => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'records'").all();
  const refs: Array<{ table: string; column: string }> = [];
  for (const { name } of tables) {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column: any) => String(column.name || ''));
    const column = ['record_id', 'row_id', '_row_id'].find((candidate) => columns.includes(candidate));
    if (column) refs.push({ table: String(name), column });
  }
  return refs;
};

export const purgeCommand = async ({ list, dryRun = false }: { list: string; dryRun?: boolean }) => {
  const listDir = resolveListDir(list);
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) throw new AgentOutboundError({ code: 'INVALID_ARGUMENT', message: `Invalid config: ${errors.join('; ')}`, retryable: false });
  const rules = normalizeExcludeRules(config?.source?.exclude);
  if (rules.length === 0) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: 'purge requires source.exclude rules in the config — it deletes exactly what sourcing would now refuse to insert.',
      retryable: false,
    });
  }

  const db = openListDb({ listDir, readonly: false });
  try {
    const records = db.prepare('SELECT * FROM records').all();
    const matchedByRule: Record<string, number> = {};
    const matched: any[] = [];
    const protectedRecords: Array<{ row_id: string; business_name: string; rule: string; reasons: string[] }> = [];

    for (const record of records) {
      const rule = matchExcludeRule({ row: record, rules });
      if (!rule) continue;
      const ruleName = String(rule.description || 'excluded');
      const reasons = isProtected({ db, record });
      if (reasons.length > 0) {
        protectedRecords.push({
          row_id: getRecordRowId(record),
          business_name: String(record.business_name || ''),
          rule: ruleName,
          reasons,
        });
        continue;
      }
      matchedByRule[ruleName] = (matchedByRule[ruleName] || 0) + 1;
      matched.push(record);
    }

    const sample = matched.slice(0, 50).map((record) => ({
      row_id: getRecordRowId(record),
      business_name: String(record.business_name || ''),
      primary_type: String(record.primary_type || ''),
    }));

    if (dryRun) {
      return {
        dry_run: true,
        examined: records.length,
        matched: matched.length,
        matched_by_rule: matchedByRule,
        protected: protectedRecords,
        sample,
      };
    }

    if (matched.length === 0) {
      return { examined: records.length, matched: 0, deleted: 0, protected: protectedRecords, backup: '' };
    }

    // Checkpoint the WAL, then snapshot the db file before any destructive write.
    db.pragma('wal_checkpoint(TRUNCATE)');
    const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    const dbPath = getDbPath(listDir);
    const backupPath = `${dbPath}.prepurge-${stamp}`;
    copyFileSync(dbPath, backupPath);

    const ids = matched.map((record) => getRecordRowId(record));
    const refs = referencingTables(db);
    const deletedByTable: Record<string, number> = {};
    const run = db.transaction(() => {
      for (const batch of chunks(ids)) {
        const placeholders = batch.map(() => '?').join(',');
        for (const { table, column } of refs) {
          const result = db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`).run(...batch);
          if (result.changes > 0) deletedByTable[table] = (deletedByTable[table] || 0) + result.changes;
        }
        const result = db.prepare(`DELETE FROM records WHERE _row_id IN (${placeholders})`).run(...batch);
        deletedByTable.records = (deletedByTable.records || 0) + result.changes;
        // Surviving duplicates pointing at a purged canonical row become standalone.
        db.prepare(`UPDATE records SET duplicate_of = '', duplicate_status = '' WHERE duplicate_of IN (${placeholders})`).run(...batch);
      }
    });
    run();

    return {
      examined: records.length,
      matched: matched.length,
      deleted: deletedByTable.records || 0,
      deleted_by_table: deletedByTable,
      matched_by_rule: matchedByRule,
      protected: protectedRecords,
      backup: backupPath,
      sample,
    };
  } finally {
    db.close();
  }
};
