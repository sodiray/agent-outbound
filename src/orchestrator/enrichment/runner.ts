import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { ensureRecordColumns, inPlayWhere, openListDb, upsertContact, upsertRecord, nowTimestamp } from '../runtime/db.js';
import { readConfig } from '../lib/config.js';
import { stableHash } from '../lib/record.js';
import { executeStepAction } from '../actions/execute-step/index.js';
import { emitActivity } from '../runtime/activity.js';
import { recordCostEvent } from '../lib/costs.js';
import { getRecordRowId } from '../lib/record.js';
import { getMcpClient } from '../runtime/mcp.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { readToolCatalog } from '../lib/tool-catalog.js';
import { getTargetColumnsForStepConfig } from '../lib/step-columns.js';
import { isBudgetExceededError } from '../runtime/contract.js';
import { assertPhaseModelReferences } from '../lib/model-validation.js';
import { evaluateFieldCheckGroup } from '../lib/conditions.js';
import { nullableBoolean, nullableNumber, nullableString } from '../actions/schema-helpers.js';
import { formatErrorMessage } from '../lib/error-format.js';
import { toolSpecNeedsMcp, type ToolCatalog, type ToolSpec } from '../runtime/tools.js';
import { providerToolUsageFromError } from '../runtime/providers/usage.js';
import { executeDecisionMakersAction } from './actions/decision-makers.js';
import { executeToolCallAction } from './actions/tool-call.js';

const recordErroredProviderToolCost = ({
  db,
  listDir,
  recordId,
  stepId,
  error,
}: {
  db: any;
  listDir: string;
  recordId: string;
  stepId: string;
  error: unknown;
}) => {
  const usage = providerToolUsageFromError(error);
  if (!usage) return;
  recordCostEvent({
    db,
    listDir,
    recordId,
    stepId,
    provider: usage.provider,
    usage,
  });
};

export const parseExtra = (value) => {
  try {
    if (!value) return {};
    if (typeof value === 'object') return value;
    return JSON.parse(String(value));
  } catch {
    return {};
  }
};

const isBlank = (value) => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number') return Number.isNaN(value);
  if (typeof value === 'object') return Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
  return false;
};

export const mergedRecordForEnrichment = ({ db, record }) => {
  const rowId = getRecordRowId(record);
  if (String(record?.duplicate_of || '').trim()) return record;
  const linked = db.prepare(`
    SELECT * FROM records
    WHERE duplicate_of = ?
    ORDER BY updated_at DESC
  `).all(rowId);
  if (!linked.length) return record;
  const merged = { ...record };
  for (const duplicate of linked) {
    for (const [key, value] of Object.entries(duplicate || {})) {
      if (key === '_row_id' || key === 'id' || key === 'duplicate_of' || key === 'duplicate_status') continue;
      if (isBlank(merged[key]) && !isBlank(value)) merged[key] = value;
    }
  }
  return merged;
};

export const writeStaleness = ({ db, recordId, stepId, depHash, cacheTtlSeconds, cacheTtl }) => {
  db.prepare(`
    INSERT INTO staleness (id, record_id, step_id, dep_hash, cache_ttl, cache_ttl_seconds, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(record_id, step_id) DO UPDATE SET
      dep_hash = excluded.dep_hash,
      cache_ttl = excluded.cache_ttl,
      cache_ttl_seconds = excluded.cache_ttl_seconds,
      updated_at = excluded.updated_at
  `).run(randomUUID(), recordId, stepId, depHash, String(cacheTtl || ''), cacheTtlSeconds, nowTimestamp());
};

export const readStaleness = ({ db, recordId, stepId }) =>
  db.prepare('SELECT * FROM staleness WHERE record_id = ? AND step_id = ?').get(recordId, stepId);

export const ttlToSeconds = (ttl) => {
  const raw = String(ttl || '').trim().toLowerCase();
  if (!raw) return 0;
  const match = raw.match(/^(\d+)([smhd])$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === 's') return amount;
  if (unit === 'm') return amount * 60;
  if (unit === 'h') return amount * 3600;
  return amount * 86400;
};

// Only fields that materially affect the enrichment OUTPUT participate in the
// staleness hash. Cosmetic edits (description, concurrency, step_budget, id,
// columns, when, cache TTL) must NOT invalidate already-computed enrichment. An
// explicit `cache_key` overrides everything, giving authors deterministic control
// over when a step is forced to recompute.
const MATERIAL_ENRICH_FIELDS = ['action', 'tool', 'args', 'args_map', 'output_map', 'outputs', 'model', 'reasoning', 'prompt_file', 'prompt_args', 'depends_on', 'on_error'] as const;

