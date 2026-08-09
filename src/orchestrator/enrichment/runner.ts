import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { ensureRecordColumns, inPlayWhere, openListDb, storeRawContent, upsertContact, upsertRecord, nowTimestamp } from '../runtime/db.js';
import { readConfig } from '../lib/config.js';
import { getRecordRowId, nowIso, stableHash } from '../lib/record.js';
import { executeStepAction } from '../actions/execute-step/index.js';
import { readPromptFileIfAny } from '../actions/shared.js';
import { emitActivity } from '../runtime/activity.js';
import { recordCostEvent } from '../lib/costs.js';
import { getMcpClient } from '../runtime/mcp.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { readToolCatalog } from '../lib/tool-catalog.js';
import { getTargetColumnsForStepConfig } from '../lib/step-columns.js';
import { flattenPipelineSteps, stepStatusColumn } from '../lib/subpipelines.js';
import { isBudgetExceededError } from '../runtime/contract.js';
import { assertPhaseModelReferences } from '../lib/model-validation.js';
import {
  skippedWhenOutcome,
  shouldRunForRecord,
  stepConfigForWhen,
  whenPredicateForStep,
} from '../lib/step-when.js';
import { nullableBoolean, nullableNumber, nullableString } from '../actions/schema-helpers.js';
import { formatErrorMessage } from '../lib/error-format.js';
import { toolSpecNeedsMcp, type ToolCatalog, type ToolSpec } from '../runtime/tools.js';
import { providerToolUsageFromError } from '../runtime/providers/usage.js';
import { decisionMakerProviderNeedsMcp } from '../runtime/providers/decision-makers/index.js';
import { executeDecisionMakersAction } from './actions/decision-makers.js';
import { executeToolCallAction, isRecordScopedProviderToolError } from './actions/tool-call.js';
import { executeLinkedinCompanyResolutionAction } from './actions/linkedin-company-resolution.js';
import {
  buildEnrichEvidencePatch,
  EVIDENCE_RECORD_COLUMNS,
  latestRetrievalSnapshot,
  preservePriorNonBlankFields,
} from '../policy/evidence.js';
import { evaluateEnrichmentCeilingGate } from '../policy/cost-ledger.js';
import { loadVerticalTaxonomy } from '../policy/taxonomy.js';
import type { FitModelConfigInput } from '../policy/scoring.js';
import { resolvePipelineFitModel } from '../scoring/fit-model.js';
import type { TreatmentBandLadders } from '../policy/treatment.js';
import type {
  ActionConfidenceConfigInput,
  BuyerConfidenceConfigInput,
  CandidateTierConfigInput,
  EnrichmentBudgetConfigInput,
  EnrichmentRepairConfigInput,
  IdentityConfidenceConfigInput,
  MailConfidenceConfigInput,
  PhoneConfidenceConfigInput,
  PriorityConfigInput,
  ReachabilityConfigInput,
  ContactPolicyConfigInput,
  TreatmentStrategyConfigInput,
} from '../../schemas/config.js';

const zeroUsage = () => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_tokens: 0,
  cache_read_tokens: 0,
  usd_cost: 0,
  tool_calls: [] as unknown[],
  tool_costs: [] as unknown[],
});

/** Structured skip from executeEnrichmentAction when over tier enrichment ceiling. */
export type EnrichmentCeilingSkipResult = {
  outputs: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  usage: ReturnType<typeof zeroUsage>;
  model: string;
  provider: string;
  skipped: true;
  skip_reason: 'enrichment_ceiling';
  skip_detail: string;
};

export const isEnrichmentCeilingSkip = (result: unknown): result is EnrichmentCeilingSkipResult => (
  Boolean(
    result
    && typeof result === 'object'
    && (result as EnrichmentCeilingSkipResult).skipped === true
    && (result as EnrichmentCeilingSkipResult).skip_reason === 'enrichment_ceiling',
  )
);

/** Evidence + status patch when an enrich/generate step is blocked by the spend ceiling. */
export const enrichmentCeilingSkipPatch = ({
  record,
  stepId,
  stepConfig,
  detail,
  statusColumn,
}: {
  record: Record<string, unknown>;
  stepId: string;
  stepConfig?: Record<string, unknown>;
  detail: string;
  statusColumn?: string;
}): Record<string, unknown> => {
  const evidencePatch = buildEnrichEvidencePatch({
    record,
    step_id: stepId,
    step_config: stepConfig,
    error: detail || 'enrichment_ceiling',
    failed: true,
  });
  const patch: Record<string, unknown> = {
    ...evidencePatch,
  };
  if (statusColumn) patch[statusColumn] = 'skipped';
  return patch;
};

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

export const writeStaleness = ({ db, recordId, stepId, depHash, inputHash = '', policyHash = '', cacheTtlSeconds, cacheTtl }) => {
  db.prepare(`
    INSERT INTO staleness (id, record_id, step_id, dep_hash, input_hash, policy_hash, cache_ttl, cache_ttl_seconds, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(record_id, step_id) DO UPDATE SET
      dep_hash = excluded.dep_hash,
      input_hash = excluded.input_hash,
      policy_hash = excluded.policy_hash,
      cache_ttl = excluded.cache_ttl,
      cache_ttl_seconds = excluded.cache_ttl_seconds,
      updated_at = excluded.updated_at
  `).run(randomUUID(), recordId, stepId, depHash, inputHash, policyHash, String(cacheTtl || ''), cacheTtlSeconds, nowTimestamp());
};

export const readStaleness = ({ db, recordId, stepId }) =>
  db.prepare('SELECT * FROM staleness WHERE record_id = ? AND step_id = ?').get(recordId, stepId);

const clearStaleness = ({ db, recordId, stepId }) => {
  db.prepare('DELETE FROM staleness WHERE record_id = ? AND step_id = ?').run(recordId, stepId);
};

