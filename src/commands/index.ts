import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { randomUUID } from 'node:crypto';
import { ensureListScaffold, resolveListDir, ensureGlobalDirs, getGlobalEnvPath } from '../orchestrator/runtime/paths.js';
import {
  addSuppression,
  deleteRecord,
  deleteRecordsBatch,
  deleteRecordsKeepTop,
  getRecordById,
  inPlayWhere,
  listActiveOverrides,
  logComplianceEvent,
  openGlobalSuppressionDb,
  openListDb,
  upsertRecord,
} from '../orchestrator/runtime/db.js';
import {
  mergeInferredPipelineDependencies,
  pipelineDependencyDiff,
  readConfig,
  writeConfig,
  getConfigPath,
  deepMergeConfig,
} from '../orchestrator/lib/config.js';
import { readToolCatalog, resolveConfigToolCatalog } from '../orchestrator/lib/tool-catalog.js';
import { cleanupRemovedStep } from '../orchestrator/lib/step-cleanup.js';
import { validateColumnName, validateWhereSql } from '../orchestrator/lib/sql-safety.js';
import { recordCostEvent } from '../orchestrator/lib/costs.js';
import { authorConfigAction } from '../orchestrator/actions/author-config/index.js';
import { runSourcing, runSourcingMore } from '../orchestrator/sourcing/runner.js';
import { runPipelineDataflow } from '../orchestrator/pipeline/dataflow.js';
import { runScoring, runScoringWithBriefs } from '../orchestrator/scoring/runner.js';
import { runGeneration } from '../orchestrator/generate/runner.js';
import {
  followupSend,
  getSequenceStatus,
  launchDraft,
  launchSend,
  logOutcome,
  runSequencer,
} from '../orchestrator/sequencer/runner.js';
import { assertRecordAccessForMutation } from '../orchestrator/policy/canary-isolation.js';
import { runDashboard } from '../orchestrator/operator/dashboard.js';
import {
  assertToolSpecAvailable,
  getMcpClient,
  getToolkitDashboardUrl,
  listConnectedToolkits,
} from '../orchestrator/runtime/mcp.js';
import { hasComposioOAuthTokens, loginComposio } from '../orchestrator/runtime/composio-oauth.js';
import { listAnthropicModels, validateAnthropicKey } from '../orchestrator/runtime/anthropic.js';
import { listDeepInfraModels, validateDeepInfraModel } from '../orchestrator/runtime/deepinfra.js';
import { listXaiModels } from '../orchestrator/runtime/xai.js';
import { listOpenAiModels } from '../orchestrator/runtime/openai.js';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';
import { runCrmSync } from '../orchestrator/crm/runner.js';
import { getEnv, readGlobalEnv, writeGlobalEnv } from '../orchestrator/runtime/env.js';
import { planRouteAction } from '../orchestrator/actions/plan-route/index.js';
import { getRecordRowId } from '../orchestrator/lib/record.js';
import { diffUsageSnapshot, readUsageSnapshot, scaleUsageProjection } from '../orchestrator/lib/usage-projection.js';
import { flattenPipelineSteps } from '../orchestrator/lib/subpipelines.js';
import { snapshotCreateCommand } from './safety.js';
import { assertConfigModelReferences, assertPhaseModelReferences } from '../orchestrator/lib/model-validation.js';
import {
  listSupportedModels,
  readModelsState,
  setProviderModels,
  writeModelsState,
} from '../orchestrator/runtime/model-store.js';

export {
  mcpAddCommand,
  mcpListCommand,
  mcpRemoveCommand,
  mcpTestCommand,
} from './mcp.js';
export { leadAddCommand, leadOverridesCommand, leadSetCommand, leadUnsetCommand } from './leads.js';
export { attioDomainsCommand } from './attio-domains.js';
export { mailboxesListCommand, mailboxesShowCommand, mailboxesTestCommand } from './mailboxes.js';
export { briefCommand, briefShowCommand } from './briefs.js';
export { sourceTerritoryCommand } from './source-territory.js';
export { automationsCommand, automationsShowCommand } from './automations.js';
export {
  territoriesAssignCommand,
  territoriesListCommand,
  territoriesNoteCommand,
  territoriesShowCommand,
} from './territories.js';
export { purgeCommand } from './purge.js';
export { interruptCommand } from './interrupt.js';
export {
  stageReviewAuthorizeCommand,
  stageReviewListCommand,
} from './stage-review.js';
export {
  followupsCommand,
  interactionAddCommand,
  interactionDoneCommand,
  interactionEditCommand,
  interactionListCommand,
  interactionRemoveCommand,
  interactionShowCommand,
} from './interactions.js';
export {
  assetsCommand,
  assetsListCommand,
  assetsOpenCommand,
  assetsShowCommand,
} from './assets.js';

const listDirsFromCwd = () => {
  const cwd = process.cwd();
  return readdirSync(cwd, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(cwd, entry.name))
    .filter((dir) => existsSync(join(dir, 'outbound.yaml')));
};

export const DEEPINFRA_RECOMMENDED_MODELS = [
  'meta-llama/Meta-Llama-3.1-8B-Instruct',
  'meta-llama/Meta-Llama-3.1-70B-Instruct',
  'meta-llama/Meta-Llama-3.1-405B-Instruct',
  'deepseek-ai/DeepSeek-V3',
  'Qwen/Qwen2.5-72B-Instruct',
  'mistralai/Mixtral-8x7B-Instruct-v0.1',
];

const applyProviderModels = ({
  anthropicModels = [],
  deepinfraModels = [],
  xaiModels = [],
  openaiModels = [],
}: {
  anthropicModels?: string[];
  deepinfraModels?: string[];
  xaiModels?: string[];
  openaiModels?: string[];
}) => {
  let state = readModelsState();
  state = setProviderModels({
    state,
    providerId: 'anthropic',
    models: anthropicModels,
  });
  state = setProviderModels({
    state,
    providerId: 'deepinfra',
    models: deepinfraModels,
  });
  state = setProviderModels({
    state,
    providerId: 'xai',
    models: xaiModels,
  });
  state = setProviderModels({
    state,
    providerId: 'openai',
    models: openaiModels,
  });
  return writeModelsState(state);
};

const withUsageSampling = async ({
  listDir,
  sampledCount,
  totalCount,
  run,
}: {
  listDir: string;
  sampledCount: number;
  totalCount: number;
  run: () => Promise<any>;
}) => {
  const db = openListDb({ listDir, readonly: false });
  const before = readUsageSnapshot({ db });
  db.close();

  const result = await run();

  const dbAfter = openListDb({ listDir, readonly: true });
  const after = readUsageSnapshot({ db: dbAfter });
  dbAfter.close();
  const delta = diffUsageSnapshot({ before, after });
  const multiplier = sampledCount > 0 ? (Math.max(totalCount, sampledCount) / sampledCount) : 1;
  const projected = scaleUsageProjection({ delta, multiplier });
  return {
    result,
    sample: {
      sampled_count: sampledCount,
      total_count: totalCount,
      usage_delta: delta,
      projected_full_scale: projected,
      note: 'Agent-Outbound tracks AI usage only. Third-party tool costs are billed by providers and not visible here.',
    },
  };
};

const getBulkSnapshotThreshold = (config: any) => {
  const raw = Number(config?.safety?.bulk_snapshot_threshold || 100);
  if (!Number.isFinite(raw) || raw <= 0) return 100;
  return Math.max(1, Math.floor(raw));
};

const hasDestructiveConfigRemoval = (beforeConfig: any, afterConfig: any) => {
  const beforePipeline = new Set((Array.isArray(beforeConfig?.pipeline) ? beforeConfig.pipeline : []).map((step: any) => String(step?.id || '').trim()).filter(Boolean));
  const afterPipeline = new Set((Array.isArray(afterConfig?.pipeline) ? afterConfig.pipeline : []).map((step: any) => String(step?.id || '').trim()).filter(Boolean));
  for (const id of beforePipeline) {
    if (!afterPipeline.has(id)) return true;
  }
  const beforeSequences = Object.keys(beforeConfig?.sequences || {});
  const afterSequences = Object.keys(afterConfig?.sequences || {});
  for (const seq of beforeSequences) {
    if (!afterSequences.includes(seq)) return true;
    const beforeSteps = Array.isArray(beforeConfig?.sequences?.[seq]?.steps) ? beforeConfig.sequences[seq].steps.length : 0;
    const afterSteps = Array.isArray(afterConfig?.sequences?.[seq]?.steps) ? afterConfig.sequences[seq].steps.length : 0;
    if (afterSteps < beforeSteps) return true;
  }
  return false;
};

export const listCreateCommand = async ({ list, description = '' }) => {
  const listDir = resolveListDir(list);
  const existed = existsSync(join(listDir, 'outbound.yaml'));
  ensureListScaffold({ listDir, description });
  const db = openListDb({ listDir, readonly: false });
  db.close();
  return {
    status: existed ? 'exists' : 'created',
    list: listDir,
    files: ['outbound.yaml', '.outbound/prospects.db', '.outbound/.activity/history.jsonl', '.outbound/logs/'],
  };
};

export const listInfoCommand = ({ list }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    const counts = db.prepare('SELECT sequence_status AS status, COUNT(*) as count FROM records GROUP BY sequence_status').all();
    const rows = db.prepare('SELECT COUNT(*) as count FROM records').get();
    const scoreAvg = db.prepare('SELECT AVG(fit_score) as fit_avg, AVG(trigger_score) as trigger_avg FROM records').get();

    return {
      list: listDir,
      records: Number(rows?.count || 0),
      by_status: counts,
      avg_fit_score: Number(scoreAvg?.fit_avg || 0),
      avg_trigger_score: Number(scoreAvg?.trigger_avg || 0),
    };
  } finally {
    db.close();
  }
};