export const materialEnrichConfig = (stepConfig: any): Record<string, any> => {
  const cfg = stepConfig && typeof stepConfig === 'object' ? stepConfig : {};
  const cacheKey = String(cfg.cache_key || '').trim();
  if (cacheKey) return { cache_key: cacheKey };
  // Build deterministically (sorted keys) so serialization order can't shift the hash.
  const material: Record<string, any> = {};
  for (const field of [...MATERIAL_ENRICH_FIELDS].sort()) {
    if (Object.prototype.hasOwnProperty.call(cfg, field) && cfg[field] !== undefined) {
      material[field] = cfg[field];
    }
  }
  return material;
};

// The material staleness hash actually written/compared, plus the legacy
// whole-config hash so caches written before material-hashing remain valid
// (no one-time re-enrichment storm on upgrade).
export const enrichDepHash = (stepConfig: any, depValues: Record<string, any> = {}) =>
  stableHash({ depValues, config: materialEnrichConfig(stepConfig) });
const legacyEnrichDepHash = (stepConfig: any, depValues: Record<string, any> = {}) =>
  stableHash({ depValues, config: stepConfig || {} });

// A record is FRESH for an enrich step when: not forced, a staleness row exists,
// its hash matches the material (or legacy) hash, AND it is within TTL. A step
// with NO configured TTL (cache_ttl_seconds <= 0) caches FOREVER — so an
// unchanged step is never redundantly re-run. TTL is opt-in periodic refresh.
export const isEnrichFresh = ({ cached, stepConfig, depValues = {}, force = false }: { cached: any; stepConfig: any; depValues?: Record<string, any>; force?: boolean }): boolean => {
  if (force || !cached) return false;
  const material = enrichDepHash(stepConfig, depValues);
  const legacy = legacyEnrichDepHash(stepConfig, depValues);
  const matched = String(cached.dep_hash || '') === material || String(cached.dep_hash || '') === legacy;
  if (!matched) return false;
  const ttl = Number(cached.cache_ttl_seconds || 0);
  if (ttl <= 0) return true; // no TTL configured = cache forever
  const updatedAt = new Date(String(cached.updated_at || 0)).getTime();
  return (Date.now() - updatedAt) / 1000 <= ttl;
};

const normalizeOutputType = (raw: any): 'string' | 'number' | 'integer' | 'boolean' => {
  const type = String(raw || 'string').trim().toLowerCase();
  if (type === 'number' || type === 'integer' || type === 'boolean') return type;
  return 'string';
};

type OutputDef = {
  type: 'string' | 'number' | 'integer' | 'boolean';
  description: string;
  enum?: string[];
};

export const getDeclaredOutputs = (stepConfig: any): Record<string, OutputDef> => {
  const declared = (stepConfig?.outputs && typeof stepConfig.outputs === 'object')
    ? stepConfig.outputs
    : {};
  const outputs: Record<string, OutputDef> = {};
  for (const [key, value] of Object.entries(declared)) {
    if (!key) continue;
    const def: any = value || {};
    outputs[String(key)] = {
      type: normalizeOutputType(def.type),
      description: String(def.description || key),
      ...(Array.isArray(def.enum) && def.enum.length ? { enum: def.enum.map((v) => String(v)) } : {}),
    };
  }
  return outputs;
};

export const getLegacyColumns = (stepConfig: any): Record<string, string> => {
  return (stepConfig?.columns && typeof stepConfig.columns === 'object')
    ? stepConfig.columns
    : {};
};

const nullableEnum = (values: [string, ...string[]]) => z.preprocess((value) => {
  if (value === null || value === undefined || value === '') return null;
  return value;
}, z.enum(values).nullable()).default(null);

export const buildOutputZodSchema = (outputs: Record<string, OutputDef>, legacyColumns: Record<string, string>) => {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, def] of Object.entries(outputs)) {
    if (def.enum?.length) {
      const enumValues = def.enum.map((v) => String(v));
      if (enumValues.length >= 1) {
        shape[key] = nullableEnum(enumValues as [string, ...string[]]).describe(def.description);
      }
      continue;
    }

    if (def.type === 'boolean') {
      shape[key] = nullableBoolean(false).describe(def.description);
    } else if (def.type === 'integer') {
      shape[key] = nullableNumber(null, z.number().int().nullable()).describe(def.description);
    } else if (def.type === 'number') {
      shape[key] = nullableNumber(null, z.number().nullable()).describe(def.description);
    } else {
      shape[key] = nullableString().describe(def.description);
    }
  }

  if (Object.keys(shape).length > 0) {
    return z.object(shape);
  }

  // Deprecated compatibility path for legacy config.columns without config.outputs.
  const legacyShape: Record<string, z.ZodTypeAny> = {};
  for (const key of Object.keys(legacyColumns)) {
    legacyShape[key] = z.any();
  }
  return z.object(legacyShape).passthrough();
};

