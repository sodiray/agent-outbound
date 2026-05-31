import { z } from 'zod';

export const nullableString = (def = '') => z.preprocess((value) => {
  if (value === null || value === undefined) return def;
  if (typeof value === 'string') return value;
  return String(value);
}, z.string()).default(def);

export const nullableBoolean = (def = false) => z.preprocess((value) => {
  if (value === null || value === undefined) return def;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return value;
}, z.boolean()).default(def);

export const nullableNumber = (def = 0, schema: z.ZodNumber = z.number()) => z.preprocess((value) => {
  if (value === null || value === undefined || value === '') return def;
  if (typeof value === 'string') return Number(value);
  return value;
}, schema).default(def);

export const arrayOf = <ItemSchema extends z.ZodTypeAny>(
  schema: ItemSchema,
  def: z.infer<ItemSchema>[] = [],
) => z.preprocess((value) => {
  if (value === null || value === undefined) return def;
  if (Array.isArray(value)) return value;
  return [value];
}, z.array(schema)).default(def);

const parseJsonString = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
};

export const lenientRecord = <ValueSchema extends z.ZodTypeAny = z.ZodAny>(
  valueSchema?: ValueSchema,
  options: { fromArrayKey?: string | string[] } = {},
) => {
  const schema = valueSchema || z.any();
  const keys = Array.isArray(options.fromArrayKey)
    ? options.fromArrayKey
    : [options.fromArrayKey].filter(Boolean);

  return z.preprocess((value) => {
    const parsed = typeof value === 'string' ? parseJsonString(value) : value;
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed === 'string') return {};
    if (Array.isArray(parsed)) {
      return Object.fromEntries(parsed.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const record = entry as Record<string, unknown>;
        const key = keys
          .map((candidate) => String(record[candidate] || '').trim())
          .find(Boolean);
        return key ? [[key, record]] : [];
      }));
    }
    if (typeof parsed === 'object') return parsed;
    return {};
  }, z.record(schema)).default({});
};

export const recordWithDefault = (def: Record<string, unknown> = {}) => z.preprocess((value) => {
  if (value === null || value === undefined) return def;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  return def;
}, z.record(z.any())).default(def);

export const objectWithDefault = <ObjectSchema extends z.AnyZodObject>(
  schema: ObjectSchema,
  def: Record<string, unknown> = {},
) => z.preprocess((value) => {
  if (value === null || value === undefined) return def;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  return def;
}, schema).default(def);

export const enumWithDefault = <Values extends [string, ...string[]]>(
  values: Values,
  def: Values[number],
) => z.preprocess((value) => {
  if (value === null || value === undefined) return def;
  if (typeof value !== 'string') return def;
  if (value.trim() === '') return def;
  if (values.includes(value)) return value;
  return def;
}, z.enum(values)).default(def);