export const listsCommand = () => {
  const dirs = listDirsFromCwd();
  const lists = [];

  for (const listDir of dirs) {
    try {
      const info = listInfoCommand({ list: listDir });
      lists.push(info);
    } catch {
      lists.push({ list: listDir, error: 'Failed to read list.' });
    }
  }

  return { lists };
};

export const modelsListCommand = ({ provider = '', search = '' } = {}) => {
  const rows = listSupportedModels({ provider, search });
  const grouped: Record<string, number> = {};
  for (const row of rows) {
    grouped[row.provider] = Number(grouped[row.provider] || 0) + 1;
  }
  return {
    count: rows.length,
    by_provider: grouped,
    models: rows,
    source: 'local',
  };
};

export const modelsAddCommand = async ({ model = '' }) => {
  const raw = String(model || '').trim();
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) {
    throw new Error(`Invalid model "${raw}". Expected provider/model-id.`);
  }
  const providerId = raw.slice(0, slash).toLowerCase();
  const modelId = raw.slice(slash + 1);
  if (providerId !== 'deepinfra') {
    throw new Error('models add currently supports deepinfra/<model-id> only.');
  }
  const key = String(getEnv('DEEPINFRA_API_KEY') || '').trim();
  if (!key) {
    throw new Error('DEEPINFRA_API_KEY is missing. Run `agent-outbound init` to configure DeepInfra.');
  }
  const validation = await validateDeepInfraModel({ apiKey: key, modelId });
  if (!validation.ok) {
    throw new Error(validation.error || `DeepInfra model not found: ${modelId}`);
  }
  const state = readModelsState();
  const current = new Set((state.providers?.deepinfra?.models || []).map((item) => String(item || '').trim()));
  current.add(modelId);
  const written = applyProviderModels({
    anthropicModels: state.providers?.anthropic?.models || [],
    deepinfraModels: [...current],
    xaiModels: state.providers?.xai?.models || [],
  });
  return {
    status: 'added',
    model: `deepinfra/${modelId}`,
    models_path: written.path,
    deepinfra_models: written.state.providers?.deepinfra?.models?.length || 0,
  };
};

export const modelsRemoveCommand = ({ model = '' }) => {
  const raw = String(model || '').trim();
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) {
    throw new Error(`Invalid model "${raw}". Expected provider/model-id.`);
  }
  const providerId = raw.slice(0, slash).toLowerCase();
  const modelId = raw.slice(slash + 1);
  const state = readModelsState();
  const provider = state.providers?.[providerId];
  const existing = new Set((provider?.models || []).map((item) => String(item || '').trim()));
  const existed = existing.delete(modelId);
  let nextState = state;
  nextState = setProviderModels({
    state: nextState,
    providerId,
    models: [...existing],
  });
  const written = writeModelsState(nextState);
  return {
    status: existed ? 'removed' : 'not_found',
    model: `${providerId}/${modelId}`,
    models_path: written.path,
    provider_model_count: written.state.providers?.[providerId]?.models?.length || 0,
  };
};

export const modelsRefreshCommand = async ({
  deepinfraModels = [] as string[],
  keepExistingDeepinfra = false,
} = {}) => {
  const anthropicKey = String(getEnv('ANTHROPIC_API_KEY') || '').trim();
  const deepinfraKey = String(getEnv('DEEPINFRA_API_KEY') || '').trim();
  const xaiKey = String(getEnv('XAI_API_KEY') || '').trim();
  const openaiKey = String(getEnv('OPENAI_API_KEY') || '').trim();
  if (!anthropicKey && !deepinfraKey && !xaiKey && !openaiKey) {
    throw new Error('At least one provider key is required. Configure Anthropic, DeepInfra, xAI, and/or OpenAI in `agent-outbound init`.');
  }

  const current = readModelsState();
  const anthroList = anthropicKey
    ? await listAnthropicModels(anthropicKey)
    : { ok: false, error: 'not configured', models: [] as string[] };
  if (anthropicKey && !anthroList.ok) {
    throw new Error(`Anthropic refresh failed: ${anthroList.error}`);
  }
  const xaiList = xaiKey
    ? await listXaiModels(xaiKey)
    : { ok: false, error: 'not configured', models: [] as string[] };
  if (xaiKey && !xaiList.ok) {
    throw new Error(`xAI refresh failed: ${xaiList.error}`);
  }
  const openaiList = openaiKey
    ? await listOpenAiModels(openaiKey)
    : { ok: false, error: 'not configured', models: [] as string[] };
  if (openaiKey && !openaiList.ok) {
    throw new Error(`OpenAI refresh failed: ${openaiList.error}`);
  }

  let deepinfraSelected: string[] = [];
  if (deepinfraKey) {
    const diList = await listDeepInfraModels(deepinfraKey);
    if (!diList.ok) {
      throw new Error(`DeepInfra refresh failed: ${diList.error}`);
    }
    const available = new Set(diList.models);
    if (Array.isArray(deepinfraModels) && deepinfraModels.length > 0) {
      const normalizedRequested = [...new Set(deepinfraModels.map((item) => String(item || '').trim()).filter(Boolean))];
      const invalid = normalizedRequested.filter((item) => !available.has(item));
      if (invalid.length > 0) {
        throw new Error(`DeepInfra model(s) not found: ${invalid.join(', ')}`);
      }
      deepinfraSelected = normalizedRequested;
    } else {
      const requested = keepExistingDeepinfra
        ? (current.providers?.deepinfra?.models || [])
        : [];
      deepinfraSelected = [...new Set(requested.map((item) => String(item || '').trim()).filter(Boolean))]
        .filter((item) => available.has(item));
    }
  }

  const written = applyProviderModels({
    anthropicModels: anthropicKey ? (anthroList.models || []) : (current.providers?.anthropic?.models || []),
    deepinfraModels: deepinfraKey ? deepinfraSelected : (current.providers?.deepinfra?.models || []),
    xaiModels: xaiKey ? (xaiList.models || []) : (current.providers?.xai?.models || []),
    openaiModels: openaiKey ? (openaiList.models || []) : (current.providers?.openai?.models || []),
  });

  return {
    status: 'refreshed',
    models_path: written.path,
    providers: {
      anthropic: {
        configured: Boolean(anthropicKey),
        model_count: written.state.providers?.anthropic?.models?.length || 0,
      },
      deepinfra: {
        configured: Boolean(deepinfraKey),
        model_count: written.state.providers?.deepinfra?.models?.length || 0,
      },
      xai: {
        configured: Boolean(xaiKey),
        model_count: written.state.providers?.xai?.models?.length || 0,
      },
      openai: {
        configured: Boolean(openaiKey),
        model_count: written.state.providers?.openai?.models?.length || 0,
      },
    },
  };
};

export const configReadCommand = ({ list }) => {
  const listDir = resolveListDir(list);
  return readConfig(listDir);
};

export const configUpdateCommand = ({ list, yamlText = '', object = null }) => {
  const listDir = resolveListDir(list);
  let patch;
  if (object && typeof object === 'object') {
    patch = object;
  } else {
    patch = yaml.load(String(yamlText || '')) || {};
  }
  // Deep-merge the provided patch into the existing config so partial updates
  // don't wipe unrelated sections.
  const current = readConfig(listDir);
  const merged = deepMergeConfig(current.config || {}, patch);
  assertConfigModelReferences(merged || {});
  let snapshot: any = null;
  if (hasDestructiveConfigRemoval(current.config || {}, merged || {})) {
    snapshot = snapshotCreateCommand({
      list: listDir,
      label: `auto-before-config-update-${new Date().toISOString()}`,
    });
  }
  const result = writeConfig(listDir, merged);
  return { status: result.written ? 'updated' : 'validation_failed', ...result, auto_snapshot: snapshot };
};

export const configInferDepsCommand = ({ list, write = false }) => {
  const listDir = resolveListDir(list);
  const current = readConfig(listDir);
  const diff = pipelineDependencyDiff(current.config, { listDir });
  if (!write) {
    return {
      status: 'preview',
      path: getConfigPath(listDir),
      dependencies: diff,
      errors: current.errors || [],
      warnings: current.warnings || [],
      written: false,
    };
  }

  const backupPath = `${getConfigPath(listDir)}.bak`;
  copyFileSync(getConfigPath(listDir), backupPath);
  const next = mergeInferredPipelineDependencies(current.config, { listDir });
  const written = writeConfig(listDir, next);
  return {
    status: written.written ? 'updated' : 'validation_failed',
    path: written.path,
    backup_path: backupPath,
    dependencies: diff,
    errors: written.errors,
    warnings: written.warnings,
    written: written.written,
  };
};

