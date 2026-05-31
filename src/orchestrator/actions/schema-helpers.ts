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

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parseJsonStringValue = (value: string): unknown => {
  const parsed = parseJsonString(value);
  return parsed === undefined ? value : parsed;
};

const getPairKey = (record: Record<string, unknown>) => {
  const key = record.name ?? record.key ?? record.field;
  return typeof key === 'string' && key.trim() ? key.trim() : '';
};

const getPairValue = (record: Record<string, unknown>) => {
  if (Object.prototype.hasOwnProperty.call(record, 'value')) return record.value;
  if (Object.prototype.hasOwnProperty.call(record, 'val')) return record.val;
  return undefined;
};

const isPairRecord = (value: unknown): value is Record<string, unknown> =>
  isPlainRecord(value) && Boolean(getPairKey(value)) && (
    Object.prototype.hasOwnProperty.call(value, 'value')
    || Object.prototype.hasOwnProperty.call(value, 'val')
  );

const singleEntry = (value: unknown): [string, unknown] | null => {
  if (!isPlainRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length !== 1) return null;
  return entries[0];
};

export const objectFromLooseShape = (
  raw: unknown,
  declaredKeys: string[] = [],
): Record<string, unknown> => {
  const value = typeof raw === 'string' ? parseJsonStringValue(raw) : raw;

  if (isPlainRecord(value)) return value;
  if (!Array.isArray(value)) return {};

  if (value.every(isPairRecord)) {
    return Object.fromEntries(value.map((entry) => [getPairKey(entry), getPairValue(entry)]));
  }

  if (value.length === 1 && isPlainRecord(value[0])) return value[0];

  const singleKeyEntries = value.map(singleEntry);
  if (singleKeyEntries.every(Boolean)) {
    return Object.fromEntries(singleKeyEntries as [string, unknown][]);
  }

  if (
    declaredKeys.length > 0
    && value.length === declaredKeys.length
    && value.every((entry) => !isPlainRecord(entry) && !Array.isArray(entry))
  ) {
    return Object.fromEntries(declaredKeys.map((key, index) => [key, value[index]]));
  }

  return {};
};

const normalizeLooseKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

const aliasKeysForDeclaredKey = (declaredKey: string) => {
  const normalized = normalizeLooseKey(declaredKey);
  const aliases: Record<string, string[]> = {
    estimatedemployees: ['estimatedemployeecount', 'employeecount', 'estimatedemployee'],
    servicessummary: ['onesentenceservicessummary', 'servicesummary'],
    hasbrandedvehicles: ['whetherbrandedwrappedcompanyvehiclesappear', 'brandedvehicles', 'wrappedcompanyvehicles'],
    hascareerspage: ['careerspage', 'hascareers'],
  };
  return [normalized, ...(aliases[normalized] || [])];
};

const looseKeysMatch = (declaredKey: string, candidateKey: string) => {
  const declaredAliases = aliasKeysForDeclaredKey(declaredKey);
  const candidate = normalizeLooseKey(candidateKey);
  return declaredAliases.some((declared) => (
    declared === candidate || declared.includes(candidate) || candidate.includes(declared)
  ));
};

export const fuzzyMapDeclaredKeys = (
  raw: Record<string, unknown>,
  declaredKeys: string[],
): Record<string, unknown> => {
  const mapped: Record<string, unknown> = { ...raw };
  for (const declaredKey of declaredKeys) {
    if (Object.prototype.hasOwnProperty.call(mapped, declaredKey)) continue;
    const match = Object.entries(raw).find(([candidateKey, value]) => (
      value !== undefined && looseKeysMatch(declaredKey, candidateKey)
    ));
    if (match) mapped[declaredKey] = match[1];
  }
  return mapped;
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
