import { basename } from 'node:path';
import { readConfig } from '../orchestrator/lib/config.js';
import { recordScore } from '../orchestrator/lib/record.js';
import { getTargetColumnsForStepConfig } from '../orchestrator/lib/step-columns.js';
import { flattenPipelineSteps, stepStatusColumn, SUBPIPELINE_LOCAL_ID_FIELD } from '../orchestrator/lib/subpipelines.js';
import { inferPipelineEdges } from '../orchestrator/lib/pipeline-graph.js';
import { declaredStageInputs } from '../orchestrator/lib/stage-inputs.js';
import { stepConfigForWhen, whenPredicateForStep } from '../orchestrator/lib/step-when.js';
import { resolvePipelineFitModel } from '../orchestrator/scoring/fit-model.js';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';
import {
  getAssetsForRow,
  getBriefForRecord,
  getRecordById,
  getTerritoryNotes,
  inPlayWhere,
  insertTerritoryNote,
  listFieldOverridesForRecord,
  listInteractionsForRecord,
  listOverridesForRecord,
  OVERRIDE_GATE,
  openListDb,
} from '../orchestrator/runtime/db.js';
import { LEAD_STATUSES, leadStatus, leadStatusCaseSql } from '../orchestrator/runtime/status.js';
import { getEnv } from '../orchestrator/runtime/env.js';
import {
  awaitingReviewWhere,
  configuredReviewStages,
  countAwaitingReviewAtStage,
  countAwaitingReviewBySequence,
  getAllReviewQueue,
  getReviewStages,
  isRecordAwaitingReview,
  requireResolvedReviewStage,
  type ReviewDecision,
} from '../orchestrator/pipeline/review.js';
import { reviewClearCommand, reviewDropCommand, reviewPassCommand } from '../commands/review.js';
import {
  DEFAULT_REJECTED_RESTORE_REASON,
  getRejectedRecords,
  getRejectedSources,
  restoreRejectedRecord,
} from '../orchestrator/pipeline/rejected.js';

const NUMERIC_COLUMNS = new Set([
  'priority_rank',
  'fit_score',
  'trigger_score',
  'user_rating_count',
  'userRatingCount',
  'latitude',
  'longitude',
  'lat',
  'lng',
  'email_verification_confidence',
  'trigger_score_peak',
  'sequence_step',
  'sequence_step_attempts',
  'mail_last_cost_cents',
  'visit_route_position',
  'outcome_value',
  'retry_count',
]);
const NUMERIC_FILTER_COLUMNS = new Set(['priority_rank', 'user_rating_count']);

// Single-score model: the legacy fit/trigger axes and internal score plumbing are
// hidden from the table. priority_rank is the one visible "Score".
const HIDDEN_SCORE_COLUMNS = new Set([
  'fit_score', 'trigger_score', 'trigger_score_peak',
  'fit_reasoning', 'trigger_reasoning', 'fit_breakdown', 'trigger_breakdown',
  'fit_updated_at', 'trigger_updated_at', 'fit_score_updated_at', 'trigger_score_updated_at',
  'fit_scoring_error', 'trigger_scoring_error',
  'fit_score_override', 'trigger_score_override', 'fit_score_override_reason', 'trigger_score_override_reason',
  'score_reasoning', 'score_breakdown', 'score_updated_at', 'score_scoring_error',
  'score_override', 'score_override_reason',
]);

const BOOLEAN_COLUMNS = new Set([
  'suppressed',
  'do_not_sms',
  'dne_email',
  'dnc_phone',
  'dnk_visit',
  'is_franchise',
  'has_storefront',
  'has_online_booking',
  'has_online_payment',
  'has_chat',
  'manual_intake',
  'is_hiring',
  'admin_job_active',
]);

const IDENTITY_COLUMNS = new Set([
  '_row_id',
  'id',
  'business_name',
  'name',
  'address',
  'formattedAddress',
  'city',
  'state',
  'zip',
  'postal_code',
  'country',
  'website',
  'websiteUri',
  'domain',
  'phone',
  'nationalPhoneNumber',
  'email_primary',
  'contact_name_primary',
  'contact_title_primary',
  'contact_name',
  'contact_email',
  'contact_title',
  'google_place_id',
  'place_id',
  'placeId',
  'latitude',
  'longitude',
  'lat',
  'lng',
  'googleMapsUri',
  'googleMapsUrl',
]);

const SCORE_COLUMNS = new Set([
  'fit_score',
  'trigger_score',
  'trigger_score_peak',
  'priority_rank',
  'fit_reasoning',
  'trigger_reasoning',
  'fit_breakdown',
  'trigger_breakdown',
  'fit_updated_at',
  'trigger_updated_at',
  'fit_score_updated_at',
  'trigger_score_updated_at',
  'fit_scoring_error',
  'trigger_scoring_error',
]);

const LIFECYCLE_COLUMNS = new Set([
  '_created_at',
  '_updated_at',
  'created_at',
  'updated_at',
  'source',
  'source_query',
  'sourced_at',
  'duplicate_of',
  'duplicate_status',
  'source_filter_result',
  'source_filter_failures',
  'disqualified_at',
  'disqualified_gate',
  'disqualify_reason',
  'sequence_name',
  'pipeline_name',
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
  'reply_classification_latest',
  'email_thread_id',
  'disposition_latest',
  'disposition_follow_up_at',
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
  'outcome',
  'outcome_notes',
  'outcome_at',
  'outcome_value',
  'extra_json',
  'retry_count',
  'last_error',
]);

const LOW_CARDINALITY_FILTERS = new Set(['city', 'state', 'primary_type', 'vertical']);
const COST_PREFIXES = ['pipeline_enrich', 'pipeline_filter_batch', 'pipeline_filter', 'scoring', 'score'];
const RAW_RECORD_FIELDS = new Set(['extra_json']);
const INTERNAL_RECORD_FIELDS = new Set([
  'id',
  'needs_review',
  'review_reason',
  'review_flagged_at',
  'parent_row_id',
  'duplicate_of',
  'duplicate_status',
  'source_filter_result',
  'source_filter_failures',
  'disqualified_at',
  'disqualified_gate',
  'disqualify_reason',
  'retry_count',
  'last_error',
]);
const RECORD_DETAIL_FIELD_ALIASES = [
  ['business_name', 'name'],
  ['address', 'formattedAddress'],
  ['website', 'websiteUri'],
  ['phone', 'nationalPhoneNumber'],
  ['postal_code', 'zip'],
  ['google_place_id', 'place_id', 'placeId'],
  ['latitude', 'lat'],
  ['longitude', 'lng'],
  ['google_maps_url', 'googleMapsUrl', 'googleMapsUri'],
  ['business_status', 'businessStatus'],
  ['user_rating_count', 'userRatingCount'],
  ['primary_type', 'primaryType'],
];
const RECORD_DETAIL_FIELD_ALIAS_META = new Map(
  RECORD_DETAIL_FIELD_ALIASES.flatMap((fields, groupIndex) => (
    fields.map((field, fieldIndex) => [field, { group: `alias:${groupIndex}`, rank: fieldIndex }] as const)
  )),
);
const SUCCESSFUL_ENRICH_STATUSES = new Set(['ok', 'done', 'complete', 'completed', 'success']);

