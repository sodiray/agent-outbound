import { createHash, randomUUID } from 'node:crypto';
import { addSuppression, listContactsByRecord, openGlobalSuppressionDb, openListDb, logCrmEvent, upsertRecord } from '../runtime/db.js';
import { readConfig } from '../lib/config.js';
import { syncCrmAction } from '../actions/sync-crm/index.js';
import { recordCostEvent } from '../lib/costs.js';
import { getRecordRowId } from '../lib/record.js';
import { assertToolSpecAvailable, getMcpClient } from '../runtime/mcp.js';
import { readToolCatalog } from '../lib/tool-catalog.js';

const stableHash = (value: any) => createHash('sha256').update(JSON.stringify(value || {})).digest('hex');

const syncSnapshot = ({ record, contacts, config }: { record: any; contacts: any[]; config: any }) => ({
  record: {
    _row_id: record?._row_id || record?.id || '',
    business_name: record?.business_name || '',
    address: record?.address || '',
    website: record?.website || '',
    phone: record?.phone || '',
    email_primary: record?.email_primary || '',
    outcome: record?.outcome || '',
    outcome_notes: record?.outcome_notes || '',
    sequence_status: record?.sequence_status || '',
    sequence_step: record?.sequence_step || 0,
    crm_company_id: record?.crm_company_id || '',
    crm_person_id: record?.crm_person_id || '',
    crm_deal_id: record?.crm_deal_id || '',
  },
  contacts: (contacts || []).map((c) => ({
    name: c?.name || c?.full_name || '',
    title: c?.title || '',
    email: c?.email || '',
    phone: c?.phone || '',
    role: c?.role || '',
    crm_person_id: c?.crm_person_id || '',
  })),
  config: {
    dnc_sync: config?.dnc_sync !== false,
    deal_stage_mapping: config?.deal_stage_mapping || {},
    config: config?.config || {},
  },
});

export const runCrmSync = async ({ listDir, where = "1=1", limit = 200 }) => {
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) throw new Error(`Invalid config: ${errors.join('; ')}`);
  const crmConfig = config?.crm || {};

  const db = openListDb({ listDir, readonly: false });
  const globalSuppressionDb = openGlobalSuppressionDb({ readonly: false });
  const mcp = await getMcpClient();
  const toolCatalog = readToolCatalog(listDir);
  try {
    const toolSpec = crmConfig?.tool || {};
    const hasToolkit = Array.isArray(toolSpec?.toolkits) && toolSpec.toolkits.length > 0;
    const hasTools = Array.isArray(toolSpec?.tools) && toolSpec.tools.length > 0;
    if (!hasToolkit && !hasTools) {
      throw new Error('CRM sync requires a configured toolkit. Run config author to set up CRM integration.');
    }
    await assertToolSpecAvailable({
      toolSpec,
      capability: 'CRM sync',
    });

    const rows = db.prepare(`SELECT * FROM records WHERE ${where} ORDER BY updated_at DESC LIMIT ?`).all(Number(limit));
    const summary = { total: rows.length, synced: 0, skipped: 0, failed: 0, errors: [] };

    for (const record of rows) {
      const recordId = getRecordRowId(record);
      const contacts = listContactsByRecord({ db, recordId });
      const snapshotHash = stableHash(syncSnapshot({ record, contacts, config: crmConfig }));
      if (String(record?.crm_sync_hash || '') === snapshotHash) {
        summary.skipped += 1;
        continue;
      }
      const result = await syncCrmAction({
        mcp,
        record: {
          ...record,
          contacts,
        },
        crmConfig,
        toolCatalog,
      });
      recordCostEvent({
        db,
        listDir,
        recordId,
        stepId: 'crm:sync',
        model: 'sonnet',
        usage: result.usage,
      });

      if (result.status === 'synced') {
        const remoteDnc = Boolean(result.remote_dnc) && (crmConfig?.dnc_sync !== false);
        const updated = {
          ...record,
          crm_company_id: result.company_id || record.crm_company_id,
          crm_person_id: result.person_id || record.crm_person_id,
          crm_deal_id: result.deal_id || record.crm_deal_id,
          crm_sync_hash: snapshotHash,
          crm_last_synced_at: new Date().toISOString(),
          suppressed: remoteDnc ? 1 : record.suppressed,
          suppressed_reason: remoteDnc ? 'crm_dnc' : record.suppressed_reason,
          suppressed_at: remoteDnc ? new Date().toISOString() : record.suppressed_at,
        };
        upsertRecord({ db, row: updated });
        if (remoteDnc) {
          const email = String(record?.email_primary || '').trim().toLowerCase();
          if (email) {
            const entry = {
              id: randomUUID(),
              value: email,
              value_type: 'email',
              scope: 'global',
              reason: 'crm_dnc',
              source: 'crm_sync',
              record_id: recordId,
              created_at: new Date().toISOString(),
            };
            addSuppression({ db, entry });
            addSuppression({ db: globalSuppressionDb, entry });
          }
        }
        summary.synced += 1;
      } else if (result.status === 'skipped') {
        summary.skipped += 1;
      } else {
        summary.failed += 1;
        summary.errors.push({ record_id: recordId, error: result.reason || 'sync failed' });
      }
    }

    logCrmEvent({ listDir, payload: summary });
    return summary;
  } finally {
    db.close();
    globalSuppressionDb.close();
  }
};