const lastErrorBelongsToStep = ({ lastError, stepId }: { lastError: unknown; stepId: string }) => {
  const detail = String(lastError || '');
  return detail.startsWith(`execute-step failed (${stepId}):`)
    || detail.startsWith(`enrichment step failed (${stepId}):`);
};

const ownedLastError = ({ error, stepId }: { error: unknown; stepId: string }) => {
  const detail = String(error || 'failed');
  if (lastErrorBelongsToStep({ lastError: detail, stepId })) return detail;
  return `enrichment step failed (${stepId}): ${detail}`;
};

const clearedLastErrorPatch = ({ record, stepId }: { record: Record<string, unknown>; stepId: string }) => (
  lastErrorBelongsToStep({ lastError: record.last_error, stepId }) ? { last_error: '' } : {}
);

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
const MATERIAL_ENRICH_FIELDS = [
  'action',
  'tool',
  'waterfall',
  'fallback_tools',
  'args',
  'args_map',
  'output_map',
  'outputs',
  'model',
  'reasoning',
  'prompt_file',
  'prompt_args',
  'depends_on',
  'on_error',
] as const;

/** Score-axis staleness keys written by scoring/runner (shouldRescore). */
export const SCORE_STALENESS_STEP_IDS = ['score:score', 'score:fit', 'score:trigger'] as const;

/**
 * Clear score cache after material evidence mutation so the next dataflow /
 * re-score run recomputes fit. Failures do not mark stale (no new usable evidence).
 * Returns number of staleness rows deleted.
 */
export const markScoringStale = ({
  db,
  recordId,
}: {
  db: any;
  recordId: string;
}): number => {
  const id = String(recordId || '').trim();
  if (!db || !id) return 0;
  try {
    const result = db.prepare(`
      DELETE FROM staleness
      WHERE record_id = ?
        AND (
          step_id = 'score:score'
          OR step_id = 'score:fit'
          OR step_id = 'score:trigger'
          OR step_id LIKE 'score:%'
        )
    `).run(id);
    return Number(result?.changes || 0);
  } catch {
    return 0;
  }
};

/**
 * True when an enrich evidence patch wrote a durable retrieval snapshot (not
 * tool_failure). Used to decide whether to mark scoring stale + score_status.
 */
export const evidencePatchIsMaterialRetrieval = (patch: Record<string, unknown> | null | undefined): boolean => {
  if (!patch || typeof patch !== 'object') return false;
  const snap = latestRetrievalSnapshot(patch);
  if (!snap) return false;
  const kind = String(snap.kind || '').trim().toLowerCase();
  if (kind === 'tool_failure' || kind === 'error') return false;
  return kind === 'retrieval' || Boolean(snap.content_hash || snap.excerpt || snap.source_id);
};

/** Patch fragment for records when scoring must re-run after evidence mutation. */
export const scoringStaleRecordPatch = (): Record<string, unknown> => ({
  score_status: 'stale',
});

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
export const enrichmentPolicyInputs = (config: Record<string, any> = {}) => {
  const score = config.score || {};
  const { fitModel } = resolvePipelineFitModel(config);
  return {
    fitModel,
    treatmentBands: score.treatment_bands,
    treatmentStrategy: score.treatment,
    priority: score.priority,
    identityConfidence: score.identity_confidence,
    phoneConfidence: score.phone_confidence,
    buyerConfidence: score.buyer_confidence,
    mailConfidence: score.mail_confidence,
    actionConfidence: score.action_confidence,
    reachability: score.reachability,
    candidateTier: score.candidate_tier,
    enrichmentRepair: score.enrichment_repair,
    enrichmentBudget: score.enrichment_budget,
    contactPolicy: config.contact_policy,
  };
};

export const executionConfigForEnrichmentStep = ({
  stepConfig,
  config,
  listDir = '',
}: {
  stepConfig: Record<string, unknown>;
  config: Record<string, any>;
  listDir?: string;
}): Record<string, unknown> | undefined => (
  (() => {
    const isPolicyApply = String(stepConfig.action || '').trim().toLowerCase() === 'policy_apply';
    const promptFile = String(stepConfig.prompt_file || '').trim();
    if (!isPolicyApply && !promptFile) return undefined;
    return {
      ...(isPolicyApply
        ? { policy: enrichmentPolicyInputs(config), taxonomy: loadVerticalTaxonomy(listDir) }
        : {}),
      ...(promptFile ? { prompt_file: { path: promptFile, body: readPromptFileIfAny({ listDir, promptFile }) } } : {}),
    };
  })()
);

export const enrichDependencyHashes = ({
  stepConfig,
  depValues = {},
  executionConfig,
}: {
  stepConfig: any;
  depValues?: Record<string, any>;
  executionConfig?: Record<string, unknown>;
}) => {
  const inputHash = stableHash({ depValues, config: materialEnrichConfig(stepConfig) });
  const policyHash = executionConfig === undefined ? '' : stableHash(executionConfig);
  return {
    inputHash,
    policyHash,
    depHash: stableHash({ inputHash, policyHash }),
  };
};

export const enrichDepHash = (stepConfig: any, depValues: Record<string, any> = {}, executionConfig?: Record<string, unknown>) =>
  executionConfig === undefined
    ? stableHash({ depValues, config: materialEnrichConfig(stepConfig) })
    : enrichDependencyHashes({ stepConfig, depValues, executionConfig }).depHash;
const legacyEnrichDepHash = (stepConfig: any, depValues: Record<string, any> = {}) =>
  stableHash({ depValues, config: stepConfig || {} });