const quoteIdent = (value: string) => `"${String(value).replaceAll('"', '""')}"`;
const labelFor = (key: string) => key.replace(/__status$/, '').replace(/^_+/, '').split('_').filter(Boolean).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ') || key;
const normalizedRows = (rows: any) => Array.isArray(rows) ? rows : [];
const toNumberOrNull = (value: any) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const tableExists = (db: any, table: string) => {
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(table));
  } catch {
    return false;
  }
};
const tableColumns = (db: any, table: string) => {
  try {
    return normalizedRows(db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all()).map((row: any) => String(row.name || ''));
  } catch {
    return [];
  }
};
const hasTableColumn = (db: any, table: string, column: string) => tableColumns(db, table).includes(column);
const outputEntries = (step: any) => Object.entries(step?.outputs || {});
const hasRecordDetailValue = (value: any) => (
  value !== null
  && value !== undefined
  && (typeof value !== 'string' || value.trim() !== '')
);
const canonicalizeRecordDetailFields = (record: any) => RECORD_DETAIL_FIELD_ALIASES.reduce(
  (current, [canonical, ...aliases]) => {
    if (hasRecordDetailValue(current[canonical])) return current;
    const alias = aliases.find((field) => hasRecordDetailValue(current[field]));
    return alias ? { ...current, [canonical]: current[alias] } : current;
  },
  { ...record },
);
const fieldAliasMeta = (field: string) => {
  const explicit = RECORD_DETAIL_FIELD_ALIAS_META.get(field);
  if (explicit) return explicit;
  const normalized = field.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const snakeCaseRank = /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(field) ? 0 : 1;
  return { group: `normalized:${normalized}`, rank: snakeCaseRank };
};
const dedupeRecordDetailFields = ({ fields, record }: { fields: string[]; record: any }) => {
  const winners = new Map<string, { field: string; rank: number }>();
  for (const field of fields) {
    if (!hasRecordDetailValue(record[field])) continue;
    const alias = fieldAliasMeta(field);
    const current = winners.get(alias.group);
    if (!current || alias.rank < current.rank) winners.set(alias.group, { field, rank: alias.rank });
  }
  const selected = new Set([...winners.values()].map((winner) => winner.field));
  return fields.filter((field) => selected.has(field));
};
const isInternalRecordDetailField = (key: string) => (
  key.startsWith('_')
  || key.endsWith('__status')
  || key === 'created_at'
  || key === 'updated_at'
  || INTERNAL_RECORD_FIELDS.has(key)
  || HIDDEN_SCORE_COLUMNS.has(key)
  || SCORE_COLUMNS.has(key)
  || LIFECYCLE_COLUMNS.has(key)
  || /(?:^|_)(?:embedding|dedup)(?:_|$)/i.test(key)
  || /^(?:attio|crm)_/i.test(key)
  || /(?:_last_synced_at|_sync_hash)$/i.test(key)
);
const sourceOutputTargets = (config: any) => {
  const source = config?.source && typeof config.source === 'object' ? config.source : {};
  const searches = Array.isArray(source.searches) ? source.searches : [];
  const strategies = Array.isArray(source.strategies) ? source.strategies : [];
  const mappedFields = [...searches, ...strategies].flatMap((entry) => {
    const outputMap = entry?.output_map && typeof entry.output_map === 'object'
      ? entry.output_map
      : {};
    return [...Object.keys(outputMap), ...Object.values(outputMap).map((value) => String(value || ''))];
  });
  return new Set(mappedFields.filter((field) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)));
};
const isUnattributedTypeDefault = (value: any) => (
  (typeof value === 'number' && value === 0)
  || value === false
);
const recordDetailFieldClassification = ({
  config,
  record,
  recordColumns,
}: {
  config: any;
  record: any;
  recordColumns: string[];
}) => {
  const producers = new Map<string, Set<string>>();
  for (const step of flattenPipelineSteps(config)) {
    if (String(step?.kind || '') !== 'enrich') continue;
    const stepId = String(step?.id || '').trim();
    if (!stepId) continue;
    const stepConfig = (
      step?.config && typeof step.config === 'object' ? step.config : step
    ) as Record<string, unknown>;
    const legacyColumnKeys = stepConfig?.columns && typeof stepConfig.columns === 'object'
      ? Object.keys(stepConfig.columns)
      : [];
    const fields = [
      ...legacyColumnKeys,
      ...getTargetColumnsForStepConfig(stepConfig).map((column) => column.name),
    ];
    for (const field of fields) {
      if (!producers.has(field)) producers.set(field, new Set());
      producers.get(field)?.add(stepId);
    }
  }
  const producerRan = (field: string) => [...(producers.get(field) || [])].some((stepId) => (
    SUCCESSFUL_ENRICH_STATUSES.has(String(record[stepStatusColumn(stepId)] || '').trim().toLowerCase())
  ));
  const raw = recordColumns.filter((key) => RAW_RECORD_FIELDS.has(key));
  const sourcedTargets = sourceOutputTargets(config);
  const displayFields = recordColumns.filter((key) => (
    !RAW_RECORD_FIELDS.has(key) && !isInternalRecordDetailField(key)
  ));
  return {
    sourced: dedupeRecordDetailFields({
      fields: displayFields.filter((key) => (
        !producerRan(key)
        && (
          sourcedTargets.has(key)
          || (!producers.has(key) && !isUnattributedTypeDefault(record[key]))
        )
      )),
      record,
    }),
    enriched: dedupeRecordDetailFields({
      fields: displayFields.filter((key) => producers.has(key) && producerRan(key)),
      record,
    }),
    raw,
  };
};
const sourceToolServer = (config: any) => {
  const strategy = Array.isArray(config?.source?.strategies) ? config.source.strategies.find((item: any) => item?.tool?.server) : null;
  return String(strategy?.tool?.server || config?.source?.tool?.server || '');
};
const sourceOutputKeys = (config: any) => {
  const strategies = Array.isArray(config?.source?.strategies) ? config.source.strategies : [];
  return new Set(strategies.flatMap((strategy: any) => Object.keys(strategy?.output_map || {})));
};
const stepOutputMap = (config: any) => {
  const map = new Map<string, string>();
  for (const step of flattenPipelineSteps(config)) {
    for (const [field] of outputEntries(step)) {
      map.set(String(field), String(step.id || ''));
    }
  }
  return map;
};
const recordFlaggedForStep = (row: any, stepId: string) => {
  try {
    const extra = JSON.parse(String(row?.extra_json || '{}') || '{}');
    const flags = Array.isArray(extra?.pipeline_flags) ? extra.pipeline_flags : [];
    return flags.some((flag: any) => String(flag?.step_id || flag?.step || flag?.id || '') === stepId);
  } catch {
    return false;
  }
};
const latestEvent = (events: any[]) => [...events].sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')))[0] || null;
const statusFromEvents = (events: any[]) => {
  const latest = latestEvent(events);
  if (!latest) return 'n/a';
  return latest.passed ? 'passed' : 'failed';
};
const inferredStepStatus = ({ step, index, dropIndex }: { step: any; index: number; dropIndex: number }) => {
  const kind = String(step?.kind || '');
  if (dropIndex >= 0) {
    if (index < dropIndex) return kind === 'enrich' ? 'done' : 'passed';
    if (index === dropIndex) return 'dropped';
    return 'not_reached';
  }
  return kind === 'enrich' ? 'done' : 'passed';
};
const costStepMatches = (raw: string, stepId: string) => {
  const stripped = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
  if (stripped === stepId) return true;
  if (stepId === 'score' && (raw.startsWith('scoring:') || raw.startsWith('score:') || stripped === 'fit' || stripped === 'trigger')) return true;
  return COST_PREFIXES.some((prefix) => raw === `${prefix}:${stepId}`);
};
const selectCostForStep = (rows: any[], stepId: string) => rows.find((row) => costStepMatches(String(row.step_id || ''), stepId)) || null;
const parseToolCalls = (value: any) => {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
const parseJsonArray = (value: any) => {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
const configuredCriteria = (config: any) => flattenPipelineSteps(config)
  .filter((step: any) => String(step?.kind || '') === 'score')
  .flatMap((step: any) => (Array.isArray(step?.criteria) ? step.criteria : []));
const configuredFitCriteria = (config: any) => resolvePipelineFitModel(config).fitModel?.criteria || [];
const criterionKey = (id: string) => `criterion__${id}`;
const criterionColumns = (config: any) => configuredCriteria(config).map((criterion: any) => {
  const id = String(criterion?.id || '');
  return {
    key: criterionKey(id),
    label: labelFor(id),
    type: 'verdict',
    group: 'criterion',
    default_visible: true,
    locked: false,
  };
}).filter((column) => column.key !== criterionKey(''));
const criterionIds = (config: any) => configuredCriteria(config).map((criterion: any) => String(criterion?.id || '')).filter(Boolean);
const nonEmptyValue = (value: any) => value !== null && value !== undefined && value !== '';
const nonEmptyString = (value: any) => String(value || '').trim() !== '';
const canonicalColumn = (realColumns: Set<string>, preferred: string, fallback: string) => realColumns.has(preferred) ? preferred : realColumns.has(fallback) ? fallback : '';
const verdictsFromBreakdown = (rawBreakdown: any) => new Map(parseJsonArray(rawBreakdown).map((item: any) => [String(item?.id || ''), String(item?.verdict || '')]));
// The row-level outcome glyph MUST agree with the lifecycle pills, so it derives
// from the same lead-status taxonomy. A record is only 'scored' when it is truly
// qualified (has a current score) — not merely "survived the gates" or carrying a
// legacy backfilled fit_score. Any dropped status collapses to the 'dropped' glyph.
const derivedOutcome = (record: any) => {
  const status = leadStatus(record);
  if (status === 'qualified') {
    return nonEmptyString(record.last_error) || nonEmptyString(record.fit_scoring_error) || nonEmptyString(record.trigger_scoring_error)
      ? 'error'
      : 'scored';
  }
  if (status === 'unscored') {
    return nonEmptyString(record.last_error) || nonEmptyString(record.fit_scoring_error) || nonEmptyString(record.trigger_scoring_error)
      ? 'error'
      : 'not_scored';
  }
  return 'dropped';
};
const costPayload = (row: any) => row ? {
  model: row.model || '',
  provider: row.provider || '',
  input_tokens: row.input_tokens ?? 0,
  output_tokens: row.output_tokens ?? 0,
  usd_cost: row.usd_cost === '' || row.usd_cost === undefined ? null : row.usd_cost,
  tool_calls: parseToolCalls(row.tool_calls),
  occurred_at: row.occurred_at || '',
} : null;
const formatConditionValue = (value: any) => {
  if (Array.isArray(value)) {
    const shown = value.slice(0, 5).map((item) => String(item));
    const suffix = value.length > shown.length ? `, +${value.length - shown.length} more` : '';
    return `[${shown.join(', ')}${suffix}]`;
  }
  if (value === undefined || value === null || value === '') return '';
  return String(value);
};
const OPERATOR_PHRASES: Record<string, string> = {
  gte: '≥',
  lte: '≤',
  gt: '>',
  lt: '<',
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
  not_in: 'is not one of',
  contains: 'contains',
  matches: 'matches',
  not_matches: 'must not match',
  is_empty: 'is empty',
  is_not_empty: 'is present',
};
const summarizeFieldCheckCondition = (condition: any) => {
  const field = labelFor(String(condition?.field || '').trim());
  const rawOp = String(condition?.operator || '').trim();
  const operator = OPERATOR_PHRASES[rawOp] || rawOp.replaceAll('_', ' ');
  if (rawOp === 'is_empty' || rawOp === 'is_not_empty') return `${field} ${operator}`.trim();
  const value = formatConditionValue(condition?.value);
  return [field, operator, value].filter(Boolean).join(' ');
};
const conditionSummary = (step: any) => {
  if (String(step?.kind || '') !== 'filter') return '';
  const type = String(step?.type || 'semantic').trim().toLowerCase();
  if (type === 'semantic') return String(step?.condition || '').trim();
  if (type !== 'field_check') return '';
  const conditions = Array.isArray(step?.conditions) ? step.conditions : [];
  const shown = conditions.slice(0, 2).map(summarizeFieldCheckCondition).filter(Boolean);
  const suffix = conditions.length > shown.length ? ` (+${conditions.length - shown.length} more)` : '';
  return `${shown.join('; ')}${suffix}`;
};
const mergeCriteriaBreakdown = (criteria: any[], rawBreakdown: any) => {
  const breakdown: any[] = (() => {
    try {
      const parsed = JSON.parse(String(rawBreakdown || '[]'));
      if (Array.isArray(parsed)) return parsed;
      return Array.isArray(parsed?.criteria) ? parsed.criteria : [];
    } catch {
      return [];
    }
  })();
  const breakdownById = new Map(breakdown.map((item: any) => [String(item?.id || ''), item]));
  return (Array.isArray(criteria) ? criteria : []).map((criterion: any) => {
    const id = String(criterion?.id || '');
    const breakdown = breakdownById.get(id) || {};
    return {
      id,
      description: String(criterion?.description || ''),
      weight: toNumberOrNull(criterion?.weight),
      verdict: breakdown.verdict === undefined ? null : String(breakdown.verdict || ''),
      grade: breakdown.grade === undefined ? null : toNumberOrNull(breakdown.grade),
      sub_score: breakdown.sub_score === undefined ? null : toNumberOrNull(breakdown.sub_score),
      points: breakdown.points === undefined ? null : toNumberOrNull(breakdown.points),
      reasoning: String(breakdown.reasoning || ''),
    };
  });
};
const typedOutputValue = (value: any, spec: any) => {
  if (value === null || value === undefined) return null;
  const type = String(spec?.type || '').toLowerCase();
  if (type === 'boolean') return Number(value) ? 1 : 0;
  if (type === 'number') return toNumberOrNull(value);
  return value;
};
const classifyColumn = ({ key, dbType, config, outputs, sourceOutputs }: any) => {
  const stepId = String(key).endsWith('__status') ? String(key).replace(/__status$/, '') : outputs.get(key);
  const type = String(key).endsWith('__status') ? 'status' : BOOLEAN_COLUMNS.has(key) ? 'boolean' : NUMERIC_COLUMNS.has(key) || /REAL|INT|NUM/i.test(String(dbType || '')) ? 'number' : 'text';
  if (String(key).endsWith('__status')) return { type, group: 'status', step_id: stepId };
  if (outputs.has(key)) return { type, group: 'enrich', step_id: outputs.get(key) };
  if (SCORE_COLUMNS.has(key)) return { type, group: 'score' };
  if (IDENTITY_COLUMNS.has(key)) return { type, group: 'identity' };
  if (sourceOutputs.has(key)) return { type, group: 'source' };
  if (LIFECYCLE_COLUMNS.has(key)) return { type, group: 'lifecycle' };
  const configIdentity = new Set(Array.isArray(config?.source?.identity) ? config.source.identity.map(String) : []);
  if (configIdentity.has(key)) return { type, group: 'identity' };
  return { type, group: 'source' };
};
const getRecordColumns = (db: any) => {
  try {
    return normalizedRows(db.prepare('PRAGMA table_info(records)').all()).map((row: any) => ({
      key: String(row.name || ''),
      dbType: String(row.type || ''),
    })).filter((row) => row.key);
  } catch {
    return [];
  }
};
const buildSteps = (config: any) => [
  {
    id: 'source',
    kind: 'source',
    description: String(config?.source?.description || 'Source records'),
    tool_server: sourceToolServer(config) || null,
  },
  ...flattenPipelineSteps(config).map((step: any) => ({
    id: String(step.id || ''),
    kind: String(step.kind || ''),
    description: String(step.description || step.condition || step.type || ''),
    condition_summary: conditionSummary(step),
    tool_server: step?.tool?.server || null,
    model: step?.model || null,
    outputs: step?.outputs || {},
  })),
  {
    id: 'score',
    kind: 'score',
    description: 'Score and prioritize records',
    criteria: configuredCriteria(config),
    minimum: Number(config?.score?.minimum ?? 0),
  },
];

const territoryCountsById = (db: any, realColumns: Set<string>) => {
  if (!tableExists(db, 'lead_territories')) return new Map();
  const rows = normalizedRows(db.prepare(`
    SELECT lt.territory_id,
      COUNT(*) AS lead_count,
      SUM(CASE WHEN ${leadStatusCaseSql({ alias: 'r', availableColumns: realColumns })} = 'qualified' THEN 1 ELSE 0 END) AS qualified_count
    FROM lead_territories lt
    JOIN records r ON r._row_id = lt.row_id
    GROUP BY lt.territory_id
  `).all());
  return new Map(rows.map((row: any) => [String(row.territory_id || ''), {
    lead_count: Number(row.lead_count || 0),
    qualified_count: Number(row.qualified_count || 0),
  }]));
};

const buildTerritories = ({ config, db, realColumns }: { config: any; db: any; realColumns: Set<string> }) => {
  const counts = territoryCountsById(db, realColumns);
  return (Array.isArray(config?.territories) ? config.territories : []).map((territory: any) => {
    const id = String(territory.id || '');
    const count = counts.get(id) || { lead_count: 0, qualified_count: 0 };
    return {
      id,
      name: String(territory.name || ''),
      description: String(territory.description || ''),
      color: String(territory.color || ''),
      polygon: (Array.isArray(territory.polygon) ? territory.polygon : []).map((point: any) => ({
        lat: Number(point.lat),
        lng: Number(point.lng),
      })),
      lead_count: count.lead_count,
      qualified_count: count.qualified_count,
    };
  });
};

export const getTerritories = (listDir: string) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    const { config } = readConfig(listDir);
    const realColumns = new Set(getRecordColumns(db).map((column) => column.key));
    return buildTerritories({ config, db, realColumns });
  } finally {
    db.close();
  }
};