export const configAuthorCommand = async ({ list, request, force = false }) => {
  const listDir = resolveListDir(list);
  const current = readConfig(listDir);
  const mcp = await getMcpClient();

  const patch = await authorConfigAction({
    mcp,
    currentConfig: current.config,
    request,
    listDir,
    force: Boolean(force),
  });
  if (patch?.usage) {
    const costDb = openListDb({ listDir, readonly: false });
    try {
      recordCostEvent({
        db: costDb,
        listDir,
        stepId: 'config:author',
        model: String((patch as any)?.model || ''),
        provider: String((patch as any)?.provider || ''),
        usage: patch.usage,
      });
    } finally {
      costDb.close();
    }
  }
  if (patch.replace === null) {
    return {
      status: 'validation_failed',
      changes: patch.changes || [],
      warnings: patch.warnings,
      errors: patch.warnings.filter((w) => typeof w === 'string' && w.startsWith('[')),
      notes: patch.notes,
      usage: patch.usage,
      path: getConfigPath(listDir),
      written: false,
    };
  }
  assertConfigModelReferences(patch.replace || {});
  let snapshot: any = null;
  if (hasDestructiveConfigRemoval(current.config || {}, patch.replace || {})) {
    snapshot = snapshotCreateCommand({
      list: listDir,
      label: `auto-before-config-author-${new Date().toISOString()}`,
    });
  }
  const removalOps = (patch.changes || [])
    .filter((change: any) => String(change?.op || '') === 'remove_pipeline_step')
    .map((change: any) => ({ id: String(change?.id || '').trim() }))
    .filter((change: any) => change.id);

  const written = writeConfig(listDir, patch.replace);
  const cleanup = [];
  if (written.written && removalOps.length > 0) {
    const db = openListDb({ listDir, readonly: false });
    try {
      for (const removal of removalOps) {
        cleanup.push({
          step_id: removal.id,
          ...cleanupRemovedStep({
            db,
            configBefore: current.config,
            configAfter: patch.replace,
            stepId: removal.id,
          }),
        });
      }
    } finally {
      db.close();
    }
  }
  return {
    status: written.written ? 'updated' : 'validation_failed',
    changes: patch.changes || [],
    warnings: patch.warnings,
    tool_resolution: patch.tool_resolution || null,
    errors: written.errors,
    notes: patch.notes,
    usage: patch.usage,
    path: written.path,
    written: written.written,
    auto_snapshot: snapshot,
    cleanup,
  };
};

export const refreshToolsCommand = async ({ list }) => {
  const listDir = resolveListDir(list);
  const current = readConfig(listDir);
  if (current.errors.length > 0) {
    return {
      status: 'validation_failed',
      errors: current.errors,
      path: getConfigPath(listDir),
      written: false,
    };
  }

  const mcp = await getMcpClient();
  const resolved = await resolveConfigToolCatalog({
    mcp,
    config: current.config,
    listDir,
  });
  const written = writeConfig(listDir, resolved.config);

  if (resolved.stats.tool_specs_unresolved > 0) {
    throw new AgentOutboundError({
      code: 'TOOL_NOT_CONNECTED',
      message: `${resolved.stats.tool_specs_unresolved} tool specification(s) could not be resolved.`,
      retryable: false,
      hint: 'Review tool_resolution.unresolved_tool_refs, then connect or correct each declared tool before retrying.',
      fields: {
        status: written.written ? 'tool_resolution_failed' : 'validation_failed',
        path: written.path,
        written: written.written,
        errors: written.errors,
        tool_resolution: resolved.stats,
      },
    });
  }

  return {
    status: written.written ? 'updated' : 'validation_failed',
    path: written.path,
    written: written.written,
    errors: written.errors,
    tool_resolution: resolved.stats,
  };
};

export const sourceCommand = async ({ list, limit = 0, dryRun = false, sample = 0, redensify = false }) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  assertPhaseModelReferences({ config, phase: 'source' });
  const searches = Array.isArray(config?.source?.searches) ? config.source.searches : [];
  const estimatedTotal = Number(limit || 0) > 0
    ? Number(limit || 0)
    : searches.reduce((sum: number, search: any) => sum + Number(search?.max_results || 0), 0);
  const threshold = getBulkSnapshotThreshold(config || {});

  if (dryRun) {
    return {
      dry_run: true,
      projected_records_scanned: estimatedTotal,
      searches: searches.map((search: any) => ({
        id: String(search?.id || ''),
        query: String(search?.query || ''),
        max_results: Number(search?.max_results || 0),
      })),
      redensify: Boolean(redensify),
      note: 'Dry-run performs no writes.',
    };
  }

  const sampleN = Math.max(0, Number(sample || 0));
  if (sampleN > 0) {
    return withUsageSampling({
      listDir,
      sampledCount: sampleN,
      totalCount: Math.max(sampleN, estimatedTotal || sampleN),
      run: () => runSourcing({ listDir, limit: sampleN, redensify }),
    });
  }
  const autoSnapshot = estimatedTotal >= threshold
    ? snapshotCreateCommand({ list: listDir, label: `auto-before-source-${new Date().toISOString()}` })
    : null;
  try {
    const sourced = await runSourcing({ listDir, limit: Number(limit || 0), redensify });
    return {
      ...sourced,
      status: sourced.status === 'partial' ? 'partial' : 'ok',
      auto_snapshot: autoSnapshot,
    };
  } catch (error) {
    return {
      status: 'error',
      searches_run: 0,
      found_total: 0,
      inserted_total: 0,
      inserted_ids: [],
      deduped_total: 0,
      filtered_out: 0,
      errors: [String((error as any)?.message || error)],
      auto_snapshot: autoSnapshot,
    };
  }
};

export const sourceMoreCommand = async ({ list, more = 0 }) => {
  const listDir = resolveListDir(list);
  const loaded = readConfig(listDir);
  assertPhaseModelReferences({ config: loaded.config, phase: 'source' });
  try {
    return await runSourcingMore({ listDir, targetNew: Number(more || 0) });
  } catch (error) {
    return {
      status: 'error',
      target_new: Number(more || 0),
      inserted_total: 0,
      inserted_ids: [],
      searches_run: 0,
      exhausted_searches: [],
      deduped_total: 0,
      filtered_out: 0,
      errors: [String((error as any)?.message || error)],
    };
  }
};

export const removeCommand = ({ list, row = '', where = '', keepTop = 0, sortBy = 'updated_at' }) => {
  const listDir = resolveListDir(list);
  const rowId = String(row || '').trim();
  const whereSql = String(where || '').trim();
  const keep = Number(keepTop || 0);
  const modes = [Boolean(rowId), Boolean(whereSql), keep > 0].filter(Boolean).length;
  if (modes !== 1) {
    throw new Error('Provide exactly one remove mode: --row, --where, or --keep-top.');
  }

  const db = openListDb({ listDir, readonly: false });
  const { config } = readConfig(listDir);
  const threshold = getBulkSnapshotThreshold(config || {});
  let autoSnapshot: any = null;
  try {
    if (rowId) {
      // Command-level canary gate (DB delete also enforces when listDir is pinned).
      assertRecordAccessForMutation({ listDir, recordId: rowId });
      const existing = db.prepare('SELECT COUNT(*) as n FROM records WHERE _row_id = ? OR id = ?').get(rowId, rowId);
      if (Number(existing?.n || 0) >= threshold) {
        autoSnapshot = snapshotCreateCommand({ list: listDir, label: `auto-before-remove-row-${new Date().toISOString()}` });
      }
      deleteRecord({ db, id: rowId });
      return {
        status: 'ok',
        mode: 'row',
        deleted_count: Number(existing?.n || 0),
        row_id: rowId,
        auto_snapshot: autoSnapshot,
      };
    }

    if (whereSql) {
      const whereCheck = validateWhereSql(whereSql);
      if (!whereCheck.ok) throw new Error(whereCheck.error || 'Invalid --where SQL fragment.');
      const toDelete = db.prepare(`SELECT COUNT(*) as n FROM records WHERE ${whereSql}`).get();
      if (Number(toDelete?.n || 0) >= threshold) {
        autoSnapshot = snapshotCreateCommand({ list: listDir, label: `auto-before-remove-where-${new Date().toISOString()}` });
      }
      const deleted = deleteRecordsBatch({ db, where: whereSql });
      return {
        status: 'ok',
        mode: 'where',
        where: whereSql,
        deleted_count: Number(deleted?.deleted || 0),
        auto_snapshot: autoSnapshot,
      };
    }

    const column = String(sortBy || '').trim() || 'updated_at';
    if (!validateColumnName(column)) {
      throw new Error(`Invalid --sort-by column "${column}".`);
    }
    const total = db.prepare('SELECT COUNT(*) as n FROM records').get();
    const candidate = Math.max(0, Number(total?.n || 0) - keep);
    if (candidate >= threshold) {
      autoSnapshot = snapshotCreateCommand({ list: listDir, label: `auto-before-remove-keep-top-${new Date().toISOString()}` });
    }
    const deleted = deleteRecordsKeepTop({ db, limit: keep, orderBy: column });
    return {
      status: 'ok',
      mode: 'keep_top',
      keep_top: keep,
      sort_by: column,
      deleted_count: Number(deleted?.deleted || 0),
      auto_snapshot: autoSnapshot,
    };
  } finally {
    db.close();
  }
};

