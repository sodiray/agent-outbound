export const listAnthropicModels = async (apiKey: string) => {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, error: 'API key is empty.', models: [] as string[] };

  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
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
      error: String(error?.message || error),
      models: [] as string[],
    };
  }
};

export const validateAnthropicKey = async (apiKey: string) => {
  const listed = await listAnthropicModels(apiKey);
  return {
    ok: Boolean(listed.ok),
    error: listed.ok ? undefined : listed.error,
    model_count: listed.models.length,
    models: listed.models,
  };
};
