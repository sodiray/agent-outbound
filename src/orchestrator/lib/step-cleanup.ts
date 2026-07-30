import { getDependentsOfStep } from './config.js';
import { getTargetColumnsForStepConfig } from './step-columns.js';
import { syncNextActionDateFromPipelineEvents } from '../runtime/db.js';

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
  'routed_by',
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

const SIDE_EFFECTING_STEP_KINDS = new Set(['send_email', 'send_sms', 'linkedin_connect']);

type CleanupDb = {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => {
    all: (...params: unknown[]) => Array<Record<string, unknown>>;
    get: (...params: unknown[]) => Record<string, unknown> | undefined;
    run: (...params: unknown[]) => { changes: number };
  };
};

const existingRecordColumns = (db: any) => {
  const rows = db.prepare('PRAGMA table_info(records)').all();
  return new Set(rows.map((row: any) => String(row?.name || '')));
};

const pipelineStepById = (config: unknown, stepId: string) => {
  const pipeline = Array.isArray((config as { pipeline?: unknown })?.pipeline)
    ? (config as { pipeline: unknown[] }).pipeline
    : [];
  return pipeline.find((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    return String((entry as Record<string, unknown>).id || '').trim() === stepId;
  }) as Record<string, unknown> | undefined;
};

export const clearStepState = ({
  db,
  config,
  stepId,
  recordId = '',
  allowSideEffectingClear = false,
}: {
  db: CleanupDb;
  config: unknown;
  stepId: string;
  recordId?: string;
  allowSideEffectingClear?: boolean;
}) => {
  const id = String(stepId || '').trim();
  const scopedRecordId = String(recordId || '').trim();
  if (!id) {
    return {
      pipelineEventsDeleted: 0,
      stalenessDeleted: 0,
      sideEffectOverrideUsed: false,
      warning: '',
    };
  }

  const step = pipelineStepById(config, id);
  const kind = String(step?.kind || '').trim();
  const declaredSideEffecting = step?.side_effecting === true || SIDE_EFFECTING_STEP_KINDS.has(kind);
  const scopeSql = scopedRecordId ? ' AND record_id = ?' : '';
  const scopeParams = scopedRecordId ? [id, scopedRecordId] : [id];
  const completed = db.prepare(`
    SELECT kind, side_effecting
    FROM pipeline_events
    WHERE step_id = ?${scopeSql}
      AND passed = 1
  `).all(...scopeParams);
  const hasCompletedSideEffect = completed.some((event) => (
    declaredSideEffecting
    || Number(event.side_effecting || 0) === 1
    || SIDE_EFFECTING_STEP_KINDS.has(String(event.kind || ''))
  ));
  const refusal = `Refusing to clear completed side-effecting step "${id}": clearing its pipeline_events or staleness can execute the external side effect again. Pass allowSideEffectingClear: true only when repeating that side effect is intentional.`;
  if (hasCompletedSideEffect && !allowSideEffectingClear) throw new Error(refusal);

  const affectedRecords = db.prepare(`
    SELECT DISTINCT record_id
    FROM pipeline_events
    WHERE step_id = ?${scopeSql}
      AND (reason = 'wake_at' OR kind = 'wait')
  `).all(...scopeParams).map((row) => String(row.record_id || '')).filter(Boolean);
  const pipelineEventsDeleted = db.prepare(`
    DELETE FROM pipeline_events
    WHERE step_id = ?${scopeSql}
  `).run(...scopeParams).changes;
  const stalenessDeleted = db.prepare(`
    DELETE FROM staleness
    WHERE step_id = ?${scopeSql}
  `).run(...scopeParams).changes;
  affectedRecords.forEach((affectedRecordId) => {
    syncNextActionDateFromPipelineEvents({ db, recordId: affectedRecordId });
  });

  return {
    pipelineEventsDeleted,
    stalenessDeleted,
    sideEffectOverrideUsed: hasCompletedSideEffect && allowSideEffectingClear,
    warning: hasCompletedSideEffect && allowSideEffectingClear
      ? `OVERRIDE USED: cleared completed side-effecting step "${id}". Running the pipeline can repeat its external side effect.`
      : '',
  };
};

export const cleanupRemovedStep = ({
  db,
  configBefore,
  configAfter,
  stepId,
  allowSideEffectingClear = false,
}: {
  db: CleanupDb;
  configBefore: unknown;
  configAfter: unknown;
  stepId: string;
  allowSideEffectingClear?: boolean;
}) => {
  const id = String(stepId || '').trim();
  if (!id) {
    return {
      droppedColumns: [],
      stalenessDeleted: false,
      stalenessRowsDeleted: 0,
      pipelineEventsDeleted: 0,
      dependentsInvalidated: [],
      sideEffectOverrideUsed: false,
      warning: '',
    };
  }

  const beforePipeline = Array.isArray((configBefore as { pipeline?: unknown })?.pipeline)
    ? (configBefore as { pipeline: unknown[] }).pipeline
    : [];
  const afterPipeline = Array.isArray((configAfter as { pipeline?: unknown })?.pipeline)
    ? (configAfter as { pipeline: unknown[] }).pipeline
    : [];
  const beforeEnrich = beforePipeline
    .filter((step): step is Record<string, unknown> => Boolean(step && typeof step === 'object'))
    .filter((step) => String(step.kind || '') === 'enrich');
  const afterEnrich = afterPipeline
    .filter((step): step is Record<string, unknown> => Boolean(step && typeof step === 'object'))
    .filter((step) => String(step.kind || '') === 'enrich');
  const targetStep = beforeEnrich.find((step) => String(step.id || '').trim() === id);
  const stepColumns = getTargetColumnsForStepConfig(targetStep || {}).map((column) => column.name);
  const clearedState = clearStepState({
    db,
    config: configBefore,
    stepId: id,
    allowSideEffectingClear,
  });

  const otherColumns = new Set<string>();
  for (const step of afterEnrich) {
    const stepKey = String(step?.id || '').trim();
    if (!stepKey) continue;
    for (const column of getTargetColumnsForStepConfig(step || {})) {
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

  const dependents = getDependentsOfStep(configAfter as Record<string, unknown>, id);
  const dependentIds = [...new Set(dependents.map((dep) => String(dep?.stepId || '').trim()).filter(Boolean))];
  if (dependentIds.length > 0) {
    const placeholders = dependentIds.map(() => '?').join(',');
    db.prepare(`UPDATE staleness SET dep_hash = '' WHERE step_id IN (${placeholders})`).run(...dependentIds);
  }

  return {
    droppedColumns: exclusive,
    stalenessDeleted: true,
    stalenessRowsDeleted: clearedState.stalenessDeleted,
    pipelineEventsDeleted: clearedState.pipelineEventsDeleted,
    dependentsInvalidated: dependentIds,
    sideEffectOverrideUsed: clearedState.sideEffectOverrideUsed,
    warning: clearedState.warning,
  };
};
