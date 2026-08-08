import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  type Asset,
  ensureRecordColumns,
  findAsset,
  inPlayWhere,
  insertAsset,
  openListDb,
  updateAsset,
  upsertRecord,
} from '../runtime/db.js';
import { EVIDENCE_RECORD_COLUMNS } from '../policy/evidence.js';
import { readConfig } from '../lib/config.js';
import { getRecordRowId } from '../lib/record.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { readToolCatalog } from '../lib/tool-catalog.js';
import { assertPhaseModelReferences } from '../lib/model-validation.js';
import { formatErrorMessage } from '../lib/error-format.js';
import { isBudgetExceededError } from '../runtime/contract.js';
import { getMcpClient } from '../runtime/mcp.js';
import { emitActivity } from '../runtime/activity.js';
import { recordCostEvent } from '../lib/costs.js';
import { toolSpecNeedsMcp, type ToolCatalog, type ToolSpec } from '../runtime/tools.js';
import { businessEvidenceIsAvailable } from '../lib/model-context.js';
import {
  buildOutputZodSchema,
  dependencyFieldsForStep,
  dependencyValueForRecord,
  dependencyValuesForRecord,
  emptyOutputsFor,
  enrichDepHash,
  enrichmentActionNeedsMcp,
  enrichmentStepConfig,
  enrichmentCeilingSkipPatch,
  executeEnrichmentAction,
  declaredOutputWritesFor,
  getDeclaredOutputs,
  isEnrichFresh,
  isEnrichmentCeilingSkip,
  mergedRecordForEnrichment,
  outputOutcomeFor,
  parseExtra,
  readStaleness,
  shouldRunForRecord,
  ttlToSeconds,
  whenPredicateForStep,
  writeStaleness,
} from '../enrichment/runner.js';
import { skippedWhenOutcome } from '../lib/step-when.js';
import { flattenPipelineSteps } from '../lib/subpipelines.js';

type DbStatement = {
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => Array<Record<string, unknown>>;
  run: (params?: unknown) => unknown;
};

type DbLike = {
  prepare: (sql: string) => DbStatement;
  close?: () => void;
};

type GenerateStepInput = Record<string, unknown>;
type GenerateRecord = Record<string, unknown>;
type Logger = (event: Record<string, unknown>) => void;

const CLAIM_ENGINE_OUTPUT_FIELDS = new Set([
  'claim_audit_passed',
  'claim_audit_json',
  'claim_audit_asset_hash',
  'permitted_claim_packet_json',
  'claim_packet_assemble_error',
  'catalog_evidence_json',
]);

const stringifyJson = (value: unknown) => {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
};

const hasToolFlavor = (stepConfig: Record<string, unknown>) => {
  const action = String(stepConfig.action || '').trim();
  const tool = stepConfig.tool && typeof stepConfig.tool === 'object'
    ? stepConfig.tool as ToolSpec
    : undefined;
  const hasPinnedTool = Boolean(
    (Array.isArray(tool?.tools) && tool.tools.length > 0)
    || (Array.isArray(tool?.toolkits) && tool.toolkits.length > 0)
  );
  return Boolean(action || hasPinnedTool);
};

const stepNeedsMcp = (stepConfig: Record<string, unknown>, options: { listDir?: string } = {}) => (
  enrichmentActionNeedsMcp(stepConfig)
  || toolSpecNeedsMcp(stepConfig.tool as ToolSpec | undefined, options)
);

const isLockedAsset = (asset: Asset | null) => {
  const status = String(asset?.status || '').trim().toLowerCase();
  return status === 'approved' || status === 'consumed';
};

const bareReferencePattern = /^(https?:\/\/|s3:\/\/|gs:\/\/|file:\/\/|\/|\.\/|\.\.\/)\S+$/i;
const localReferencePattern = /^(file:\/\/|\/|\.\/|\.\.\/)\S+$/i;
const explicitReferenceKeys = new Set(['reference', 'uri', 'path', 'link', 'url', 'asset_url']);

const firstString = (values: unknown[]) => {
  const match = values.find((value) => typeof value === 'string' && value.trim() !== '');
  return typeof match === 'string' ? match : '';
};

const objectValue = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const outputsFromAsset = (asset: Asset | null): Record<string, unknown> => {
  try {
    return objectValue(JSON.parse(String(asset?.outputs_json || '{}')));
  } catch {
    return {};
  }
};

