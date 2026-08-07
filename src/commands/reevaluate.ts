import { readConfig } from '../orchestrator/lib/config.js';
import { validateWhereSql } from '../orchestrator/lib/sql-safety.js';
import { getRecordRowId } from '../orchestrator/lib/record.js';
import { assertRecordAccessForMutation } from '../orchestrator/policy/canary-isolation.js';
import {
  buildIdentityResolution,
  deriveBuyerConfidence,
  deriveMailConfidence,
  derivePhoneConfidence,
} from '../orchestrator/policy/evidence.js';
import { findNearDuplicateMatch, findNearDuplicatePairs } from '../orchestrator/sourcing/near-duplicate.js';
import { ensureRecordColumns, listFieldOverridesForRecord, openListDb } from '../orchestrator/runtime/db.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';

const REEVALUATION_AREAS = ['provenance', 'confidences', 'near_duplicates'] as const;

type ReevaluationArea = typeof REEVALUATION_AREAS[number];

type ReevaluationChange = {
  field: string;
  from: unknown;
  to: unknown;
  reason: string;
};

type ReevaluationRecord = {
  row_id: string;
  business_name: string;
  changes: ReevaluationChange[];
  protected_fields: string[];
  provenance_unavailable: string[];
};

const text = (value: unknown): string => String(value ?? '').trim();

const numeric = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const sameValue = (left: unknown, right: unknown): boolean => {
  if (typeof right === 'number') return numeric(left) === right;
  return left === right;
};

const parseAreas = (what: string | string[]): ReevaluationArea[] => {
  const requested = (Array.isArray(what) ? what : String(what || '').split(','))
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim().toLowerCase().replace(/-/gu, '_'))
    .filter(Boolean);
  if (requested.length === 0 || requested.includes('all')) return [...REEVALUATION_AREAS];
  const invalid = requested.filter((value) => !REEVALUATION_AREAS.includes(value as ReevaluationArea));
  if (invalid.length > 0) {
    throw new Error(`Unknown --what value(s): ${invalid.join(', ')}. Use provenance, confidences, near_duplicates, or all.`);
  }
  return [...new Set(requested as ReevaluationArea[])];
};

const terminalRecord = (record: Record<string, unknown>): boolean => {
  const lifecycle = text(record.lifecycle_stage).toLowerCase();
  const sequence = text(record.sequence_status).toLowerCase();
  const accountSequence = text(record.account_sequence_state).toLowerCase();
  return Boolean(record.suppressed)
    || ['won', 'lost', 'disqualified'].includes(lifecycle)
    || ['completed', 'cancelled', 'opted_out', 'bounced'].includes(sequence)
    || ['completed', 'cancelled'].includes(accountSequence);
};

const confidenceChanges = ({
  record,
  config,
  protectedFields,
}: {
  record: Record<string, unknown>;
  config: Record<string, unknown>;
  protectedFields: Set<string>;
}): ReevaluationChange[] => {
  const score = (config.score || {}) as Record<string, unknown>;
  const desired: Record<string, number> = {
    identity_confidence: buildIdentityResolution(record, score.identity_confidence).identity_confidence ?? 0,
    phone_confidence: derivePhoneConfidence(record, score.phone_confidence),
    buyer_confidence: deriveBuyerConfidence(record, score.buyer_confidence),
    mail_confidence: deriveMailConfidence(record, score.mail_confidence),
  };
  return Object.entries(desired)
    .filter(([field]) => !protectedFields.has(field))
    .filter(([field, value]) => !sameValue(record[field], value))
    .map(([field, value]) => ({
      field,
      from: record[field] ?? null,
      to: value,
      reason: 'derived_from_current_persisted_evidence',
    }));
};

