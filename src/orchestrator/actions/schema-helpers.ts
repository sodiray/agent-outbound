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