const valueSignalsReference = (value: unknown): boolean | null => {
  const record = objectValue(value);
  if (Object.keys(record).length === 0) return null;
  if (record.is_reference === true || record.isReference === true || record.reference === true) return true;
  if (record.is_reference === false || record.isReference === false || record.reference === false) return false;
  const type = String(record.type || record.kind || '').trim().toLowerCase();
  if (type === 'reference' || type === 'asset_reference') return true;
  const nested = [
    record.result,
    record.output,
    record.data,
    record.artifacts,
    record.outputs,
  ].map(valueSignalsReference).find((signal) => signal !== null);
  return nested === undefined ? null : nested;
};

const assetResultFromExecution = (result: Record<string, unknown>) => {
  const artifacts = objectValue(result.artifacts);
  const outputs = objectValue(result.outputs);
  const artifactText = firstString([
    artifacts.result,
    artifacts.text,
    artifacts.body,
    artifacts.url,
    artifacts.path,
    artifacts.reference,
  ]);
  const outputText = firstString(Object.values(outputs));
  const summary = String(result.summary || '').trim();
  const reason = String(result.reason || '').trim();
  if (summary) return summary;
  if (artifactText) return artifactText;
  if (outputText) return outputText;
  if (reason) return reason;
  if (Object.keys(artifacts).length > 0) return stringifyJson(artifacts);
  if (Object.keys(outputs).length > 0) return stringifyJson(outputs);
  return '';
};

const isReferenceResult = ({ toolDriven, resultText, executionResult }: {
  toolDriven: boolean;
  resultText: string;
  executionResult: Record<string, unknown>;
}) => {
  if (!toolDriven) return false;
  const explicit = valueSignalsReference(executionResult);
  if (explicit !== null) return explicit;
  // Last-resort heuristic for tools that return only a URL/path string.
  return bareReferencePattern.test(String(resultText || '').trim());
};

type ReferenceCandidate = {
  key: string;
  value: string;
};

const referenceCandidatesFrom = (record: Record<string, unknown>): ReferenceCandidate[] => (
  Object.entries(record).flatMap(([key, value]) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || !bareReferencePattern.test(text)) return [];
    return [{ key: key.trim().toLowerCase(), value: text }];
  })
);

const selectReferencePointer = (candidates: ReferenceCandidate[]) => {
  const localPathOrFile = candidates.find(({ key, value }) => (
    (key.includes('path') || key.includes('file')) && localReferencePattern.test(value)
  ));
  const pathOrFile = candidates.find(({ key }) => key.includes('path') || key.includes('file'));
  const explicit = candidates.find(({ key }) => explicitReferenceKeys.has(key));
  return localPathOrFile?.value || pathOrFile?.value || explicit?.value || candidates[0]?.value || '';
};

const referencePointerFrom = ({
  outputs,
  executionResult,
  resultText,
}: {
  outputs: Record<string, unknown>;
  executionResult: Record<string, unknown>;
  resultText: string;
}) => {
  const candidates = [
    ...referenceCandidatesFrom(outputs),
    ...referenceCandidatesFrom(objectValue(executionResult.artifacts)),
  ];
  const pointer = selectReferencePointer(candidates);
  if (pointer) return pointer;
  const text = String(resultText || '').trim();
  return bareReferencePattern.test(text) ? text : '';
};

const assetResultForReference = ({
  isReference,
  resultText,
  outputs,
  executionResult,
  reason,
}: {
  isReference: boolean;
  resultText: string;
  outputs: Record<string, unknown>;
  executionResult: Record<string, unknown>;
  reason: string;
}) => {
  if (!isReference) return { result: resultText, reason };
  // Reference assets must store the machine-openable pointer in result; keep summaries in reason for humans.
  const pointer = referencePointerFrom({ outputs, executionResult, resultText });
  if (!pointer || pointer === resultText) return { result: resultText, reason };
  return { result: pointer, reason: String(reason || resultText || '') };
};

const emit = ({ logger, event }: { logger?: Logger; event: Record<string, unknown> }) => {
  if (logger) logger(event);
  emitActivity(event);
};

const dependencyFieldsFor = (stepConfig: Record<string, unknown>) => dependencyFieldsForStep(stepConfig);

