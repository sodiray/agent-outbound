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
import {
  buildOutputZodSchema,
  dependencyValueForRecord,
  emptyOutputsFor,
  enrichDepHash,
  enrichmentActionNeedsMcp,
  enrichmentStepConfig,
  enrichmentCeilingSkipPatch,
  executeEnrichmentAction,
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

const dependencyValuesFor = ({ stepConfig, record }: {
  stepConfig: Record<string, unknown>;
  record: GenerateRecord;
}) => {
  const dependsOn = Array.isArray(stepConfig.depends_on) ? stepConfig.depends_on : [];
  const extra = parseExtra(record.extra_json);
  const depValues: Record<string, unknown> = {};
  for (const dep of dependsOn) {
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
  const declaredOutputs = getDeclaredOutputs(stepConfig);
  const outputZod = buildOutputZodSchema(declaredOutputs, {});
  const executionOutputZod = buildOutputZodSchema({}, {});
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
  };

  await mapWithConcurrency<GenerateRecord, void>(rows || [], async (record) => {
    const recordId = getRecordRowId(record);
    const rowLabel = String(record.business_name || recordId);
    const existing = findAsset({ db, rowId: recordId, stepId: id });

    const whenOutcome = shouldRunForRecord({ record, predicate: whenPredicate, listDir });
    if (!whenOutcome.passed) {
      summary.skipped_when += 1;
      summary.record_ids.push(recordId);
      emit({ logger, event: { event: 'row_skipped', phase: 'generate', step: id, row: rowLabel, reason: String(whenOutcome.reason || 'when_not_matched') } });
      return;
    }

    if (isLockedAsset(existing)) {
      summary.skipped_locked += 1;
      return;
    }

    const depValues = dependencyValuesFor({ stepConfig, record });
    const depHash = enrichDepHash(stepConfig, depValues);
    const cached = readStaleness({ db, recordId, stepId: id });
    if (existing && isEnrichFresh({ cached, stepConfig, depValues, force })) {
      summary.skipped_fresh += 1;
      return;
    }

    try {
      const inputRecord = mergedRecordForEnrichment({ db, record });
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
        outputSchema: executionOutputZod,
        toolCatalog,
      }) as Record<string, unknown>;

      // Expensive generate (e.g. diagnostic_content_pack): skip provider when over ceiling.
      if (isEnrichmentCeilingSkip(executionResult)) {
        const detail = String(executionResult.skip_detail || 'enrichment_ceiling');
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
          outputsJson: stringifyJson(emptyOutputsFor(outputZod)),
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

      // Deterministic claim packet assembly + claim audit (not best-effort swallow).
      {
        const {
          auditClaims,
          assembleClaimEvidenceCatalog,
          assemblePermittedClaimPacket,
          calculateEconomicScenario,
          claimAuditAssetHash,
          draftAssetText,
        } = await import('../policy/index.js');
        const { ensureRecordColumns, upsertRecord } = await import('../runtime/db.js');
        // Final drafted email (subject+body) is the only asset that may authorize
        // claim_audit for send. Do NOT hash diagnostic snapshot + raw model result
        // into the same hash — that makes legitimate drafts fail at send.
        const draftedEmail = draftAssetText({
          subject: parsedOutputs.subject as string,
          body: (parsedOutputs.body || parsedOutputs.email_body || parsedOutputs.email_copy) as string,
        });
        // Audit text: prefer drafted email; fall back to diagnostic snapshot alone
        // (not a composite with model result) when no body yet.
        const assetText = draftedEmail
          || String(parsedOutputs.preliminary_snapshot || '').trim()
          || String(referenceAsset.result || '').trim();

        // Prefer code-assembled packet over model-emitted packet (prevents self-approval).
        let packet: any = null;
        try {
          const economicInputs: Record<string, number> = {};
          for (const key of [
            'weekly_admin_hours',
            'admin_hours_per_week',
            'hourly_loaded_cost',
            'hourly_rate',
            'missed_leads_per_month',
            'avg_job_value',
            'close_rate',
          ]) {
            const n = Number((inputRecord as any)[key] ?? (parsedOutputs as any)[key]);
            if (Number.isFinite(n)) economicInputs[key] = n;
          }
          const scenarioIds = ['admin_labor_leak', 'missed_lead_revenue'];
          const econResults = scenarioIds.map((scenario_id) =>
            calculateEconomicScenario({
              scenario_id,
              weekly_admin_hours: economicInputs.weekly_admin_hours ?? economicInputs.admin_hours_per_week,
              hourly_loaded_cost: economicInputs.hourly_loaded_cost ?? economicInputs.hourly_rate,
              missed_leads_per_month: economicInputs.missed_leads_per_month,
              avg_job_value: economicInputs.avg_job_value,
              close_rate: economicInputs.close_rate,
            }),
          );
          parsedOutputs.economic_scenarios_json = JSON.stringify(econResults);

          packet = assemblePermittedClaimPacket({
            account_id: String(recordId),
            family_id: String(inputRecord.diagnostic_family || inputRecord.vertical || ''),
            vertical: String(inputRecord.vertical || ''),
            economic_inputs: economicInputs,
            preliminary_snapshot: String(parsedOutputs.preliminary_snapshot || ''),
            listDir: String(listDir || ''),
          });
          parsedOutputs.permitted_claim_packet_json = JSON.stringify(packet);
          parsedOutputs.catalog_evidence_json = JSON.stringify(
            assembleClaimEvidenceCatalog({
              family_id: String(inputRecord.diagnostic_family || inputRecord.vertical || ''),
              vertical: String(inputRecord.vertical || ''),
              economic_inputs: economicInputs,
              listDir: String(listDir || ''),
            }),
          );
        } catch (assembleErr) {
          // Fall back to model packet only if assembler fails; still audit.
          const packetRaw = parsedOutputs.permitted_claim_packet_json
            || inputRecord.permitted_claim_packet_json
            || '';
          if (packetRaw) {
            packet = typeof packetRaw === 'string' ? JSON.parse(String(packetRaw)) : packetRaw;
          }
          parsedOutputs.claim_packet_assemble_error = String((assembleErr as Error)?.message || assembleErr);
        }

        if (packet && Array.isArray(packet.permitted_claims) && assetText) {
          // Sentence-ish extract for audit. Empty result with non-empty assetText must fail
          // (claim-audit v2 no_claims_extracted) — never treat "nothing extracted" as pass.
          // Audit EVERY substantive sentence (no 12-sentence cap, no dropping short claims
          // that can still assert commercial falsehoods).
          const extracted = String(assetText)
            .split(/[.!?\n]+/)
            .map((t) => t.trim())
            .filter((t) => t.length >= 3)
            .map((text) => ({ text }));
          let audit: any;
          try {
            audit = auditClaims({ packet, extracted, assetText });
            // Belt-and-suspenders: empty extract of authored content cannot pass even if
            // auditClaims were ever relaxed.
            if (extracted.length === 0 && String(assetText).trim()) {
              audit = {
                ...audit,
                passed: false,
                unauthorized: [
                  ...(audit.unauthorized || []),
                  { text: String(assetText).slice(0, 120), reason: 'no_claims_extracted' },
                ],
              };
            }
            // Withheld / unknown family packet (zero claims) cannot authorize content.
            if ((packet.permitted_claims || []).length === 0 && String(assetText).trim()) {
              audit = {
                ...audit,
                passed: false,
                unauthorized: [
                  ...(audit.unauthorized || []).filter((u: any) => u.reason !== 'withheld_claim_packet'),
                  {
                    text: String(assetText).slice(0, 120),
                    reason: String((packet as any).withhold_reason || 'withheld_claim_packet'),
                  },
                ],
              };
            }
          } catch (auditErr) {
            // Do not swallow: mark failed so readiness cannot pass on missing audit.
            audit = {
              passed: false,
              authorized: [],
              unauthorized: [{ text: 'audit_error', reason: String((auditErr as Error)?.message || auditErr) }],
              policy_version: 'error',
            };
          }
          ensureRecordColumns({
            db,
            columns: [
              'claim_audit_passed',
              'claim_audit_json',
              'claim_audit_asset_hash',
              'permitted_claim_packet_json',
              'economic_scenarios_json',
              'claim_packet_assemble_error',
            ],
          });
          // Bind hash only when we audited a real drafted email body. Snapshot-only
          // audits never set claim_audit_passed=1 (send requires draft-bound hash).
          const assetHash = draftedEmail ? claimAuditAssetHash(draftedEmail) : '';
          const pass = Boolean(audit.passed && draftedEmail && assetHash);
          const patch: Record<string, unknown> = {
            ...inputRecord,
            ...parsedOutputs,
            permitted_claim_packet_json: JSON.stringify(packet),
            claim_audit_json: JSON.stringify(audit),
            claim_audit_passed: pass ? 1 : 0,
            ...(assetHash ? { claim_audit_asset_hash: assetHash } : {}),
          };
          upsertRecord({ db, row: patch });
          if (!audit.passed) {
            persistAsset({
              db,
              existing: saved,
              recordId,
              stepId: id,
              label: String(stepConfig.label || ''),
              result: referenceAsset.result,
              outputsJson,
              isReference,
              status: 'needs_repair',
              reason: `claim_audit_failed:${(audit.unauthorized || []).map((u: any) => u.reason).join(',')}`,
            });
          }
        } else if (Object.keys(parsedOutputs).length > 0) {
          ensureRecordColumns({ db, columns: Object.keys(parsedOutputs) });
          // Content without packet/audit → mark audit required failed if text exists.
          const patch: Record<string, unknown> = { ...inputRecord, ...parsedOutputs };
          if (assetText && !packet) {
            patch.claim_audit_passed = 0;
            patch.claim_audit_json = JSON.stringify({
              passed: false,
              unauthorized: [{ text: '', reason: 'missing_permitted_claim_packet' }],
            });
          }
          // Empty extract path: assetText present but condition skipped → fail closed.
          if (assetText && packet && !Array.isArray(packet.permitted_claims)) {
            patch.claim_audit_passed = 0;
            patch.claim_audit_json = JSON.stringify({
              passed: false,
              unauthorized: [{ text: '', reason: 'invalid_permitted_claim_packet' }],
            });
            patch.permitted_claim_packet_json = JSON.stringify(packet);
          }
          upsertRecord({ db, row: patch });
        }
      }

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

  const generateSteps = (Array.isArray(config.pipeline) ? config.pipeline : []).filter((step: GenerateStepInput) => step?.kind === 'generate');
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