const provenanceChanges = ({
  record,
  declaredPhoneSourceKind,
  protectedFields,
}: {
  record: Record<string, unknown>;
  declaredPhoneSourceKind: string;
  protectedFields: Set<string>;
}): ReevaluationChange[] => {
  const changes: ReevaluationChange[] = [];
  if (declaredPhoneSourceKind && text(record.phone) && !text(record.phone_source_kind) && !protectedFields.has('phone_source_kind')) {
    changes.push({
      field: 'phone_source_kind',
      from: record.phone_source_kind ?? null,
      to: declaredPhoneSourceKind,
      reason: 'operator_declared_provenance',
    });
  }
  if (text(record.place_id) && !text(record.resolution_source) && !protectedFields.has('resolution_source')) {
    changes.push({
      field: 'resolution_source',
      from: record.resolution_source ?? null,
      to: 'places',
      reason: 'derived_from_retained_place_id',
    });
  }
  return changes;
};

const duplicateChange = ({
  record,
  candidates,
  config,
  protectedFields,
}: {
  record: Record<string, unknown>;
  candidates: Record<string, unknown>[];
  config: Record<string, unknown>;
  protectedFields: Set<string>;
}): ReevaluationChange[] => {
  if (terminalRecord(record) || text(record.duplicate_status).toLowerCase() === 'confirmed') return [];
  const rowId = getRecordRowId(record);
  const canonicalCandidates = candidates.filter((candidate) => getRecordRowId(candidate).localeCompare(rowId) < 0);
  const match = findNearDuplicateMatch({ row: record, candidates: canonicalCandidates, config });
  if (!match) return [];
  const desired = {
    duplicate_of: getRecordRowId(match.candidate),
    duplicate_status: 'needs_review',
    duplicate_reason: match.reason,
  };
  return Object.entries(desired)
    .filter(([field]) => !protectedFields.has(field))
    .filter(([field, value]) => !sameValue(record[field], value))
    .map(([field, value]) => ({
      field,
      from: record[field] ?? null,
      to: value,
      reason: 'near_duplicate_detected',
    }));
};

const columnsFor = (changes: ReevaluationChange[]) => changes.map((change) => (
  change.field.endsWith('_confidence')
    ? { name: change.field, type: 'REAL' }
    : { name: change.field, type: 'TEXT' }
));