export const getTerritoryNotesForViz = (listDir: string, territoryId: string) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    if (!tableExists(db, 'territory_notes')) return [];
    return getTerritoryNotes({ db, territoryId });
  } finally {
    db.close();
  }
};

export const insertTerritoryNoteForViz = (listDir: string, territoryId: string, body: string, createdBy = '') => {
  const db = openListDb({ listDir, readonly: false });
  try {
    return insertTerritoryNote({ db, territoryId, body, createdBy });
  } finally {
    db.close();
  }
};

// Numeric sort candidates for a review queue: numeric record columns plus step
// outputs declared as numbers. Dynamically added columns are TEXT, so the queue
// sort casts values rather than trusting the column affinity.
const numericRecordFields = (columns: Array<{ key: string; dbType: string }>, config: any) => {
  const declared = new Set(flattenPipelineSteps(config).flatMap((step: any) => outputEntries(step)
    .filter(([, spec]: any) => ['number', 'integer'].includes(String(spec?.type || '').toLowerCase()))
    .map(([field]) => String(field))));
  return columns
    .filter((column) => column.key !== '_row_id' && !BOOLEAN_COLUMNS.has(column.key) && !INTERNAL_RECORD_FIELDS.has(column.key))
    .filter((column) => NUMERIC_COLUMNS.has(column.key) || /REAL|INT|NUM/i.test(column.dbType) || declared.has(column.key))
    .map((column) => column.key);
};

const REVIEW_QUEUE_PAGE_MAX = 500;
const REVIEW_VERDICTS: Record<string, 'pass' | 'drop'> = { approve: 'pass', pass: 'pass', reject: 'drop', drop: 'drop' };

// on_event review steps run once per event turn. Their state lives in
// event_turn_steps and the CLI decides them there (completing the turn on a
// reject), not with an override. The viewer has no queue with the in-play and
// latest-turn semantics those decisions need, so it refuses them outright
// rather than writing an override that means something else. A bare step id is
// refused too: the CLI routes it to the event-turn path.
const eventTurnReviewSteps = (config: any) => [...new Map(
  [...(Array.isArray(config?.pipeline) ? config.pipeline : []), ...flattenPipelineSteps(config)]
    .filter((block: any) => isPlainObject(block) && textOf(block.kind) === ON_EVENT_KIND)
    .flatMap((block: any) => (Array.isArray(block.steps) ? block.steps : [])
      .filter((step: any) => isPlainObject(step) && textOf(step.kind) === 'review' && textOf(step.id))
      .map((step: any) => ({ blockId: textOf(block.id), stepId: textOf(step.id), nodeId: `${textOf(block.id)}.${textOf(step.id)}` })))
    .map((step: { blockId: string; stepId: string; nodeId: string }) => [step.nodeId, step] as const),
).values()];

const refuseEventTurnReviewStage = (config: any, stageId: string) => {
  const id = textOf(stageId);
  const step = eventTurnReviewSteps(config).find((candidate) => candidate.nodeId === id || candidate.stepId === id);
  if (!step) return;
  throw new AgentOutboundError({
    code: 'INVALID_ARGUMENT',
    message: `Review step "${step.stepId}" runs inside the on_event block "${step.blockId}", once per event turn. The viewer does not list, decide, or undo event-turn reviews; use \`agent-outbound review list|approve|reject|clear <list> --stage ${step.stepId}\`.`,
    retryable: false,
  });
};

// One page of a review queue in one SQL statement: membership is the exported
// awaitingReviewWhere predicate (the one getReviewQueue and the CLI use), and
// ordering, the total, and paging happen in the same query. With `around`, the
// page returned is the one holding that record, so the panel can open any
// record in the queue and move across page boundaries.
export const reviewQueuePageForViz = ({
  db,
  config,
  stageId,
  limit = 100,
  offset = 0,
  sort = '',
  dir = '',
  around = '',
}: {
  db: any;
  config: any;
  stageId: string;
  limit?: number;
  offset?: number;
  sort?: string;
  dir?: string;
  around?: string;
}) => {
  refuseEventTurnReviewStage(config, stageId);
  const stage = requireResolvedReviewStage({ db, config, stageId });
  const direction = textOf(dir || 'asc').toLowerCase();
  if (direction !== 'asc' && direction !== 'desc') {
    throw new AgentOutboundError({ code: 'INVALID_ARGUMENT', message: 'Review sort direction must be "asc" or "desc".', retryable: false });
  }
  const pageLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(REVIEW_QUEUE_PAGE_MAX, Math.floor(Number(limit)))) : 100;
  const requestedOffset = Number.isFinite(Number(offset)) ? Math.max(0, Math.floor(Number(offset))) : 0;
  const columns = getRecordColumns(db);
  const realColumns = new Set(columns.map((column) => column.key));
  const numericSortFields = numericRecordFields(columns, config);
  const requestedSort = textOf(sort);
  const numeric = Boolean(requestedSort) && numericSortFields.includes(requestedSort);
  if (requestedSort && !numeric && requestedSort !== '_row_id' && !stage.fields.includes(requestedSort)) {
    throw new AgentOutboundError({ code: 'INVALID_ARGUMENT', message: `Unknown review sort field "${requestedSort}".`, retryable: false });
  }
  const column = `record.${quoteIdent(requestedSort)}`;
  // Numeric sorts cast (dynamic columns are TEXT) and put empty values last.
  const orderBy = !requestedSort
    ? 'awaiting.parked_at ASC, record._row_id ASC'
    : numeric
      ? `CASE WHEN ${column} IS NULL OR TRIM(CAST(${column} AS TEXT)) = '' THEN 1 ELSE 0 END ASC, CAST(${column} AS REAL) ${direction.toUpperCase()}, record._row_id ASC`
      : `${column} ${direction.toUpperCase()}, record._row_id ASC`;
  const awaiting = `awaiting AS (
    SELECT event.record_id, MAX(event.occurred_at) AS parked_at
    FROM pipeline_events event
    JOIN records record ON record._row_id = event.record_id
    WHERE ${awaitingReviewWhere()}
    GROUP BY event.record_id
  )`;
  const fields = [...new Set(['_row_id', ...stage.fields, stage.title_field || '', requestedSort])]
    .filter((field) => field && realColumns.has(field));
  const anchor = textOf(around);
  // One read transaction, so the anchor position and the page share a snapshot.
  return db.transaction(() => {
    const anchorRow = anchor ? db.prepare(`
      WITH ${awaiting},
      ordered AS (
        SELECT record._row_id AS row_id, ROW_NUMBER() OVER (ORDER BY ${orderBy}) - 1 AS position
        FROM awaiting
        JOIN records record ON record._row_id = awaiting.record_id
      )
      SELECT position FROM ordered WHERE row_id = ?
    `).get(stage.id, anchor) : undefined;
    const aroundPosition = anchorRow ? Number(anchorRow.position) : null;
    const pageOffset = aroundPosition === null ? requestedOffset : Math.floor(aroundPosition / pageLimit) * pageLimit;
    const rows = normalizedRows(db.prepare(`
      WITH ${awaiting}
      SELECT ${fields.map((field) => `record.${quoteIdent(field)}`).join(', ')}, COUNT(*) OVER () AS __queue_total
      FROM awaiting
      JOIN records record ON record._row_id = awaiting.record_id
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(stage.id, pageLimit, pageOffset));
    const total = rows.length > 0 ? Number(rows[0].__queue_total || 0) : countAwaitingReviewAtStage({ db, stageId: stage.id });
    return {
      stage: { ...stage, awaiting_count: total, sequence_counts: countAwaitingReviewBySequence({ db, stageId: stage.id }) },
      total,
      limit: pageLimit,
      offset: pageOffset,
      records: rows.map(({ __queue_total, ...row }: any) => row),
      ...(anchor ? { around: anchor, around_position: aroundPosition } : {}),
      numeric_sort_fields: numericSortFields,
    };
  })();
};

export const getReviewQueueForViz = (
  listDir: string,
  stageId: string,
  limit = 100,
  offset = 0,
  sort = '',
  dir = '',
  around = '',
) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    const { config } = readConfig(listDir);
    return reviewQueuePageForViz({ db, config, stageId, limit, offset, sort, dir, around });
  } finally {
    db.close();
  }
};

export const getAllReviewQueueForViz = (
  listDir: string,
  limit = 100,
  offset = 0,
  sort = '',
  dir = '',
) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    const { config } = readConfig(listDir);
    return getAllReviewQueue({ db, config, limit, offset, sort, dir });
  } finally {
    db.close();
  }
};

const reviewEditsInput = (raw: unknown): Record<string, string> => {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) {
    throw new AgentOutboundError({ code: 'INVALID_ARGUMENT', message: 'Review edits must be an object of field: value.', retryable: false });
  }
  return Object.fromEntries(Object.entries(raw).map(([field, value]) => [field, String(value ?? '')]));
};

// Decisions run through the CLI's own commands (`review approve` / `review
// reject`), so every stage kind behaves as it does there: edit validation, the
// audit entry, the override, and reconciliation. The viewer adds two
// preconditions: the stage is not an event-turn review, and the record is
// awaiting this stage now, so a stale screen can never pre-approve a record
// that has not reached the gate.
export const applyReviewDecisionsForViz = (listDir: string, stageId: string, decisions: unknown) => {
  if (!Array.isArray(decisions)) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: 'Review decisions body must contain a decisions array.',
      retryable: false,
    });
  }
  if (decisions.length > 500) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: 'Review decision batches are capped at 500 rows.',
      retryable: false,
    });
  }
  const { config } = readConfig(listDir);
  refuseEventTurnReviewStage(config, stageId);
  const lookup = openListDb({ listDir, readonly: true });
  const stage = (() => {
    try {
      return requireResolvedReviewStage({ db: lookup, config, stageId });
    } finally {
      lookup.close();
    }
  })();
  const results = (decisions as ReviewDecision[]).map((input, index) => {
    const ref = String(input?.row_id || '');
    const requestedVerdict = String(input?.verdict || '').trim().toLowerCase();
    try {
      const verdict = REVIEW_VERDICTS[requestedVerdict];
      if (!verdict) {
        throw new AgentOutboundError({
          code: 'INVALID_ARGUMENT',
          message: `Unknown review verdict "${requestedVerdict}". Expected approve/pass or reject/drop.`,
          retryable: false,
        });
      }
      const edits = reviewEditsInput((input as any)?.edits);
      if (verdict === 'drop' && Object.keys(edits).length > 0) {
        throw new AgentOutboundError({
          code: 'INVALID_ARGUMENT',
          message: 'Edits apply only to an approval; a reject records none (as with `review reject`).',
          retryable: false,
        });
      }
      const check = openListDb({ listDir, readonly: true });
      try {
        if (!isRecordAwaitingReview({ db: check, recordId: ref, stageId: stage.id })) {
          throw new AgentOutboundError({
            code: 'INVALID_ARGUMENT',
            message: `Record "${ref}" is not awaiting review at "${stage.id}".`,
            retryable: false,
          });
        }
      } finally {
        check.close();
      }
      const reason = String(input?.reason || '');
      const outcome: any = verdict === 'pass'
        ? reviewPassCommand({ list: listDir, ref, stage: stage.id, reason, edits })
        : reviewDropCommand({ list: listDir, ref, stage: stage.id, reason });
      return {
        ok: true,
        index,
        row_id: String(outcome.row_id || ''),
        verdict: outcome.verdict,
        override_id: String(outcome.override_id || ''),
        record: outcome.record,
        state: outcome.state,
      };
    } catch (error) {
      return {
        ok: false,
        index,
        row_id: ref,
        verdict: requestedVerdict,
        error: String((error as Error)?.message || error),
      };
    }
  });
  return {
    stage,
    requested: decisions.length,
    applied: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
};