export const pipelineCommand = async ({ list, where = '', limit = 0, dryRun = false, sample = 0, force = false, reapply = false, concurrency = 0 }) => {
  const listDir = resolveListDir(list);
  const loaded = readConfig(listDir);
  assertPhaseModelReferences({ config: loaded.config, phase: 'pipeline' });
  const whereSql = String(where || '').trim();
  const whereCheck = validateWhereSql(whereSql);
  if (!whereCheck.ok) throw new Error(whereCheck.error || 'Invalid --where SQL fragment.');

  const db = openListDb({ listDir, readonly: true });
  const totalCountRow = db.prepare(`
    SELECT COUNT(*) as count
    FROM records
    WHERE ${inPlayWhere()} AND sequence_status != 'opted_out' ${whereSql ? `AND (${whereSql})` : ''}
  `).get();
  db.close();
  const totalCount = Number(totalCountRow?.count || 0);
  const { config } = loaded;
  const threshold = getBulkSnapshotThreshold(config || {});

  if (dryRun) {
    // Impact preview: simulate the run (no writes) and report blast radius —
    // re-enrich counts + estimated cost, would-drop counts incl. committed
    // records that would be review-flagged rather than dropped.
    const impact = await runPipelineDataflow({
      listDir,
      where: whereSql,
      limit: Number(limit || 0),
      dryRun: true,
      force,
      reapply,
      concurrency: Number(concurrency || 0) || undefined,
    });
    return {
      ...impact,
      total_records_matching: totalCount,
      where: whereSql || '',
    };
  }

  const sampleN = Math.max(0, Number(sample || 0));
  if (sampleN > 0) {
    return withUsageSampling({
      listDir,
      sampledCount: sampleN,
      totalCount: Math.max(totalCount, sampleN),
      run: async () => {
        const pipeline = await runPipelineDataflow({
          listDir,
          where: whereSql,
          limit: sampleN,
          concurrency: Number(concurrency || 0) || undefined,
        });
        return {
          pipeline,
          scoring: null,
          note: 'Sample mode runs pipeline on N records and reports projections.',
        };
      },
    });
  }

  const autoSnapshot = totalCount >= threshold
    ? snapshotCreateCommand({ list: listDir, label: `auto-before-pipeline-${new Date().toISOString()}` })
    : null;
  const pipeline = await runPipelineDataflow({
    listDir,
    where: whereSql,
    limit: Number(limit || 0),
    force,
    reapply,
    concurrency: Number(concurrency || 0) || undefined,
  });
  return {
    pipeline,
    auto_snapshot: autoSnapshot,
  };
};

const millis = (value: string) => new Date(String(value || '')).getTime();

const durationText = (ms: number) => {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
};

const distinctCount = (items: string[]) => new Set(items.filter(Boolean)).size;

const costMatchesStep = (cost: any, stepId: string) => {
  const value = String(cost?.step_id || '');
  return value === stepId || value.endsWith(`:${stepId}`) || value.includes(stepId);
};

const safeAll = (db: any, sql: string, params: any[] = []) => {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
};

const batchStats = (batches: any[]) => {
  const sizes = batches.map((batch) => Number(batch?.size || 0)).filter((size) => size > 0);
  if (sizes.length === 0) return { count: 0, min: 0, avg: 0, max: 0 };
  return {
    count: sizes.length,
    min: Math.min(...sizes),
    avg: sizes.reduce((sum, size) => sum + size, 0) / sizes.length,
    max: Math.max(...sizes),
  };
};

const groupedErroredRecords = (events: any[]) => [...events.reduce((groups: Map<string, any>, event: any) => {
  const recordId = String(event.record_id || '');
  const stepId = String(event.step_id || '');
  const error = String(event.error || '');
  const key = `${recordId}\u0000${stepId}\u0000${error}`;
  const existing = groups.get(key);
  groups.set(key, {
    record_id: recordId,
    step_id: stepId,
    error,
    occurred_at: String(event.occurred_at || existing?.occurred_at || ''),
    attempts: Number(existing?.attempts || 0) + 1,
  });
  return groups;
}, new Map<string, any>()).values()];

const renderPipelineReport = (report: any) => {
  const erroredOverview = Number(report.overview.errored_attempts || 0) > Number(report.overview.errored || 0)
    ? `${report.overview.errored} records (${report.overview.errored_attempts} attempts)`
    : `${report.overview.errored}`;
  const stepLines = report.steps.map((step: any) => [
    step.step_id,
    step.kind,
    `eval=${step.evaluated}`,
    `pass=${step.passed}`,
    `drop=${step.dropped}`,
    `flag=${step.flagged}`,
    `err=${step.errored}`,
    `llm=${step.llm_calls}`,
    `batches=${step.batches}`,
    `batch=${step.batch_size.min}/${step.batch_size.avg.toFixed(1)}/${step.batch_size.max}`,
    `tok=${step.tokens_in}/${step.tokens_out}`,
    `span=${step.first_to_last || '-'}`,
    `dur=${step.step_duration || '-'}`,
    `avg=${step.avg_per_record_latency || '-'}`,
  ].join(' | '));
  const batchLines = report.batching.length > 0
    ? report.batching.map((entry: any) => `${entry.step_id}: ${entry.count} batches sizes=[${entry.sizes.join(',')}] reasons=${entry.reasons.join(',')}`)
    : ['(no batch_events for this run)'];
  const timelineLines = report.timeline.buckets.length > 0
    ? report.timeline.buckets.map((bucket: any) => `${bucket.bucket}: ${bucket.records} records`)
    : ['(no record completion events)'];
  const erroredLines = report.timeline.errored_records.length > 0
    ? report.timeline.errored_records.map((entry: any) => {
      const attempts = Number(entry.attempts || 0) > 1 ? ` (${entry.attempts} attempts)` : '';
      return `${entry.record_id || '(unknown)'} @ ${entry.step_id || '(unknown)'}${attempts}: ${entry.error || ''}`;
    })
    : ['(none)'];
  const overrideLines = Array.isArray(report.overrides) && report.overrides.length > 0
    ? report.overrides.map((entry: any) => `${String(entry.kind || '').toUpperCase()} ${entry.scope} · ${entry.business_name} (${entry.row_id}): ${entry.reason}`)
    : ['(none)'];
  return [
    'RUN OVERVIEW',
    `status: ${report.overview.status}`,
    `started: ${report.overview.started_at}`,
    `ended: ${report.overview.ended_at}`,
    `wall_clock: ${report.overview.wall_clock}`,
    `records_in: ${report.overview.records_in}`,
    `survivors: ${report.overview.survivors}`,
    `dropped: ${report.overview.dropped}`,
    `flagged: ${report.overview.flagged}`,
    `errored: ${erroredOverview}`,
    '',
    'PER-STEP',
    ...stepLines,
    '',
    'BATCHING DETAIL',
    ...batchLines,
    '',
    'COMPLETION TIMELINE',
    ...timelineLines,
    '',
    'ERRORED RECORDS',
    ...erroredLines,
    '',
    'OVERRIDES (active)',
    ...overrideLines,
    '',
    'TOTALS',
    `llm_calls: ${report.totals.llm_calls}`,
    `tokens_in: ${report.totals.tokens_in}`,
    `tokens_out: ${report.totals.tokens_out}`,
    `usd_cost: ${report.totals.usd_cost}`,
    `wall_clock: ${report.totals.wall_clock}`,
  ].join('\n');
};

