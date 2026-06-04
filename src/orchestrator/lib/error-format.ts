const primitiveText = (value: unknown) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return '';
};

const safeJson = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
};

const errorParts = (value: unknown, seen: Set<unknown>, depth: number): string[] => {
  const primitive = primitiveText(value);
  if (primitive) return [primitive];
  if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) return [];
  seen.add(value);

  const record = value as Record<string, unknown>;
  const direct = [
    record.message,
    record.shortMessage,
    record.error,
    record.detail,
    record.details,
    record.reason,
    record.statusText,
  ].flatMap((entry) => errorParts(entry, seen, depth + 1));
  const nested = [
    record.data,
    record.cause,
    record.response,
    record.body,
    record.result,
    record.payload,
  ].flatMap((entry) => errorParts(entry, seen, depth + 1));
  const arrayParts = Array.isArray(value)
    ? value.flatMap((entry) => errorParts(entry, seen, depth + 1))
    : [];
  const fallback = direct.length === 0 && nested.length === 0 && arrayParts.length === 0
    ? [safeJson(value)].filter(Boolean)
    : [];
  return [...direct, ...nested, ...arrayParts, ...fallback];
};

export const formatErrorMessage = (error: unknown, fallback = 'failed') => {
  const parts = errorParts(error, new Set<unknown>(), 0)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const deduped = [...new Set(parts)];
  return deduped.join(' | ') || fallback;
};
