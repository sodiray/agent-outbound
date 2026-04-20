import { getDependentsOfStep } from './config.js';
import { getTargetColumnsForStepConfig } from './step-columns.js';

const CORE_RECORD_COLUMNS = new Set([
  '_row_id',
  'id',
  '_created_at',
  '_updated_at',
  'business_name',
  'address',
  'city',
  'state',
  'zip',
  'postal_code',
  'country',
  'website',
  'domain',
  'google_place_id',
  'parent_row_id',
  'latitude',
  'longitude',
  'source',
  'source_query',
  'sourced_at',
  'duplicate_of',
  'duplicate_status',
  'source_filter_result',
  'source_filter_failures',
  'phone',
  'email_primary',
  'contact_name_primary',
  'contact_title_primary',
  'contact_name',
  'contact_email',
  'contact_title',
  'email_verification_status',
  'email_verification_confidence',
  'email_verified_at',
  'fit_score',
  'trigger_score',
  'trigger_score_peak',
  'fit_reasoning',
  'trigger_reasoning',
  'fit_updated_at',
  'trigger_updated_at',
  'fit_score_updated_at',
  'trigger_score_updated_at',
  'priority_rank',
  'sequence_name',
  'sequence_status',
  'sequence_step',
  'sequence_step_attempts',
  'next_action_date',
  'launched_at',
  'last_outreach_at',
  'email_last_message_id',
  'email_last_thread_id',
  'email_last_draft_id',
  'email_last_reply_at',
  'email_reply_classification',
  'email_thread_id',
  'mail_last_piece_id',
  'mail_last_cost_cents',
  'mail_last_expected_delivery',
  'mail_last_delivered_at',
  'mail_last_returned_at',
  'visit_scheduled_date',
  'visit_route_id',
  'visit_route_position',
  'sms_last_message_id',
  'call_last_disposition',
  'suppressed',
  'suppressed_reason',
  'suppressed_at',
  'do_not_sms',
  'dne_email',
  'dnc_phone',
  'dnk_visit',
  'crm_company_id',
  'crm_person_id',
  'crm_deal_id',
  'crm_last_synced_at',
  'crm_sync_hash',
  'workflow_signals',
  'vertical',
  'sub_vertical',
  'size_tier',
  'is_franchise',
  'persona',
  'outcome',
  'outcome_notes',
  'outcome_at',
  'outcome_value',
  'extra_json',
  'retry_count',
  'last_error',
  'created_at',
  'updated_at',
]);

const validIdentifier = (value: string) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(value || '').trim());

const existingRecordColumns = (db: any) => {
  const rows = db.prepare('PRAGMA table_info(records)').all();
  return new Set(rows.map((row: any) => String(row?.name || '')));
};

export const cleanupRemovedStep = ({
  db,
  configBefore,
  configAfter,
  stepId,
}: {
  db: any;
  configBefore: any;
  configAfter: any;
  stepId: string;
}) => {
  const id = String(stepId || '').trim();
  if (!id) {
    return {
      droppedColumns: [],
      stalenessDeleted: false,
      dependentsInvalidated: [],
    };
  }

  const beforeEnrich = Array.isArray(configBefore?.enrich) ? configBefore.enrich : [];
  const afterEnrich = Array.isArray(configAfter?.enrich) ? configAfter.enrich : [];
  const targetStep = beforeEnrich.find((step: any) => String(step?.id || '').trim() === id);
  const stepColumns = getTargetColumnsForStepConfig(targetStep?.config || {}).map((column) => column.name);

  const otherColumns = new Set<string>();
  for (const step of afterEnrich) {
    const stepKey = String(step?.id || '').trim();
    if (!stepKey) continue;
    for (const column of getTargetColumnsForStepConfig(step?.config || {})) {
      otherColumns.add(column.name);
    }
  }

  const existing = existingRecordColumns(db);
  const exclusive = stepColumns
    .map((name) => String(name || '').trim())
    .filter(Boolean)
    .filter((name) => !otherColumns.has(name))
    .filter((name) => !CORE_RECORD_COLUMNS.has(name))
    .filter((name) => existing.has(name))
    .filter((name) => validIdentifier(name));

  for (const col of exclusive) {
    db.exec(`ALTER TABLE records DROP COLUMN ${col}`);
  }

  db.prepare('DELETE FROM staleness WHERE step_id = ?').run(id);

  const dependents = getDependentsOfStep(configAfter, id);
  const dependentIds = [...new Set(dependents.map((dep) => String(dep?.stepId || '').trim()).filter(Boolean))];
  if (dependentIds.length > 0) {
    const placeholders = dependentIds.map(() => '?').join(',');
    db.prepare(`UPDATE staleness SET dep_hash = '' WHERE step_id IN (${placeholders})`).run(...dependentIds);
  }

  return {
    droppedColumns: exclusive,
    stalenessDeleted: true,
    dependentsInvalidated: dependentIds,
  };
};
