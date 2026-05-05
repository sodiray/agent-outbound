import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ensureRecordColumns, openListDb, upsertContact, upsertRecord, nowTimestamp } from '../runtime/db.js';
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

const parseExtra = (value) => {
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

const mergedRecordForEnrichment = ({ db, record }) => {
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

const writeStaleness = ({ db, recordId, stepId, depHash, cacheTtlSeconds, cacheTtl }) => {
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

const readStaleness = ({ db, recordId, stepId }) =>
  db.prepare('SELECT * FROM staleness WHERE record_id = ? AND step_id = ?').get(recordId, stepId);

const ttlToSeconds = (ttl) => {
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

const isStale = ({ cached, depHash }) => {
  if (!cached) return true;
  if (String(cached.dep_hash || '') !== String(depHash || '')) return true;
  const ttl = Number(cached.cache_ttl_seconds || 0);
  if (ttl <= 0) return true;
  const updatedAt = new Date(String(cached.updated_at || 0)).getTime();
  return (Date.now() - updatedAt) / 1000 > ttl;
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

const getDeclaredOutputs = (stepConfig: any): Record<string, OutputDef> => {
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

const getLegacyColumns = (stepConfig: any): Record<string, string> => {
  return (stepConfig?.columns && typeof stepConfig.columns === 'object')
    ? stepConfig.columns
    : {};
};

const buildOutputZodSchema = (outputs: Record<string, OutputDef>, legacyColumns: Record<string, string>) => {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, def] of Object.entries(outputs)) {
    if (def.enum?.length) {
      const enumValues = def.enum.map((v) => String(v));
      if (enumValues.length >= 1) {
        shape[key] = z.enum(enumValues as [string, ...string[]]).describe(def.description);
      }
      continue;
    }

    if (def.type === 'boolean') {
      shape[key] = z.boolean().describe(def.description);
    } else if (def.type === 'integer') {
      shape[key] = z.number().int().describe(def.description);
    } else if (def.type === 'number') {
      shape[key] = z.number().describe(def.description);
    } else {
      shape[key] = z.string().describe(def.description);
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
  if (value === null || value === undefined) return type === 'string' ? '' : 0;
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

const dependencyValueForRecord = ({ dep, record, extra }) => {
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

export const runEnrichment = async ({ listDir, stepId = '', where = '', limit = 0 }) => {
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) {
    throw new Error(`Invalid config: ${errors.join('; ')}`);
  }
  assertPhaseModelReferences({ config, phase: 'enrich' });

  const enrichSteps = Array.isArray(config.enrich) ? config.enrich : [];
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
  let rowsSql = "SELECT * FROM records WHERE sequence_status != 'opted_out'";
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
  const mcp = await getMcpClient();
  const toolCatalog = readToolCatalog(listDir);

  const summary = {
    steps: selectedSteps.length,
    rows_total: rows.length,
    processed: 0,
    skipped_fresh: 0,
    skipped_upstream: 0,
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
        if (targetColumns.length > 0) {
          ensureRecordColumns({ db, columns: targetColumns });
        }

        emitActivity({ event: 'step_start', phase: 'enrichment', step: id, rows: recordState.size });

        const patches: Array<{
          recordId: string;
          rowLabel: string;
          patch: Record<string, any>;
          depHash: string;
          cacheTtlSeconds: number;
          cacheTtl: string;
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

          const dependsOn = Array.isArray(step?.config?.depends_on) ? step.config.depends_on : [];
          const depValues: Record<string, any> = {};
          const extra = parseExtra(record.extra_json);
          for (const dep of dependsOn) {
            depValues[dep] = dependencyValueForRecord({ dep, record, extra });
          }
          const depHash = stableHash({ depValues, config: step?.config || {} });
          const cached = readStaleness({ db, recordId, stepId: id });

          if (!isStale({ cached, depHash })) {
            summary.skipped_fresh += 1;
            return;
          }

          try {
            const inputRecord = mergedRecordForEnrichment({ db, record });
            const result = await executeStepAction({
              mcp,
              listDir,
              stepId: id,
              description: step?.description || id,
              stepConfig: step?.config || {},
              record: inputRecord,
              aiConfig: config?.ai || {},
              role: 'research',
              context: {
                phase: 'enrichment',
                step: id,
                linked_duplicates: db.prepare('SELECT _row_id, business_name FROM records WHERE duplicate_of = ?').all(recordId),
              },
              outputSchema: outputZod,
              toolCatalog,
            });

            const expectedOutputs = Object.keys(declaredOutputs).length > 0
              ? declaredOutputs
              : legacyColumns;
            if (Object.keys(expectedOutputs).length > 0 && Object.keys(result.outputs || {}).length === 0) {
              throw new Error(`Step "${id}" returned no outputs for declared outputs.`);
            }

            outputZod.parse(result.outputs || {});
            recordCostEvent({
              db,
              listDir,
              recordId,
              stepId: `enrich:${id}`,
              model: String((result as any)?.model || ''),
              provider: String((result as any)?.provider || ''),
              usage: result.usage,
            });

            const patch = applyOutputs({
              step: { ...step, __list_dir: listDir },
              outputs: result.outputs || {},
            });
            patches.push({
              recordId,
              rowLabel,
              patch,
              depHash,
              cacheTtlSeconds: ttlToSeconds(step?.config?.cache),
              cacheTtl: String(step?.config?.cache || ''),
            });
          } catch (error) {
            if (isBudgetExceededError(error)) throw error;
            const detail = String(error?.message || error);
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
            writeStaleness({
              db,
              recordId: item.recordId,
              stepId: result.id,
              depHash: item.depHash,
              cacheTtlSeconds: item.cacheTtlSeconds,
              cacheTtl: item.cacheTtl,
            });
            recordState.set(item.recordId, merged);
            summary.processed += 1;
            emitActivity({ event: 'row_complete', phase: 'enrichment', step: result.id, row: item.rowLabel });
          } catch (error) {
            if (isBudgetExceededError(error)) throw error;
            const detail = String(error?.message || error);
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
