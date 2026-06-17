import { AUTOMATION_PLAN_STEP_ID, runAutomations } from '../orchestrator/automations/runner.js';
import { findAsset, openListDb, resolveRecordRef } from '../orchestrator/runtime/db.js';
import { validateWhereSql } from '../orchestrator/lib/sql-safety.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';

const parseOutputs = (value: any) => {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

export const automationView = (asset: any) => ({
  asset_id: String(asset.asset_id || ''),
  row_id: String(asset.row_id || ''),
  summary: String(asset.reason || parseOutputs(asset.outputs_json).summary || ''),
  content: String(asset.result || ''),
  model: String(parseOutputs(asset.outputs_json).model || ''),
  status: String(asset.status || ''),
  updated_at: String(asset.updated_at || ''),
});

export const automationsCommand = async ({ list, where = '', limit = 0, force = false }: { list: string; where?: string; limit?: number; force?: boolean }) => {
  const listDir = resolveListDir(list);
  const whereSql = String(where || '').trim();
  if (whereSql) {
    const check = validateWhereSql(whereSql);
    if (!check.ok) throw new AgentOutboundError({ code: 'INVALID_ARGUMENT', message: check.error || 'Invalid --where SQL fragment.', retryable: false });
  }
  return runAutomations({ listDir, where: whereSql, limit, force });
};

export const automationsShowCommand = ({ list, ref }: { list: string; ref: string }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    const record = resolveRecordRef({ db, ref });
    const asset = findAsset({ db, rowId: String(record._row_id), stepId: AUTOMATION_PLAN_STEP_ID });
    if (!asset) {
      return {
        record: { row_id: String(record._row_id), business_name: String(record.business_name || '') },
        automation_plan: null,
        note: 'No automation plan generated for this lead yet. Run `automations <list> --where ...` (requires automations.enabled and an existing brief).',
      };
    }
    return {
      record: { row_id: String(record._row_id), business_name: String(record.business_name || '') },
      automation_plan: automationView(asset),
    };
  } finally {
    db.close();
  }
};
