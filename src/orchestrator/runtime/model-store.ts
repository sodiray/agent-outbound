import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ensureGlobalDirs, getGlobalModelsPath } from './paths.js';
import { AgentOutboundError } from './contract.js';

export const MODELS_SCHEMA_VERSION = '1.0.0';

export type ProviderModelState = {
  provider: string;
  models: string[];
  updated_at: string;
};

export type ModelsState = {
  schema_version: string;
  updated_at: string;
  providers: Record<string, ProviderModelState>;
};

const nowIso = () => new Date().toISOString();

const normalizeModelList = (models: string[]) => Array.from(new Set(
  (models || [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
)).sort((a, b) => a.localeCompare(b));

export const defaultModelsState = (): ModelsState => ({
  schema_version: MODELS_SCHEMA_VERSION,
  updated_at: '',
  providers: {},
});

export const readModelsState = (): ModelsState => {
  const path = getGlobalModelsPath();
  if (!existsSync(path)) return defaultModelsState();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const providers = parsed?.providers && typeof parsed.providers === 'object' ? parsed.providers : {};
    const normalizedProviders: Record<string, ProviderModelState> = {};
    for (const [providerId, value] of Object.entries(providers)) {
      const provider = String(providerId || '').trim().toLowerCase();
      if (!provider) continue;
      const modelList = Array.isArray((value as any)?.models) ? (value as any).models : [];
      normalizedProviders[provider] = {
        provider,
        models: normalizeModelList(modelList),
        updated_at: String((value as any)?.updated_at || parsed?.updated_at || ''),
      };
    }
    return {
      schema_version: String(parsed?.schema_version || MODELS_SCHEMA_VERSION),
      updated_at: String(parsed?.updated_at || ''),
      providers: normalizedProviders,
    };
  } catch {
    return defaultModelsState();
  }
};

export const writeModelsState = (state: ModelsState) => {
  ensureGlobalDirs();
  const path = getGlobalModelsPath();
  const normalized: ModelsState = {
    schema_version: MODELS_SCHEMA_VERSION,
    updated_at: nowIso(),
    providers: {},
  };
  const inputProviders = state?.providers && typeof state.providers === 'object' ? state.providers : {};
  for (const [providerId, value] of Object.entries(inputProviders)) {
    const provider = String(providerId || '').trim().toLowerCase();
    if (!provider) continue;
    normalized.providers[provider] = {
      provider,
      models: normalizeModelList(Array.isArray((value as any)?.models) ? (value as any).models : []),
      updated_at: String((value as any)?.updated_at || normalized.updated_at),
    };
  }
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`);
  chmodSync(path, 0o600);
  return { path, state: normalized };
};

export const setProviderModels = ({
  state,
  providerId,
  models,
}: {
  state: ModelsState;
  providerId: string;
  models: string[];
}) => {
  const provider = String(providerId || '').trim().toLowerCase();
  if (!provider) return state;
  const next = {
    ...state,
    providers: {
      ...(state?.providers || {}),
      [provider]: {
        provider,
        models: normalizeModelList(models || []),
        updated_at: nowIso(),
      },
    },
  };
  return next;
};

export const listSupportedModels = ({
  provider = '',
  search = '',
}: {
  provider?: string;
  search?: string;
} = {}) => {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const needle = String(search || '').trim().toLowerCase();
  const state = readModelsState();
  const rows: Array<{ provider: string; model_id: string; model: string }> = [];
  for (const [providerId, value] of Object.entries(state.providers || {})) {
    if (normalizedProvider && providerId !== normalizedProvider) continue;
    for (const modelId of Array.isArray((value as any)?.models) ? (value as any).models : []) {
      const full = `${providerId}/${String(modelId || '').trim()}`;
      if (needle && !full.toLowerCase().includes(needle)) continue;
      rows.push({
        provider: providerId,
        model_id: String(modelId || ''),
        model: full,
      });
    }
  }
  rows.sort((a, b) => a.model.localeCompare(b.model));
  return rows;
};

export const hasSupportedModel = (modelRef: string) => {
  const text = String(modelRef || '').trim();
  if (!text) return false;
  const slash = text.indexOf('/');
  if (slash < 1) return false;
  const provider = text.slice(0, slash).toLowerCase();
  const modelId = text.slice(slash + 1);
  const state = readModelsState();
  const providerState = state.providers?.[provider];
  if (!providerState) return false;
  return new Set(providerState.models || []).has(modelId);
};

export const assertSupportedModel = (modelRef: string) => {
  const model = String(modelRef || '').trim();
  if (!hasSupportedModel(model)) {
    throw new AgentOutboundError({
      code: 'UNSUPPORTED_MODEL',
      message: `${model} isn't in your supported models list.\nAdd it with: agent-outbound models add ${model}\nOr refresh the full list with: agent-outbound models refresh`,
      retryable: false,
      hint: 'Add the missing model or refresh supported models.',
      fields: { model },
      status: 400,
    });
  }
};