export const pipelineReportCommand = ({ list, run = 'latest' }) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const steps = flattenPipelineSteps(config).map((step: any, index: number) => ({
    id: String(step?.id || '').trim() || `pipeline_step_${index + 1}`,
    kind: String(step?.kind || ''),
    dropGate: String(step?.kind || '') === 'filter' && String(step?.on_fail || 'drop').trim().toLowerCase() !== 'flag',
  }));
  const db = openListDb({ listDir, readonly: true });
  try {
    const runRow = String(run || 'latest') === 'latest'
      ? db.prepare("SELECT * FROM run_state WHERE phase = 'pipeline' ORDER BY started_at DESC LIMIT 1").get()
      : db.prepare("SELECT * FROM run_state WHERE phase = 'pipeline' AND run_id = ? LIMIT 1").get(String(run || ''));
    if (!runRow) throw new Error('No pipeline run found.');
    const startedAt = String(runRow.started_at || '');
    const endedAt = String(runRow.updated_at || startedAt);
    const runStartMs = millis(startedAt);
    const runEndMs = millis(endedAt);
    const pipelineEvents = safeAll(db, `
      SELECT * FROM pipeline_events
      WHERE occurred_at >= ? AND occurred_at <= ?
      ORDER BY occurred_at ASC
    `, [startedAt, endedAt]);
    const costEvents = safeAll(db, `
      SELECT * FROM cost_events
      WHERE occurred_at >= ? AND occurred_at <= ?
      ORDER BY occurred_at ASC
    `, [startedAt, endedAt]);
    const batchEvents = safeAll(db, `
      SELECT * FROM batch_events
      WHERE run_id = ?
      ORDER BY occurred_at ASC
    `, [String(runRow.run_id || '')]);
    const erroredEvents = safeAll(db, `
      SELECT * FROM errored_events
      WHERE run_id = ?
      ORDER BY occurred_at ASC
    `, [String(runRow.run_id || '')]);
    const stepReports = steps.map((step) => {
      const events = pipelineEvents.filter((event: any) => String(event.step_id || '') === step.id);
      const costs = costEvents.filter((cost: any) => costMatchesStep(cost, step.id));
      const batches = batchEvents.filter((batch: any) => String(batch.step_id || '') === step.id);
      const errors = erroredEvents.filter((error: any) => String(error.step_id || '') === step.id);
      const times = [
        ...events.map((event: any) => millis(event.occurred_at)),
        ...costs.map((cost: any) => millis(cost.occurred_at)),
        ...batches.map((batch: any) => millis(batch.occurred_at)),
        ...errors.map((error: any) => millis(error.occurred_at)),
      ].filter((time) => Number.isFinite(time) && time > 0);
      const first = times.length > 0 ? Math.min(...times) : 0;
      const last = times.length > 0 ? Math.max(...times) : 0;
      const stats = batchStats(batches);
      const evaluated = distinctCount([
        ...events.map((event: any) => String(event.record_id || '')),
        ...errors.map((error: any) => String(error.record_id || '')),
      ]);
      return {
        step_id: step.id,
        kind: step.kind,
        evaluated,
        passed: distinctCount(events.filter((event: any) => Number(event.passed || 0) === 1).map((event: any) => String(event.record_id || ''))),
        dropped: distinctCount(events.filter((event: any) => Number(event.passed || 0) === 0 && step.dropGate).map((event: any) => String(event.record_id || ''))),
        flagged: distinctCount(events.filter((event: any) => Number(event.passed || 0) === 0 && !step.dropGate).map((event: any) => String(event.record_id || ''))),
        errored: errors.length,
        llm_calls: costs.length,
        batches: stats.count,
        batch_size: { min: stats.min, avg: stats.avg, max: stats.max },
        tokens_in: costs.reduce((sum: number, cost: any) => sum + Number(cost.input_tokens || 0), 0),
        tokens_out: costs.reduce((sum: number, cost: any) => sum + Number(cost.output_tokens || 0), 0),
        first_to_last: first && last ? `${new Date(first).toISOString()} -> ${new Date(last).toISOString()}` : '',
        step_duration: first && last ? durationText(last - first) : '',
        avg_per_record_latency: evaluated > 0 && first && last ? durationText((last - first) / evaluated) : '',
      };
    });
    const recordLastEvents = new Map<string, number>();
    pipelineEvents.forEach((event: any) => {
      const recordId = String(event.record_id || '');
      const time = millis(event.occurred_at);
      if (!recordId || !Number.isFinite(time)) return;
      recordLastEvents.set(recordId, Math.max(Number(recordLastEvents.get(recordId) || 0), time));
    });
    const timelineBuckets = [...recordLastEvents.values()].reduce((buckets: Map<string, number>, time) => {
      const minute = Math.max(0, Math.floor((time - runStartMs) / 60000));
      const key = `${minute}m`;
      buckets.set(key, Number(buckets.get(key) || 0) + 1);
      return buckets;
    }, new Map<string, number>());
    const dropped = stepReports.reduce((sum: number, step: any) => sum + Number(step.dropped || 0), 0);
    const flagged = stepReports.reduce((sum: number, step: any) => sum + Number(step.flagged || 0), 0);
    const erroredAttempts = stepReports.reduce((sum: number, step: any) => sum + Number(step.errored || 0), 0);
    const errored = distinctCount(erroredEvents.map((event: any) => String(event.record_id || '')));
    const recordsIn = Number(runRow.target_count || 0);
    const totals = {
      llm_calls: costEvents.length,
      tokens_in: costEvents.reduce((sum: number, cost: any) => sum + Number(cost.input_tokens || 0), 0),
      tokens_out: costEvents.reduce((sum: number, cost: any) => sum + Number(cost.output_tokens || 0), 0),
      usd_cost: Number(costEvents.reduce((sum: number, cost: any) => sum + Number(cost.usd_cost || 0), 0).toFixed(6)),
      wall_clock: durationText(runEndMs - runStartMs),
    };
    const activeOverrides = listActiveOverrides({ db }).map((row: any) => {
      const record = getRecordById({ db, id: String(row.record_id) });
      return {
        kind: String(row.kind || ''),
        scope: String(row.step_id || '').trim() ? `gate:${row.step_id}` : (String(row.kind) === 'keep' ? 'all_gates' : 'manual'),
        row_id: String(row.record_id || ''),
        business_name: record ? String(record.business_name || record.name || '') : '(deleted record)',
        reason: String(row.reason || ''),
      };
    });
    const report = {
      run_id: String(runRow.run_id || ''),
      overrides: activeOverrides,
      overview: {
        status: String(runRow.status || ''),
        started_at: startedAt,
        ended_at: endedAt,
        wall_clock: durationText(runEndMs - runStartMs),
        records_in: recordsIn,
        survivors: Math.max(0, recordsIn - dropped),
        dropped,
        flagged,
        errored,
        errored_attempts: erroredAttempts,
      },
      steps: stepReports,
      batching: steps
        .map((step) => ({
          step_id: step.id,
          events: batchEvents.filter((batch: any) => String(batch.step_id || '') === step.id),
        }))
        .filter((entry) => entry.events.length > 0)
        .map((entry) => ({
          step_id: entry.step_id,
          count: entry.events.length,
          sizes: entry.events.map((event: any) => Number(event.size || 0)),
          reasons: entry.events.map((event: any) => String(event.reason || '')),
        })),
      timeline: {
        buckets: [...timelineBuckets.entries()].map(([bucket, records]) => ({ bucket, records })),
        errored_records: groupedErroredRecords(erroredEvents),
      },
      totals,
    };
    return { ...report, summary: renderPipelineReport(report) };
  } finally {
    db.close();
  }
};

export const runCommand = async ({ list, more = 0 }) => {
  const listDir = resolveListDir(list);
  const loaded = readConfig(listDir);
  assertPhaseModelReferences({ config: loaded.config, phase: 'source' });
  assertPhaseModelReferences({ config: loaded.config, phase: 'pipeline' });
  assertPhaseModelReferences({ config: loaded.config, phase: 'score' });

  // Canary isolation scopes the full run surface — not only the pipeline pass.
  const { loadCanaryConfig, filterRecordsForCanary } = await import(
    '../orchestrator/policy/canary-isolation.js'
  );
  const canaryConfig = loadCanaryConfig({ listDir });

  const sourceResult: any = Number(more || 0) > 0
    ? await runSourcingMore({ listDir, targetNew: Number(more || 0) })
    : await runSourcing({ listDir, limit: 0 });

  const newIds = Array.isArray(sourceResult?.inserted_ids) ? sourceResult.inserted_ids : [];
  // Intersect newly sourced IDs with canary allowlist when isolation is active.
  const scopedNew = filterRecordsForCanary(
    newIds.map((id: string) => ({ _row_id: id })),
    canaryConfig,
  ).map((r: any) => String(r._row_id));
  const pipelineResult = await (async () => {
    if (scopedNew.length === 0) return null;
    const escaped = scopedNew.map((id: string) => `'${String(id || '').replace(/'/g, "''")}'`).join(', ');
    return runPipelineDataflow({ listDir, where: `_row_id IN (${escaped})` });
  })();

  // Score/generate must not re-query the unfiltered production corpus under canary.
  const allowIds = (canaryConfig.allowlist_record_ids || []).map((id) => String(id).trim()).filter(Boolean);
  const canaryWhere = canaryConfig.mode !== 'off' && allowIds.length > 0
    ? `_row_id IN (${allowIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')})`
    : (canaryConfig.mode !== 'off' ? `_row_id IN ('__canary_none__')` : '');

  const scoreResult = await runScoringWithBriefs({
    listDir,
    ...(canaryWhere ? { where: canaryWhere } : {}),
  });
  const generateResult = await runGeneration({
    listDir,
    ...(canaryWhere ? { where: canaryWhere } : {}),
  });

  return {
    source: sourceResult,
    pipeline: pipelineResult,
    score: scoreResult,
    generate: generateResult,
  };
};

export const scoreCommand = async ({ list, where = '', dryRun = false, sample = 0, force = false }) => {
  const listDir = resolveListDir(list);
  const loaded = readConfig(listDir);
  assertPhaseModelReferences({ config: loaded.config, phase: 'score' });
  const whereSql = String(where || '').trim();
  const whereCheck = validateWhereSql(whereSql);
  if (!whereCheck.ok) throw new Error(whereCheck.error || 'Invalid --where SQL fragment.');

  const db = openListDb({ listDir, readonly: true });
  const total = db.prepare(`
    SELECT COUNT(*) as count
    FROM records
    WHERE ${inPlayWhere()} ${whereSql ? `AND (${whereSql})` : ''}
  `).get();
  db.close();
  const totalCount = Number(total?.count || 0);
  const { config } = loaded;
  const threshold = getBulkSnapshotThreshold(config || {});

  if (dryRun) {
    return runScoring({
      listDir, where: whereSql, dryRun: true, force,
    });
  }
  const sampleN = Math.max(0, Number(sample || 0));
  if (sampleN > 0) {
    return withUsageSampling({
      listDir,
      sampledCount: sampleN,
      totalCount: Math.max(totalCount, sampleN),
      run: () => runScoring({
        listDir, where: whereSql, limit: sampleN, force,
      }),
    });
  }
  const autoSnapshot = totalCount >= threshold
    ? snapshotCreateCommand({ list: listDir, label: `auto-before-score-${new Date().toISOString()}` })
    : null;
  const scored = await runScoringWithBriefs({ listDir, where: whereSql, force });
  return {
    ...scored,
    auto_snapshot: autoSnapshot,
  };
};

/**
 * Deterministic policy projection (treatment, priority, next-action, readiness)
 * without model calls. Uses score_breakdown grades when present.
 */
