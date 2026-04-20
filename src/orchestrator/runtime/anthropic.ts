export const validateAnthropicKey = async (apiKey: string) => {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, error: 'API key is empty.' };

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
      };
    }

    const data: any = await response.json().catch(() => ({}));
    const models = Array.isArray(data?.data) ? data.data : [];
    return {
      ok: true,
      model_count: models.length,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
    };
  }
};