const currentRecordForDependencies = ({ db, record, stepConfig }: {
  db: DbLike;
  record: GenerateRecord;
  stepConfig: Record<string, unknown>;
}) => {
  if (dependencyFieldsFor(stepConfig).length === 0) return record;
  const recordId = getRecordRowId(record);
  const current = db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1').get(recordId, recordId);
  return (current as GenerateRecord) || record;
};

const dependencyValuesFor = ({ stepConfig, record }: {
  stepConfig: Record<string, unknown>;
  record: GenerateRecord;
}) => {
  const depValues = dependencyValuesForRecord({ stepConfig, record });
  const extra = parseExtra(record.extra_json);
  for (const dep of dependencyFieldsFor(stepConfig)) {
    depValues[String(dep)] = dependencyValueForRecord({ dep, record, extra });
  }
  return depValues;
};

const persistAsset = ({
  db,
  existing,
  recordId,
  stepId,
  label,
  result,
  outputsJson,
  isReference,
  status,
  reason,
}: {
  db: DbLike;
  existing: Asset | null;
  recordId: string;
  stepId: string;
  label: string;
  result: string;
  outputsJson: string;
  isReference: boolean;
  status: string;
  reason: string;
}) => (
  existing
    ? updateAsset({ db, assetId: existing.asset_id, label, result, outputsJson, isReference, status, reason })
    : insertAsset({ db, rowId: recordId, stepId, label, result, outputsJson, isReference, status, reason })
);

