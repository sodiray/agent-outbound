export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const withoutTrailingSlash = (value: string) => String(value || '').trim().replace(/\/+$/, '');

export const listOpenRouterModels = async ({
  apiKey,
  baseURL = OPENROUTER_BASE_URL,
}: {
  apiKey: string;
  baseURL?: string;
}) => {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, error: 'API key is empty.', models: [] as string[] };

  try {
    const response = await fetch(`${withoutTrailingSlash(baseURL)}/models`, {
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
    const modelRows = data && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data)
      ? (data as { data: unknown[] }).data
      : [];
    return {
      ok: true,
      models: modelRows
        .map((item) => {
          if (!item || typeof item !== 'object') return '';
          return String((item as { id?: unknown }).id || '').trim();
        })
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