// A record is FRESH for an enrich step when: not forced, a staleness row exists,
// its hash matches the material (or legacy) hash, AND it is within TTL. A step
// with NO configured TTL (cache_ttl_seconds <= 0) caches FOREVER — so an
// unchanged step is never redundantly re-run. TTL is opt-in periodic refresh.
export const isEnrichFresh = ({ cached, stepConfig, depValues = {}, executionConfig, force = false }: { cached: any; stepConfig: any; depValues?: Record<string, any>; executionConfig?: Record<string, unknown>; force?: boolean }): boolean => {
  if (force || !cached) return false;
  const material = enrichDepHash(stepConfig, depValues, executionConfig);
  const legacy = legacyEnrichDepHash(stepConfig, depValues);
  const matched = String(cached.dep_hash || '') === material
    || (executionConfig === undefined && String(cached.dep_hash || '') === legacy);
  if (!matched) return false;
  const ttl = Number(cached.cache_ttl_seconds || 0);
  if (ttl <= 0) return true; // no TTL configured = cache forever
  const updatedAt = new Date(String(cached.updated_at || 0)).getTime();
  return (Date.parse(nowIso()) - updatedAt) / 1000 <= ttl;
};

export const enrichRerunReason = ({
  cached,
  stepConfig,
  depValues = {},
  executionConfig,
}: {
  cached: any;
  stepConfig: any;
  depValues?: Record<string, any>;
  executionConfig?: Record<string, unknown>;
}): string => {
  if (!cached || executionConfig === undefined) return '';
  const hashes = enrichDependencyHashes({ stepConfig, depValues, executionConfig });
  const previousInputHash = String(cached.input_hash || '');
  const previousPolicyHash = String(cached.policy_hash || '');
  if (
    (previousInputHash === hashes.inputHash && previousPolicyHash !== hashes.policyHash)
    || String(cached.dep_hash || '') === hashes.inputHash
  ) return 'rerun_policy_changed';
  return '';
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
  if (String(config.action || '').trim().toLowerCase() !== 'decision_makers') return false;
  return decisionMakerProviderNeedsMcp({ provider: String(config.provider || '') });
};

export const enrichmentStepConfig = stepConfigForWhen;

export const enrichmentStepNeedsMcp = (step: unknown, options: { listDir?: string } = {}) => {
  const stepConfig = enrichmentStepConfig(step);
  return enrichmentActionNeedsMcp(stepConfig) || toolSpecNeedsMcp(stepConfig.tool as ToolSpec | undefined, options);
};

export { shouldRunForRecord, whenPredicateForStep } from '../lib/step-when.js';

