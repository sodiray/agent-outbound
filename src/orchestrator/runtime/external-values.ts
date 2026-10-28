export const externalObject = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);
export const externalText = (value: unknown) => String(value ?? '').trim();
export const externalPath = (data: unknown, path: string): unknown => path.split('.').reduce<unknown>((value, key) => externalObject(value)[key], data);
export const validateExternalOutputs = (definitions: unknown, values: unknown) => {
  const outputs = externalObject(values);
  const declared = externalObject(definitions);
  const extra = Object.keys(outputs).filter((key) => !Object.hasOwn(declared, key));
  if (extra.length) throw new Error(`Undeclared external outputs: ${extra.join(', ')}.`);
  return Object.fromEntries(Object.entries(declared).map(([name, raw]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || ['_row_id','id','created_at','updated_at','__proto__','constructor','prototype'].includes(name)) throw new Error('Invalid external output name.');
    const definition = externalObject(raw);
    const value = outputs[name];
    const valid = definition.type === 'string' ? typeof value === 'string' && value.trim() !== ''
      : definition.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : definition.type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
      : definition.type === 'boolean' ? typeof value === 'boolean'
      : definition.type === 'json' ? value !== undefined && value !== null
      : false;
    if (!valid || (Array.isArray(definition.enum) && !definition.enum.includes(value))) throw new Error(`Invalid or missing external output: ${name}.`);
    return [name, definition.type === 'boolean' ? Number(value) : definition.type === 'json' ? JSON.stringify(value) : value];
  }));
};