const coerceForSqlite = (value: any, type: OutputDef['type']): string | number | null => {
  if (value === null || value === undefined) return type === 'string' ? '' : type === 'boolean' ? 0 : null;
  if (type === 'boolean') return value ? 1 : 0;
  if (type === 'integer') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : 0;
  }
  if (type === 'number') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
};

export const outputOutcomeFor = ({ outputs, expectedOutputs }: { outputs: any; expectedOutputs: Record<string, any> }) => {
  const expectedNames = Object.keys(expectedOutputs || {});
  if (expectedNames.length === 0) return 'ok';
  const hasAnyValue = expectedNames.some((name) => !isBlank(outputs?.[name]));
  return hasAnyValue ? 'ok' : 'empty';
};

const declaredOutputsHaveAnyValue = ({ record, expectedOutputs }: { record: Record<string, unknown>; expectedOutputs: Record<string, unknown> }) => {
  const expectedNames = Object.keys(expectedOutputs || {});
  if (expectedNames.length === 0) return true;
  return expectedNames.some((name) => !isBlank(record?.[name]));
};

export const emptyOutputsFor = (outputZod: z.ZodTypeAny) => outputZod.parse({});

export const enrichStepUsesEmptyOnError = (stepConfig: unknown) => {
  const config = stepConfig && typeof stepConfig === 'object' ? stepConfig as Record<string, unknown> : {};
  return String(config.on_error || 'fail').trim().toLowerCase() === 'empty';
};

export const enrichmentActionNeedsMcp = (stepConfig: unknown) => {
  const config = stepConfig && typeof stepConfig === 'object' ? stepConfig as Record<string, unknown> : {};
  return String(config.action || '').trim().toLowerCase() === 'decision_makers';
};

export const enrichmentStepConfig = (step: unknown): Record<string, unknown> => {
  const record = step && typeof step === 'object' ? step as Record<string, unknown> : {};
  return record.config && typeof record.config === 'object'
    ? record.config as Record<string, unknown>
    : record;
};

export const enrichmentStepNeedsMcp = (step: unknown, options: { listDir?: string } = {}) => {
  const stepConfig = enrichmentStepConfig(step);
  return enrichmentActionNeedsMcp(stepConfig) || toolSpecNeedsMcp(stepConfig.tool as ToolSpec | undefined, options);
};

export const whenPredicateForStep = ({ step, stepConfig }: { step: any; stepConfig: any }) => (
  stepConfig?.when && typeof stepConfig.when === 'object'
    ? stepConfig.when
    : step?.when && typeof step.when === 'object'
      ? step.when
      : null
);

export const shouldRunForRecord = ({ record, predicate, listDir = '' }: { record: any; predicate: any; listDir?: string }) => {
  if (!predicate) return { passed: true, reason: '' };
  return evaluateFieldCheckGroup({
    row: record,
    conditions: Array.isArray(predicate?.conditions) ? predicate.conditions : [],
    match: predicate?.match || 'all',
    listDir,
  });
};

const applyOutputs = ({ step, outputs }) => {
  const patch: Record<string, any> = {};
  const declaredOutputs = getDeclaredOutputs(step?.config || {});
  const legacyColumns = getLegacyColumns(step?.config || {});

  for (const [name, def] of Object.entries(declaredOutputs)) {
    if (!(name in (outputs || {}))) continue;
    patch[name] = coerceForSqlite(outputs?.[name], def.type);
  }

  // Deprecated compatibility path: map output key -> distinct column name.
  for (const [outputField, targetColumn] of Object.entries(legacyColumns)) {
    const target = String(targetColumn || '').trim();
    if (!target) continue;
    if (!(outputField in (outputs || {}))) continue;
    patch[target] = coerceForSqlite(outputs?.[outputField], 'string');
  }

  return patch;
};

const upsertPrimaryContactIfPresent = ({ db, record }: { db: any; record: any }) => {
  const contactEmail = String(record?.contact_email || record?.email_primary || '').trim().toLowerCase();
  if (!contactEmail) return;
  upsertContact({
    db,
    contact: {
      record_id: getRecordRowId(record),
      full_name: String(record?.contact_name || record?.contact_name_primary || ''),
      title: String(record?.contact_title || record?.contact_title_primary || ''),
      email: contactEmail,
      phone: String(record?.phone || ''),
      role: 'primary',
      is_primary: true,
    },
  });
};

export const dependencyValueForRecord = ({ dep, record, extra }) => {
  const key = String(dep || '').trim();
  if (!key) return undefined;
  if (key.includes('.')) {
    const parts = key.split('.');
    const outputField = String(parts.slice(1).join('.') || '').trim();
    if (!outputField) return undefined;
    if (outputField in (record || {})) return (record as any)[outputField];
    return (extra as any)?.[outputField];
  }
  if (key in (record || {})) return (record as any)[key];
  return (extra as any)?.[key];
};

