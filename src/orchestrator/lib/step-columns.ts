const normalizeOutputType = (raw: any): 'string' | 'number' | 'integer' | 'boolean' => {
  const type = String(raw || 'string').trim().toLowerCase();
  if (type === 'number' || type === 'integer' || type === 'boolean') return type;
  return 'string';
};

const getDeclaredOutputs = (stepConfig: any): Record<string, { type: 'string' | 'number' | 'integer' | 'boolean' }> => {
  const declared = (stepConfig?.outputs && typeof stepConfig.outputs === 'object')
    ? stepConfig.outputs
    : {};
  const outputs: Record<string, { type: 'string' | 'number' | 'integer' | 'boolean' }> = {};
  for (const [key, value] of Object.entries(declared)) {
    if (!key) continue;
    outputs[String(key)] = {
      type: normalizeOutputType((value as any)?.type),
    };
  }
  return outputs;
};

const getLegacyColumns = (stepConfig: any): Record<string, string> => (
  (stepConfig?.columns && typeof stepConfig.columns === 'object') ? stepConfig.columns : {}
);

const sqliteTypeForOutput = (type: 'string' | 'number' | 'integer' | 'boolean') => {
  if (type === 'integer') return 'INTEGER';
  if (type === 'number') return 'REAL';
  if (type === 'boolean') return 'INTEGER';
  return 'TEXT';
};

export const getTargetColumnsForStepConfig = (stepConfig: any): Array<{ name: string; type: string }> => {
  const declaredOutputs = getDeclaredOutputs(stepConfig || {});
  const legacyColumns = getLegacyColumns(stepConfig || {});
  const mapped = Object.entries(declaredOutputs)
    .map(([name, def]) => ({
      name: String(name || '').trim(),
      type: sqliteTypeForOutput(def.type),
    }))
    .concat(
      Object.entries(legacyColumns).map(([, targetColumn]) => ({
        name: String(targetColumn || '').trim(),
        type: 'TEXT',
      })),
    )
    .filter((item) => item.name);

  const deduped = new Map<string, { name: string; type: string }>();
  for (const item of mapped) {
    if (!deduped.has(item.name)) deduped.set(item.name, item);
  }
  return [...deduped.values()];
};
