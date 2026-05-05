import { getEnv } from './env.js';
import { listAnthropicModels } from './anthropic.js';
import { listDeepInfraModels } from './deepinfra.js';

type ProviderValidateResult = {
  ok: boolean;
  error?: string;
  models: string[];
};

export type RuntimeProvider = {
  id: string;
  envKey: string;
  supportsCacheControl: boolean;
  validateKey: (apiKey: string) => Promise<ProviderValidateResult>;
  buildModel: (modelId: string, apiKey: string) => Promise<any>;
  getProviderOptions?: (modelId: string) => Record<string, any>;
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
    return deepinfra(String(modelId || '').trim());
  }
  if (typeof (providerModule as any).deepinfra === 'function') {
    return (providerModule as any).deepinfra(String(modelId || '').trim(), { apiKey });
  }
  throw new Error('Missing DeepInfra AI SDK provider. Install @ai-sdk/deepinfra.');
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
    extractUsdCost: (result: any) => parseUsd(result?.usage?.totalCost),
  },
  {
    id: 'deepinfra',
    envKey: 'DEEPINFRA_API_KEY',
    supportsCacheControl: false,
    validateKey: async (apiKey: string) => listDeepInfraModels(apiKey),
    buildModel: buildDeepInfraModel,
    extractUsdCost: (result: any) => (
      parseUsd(result?.providerMetadata?.deepinfra?.usage?.estimated_cost)
      ?? parseDeepInfraUsdFromResponseBody(result?.response?.body)
      ?? parseDeepInfraUsdFromResponseBody(result?.rawResponse?.body)
    ),
  },
];

export const getRegisteredProviders = () => PROVIDERS.slice();

export const getProviderById = (providerId: string): RuntimeProvider | null => {
  const id = String(providerId || '').trim().toLowerCase();
  if (!id) return null;
  return PROVIDERS.find((provider) => provider.id === id) || null;
};

export const getProviderKey = (providerId: string) => {
  const provider = getProviderById(providerId);
  if (!provider) return '';
  return String(getEnv(provider.envKey) || '').trim();
};

