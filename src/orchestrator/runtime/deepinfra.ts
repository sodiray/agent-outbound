const DEEPINFRA_MODELS_ENDPOINT = 'https://api.deepinfra.com/v1/openai/models';

export const listDeepInfraModels = async (apiKey: string) => {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, error: 'API key is empty.', models: [] as string[] };

  try {
    const response = await fetch(DEEPINFRA_MODELS_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        error: `HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
        models: [] as string[],
      };
    }
    const data: any = await response.json().catch(() => ({}));
    const models = Array.isArray(data?.data) ? data.data : [];
    return {
      ok: true,
      models: models
        .map((item: any) => String(item?.id || '').trim())
        .filter(Boolean),
    };
  } catch (error) {
    return {
      ok: false,
      error: String((error as any)?.message || error),
      models: [] as string[],
    };
  }
};

export const validateDeepInfraKey = async (apiKey: string) => {
  const listed = await listDeepInfraModels(apiKey);
  return {
    ok: Boolean(listed.ok),
    error: listed.ok ? undefined : listed.error,
    model_count: listed.models.length,
    models: listed.models,
  };
};

export const validateDeepInfraModel = async ({ apiKey, modelId }: { apiKey: string; modelId: string }) => {
  const listed = await listDeepInfraModels(apiKey);
  if (!listed.ok) {
    return {
      ok: false,
      error: listed.error || 'Failed to load DeepInfra model list.',
    };
  }
  const normalized = String(modelId || '').trim();
  if (!normalized) {
    return { ok: false, error: 'Model id is empty.' };
  }
  if (!listed.models.includes(normalized)) {
    return {
      ok: false,
      error: `DeepInfra model not found: ${normalized}`,
    };
  }
  return { ok: true };
};

