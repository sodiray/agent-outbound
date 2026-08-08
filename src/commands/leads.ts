import { resolveListDir } from '../orchestrator/runtime/paths.js';
import { runPipelineDataflow } from '../orchestrator/pipeline/dataflow.js';
import { addSingleLead } from '../orchestrator/sourcing/single-lead.js';
import {
  clearFieldOverrides,
  getRecordById,
  insertFieldOverride,
  listFieldOverridesForRecord,
  openListDb,
  reconcileFieldOverrides,
  resolveRecordRef,
} from '../orchestrator/runtime/db.js';
import { leadStatus } from '../orchestrator/runtime/status.js';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';

const sqlString = (value: string) => `'${String(value || '').replace(/'/g, "''")}'`;

export const leadAddCommand = async ({
  list,
  name,
  near = '',
  query = '',
  run = false,
  dryRun = false,
  max = 5,
}: {
  list: string;
  name: string;
  near?: string;
  query?: string;
  run?: boolean;
  dryRun?: boolean;
  max?: number;
}) => {
  const listDir = resolveListDir(list);
  const intake = await addSingleLead({
    listDir,
    name,
    near,
    query,
    max,
    dryRun,
  });
  const rowId = String(intake.record?.row_id || '').trim();
  const where = rowId ? `_row_id = ${sqlString(rowId)}` : '';
  const pipelineRun = async () => {
    if (!run || dryRun || !rowId) return null;
    const pipeline = await runPipelineDataflow({ listDir, where });
    return {
      where,
      pipeline,
    };
  };

  return {
    ...intake,
    run: await pipelineRun(),
  };
};

const fieldOverrideView = (row: any) => ({
  id: String(row.id || ''),
  field: String(row.field || ''),
  value: row.value === null || row.value === undefined ? null : String(row.value),
  reason: String(row.reason || ''),
  created_by: String(row.created_by || ''),
  created_at: String(row.created_at || ''),
  ...(String(row.cleared_at || '').trim() ? { cleared_at: String(row.cleared_at), cleared_by: String(row.cleared_by || '') } : {}),
});

// Manually set a record field ("the decision maker is Teresa"). The value is
// written immediately AND registered as an active field override, so pipeline
// and scoring reruns re-assert it instead of clobbering it.
export const leadSetCommand = ({ list, ref, field, value, reason = '', createdBy = '' }: { list: string; ref: string; field: string; value: string; reason?: string; createdBy?: string }) => {
  if (!String(field || '').trim()) throw new AgentOutboundError({ code: 'INVALID_ARGUMENT', message: 'lead set requires --field FIELD.', retryable: false });
  if (value === undefined) throw new AgentOutboundError({ code: 'INVALID_ARGUMENT', message: 'lead set requires --value VALUE.', retryable: false });
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const record = resolveRecordRef({ db, ref });
    const recordId = String(record._row_id);
    const previous = record[String(field).trim()];
    const override = insertFieldOverride({ db, recordId, field, value, reason, createdBy });
    reconcileFieldOverrides({ db });
    const after = getRecordById({ db, id: recordId });
    return {
      status: 'field_set',
      record: { row_id: recordId, business_name: String(record.business_name || '') },
      field: override.field,
      previous_value: previous === null || previous === undefined ? null : String(previous),
      value: override.value,
      reason: override.reason,
      lead_status: leadStatus(after),
      note: 'This field is now human-owned: enrichment and scoring reruns will not change it. Use `lead unset` to release it.',
    };
  } finally {
    db.close();
  }
};

export const leadUnsetCommand = ({ list, ref, field = null, clearedBy = '' }: { list: string; ref: string; field?: string | null; clearedBy?: string }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const record = resolveRecordRef({ db, ref });
    const cleared = clearFieldOverrides({ db, recordId: String(record._row_id), field, clearedBy });
    if (cleared.length === 0) {
      return { status: 'noop', record: { row_id: String(record._row_id), business_name: String(record.business_name || '') }, note: 'No matching active field overrides to clear.' };
    }
    return {
      status: 'field_overrides_cleared',
      record: { row_id: String(record._row_id), business_name: String(record.business_name || '') },
      cleared: cleared.map(fieldOverrideView),
      note: 'Released fields keep their current values but the pipeline may overwrite them on the next run.',
    };
  } finally {
    db.close();
  }
};

export const leadOverridesCommand = ({ list, ref }: { list: string; ref: string }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    const record = resolveRecordRef({ db, ref });
    const recordId = String(record._row_id);
    return {
      record: { row_id: recordId, business_name: String(record.business_name || '') },
      lead_status: leadStatus(record),
      active: listFieldOverridesForRecord({ db, recordId }).map(fieldOverrideView),
      history: listFieldOverridesForRecord({ db, recordId, includeCleared: true }).map(fieldOverrideView),
    };
  } finally {
    db.close();
  }
};