export const runGenerateStep = async ({
  db,
  listDir,
  config,
  mcp = null,
  toolCatalog,
  step,
  rows,
  stepId = '',
  force = false,
  concurrency,
  logger,
}: {
  db: DbLike;
  listDir: string;
  config: Record<string, unknown>;
  mcp?: Client | null;
  toolCatalog?: ToolCatalog;
  step: GenerateStepInput;
  rows: GenerateRecord[];
  stepId?: string;
  force?: boolean;
  concurrency?: number;
  logger?: Logger;
}) => {
  const id = String(stepId || step?.id || '').trim() || 'generate';
  const stepConfig = enrichmentStepConfig(step);
  const declaredOutputs = Object.fromEntries(
    Object.entries(getDeclaredOutputs(stepConfig)).filter(([key]) => !CLAIM_ENGINE_OUTPUT_FIELDS.has(key)),
  );
  const outputZod = buildOutputZodSchema(declaredOutputs, {});
  const effectiveConcurrency = Number(concurrency || stepConfig.concurrency || 3);
  const whenPredicate = whenPredicateForStep({ step, stepConfig });
  const toolDriven = hasToolFlavor(stepConfig);
  const onErrorEmpty = String(stepConfig.on_error || 'empty').trim().toLowerCase() === 'empty';

  const summary = {
    processed: 0,
    inserted: 0,
    updated: 0,
    skipped_fresh: 0,
    skipped_locked: 0,
    skipped_when: 0,
    skipped_ceiling: 0,
    failed: 0,
    errors: [] as Array<{ record_id: string; error: string }>,
    record_ids: [] as string[],
    declared_output_writes: {} as Record<string, Record<string, { provided: boolean; value: unknown }>>,
    non_execution_reasons: {} as Record<string, string>,
  };

  await mapWithConcurrency<GenerateRecord, void>(rows || [], async (record) => {
    const recordId = getRecordRowId(record);
    const currentRecord = currentRecordForDependencies({ db, record, stepConfig });
    const rowLabel = String(currentRecord.business_name || recordId);
    const existing = findAsset({ db, rowId: recordId, stepId: id });

    const whenOutcome = shouldRunForRecord({ record: currentRecord, predicate: whenPredicate, listDir });
    if (!whenOutcome.passed) {
      summary.declared_output_writes[recordId] = declaredOutputWritesFor({ stepConfig, outputs: {} });
      summary.skipped_when += 1;
      summary.record_ids.push(recordId);
      summary.non_execution_reasons[recordId] = skippedWhenOutcome(whenOutcome).reason;
      emit({ logger, event: { event: 'row_skipped', phase: 'generate', step: id, row: rowLabel, reason: String(whenOutcome.reason || 'when_not_matched') } });
      return;
    }

    if (isLockedAsset(existing)) {
      summary.declared_output_writes[recordId] = declaredOutputWritesFor({
        stepConfig,
        outputs: outputsFromAsset(existing),
      });
      summary.skipped_locked += 1;
      return;
    }

    if (stepConfig.requires_evidence === true && !businessEvidenceIsAvailable(currentRecord)) {
      const reason = 'needs_discovery: no_business_evidence';
      const emptyOutputs = emptyOutputsFor(outputZod);
      summary.declared_output_writes[recordId] = declaredOutputWritesFor({ stepConfig, outputs: emptyOutputs });
      ensureRecordColumns({
        db,
        columns: [...Object.keys(emptyOutputs), { name: 'score_status', type: 'TEXT' }],
      });
      upsertRecord({
        db,
        row: { ...currentRecord, ...emptyOutputs, score_status: 'needs_discovery' },
      });
      persistAsset({
        db,
        existing,
        recordId,
        stepId: id,
        label: String(stepConfig.label || ''),
        result: '',
        outputsJson: stringifyJson(emptyOutputs),
        isReference: false,
        status: 'empty',
        reason,
      });
      summary.processed += 1;
      if (existing) summary.updated += 1;
      if (!existing) summary.inserted += 1;
      summary.record_ids.push(recordId);
      emit({ logger, event: { event: 'row_complete', phase: 'generate', step: id, row: rowLabel, outcome: 'empty', reason } });
      return;
    }

    const depValues = dependencyValuesFor({ stepConfig, record: currentRecord });
    const depHash = enrichDepHash(stepConfig, depValues);
    const cached = readStaleness({ db, recordId, stepId: id });
    if (existing && isEnrichFresh({ cached, stepConfig, depValues, force })) {
      summary.declared_output_writes[recordId] = declaredOutputWritesFor({
        stepConfig,
        outputs: outputsFromAsset(existing),
      });
      summary.skipped_fresh += 1;
      return;
    }

    try {
      const inputRecord = mergedRecordForEnrichment({ db, record: currentRecord });
      const executionResult = await executeEnrichmentAction({
        db,
        mcp,
        listDir,
        stepId: id,
        description: String(step.description || id),
        stepConfig,
        record: inputRecord,
        aiConfig: objectValue(config.ai),
        context: {
          phase: 'generate',
          step: id,
          linked_duplicates: db.prepare('SELECT _row_id, business_name FROM records WHERE duplicate_of = ?').all(recordId),
        },
        outputSchema: outputZod,
        toolCatalog,
      }) as Record<string, unknown>;

      // Expensive generate steps skip the provider when over ceiling.
      if (isEnrichmentCeilingSkip(executionResult)) {
        const detail = String(executionResult.skip_detail || 'enrichment_ceiling');
        const emptyOutputs = emptyOutputsFor(outputZod);
        summary.declared_output_writes[recordId] = declaredOutputWritesFor({ stepConfig, outputs: emptyOutputs });
        const currentRow = db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1').get(recordId, recordId)
          || inputRecord
          || record;
        const evidencePatch = enrichmentCeilingSkipPatch({
          record: currentRow as Record<string, unknown>,
          stepId: id,
          stepConfig,
          detail,
        });
        ensureRecordColumns({ db, columns: [...EVIDENCE_RECORD_COLUMNS] });
        upsertRecord({ db, row: { ...(currentRow as Record<string, unknown>), ...evidencePatch } });
        persistAsset({
          db,
          existing,
          recordId,
          stepId: id,
          label: String(stepConfig.label || ''),
          result: '',
          outputsJson: stringifyJson(emptyOutputs),
          isReference: false,
          status: 'skipped',
          reason: detail,
        });
        summary.skipped_ceiling += 1;
        summary.record_ids.push(recordId);
        emit({
          logger,
          event: {
            event: 'row_skipped',
            phase: 'generate',
            step: id,
            row: rowLabel,
            reason: 'enrichment_ceiling',
            detail,
          },
        });
        return;
      }

      const outputs = objectValue(executionResult.outputs);
      const expectedOutputs = declaredOutputs;
      const result = assetResultFromExecution(executionResult);
      const parsedOutputs = (() => {
        if (Object.keys(expectedOutputs).length === 0) return {};
        try {
          return outputZod.parse(outputs);
        } catch (error) {
          if (!onErrorEmpty) throw error;
          return { __parse_error: formatErrorMessage(error) };
        }
      })();
      if (Object.prototype.hasOwnProperty.call(parsedOutputs, '__parse_error')) {
        const detail = `Declared output parsing failed; stored raw result with empty structured outputs. ${String(parsedOutputs.__parse_error || '')}`.trim();
        summary.declared_output_writes[recordId] = declaredOutputWritesFor({ stepConfig, outputs: {} });
        const isReference = isReferenceResult({ toolDriven, resultText: result, executionResult });
        const referenceAsset = assetResultForReference({
          isReference,
          resultText: result,
          outputs,
          executionResult,
          reason: detail,
        });
        persistAsset({
          db,
          existing,
          recordId,
          stepId: id,
          label: String(stepConfig.label || ''),
          result: referenceAsset.result,
          outputsJson: stringifyJson(emptyOutputsFor(outputZod)),
          isReference,
          status: 'empty',
          reason: referenceAsset.reason,
        });
        writeStaleness({
          db,
          recordId,
          stepId: id,
          depHash,
          cacheTtlSeconds: ttlToSeconds(stepConfig.cache),
          cacheTtl: String(stepConfig.cache || ''),
        });
        summary.processed += 1;
        if (existing) summary.updated += 1;
        if (!existing) summary.inserted += 1;
        summary.record_ids.push(recordId);
        emit({ logger, event: { event: 'row_complete', phase: 'generate', step: id, row: rowLabel, outcome: 'empty', reason: detail } });
        return;
      }
      const outcome = outputOutcomeFor({ outputs: parsedOutputs, expectedOutputs });
      if (Object.keys(expectedOutputs).length > 0 && outcome === 'empty' && !onErrorEmpty) {
        throw new Error(`Step "${id}" returned no outputs for declared outputs.`);
      }

      const outputsJson = Object.keys(expectedOutputs).length > 0 ? stringifyJson(parsedOutputs) : '{}';
      summary.declared_output_writes[recordId] = declaredOutputWritesFor({
        stepConfig,
        outputs: parsedOutputs,
      });
      const isReference = isReferenceResult({ toolDriven, resultText: result, executionResult });
      const outputsForReference = Object.keys(expectedOutputs).length > 0 ? parsedOutputs : outputs;
      const referenceAsset = assetResultForReference({
        isReference,
        resultText: result,
        outputs: outputsForReference,
        executionResult,
        reason: String(executionResult.reason || ''),
      });
      const saved = persistAsset({
        db,
        existing,
        recordId,
        stepId: id,
        label: String(stepConfig.label || ''),
        result: referenceAsset.result,
        outputsJson,
        isReference,
        status: outcome === 'empty' ? 'empty' : 'ready',
        reason: referenceAsset.reason,
      });

      ensureRecordColumns({ db, columns: Object.keys(parsedOutputs) });
      upsertRecord({ db, row: { ...inputRecord, ...parsedOutputs } });

      recordCostEvent({
        db,
        listDir,
        recordId,
        stepId: `generate:${id}`,
        model: String(executionResult.model || ''),
        provider: String(executionResult.provider || ''),
        usage: executionResult.usage,
      });
      writeStaleness({
        db,
        recordId,
        stepId: id,
        depHash,
        cacheTtlSeconds: ttlToSeconds(stepConfig.cache),
        cacheTtl: String(stepConfig.cache || ''),
      });
      summary.processed += 1;
      if (existing) summary.updated += 1;
      if (!existing) summary.inserted += 1;
      summary.record_ids.push(recordId);
      emit({ logger, event: { event: 'row_complete', phase: 'generate', step: id, row: rowLabel, asset_id: saved?.asset_id || '' } });
    } catch (error) {
      if (isBudgetExceededError(error)) throw error;
      const detail = formatErrorMessage(error);
      if (onErrorEmpty) {
        summary.declared_output_writes[recordId] = declaredOutputWritesFor({ stepConfig, outputs: {} });
        persistAsset({
          db,
          existing,
          recordId,
          stepId: id,
          label: String(stepConfig.label || ''),
          result: '',
          outputsJson: stringifyJson(emptyOutputsFor(outputZod)),
          isReference: false,
          status: 'empty',
          reason: detail,
        });
        writeStaleness({
          db,
          recordId,
          stepId: id,
          depHash,
          cacheTtlSeconds: ttlToSeconds(stepConfig.cache),
          cacheTtl: String(stepConfig.cache || ''),
        });
        summary.processed += 1;
        if (existing) summary.updated += 1;
        if (!existing) summary.inserted += 1;
        summary.record_ids.push(recordId);
        emit({ logger, event: { event: 'row_complete', phase: 'generate', step: id, row: rowLabel, outcome: 'empty', reason: detail } });
        return;
      }
      summary.failed += 1;
      summary.errors.push({ record_id: recordId, error: detail });
      summary.record_ids.push(recordId);
      emit({ logger, event: { event: 'error', phase: 'generate', step: id, row: rowLabel, detail } });
    }
  }, effectiveConcurrency);

  return summary;
};

