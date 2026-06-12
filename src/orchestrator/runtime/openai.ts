const OPENAI_MODELS_ENDPOINT = 'https://api.openai.com/v1/models';

export const listOpenAiModels = async (apiKey: string) => {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, error: 'API key is empty.', models: [] as string[] };

  try {
    const response = await fetch(OPENAI_MODELS_ENDPOINT, {
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
    const data: unknown = await response.json().catch(() => ({}));
    const models = Array.isArray((data as { data?: unknown })?.data)
      ? (data as { data: unknown[] }).data
      : [];
    return {
      ok: true,
      models: models
        .map((item) => String((item as { id?: unknown })?.id || '').trim())
        .filter(Boolean),
    };
  } catch (error) {
    return {
      ok: false,
      error: String((error as { message?: unknown })?.message || error),
      models: [] as string[],
    };
  }
};