const applyOutputs = ({ step, outputs }) => {
  const patch: Record<string, any> = {};
  const stepConfig = enrichmentStepConfig(step);
  const declaredOutputs = getDeclaredOutputs(stepConfig);
  const legacyColumns = getLegacyColumns(stepConfig);
  const action = String(stepConfig.action || '').trim().toLowerCase();

  if (action === 'policy_apply') {
    return Object.fromEntries(
      Object.entries(outputs || {}).filter(([, value]) => (
        value === null
        || typeof value === 'string'
        || typeof value === 'number'
        || typeof value === 'boolean'
      )),
    );
  }

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

export const declaredOutputWritesFor = ({
  stepConfig,
  outputs,
}: {
  stepConfig: Record<string, unknown>;
  outputs: Record<string, unknown>;
}): Record<string, { provided: boolean; value: unknown }> => {
  const declaredOutputs = getDeclaredOutputs(stepConfig);
  const legacyColumns = getLegacyColumns(stepConfig);
  return Object.fromEntries(Object.entries(declaredOutputs).map(([name, definition]) => {
    const mappedTarget = String(legacyColumns[name] || '').trim();
    const target = mappedTarget || name;
    const provided = Object.prototype.hasOwnProperty.call(outputs, name);
    return [target, {
      provided,
      value: provided ? coerceForSqlite(outputs[name], mappedTarget ? 'string' : definition.type) : undefined,
    }];
  }));
};

/** Ensure evidence JSON columns + score_status exist on the list records table. */
const ensureEvidenceColumns = (db: any) => {
  ensureRecordColumns({
    db,
    columns: [
      ...EVIDENCE_RECORD_COLUMNS,
      // Set to 'stale' after material retrieval so next scoring pass re-runs.
      { name: 'score_status', type: 'TEXT' },
    ],
  });
};

/**
 * Apply tool/enrich outputs without clobbering prior non-blank fields with empties,
 * and attach immutable retrieval snapshot + observations (or tool_failure).
 */
const applyOutputsWithEvidence = ({
  db,
  step,
  stepConfig,
  stepId,
  outputs,
  record,
  provider,
  usage,
  error,
  failed,
}: {
  db: any;
  step: any;
  stepConfig: Record<string, unknown>;
  stepId: string;
  outputs: Record<string, unknown>;
  record: Record<string, unknown>;
  provider?: string;
  usage?: Record<string, unknown> | null;
  error?: string | null;
  failed?: boolean;
}) => {
  const rawPatch = failed
    ? {}
    : applyOutputs({
        step: { ...step, config: stepConfig },
        outputs,
      });
  const action = String(stepConfig.action || '').trim().toLowerCase();
  const preservedPatch = preservePriorNonBlankFields({ record, patch: rawPatch });
  const patch: Record<string, unknown> = action === 'policy_apply' && Object.hasOwn(rawPatch, 'fit_score')
    ? { ...preservedPatch, fit_score: rawPatch.fit_score }
    : preservedPatch;
  const evidencePatch = buildEnrichEvidencePatch({
    record,
    step_id: stepId,
    step_config: stepConfig,
    outputs: failed ? {} : outputs,
    provider,
    usage,
    error,
    failed: Boolean(failed),
    storeRawContent: (content) => {
      storeRawContent({ db, content });
    },
  });
  return { ...patch, ...evidencePatch };
};

/**
 * Create a primary contact from record-level fields, for pipelines that have no
 * `decision_makers` step.
 *
 * It must never overwrite the email of a contact that already exists. Those rows
 * come from `decision_makers`, where every address is checked against the raw
 * provider payload before it is stored. The values reaching this function do not
 * carry that guarantee: they are whatever a general enrichment step put on the
 * record.
 *
 * Skipping that check bound a company inbox to a real named person. `site_profile`
 * returned a shared inbox — which genuinely appears on that site, in its
 * accessibility notice, so the model answered its prompt correctly.
 * `upsertRecord` refused the value, as designed. But this function read it from
 * the in-memory row, and `upsertContact` matches on name+title only, so it landed
 * on the provider-sourced contact row and replaced his address. The projection
 * then republished it to `records.contact_email`,
 * laundering it past the very lock that had rejected it — and the account was one
 * approval away from emailing a real person at an address that was never his.
 *
 * Nobody fabricated anything. A site-wide inbox was bound to a named human.
 */
const upsertPrimaryContactIfPresent = ({ db, record }: { db: any; record: any }) => {
  const contactEmail = String(record?.contact_email || record?.email_primary || '').trim().toLowerCase();
  if (!contactEmail) return;
  const recordId = getRecordRowId(record);
  const existing = db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE row_id = ?').get(recordId);
  if (Number(existing?.n || 0) > 0) return;
  upsertContact({
    db,
    contact: {
      record_id: recordId,
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

export const dependencyFieldsForStep = (stepConfig: Record<string, unknown>) => {
  const dependsOn = Array.isArray(stepConfig.depends_on) ? stepConfig.depends_on : [];
  const inputs = Array.isArray(stepConfig.inputs) ? stepConfig.inputs : [];
  return [...new Set([...dependsOn, ...inputs].map((value) => String(value).trim()).filter(Boolean))];
};

export const dependencyValuesForRecord = ({ stepConfig, record }: {
  stepConfig: Record<string, unknown>;
  record: Record<string, unknown>;
}) => {
  const extra = parseExtra(record.extra_json);
  const depValues: Record<string, unknown> = {};
  for (const dep of dependencyFieldsForStep(stepConfig)) {
    depValues[dep] = dependencyValueForRecord({ dep, record, extra });
  }
  return depValues;
};

const resolveStepId = (step: any, index: number) => {
  const id = String(step?.id || step?.config?.id || '').trim();
  if (id) return id;
  return `enrich_step_${index + 1}`;
};

// Non-writing count of what a pipeline enrich step WOULD do on the given rows:
// how many would actually re-run vs be skipped (fresh cache or `when` mismatch).
// Mirrors the per-record staleness logic in executeEnrichmentStepOnRecords so the
// dry-run impact preview is accurate.
export const countEnrichWorkForStep = ({ db, listDir = '', config = {}, step, stepId = '', rows = [], force = false }: { db: any; listDir?: string; config?: Record<string, any>; step: any; stepId?: string; rows?: any[]; force?: boolean }) => {
  const id = String(stepId || step?.id || '').trim() || 'enrich';
  const stepConfig = enrichmentStepConfig(step);
  const executionConfig = executionConfigForEnrichmentStep({ stepConfig, config, listDir });
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
      isEnrichFresh({ cached, stepConfig, depValues: dependencyValuesForRecord({ stepConfig, record }), executionConfig, force })
      && declaredOutputsHaveAnyValue({ record, expectedOutputs })
    ) { result.skip_fresh += 1; continue; }
    result.would_enrich += 1;
  }
  return result;
};

export const executeEnrichmentAction = async ({
  db,
  mcp,
  listDir,
  stepId,
  description,
  stepConfig,
  record,
  aiConfig,
  context,
  fitModel,
  treatmentBands,
  treatmentStrategy,
  priority,
  identityConfidence,
  phoneConfidence,
  buyerConfidence,
  mailConfidence,
  actionConfidence,
  reachability,
  candidateTier,
  enrichmentRepair,
  enrichmentBudget,
  contactPolicy,
  outputSchema,
  toolCatalog,
}: {
  db?: Parameters<typeof upsertContact>[0]['db'];
  mcp: Client | null;
  listDir: string;
  stepId: string;
  description: string;
  stepConfig: Record<string, unknown>;
  record: Record<string, unknown>;
  aiConfig: Record<string, unknown>;
  context: Record<string, unknown>;
  fitModel?: FitModelConfigInput;
  treatmentBands?: TreatmentBandLadders;
  treatmentStrategy?: TreatmentStrategyConfigInput;
  priority?: PriorityConfigInput;
  identityConfidence?: IdentityConfidenceConfigInput;
  phoneConfidence?: PhoneConfidenceConfigInput;
  buyerConfidence?: BuyerConfidenceConfigInput;
  mailConfidence?: MailConfidenceConfigInput;
  actionConfidence?: ActionConfidenceConfigInput;
  reachability?: ReachabilityConfigInput;
  candidateTier?: CandidateTierConfigInput;
  enrichmentRepair?: EnrichmentRepairConfigInput;
  enrichmentBudget?: EnrichmentBudgetConfigInput;
  contactPolicy?: ContactPolicyConfigInput;
  outputSchema: z.ZodTypeAny;
  toolCatalog?: ToolCatalog;
}) => {
  const action = String(stepConfig?.action || '').trim().toLowerCase();
  const fixtureMode = String(process.env.AO_PIPELINE_FIXTURE || process.env.AO_STEP_FIXTURE || '').trim() === '1';

  // Pre-provider spend gate: when a tiered record is already over its enrichment
  // ceiling, skip tool_call / model generate / decision_makers without calling the provider.
  if (!fixtureMode) {
    const gate = evaluateEnrichmentCeilingGate({ db, record, stepConfig, enrichmentBudget });
    if (gate.apply && !gate.within_budget) {
      const detail = String(gate.detail || gate.reason || 'enrichment_ceiling');
      return {
        outputs: {},
        artifacts: {
          skipped: true,
          reason: 'enrichment_ceiling',
          enrichment_usd: gate.enrichment_usd,
          ceiling: gate.ceiling,
          step_id: stepId,
        },
        usage: zeroUsage(),
        model: '',
        provider: 'cost_blocked',
        skipped: true as const,
        skip_reason: 'enrichment_ceiling' as const,
        skip_detail: detail,
      };
    }
  }

  if (action === 'decision_makers') {
    if (fixtureMode) {
      const outputs: Record<string, unknown> = {
        decision_makers_json: record.decision_makers_json
          || '',
        decision_maker_exists: false,
        contact_name: record.contact_name || '',
        contact_email: record.contact_email || record.email_primary || '',
      };
      return {
        outputs,
        artifacts: { fixture: true, action },
        usage: {
          input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0,
          usd_cost: 0, tool_calls: [], tool_costs: [],
        },
        model: 'fixture',
        provider: 'fixture',
      };
    }
    return executeDecisionMakersAction({
      db,
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
  if (action === 'linkedin_company_resolution') {
    if (fixtureMode) {
      const outputs: Record<string, unknown> = {
        company_resolution: record.company_resolution || 'resolved',
        linkedin_company_url: record.linkedin_company_url || 'https://www.linkedin.com/company/fixture',
      };
      return {
        outputs,
        artifacts: { fixture: true, action },
        usage: {
          input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0,
          usd_cost: 0, tool_calls: [], tool_costs: [],
        },
        model: 'fixture',
        provider: 'fixture',
      };
    }
    return executeLinkedinCompanyResolutionAction({
      db,
      listDir,
      stepConfig,
      record,
      aiConfig,
      identityFields: Array.isArray(context?.source_identity)
        ? context.source_identity.map((field) => String(field || '').trim()).filter(Boolean)
        : [],
    });
  }
  if (action === 'policy_apply') {
    const { applyOutboundPolicy, loadCampaignContactsFromDb, hydrateRecordCostLedger } = await import('../policy/index.js');
    const rowId = String(record._row_id || record.id || '');
    const contacts = db ? loadCampaignContactsFromDb(db, rowId) : [];
    // Production spend lives in cost_events — hydrate ledger before ceilings/GT.
    const costHydrate = db && rowId
      ? hydrateRecordCostLedger({ db, recordId: rowId, record })
      : null;
    const recordForPolicy = {
      ...record,
      ...(costHydrate?.patch || {}),
      _list_dir: record._list_dir || listDir,
    };
    const result = applyOutboundPolicy({
      record: recordForPolicy,
      recomputeFitFromBreakdown: false,
      contacts: contacts.length ? contacts : undefined,
      campaignId: rowId ? `camp_${rowId}` : undefined,
      listDir,
      costLedger: costHydrate?.ledger,
      enrichmentSpendUsd: costHydrate?.enrichment_usd,
      minFitCoverage: Number(context?.min_fit_coverage),
      fitModel,
      treatmentBands,
      treatmentStrategy,
      priority,
      identityConfidence,
      phoneConfidence,
      buyerConfidence,
      mailConfidence,
      actionConfidence,
      reachability,
      candidateTier,
      enrichmentRepair,
      enrichmentBudget,
      contactPolicy,
    });
    // Map declared outputs from patch when present
    const outputs: Record<string, unknown> = { ...result.patch };
    return {
      outputs,
      artifacts: {
        treatment_tier: result.treatment_tier,
        mail_treatment: result.mail_treatment,
        priority_lane: result.priority_lane,
        priority_rank: result.priority_rank,
        integrity_errors: result.integrity_errors,
      },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        usd_cost: 0,
        tool_calls: [],
        tool_costs: [],
      },
      model: '',
      provider: 'policy',
    };
  }
  // Generic model/research enrich under fixture: no model spend; typed declared outputs.
  if (fixtureMode) {
    const declared = (stepConfig?.outputs && typeof stepConfig.outputs === 'object' ? stepConfig.outputs : {}) as Record<string, unknown>;
    const outputs: Record<string, unknown> = {};
    for (const key of Object.keys(declared)) {
      const spec = declared[key];
      const typ = (spec && typeof spec === 'object' && !Array.isArray(spec))
        ? String((spec as any).type || 'string').toLowerCase()
        : 'string';
      const existing = record?.[key];
      if (typ === 'boolean') {
        if (typeof existing === 'boolean') outputs[key] = existing;
        else if (key === 'is_franchise') outputs[key] = false;
        else if (key === 'locally_accessible') outputs[key] = true;
        else outputs[key] = Boolean(existing);
        continue;
      }
      if (typ === 'number' || typ === 'integer') {
        const n = Number(existing);
        outputs[key] = Number.isFinite(n) ? n : 0;
        continue;
      }
      if (existing !== undefined && existing !== null && String(existing).trim() !== '') {
        outputs[key] = existing;
      } else if (key === 'franchise_brand') {
        outputs[key] = '';
      } else if (key === 'accessibility_reasoning') {
        outputs[key] = 'Fixture: independent local business with on-site buyer access.';
      } else {
        outputs[key] = `fixture_${key}`;
      }
    }
    return {
      outputs,
      artifacts: { fixture: true, action: action || 'model' },
      usage: {
        input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0,
        usd_cost: 0, tool_calls: [], tool_costs: [],
      },
      model: 'fixture',
      provider: 'fixture',
    };
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
  executeAction = executeEnrichmentAction,
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
  executeAction?: typeof executeEnrichmentAction;
}) => {
  const id = String(stepId || step?.id || '').trim() || 'enrich';
  const stepConfig = enrichmentStepConfig(step);
  const executionConfig = executionConfigForEnrichmentStep({ stepConfig, config, listDir });
  const declaredOutputs = getDeclaredOutputs(stepConfig || {});
  const legacyColumns = getLegacyColumns(stepConfig || {});
  const outputZod = buildOutputZodSchema(declaredOutputs, legacyColumns);
  const concurrency = Number(stepConfig?.concurrency || 3);
  const targetColumns = getTargetColumnsForStepConfig(stepConfig || {});
  const statusColumn = stepStatusColumn(id);
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
  ensureEvidenceColumns(db);

  const summary = {
    processed: 0,
    skipped_fresh: 0,
    skipped_when: 0,
    skipped_ceiling: 0,
    failed: 0,
    errors: [] as Array<{ record_id: string; error: string }>,
    handled_errors: [] as string[],
    record_ids: [] as string[],
    declared_output_writes: {} as Record<string, Record<string, { provided: boolean; value: unknown }>>,
    non_execution_reasons: {} as Record<string, string>,
  };

  await mapWithConcurrency<any, void>((rows || []) as any[], async (record) => {
    const recordId = getRecordRowId(record);
    const currentRecord = dependencyFieldsForStep(stepConfig).length > 0
      ? db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1').get(recordId, recordId) || record
      : record;
    const rowLabel = String(currentRecord?.business_name || recordId);
    const whenOutcome = shouldRunForRecord({ record: currentRecord, predicate: whenPredicate, listDir });
    if (!whenOutcome.passed) {
      upsertRecord({
        db,
        row: {
          ...currentRecord,
          [statusColumn]: 'skipped',
        },
      });
      summary.skipped_when += 1;
      summary.record_ids.push(recordId);
      summary.non_execution_reasons[recordId] = skippedWhenOutcome(whenOutcome).reason;
      emitActivity({ event: 'row_skipped', phase: 'pipeline', step: id, row: rowLabel, reason: String(whenOutcome.reason || 'when_not_matched') });
      return;
    }

    const depValues = dependencyValuesForRecord({ stepConfig, record: currentRecord });
    const dependencyHashes = enrichDependencyHashes({ stepConfig, depValues, executionConfig });
    const cached = readStaleness({ db, recordId, stepId: id });

    const expectedOutputs = Object.keys(declaredOutputs).length > 0
      ? declaredOutputs
      : legacyColumns;
    if (
      isEnrichFresh({ cached, stepConfig, depValues, executionConfig, force })
      && declaredOutputsHaveAnyValue({ record: currentRecord, expectedOutputs })
    ) {
      summary.skipped_fresh += 1;
      summary.non_execution_reasons[recordId] = 'skipped:fresh';
      return;
    }

    const runAttempt = async (attempt: number) => {
      const inputRecord = mergedRecordForEnrichment({ db, record: currentRecord });
      const result = await executeAction({
        db,
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
          source_identity: Array.isArray(config?.source?.identity) ? config.source.identity : [],
          min_fit_coverage: config?.score?.min_coverage,
          linked_duplicates: db.prepare('SELECT _row_id, business_name FROM records WHERE duplicate_of = ?').all(recordId),
        },
        ...enrichmentPolicyInputs(config || {}),
        outputSchema: outputZod,
        toolCatalog,
      });

      if (isEnrichmentCeilingSkip(result)) {
        const detail = String(result.skip_detail || 'enrichment_ceiling');
        const currentRow = db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1').get(recordId, recordId) || currentRecord;
        const patch = enrichmentCeilingSkipPatch({
          record: currentRow,
          stepId: id,
          stepConfig,
          detail,
          statusColumn,
        });
        upsertRecord({ db, row: { ...currentRow, ...patch } });
        summary.skipped_ceiling += 1;
        summary.record_ids.push(recordId);
        summary.non_execution_reasons[recordId] = 'skipped:enrichment_ceiling';
        emitActivity({
          event: 'row_skipped',
          phase: 'pipeline',
          step: id,
          row: rowLabel,
          reason: 'enrichment_ceiling',
          detail,
        });
        return { outcome: 'skipped', attempt, ceiling: true };
      }

      const outputs = result.outputs || {};
      const outcome = outputOutcomeFor({ outputs, expectedOutputs });
      summary.declared_output_writes[recordId] = declaredOutputWritesFor({ stepConfig, outputs });

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
      if (
        outcome === 'ok'
        && String(stepConfig.action || '').trim().toLowerCase() === 'policy_apply'
      ) {
        ensureRecordColumns({ db, columns: Object.keys(outputs) });
      }

      const currentRow = db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1').get(recordId, recordId) || currentRecord;
      // Empty success: still do not clobber prior good site_text; record evidence only when material.
      const isEmptyOutcome = outcome === 'empty';
      const failedEmpty = isEmptyOutcome && Object.keys(outputs || {}).every((k) => isBlank(outputs?.[k]));
      const patch = applyOutputsWithEvidence({
        db,
        step: { ...step, config: stepConfig, __list_dir: listDir },
        stepConfig,
        stepId: id,
        outputs: isEmptyOutcome ? {} : outputs,
        record: currentRow,
        provider: String((result as any)?.provider || ''),
        usage: result.usage as Record<string, unknown> | null,
        failed: failedEmpty,
        error: isEmptyOutcome ? `enrichment step empty (${id})` : null,
      });
      patch[statusColumn] = outcome;
      // Material retrieval → force next scoring pass (clear score:* staleness).
      if (!failedEmpty && evidencePatchIsMaterialRetrieval(patch)) {
        markScoringStale({ db, recordId });
        Object.assign(patch, scoringStaleRecordPatch());
      }
      const merged = {
        ...currentRow,
        ...patch,
        ...clearedLastErrorPatch({ record: currentRow, stepId: id }),
      };
      upsertRecord({ db, row: merged });
      if (String(stepConfig.action || '').trim().toLowerCase() !== 'decision_makers') {
        upsertPrimaryContactIfPresent({ db, record: merged });
      }
      writeStaleness({
        db,
        recordId,
        stepId: id,
        ...dependencyHashes,
        cacheTtlSeconds: ttlToSeconds(stepConfig?.cache),
        cacheTtl: String(stepConfig?.cache || ''),
      });
      summary.processed += 1;
      summary.record_ids.push(recordId);
      const rerunReason = enrichRerunReason({ cached, stepConfig, depValues, executionConfig });
      if (rerunReason) summary.non_execution_reasons[recordId] = rerunReason;
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
      const detail = formatErrorMessage(error);
      if (
        enrichStepUsesEmptyOnError(stepConfig)
        && isRecordScopedProviderToolError(error)
      ) {
        const outputs = emptyOutputsFor(outputZod);
        const currentRow = db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1').get(recordId, recordId) || currentRecord;
        const patch = applyOutputsWithEvidence({
          db,
          step: { ...step, config: stepConfig, __list_dir: listDir },
          stepConfig,
          stepId: id,
          outputs,
          record: currentRow,
          error: detail,
          failed: true,
        });
        patch[statusColumn] = 'failed';
        const merged = {
          ...currentRow,
          ...patch,
          retry_count: Number(currentRow.retry_count || 0) + 1,
          last_error: ownedLastError({ error: detail, stepId: id }),
        };
        upsertRecord({ db, row: merged });
        clearStaleness({ db, recordId, stepId: id });
        summary.failed += 1;
        summary.errors.push({ record_id: recordId, error: detail });
        summary.handled_errors.push(recordId);
        summary.record_ids.push(recordId);
        emitActivity({ event: 'error', phase: 'pipeline', step: id, row: rowLabel, detail });
        return;
      }
      emitActivity({ event: 'row_retry', phase: 'pipeline', step: id, row: rowLabel, detail });
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
        clearStaleness({ db, recordId, stepId: id });
        const currentRow = db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1').get(recordId, recordId) || record;
        const evidencePatch = buildEnrichEvidencePatch({
          record: currentRow,
          step_id: id,
          step_config: stepConfig,
          error: detail,
          failed: true,
        });
        upsertRecord({
          db,
          row: {
            ...currentRow,
            ...evidencePatch,
            [statusColumn]: 'failed',
            retry_count: Number(currentRow.retry_count || 0) + 1,
            last_error: ownedLastError({ error: detail, stepId: id }),
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
  const nodes: EnrichmentStepNode[] = (steps || []).map((step, index) => {
    const stepConfig = enrichmentStepConfig(step);
    return {
      id: resolveStepId(step, index),
      index,
      step,
      dependsOn: Array.isArray(stepConfig.depends_on) ? stepConfig.depends_on as string[] : [],
    };
  });
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

  const enrichSteps = flattenPipelineSteps(config).filter((step: any) => step?.kind === 'enrich');
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
  const {
    assertListAccessForMutation,
    filterRecordsForCanary,
    loadCanaryConfig,
  } = await import('../policy/canary-isolation.js');
  assertListAccessForMutation(listDir);
  const baseRowsSql = `SELECT * FROM records WHERE sequence_status != 'opted_out' AND ${inPlayWhere()}`;
  const filteredRowsSql = whereSql ? `${baseRowsSql} AND (${whereSql})` : baseRowsSql;
  const rawRows = db.prepare(`${filteredRowsSql} ORDER BY updated_at DESC`).all();
  const canaryRows = filterRecordsForCanary(rawRows, loadCanaryConfig({ listDir }));
  const rows = limitN > 0 ? canaryRows.slice(0, limitN) : canaryRows;
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
    skipped_ceiling: 0,
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
        const stepConfig = enrichmentStepConfig(step);
        const managesContacts = String(stepConfig.action || '').trim().toLowerCase() === 'decision_makers';
        const rawDependsOn = Array.isArray(stepConfig.depends_on) ? stepConfig.depends_on : [];
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
          return { id, patches: [], failures: [], managesContacts };
        }
        const declaredOutputs = getDeclaredOutputs(stepConfig);
        const legacyColumns = getLegacyColumns(stepConfig);
        const outputZod = buildOutputZodSchema(declaredOutputs, legacyColumns);
        const concurrency = Number(stepConfig.concurrency || 3);
        const targetColumns = getTargetColumnsForStepConfig(stepConfig);
        const statusColumn = stepStatusColumn(id);
        const whenPredicate = whenPredicateForStep({ step, stepConfig });
        ensureRecordColumns({ db, columns: [...targetColumns, { name: statusColumn, type: 'TEXT' }] });
        ensureEvidenceColumns(db);

        emitActivity({ event: 'step_start', phase: 'enrichment', step: id, rows: recordState.size });

        const patches: Array<{
          recordId: string;
          rowLabel: string;
          patch: Record<string, any>;
          depHash: string;
          inputHash: string;
          policyHash: string;
          cacheTtlSeconds: number;
          cacheTtl: string;
          skippedWhen?: boolean;
          skippedCeiling?: boolean;
          failedError?: string;
        }> = [];
        const failures: Array<{ recordId: string; rowLabel: string; error: string }> = [];
        const snapshot = [...recordState.values()];
        const executionConfig = executionConfigForEnrichmentStep({ stepConfig, config, listDir });

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
              inputHash: '',
              policyHash: '',
              cacheTtlSeconds: 0,
              cacheTtl: '',
              skippedWhen: true,
            });
            emitActivity({ event: 'row_skipped', phase: 'enrichment', step: id, row: rowLabel, reason: String(whenOutcome.reason || 'when_not_matched') });
            return;
          }

          const depValues = dependencyValuesForRecord({ stepConfig, record });
          const dependencyHashes = enrichDependencyHashes({ stepConfig, depValues, executionConfig });
          const cached = readStaleness({ db, recordId, stepId: id });

          const expectedOutputs = Object.keys(declaredOutputs).length > 0
            ? declaredOutputs
            : legacyColumns;
          if (
            isEnrichFresh({ cached, stepConfig, depValues, executionConfig, force })
            && declaredOutputsHaveAnyValue({ record, expectedOutputs })
          ) {
            summary.skipped_fresh += 1;
            return;
          }

          try {
            const inputRecord = mergedRecordForEnrichment({ db, record });
            const result = await executeEnrichmentAction({
              db,
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
                source_identity: Array.isArray(config?.source?.identity) ? config.source.identity : [],
                min_fit_coverage: config?.score?.min_coverage,
                linked_duplicates: db.prepare('SELECT _row_id, business_name FROM records WHERE duplicate_of = ?').all(recordId),
              },
              ...enrichmentPolicyInputs(config || {}),
              outputSchema: outputZod,
              toolCatalog,
            });

            if (isEnrichmentCeilingSkip(result)) {
              const detail = String(result.skip_detail || 'enrichment_ceiling');
              const patch = enrichmentCeilingSkipPatch({
                record,
                stepId: id,
                stepConfig,
                detail,
                statusColumn,
              });
              patches.push({
                recordId,
                rowLabel,
                patch,
                depHash: '',
                inputHash: '',
                policyHash: '',
                cacheTtlSeconds: 0,
                cacheTtl: '',
                skippedCeiling: true,
              });
              emitActivity({
                event: 'row_skipped',
                phase: 'enrichment',
                step: id,
                row: rowLabel,
                reason: 'enrichment_ceiling',
                detail,
              });
              return;
            }

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
            if (
              outcome === 'ok'
              && String(stepConfig.action || '').trim().toLowerCase() === 'policy_apply'
            ) {
              ensureRecordColumns({ db, columns: Object.keys(outputs) });
            }

            const isEmptyOutcome = outcome === 'empty';
            const patch = applyOutputsWithEvidence({
              db,
              step: { ...step, __list_dir: listDir },
              stepConfig,
              stepId: id,
              outputs: isEmptyOutcome ? {} : outputs,
              record,
              provider: String((result as any)?.provider || ''),
              usage: result.usage as Record<string, unknown> | null,
              failed: isEmptyOutcome && Object.keys(outputs || {}).every((k) => isBlank(outputs?.[k])),
              error: isEmptyOutcome ? `enrichment step empty (${id})` : null,
            });
            patch[statusColumn] = outcome;
            patches.push({
              recordId,
              rowLabel,
              patch,
              ...dependencyHashes,
              cacheTtlSeconds: ttlToSeconds(stepConfig.cache),
              cacheTtl: String(stepConfig.cache || ''),
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
            const detail = formatErrorMessage(error);
            if (
              enrichStepUsesEmptyOnError(stepConfig)
              && isRecordScopedProviderToolError(error)
            ) {
              const outputs = emptyOutputsFor(outputZod);
              const patch = applyOutputsWithEvidence({
                db,
                step: { ...step, __list_dir: listDir },
                stepConfig,
                stepId: id,
                outputs,
                record,
                error: detail,
                failed: true,
              });
              patch[statusColumn] = 'failed';
              patch.retry_count = Number(record.retry_count || 0) + 1;
              patch.last_error = ownedLastError({ error: detail, stepId: id });
              markStepFailure(recordId, id);
              patches.push({
                recordId,
                rowLabel,
                patch,
                ...dependencyHashes,
                cacheTtlSeconds: ttlToSeconds(stepConfig.cache),
                cacheTtl: String(stepConfig.cache || ''),
                skippedWhen: false,
                failedError: detail,
              });
              emitActivity({ event: 'error', phase: 'enrichment', step: id, row: rowLabel, detail });
              return;
            }
            markStepFailure(recordId, id);
            failures.push({ recordId, rowLabel, error: detail });
            emitActivity({ event: 'error', phase: 'enrichment', step: id, row: rowLabel, detail });
          }
        }, concurrency);

        emitActivity({ event: 'step_complete', phase: 'enrichment', step: id });
        return { id, patches, failures, managesContacts };
      }));

      for (const result of levelResults) {
        for (const item of result.patches) {
          try {
            const currentRow = db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1').get(item.recordId, item.recordId)
              || recordState.get(item.recordId)
              || {};
            let patch = !item.skippedWhen && !item.skippedCeiling && !item.failedError
              ? {
                ...item.patch,
                ...clearedLastErrorPatch({ record: currentRow, stepId: result.id }),
              }
              : item.patch;
            // Material retrieval evidence → mark scoring stale so next dataflow re-scores.
            if (
              !item.failedError
              && !item.skippedWhen
              && !item.skippedCeiling
              && evidencePatchIsMaterialRetrieval(patch)
            ) {
              markScoringStale({ db, recordId: item.recordId });
              patch = { ...patch, ...scoringStaleRecordPatch() };
            }
            const merged = { ...currentRow, ...patch };
            upsertRecord({ db, row: merged });
            if (!result.managesContacts) upsertPrimaryContactIfPresent({ db, record: merged });
            if (item.failedError) {
              clearStaleness({ db, recordId: item.recordId, stepId: result.id });
            } else if (!item.skippedWhen && !item.skippedCeiling) {
              writeStaleness({
                db,
                recordId: item.recordId,
                stepId: result.id,
                depHash: item.depHash,
                inputHash: item.inputHash,
                policyHash: item.policyHash,
                cacheTtlSeconds: item.cacheTtlSeconds,
                cacheTtl: item.cacheTtl,
              });
            }
            recordState.set(item.recordId, merged);
            if (item.skippedCeiling) {
              summary.skipped_ceiling += 1;
            } else if (item.skippedWhen) {
              summary.skipped_when += 1;
            } else if (item.failedError) {
              summary.failed += 1;
              summary.errors.push({ step: result.id, record_id: item.recordId, error: item.failedError });
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
          clearStaleness({ db, recordId: failure.recordId, stepId: result.id });
          const currentRow = recordState.get(failure.recordId);
          if (currentRow) {
            const evidencePatch = buildEnrichEvidencePatch({
              record: currentRow,
              step_id: result.id,
              step_config: enrichmentStepConfig(level.find((n) => n.id === result.id)?.step),
              error: failure.error,
              failed: true,
            });
            const updated = {
              ...currentRow,
              ...evidencePatch,
              [`${result.id}__status`]: 'failed',
              retry_count: Number(currentRow.retry_count || 0) + 1,
              last_error: ownedLastError({ error: failure.error, stepId: result.id }),
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
      skipped: summary.skipped_fresh + summary.skipped_upstream + summary.skipped_when + summary.skipped_ceiling,
      failed: summary.failed,
    });
    return summary;
  } finally {
    db.close();
  }
};
