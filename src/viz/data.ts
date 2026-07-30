import { basename } from 'node:path';
import { readConfig } from '../orchestrator/lib/config.js';
import { recordScore } from '../orchestrator/lib/record.js';
import { getTargetColumnsForStepConfig } from '../orchestrator/lib/step-columns.js';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';
import {
  getAssetsForRow,
  getBriefForRecord,
  getRecordById,
  getTerritoryNotes,
  insertTerritoryNote,
  listFieldOverridesForRecord,
  listInteractionsForRecord,
  listOverridesForRecord,
  OVERRIDE_GATE,
  openListDb,
  reconcileOverrides,
} from '../orchestrator/runtime/db.js';
import { LEAD_STATUSES, leadStatus, leadStatusCaseSql } from '../orchestrator/runtime/status.js';
import { getEnv } from '../orchestrator/runtime/env.js';
import {
  clearReviewDecision,
  getReviewQueue,
  getReviewStages,
  insertReviewDecision,
  requireResolvedReviewStage,
  reviewDecisionResult,
  reviewRecordDecisionState,
  reviewRecordLabel,
  type ReviewDecision,
} from '../orchestrator/pipeline/review.js';
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
  for (const step of (Array.isArray(config?.pipeline) ? config.pipeline : [])) {
    if (String(step?.kind || '') !== 'enrich') continue;
    const stepId = String(step?.id || '').trim();
    if (!stepId) continue;
    const stepConfig = step?.config && typeof step.config === 'object' ? step.config : step;
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
    SUCCESSFUL_ENRICH_STATUSES.has(String(record[`${stepId}__status`] || '').trim().toLowerCase())
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
  for (const step of Array.isArray(config?.pipeline) ? config.pipeline : []) {
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
const configuredCriteria = (config: any) => (Array.isArray(config?.score?.criteria) ? config.score.criteria : []);
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
  const breakdownById = new Map(parseJsonArray(rawBreakdown).map((item: any) => [String(item?.id || ''), item]));
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
  ...(Array.isArray(config?.pipeline) ? config.pipeline : []).map((step: any) => ({
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
    criteria: Array.isArray(config?.score?.criteria) ? config.score.criteria : [],
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

export const getReviewQueueForViz = (listDir: string, stageId: string, limit = 100, offset = 0) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    const { config } = readConfig(listDir);
    return getReviewQueue({ db, config, stageId, limit, offset });
  } finally {
    db.close();
  }
};

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
  const db = openListDb({ listDir, readonly: false });
  try {
    const { config } = readConfig(listDir);
    const stage = requireResolvedReviewStage({ db, config, stageId });
    const write = db.transaction(() => {
      const outcomes = (decisions as ReviewDecision[]).map((input, index) => {
        try {
          return {
            ok: true,
            index,
            decision: insertReviewDecision({
              db,
              config,
              ref: String(input?.row_id || ''),
              stageId: stage.id,
              verdict: String(input?.verdict || ''),
              reason: String(input?.reason || ''),
            }),
          };
        } catch (error) {
          return {
            ok: false,
            index,
            row_id: String(input?.row_id || ''),
            verdict: String(input?.verdict || ''),
            error: String((error as Error)?.message || error),
          };
        }
      });
      reconcileOverrides({ db });
      return outcomes.map((outcome: any) => outcome.ok
        ? { ok: true, index: outcome.index, ...reviewDecisionResult({ db, decision: outcome.decision }) }
        : outcome);
    });
    const results = write();
    return {
      stage,
      requested: decisions.length,
      applied: results.filter((result: any) => result.ok).length,
      failed: results.filter((result: any) => !result.ok).length,
      results,
    };
  } finally {
    db.close();
  }
};

export const clearReviewDecisionForViz = (listDir: string, rowId: string, stageId: string) => {
  const db = openListDb({ listDir, readonly: false });
  try {
    const { config } = readConfig(listDir);
    const write = db.transaction(() => {
      const result = clearReviewDecision({ db, config, ref: rowId, stageId });
      reconcileOverrides({ db });
      const record = getRecordById({ db, id: String(result.record._row_id) }) || result.record;
      return {
        status: result.cleared.length > 0 ? 'review_cleared' : 'noop',
        stage: result.stage,
        cleared_count: result.cleared.length,
        cleared: result.cleared.map((override: any) => ({
          id: String(override.id || ''),
          kind: String(override.kind || ''),
          step_id: String(override.step_id || ''),
          reason: String(override.reason || ''),
        })),
        record: reviewRecordLabel(record),
        state: reviewRecordDecisionState(record),
      };
    });
    return write();
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
        const verdicts = verdictsFromBreakdown(record.score_breakdown);
        return {
          ...record,
          __stage: String(record.disqualified_at || '') ? 'dropped' : 'scored',
          __lead_status: leadStatus(record),
          __dropped_at: String(record.disqualified_gate || ''),
          __outcome: derivedOutcome(record),
          ...Object.fromEntries(criteria.map((id) => [criterionKey(id), verdicts.get(id) || ''])),
        };
      });
    const pipelineStepIds = (Array.isArray(config?.pipeline) ? config.pipeline : []).map((step: any) => String(step?.id || '')).filter(Boolean);
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
    const pipeline = Array.isArray(config?.pipeline) ? config.pipeline : [];
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
      const statusColumn = `${id}__status`;
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
      reasoning: record.score_reasoning || record.fit_reasoning || '',
      criteria: mergeCriteriaBreakdown(config?.score?.criteria, record.score_breakdown),
      minimum,
      updated_at: record.score_updated_at || record.fit_score_updated_at || '',
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
    if (!tableExists(db, 'run_state')) return { run: null };
    const row: any = db.prepare('SELECT * FROM run_state ORDER BY updated_at DESC LIMIT 1').get();
    if (!row) return { run: null };
    const updatedAtMs = Date.parse(String(row.updated_at || ''));
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
        age_ms: Number.isFinite(updatedAtMs) ? Math.max(0, Date.now() - updatedAtMs) : null,
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