// Undo is the CLI's `review clear` for the stage and record the history entry
// names.
export const clearReviewDecisionForViz = (listDir: string, rowId: string, stageId: string) => {
  const { config } = readConfig(listDir);
  refuseEventTurnReviewStage(config, stageId);
  return reviewClearCommand({ list: listDir, ref: rowId, stage: stageId });
};

// --- Pipeline canvas ---------------------------------------------------------
//
// Node counts describe each record's current state at a step. pipeline_events
// keeps history, so a record's state is its latest *outcome* row for the step;
// see docs/technical/viewer.md for the classification of every reason.

const SOURCE_NODE_ID = 'source';
const ON_EVENT_KIND = 'on_event';
const PER_EVENT_GROUP_LABEL = 'per event';
// The table view's live-run rule (App.tsx `runActive`): a `running` row whose
// heartbeat is older than this belongs to a process that is gone.
const LIVE_RUN_MAX_AGE_MS = 8000;

// Rows dataflow.ts writes for every step a run did not attempt
// (notAttemptedReason / onStepNotAttempted, the deferred-generate marker, and the
// legacy upstream_skipped marker). They say why a run passed the step by; they
// never replace the outcome the record already has there.
const NOT_ATTEMPTED_REASONS = [
  'skipped:record_dropped',
  'skipped:already_resolved',
  'skipped:pending',
  'skipped:not_applicable',
  'skipped:not_time_ready',
  'skipped:not_scheduled',
  'skipped:deferred_generate',
];
const NOT_ATTEMPTED_PREFIXES = [
  'skipped:upstream_errored:',
  'skipped:unresolved_dependencies:',
  'skipped:unsupported_step_kind:',
  'skipped:upstream_skipped:',
];
const UPSTREAM_ERRORED_PREFIX = 'skipped:upstream_errored:';
// passed = 1 rows whose reason starts with `skipped:` but are not the `when`
// predicate: a fresh cache hit or a provider that answered without a verdict
// (the step ran), and enrichment budget ceilings (the step did not run).
const RAN_SKIP_REASONS = ['skipped:fresh'];
const RAN_SKIP_PREFIXES = ['skipped:provider_no_opinion:'];
const BUDGET_SKIP_REASONS = [
  'skipped:enrichment_ceiling',
  'skipped:enrichment_budget_not_configured',
  'skipped:enrichment_budget_tier_not_configured',
];
// manual.ts closes a park that stopped applying with skipped:not_applicable[:…];
// work-item-applicability.ts marks the `when` case as when_not_matched.
const PARK_CLOSED_REASON = 'skipped:not_applicable';
const PARK_CLOSED_WHEN_PREFIX = 'skipped:not_applicable:when_not_matched';
const WAITING_REASONS = [
  'awaiting_review',
  'awaiting_manual',
  'awaiting_external_event',
  'wake_at',
  'Awaiting author step approval.',
];
const PIPELINE_STEP_STATES = ['waiting', 'deferred', 'passed', 'dropped', 'skipped_when', 'skipped_other', 'failed', 'blocked_by_error', 'errored'] as const;
type PipelineStepState = typeof PIPELINE_STEP_STATES[number];

// Cost rows carry the writer's namespace (`pipeline_enrich:<step>`, …); see the
// recordCostEvent callers. Sourcing spend belongs to the source node.
const COST_STEP_PREFIXES = ['pipeline_enrich:', 'pipeline_filter_batch:', 'pipeline_filter:', 'pipeline:compose:', 'enrich:', 'generate:'];
const SOURCING_COST_PREFIX = 'sourcing:';
// on_event turn steps execute as `<block>:<turn_index>:<step>`.
const TURN_SCOPED_STEP_ID = /^(.+):\d+:([^:]+)$/;

const WHEN_OPERATOR_TEXT: Record<string, string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  in: 'in',
  not_in: 'not in',
  contains: 'contains',
  matches: 'matches',
  not_matches: 'not matches',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
};

type PipelineCounts = Record<PipelineStepState, number> & { awaiting_review: number };

type PipelineGroup = { id: string; label: string; parent_id: string };

type PipelineStepDefinition = {
  id: string;
  localId: string;
  step: any;
  explicit: string[];
  inferred: string[];
  group?: PipelineGroup;
};

const textOf = (value: unknown) => String(value ?? '').trim();
const stringsOf = (value: unknown) => (Array.isArray(value) ? value.map(textOf).filter(Boolean) : []);
const isPlainObject = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;
const sqlList = (values: string[]) => values.map(sqlString).join(', ');
const globPrefix = (column: string, prefix: string) => `${column} GLOB ${sqlString(`${prefix}*`)}`;
const emptyPipelineCounts = (): PipelineCounts => ({
  waiting: 0,
  deferred: 0,
  passed: 0,
  dropped: 0,
  skipped_when: 0,
  skipped_other: 0,
  failed: 0,
  blocked_by_error: 0,
  errored: 0,
  awaiting_review: 0,
});

const whenConditionValue = (condition: any) => {
  const valueField = textOf(condition?.value_field);
  if (valueField) return `field ${valueField}`;
  const valueFile = textOf(condition?.value_file);
  if (valueFile) return `values in ${valueFile}`;
  if (condition?.value === '') return '""';
  return formatConditionValue(condition?.value);
};

const summarizeWhenPredicate = (predicate: any) => {
  const conditions = Array.isArray(predicate?.conditions) ? predicate.conditions : [];
  const joiner = textOf(predicate?.match).toLowerCase() === 'any' ? ' or ' : ' and ';
  return conditions.map((condition: any) => {
    const field = textOf(condition?.field);
    const rawOperator = textOf(condition?.operator);
    const operator = WHEN_OPERATOR_TEXT[rawOperator] || rawOperator.replaceAll('_', ' ');
    if (rawOperator === 'is_empty' || rawOperator === 'is_not_empty') return `${field} ${operator}`.trim();
    return [field, operator, whenConditionValue(condition)].filter(Boolean).join(' ');
  }).filter(Boolean).join(joiner);
};

const pipelineWhen = (step: any) => {
  const predicate = whenPredicateForStep({ step, stepConfig: stepConfigForWhen(step) });
  const summary = predicate ? summarizeWhenPredicate(predicate) : '';
  return summary ? { summary } : undefined;
};

const pipelineToolOrModel = (step: any) => {
  const config = isPlainObject(step?.config) ? { ...step, ...step.config } : step;
  if (textOf(config?.model)) return textOf(config.model);
  const tool = isPlainObject(config?.tool) ? config.tool : {};
  const tools = stringsOf(tool.tools).length > 0 ? stringsOf(tool.tools) : stringsOf([tool.tool]);
  return [textOf(tool.server), tools.join(', ')].filter(Boolean).join(' · ') || undefined;
};

const pipelineStepOutputs = (step: any) => {
  const config = isPlainObject(step?.config) ? step.config : step;
  return [...new Set([
    ...Object.keys(isPlainObject(config?.outputs) ? config.outputs : {}),
    ...getTargetColumnsForStepConfig(config).map((column: any) => String(column?.name || '')),
  ])].filter(Boolean);
};

const turnStepDefinitions = (block: any, blockExplicit: string[], blockInferred: string[]): PipelineStepDefinition[] => {
  const blockId = textOf(block?.id);
  const children = (Array.isArray(block?.steps) ? block.steps : []).filter((child: unknown) => isPlainObject(child) && textOf(child.id));
  const localIds = new Set(children.map((child: any) => textOf(child.id)));
  const scoped = (localId: string) => `${blockId}.${localId}`;
  const group = { id: blockId, label: PER_EVENT_GROUP_LABEL, parent_id: blockExplicit[0] || blockInferred[0] || SOURCE_NODE_ID };
  return children.map((child: any) => {
    const declared = [...new Set([...stringsOf(child.depends_on), ...stringsOf(child.runs_after)])]
      .map((dependency) => (localIds.has(dependency) ? scoped(dependency) : dependency));
    // A turn's first steps hang off the step that opens the turn.
    return {
      id: scoped(textOf(child.id)),
      localId: textOf(child.id),
      step: child,
      explicit: declared.length > 0 ? declared : blockExplicit,
      inferred: declared.length > 0 ? [] : blockInferred,
      group,
    };
  });
};

const pipelineStepDefinitions = (config: any, listDir: string): PipelineStepDefinition[] => {
  const inferred = inferPipelineEdges(config, { listDir });
  return flattenPipelineSteps(config).flatMap((step: any) => {
    const id = textOf(step?.id);
    if (!id) return [];
    const explicit = [...new Set([...stringsOf(step.depends_on), ...stringsOf(step.runs_after)])];
    const inferredDependencies = [...(inferred.get(id) || [])].map(String).filter((dependency) => !explicit.includes(dependency));
    if (textOf(step.kind) === ON_EVENT_KIND) return turnStepDefinitions(step, explicit, inferredDependencies);
    return [{
      id,
      localId: textOf(step[SUBPIPELINE_LOCAL_ID_FIELD]) || id,
      step,
      explicit,
      inferred: inferredDependencies,
    }];
  });
};