export const policyApplyCommand = async ({ list, where = '', limit = 0, dryRun = false }) => {
  const listDir = resolveListDir(list);
  const whereSql = String(where || '').trim();
  const whereCheck = validateWhereSql(whereSql);
  if (!whereCheck.ok) throw new Error(whereCheck.error || 'Invalid --where SQL fragment.');

  const { applyOutboundPolicy } = await import('../orchestrator/policy/index.js');
  const { ensureRecordColumns, openListDb: openDb, upsertRecord, inPlayWhere } = await import('../orchestrator/runtime/db.js');

  const db = openDb({ listDir, readonly: Boolean(dryRun) });
  const limitN = Math.max(0, Number(limit || 0));
  const params: unknown[] = [];
  let sql = `SELECT * FROM records WHERE ${inPlayWhere()} ${whereSql ? `AND (${whereSql})` : ''} ORDER BY updated_at DESC`;
  if (limitN > 0) {
    sql += ' LIMIT ?';
    params.push(limitN);
  }
  const rows = db.prepare(sql).all(...params);
  const summary = {
    matched: rows.length,
    updated: 0,
    dry_run: Boolean(dryRun),
    tiers: {} as Record<string, number>,
    integrity_errors: 0,
    sample: [] as Array<Record<string, unknown>>,
  };

  for (const record of rows) {
    const { loadCampaignContactsFromDb, hydrateRecordCostLedger } = await import('../orchestrator/policy/index.js');
    const rowId = String(record._row_id || '');
    const campaignContacts = loadCampaignContactsFromDb(db, rowId);
    const costHydrate = hydrateRecordCostLedger({ db, recordId: rowId, record });
    const result = applyOutboundPolicy({
      record: { ...record, ...costHydrate.patch },
      recomputeFitFromBreakdown: true,
      contacts: campaignContacts.length ? campaignContacts : undefined,
      campaignId: `camp_${record._row_id}`,
      costLedger: costHydrate.ledger,
      enrichmentSpendUsd: costHydrate.enrichment_usd,
    });
    summary.tiers[result.treatment_tier] = (summary.tiers[result.treatment_tier] || 0) + 1;
    if (result.integrity_errors.length) summary.integrity_errors += 1;
    if (summary.sample.length < 5) {
      summary.sample.push({
        _row_id: record._row_id,
        treatment_tier: result.treatment_tier,
        mail_treatment: result.mail_treatment,
        priority_lane: result.priority_lane,
        priority_rank: result.priority_rank,
        next_action_type: result.next_action?.action_type,
        eligibility: result.eligibility_outcome,
      });
    }
    if (!dryRun) {
      ensureRecordColumns({ db, columns: Object.keys(result.patch) });
      upsertRecord({ db, row: { ...record, ...result.patch } });
      summary.updated += 1;
    }
  }
  db.close();
  return summary;
};

export const generateCommand = async ({ list, where = '', step = '', force = false, dryRun = false, sample = 0 }) => {
  const listDir = resolveListDir(list);
  const loaded = readConfig(listDir);
  assertPhaseModelReferences({ config: loaded.config, phase: 'pipeline' });
  const whereSql = String(where || '').trim();
  const whereCheck = validateWhereSql(whereSql);
  if (!whereCheck.ok) throw new Error(whereCheck.error || 'Invalid --where SQL fragment.');

  const db = openListDb({ listDir, readonly: true });
  const total = db.prepare(`
    SELECT COUNT(*) as count
    FROM records
    WHERE ${inPlayWhere()} AND sequence_status != 'opted_out' ${whereSql ? `AND (${whereSql})` : ''}
  `).get();
  db.close();
  const totalCount = Number(total?.count || 0);
  const { config } = loaded;
  const threshold = getBulkSnapshotThreshold(config || {});

  if (dryRun) {
    return {
      dry_run: true,
      where: whereSql,
      step_id: String(step || ''),
      matching_in_play_records: totalCount,
      note: 'Dry-run reports scope only; generation is not executed.',
    };
  }
  const sampleN = Math.max(0, Number(sample || 0));
  if (sampleN > 0) {
    return withUsageSampling({
      listDir,
      sampledCount: sampleN,
      totalCount: Math.max(totalCount, sampleN),
      run: () => runGeneration({ listDir, where: whereSql, stepId: String(step || ''), force, limit: sampleN }),
    });
  }
  const autoSnapshot = totalCount >= threshold
    ? snapshotCreateCommand({ list: listDir, label: `auto-before-generate-${new Date().toISOString()}` })
    : null;
  const generated = await runGeneration({ listDir, where: whereSql, stepId: String(step || ''), force });
  return {
    ...generated,
    auto_snapshot: autoSnapshot,
  };
};

export const sequenceRunCommand = async ({ list, allLists = false, sequenceName = '', dryRun = false, sample = 0 }) => {
  if (allLists) {
    const dirs = listDirsFromCwd();
    const runs = [];
    for (const dir of dirs) {
      const loaded = readConfig(dir);
      assertPhaseModelReferences({ config: loaded.config, phase: 'sequence' });
      runs.push({ list: dir, result: await runSequencer({ listDir: dir, sequenceName, dryRun, sample }) });
    }
    return { runs };
  }

  const listDir = resolveListDir(list);
  const loaded = readConfig(listDir);
  assertPhaseModelReferences({ config: loaded.config, phase: 'sequence' });
  if (dryRun) {
    return runSequencer({ listDir, sequenceName, dryRun: true, sample });
  }
  const sampleN = Math.max(0, Number(sample || 0));
  if (sampleN > 0) {
    const db = openListDb({ listDir, readonly: true });
    const total = db.prepare(`SELECT COUNT(*) as count FROM records WHERE ${inPlayWhere()}`).get();
    db.close();
    return withUsageSampling({
      listDir,
      sampledCount: sampleN,
      totalCount: Math.max(Number(total?.count || 0), sampleN),
      run: () => runSequencer({ listDir, sequenceName, dryRun: false, sample: sampleN }),
    });
  }
  const db = openListDb({ listDir, readonly: true });
  const total = db.prepare(`SELECT COUNT(*) as count FROM records WHERE ${inPlayWhere()}`).get();
  db.close();
  const { config } = readConfig(listDir);
  const threshold = getBulkSnapshotThreshold(config || {});
  const autoSnapshot = Number(total?.count || 0) >= threshold
    ? snapshotCreateCommand({ list: listDir, label: `auto-before-sequence-run-${new Date().toISOString()}` })
    : null;
  const result = await runSequencer({ listDir, sequenceName, dryRun: false, sample: 0 });
  return { ...result, auto_snapshot: autoSnapshot };
};

export const sequenceStatusCommand = ({ list }) => {
  const listDir = resolveListDir(list);
  return getSequenceStatus({ listDir });
};

export const launchDraftCommand = async ({ list, sequenceName = '', limit = 50, dryRun = false, sample = 0 }) => {
  const listDir = resolveListDir(list);
  const loaded = readConfig(listDir);
  assertPhaseModelReferences({ config: loaded.config, phase: 'sequence' });
  const db = openListDb({ listDir, readonly: true });
  const candidate = db.prepare(`
    SELECT COUNT(*) as count
    FROM records
    WHERE ${inPlayWhere()} AND sequence_status = 'idle'
  `).get();
  db.close();
  const totalCount = Number(candidate?.count || 0);
  const { config } = loaded;
  const threshold = getBulkSnapshotThreshold(config || {});
  if (dryRun) {
    return {
      dry_run: true,
      projected_records: Math.min(Number(limit || 50), totalCount),
      total_candidates: totalCount,
      sequence: sequenceName,
    };
  }
  const sampleN = Math.max(0, Number(sample || 0));
  if (sampleN > 0) {
    return withUsageSampling({
      listDir,
      sampledCount: sampleN,
      totalCount: Math.max(totalCount, sampleN),
      run: () => launchDraft({ listDir, sequenceName, limit: sampleN }),
    });
  }
  const autoSnapshot = totalCount >= threshold
    ? snapshotCreateCommand({ list: listDir, label: `auto-before-launch-draft-${new Date().toISOString()}` })
    : null;
  const result = await launchDraft({ listDir, sequenceName, limit: Number(limit || 50) });
  return { ...result, auto_snapshot: autoSnapshot };
};

export const launchSendCommand = async ({ list, limit = 50, dryRun = false, sample = 0 }) => {
  const listDir = resolveListDir(list);
  const loaded = readConfig(listDir);
  assertPhaseModelReferences({ config: loaded.config, phase: 'sequence' });
  const db = openListDb({ listDir, readonly: true });
  const candidate = db.prepare(`
    SELECT COUNT(*) as count
    FROM records
    WHERE sequence_status = 'idle'
  `).get();
  db.close();
  const totalCount = Number(candidate?.count || 0);
  const { config } = loaded;
  const threshold = getBulkSnapshotThreshold(config || {});
  if (dryRun) {
    return {
      dry_run: true,
      projected_records: Math.min(Number(limit || 50), totalCount),
      total_candidates: totalCount,
      note: 'Dry-run does not dispatch sends.',
    };
  }
  const sampleN = Math.max(0, Number(sample || 0));
  if (sampleN > 0) {
    return withUsageSampling({
      listDir,
      sampledCount: sampleN,
      totalCount: Math.max(totalCount, sampleN),
      run: () => launchSend({ listDir, limit: sampleN }),
    });
  }
  const autoSnapshot = totalCount >= threshold
    ? snapshotCreateCommand({ list: listDir, label: `auto-before-launch-send-${new Date().toISOString()}` })
    : null;
  const result = await launchSend({ listDir, limit: Number(limit || 50) });
  return { ...result, auto_snapshot: autoSnapshot };
};

export const followupSendCommand = async ({ list, limit = 50 }) => {
  const listDir = resolveListDir(list);
  return followupSend({ listDir, limit: Number(limit || 50) });
};

export const dashboardCommand = async ({ list = '', allLists = false, alerts = false }) => {
  return runDashboard({ list, allLists, alerts });
};