const resolveStepId = (step: any, index: number) => {
  const id = String(step?.id || step?.config?.id || '').trim();
  if (id) return id;
  return `enrich_step_${index + 1}`;
};

// Non-writing count of what a pipeline enrich step WOULD do on the given rows:
// how many would actually re-run vs be skipped (fresh cache or `when` mismatch).
// Mirrors the per-record staleness logic in executeEnrichmentStepOnRecords so the
// dry-run impact preview is accurate. (Pipeline enrich uses empty depValues.)
export const countEnrichWorkForStep = ({ db, listDir = '', step, stepId = '', rows = [], force = false }: { db: any; listDir?: string; step: any; stepId?: string; rows?: any[]; force?: boolean }) => {
  const id = String(stepId || step?.id || '').trim() || 'enrich';
  const stepConfig = enrichmentStepConfig(step);
  const declaredOutputs = getDeclaredOutputs(stepConfig || {});
  const legacyColumns = getLegacyColumns(stepConfig || {});
  const expectedOutputs = Object.keys(declaredOutputs).length > 0
    ? declaredOutputs
    : legacyColumns;
  const whenPredicate = whenPredicateForStep({ step, stepConfig });
  const result = { would_enrich: 0, skip_fresh: 0, skip_when: 0 };
  for (const record of rows || []) {
    const whenOutcome = shouldRunForRecord({ record, predicate: whenPredicate, listDir });
    if (!whenOutcome.passed) { result.skip_when += 1; continue; }
    const cached = readStaleness({ db, recordId: getRecordRowId(record), stepId: id });
    if (
      isEnrichFresh({ cached, stepConfig, depValues: {}, force })
      && declaredOutputsHaveAnyValue({ record, expectedOutputs })
    ) { result.skip_fresh += 1; continue; }
    result.would_enrich += 1;
  }
  return result;
};

export const executeEnrichmentAction = async ({
  mcp,
  listDir,
  stepId,
  description,
  stepConfig,
  record,
  aiConfig,
  context,
  outputSchema,
  toolCatalog,
}: {
  mcp: Client | null;
  listDir: string;
  stepId: string;
  description: string;
  stepConfig: Record<string, unknown>;
  record: Record<string, unknown>;
  aiConfig: Record<string, unknown>;
  context: Record<string, unknown>;
  outputSchema: z.ZodTypeAny;
  toolCatalog?: ToolCatalog;
}) => {
  const action = String(stepConfig?.action || '').trim().toLowerCase();
  if (action === 'decision_makers') {
    return executeDecisionMakersAction({
      mcp,
      listDir,
      stepId,
      stepConfig,
      record,
      aiConfig,
    });
  }
  if (action === 'tool_call') {
    return executeToolCallAction({
      mcp,
      listDir,
      stepId,
      stepConfig,
      record,
      toolCatalog,
    });
  }
  return executeStepAction({
    mcp,
    listDir,
    stepId,
    description,
    stepConfig,
    record,
    aiConfig,
    role: 'research',
    context,
    outputSchema,
    toolCatalog,
  });
};

