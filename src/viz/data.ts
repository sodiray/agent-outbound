import { basename } from 'node:path';
import { readConfig } from '../orchestrator/lib/config.js';
import { listOverridesForRecord, OVERRIDE_GATE, openListDb } from '../orchestrator/runtime/db.js';

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
const NUMERIC_FILTER_COLUMNS = new Set(['priority_rank', 'fit_score', 'trigger_score', 'user_rating_count']);

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
const configuredCriteria = (config: any) => ({
  fit: Array.isArray(config?.score?.fit?.criteria) ? config.score.fit.criteria : [],
  trigger: Array.isArray(config?.score?.trigger?.criteria) ? config.score.trigger.criteria : [],
});
const criterionKey = (id: string) => `criterion__${id}`;
const criterionColumns = (config: any) => {
  const criteria = configuredCriteria(config);
  return [...criteria.fit, ...criteria.trigger].map((criterion: any) => {
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
};
const criterionIds = (config: any) => {
  const criteria = configuredCriteria(config);
  return {
    fit: criteria.fit.map((criterion: any) => String(criterion?.id || '')).filter(Boolean),
    trigger: criteria.trigger.map((criterion: any) => String(criterion?.id || '')).filter(Boolean),
  };
};
const nonEmptyValue = (value: any) => value !== null && value !== undefined && value !== '';
const nonEmptyString = (value: any) => String(value || '').trim() !== '';
const canonicalColumn = (realColumns: Set<string>, preferred: string, fallback: string) => realColumns.has(preferred) ? preferred : realColumns.has(fallback) ? fallback : '';
const verdictsFromBreakdown = (rawBreakdown: any) => new Map(parseJsonArray(rawBreakdown).map((item: any) => [String(item?.id || ''), String(item?.verdict || '')]));
const isScoredRecord = (record: any) =>
  nonEmptyString(record.fit_score_updated_at) ||
  nonEmptyString(record.trigger_score_updated_at) ||
  Number(record.priority_rank) > 0 ||
  Number(record.fit_score) > 0;
// Precedence matters: a dropped record never scores; a scored record outranks a
// non-fatal per-step error (e.g. a stale timing_enrich error on an otherwise
// fully scored lead). Only surface 'error' when nothing else completed.
const derivedOutcome = (record: any) => {
  if (nonEmptyString(record.disqualified_at)) return 'dropped';
  if (isScoredRecord(record)) return 'scored';
  if (nonEmptyString(record.last_error) || nonEmptyString(record.fit_scoring_error) || nonEmptyString(record.trigger_scoring_error)) return 'error';
  return 'not_scored';
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
    criteria: {
      fit: Array.isArray(config?.score?.fit?.criteria) ? config.score.fit.criteria : [],
      trigger: Array.isArray(config?.score?.trigger?.criteria) ? config.score.trigger.criteria : [],
    },
    priority_weight: config?.score?.priority?.weight || {},
  },
];

export const buildMeta = (listDir: string) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    const { config } = readConfig(listDir);
    const recordColumns = getRecordColumns(db);
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
      // Outcome, fit_score, and the business name are the three frozen/locked columns.
      const locked = column.key === lockedNameKey || column.key === 'fit_score';
      return {
        key: column.key,
        label: labelFor(column.key),
        ...classified,
        default_visible: locked || defaultFundamentals.has(column.key) || column.key === 'fit_score' || classified.group === 'enrich',
        locked,
      };
    });
    const orderedKeys = [
      lockedNameKey,
      canonicalColumn(realColumns, 'address', 'formattedAddress'),
      canonicalColumn(realColumns, 'website', 'websiteUri'),
      canonicalColumn(realColumns, 'phone', 'nationalPhoneNumber'),
      realColumns.has('fit_score') ? 'fit_score' : '',
      ...realColumnMeta.filter((column: any) => column.group === 'enrich').map((column) => column.key),
    ].filter(Boolean);
    const orderedKeySet = new Set(orderedKeys);
    const orderedRealColumns = [
      ...orderedKeys.map((key) => realColumnMeta.find((column) => column.key === key)).filter(Boolean),
      ...realColumnMeta.filter((column) => !orderedKeySet.has(column.key)),
    ];
    const columns = [...orderedRealColumns, ...criterionColumns(config)];
    const total = Number(db.prepare('SELECT COUNT(*) AS count FROM records').get()?.count || 0);
    const qualified = realColumns.has('disqualified_at')
      ? Number(db.prepare("SELECT COUNT(*) AS count FROM records WHERE COALESCE(disqualified_at, '') = ''").get()?.count || 0)
      : total;
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
    return {
      list: { name: basename(listDir), dir: listDir },
      counts: { total, qualified, disqualified: total - qualified },
      steps: buildSteps(config),
      columns,
      filters,
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
      if (key === 'disqualified') {
        if (filterValue === 'qualified' && realColumns.has('disqualified_at')) where.push("COALESCE(disqualified_at, '') = ''");
        if (filterValue === 'disqualified' && realColumns.has('disqualified_at')) where.push("COALESCE(disqualified_at, '') != ''");
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
    const sort = realColumns.has(requestedSort) ? requestedSort : realColumns.has('priority_rank') ? 'priority_rank' : '_row_id';
    const dir = String(params?.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.max(1, Math.min(500, Number(params?.limit || 50) || 50));
    const offset = Math.max(0, Number(params?.offset || 0) || 0);
    const sortExpr = NUMERIC_COLUMNS.has(sort) ? `CAST(NULLIF(${quoteIdent(sort)}, '') AS REAL)` : quoteIdent(sort);
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM records${whereSql}`).get(...values)?.count || 0);
    const records = normalizedRows(db.prepare(`SELECT * FROM records${whereSql} ORDER BY ${sortExpr} ${dir}, _row_id ASC LIMIT ? OFFSET ?`).all(...values, limit, offset))
      .map((record: any) => {
        const fitVerdicts = verdictsFromBreakdown(record.fit_breakdown);
        const triggerVerdicts = verdictsFromBreakdown(record.trigger_breakdown);
        return {
          ...record,
          __stage: String(record.disqualified_at || '') ? 'dropped' : 'scored',
          __dropped_at: String(record.disqualified_gate || ''),
          __outcome: derivedOutcome(record),
          ...Object.fromEntries(criteria.fit.map((id) => [criterionKey(id), fitVerdicts.get(id) || ''])),
          ...Object.fromEntries(criteria.trigger.map((id) => [criterionKey(id), triggerVerdicts.get(id) || ''])),
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
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
    if (!record) throw new Error(`Record not found: ${rowId}`);
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
    const recordColumns = new Set(getRecordColumns(db).map((column) => column.key));
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
    const fitScore = Number(record.fit_score || 0);
    const triggerScore = Number(record.trigger_score || 0);
    const weight = config?.score?.priority?.weight || {};
    const fitWeight = Number(weight.fit ?? 0);
    const triggerWeight = Number(weight.trigger ?? 0);
    const computedPriority = (fitScore * fitWeight) + (triggerScore * triggerWeight);
    const rank = toNumberOrNull(record.priority_rank) ?? Number(computedPriority.toFixed(1));
    const score = {
      fit: {
        score: fitScore,
        reasoning: record.fit_reasoning || '',
        criteria: mergeCriteriaBreakdown(config?.score?.fit?.criteria, record.fit_breakdown),
        updated_at: record.fit_score_updated_at || record.fit_updated_at || '',
      },
      trigger: {
        score: triggerScore,
        reasoning: record.trigger_reasoning || '',
        criteria: mergeCriteriaBreakdown(config?.score?.trigger?.criteria, record.trigger_breakdown),
        updated_at: record.trigger_score_updated_at || record.trigger_updated_at || '',
      },
      priority: {
        rank,
        weight: { fit: fitWeight, trigger: triggerWeight },
        computation: `${fitScore} × ${fitWeight} + ${triggerScore} × ${triggerWeight} = ${rank.toFixed(1)}`,
      },
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
      ...costEvents.filter((event) => event.record_id === rowId || selectCostForStep(costEvents, 'score') === event || pipeline.some((step: any) => costStepMatches(String(event.step_id || ''), String(step.id || '')))).map((event) => ({
        kind: 'cost',
        label: event.step_id || '',
        detail: [event.model, event.provider].filter(Boolean).join(' '),
        at: event.occurred_at || '',
      })),
    ].filter(Boolean).sort((a: any, b: any) => String(a.at || '').localeCompare(String(b.at || '')));
    return { record, steps, score, timeline, overrides };
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

export const getCounts = (listDir: string) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    const total = Number(db.prepare('SELECT COUNT(*) AS count FROM records').get()?.count || 0);
    const qualified = hasTableColumn(db, 'records', 'disqualified_at')
      ? Number(db.prepare("SELECT COUNT(*) AS count FROM records WHERE COALESCE(disqualified_at, '') = ''").get()?.count || 0)
      : total;
    return { total, qualified, disqualified: total - qualified };
  } finally {
    db.close();
  }
};