const pipelineEdges = (definitions: PipelineStepDefinition[]) => {
  const ids = new Set(definitions.map((definition) => definition.id));
  // A dependency on an on_event block means "after its turn": its sink steps.
  const groupSinks = new Map<string, string[]>();
  definitions.filter((definition) => definition.group).forEach((definition) => {
    const groupId = definition.group!.id;
    const members = definitions.filter((candidate) => candidate.group?.id === groupId);
    const sinks = members.filter((member) => !members.some((other) => other.explicit.includes(member.id))).map((member) => member.id);
    groupSinks.set(groupId, sinks);
  });
  const sourcesFor = (dependency: string) => (ids.has(dependency) ? [dependency] : groupSinks.get(dependency) || []);
  const seen = new Set<string>();
  const edges = definitions.flatMap((definition) => (
    [
      ...definition.explicit.map((dependency) => ({ dependency, origin: 'explicit' as const })),
      ...definition.inferred.map((dependency) => ({ dependency, origin: 'inferred' as const })),
    ].flatMap(({ dependency, origin }) => sourcesFor(dependency).map((from) => ({ from, to: definition.id, origin })))
  )).filter((edge) => {
    const key = `${edge.from}->${edge.to}`;
    if (edge.from === edge.to || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const targets = new Set(edges.map((edge) => edge.to));
  const all = [
    ...definitions
      .filter((definition) => !targets.has(definition.id))
      .map((definition) => ({ from: SOURCE_NODE_ID, to: definition.id, origin: 'source' as const })),
    ...edges,
  ];
  // Inferred dependencies mostly restate an ordering the explicit graph already
  // guarantees. Mark an inferred edge `implied` when its target is reachable
  // from its source through other edges, so the canvas can leave it undrawn.
  const successors = new Map<string, string[]>();
  all.forEach((edge) => successors.set(edge.from, [...(successors.get(edge.from) || []), edge.to]));
  const reachable = new Map<string, Set<string>>();
  const reach = (id: string, visiting = new Set<string>()): Set<string> => {
    const cached = reachable.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return new Set();
    visiting.add(id);
    const found = new Set<string>();
    (successors.get(id) || []).forEach((next) => {
      found.add(next);
      reach(next, visiting).forEach((descendant) => found.add(descendant));
    });
    visiting.delete(id);
    reachable.set(id, found);
    return found;
  };
  return all.map((edge) => (
    edge.origin === 'inferred'
      && (successors.get(edge.from) || []).some((next) => next !== edge.to && reach(next).has(edge.to))
      ? { ...edge, implied: true }
      : edge
  ));
};

const inPlayRecordSql = () => `(${inPlayWhere('record')} AND COALESCE(record.sequence_status, '') != 'opted_out')`;

// Dropped at this step: the gate that disqualified the record, or a review
// rejection (reconcileOverrides drops it under OVERRIDE_GATE, attributed through
// the override's `review:<step>` author).
const droppedAtStepSql = (stepExpression: string) => `(
  COALESCE(record.disqualified_at, '') <> ''
  AND (
    record.disqualified_gate = ${stepExpression}
    OR (
      record.disqualified_gate = ${sqlString(OVERRIDE_GATE)}
      AND EXISTS (
        SELECT 1 FROM overrides verdict
        WHERE verdict.record_id = record._row_id
          AND verdict.kind = 'drop'
          AND verdict.step_id = ''
          AND COALESCE(verdict.cleared_at, '') = ''
          AND verdict.created_by = 'review:' || ${stepExpression}
      )
    )
  )
)`;

// State of a passed = 1 row (pipeline_events) or a `skipped` turn step.
const passedStateSql = ({ reason, kind, sideEffecting }: { reason: string; kind: string; sideEffecting: string }) => `CASE
  WHEN ${reason} NOT GLOB 'skipped:*' THEN 'passed'
  WHEN ${reason} IN (${sqlList(RAN_SKIP_REASONS)}) OR ${RAN_SKIP_PREFIXES.map((prefix) => globPrefix(reason, prefix)).join(' OR ')} THEN 'passed'
  WHEN ${reason} IN (${sqlList(BUDGET_SKIP_REASONS)}) THEN 'skipped_other'
  WHEN ${globPrefix(reason, PARK_CLOSED_WHEN_PREFIX)} THEN 'skipped_when'
  WHEN ${reason} = ${sqlString(PARK_CLOSED_REASON)} OR ${globPrefix(reason, `${PARK_CLOSED_REASON}:`)} THEN 'skipped_other'
  WHEN ${kind} = 'manual_task' AND ${sideEffecting} = 1 THEN 'skipped_other'
  ELSE 'skipped_when'
END`;

const waitingReasonSql = (reason: string) => `(
  ${reason} IN (${sqlList(WAITING_REASONS)})
  OR ${globPrefix(reason, 'wake_at:')}
  OR lower(${reason}) LIKE '%pending approval%'
  OR lower(${reason}) LIKE '%approval required%'
)`;

// One row per (record, step) the record has history at, with its state there.
// Unscoped, both placeholders are bound to null and match every step.
const stepStateSql = (db: any, scoped: boolean) => {
  const notAttempted = `(event.passed = 0 AND (
    COALESCE(event.reason, '') IN (${sqlList(NOT_ATTEMPTED_REASONS)})
    OR ${NOT_ATTEMPTED_PREFIXES.map((prefix) => globPrefix('event.reason', prefix)).join(' OR ')}
  ))`;
  const errors = tableExists(db, 'errored_events')
    ? `SELECT record_id, step_id, MAX(occurred_at) AS errored_at FROM errored_events ${scoped ? 'WHERE step_id = ?' : 'WHERE ? IS NULL'} GROUP BY record_id, step_id`
    : `SELECT NULL AS record_id, NULL AS step_id, NULL AS errored_at WHERE ? IS NULL AND 0`;
  const keptAtReview = `EXISTS (
    SELECT 1 FROM overrides verdict
    WHERE verdict.record_id = keyed.record_id
      AND verdict.kind = 'keep'
      AND COALESCE(verdict.cleared_at, '') = ''
      AND (verdict.step_id = keyed.step_id OR verdict.step_id = '')
  )`;
  return `
    WITH ranked AS (
      SELECT
        event.record_id,
        event.step_id,
        event.kind,
        event.passed,
        COALESCE(event.reason, '') AS reason,
        COALESCE(event.side_effecting, 0) AS side_effecting,
        event.occurred_at,
        ${notAttempted} AS not_attempted,
        ROW_NUMBER() OVER (
          PARTITION BY event.record_id, event.step_id
          ORDER BY ${notAttempted} ASC, event.occurred_at DESC, event.rowid DESC
        ) AS position
      FROM pipeline_events event
      ${scoped ? 'WHERE event.step_id = ?' : 'WHERE ? IS NULL'}
    ),
    latest AS (SELECT * FROM ranked WHERE position = 1),
    errors AS (${errors}),
    keyed AS (
      SELECT latest.record_id, latest.step_id, latest.kind, latest.passed, latest.reason,
        latest.side_effecting, latest.occurred_at, latest.not_attempted, errors.errored_at
      FROM latest
      LEFT JOIN errors ON errors.record_id = latest.record_id AND errors.step_id = latest.step_id
      UNION ALL
      SELECT errors.record_id, errors.step_id, NULL, NULL, '', 0, NULL, NULL, errors.errored_at
      FROM errors
      WHERE NOT EXISTS (
        SELECT 1 FROM pipeline_events seen
        WHERE seen.record_id = errors.record_id AND seen.step_id = errors.step_id
      )
    )
    SELECT
      keyed.record_id,
      keyed.step_id,
      keyed.reason,
      MAX(COALESCE(keyed.occurred_at, ''), COALESCE(keyed.errored_at, '')) AS state_at,
      CASE
        WHEN ${droppedAtStepSql('keyed.step_id')} THEN 'dropped'
        WHEN keyed.passed = 0 AND ${globPrefix('keyed.reason', 'deferred:')} THEN 'deferred'
        WHEN keyed.errored_at IS NOT NULL
          AND (keyed.occurred_at IS NULL OR keyed.not_attempted = 1 OR keyed.errored_at >= keyed.occurred_at)
          THEN CASE WHEN ${inPlayRecordSql()} THEN 'errored' ELSE 'left' END
        WHEN keyed.not_attempted = 1
          THEN CASE WHEN ${globPrefix('keyed.reason', UPSTREAM_ERRORED_PREFIX)} AND ${inPlayRecordSql()} THEN 'blocked_by_error' ELSE 'not_reached' END
        WHEN keyed.passed = 1
          THEN ${passedStateSql({ reason: 'keyed.reason', kind: 'keyed.kind', sideEffecting: 'keyed.side_effecting' })}
        WHEN ${waitingReasonSql('keyed.reason')} THEN CASE
          WHEN keyed.kind = 'review' AND ${keptAtReview} THEN 'passed'
          WHEN ${inPlayRecordSql()} THEN 'waiting'
          ELSE 'left'
        END
        ELSE 'failed'
      END AS state
    FROM keyed
    JOIN records record ON record._row_id = keyed.record_id
  `;
};

// stepStateSql always has two placeholders (events, errors); null means every step.
const stepStateParams = (stepId: string | null) => [stepId, stepId];

// on_event turn steps live in event_turn_steps, one row per turn; a record's
// state is its latest turn's row. Scoped by `?` = node id (`<block>.<step>`).
const turnStepStateSql = (scoped: boolean) => `
  WITH latest_turn AS (
    SELECT turn.turn_id, turn.record_id, turn.block_id,
      ROW_NUMBER() OVER (PARTITION BY turn.record_id, turn.block_id ORDER BY turn.turn_index DESC) AS position
    FROM event_turns turn
    WHERE turn.status <> 'ignored'
  ),
  turn_steps AS (
    SELECT latest_turn.record_id, latest_turn.block_id || '.' || step.step_id AS step_id,
      step.kind, step.status, COALESCE(step.reason, '') AS reason, step.occurred_at
    FROM latest_turn
    JOIN event_turn_steps step ON step.turn_id = latest_turn.turn_id
    WHERE latest_turn.position = 1
  )
  SELECT turn_steps.record_id, turn_steps.step_id, turn_steps.reason, turn_steps.occurred_at AS state_at,
    CASE turn_steps.status
      WHEN 'passed' THEN 'passed'
      WHEN 'skipped' THEN CASE
        WHEN turn_steps.reason GLOB 'skipped:*'
          THEN ${passedStateSql({ reason: 'turn_steps.reason', kind: 'turn_steps.kind', sideEffecting: '0' })}
        ELSE 'skipped_other'
      END
      WHEN 'errored' THEN CASE WHEN ${inPlayRecordSql()} THEN 'errored' ELSE 'left' END
      WHEN 'awaiting_review' THEN CASE WHEN ${inPlayRecordSql()} THEN 'waiting' ELSE 'left' END
      WHEN 'parked' THEN CASE WHEN ${inPlayRecordSql()} THEN 'waiting' ELSE 'left' END
      ELSE 'failed'
    END AS state
  FROM turn_steps
  JOIN records record ON record._row_id = turn_steps.record_id
  ${scoped ? 'WHERE turn_steps.step_id = ?' : ''}
`;

const hasTurnTables = (db: any) => tableExists(db, 'event_turns') && tableExists(db, 'event_turn_steps');

const droppedCountsByStep = (db: any) => normalizedRows(db.prepare(`
  SELECT step_id, COUNT(DISTINCT record_id) AS dropped
  FROM (
    SELECT disqualified_gate AS step_id, _row_id AS record_id
    FROM records
    WHERE COALESCE(disqualified_at, '') <> ''
      AND COALESCE(disqualified_gate, '') NOT IN ('', ${sqlString(OVERRIDE_GATE)})
    UNION ALL
    SELECT substr(verdict.created_by, ${'review:'.length + 1}) AS step_id, record._row_id AS record_id
    FROM records record
    JOIN overrides verdict ON verdict.record_id = record._row_id
    WHERE COALESCE(record.disqualified_at, '') <> ''
      AND record.disqualified_gate = ${sqlString(OVERRIDE_GATE)}
      AND verdict.kind = 'drop'
      AND verdict.step_id = ''
      AND COALESCE(verdict.cleared_at, '') = ''
      AND verdict.created_by GLOB 'review:*'
  )
  GROUP BY step_id
`).all());

const pipelineStepCounts = (db: any) => {
  const byStep = new Map<string, PipelineCounts>();
  const add = (stepId: string, state: string, count: number) => {
    if (!(PIPELINE_STEP_STATES as readonly string[]).includes(state)) return;
    const counts = byStep.get(stepId) || emptyPipelineCounts();
    counts[state as PipelineStepState] += count;
    byStep.set(stepId, counts);
  };
  if (tableExists(db, 'pipeline_events')) {
    normalizedRows(db.prepare(`
      SELECT step_id, state, COUNT(*) AS count FROM (${stepStateSql(db, false)})
      WHERE state <> 'dropped'
      GROUP BY step_id, state
    `).all(...stepStateParams(null))).forEach((row: any) => add(String(row.step_id), String(row.state), Number(row.count || 0)));
  }
  if (hasTurnTables(db)) {
    normalizedRows(db.prepare(`
      SELECT step_id, state, COUNT(*) AS count FROM (${turnStepStateSql(false)}) GROUP BY step_id, state
    `).all()).forEach((row: any) => add(String(row.step_id), String(row.state), Number(row.count || 0)));
  }
  droppedCountsByStep(db).forEach((row: any) => add(String(row.step_id), 'dropped', Number(row.dropped || 0)));
  return byStep;
};

// Every configured review stage with its queue count, from one grouped query
// over the queue's own predicate (awaitingReviewWhere), so each count equals
// GET /api/review/:stageId `total`.
const resolvedReviewStagesWithCounts = (db: any, config: any) => {
  const columns = new Set(getRecordColumns(db).map((column) => column.key));
  const stages = configuredReviewStages(config).map((stage) => ({
    ...stage,
    fields: [...new Set(stage.fields)].filter((field) => columns.has(field)),
  }));
  const counts = new Map<string, number>();
  if (stages.length > 0 && tableExists(db, 'pipeline_events')) {
    normalizedRows(db.prepare(`
      SELECT event.step_id AS stage_id, COUNT(DISTINCT event.record_id) AS awaiting
      FROM pipeline_events event
      JOIN records record ON record._row_id = event.record_id
      WHERE ${awaitingReviewWhere(`event.step_id IN (${stages.map(() => '?').join(', ')})`)}
      GROUP BY event.step_id
    `).all(...stages.map((stage) => stage.id))).forEach((row: any) => counts.set(String(row.stage_id), Number(row.awaiting || 0)));
  }
  return new Map(stages.map((stage) => [stage.id, { ...stage, awaiting_count: counts.get(stage.id) || 0 }]));
};

const costNodeId = (raw: string, nodeIds: Set<string>) => {
  if (raw.startsWith(SOURCING_COST_PREFIX)) return SOURCE_NODE_ID;
  const prefix = COST_STEP_PREFIXES.find((candidate) => raw.startsWith(candidate)) || '';
  const id = raw.slice(prefix.length);
  if (nodeIds.has(id)) return id;
  const turn = id.match(TURN_SCOPED_STEP_ID);
  return turn && nodeIds.has(`${turn[1]}.${turn[2]}`) ? `${turn[1]}.${turn[2]}` : '';
};

type PipelineSpend = { spend_usd: number | null; spend_calls: number; unpriced_calls: number };

const pipelineSpend = (db: any, nodeIds: Set<string>) => {
  const rows = tableExists(db, 'cost_events') ? normalizedRows(db.prepare(`
    SELECT step_id,
      SUM(usd_cost) AS spend_usd,
      COUNT(*) AS calls,
      SUM(CASE WHEN usd_cost IS NULL THEN 1 ELSE 0 END) AS unpriced
    FROM cost_events
    GROUP BY step_id
  `).all()) : [];
  const byNode = new Map<string, PipelineSpend>();
  // Cost rows no node claims (a removed step, an unknown writer). Unpriced ones
  // are listed too, so missing spend is visible rather than silently absent.
  const unattributed: Array<{ step_id: string; spend_usd: number | null; calls: number; unpriced_calls: number }> = [];
  rows.forEach((row: any) => {
    const raw = String(row.step_id || '');
    const priced = row.spend_usd === null || row.spend_usd === undefined ? null : Number(row.spend_usd);
    const nodeId = costNodeId(raw, nodeIds);
    if (!nodeId) {
      unattributed.push({ step_id: raw, spend_usd: priced, calls: Number(row.calls || 0), unpriced_calls: Number(row.unpriced || 0) });
      return;
    }
    const current = byNode.get(nodeId) || { spend_usd: null, spend_calls: 0, unpriced_calls: 0 };
    byNode.set(nodeId, {
      spend_usd: priced === null ? current.spend_usd : (current.spend_usd || 0) + priced,
      spend_calls: current.spend_calls + Number(row.calls || 0),
      unpriced_calls: current.unpriced_calls + Number(row.unpriced || 0),
    });
  });
  return {
    byNode,
    unattributed,
    unattributedUsd: unattributed.reduce((total, item) => total + (item.spend_usd || 0), 0),
    unattributedUnpriced: unattributed.reduce((total, item) => total + item.unpriced_calls, 0),
  };
};

const latestRunState = (db: any) => (
  tableExists(db, 'run_state') ? db.prepare('SELECT * FROM run_state ORDER BY updated_at DESC LIMIT 1').get() || null : null
);

const runAgeMs = (row: any) => {
  const updatedAtMs = Date.parse(String(row?.updated_at || ''));
  return Number.isFinite(updatedAtMs) ? Math.max(0, Date.now() - updatedAtMs) : null;
};

const liveActiveStep = (db: any, nodeIds: Set<string>) => {
  const run = latestRunState(db);
  if (!run || String(run.status || '') !== 'running') return '';
  const age = runAgeMs(run);
  if (age !== null && age >= LIVE_RUN_MAX_AGE_MS) return '';
  const stepId = textOf(run.active_step);
  return nodeIds.has(stepId) && stepId !== SOURCE_NODE_ID ? stepId : '';
};

const sourceStrategies = (config: any) => [
  ...(Array.isArray(config?.source?.strategies) ? config.source.strategies : []),
  ...(Array.isArray(config?.source?.searches) ? config.source.searches : []),
].filter(isPlainObject).map((strategy: any) => ({
  id: textOf(strategy.id),
  kind: textOf(strategy.kind),
  ...(pipelineToolOrModel(strategy) ? { tool_or_model: pipelineToolOrModel(strategy) } : {}),
})).filter((strategy) => strategy.id || strategy.kind);

const sourceNode = ({ db, config, spend }: { db: any; config: any; spend?: PipelineSpend }) => {
  const total = Number(db.prepare('SELECT COUNT(*) AS count FROM records').get()?.count || 0);
  const bySource = hasTableColumn(db, 'records', 'source')
    ? normalizedRows(db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(source), ''), 'unknown') AS source, COUNT(*) AS count
      FROM records GROUP BY 1 ORDER BY count DESC, source ASC
    `).all()).map((row: any) => ({ source: String(row.source), count: Number(row.count || 0) }))
    : [];
  const strategies = sourceStrategies(config);
  const tools = [...new Set(strategies.map((strategy) => strategy.tool_or_model).filter(Boolean))];
  return {
    id: SOURCE_NODE_ID,
    label: 'Source',
    description: textOf(config?.source?.description),
    kind: 'source',
    ...(tools.length > 0 ? { tool_or_model: tools.join(' + ') } : {}),
    inputs: [],
    outputs: [...sourceOutputKeys(config)],
    depends_on: [],
    inferred_depends_on: [],
    sources: strategies,
    source_counts: bySource,
    counts: { ...emptyPipelineCounts(), passed: total },
    spend_usd: spend?.spend_usd ?? null,
    spend_calls: spend?.spend_calls || 0,
    unpriced_calls: spend?.unpriced_calls || 0,
  };
};

export const getPipelineForViz = (listDir: string) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    const { config } = readConfig(listDir);
    const definitions = pipelineStepDefinitions(config, listDir);
    const nodeIds = new Set([SOURCE_NODE_ID, ...definitions.map((definition) => definition.id)]);
    const reviewStages = resolvedReviewStagesWithCounts(db, config);
    const counts = pipelineStepCounts(db);
    const spend = pipelineSpend(db, nodeIds);
    const stepNodes = definitions.map((definition) => {
      const { id, step } = definition;
      const kind = textOf(step.kind);
      const stage = definition.group ? undefined : reviewStages.get(id);
      const stepCounts = counts.get(id) || emptyPipelineCounts();
      // A review stage's waiting records ARE its queue: the same count the review
      // API and CLI report (the awaitingReviewWhere predicate).
      const reviewCounts = stage
        ? { waiting: Number(stage.awaiting_count || 0), awaiting_review: Number(stage.awaiting_count || 0) }
        : kind === 'review' ? { awaiting_review: stepCounts.waiting } : {};
      const stepSpend = spend.byNode.get(id);
      const toolOrModel = pipelineToolOrModel(step);
      const when = pipelineWhen(step);
      return {
        id,
        label: textOf(step.label) || definition.localId,
        description: textOf(step.description),
        kind,
        ...(toolOrModel ? { tool_or_model: toolOrModel } : {}),
        ...(when ? { when } : {}),
        inputs: declaredStageInputs(step),
        outputs: pipelineStepOutputs(step),
        depends_on: definition.explicit,
        inferred_depends_on: definition.inferred,
        ...(stage ? {
          review: {
            fields: stage.fields,
            edit_fields: stage.edit_fields,
            ...(stage.title_field ? { title_field: stage.title_field } : {}),
          },
        } : {}),
        ...(definition.group ? { group: definition.group } : {}),
        counts: { ...stepCounts, ...reviewCounts },
        spend_usd: stepSpend?.spend_usd ?? null,
        spend_calls: stepSpend?.spend_calls || 0,
        unpriced_calls: stepSpend?.unpriced_calls || 0,
      };
    });
    const groups = [...new Map(definitions.filter((definition) => definition.group).map((definition) => [definition.group!.id, definition.group!])).values()];
    return {
      nodes: [sourceNode({ db, config, spend: spend.byNode.get(SOURCE_NODE_ID) }), ...stepNodes],
      edges: pipelineEdges(definitions),
      groups,
      active_step: liveActiveStep(db, nodeIds),
      unattributed_spend_usd: spend.unattributedUsd,
      unattributed_spend: spend.unattributed,
      unattributed_unpriced_calls: spend.unattributedUnpriced,
    };
  } finally {
    db.close();
  }
};

const stepRecordSummary = (row: any) => Object.fromEntries(
  Object.entries(row || {}).filter(([key]) => !RAW_RECORD_FIELDS.has(key)),
);

const recordsInIdOrder = (db: any, ids: string[]) => {
  if (ids.length === 0) return [];
  const rows = normalizedRows(db.prepare('SELECT * FROM records WHERE _row_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)));
  const byId = new Map(rows.map((row: any) => [String(row._row_id), row]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
};

export const getPipelineStepRecordsForViz = (listDir: string, stepId: string, state: string, limit = 100, offset = 0) => {
  if (!(PIPELINE_STEP_STATES as readonly string[]).includes(state)) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: `Step record state must be one of: ${PIPELINE_STEP_STATES.join(', ')}.`,
      retryable: false,
    });
  }
  const pageLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const pageOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const db = openListDb({ listDir, readonly: true });
  try {
    const { config } = readConfig(listDir);
    const definitions = pipelineStepDefinitions(config, listDir);
    const definition = definitions.find((candidate) => candidate.id === stepId);
    if (!definition && stepId !== SOURCE_NODE_ID) {
      throw new AgentOutboundError({ code: 'NOT_FOUND', message: `Unknown pipeline step "${stepId}".`, retryable: false });
    }
    const page = (total: number, rows: any[]) => ({
      step_id: stepId,
      state,
      total,
      limit: pageLimit,
      offset: pageOffset,
      records: rows.map(stepRecordSummary),
    });
    if (stepId === SOURCE_NODE_ID) {
      if (state !== 'passed') return page(0, []);
      const total = Number(db.prepare('SELECT COUNT(*) AS count FROM records').get()?.count || 0);
      return page(total, normalizedRows(db.prepare('SELECT * FROM records ORDER BY _row_id ASC LIMIT ? OFFSET ?').all(pageLimit, pageOffset)));
    }
    const isReviewStage = !definition!.group && configuredReviewStages(config).some((stage) => stage.id === stepId);
    if (state === 'waiting' && isReviewStage) {
      const queue = reviewQueuePageForViz({ db, config, stageId: stepId, limit: pageLimit, offset: pageOffset });
      return page(queue.total, recordsInIdOrder(db, queue.records.map((row: any) => String(row._row_id))));
    }
    if (state === 'dropped') {
      const where = droppedAtStepSql('?');
      const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM records record WHERE ${where}`).get(stepId, stepId)?.count || 0);
      const rows = normalizedRows(db.prepare(`
        SELECT record.*, record.disqualify_reason AS __step_reason, record.disqualified_at AS __step_at
        FROM records record
        WHERE ${where}
        ORDER BY record.disqualified_at DESC, record._row_id ASC
        LIMIT ? OFFSET ?
      `).all(stepId, stepId, pageLimit, pageOffset));
      return page(total, rows);
    }
    const isTurnStep = Boolean(definition!.group);
    if (isTurnStep && !hasTurnTables(db)) return page(0, []);
    if (!isTurnStep && !tableExists(db, 'pipeline_events')) return page(0, []);
    const source = isTurnStep ? turnStepStateSql(true) : stepStateSql(db, true);
    const params = isTurnStep ? [stepId] : stepStateParams(stepId);
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM (${source}) WHERE state = ?`).get(...params, state)?.count || 0);
    const rows = normalizedRows(db.prepare(`
      SELECT record.*, classified.reason AS __step_reason, classified.state_at AS __step_at
      FROM (${source}) classified
      JOIN records record ON record._row_id = classified.record_id
      WHERE classified.state = ?
      ORDER BY classified.state_at DESC, record._row_id ASC
      LIMIT ? OFFSET ?
    `).all(...params, state, pageLimit, pageOffset));
    return page(total, rows);
  } finally {
    db.close();
  }
};

export const getRejectedSourcesForViz = (listDir: string) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    const { config } = readConfig(listDir);
    return getRejectedSources({ db, config });
  } finally {
    db.close();
  }
};

export const getRejectedRecordsForViz = (
  listDir: string,
  source = '',
  limit = 100,
  offset = 0,
) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    const { config } = readConfig(listDir);
    return getRejectedRecords({ db, config, source, limit, offset });
  } finally {
    db.close();
  }
};

export const restoreRejectedRecordForViz = (
  listDir: string,
  rowId: string,
  reason = DEFAULT_REJECTED_RESTORE_REASON,
) => {
  const db = openListDb({ listDir, readonly: false });
  try {
    const { config } = readConfig(listDir);
    return db.transaction(() => restoreRejectedRecord({
      db,
      config,
      ref: rowId,
      reason: String(reason || DEFAULT_REJECTED_RESTORE_REASON),
      createdBy: 'rejected:viz',
    }))();
  } finally {
    db.close();
  }
};

export const buildMeta = (listDir: string) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    const { config } = readConfig(listDir);
    const recordColumns = getRecordColumns(db).filter((column) => !HIDDEN_SCORE_COLUMNS.has(column.key));
    const realColumns = new Set(recordColumns.map((column) => column.key));
    const outputs = stepOutputMap(config);
    const sourceOutputs = sourceOutputKeys(config);
    const lockedNameKey = realColumns.has('business_name') ? 'business_name' : realColumns.has('name') ? 'name' : '';
    const defaultFundamentals = new Set([
      canonicalColumn(realColumns, 'address', 'formattedAddress'),
      canonicalColumn(realColumns, 'website', 'websiteUri'),
      canonicalColumn(realColumns, 'phone', 'nationalPhoneNumber'),
    ].filter(Boolean));
    const realColumnMeta = recordColumns.map((column) => {
      const classified = classifyColumn({ key: column.key, dbType: column.dbType, config, outputs, sourceOutputs });
      // The single Score and the business name are the frozen/locked columns.
      const locked = column.key === lockedNameKey || column.key === 'priority_rank';
      return {
        key: column.key,
        label: column.key === 'priority_rank' ? 'Score' : labelFor(column.key),
        ...classified,
        default_visible: locked || defaultFundamentals.has(column.key) || column.key === 'priority_rank' || classified.group === 'enrich',
        locked,
      };
    });
    const orderedKeys = [
      lockedNameKey,
      realColumns.has('priority_rank') ? 'priority_rank' : '',
      canonicalColumn(realColumns, 'address', 'formattedAddress'),
      canonicalColumn(realColumns, 'website', 'websiteUri'),
      canonicalColumn(realColumns, 'phone', 'nationalPhoneNumber'),
      ...realColumnMeta.filter((column: any) => column.group === 'enrich').map((column) => column.key),
    ].filter(Boolean);
    const orderedKeySet = new Set(orderedKeys);
    const orderedRealColumns = [
      ...orderedKeys.map((key) => realColumnMeta.find((column) => column.key === key)).filter(Boolean),
      ...realColumnMeta.filter((column) => !orderedKeySet.has(column.key)),
    ];
    const columns = [...orderedRealColumns, ...criterionColumns(config)];
    const total = Number(db.prepare('SELECT COUNT(*) AS count FROM records').get()?.count || 0);
    const filters: any[] = columns.flatMap((column: any): any[] => {
      if ((LOW_CARDINALITY_FILTERS.has(column.key) || String(column.key).endsWith('__status')) && realColumns.has(column.key)) {
        const options = normalizedRows(db.prepare(`SELECT DISTINCT ${quoteIdent(column.key)} AS value FROM records WHERE COALESCE(${quoteIdent(column.key)}, '') != '' ORDER BY ${quoteIdent(column.key)} COLLATE NOCASE LIMIT 200`).all())
          .map((row: any) => String(row.value || ''))
          .filter(Boolean);
        return [{ key: column.key, label: column.label, type: 'enum', options }];
      }
      if (NUMERIC_FILTER_COLUMNS.has(column.key) && realColumns.has(column.key)) {
        const range = db.prepare(`SELECT MIN(CAST(NULLIF(${quoteIdent(column.key)}, '') AS REAL)) AS min, MAX(CAST(NULLIF(${quoteIdent(column.key)}, '') AS REAL)) AS max FROM records`).get() || {};
        return [{ key: column.key, label: column.label, type: 'range', min: range.min, max: range.max }];
      }
      return [];
    });
    filters.push({ key: 'disqualified', label: 'Status', type: 'enum', options: ['qualified', 'disqualified'] });
    filters.push({ key: 'lead_status', label: 'Lead status', type: 'enum', options: [...LEAD_STATUSES] });
    filters.push({ key: 'territory', label: 'Territory', type: 'enum', options: (Array.isArray(config?.territories) ? config.territories : []).map((territory: any) => String(territory.id || '')).filter(Boolean) });
    const byStatus = leadStatusBreakdown(db);
    const territories = buildTerritories({ config, db, realColumns });
    return {
      list: { name: basename(listDir), dir: listDir },
      counts: {
        total,
        // "Qualified" = actually scored and in play (lead_status === 'qualified'),
        // NOT "survived the gates". The old total-minus-dropped count was misleading.
        qualified: byStatus.qualified,
        disqualified: byStatus.dropped_low_score + byStatus.dropped_gate + byStatus.dropped_manual,
        by_status: byStatus,
      },
      steps: buildSteps(config),
      columns,
      filters,
      territories,
      review_stages: getReviewStages({ db, config }),
      mapsApiKey: getEnv('GOOGLE_MAPS_API_KEY'),
      scoreMinimum: Number(config?.score?.minimum ?? 0),
    };
  } finally {
    db.close();
  }
};

export const queryRecords = (listDir: string, params: any = {}) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    const { config } = readConfig(listDir);
    const criteria = criterionIds(config);
    const recordColumns = getRecordColumns(db);
    const realColumns = new Set(recordColumns.map((column) => column.key));
    const where: string[] = [];
    const values: any[] = [];
    const filters = params?.filters && typeof params.filters === 'object' ? params.filters : {};
    for (const [key, filterValue] of Object.entries(filters)) {
      if (key === 'territory') {
        const territoryId = String(filterValue || '').trim();
        if (territoryId && tableExists(db, 'lead_territories')) {
          where.push('_row_id IN (SELECT row_id FROM lead_territories WHERE territory_id = ?)');
          values.push(territoryId);
        }
        continue;
      }
      if (key === 'disqualified') {
        if (filterValue === 'qualified' && realColumns.has('disqualified_at')) where.push("COALESCE(disqualified_at, '') = ''");
        if (filterValue === 'disqualified' && realColumns.has('disqualified_at')) where.push("COALESCE(disqualified_at, '') != ''");
        continue;
      }
      if (key === 'lead_status') {
        const status = String(filterValue || '');
        if ((LEAD_STATUSES as readonly string[]).includes(status)) {
          where.push(`${leadStatusCaseSql({ availableColumns: realColumns })} = ?`);
          values.push(status);
        }
        continue;
      }
      if (!realColumns.has(key)) continue;
      if (filterValue && typeof filterValue === 'object' && !Array.isArray(filterValue)) {
        const min = toNumberOrNull((filterValue as any).min);
        const max = toNumberOrNull((filterValue as any).max);
        if (min !== null) {
          where.push(`CAST(NULLIF(${quoteIdent(key)}, '') AS REAL) >= ?`);
          values.push(min);
        }
        if (max !== null) {
          where.push(`CAST(NULLIF(${quoteIdent(key)}, '') AS REAL) <= ?`);
          values.push(max);
        }
        continue;
      }
      if (BOOLEAN_COLUMNS.has(key)) {
        where.push(`${quoteIdent(key)} = ?`);
        values.push(Number(filterValue) ? 1 : 0);
        continue;
      }
      where.push(`${quoteIdent(key)} = ?`);
      values.push(String(filterValue));
    }
    const q = String(params?.q || '').trim();
    const qColumns = ['business_name', 'address', 'website', 'name'].filter((column) => realColumns.has(column));
    if (q && qColumns.length > 0) {
      where.push(`(${qColumns.map((column) => `${quoteIdent(column)} LIKE ?`).join(' OR ')})`);
      values.push(...qColumns.map(() => `%${q}%`));
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const requestedSort = String(params?.sort || 'priority_rank');
    // 'state' is the client's lifecycle pseudo-sort (resolved client-side), NOT the
    // address `state` column — which exists but is empty, so ordering by it collapses
    // to insertion order and truncates qualified leads past the page limit. Reserve it
    // (and any other pseudo-sort) so the server orders by score and every qualified lead
    // lands in the first page for the client to re-sort by lifecycle.
    const PSEUDO_SORTS = new Set(['state']);
    const sort = (!PSEUDO_SORTS.has(requestedSort) && realColumns.has(requestedSort))
      ? requestedSort
      : realColumns.has('priority_rank') ? 'priority_rank' : '_row_id';
    const dir = String(params?.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.max(1, Math.min(500, Number(params?.limit || 50) || 50));
    const offset = Math.max(0, Number(params?.offset || 0) || 0);
    const sortExpr = sort === 'priority_rank' && realColumns.has('fit_score')
      ? `COALESCE(CAST(NULLIF(${quoteIdent('fit_score')}, '') AS REAL), CAST(NULLIF(${quoteIdent('priority_rank')}, '') AS REAL))`
      : NUMERIC_COLUMNS.has(sort) ? `CAST(NULLIF(${quoteIdent(sort)}, '') AS REAL)` : quoteIdent(sort);
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM records${whereSql}`).get(...values)?.count || 0);
    const records = normalizedRows(db.prepare(`SELECT * FROM records${whereSql} ORDER BY ${sortExpr} ${dir}, _row_id ASC LIMIT ? OFFSET ?`).all(...values, limit, offset))
      .map((record: any) => {
        const verdicts = verdictsFromBreakdown(record.fit_breakdown);
        return {
          ...record,
          __stage: String(record.disqualified_at || '') ? 'dropped' : 'scored',
          __lead_status: leadStatus(record),
          __dropped_at: String(record.disqualified_gate || ''),
          __outcome: derivedOutcome(record),
          ...Object.fromEntries(criteria.map((id) => [criterionKey(id), verdicts.get(id) || ''])),
        };
      });
    const pipelineStepIds = flattenPipelineSteps(config).map((step: any) => String(step?.id || '')).filter(Boolean);
    const stepOrder = new Map(pipelineStepIds.map((id, i) => [id, i]));
    const rowIds = records.map((record: any) => String(record._row_id)).filter(Boolean);
    const events = tableExists(db, 'pipeline_events') && rowIds.length > 0
      ? normalizedRows(db.prepare(`SELECT record_id, step_id FROM pipeline_events WHERE record_id IN (${rowIds.map(() => '?').join(',')})`).all(...rowIds))
      : [];
    const furthestState = events.reduce((state: any, ev: any) => {
      const rid = String(ev.record_id || '');
      const sid = String(ev.step_id || '');
      const rank = stepOrder.has(sid) ? (stepOrder.get(sid) as number) : -1;
      if (rank < 0) return state;
      if (!state.furthestRank.has(rid) || rank > (state.furthestRank.get(rid) as number)) {
        state.furthestRank.set(rid, rank);
        state.furthestByRow.set(rid, sid);
      }
      return state;
    }, { furthestByRow: new Map<string, string>(), furthestRank: new Map<string, number>() });
    return {
      total,
      records: records.map((record: any) => ({ ...record, __furthest_step: furthestState.furthestByRow.get(String(record._row_id)) || '' })),
    };
  } finally {
    db.close();
  }
};