export const visitsTodayCommand = ({ list = '', allLists = false, date = '' }) => {
  const routeDate = String(date || new Date().toISOString().slice(0, 10)).trim();
  const targets = allLists
    ? listDirsFromCwd()
    : list
      ? [resolveListDir(list)]
      : [];

  if (targets.length === 0) {
    return {
      status: 'error',
      error: 'Provide --list LIST or --all-lists.',
    };
  }

  const lists = [];
  let totalStops = 0;

  for (const listDir of targets) {
    const db = openListDb({ listDir, readonly: true });
    try {
      const stops = db.prepare(`
        SELECT
          rs.id,
          rs.route_id,
          rs.record_id,
          rs.stop_order,
          rs.scheduled_time,
          rs.drive_minutes_from_prev,
          rs.calendar_event_id,
          rs.eta,
          rs.notes,
          rt.route_date,
          rt.status AS route_status,
          rec.business_name,
          rec.address,
          rec.phone,
          COALESCE(rec.fit_score, rec.priority_rank) AS priority_rank
        FROM route_stops rs
        INNER JOIN routes rt ON rt.id = rs.route_id
        LEFT JOIN records rec ON rec._row_id = rs.record_id OR rec.id = rs.record_id
        WHERE rt.route_date = ?
        ORDER BY rs.scheduled_time ASC, rs.stop_order ASC
      `).all(routeDate);

      totalStops += stops.length;
      lists.push({
        list: listDir,
        route_date: routeDate,
        stops,
        count: stops.length,
      });
    } finally {
      db.close();
    }
  }

  return {
    status: 'ok',
    route_date: routeDate,
    all_lists: allLists,
    total_stops: totalStops,
    lists,
  };
};

export const routePlanCommand = async ({ list, date = '' }) => {
  const listDir = resolveListDir(list);
  const routeDate = String(date || new Date().toISOString().slice(0, 10)).trim();
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) throw new Error(`Invalid config: ${errors.join('; ')}`);
  assertPhaseModelReferences({ config, phase: 'sequence' });

  const db = openListDb({ listDir, readonly: false });
  try {
    const due = db.prepare(`
      SELECT * FROM records
      WHERE ${inPlayWhere()} AND visit_scheduled_date = ? AND sequence_status = 'active'
      ORDER BY COALESCE(fit_score, priority_rank) DESC, updated_at DESC
    `).all(routeDate);

    if (due.length === 0) {
      return { status: 'ok', route_date: routeDate, stops: 0, route_id: '' };
    }

    const mcp = await getMcpClient();
    const toolSpec = (config?.channels?.visit as any)?.tool || {};
    const hasToolkit = Array.isArray(toolSpec?.toolkits) && toolSpec.toolkits.length > 0;
    const hasTools = Array.isArray(toolSpec?.tools) && toolSpec.tools.length > 0;
    if (!hasToolkit && !hasTools) {
      throw new Error('Route planning requires channels.visit.tool to be configured.');
    }
    await assertToolSpecAvailable({
      toolSpec,
      capability: 'visit route planning',
    });
    const route = await planRouteAction({
      mcp,
      routeDate,
      territory: config?.list?.territory || {},
      stops: due,
      toolSpec,
      toolCatalog: readToolCatalog(listDir),
      aiConfig: config?.ai || {},
      model: config?.channels?.visit?.model || '',
      listDir,
    });
    recordCostEvent({
      db,
      listDir,
      stepId: 'route:plan',
      model: String((route as any)?.model || ''),
      provider: String((route as any)?.provider || ''),
      usage: route.usage,
    });

    const routeId = `route_${routeDate}_${randomUUID().slice(0, 8)}`;
    db.prepare(`
      INSERT INTO routes (id, route_date, status, total_drive_minutes, summary_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      routeId,
      routeDate,
      'planned',
      Number(route.total_drive_minutes || 0),
      JSON.stringify({ summary: route.summary || '' }),
      new Date().toISOString(),
      new Date().toISOString()
    );

    for (const stop of route.stops || []) {
      db.prepare(`
        INSERT INTO route_stops (
          id, route_id, record_id, stop_order, scheduled_time, drive_minutes_from_prev, calendar_event_id, eta, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        routeId,
        stop.record_id,
        Number(stop.stop_order || 0),
        String(stop.scheduled_time || ''),
        Number(stop.drive_minutes_from_prev || 0),
        String(stop.calendar_event_id || ''),
        String(stop.eta || ''),
        String(stop.notes || ''),
        new Date().toISOString(),
        new Date().toISOString()
      );

      const row = due.find((item) => getRecordRowId(item) === stop.record_id);
      if (!row) continue;
      upsertRecord({
        db,
        row: {
          ...row,
          visit_route_id: routeId,
          visit_route_position: Number(stop.stop_order || 0),
          visit_scheduled_date: routeDate,
        },
      });
    }

    return {
      status: 'ok',
      route_id: routeId,
      route_date: routeDate,
      total_drive_minutes: Number(route.total_drive_minutes || 0),
      stops: Number((route.stops || []).length),
      summary: route.summary || '',
    };
  } finally {
    db.close();
  }
};

