import { readConfig } from '../orchestrator/lib/config.js';
import {
  clearOverrides,
  getRecordById,
  insertOverride,
  listActiveOverrides,
  listOverridesForRecord,
  reconcileOverrides,
  resolveRecordRef,
  openListDb,
} from '../orchestrator/runtime/db.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';

const recordLabel = (record: any) => ({
  row_id: String(record._row_id || record.id || ''),
  business_name: String(record.business_name || record.name || ''),
});

const recordDecisionState = (record: any) => {
  const disqualifiedAt = String(record.disqualified_at || '').trim();
  const extra = (() => {
    try {
      return record?.extra_json && typeof record.extra_json === 'string' ? JSON.parse(record.extra_json) : (record?.extra_json || {});
    } catch {
      return {};
    }
  })();
  return {
    in_play: disqualifiedAt === '' && !record.suppressed,
    disqualified_at: disqualifiedAt,
    disqualified_gate: String(record.disqualified_gate || ''),
    disqualify_reason: String(record.disqualify_reason || ''),
    needs_review: Boolean(record.needs_review),
    review_reason: String(record.review_reason || ''),
    pipeline_flags: Array.isArray(extra.pipeline_flags) ? extra.pipeline_flags : [],
  };
};

const filterStepIds = (config: any) => (Array.isArray(config?.pipeline) ? config.pipeline : [])
  .filter((step: any) => String(step?.kind || '') === 'filter')
  .map((step: any) => String(step?.id || '').trim())
  .filter(Boolean);

export const overrideKeepCommand = ({ list, ref, step = '', allGates = false, reason = '', createdBy = '' }: { list: string; ref: string; step?: string; allGates?: boolean; reason?: string; createdBy?: string }) => {
  if (!String(reason || '').trim()) throw new AgentOutboundError({ code: 'INVALID_ARGUMENT', message: 'override keep requires --reason.', retryable: false });
  if (!allGates && !String(step || '').trim()) throw new AgentOutboundError({ code: 'INVALID_ARGUMENT', message: 'override keep requires --step STEP_ID or --all-gates.', retryable: false });
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const stepId = String(step || '').trim();
  if (!allGates) {
    const validSteps = filterStepIds(config);
    if (!validSteps.includes(stepId)) {
      throw new AgentOutboundError({ code: 'NOT_FOUND', message: `Unknown filter step "${stepId}". Filter steps: ${validSteps.join(', ') || '(none)'}`, retryable: false });
    }
  }
  const db = openListDb({ listDir, readonly: false });
  try {
    const record = resolveRecordRef({ db, ref });
    const override = insertOverride({ db, recordId: String(record._row_id), kind: 'keep', stepId: allGates ? '' : stepId, reason, createdBy });
    reconcileOverrides({ db });
    const after = getRecordById({ db, id: String(record._row_id) });
    return {
      status: 'override_created',
      override,
      scope: allGates ? 'all_gates' : `gate:${stepId}`,
      record: recordLabel(record),
      state: recordDecisionState(after),
      note: 'Run `pipeline --reapply` to process this lead through the remaining steps.',
    };
  } finally {
    db.close();
  }
};

export const overrideDropCommand = ({ list, ref, reason = '', createdBy = '' }: { list: string; ref: string; reason?: string; createdBy?: string }) => {
  if (!String(reason || '').trim()) throw new AgentOutboundError({ code: 'INVALID_ARGUMENT', message: 'override drop requires --reason.', retryable: false });
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const record = resolveRecordRef({ db, ref });
    const override = insertOverride({ db, recordId: String(record._row_id), kind: 'drop', stepId: '', reason, createdBy });
    reconcileOverrides({ db });
    const after = getRecordById({ db, id: String(record._row_id) });
    return {
      status: 'override_created',
      override,
      record: recordLabel(record),
      state: recordDecisionState(after),
    };
  } finally {
    db.close();
  }
};

export const overrideClearCommand = ({ list, ref, step = null, clearedBy = '' }: { list: string; ref: string; step?: string | null; clearedBy?: string }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const record = resolveRecordRef({ db, ref });
    const stepFilter = step === null || step === undefined ? null : String(step || '');
    const cleared = clearOverrides({ db, recordId: String(record._row_id), stepId: stepFilter, clearedBy });
    if (cleared.length === 0) {
      return { status: 'noop', record: recordLabel(record), note: 'No matching active overrides to clear.' };
    }
    // Honor remaining overrides; record state is reconciled but not re-evaluated
    // until the next `pipeline --reapply` run.
    reconcileOverrides({ db });
    const after = getRecordById({ db, id: String(record._row_id) });
    return {
      status: 'overrides_cleared',
      cleared_count: cleared.length,
      cleared: cleared.map((o: any) => ({ id: o.id, kind: o.kind, step_id: o.step_id, reason: o.reason })),
      record: recordLabel(record),
      state: recordDecisionState(after),
      note: 'Cleared overrides no longer apply. Run `pipeline --reapply` to re-evaluate this lead.',
    };
  } finally {
    db.close();
  }
};

export const overrideListCommand = ({ list }: { list: string }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    const rows = listActiveOverrides({ db });
    const overrides = rows.map((row: any) => {
      const record = getRecordById({ db, id: String(row.record_id) });
      return {
        id: row.id,
        kind: row.kind,
        scope: String(row.step_id || '').trim() ? `gate:${row.step_id}` : (row.kind === 'keep' ? 'all_gates' : 'manual'),
        record: record ? recordLabel(record) : { row_id: String(row.record_id), business_name: '(deleted record)' },
        reason: row.reason,
        created_at: row.created_at,
        created_by: row.created_by,
      };
    });
    return {
      count: overrides.length,
      keep: overrides.filter((o) => o.kind === 'keep').length,
      drop: overrides.filter((o) => o.kind === 'drop').length,
      overrides,
    };
  } finally {
    db.close();
  }
};

export const overrideShowCommand = ({ list, ref }: { list: string; ref: string }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    const record = resolveRecordRef({ db, ref });
    const active = listOverridesForRecord({ db, recordId: String(record._row_id) });
    const history = listOverridesForRecord({ db, recordId: String(record._row_id), includeCleared: true });
    return {
      record: recordLabel(record),
      state: recordDecisionState(record),
      active_overrides: active.map((o: any) => ({ id: o.id, kind: o.kind, step_id: o.step_id, reason: o.reason, created_at: o.created_at })),
      override_history: history.map((o: any) => ({ id: o.id, kind: o.kind, step_id: o.step_id, reason: o.reason, created_at: o.created_at, cleared_at: o.cleared_at })),
    };
  } finally {
    db.close();
  }
};
