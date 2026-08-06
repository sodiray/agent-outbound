import { getEnv } from './env.js';
import { listAnthropicModels } from './anthropic.js';
import { listDeepInfraModels } from './deepinfra.js';
import { listXaiModels } from './xai.js';
import { listOpenAiModels } from './openai.js';
import { listOpenRouterModels, OPENROUTER_BASE_URL } from './openrouter.js';

type ProviderValidateResult = {
  ok: boolean;
  error?: string;
  models: string[];
};

export type ProviderCredentials = {
  apiKey: string;
  baseURL?: string;
};

export type RuntimeProvider = {
  id: string;
  envKey: string;
  credentialEnvDescription?: string;
  supportsCacheControl: boolean;
  validateKey: (apiKey: string) => Promise<ProviderValidateResult>;
  buildModel: (modelId: string, apiKey: string, baseURL?: string) => Promise<any>;
  resolveCredentials?: () => ProviderCredentials;
  getProviderOptions?: (modelId: string, opts?: { reasoning?: boolean }) => Record<string, any>;
  extractUsdCost: (result: any) => number | null;
};

const parseUsd = (value: any): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const parseDeepInfraUsdFromResponseBody = (rawBody: any): number | null => {
  if (!rawBody) return null;
  if (typeof rawBody === 'string') {
    try {
      const parsed = JSON.parse(rawBody);
      return parseUsd(parsed?.usage?.estimated_cost);
    } catch {
      return null;
    }
  }
  if (typeof rawBody === 'object') {
    return parseUsd((rawBody as any)?.usage?.estimated_cost);
  }
  return null;
};