export const recordsReevaluateCommand = ({
  list,
  what = '',
  where = '',
  limit = 0,
  dryRun = false,
  apply = false,
  declaredPhoneSourceKind = '',
}: {
  list: string;
  what?: string | string[];
  where?: string;
  limit?: number;
  dryRun?: boolean;
  apply?: boolean;
  declaredPhoneSourceKind?: string;
}) => {
  if (apply && dryRun) throw new Error('Use either --apply or --dry-run, not both. Re-evaluation defaults to dry-run.');
  const phoneSourceKind = text(declaredPhoneSourceKind).toLowerCase();
  if (phoneSourceKind && phoneSourceKind !== 'structured') {
    throw new Error('--declare-phone-source-kind currently accepts only "structured". It is an explicit operator assertion, never an inference.');
  }

  const listDir = resolveListDir(list);
  const areas = parseAreas(what);
  const whereSql = text(where);
  const whereCheck = validateWhereSql(whereSql);
  if (!whereCheck.ok) throw new Error(whereCheck.error || 'Invalid --where SQL fragment.');
  const effectiveDryRun = !apply || dryRun;
  const db = openListDb({ listDir, readonly: effectiveDryRun });

  try {
    const { config } = readConfig(listDir);
    const params: unknown[] = [];
    const limitN = Math.max(0, Number(limit || 0));
    let selectedSql = `SELECT * FROM records ${whereSql ? `WHERE (${whereSql})` : ''} ORDER BY _row_id ASC`;
    if (limitN > 0) {
      selectedSql += ' LIMIT ?';
      params.push(limitN);
    }
    const selected = db.prepare(selectedSql).all(...params) as Record<string, unknown>[];
    const candidates = areas.includes('near_duplicates')
      ? db.prepare('SELECT * FROM records ORDER BY _row_id ASC').all() as Record<string, unknown>[]
      : [];
    const records: ReevaluationRecord[] = [];
    const allChanges: Array<{ record: Record<string, unknown>; changes: ReevaluationChange[] }> = [];

    for (const record of selected) {
      const rowId = getRecordRowId(record);
      const overrides = listFieldOverridesForRecord({ db, recordId: rowId }) as Array<Record<string, unknown>>;
      const protectedFields = new Set<string>(overrides.map((override) => text(override.field)));
      const provenance = areas.includes('provenance')
        ? provenanceChanges({ record, declaredPhoneSourceKind: phoneSourceKind, protectedFields })
        : [];
      const recordWithDeclaredProvenance = {
        ...record,
        ...Object.fromEntries(provenance.map((change) => [change.field, change.to])),
      };
      const changes = terminalRecord(record)
        ? []
        : [
            ...provenance,
            ...(areas.includes('confidences')
              ? confidenceChanges({ record: recordWithDeclaredProvenance, config, protectedFields })
              : []),
            ...(areas.includes('near_duplicates')
              ? duplicateChange({ record, candidates, config: (config.source?.near_duplicate || {}) as Record<string, unknown>, protectedFields })
              : []),
          ];
      const provenanceUnavailable = areas.includes('provenance')
        && text(record.phone)
        && !text(record.phone_source_kind)
        && !phoneSourceKind
        ? ['phone_source_kind: raw provider field path was not retained; no provenance was inferred']
        : [];
      records.push({
        row_id: rowId,
        business_name: text(record.business_name),
        changes,
        protected_fields: [...protectedFields].filter((field) => (
          ['phone_source_kind', 'resolution_source', 'identity_confidence', 'phone_confidence', 'buyer_confidence', 'mail_confidence', 'duplicate_of', 'duplicate_status', 'duplicate_reason'].includes(field)
        )),
        provenance_unavailable: provenanceUnavailable,
      });
      if (changes.length > 0) allChanges.push({ record, changes });
    }

    if (!effectiveDryRun && allChanges.length > 0) {
      ensureRecordColumns({ db, columns: columnsFor(allChanges.flatMap(({ changes }) => changes)) });
      const timestamp = new Date().toISOString();
      for (const proposal of allChanges) {
        const rowId = getRecordRowId(proposal.record);
        assertRecordAccessForMutation({ listDir, recordId: rowId });
        const fields = proposal.changes.map((change) => change.field);
        const setSql = fields.map((field) => `${field} = ?`).join(', ');
        db.prepare(`UPDATE records SET ${setSql}, updated_at = ? WHERE _row_id = ?`)
          .run(...proposal.changes.map((change) => change.to), timestamp, rowId);
      }
    }

    const fields = records.flatMap((record) => record.changes).reduce<Record<string, number>>((counts, change) => ({
      ...counts,
      [change.field]: (counts[change.field] || 0) + 1,
    }), {});
    const selectedIds = new Set(selected.map((record) => getRecordRowId(record)));
    const duplicatePairs = areas.includes('near_duplicates')
      ? findNearDuplicatePairs({
          rows: candidates,
          config: (config.source?.near_duplicate || {}) as Record<string, unknown>,
        })
        .filter(({ row, candidate }) => (
          selectedIds.has(getRecordRowId(row)) || selectedIds.has(getRecordRowId(candidate))
        ))
        .map(({ row, candidate, signals, name_similarity, reason }) => ({
          row_id: getRecordRowId(row),
          business_name: text(row.business_name),
          matched_row_id: getRecordRowId(candidate),
          matched_business_name: text(candidate.business_name),
          signals,
          name_similarity: Number(name_similarity.toFixed(2)),
          reason,
        }))
      : [];
    return {
      status: effectiveDryRun ? 'dry_run' : 'applied',
      list: listDir,
      dry_run: effectiveDryRun,
      areas,
      matched: selected.length,
      changed_records: allChanges.length,
      fields,
      duplicate_pairs: duplicatePairs,
      provenance: {
        phone_source_kind: phoneSourceKind ? 'operator_declared_for_blank_stamps' : 'not_inferred',
        resolution_source: 'derived_from_retained_place_id',
      },
      protected: [
        'suppressed records and terminal lifecycle/sequence states are skipped',
        'active field overrides on reevaluation-owned fields are skipped',
        'confirmed duplicate decisions are never overwritten',
        'suppression, DNE/DNC, bounce, human review, sequence progress, and all other fields are never written',
      ],
      records,
    };
  } finally {
    db.close();
  }
};