export const getRecordDetail = (listDir: string, rowId: string) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    const { config } = readConfig(listDir);
    const storedRecord = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
    if (!storedRecord) throw new Error(`Record not found: ${rowId}`);
    const record = canonicalizeRecordDetailFields(storedRecord);
    const pipelineEvents = tableExists(db, 'pipeline_events')
      ? normalizedRows(db.prepare('SELECT * FROM pipeline_events WHERE record_id = ? ORDER BY occurred_at ASC').all(rowId))
      : [];
    const scoreEvents = tableExists(db, 'score_events')
      ? normalizedRows(db.prepare('SELECT * FROM score_events WHERE row_id = ? ORDER BY computed_at ASC').all(rowId))
      : [];
    const costEvents = tableExists(db, 'cost_events') && hasTableColumn(db, 'cost_events', 'record_id')
      ? normalizedRows(db.prepare("SELECT * FROM cost_events WHERE COALESCE(record_id, '') IN ('', ?) ORDER BY occurred_at DESC").all(rowId))
      : [];
    const overrideRows = tableExists(db, 'overrides')
      ? listOverridesForRecord({ db, recordId: rowId, includeCleared: true })
      : [];
    const fieldOverrides = tableExists(db, 'field_overrides')
      ? listFieldOverridesForRecord({ db, recordId: rowId, includeCleared: true })
      : [];
    const interactionRows = tableExists(db, 'interactions')
      ? listInteractionsForRecord({ db, recordId: rowId })
      : [];
    const interactions = interactionRows.map((row: any) => ({
      interaction_id: String(row.interaction_id || ''),
      kind: String(row.kind || ''),
      contact: String(row.contact || ''),
      summary: String(row.summary || ''),
      body: String(row.body || ''),
      objections: String(row.objections || ''),
      follow_up_at: String(row.follow_up_at || ''),
      follow_up_done_at: String(row.follow_up_done_at || ''),
      follow_up_note: String(row.follow_up_note || ''),
      occurred_at: String(row.occurred_at || ''),
      created_by: String(row.created_by || ''),
    }));
    const overrides = overrideRows.map((o: any) => ({
      id: String(o.id || ''),
      kind: String(o.kind || ''),
      step_id: String(o.step_id || ''),
      scope: String(o.step_id || '').trim() ? `gate:${o.step_id}` : (String(o.kind) === 'keep' ? 'all_gates' : 'manual'),
      reason: String(o.reason || ''),
      created_at: String(o.created_at || ''),
      created_by: String(o.created_by || ''),
      cleared_at: String(o.cleared_at || ''),
      active: String(o.cleared_at || '').trim() === '',
    }));
    // Map active keep overrides to the gate they cover ('*' = all gates / blanket).
    const activeKeepByStep = new Map<string, any>();
    overrides.filter((o) => o.active && o.kind === 'keep').forEach((o) => {
      activeKeepByStep.set(o.step_id || '*', o);
    });
    const recordColumnNames = [...new Set([
      ...getRecordColumns(db).map((column) => column.key),
      ...Object.keys(record),
    ])];
    const recordColumns = new Set(recordColumnNames);
    const fieldClassification = recordDetailFieldClassification({ config, record, recordColumns: recordColumnNames });
    const pipeline = flattenPipelineSteps(config);
    const orderedSteps = [{ id: 'source', kind: 'source' }, ...pipeline.map((step: any) => ({ id: String(step.id || ''), kind: String(step.kind || '') }))];
    const dropGate = String(record.disqualified_gate || '');
    const dropIndex = dropGate ? orderedSteps.findIndex((step) => step.id === dropGate) : -1;
    const sourceFields = Array.from(sourceOutputKeys(config)).map(String).filter((key) => recordColumns.has(key));
    const sourceConfig: any = config?.source || {};
    const sourceStep = {
      id: 'source',
      kind: 'source',
      description: String(sourceConfig?.description || 'Source records'),
      status: 'done',
      tool: {
        server: sourceToolServer(config) || null,
        tools: Array.isArray(sourceConfig?.strategies?.[0]?.tool?.tools) ? sourceConfig.strategies[0].tool.tools : [],
      },
      reasoning: record.source_filter_failures || record.source_filter_result || '',
      condition_summary: '',
      outputs: Object.fromEntries(sourceFields.map((field) => [field, record[field]])),
      events: [],
      cost: null,
    };
    const steps = [sourceStep, ...pipeline.map((step: any, pipelineIndex: number) => {
      const id = String(step.id || '');
      const index = pipelineIndex + 1;
      const events = pipelineEvents.filter((event) => String(event.step_id || '') === id);
      const statusColumn = stepStatusColumn(id);
      const isDropGate = Boolean(dropGate && id === dropGate);
      const explicitStatus = recordColumns.has(statusColumn) && String(record[statusColumn] || '')
        ? String(record[statusColumn] || '')
        : '';
      const eventStatus = events.length > 0 ? statusFromEvents(events) : '';
      const inferredStatus = inferredStepStatus({ step, index, dropIndex });
      const status = isDropGate
        ? 'dropped'
        : String(step.kind || '') === 'enrich' && explicitStatus
          ? explicitStatus
          : recordFlaggedForStep(record, id)
            ? 'flagged'
            : String(step.kind || '') === 'filter' && eventStatus
              ? eventStatus
              : inferredStatus;
      const latestReason = [...events].reverse().find((event) => String(event.reason || '').trim())?.reason || '';
      const outputs = Object.fromEntries(outputEntries(step).map(([field, spec]) => [field, typedOutputValue(record[field], spec)]));
      const stepKeep = activeKeepByStep.get(id) || activeKeepByStep.get('*');
      const override = stepKeep
        ? { kind: 'keep', scope: stepKeep.scope, reason: stepKeep.reason, created_at: stepKeep.created_at, created_by: stepKeep.created_by }
        : null;
      return {
        id,
        kind: String(step.kind || ''),
        description: String(step.description || step.condition || step.type || ''),
        condition_summary: conditionSummary(step),
        status: override ? 'kept' : status,
        tool: { server: step?.tool?.server || null, tools: Array.isArray(step?.tool?.tools) ? step.tool.tools : [] },
        reasoning: isDropGate && !latestReason ? String(record.disqualify_reason || '') : latestReason,
        override,
        outputs,
        events,
        cost: costPayload(selectCostForStep(costEvents, id)),
      };
    })];
    const rank = recordScore(record) ?? 0;
    const minimum = Number(config?.score?.minimum ?? 0);
    const score = {
      value: rank,
      reasoning: record.fit_reasoning || '',
      criteria: mergeCriteriaBreakdown(configuredFitCriteria(config), record.fit_breakdown),
      minimum,
      updated_at: record.fit_score_updated_at || record.updated_at || '',
      events: scoreEvents,
    };
    const timeline = [
      record.sourced_at ? { kind: 'source', label: 'Source', detail: record.source_query || record.source || '', at: record.sourced_at } : null,
      ...pipelineEvents.map((event) => ({
        kind: event.kind || 'filter',
        label: event.step_id || '',
        detail: event.reason || (event.passed ? 'passed' : 'failed'),
        at: event.occurred_at || '',
      })),
      ...scoreEvents.map((event) => ({
        kind: 'score',
        label: `${event.axis || ''} score`,
        detail: event.reasoning || String(event.score ?? ''),
        at: event.computed_at || '',
      })),
      ...overrides.map((o) => ({
        kind: 'override',
        label: o.kind === 'keep' ? `override · keep ${o.step_id || 'all gates'}` : 'override · drop',
        detail: o.reason,
        at: o.created_at,
        cleared: !o.active,
      })),
      ...fieldOverrides.map((o: any) => ({
        kind: 'override',
        label: `field set · ${o.field}`,
        detail: [o.value === null ? '(cleared)' : `= ${o.value}`, o.reason].filter(Boolean).join(' — '),
        at: o.created_at,
        cleared: String(o.cleared_at || '').trim() !== '',
      })),
      ...interactions.map((i: any) => ({
        kind: 'interaction',
        label: `${i.kind}${i.contact ? ` · ${i.contact}` : ''}`,
        detail: i.summary,
        at: i.occurred_at,
      })),
      ...costEvents.filter((event) => event.record_id === rowId || selectCostForStep(costEvents, 'score') === event || pipeline.some((step: any) => costStepMatches(String(event.step_id || ''), String(step.id || '')))).map((event) => ({
        kind: 'cost',
        label: event.step_id || '',
        detail: [event.model, event.provider].filter(Boolean).join(' '),
        at: event.occurred_at || '',
      })),
    ].filter(Boolean).sort((a: any, b: any) => String(a.at || '').localeCompare(String(b.at || '')));
    const manualFields = fieldOverrides
      .filter((o: any) => String(o.cleared_at || '').trim() === '')
      .map((o: any) => ({
        field: String(o.field || ''),
        value: o.value === null || o.value === undefined ? null : String(o.value),
        reason: String(o.reason || ''),
        created_at: String(o.created_at || ''),
      }));
    const briefRow = tableExists(db, 'lead_briefs') ? getBriefForRecord({ db, rowId }) : null;
    const brief = briefRow
      ? {
        summary: String(briefRow.summary || ''),
        content: String(briefRow.content || ''),
        roles: (() => {
          try {
            const parsed = JSON.parse(String(briefRow.roles_json || '[]'));
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })(),
        model: String(briefRow.model || ''),
        updated_at: String(briefRow.updated_at || ''),
      }
      : null;
    // Generated assets for this lead (e.g. the automation plan), keyed by step_id.
    // The brief lives in its own table, so it is never included here.
    const assets = (tableExists(db, 'assets') ? getAssetsForRow({ db, rowId }) : []).map((asset: any) => {
      const outputs = (() => {
        try {
          const parsed = JSON.parse(String(asset.outputs_json || '{}'));
          return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
          return {};
        }
      })();
      return {
        asset_id: String(asset.asset_id || ''),
        step_id: String(asset.step_id || ''),
        label: String(asset.label || labelFor(asset.step_id || '')),
        summary: String(asset.reason || outputs.summary || ''),
        content: String(asset.result || ''),
        is_reference: Boolean(asset.is_reference),
        status: String(asset.status || ''),
        model: String(outputs.model || ''),
        updated_at: String(asset.updated_at || ''),
      };
    });
    return {
      record,
      field_classification: fieldClassification,
      lead_status: leadStatus(record),
      manual_fields: manualFields,
      interactions,
      brief,
      assets,
      steps,
      score,
      timeline,
      overrides,
    };
  } finally {
    db.close();
  }
};

