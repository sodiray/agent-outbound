interface AnthropicModel {
  id?: string;
  display_name?: string;
  type?: string;
  created_at?: string;
}

interface AnthropicListModelsResponse {
  data?: AnthropicModel[];
  has_more?: boolean;
  first_id?: string | null;
  last_id?: string | null;
}

export interface ListAnthropicModelsResult {
  ok: boolean;
  models: string[];
  error?: string;
}

export interface ValidateAnthropicResult {
  ok: boolean;
  model_count: number;
  models: string[];
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export const listAnthropicModels = async (
  apiKey: string,
  options: { timeoutMs?: number } = {},
): Promise<ListAnthropicModelsResult> => {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, error: 'API key is empty.', models: [] };

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        error: `HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
        models: [],
      };
    }

    const data = (await response
      .json()
      .catch(() => ({}))) as AnthropicListModelsResponse;
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      ok: true,
      models: items
        .map((item) => String(item?.id || '').trim())
        .filter(Boolean),
    };
  } catch (error) {
    // AbortError surfaces as a clear timeout message, all other errors
    // narrow safely without `any` access.
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return {
          ok: false,
          error: `Request timed out after ${timeoutMs}ms.`,
          models: [],
        };
      }
      return { ok: false, error: error.message, models: [] };
    }
    return { ok: false, error: String(error), models: [] };
  } finally {
    clearTimeout(timer);
  }
};

export const validateAnthropicKey = async (
  apiKey: string,
  options: { timeoutMs?: number } = {},
): Promise<ValidateAnthropicResult> => {
  const listed = await listAnthropicModels(apiKey, options);
  return {
    ok: Boolean(listed.ok),
    error: listed.ok ? undefined : listed.error,
    model_count: listed.models.length,
    models: listed.models,
  };
};