export const runGeneration = async ({ listDir, stepId = '', where = '', limit = 0, force = false, logger }: {
  listDir: string;
  stepId?: string;
  where?: string;
  limit?: number;
  force?: boolean;
  logger?: Logger;
}) => {
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) {
    throw new Error(`Invalid config: ${errors.join('; ')}`);
  }
  assertPhaseModelReferences({ config, phase: 'pipeline' });

  const generateSteps = flattenPipelineSteps(config).filter((step: GenerateStepInput) => step?.kind === 'generate');
  const selectedSteps = stepId
    ? generateSteps.filter((step: GenerateStepInput) => String(step?.id || '').trim() === String(stepId).trim())
    : generateSteps;

  const db = openListDb({ listDir, readonly: false }) as DbLike;
  const whereSql = String(where || '').trim();
  const limitN = Number(limit || 0);
  // Canary isolation: assert list + filter BEFORE limit so allowlisted rows are not starved.
  const { loadCanaryConfig, filterRecordsForCanary, assertListAccessForMutation } = await import('../policy/canary-isolation.js');
  assertListAccessForMutation(listDir);
  const baseRowsSql = `SELECT * FROM records WHERE sequence_status != 'opted_out' AND ${inPlayWhere()}`;
  const filteredRowsSql = whereSql ? `${baseRowsSql} AND (${whereSql})` : baseRowsSql;
  const orderedRowsSql = `${filteredRowsSql} ORDER BY updated_at DESC`;
  let rows = db.prepare(orderedRowsSql).all() as any[];
  rows = filterRecordsForCanary(rows, loadCanaryConfig({ listDir }));
  if (limitN > 0) rows = rows.slice(0, limitN);
  const toolCatalog = readToolCatalog(listDir);
  const mcpState: { client: Client | null } = { client: null };
  const mcpForStep = async (stepConfig: Record<string, unknown>) => {
    if (!stepNeedsMcp(stepConfig, { listDir })) return null;
    if (!mcpState.client) mcpState.client = await getMcpClient();
    return mcpState.client;
  };

  const summary = {
    steps: selectedSteps.length,
    rows_total: rows.length,
    processed: 0,
    inserted: 0,
    updated: 0,
    skipped_fresh: 0,
    skipped_locked: 0,
    skipped_when: 0,
    failed: 0,
    errors: [] as Array<Record<string, unknown>>,
  };

  emit({ logger, event: { event: 'phase_start', phase: 'generate', steps: selectedSteps.length, rows: rows.length } });
  try {
    for (const step of selectedSteps) {
      const id = String(step?.id || '').trim() || 'generate';
      const stepConfig = enrichmentStepConfig(step);
      emit({ logger, event: { event: 'step_start', phase: 'generate', step: id, rows: rows.length } });
      const result = await runGenerateStep({
        db,
        listDir,
        config,
        mcp: await mcpForStep(stepConfig),
        toolCatalog,
        step,
        rows,
        stepId: id,
        force,
        logger,
      });
      summary.processed += result.processed;
      summary.inserted += result.inserted;
      summary.updated += result.updated;
      summary.skipped_fresh += result.skipped_fresh;
      summary.skipped_locked += result.skipped_locked;
      summary.skipped_when += result.skipped_when;
      summary.failed += result.failed;
      summary.errors.push(...result.errors.map((error) => ({ step: id, ...error })));
      emit({ logger, event: { event: 'step_complete', phase: 'generate', step: id } });
    }
    emit({
      logger,
      event: {
        event: 'phase_complete',
        phase: 'generate',
        processed: summary.processed,
        skipped: summary.skipped_fresh + summary.skipped_locked + summary.skipped_when,
        failed: summary.failed,
      },
    });
    return summary;
  } finally {
    db.close?.();
  }
};