export const getProgress = (listDir: string) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    const row: any = latestRunState(db);
    if (!row) return { run: null };
    return {
      run: {
        run_id: String(row.run_id || ''),
        phase: String(row.phase || ''),
        active_step: String(row.active_step || ''),
        message: String(row.message || ''),
        target_count: Number(row.target_count || 0),
        done_count: Number(row.done_count || 0),
        step_index: Number(row.step_index || 0),
        step_total: Number(row.step_total || 0),
        status: String(row.status || ''),
        error: String(row.error || ''),
        started_at: String(row.started_at || ''),
        updated_at: String(row.updated_at || ''),
        age_ms: runAgeMs(row),
      },
    };
  } finally {
    db.close();
  }
};

// One source of truth for the lifecycle pills: the lead-status taxonomy. Every
// record maps to exactly one status, so the parts sum to total and the table's
// `lead_status` filter agrees with these counts.
const leadStatusBreakdown = (db: any) => {
  const realColumns = new Set(getRecordColumns(db).map((column) => column.key));
  const rows = normalizedRows(db.prepare(`
    SELECT ${leadStatusCaseSql({ availableColumns: realColumns })} AS status, COUNT(*) AS count
    FROM records GROUP BY status
  `).all());
  const counts = Object.fromEntries(rows.map((row: any) => [String(row.status || ''), Number(row.count || 0)]));
  return {
    unscored: Number(counts.unscored || 0),
    qualified: Number(counts.qualified || 0),
    dropped_low_score: Number(counts.dropped_low_score || 0),
    dropped_gate: Number(counts.dropped_gate || 0),
    dropped_manual: Number(counts.dropped_manual || 0),
  };
};

export const getCounts = (listDir: string) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    const total = Number(db.prepare('SELECT COUNT(*) AS count FROM records').get()?.count || 0);
    const byStatus = leadStatusBreakdown(db);
    // "Qualified" means actually-scored-and-in-play, not merely "survived the gates".
    const qualified = byStatus.qualified;
    const disqualified = byStatus.dropped_low_score + byStatus.dropped_gate + byStatus.dropped_manual;
    return { total, qualified, disqualified, by_status: byStatus };
  } finally {
    db.close();
  }
};
