import { AgentOutboundError } from './contract.js';
import { assertSupportedModel } from './model-store.js';
import { getProviderById, getProviderKey } from './providers.js';

export const LEGACY_MODEL_HINTS: Record<string, string> = {
  haiku: 'anthropic/claude-haiku-4-5-20251001',
  sonnet: 'anthropic/claude-sonnet-4-6',
  opus: 'anthropic/claude-opus-4-6',
};

export type ActionRole = 'evaluation' | 'copywriting' | 'research';

const clean = (value: any) => String(value || '').trim();

export const parseProviderModel = (value: string) => {
  const raw = clean(value);
  if (!raw) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: 'Model is required and must be in provider/model format.',
      retryable: false,
      fields: { model: raw },
      status: 400,
    });
  }
  const legacy = LEGACY_MODEL_HINTS[raw.toLowerCase()];
  if (legacy) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: `Model shorthand "${raw}" is no longer supported. Use "${legacy}" instead of "${raw}".`,
      retryable: false,
      hint: 'Update outbound.yaml model fields to provider/model format.',
      fields: { model: raw, suggested: legacy },
      status: 400,
    });
  }
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: `Invalid model "${raw}". Expected provider/model-id format (split on the first "/").`,
      retryable: false,
      fields: { model: raw },
      status: 400,
    });
  }
  const providerId = raw.slice(0, slash).trim().toLowerCase();
  const modelId = raw.slice(slash + 1).trim();
  if (!providerId || !modelId) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: `Invalid model "${raw}". Expected provider/model-id format.`,
      retryable: false,
      fields: { model: raw },
      status: 400,
    });
  }
  return {
    providerId,
    modelId,
    modelRef: `${providerId}/${modelId}`,
  };
};

const normalizeAiConfig = (aiConfig: any) => ({
  default_model: clean(aiConfig?.default_model),
  defaults: {
    evaluation: clean(aiConfig?.defaults?.evaluation),
    copywriting: clean(aiConfig?.defaults?.copywriting),
    research: clean(aiConfig?.defaults?.research),
  },
});

export const resolveConfiguredModelRef = ({
  model = '',
  role = 'research',
  aiConfig = {},
}: {
  model?: string;
  role?: ActionRole;
  aiConfig?: any;
}) => {
  const ai = normalizeAiConfig(aiConfig || {});
  const explicit = clean(model);
  if (explicit) return { modelRef: explicit, source: 'step' };
  const roleDefault = clean(ai.defaults?.[role]);
  if (roleDefault) return { modelRef: roleDefault, source: `ai.defaults.${role}` };
  const topDefault = clean(ai.default_model);
  if (topDefault) return { modelRef: topDefault, source: 'ai.default_model' };
  throw new AgentOutboundError({
    code: 'INVALID_ARGUMENT',
    message: `No model resolved for role "${role}". Set step model, ai.defaults.${role}, or ai.default_model.`,
    retryable: false,
    hint: 'Set ai.default_model in outbound.yaml to a supported provider/model id.',
    fields: { role },
    status: 400,
  });
};

export const resolveRuntimeModel = async ({
  model = '',
  role = 'research',
  aiConfig = {},
  enforceSupported = true,
}: {
  model?: string;
  role?: ActionRole;
  aiConfig?: any;
  enforceSupported?: boolean;
}) => {
  const resolved = resolveConfiguredModelRef({ model, role, aiConfig });
  const parsed = parseProviderModel(resolved.modelRef);
  const provider = getProviderById(parsed.providerId);
  if (!provider) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: `Unknown model provider "${parsed.providerId}" in "${parsed.modelRef}".`,
      retryable: false,
      fields: { model: parsed.modelRef, provider: parsed.providerId },
      status: 400,
    });
  }
  const apiKey = getProviderKey(provider.id);
  if (!apiKey) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: `${parsed.modelRef} requires ${provider.envKey}, but it is not set.`,
      retryable: false,
      hint: `Run agent-outbound init and configure ${provider.id}.`,
      fields: { model: parsed.modelRef, provider: provider.id, env_key: provider.envKey },
      status: 400,
    });
  }
  if (enforceSupported) {
    assertSupportedModel(parsed.modelRef);
  }
  const built = await provider.buildModel(parsed.modelId, apiKey);
  return {
    provider,
    providerId: provider.id,
    modelId: parsed.modelId,
    modelRef: parsed.modelRef,
    resolvedFrom: resolved.source,
    built,
    providerOptions: provider.getProviderOptions ? provider.getProviderOptions(parsed.modelId) : {},
  };
};

export const normalizeModelRef = (value: string) => parseProviderModel(value).modelRef;