export const duplicatesListCommand = ({ list, status = 'needs_review', limit = 100 }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    const rows = db.prepare(`
      SELECT _row_id, business_name, duplicate_of, duplicate_status, updated_at
      FROM records
      WHERE duplicate_status = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(String(status || 'needs_review'), Number(limit || 100));
    return {
      status: 'ok',
      list: listDir,
      duplicate_status: String(status || 'needs_review'),
      count: rows.length,
      rows,
    };
  } finally {
    db.close();
  }
};

export const duplicatesConfirmCommand = ({ list, rowId = '', canonicalRowId = '' }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const id = String(rowId || '').trim();
    const canonical = String(canonicalRowId || '').trim();
    if (!id || !canonical) return { status: 'error', error: 'Provide --row and --canonical.' };

    const row = db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1').get(id, id);
    if (!row) return { status: 'error', error: `Row not found: ${id}` };
    const target = db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1').get(canonical, canonical);
    if (!target) return { status: 'error', error: `Canonical row not found: ${canonical}` };

    upsertRecord({
      db,
      row: {
        ...row,
        duplicate_of: getRecordRowId(target),
        duplicate_status: 'confirmed',
      },
    });

    return {
      status: 'confirmed',
      row_id: getRecordRowId(row),
      duplicate_of: getRecordRowId(target),
    };
  } finally {
    db.close();
  }
};

export const duplicatesBreakCommand = ({ list, rowId = '' }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const id = String(rowId || '').trim();
    if (!id) return { status: 'error', error: 'Provide --row.' };
    const row = db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1').get(id, id);
    if (!row) return { status: 'error', error: `Row not found: ${id}` };
    upsertRecord({
      db,
      row: {
        ...row,
        duplicate_of: '',
        duplicate_status: '',
      },
    });
    return { status: 'unlinked', row_id: getRecordRowId(row) };
  } finally {
    db.close();
  }
};

export const logCommand = ({ list, prospect, action, note = '', transition = '', followUpIn = '' }) => {
  const listDir = resolveListDir(list);
  return logOutcome({ listDir, prospect, action, note, transition, followUpIn });
};

export const crmSyncCommand = async ({ list, limit = 200 }) => {
  const listDir = resolveListDir(list);
  return runCrmSync({ listDir, where: '1=1', limit: Number(limit || 200) });
};

export const authListCommand = async () => {
  try {
    const toolkits = await listConnectedToolkits();
    return {
      status: 'ok',
      connected_toolkits: toolkits,
    };
  } catch (error) {
    return {
      status: 'error',
      error: String(error?.message || error),
    };
  }
};

export const authConnectCommand = async ({ toolkit }) => {
  const slug = String(toolkit || '').trim().toUpperCase();
  if (!slug) {
    return { status: 'error', error: 'Toolkit is required.' };
  }
  return {
    status: 'ok',
    toolkit: slug,
    dashboard_url: getToolkitDashboardUrl(slug),
    note: 'Connect this toolkit in your Composio dashboard. agent-outbound does not initiate OAuth or manage connections.',
  };
};

export const authLoginCommand = async () => {
  const result = await loginComposio();
  if (!result.ok) {
    return {
      status: 'error',
      authenticated: false,
      error: result.error || 'Composio OAuth login failed.',
    };
  }
  return {
    status: 'ok',
    authenticated: true,
    connected_toolkits: result.toolkits || [],
  };
};

const writeEnvUpdates = (updates: Record<string, string>) => {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(updates)) {
    const trimmed = String(value || '').trim();
    if (trimmed) cleaned[key] = trimmed;
  }
  if (Object.keys(cleaned).length === 0) return getGlobalEnvPath();
  return writeGlobalEnv(cleaned);
};

export const initCommand = async ({
  anthropicApiKey = '',
  deepinfraApiKey = '',
  deepinfraModels = [] as string[],
  keepExistingDeepinfra = false,
} = {}) => {
  ensureGlobalDirs();

  const updates: Record<string, string> = {};
  if (anthropicApiKey) updates.ANTHROPIC_API_KEY = anthropicApiKey;
  if (deepinfraApiKey) updates.DEEPINFRA_API_KEY = deepinfraApiKey;

  const envPath = writeEnvUpdates(updates);
  const env = readGlobalEnv();

  const effectiveAnthropicKey = String(env.ANTHROPIC_API_KEY || '').trim();
  const effectiveDeepinfraKey = String(env.DEEPINFRA_API_KEY || '').trim();
  const effectiveXaiKey = String(env.XAI_API_KEY || '').trim();

  const composioAuthenticated = await hasComposioOAuthTokens();
  const composioToolkits = composioAuthenticated
    ? await listConnectedToolkits().catch(() => [] as string[])
    : [];

  const anthropic = effectiveAnthropicKey
    ? await validateAnthropicKey(effectiveAnthropicKey)
    : { ok: false, error: 'ANTHROPIC_API_KEY is not set.', models: [] as string[] };
  const deepinfra = effectiveDeepinfraKey
    ? await listDeepInfraModels(effectiveDeepinfraKey)
    : { ok: false, error: 'DEEPINFRA_API_KEY is not set.', models: [] as string[] };
  const xai = effectiveXaiKey
    ? await listXaiModels(effectiveXaiKey)
    : { ok: false, error: 'XAI_API_KEY is not set.', models: [] as string[] };

  const hasValidLlmProvider = Boolean(anthropic.ok || deepinfra.ok || xai.ok);
  if (!hasValidLlmProvider) {
    throw new Error('At least one LLM provider key must be configured and valid (Anthropic, DeepInfra, and/or xAI).');
  }

  const currentModels = readModelsState();
  let selectedDeepinfraModels: string[] = [];
  if (deepinfra.ok) {
    const available = new Set(deepinfra.models || []);
    if (Array.isArray(deepinfraModels) && deepinfraModels.length > 0) {
      const normalizedRequested = [...new Set(deepinfraModels.map((item) => String(item || '').trim()).filter(Boolean))];
      const invalid = normalizedRequested.filter((modelId) => !available.has(modelId));
      if (invalid.length > 0) {
        throw new Error(`DeepInfra model(s) not found: ${invalid.join(', ')}`);
      }
      selectedDeepinfraModels = normalizedRequested;
    } else {
      const current = keepExistingDeepinfra
        ? (currentModels.providers?.deepinfra?.models || [])
        : (currentModels.providers?.deepinfra?.models || DEEPINFRA_RECOMMENDED_MODELS);
      selectedDeepinfraModels = [...new Set(current.map((item) => String(item || '').trim()).filter(Boolean))]
        .filter((modelId) => available.has(modelId));
    }
  }

  const writtenModels = applyProviderModels({
    anthropicModels: anthropic.ok ? (anthropic.models || []) : (currentModels.providers?.anthropic?.models || []),
    deepinfraModels: deepinfra.ok ? selectedDeepinfraModels : (currentModels.providers?.deepinfra?.models || []),
    xaiModels: xai.ok ? (xai.models || []) : (currentModels.providers?.xai?.models || []),
  });

  return {
    status: composioAuthenticated && hasValidLlmProvider ? 'ok' : 'incomplete',
    env_path: envPath,
    models_path: writtenModels.path,
    composio: {
      authenticated: composioAuthenticated,
      error: composioAuthenticated ? undefined : 'Run `agent-outbound auth login` to authenticate Composio.',
      toolkits: composioToolkits,
    },
    anthropic: {
      has_key: Boolean(effectiveAnthropicKey),
      valid: Boolean(anthropic.ok),
      error: anthropic.ok ? undefined : anthropic.error,
      model_count: anthropic.ok ? (anthropic.models || []).length : 0,
    },
    deepinfra: {
      has_key: Boolean(effectiveDeepinfraKey),
      valid: Boolean(deepinfra.ok),
      error: deepinfra.ok ? undefined : deepinfra.error,
      model_count: selectedDeepinfraModels.length,
    },
    xai: {
      has_key: Boolean(effectiveXaiKey),
      valid: Boolean(xai.ok),
      error: xai.ok ? undefined : xai.error,
      model_count: xai.ok ? (xai.models || []).length : 0,
    },
  };
};

export const reconcileCommand = ({ list, staleMinutes = 30 }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const cutoff = new Date(Date.now() - Number(staleMinutes || 30) * 60 * 1000).toISOString();
    const pending = db.prepare(`
      SELECT * FROM idempotency
      WHERE status = 'pending' AND updated_at < ?
      ORDER BY updated_at ASC
    `).all(cutoff);

    for (const row of pending) {
      db.prepare('UPDATE idempotency SET status = ?, updated_at = ? WHERE id = ?')
        .run('failed', new Date().toISOString(), row.id);
    }

    return {
      status: 'ok',
      pending_marked_failed: pending.length,
      cutoff,
    };
  } finally {
    db.close();
  }
};

export const suppressCommand = ({ list, value, valueType = 'email', reason = 'manual_suppress', source = 'operator' }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  const globalDb = openGlobalSuppressionDb({ readonly: false });
  try {
    const entry = {
      id: randomUUID(),
      value: String(value || '').trim().toLowerCase(),
      value_type: String(valueType || 'email').trim().toLowerCase(),
      scope: 'global',
      reason: String(reason || 'manual_suppress'),
      source: String(source || 'operator'),
      record_id: '',
      created_at: new Date().toISOString(),
    };

    addSuppression({ db, entry });
    addSuppression({ db: globalDb, entry });
    return { status: 'suppressed', ...entry };
  } finally {
    db.close();
    globalDb.close();
  }
};

export const forgetCommand = ({ list, email = '', phone = '' }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  const globalDb = openGlobalSuppressionDb({ readonly: false });
  try {
    const clauses = [];
    const params = [];
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedPhone = String(phone || '').trim();

    if (normalizedEmail) {
      clauses.push('lower(email_primary) = ?');
      params.push(normalizedEmail);
    }
    if (normalizedPhone) {
      clauses.push('phone = ?');
      params.push(normalizedPhone);
    }

    if (clauses.length === 0) {
      return { status: 'error', error: 'Provide --email and/or --phone.' };
    }

    const rows = db.prepare(`SELECT * FROM records WHERE ${clauses.join(' OR ')}`).all(...params);

    for (const row of rows) {
      const updated = {
        ...row,
        contact_name_primary: '',
        contact_title_primary: '',
        email_primary: '',
        phone: '',
        dne_email: 1,
        dnc_phone: 1,
        dnk_visit: 1,
        do_not_sms: 1,
        suppressed: 1,
        suppressed_reason: 'forget_request',
        suppressed_at: new Date().toISOString(),
      };
      upsertRecord({ db, row: updated });
    }

    if (normalizedEmail) {
      const entry = {
        id: randomUUID(),
        value: normalizedEmail,
        value_type: 'email',
        scope: 'global',
        reason: 'forget_request',
        source: 'forget_command',
        record_id: '',
        created_at: new Date().toISOString(),
      };
      addSuppression({ db, entry });
      addSuppression({ db: globalDb, entry });
      logComplianceEvent({
        listDir,
        payload: {
          action: 'forget',
          target_type: 'email',
          target_value: normalizedEmail,
          source: 'forget_command',
        },
      });
    }

    if (normalizedPhone) {
      const entry = {
        id: randomUUID(),
        value: normalizedPhone,
        value_type: 'phone',
        scope: 'global',
        reason: 'forget_request',
        source: 'forget_command',
        record_id: '',
        created_at: new Date().toISOString(),
      };
      addSuppression({ db, entry });
      addSuppression({ db: globalDb, entry });
      logComplianceEvent({
        listDir,
        payload: {
          action: 'forget',
          target_type: 'phone',
          target_value: normalizedPhone,
          source: 'forget_command',
        },
      });
    }

    logComplianceEvent({
      listDir,
      payload: {
        action: 'forget',
        source: 'forget_command',
        records_updated: rows.length,
        email: normalizedEmail || '',
        phone: normalizedPhone || '',
      },
    });

    return { status: 'forgotten', records_updated: rows.length, email: Boolean(normalizedEmail), phone: Boolean(normalizedPhone) };
  } finally {
    db.close();
    globalDb.close();
  }
};

export {
  aiUsageCommand,
  describeCommand,
  exportCommand,
  pipelineShowCommand,
  queryCommand,
  recordShowCommand,
  repliesShowCommand,
  routeShowCommand,
  schemaCommand,
  usageCommand,
  viewsSaveCommand,
} from './data-access.js';

export {
  configDiffCommand,
  configValidateCommand,
  recordRevertScoreCommand,
  recordRevertSequenceCommand,
  recordRevertStepCommand,
  snapshotCreateCommand,
  snapshotDeleteCommand,
  snapshotListCommand,
  snapshotRestoreCommand,
} from './safety.js';

export {
  overrideKeepCommand,
  overrideDropCommand,
  overrideClearCommand,
  overrideListCommand,
  overrideShowCommand,
} from './overrides.js';

export {
  reviewClearCommand,
  reviewDropCommand,
  reviewListCommand,
  reviewPassCommand,
  reviewStagesCommand,
} from './review.js';

export {
  manualCompleteCommand,
  manualListCommand,
} from './manual.js';

export {
  callBoardCommand,
  callBoardClaimCommand,
  callBoardDisposeCommand,
  healthCheckCommand,
  timelineCommand,
  decisionViewCommand,
  metricsCommand,
  auditExportCommand,
  workQueuesCommand,
  queueRepairCommand,
  queueEnrichmentHoldCommand,
  queueObjectionCommand,
  queueCallbackCommand,
  queueMeetingCommand,
  queueRecycleCommand,
  queueReentryCommand,
  queueStageReviewCommand,
  queueManualCommand,
  queueReplyCommand,
  WORK_QUEUE_NAMES,
} from './operator-surfaces.js';

export {
  sequencesBoardCommand,
  sequencesListCommand,
} from './sequences-board.js';

export {
  rejectedListCommand,
  rejectedRestoreCommand,
  rejectedSourcesCommand,
} from './rejected.js';

export {
  draftsApproveCommand,
  draftsEditCommand,
  draftsListCommand,
  draftsRejectCommand,
  draftsShowCommand,
} from './drafts.js';

export {
  templatesCreateCommand,
  templatesListCommand,
  templatesShowCommand,
  templatesUpdateCommand,
} from './templates.js';

export {
  contextCommand,
  monitorCommand,
  monitorOnceCommand,
  pendingActionCommand,
  pendingListCommand,
  pendingShowCommand,
} from './operator.js';