const parseOpenRouterUsdFromResponseBody = (rawBody: unknown): number | null => {
  const parsed = typeof rawBody === 'string'
    ? (() => {
      try {
        return JSON.parse(rawBody) as unknown;
      } catch {
        return null;
      }
    })()
    : rawBody;
  if (!parsed || typeof parsed !== 'object') return null;
  const usage = (parsed as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return null;
  return parseUsd((usage as { cost?: unknown }).cost);
};

const buildAnthropicModel = async (modelId: string, apiKey: string) => {
  const modName = '@ai-sdk/anthropic';
  const providerModule = await import(modName);
  if (typeof (providerModule as any).createAnthropic === 'function') {
    const anthropic = (providerModule as any).createAnthropic({ apiKey });
    return anthropic(String(modelId || '').trim());
  }
  if (typeof (providerModule as any).anthropic === 'function') {
    return (providerModule as any).anthropic(String(modelId || '').trim(), { apiKey });
  }
  throw new Error('Failed to initialize Anthropic provider from @ai-sdk/anthropic.');
};

const buildDeepInfraModel = async (modelId: string, apiKey: string) => {
  const modName = '@ai-sdk/deepinfra';
  const providerModule = await import(modName);
  if (typeof (providerModule as any).createDeepInfra === 'function') {
    const deepinfra = (providerModule as any).createDeepInfra({ apiKey });
    const model = deepinfra(String(modelId || '').trim());
    if ('supportsStructuredOutputs' in model) {
      model.supportsStructuredOutputs = true;
    }
    return model;
  }
  if (typeof (providerModule as any).deepinfra === 'function') {
    const model = (providerModule as any).deepinfra(String(modelId || '').trim(), { apiKey });
    if ('supportsStructuredOutputs' in model) {
      model.supportsStructuredOutputs = true;
    }
    return model;
  }
  throw new Error('Missing DeepInfra AI SDK provider. Install @ai-sdk/deepinfra.');
};

const getDeepInfraProviderOptions = (modelId: string, opts?: { reasoning?: boolean }) => {
  const normalized = String(modelId || '').trim().toLowerCase();
  // Kimi K2.6 is a reasoning model: thinking is opt-in per step. When reasoning is
  // off (the default), disable chain-of-thought so simple gates/enrichments stay
  // fast and cheap; turn it on only for steps that genuinely need deliberation
  // (e.g. drafting outreach copy).
  if (normalized === 'moonshotai/kimi-k2.6') {
    return {
      deepinfra: opts?.reasoning
        ? { thinking: { type: 'enabled' } }
        : { reasoning_effort: 'none' },
    };
  }
  return {};
};

const buildOpenAiModel = async (modelId: string, apiKey: string) => {
  const modName = '@ai-sdk/openai';
  const providerModule = await import(modName);
  // Strict structured outputs (the default) — reliable schema conformance. All
  // schemas used with OpenAI must be strict-compatible (every field required, no
  // minLength/min/max/defaults); see BriefResultSchema, kept strict-safe for this.
  const id = String(modelId || '').trim();
  if (typeof (providerModule as any).createOpenAI === 'function') {
    const openai = (providerModule as any).createOpenAI({ apiKey });
    // Route via chat-completions, not the Responses API: the SDK's Responses
    // structured-output path is flaky here (silent retry storms on the score
    // schema), while chat-completions + strict json_schema is reliable (verified
    // by direct API probe). Strict stays ON (default) for guaranteed conformance.
    if (typeof openai.chat === 'function') return openai.chat(id);
    return openai(id);
  }
  if (typeof (providerModule as any).openai === 'function') {
    return (providerModule as any).openai(id, { apiKey });
  }
  throw new Error('Failed to initialize OpenAI provider from @ai-sdk/openai.');
};

const buildOpenRouterModel = async (modelId: string, apiKey: string, baseURL = OPENROUTER_BASE_URL) => {
  const modName = '@ai-sdk/openai';
  const providerModule: unknown = await import(modName);
  const id = String(modelId || '').trim();
  const resolvedBaseURL = String(baseURL || OPENROUTER_BASE_URL).trim();
  const openAiModule = providerModule as {
    createOpenAI?: (settings: {
      apiKey: string;
      baseURL: string;
      name: string;
    }) => ((modelId: string) => unknown) & { chat?: (modelId: string) => unknown };
    openai?: (modelId: string, settings: { apiKey: string; baseURL: string }) => unknown;
  };
  if (typeof openAiModule.createOpenAI === 'function') {
    const openrouter = openAiModule.createOpenAI({
      apiKey,
      baseURL: resolvedBaseURL,
      name: 'openrouter',
    });
    if (typeof openrouter.chat === 'function') return openrouter.chat(id);
    return openrouter(id);
  }
  if (typeof openAiModule.openai === 'function') {
    return openAiModule.openai(id, { apiKey, baseURL: resolvedBaseURL });
  }
  throw new Error('Failed to initialize OpenRouter provider from @ai-sdk/openai.');
};

const resolveOpenRouterCredentials = (): ProviderCredentials => {
  const openRouterKey = String(getEnv('OPENROUTER_API_KEY') || '').trim();
  if (openRouterKey) return { apiKey: openRouterKey, baseURL: OPENROUTER_BASE_URL };

  const compatibleKey = String(getEnv('OPENAI_COMPATIBLE_API_KEY') || '').trim();
  const compatibleBaseURL = String(getEnv('OPENAI_COMPATIBLE_BASE_URL') || '').trim();
  if (compatibleKey && compatibleBaseURL) {
    return { apiKey: compatibleKey, baseURL: compatibleBaseURL };
  }

  return { apiKey: '', baseURL: OPENROUTER_BASE_URL };
};

// OpenAI's API does not return a cost field, so we compute it from token usage.
// USD per 1M tokens (input/output). Update if OpenAI changes pricing.
const OPENAI_PRICES: Record<string, { in: number; out: number }> = {
  'gpt-4.1-nano': { in: 0.10, out: 0.40 },
  'gpt-4.1-mini': { in: 0.40, out: 1.60 },
  'gpt-4.1': { in: 2.00, out: 8.00 },
  'gpt-4o-mini': { in: 0.15, out: 0.60 },
};

const computeOpenAiUsd = (result: any): number | null => {
  const usage = result?.usage || {};
  const inTok = Number(usage.inputTokens ?? usage.promptTokens ?? 0);
  const outTok = Number(usage.outputTokens ?? usage.completionTokens ?? 0);
  if (!Number.isFinite(inTok) || !Number.isFinite(outTok)) return null;
  const modelId = String(result?.model || result?.response?.modelId || '').trim().toLowerCase();
  // Prefix-match so dated suffixes (e.g. gpt-4.1-nano-2025-04-14) resolve; default to nano.
  const sorted = Object.entries(OPENAI_PRICES).sort((a, b) => b[0].length - a[0].length);
  const price = sorted.find(([k]) => modelId.startsWith(k))?.[1] || OPENAI_PRICES['gpt-4.1-nano'];
  return (inTok / 1e6) * price.in + (outTok / 1e6) * price.out;
};

// Anthropic's AI SDK result doesn't populate a cost field (usage.totalCost is
// undefined), so cost_events logged $0. Compute from token usage like OpenAI.
// USD per 1M tokens. Cache write ~1.25x input, cache read ~0.1x input.
const ANTHROPIC_PRICES: Record<string, { in: number; out: number; cacheWrite: number; cacheRead: number }> = {
  'claude-haiku-4-5': { in: 1.0, out: 5.0, cacheWrite: 1.25, cacheRead: 0.10 },
  'claude-3-5-haiku': { in: 0.8, out: 4.0, cacheWrite: 1.00, cacheRead: 0.08 },
};

const computeAnthropicUsd = (result: any): number | null => {
  // Only trust a positive direct cost; Anthropic reports totalCost as 0 (not
  // undefined), which would short-circuit to $0. Fall through to token-based calc.
  const direct = parseUsd(result?.usage?.totalCost);
  if (direct !== null && direct > 0) return direct;
  const usage = result?.usage || {};
  const inTok = Number(usage.inputTokens ?? usage.promptTokens ?? 0);
  const outTok = Number(usage.outputTokens ?? usage.completionTokens ?? 0);
  const cacheWrite = Number(usage.cacheCreationInputTokens ?? usage.cachedInputTokens ?? 0);
  const cacheRead = Number(usage.cacheReadInputTokens ?? 0);
  if (!Number.isFinite(inTok) || !Number.isFinite(outTok)) return null;
  const modelId = String(result?.model || result?.response?.modelId || '').trim().toLowerCase();
  const sorted = Object.entries(ANTHROPIC_PRICES).sort((a, b) => b[0].length - a[0].length);
  const p = sorted.find(([k]) => modelId.startsWith(k))?.[1] || ANTHROPIC_PRICES['claude-haiku-4-5'];
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out
    + (cacheWrite / 1e6) * p.cacheWrite + (cacheRead / 1e6) * p.cacheRead;
};

const buildXaiModel = async (modelId: string, apiKey: string) => {
  const modName = '@ai-sdk/xai';
  const providerModule: unknown = await import(modName);
  const createXai = (providerModule as {
    createXai?: (settings: { apiKey: string }) => (modelId: string) => unknown;
  }).createXai;
  if (typeof createXai === 'function') {
    const xai = createXai({ apiKey });
    return xai(String(modelId || '').trim());
  }
  throw new Error('Failed to initialize xAI provider from @ai-sdk/xai.');
};

export const PROVIDERS: RuntimeProvider[] = [
  {
    id: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    supportsCacheControl: true,
    validateKey: async (apiKey: string) => listAnthropicModels(apiKey),
    buildModel: buildAnthropicModel,
    getProviderOptions: () => ({
      anthropic: {
        cacheControl: {
          type: 'ephemeral',
          ttl: '5m',
        },
      },
    }),
    extractUsdCost: (result: any) => computeAnthropicUsd(result),
  },
  {
    id: 'deepinfra',
    envKey: 'DEEPINFRA_API_KEY',
    supportsCacheControl: false,
    validateKey: async (apiKey: string) => listDeepInfraModels(apiKey),
    buildModel: buildDeepInfraModel,
    getProviderOptions: getDeepInfraProviderOptions,
    extractUsdCost: (result: any) => (
      parseUsd(result?.providerMetadata?.deepinfra?.usage?.estimated_cost)
      ?? parseDeepInfraUsdFromResponseBody(result?.response?.body)
      ?? parseDeepInfraUsdFromResponseBody(result?.rawResponse?.body)
    ),
  },
  {
    id: 'openai',
    envKey: 'OPENAI_API_KEY',
    supportsCacheControl: false,
    validateKey: async (apiKey: string) => listOpenAiModels(apiKey),
    buildModel: buildOpenAiModel,
    extractUsdCost: (result: any) => computeOpenAiUsd(result),
  },
  {
    id: 'openrouter',
    envKey: 'OPENROUTER_API_KEY',
    credentialEnvDescription: 'OPENROUTER_API_KEY or OPENAI_COMPATIBLE_API_KEY + OPENAI_COMPATIBLE_BASE_URL',
    supportsCacheControl: false,
    validateKey: async (apiKey: string) => listOpenRouterModels({ apiKey }),
    buildModel: buildOpenRouterModel,
    resolveCredentials: resolveOpenRouterCredentials,
    extractUsdCost: (result) => (
      parseUsd(result?.providerMetadata?.openrouter?.usage?.cost)
      ?? parseUsd(result?.usage?.cost)
      ?? parseOpenRouterUsdFromResponseBody(result?.response?.body)
      ?? parseOpenRouterUsdFromResponseBody(result?.rawResponse?.body)
    ),
  },
  {
    id: 'xai',
    envKey: 'XAI_API_KEY',
    supportsCacheControl: false,
    validateKey: async (apiKey: string) => listXaiModels(apiKey),
    buildModel: buildXaiModel,
    extractUsdCost: () => null,
  },
];

export const getRegisteredProviders = () => PROVIDERS.slice();

export const getProviderById = (providerId: string): RuntimeProvider | null => {
  const id = String(providerId || '').trim().toLowerCase();
  if (!id) return null;
  return PROVIDERS.find((provider) => provider.id === id) || null;
};

export const getProviderKey = (providerId: string) => {
  return getProviderCredentials(providerId).apiKey;
};

export const getProviderCredentials = (providerId: string): ProviderCredentials => {
  const provider = getProviderById(providerId);
  if (!provider) return { apiKey: '' };
  if (provider.resolveCredentials) return provider.resolveCredentials();
  return { apiKey: String(getEnv(provider.envKey) || '').trim() };
};