export const executeEnrichmentStepOnRecords = async ({
  db,
  listDir,
  config,
  mcp,
  toolCatalog,
  step,
  rows,
  stepId = '',
  force = false,
}: {
  db: any;
  listDir: string;
  config: any;
  mcp: any;
  toolCatalog: any;
  step: any;
  rows: any[];
  stepId?: string;
  force?: boolean;
}) => {
  const id = String(stepId || step?.id || '').trim() || 'enrich';
  const stepConfig = enrichmentStepConfig(step);
  const declaredOutputs = getDeclaredOutputs(stepConfig || {});
  const legacyColumns = getLegacyColumns(stepConfig || {});
  const outputZod = buildOutputZodSchema(declaredOutputs, legacyColumns);
  const concurrency = Number(stepConfig?.concurrency || 3);
  const targetColumns = getTargetColumnsForStepConfig(stepConfig || {});
  const statusColumn = `${id}__status`;
  const whenPredicate = whenPredicateForStep({ step, stepConfig });
  if (targetColumns.length > 0 || statusColumn) {
    ensureRecordColumns({
      db,
      columns: [
        ...targetColumns,
        { name: statusColumn, type: 'TEXT' },
      ],
    });
  }

  const summary = {
    processed: 0,
    skipped_fresh: 0,
    skipped_when: 0,
    failed: 0,
    errors: [] as Array<{ record_id: string; error: string }>,
    record_ids: [] as string[],
  };

  await mapWithConcurrency<any, void>((rows || []) as any[], async (record) => {
    const recordId = getRecordRowId(record);
    const rowLabel = String(record?.business_name || recordId);
    const whenOutcome = shouldRunForRecord({ record, predicate: whenPredicate, listDir });
    if (!whenOutcome.passed) {
      upsertRecord({
        db,
        row: {
          ...record,
          [statusColumn]: 'skipped',
        },
      });
      summary.skipped_when += 1;
      summary.record_ids.push(recordId);
      emitActivity({ event: 'row_skipped', phase: 'pipeline', step: id, row: rowLabel, reason: String(whenOutcome.reason || 'when_not_matched') });
      return;
    }

    const depHash = enrichDepHash(stepConfig, {});
    const cached = readStaleness({ db, recordId, stepId: id });

    const expectedOutputs = Object.keys(declaredOutputs).length > 0
      ? declaredOutputs
      : legacyColumns;
    if (
      isEnrichFresh({ cached, stepConfig, depValues: {}, force })
      && declaredOutputsHaveAnyValue({ record, expectedOutputs })
    ) {
      summary.skipped_fresh += 1;
      return;
    }

    const runAttempt = async (attempt: number) => {
      const inputRecord = mergedRecordForEnrichment({ db, record });
      const result = await executeEnrichmentAction({
        mcp,
        listDir,
        stepId: id,
        description: step?.description || id,
        stepConfig,
        record: inputRecord,
        aiConfig: config?.ai || {},
        context: {
          phase: 'pipeline',
          step: id,
          linked_duplicates: db.prepare('SELECT _row_id, business_name FROM records WHERE duplicate_of = ?').all(recordId),
        },
        outputSchema: outputZod,
        toolCatalog,
      });

      const outputs = result.outputs || {};
      const outcome = outputOutcomeFor({ outputs, expectedOutputs });

      recordCostEvent({
        db,
        listDir,
        recordId,
        stepId: `pipeline_enrich:${id}`,
        model: String((result as any)?.model || ''),
        provider: String((result as any)?.provider || ''),
        usage: result.usage,
      });
      if (outcome === 'ok') outputZod.parse(outputs);

      const patch = applyOutputs({
        step: { ...step, config: stepConfig, __list_dir: listDir },
        outputs,
      });
      patch[statusColumn] = outcome;
      const currentRow = db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1').get(recordId, recordId) || record;
      const merged = { ...currentRow, ...patch };
      upsertRecord({ db, row: merged });
      upsertPrimaryContactIfPresent({ db, record: merged });
      writeStaleness({
        db,
        recordId,
        stepId: id,
        depHash,
        cacheTtlSeconds: ttlToSeconds(stepConfig?.cache),
        cacheTtl: String(stepConfig?.cache || ''),
      });
      summary.processed += 1;
      summary.record_ids.push(recordId);
      emitActivity({ event: 'row_complete', phase: 'pipeline', step: id, row: rowLabel, outcome });
      return { outcome, attempt };
    };

    try {
      await runAttempt(1);
    } catch (error) {
      recordErroredProviderToolCost({
        db,
        listDir,
        recordId,
        stepId: `pipeline_enrich:${id}`,
        error,
      });
      if (isBudgetExceededError(error)) throw error;
      if (enrichStepUsesEmptyOnError(stepConfig)) {
        const outputs = emptyOutputsFor(outputZod);
        const patch = applyOutputs({
          step: { ...step, config: stepConfig, __list_dir: listDir },
          outputs,
        });
        patch[statusColumn] = 'empty';
        const currentRow = db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1').get(recordId, recordId) || record;
        const merged = { ...currentRow, ...patch };
        upsertRecord({ db, row: merged });
        writeStaleness({
          db,
          recordId,
          stepId: id,
          depHash,
          cacheTtlSeconds: ttlToSeconds(stepConfig?.cache),
          cacheTtl: String(stepConfig?.cache || ''),
        });
        summary.processed += 1;
        summary.record_ids.push(recordId);
        emitActivity({ event: 'row_complete', phase: 'pipeline', step: id, row: rowLabel, outcome: 'empty' });
        return;
      }
      const firstDetail = formatErrorMessage(error);
      emitActivity({ event: 'row_retry', phase: 'pipeline', step: id, row: rowLabel, detail: firstDetail });
      try {
        await runAttempt(2);
        return;
      } catch (retryError) {
        recordErroredProviderToolCost({
          db,
          listDir,
          recordId,
          stepId: `pipeline_enrich:${id}`,
          error: retryError,
        });
        if (isBudgetExceededError(retryError)) throw retryError;
        const detail = formatErrorMessage(retryError);
        summary.failed += 1;
        summary.errors.push({ record_id: recordId, error: detail });
        upsertRecord({
          db,
          row: {
            ...record,
            [statusColumn]: 'failed',
            retry_count: Number(record.retry_count || 0) + 1,
            last_error: detail,
          },
        });
        summary.record_ids.push(recordId);
        emitActivity({ event: 'error', phase: 'pipeline', step: id, row: rowLabel, detail, retried: true });
      }
    }
  }, concurrency);

  return summary;
};

type EnrichmentStepNode = {
  id: string;
  index: number;
  step: any;
  dependsOn: string[];
};

