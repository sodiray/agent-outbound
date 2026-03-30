const parseTimeoutMs = (value) => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }

  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return undefined;

  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) return undefined;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;

  const unit = match[2] || 'ms';
  if (unit === 'h') return Math.round(amount * 60 * 60 * 1000);
  if (unit === 'm') return Math.round(amount * 60 * 1000);
  if (unit === 's') return Math.round(amount * 1000);
  return Math.round(amount);
};

const normalizeModel = (value) => {
  const model = String(value ?? '').trim();
  return model || undefined;
};

export const getStepRuntimeOverrides = (stepConfig) => {
  const model = normalizeModel(stepConfig?.model) || normalizeModel(stepConfig?.platform_model);
  const timeout = parseTimeoutMs(stepConfig?.timeout);
  return {
    ...(model ? { model } : {}),
    ...(timeout ? { timeout } : {}),
  };
};
