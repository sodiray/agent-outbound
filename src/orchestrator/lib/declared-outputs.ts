/**
 * Presence semantics for declared step outputs used by unchanged-input skips.
 *
 * Absent: `undefined`, `null`, empty/whitespace-only string.
 * Present: numbers (including 0), booleans (including false), non-empty strings,
 * objects and arrays (including empty collections — the step wrote a value).
 *
 * Fail closed for skips: when any declared output is absent, re-run the step.
 * Doing work twice is cheap; silently skipping with empty outputs is not.
 */

export const isPresentDeclaredOutputValue = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
};

export const missingDeclaredOutputKeys = ({
  record,
  outputKeys,
}: {
  record: Record<string, unknown>;
  outputKeys: Iterable<string>;
}): string[] => [...outputKeys].filter((key) => !isPresentDeclaredOutputValue(record[key]));

export const hasAllDeclaredOutputs = ({
  record,
  outputKeys,
}: {
  record: Record<string, unknown>;
  outputKeys: Iterable<string>;
}): boolean => missingDeclaredOutputKeys({ record, outputKeys }).length === 0;
