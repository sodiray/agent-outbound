const DEFAULT_MODELS = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

export const resolveModel = (hint = 'sonnet') => {
  const key = String(hint || '').trim().toLowerCase();
  if (key in DEFAULT_MODELS) return DEFAULT_MODELS[key];
  return DEFAULT_MODELS.sonnet;
};

export const pickModel = resolveModel;