const buildEnrichmentDag = (steps: any[]): {
  levels: EnrichmentStepNode[][];
  ancestors: Map<string, Set<string>>;
} => {
  const nodes: EnrichmentStepNode[] = (steps || []).map((step, index) => ({
    id: resolveStepId(step, index),
    index,
    step,
    dependsOn: Array.isArray(step?.config?.depends_on) ? step.config.depends_on : [],
  }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const parents = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  for (const node of nodes) {
    parents.set(node.id, new Set<string>());
    children.set(node.id, new Set<string>());
    indegree.set(node.id, 0);
  }

  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      const text = String(dep || '').trim();
      if (!text) continue;
      let upstream = '';
      if (nodeById.has(text)) {
        upstream = text;
      } else if (text.includes('.')) {
        const prefix = text.split('.')[0];
        if (nodeById.has(prefix)) upstream = prefix;
      }
      if (!upstream || upstream === node.id) continue;
      if (!children.get(upstream)?.has(node.id)) {
        children.get(upstream)?.add(node.id);
        parents.get(node.id)?.add(upstream);
        indegree.set(node.id, Number(indegree.get(node.id) || 0) + 1);
      }
    }
  }

  const ready: EnrichmentStepNode[] = nodes
    .filter((node) => Number(indegree.get(node.id) || 0) === 0)
    .sort((a, b) => a.index - b.index);
  const levels: EnrichmentStepNode[][] = [];
  const topo: string[] = [];

  while (ready.length > 0) {
    const currentLevel = [...ready].sort((a, b) => a.index - b.index);
    ready.length = 0;
    levels.push(currentLevel);

    for (const node of currentLevel) {
      topo.push(node.id);
      const outgoing = [...(children.get(node.id) || new Set<string>())]
        .map((id) => nodeById.get(id))
        .filter(Boolean) as EnrichmentStepNode[];
      for (const nextNode of outgoing) {
        const nextDegree = Number(indegree.get(nextNode.id) || 0) - 1;
        indegree.set(nextNode.id, nextDegree);
        if (nextDegree === 0) ready.push(nextNode);
      }
    }
  }

  if (topo.length !== nodes.length) {
    const unresolved = nodes
      .filter((node) => !topo.includes(node.id))
      .map((node) => node.id);
    throw new Error(`Enrichment dependency cycle detected: ${unresolved.join(', ')}`);
  }

  const ancestors = new Map<string, Set<string>>();
  for (const id of topo) {
    const set = new Set<string>();
    for (const parent of parents.get(id) || new Set<string>()) {
      set.add(parent);
      for (const ancestor of ancestors.get(parent) || new Set<string>()) {
        set.add(ancestor);
      }
    }
    ancestors.set(id, set);
  }

  return { levels, ancestors };
};

