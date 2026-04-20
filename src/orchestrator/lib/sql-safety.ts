export const validateWhereSql = (input: string): { ok: boolean; error?: string } => {
  const normalized = String(input || '').trim();
  if (!normalized) return { ok: true };
  const forbidden = /;\s*$|;\s*\w|DROP\s|DELETE\s|INSERT\s|UPDATE\s|ALTER\s|CREATE\s|ATTACH\s|DETACH\s/i;
  if (forbidden.test(normalized)) {
    return { ok: false, error: `Unsafe SQL fragment rejected: "${normalized}"` };
  }
  return { ok: true };
};

export const validateColumnName = (col: string): boolean =>
  /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(col || '').trim());
