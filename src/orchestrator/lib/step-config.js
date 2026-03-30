const NON_EXECUTION_STEP_KEYS = new Set([
  'action',
  'day',
  'template_args',
  'condition',
]);

export const getExecutionStepConfig = (step) => {
  if (step?.config && typeof step.config === 'object') {
    return step.config;
  }

  const base = step && typeof step === 'object' ? step : {};
  const extracted = {};
  for (const [key, value] of Object.entries(base)) {
    if (NON_EXECUTION_STEP_KEYS.has(key)) continue;
    extracted[key] = value;
  }
  return extracted;
};