export const runEnrichment = async ({ listDir, stepId = '', where = '', limit = 0, force = false }) => {
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) {
    throw new Error(`Invalid config: ${errors.join('; ')}`);
  }
  assertPhaseModelReferences({ config, phase: 'pipeline' });

  const enrichSteps = (Array.isArray(config.pipeline) ? config.pipeline : []).filter((step: any) => step?.kind === 'enrich');
  const stepIdMatch = (step: any) => {
    const topId = String(step?.id || '').trim();
    const configId = String(step?.config?.id || '').trim();
    return topId === String(stepId).trim() || configId === String(stepId).trim();
  };
  const selectedSteps = stepId
    ? enrichSteps.filter(stepIdMatch)
    : enrichSteps;
  const { levels, ancestors } = buildEnrichmentDag(selectedSteps);
  const knownStepIds = new Set(selectedSteps.map((step: any, index: number) => resolveStepId(step, index)));

  const db = openListDb({ listDir, readonly: false });
  const whereSql = String(where || '').trim();
  const limitN = Number(limit || 0);
  const params: any[] = [];
  let rowsSql = `SELECT * FROM records WHERE sequence_status != 'opted_out' AND ${inPlayWhere()}`;
  if (whereSql) rowsSql += ` AND (${whereSql})`;
  rowsSql += ' ORDER BY updated_at DESC';
  if (limitN > 0) {
    rowsSql += ' LIMIT ?';
    params.push(limitN);
  }
  const rows = db.prepare(rowsSql).all(...params);
  const recordState = new Map<string, any>();
  for (const row of rows) {
    recordState.set(getRecordRowId(row), row);
  }
  const mcpState: { client: any } = { client: null };
  const mcpForStep = async (stepConfig: any) => {
    if (!enrichmentStepNeedsMcp(stepConfig, { listDir })) return null;
    if (!mcpState.client) mcpState.client = await getMcpClient();
    return mcpState.client;
  };
  const toolCatalog = readToolCatalog(listDir);

  const summary = {
    steps: selectedSteps.length,
    rows_total: rows.length,
    processed: 0,
    skipped_fresh: 0,
    skipped_upstream: 0,
    skipped_when: 0,
    failed: 0,
    errors: [],
  };

  emitActivity({ event: 'phase_start', phase: 'enrichment', steps: selectedSteps.length, rows: rows.length });

  try {
    const failedByRecord = new Map<string, Set<string>>();
    const markStepFailure = (recordId: string, stepKey: string) => {
      const next = failedByRecord.get(recordId) || new Set<string>();
      next.add(stepKey);
      failedByRecord.set(recordId, next);
    };

    const hasFailedAncestor = (recordId: string, stepKey: string) => {
      const failed = failedByRecord.get(recordId);
      if (!failed || failed.size === 0) return false;
      const deps = ancestors.get(stepKey) || new Set<string>();
      for (const dep of deps) {
        if (failed.has(dep)) return true;
      }
      return false;
    };

    for (const level of levels) {
      const levelResults = await Promise.all(level.map(async (node) => {
        const step = node.step;
        const id = node.id;
        const rawDependsOn = Array.isArray(step?.config?.depends_on) ? step.config.depends_on : [];
        const missingDeps = rawDependsOn
          .map((dep: any) => String(dep || '').trim())
          .filter(Boolean)
          .filter((dep: string) => {
            const ref = dep.includes('.') ? dep.split('.')[0] : dep;
            return !knownStepIds.has(ref);
          });
        if (missingDeps.length > 0) {
          const detail = `Skipping "${id}": missing dependency ${missingDeps.map((dep) => `"${dep}"`).join(', ')}`;
          emitActivity({ event: 'warning', phase: 'enrichment', step: id, detail });
          summary.errors.push({ step: id, warning: detail });
          return { id, patches: [], failures: [] };
        }
        const declaredOutputs = getDeclaredOutputs(step?.config || {});
        const legacyColumns = getLegacyColumns(step?.config || {});
        const outputZod = buildOutputZodSchema(declaredOutputs, legacyColumns);
        const concurrency = Number(step?.config?.concurrency || 3);
        const targetColumns = getTargetColumnsForStepConfig(step?.config || {});
        const statusColumn = `${id}__status`;
        const whenPredicate = whenPredicateForStep({ step, stepConfig: step?.config || {} });
        ensureRecordColumns({ db, columns: [...targetColumns, { name: statusColumn, type: 'TEXT' }] });

        emitActivity({ event: 'step_start', phase: 'enrichment', step: id, rows: recordState.size });

        const patches: Array<{
          recordId: string;
          rowLabel: string;
          patch: Record<string, any>;
          depHash: string;
          cacheTtlSeconds: number;
          cacheTtl: string;
          skippedWhen?: boolean;
        }> = [];
        const failures: Array<{ recordId: string; rowLabel: string; error: string }> = [];
        const snapshot = [...recordState.values()];

        await mapWithConcurrency(snapshot, async (record) => {
          const recordId = getRecordRowId(record);
          const rowLabel = String(record?.business_name || recordId);

          if (hasFailedAncestor(recordId, id)) {
            summary.skipped_upstream += 1;
            emitActivity({ event: 'row_skipped', phase: 'enrichment', step: id, row: rowLabel, reason: 'upstream_failed' });
            return;
          }

          const whenOutcome = shouldRunForRecord({ record, predicate: whenPredicate, listDir });
          if (!whenOutcome.passed) {
            patches.push({
              recordId,
              rowLabel,
              patch: { [statusColumn]: 'skipped' },
              depHash: '',
              cacheTtlSeconds: 0,
              cacheTtl: '',
              skippedWhen: true,
            });
            emitActivity({ event: 'row_skipped', phase: 'enrichment', step: id, row: rowLabel, reason: String(whenOutcome.reason || 'when_not_matched') });
            return;
          }

          const dependsOn = Array.isArray(step?.config?.depends_on) ? step.config.depends_on : [];
          const depValues: Record<string, any> = {};
          const extra = parseExtra(record.extra_json);
          for (const dep of dependsOn) {
            depValues[dep] = dependencyValueForRecord({ dep, record, extra });
          }
          const depHash = enrichDepHash(step?.config || {}, depValues);
          const cached = readStaleness({ db, recordId, stepId: id });

          const expectedOutputs = Object.keys(declaredOutputs).length > 0
            ? declaredOutputs
            : legacyColumns;
          if (
            isEnrichFresh({ cached, stepConfig: step?.config || {}, depValues, force })
            && declaredOutputsHaveAnyValue({ record, expectedOutputs })
          ) {
            summary.skipped_fresh += 1;
            return;
          }

          try {
            const inputRecord = mergedRecordForEnrichment({ db, record });
            const stepConfig = step?.config || {};
            const result = await executeEnrichmentAction({
              mcp: await mcpForStep(stepConfig),
              listDir,
              stepId: id,
              description: step?.description || id,
              stepConfig,
              record: inputRecord,
              aiConfig: config?.ai || {},
              context: {
                phase: 'enrichment',
                step: id,
                linked_duplicates: db.prepare('SELECT _row_id, business_name FROM records WHERE duplicate_of = ?').all(recordId),
              },
              outputSchema: outputZod,
              toolCatalog,
            });

            const outputs = result.outputs || {};
            const outcome = outputOutcomeFor({ outputs, expectedOutputs });
            if (
              outcome === 'empty'
              && !enrichStepUsesEmptyOnError(stepConfig)
              && Object.keys(expectedOutputs).length > 0
              && Object.keys(outputs).length === 0
            ) {
              throw new Error(`Step "${id}" returned no outputs for declared outputs.`);
            }

            recordCostEvent({
              db,
              listDir,
              recordId,
              stepId: `enrich:${id}`,
              model: String((result as any)?.model || ''),
              provider: String((result as any)?.provider || ''),
              usage: result.usage,
            });
            if (outcome === 'ok') outputZod.parse(outputs);

            const patch = applyOutputs({
              step: { ...step, __list_dir: listDir },
              outputs,
            });
            patch[statusColumn] = outcome;
            patches.push({
              recordId,
              rowLabel,
              patch,
              depHash,
              cacheTtlSeconds: ttlToSeconds(step?.config?.cache),
              cacheTtl: String(step?.config?.cache || ''),
              skippedWhen: false,
            });
          } catch (error) {
            recordErroredProviderToolCost({
              db,
              listDir,
              recordId,
              stepId: `enrich:${id}`,
              error,
            });
            if (isBudgetExceededError(error)) throw error;
            const neutralStepConfig = step?.config && typeof step.config === 'object' ? step.config : step;
            if (enrichStepUsesEmptyOnError(neutralStepConfig)) {
              const outputs = emptyOutputsFor(outputZod);
              const patch = applyOutputs({
                step: { ...step, __list_dir: listDir },
                outputs,
              });
              patch[statusColumn] = 'empty';
              patches.push({
                recordId,
                rowLabel,
                patch,
                depHash,
                cacheTtlSeconds: ttlToSeconds(neutralStepConfig?.cache),
                cacheTtl: String(neutralStepConfig?.cache || ''),
                skippedWhen: false,
              });
              return;
            }
            const detail = formatErrorMessage(error);
            markStepFailure(recordId, id);
            failures.push({ recordId, rowLabel, error: detail });
            emitActivity({ event: 'error', phase: 'enrichment', step: id, row: rowLabel, detail });
          }
        }, concurrency);

        emitActivity({ event: 'step_complete', phase: 'enrichment', step: id });
        return { id, patches, failures };
      }));

      for (const result of levelResults) {
        for (const item of result.patches) {
          try {
            const currentRow = recordState.get(item.recordId)
              || db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1').get(item.recordId, item.recordId)
              || {};
            const merged = { ...currentRow, ...item.patch };
            upsertRecord({ db, row: merged });
            upsertPrimaryContactIfPresent({ db, record: merged });
            if (!item.skippedWhen) {
              writeStaleness({
                db,
                recordId: item.recordId,
                stepId: result.id,
                depHash: item.depHash,
                cacheTtlSeconds: item.cacheTtlSeconds,
                cacheTtl: item.cacheTtl,
              });
            }
            recordState.set(item.recordId, merged);
            if (item.skippedWhen) {
              summary.skipped_when += 1;
            } else {
              summary.processed += 1;
              emitActivity({ event: 'row_complete', phase: 'enrichment', step: result.id, row: item.rowLabel });
            }
          } catch (error) {
            if (isBudgetExceededError(error)) throw error;
            const detail = formatErrorMessage(error);
            markStepFailure(item.recordId, result.id);
            summary.failed += 1;
            summary.errors.push({ step: result.id, record_id: item.recordId, error: detail });
            emitActivity({ event: 'error', phase: 'enrichment', step: result.id, row: item.rowLabel, detail });
          }
        }

        for (const failure of result.failures) {
          summary.failed += 1;
          summary.errors.push({ step: result.id, record_id: failure.recordId, error: failure.error });
          const currentRow = recordState.get(failure.recordId);
          if (currentRow) {
            const updated = {
              ...currentRow,
              retry_count: Number(currentRow.retry_count || 0) + 1,
              last_error: failure.error,
            };
            upsertRecord({ db, row: updated });
            recordState.set(failure.recordId, updated);
          }
        }
      }
    }

    emitActivity({
      event: 'phase_complete',
      phase: 'enrichment',
      processed: summary.processed,
      skipped: summary.skipped_fresh + summary.skipped_upstream,
      failed: summary.failed,
    });
    return summary;
  } finally {
    db.close();
  }
};
