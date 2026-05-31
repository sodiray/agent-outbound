import { z } from 'zod';
import {
  ProviderModelSchema,
} from '../../../schemas/config.js';
import { NON_WORKING_DAY_POLICY_VALUES, SEQUENCE_WORKING_DAY_VALUES } from '../../lib/working-days.js';
import {
  arrayOf,
  enumWithDefault,
  lenientRecord,
  nullableBoolean,
  nullableNumber,
  nullableString,
  objectWithDefault,
  recordWithDefault,
} from '../schema-helpers.js';

const OUTPUT_TYPE_VALUES: ['string', 'number', 'integer', 'boolean'] = ['string', 'number', 'integer', 'boolean'];

const ARRAY_KEYS = new Set([
  'changes',
  'criteria',
  'depends_on',
  'disposition_options',
  'enum',
  'exclude_zips',
  'identity',
  'key_source',
  'manual_results',
  'notes',
  'preferred_visit_days',
  'steps',
  'toolkits',
  'tools',
  'versions',
  'warnings',
  'working_days',
]);

const BOOLEAN_DEFAULTS: Record<string, boolean> = {
  dnc_sync: true,
  draft_approval_required: false,
  force: false,
  visit_permit_required: false,
};

const NUMBER_DEFAULTS: Record<string, number> = {
  concurrency: 10,
  day: 0,
  floor: 0,
  limit: 25,
  max_drive_radius_miles: 35,
  max_results: 100,
  max_visits_per_day: 12,
  step_budget: 8,
  template_version: 1,
  version: 1,
  weight: 1,
  window_days: 30,
};

const RECORD_KEYS = new Set([
  'args',
  'business_hours',
  'channels',
  'columns',
  'config',
  'pagination',
  'patch',
  'prompt_args',
  'territory',
  'variables',
]);

const parseJsonString = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
};

const normalizeOutputRecord = (value: unknown): Record<string, unknown> => {
  const parsed = typeof value === 'string' ? parseJsonString(value) : value;
  if (!parsed || typeof parsed === 'string') return {};
  if (Array.isArray(parsed)) {
    return Object.fromEntries(parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      const key = String(record.name || record.slug || '').trim();
      return key ? [[key, record]] : [];
    }));
  }
  if (typeof parsed === 'object') return parsed as Record<string, unknown>;
  return {};
};

const normalizeLooseAuthorValue = (value: unknown, key = ''): unknown => {
  if (key === 'outputs') return normalizeOutputRecord(value);
  if (value === null || value === undefined) {
    if (ARRAY_KEYS.has(key)) return [];
    if (Object.prototype.hasOwnProperty.call(BOOLEAN_DEFAULTS, key)) return BOOLEAN_DEFAULTS[key];
    if (Object.prototype.hasOwnProperty.call(NUMBER_DEFAULTS, key)) return NUMBER_DEFAULTS[key];
    if (RECORD_KEYS.has(key)) return {};
    return '';
  }

  const parsed = typeof value === 'string' && (ARRAY_KEYS.has(key) || RECORD_KEYS.has(key))
    ? parseJsonString(value)
    : undefined;
  const effective = parsed === undefined ? value : parsed;

  if (ARRAY_KEYS.has(key) && !Array.isArray(effective)) {
    return [normalizeLooseAuthorValue(effective)];
  }

  if (RECORD_KEYS.has(key) && (typeof effective !== 'object' || Array.isArray(effective) || effective === null)) {
    return {};
  }

  if (Array.isArray(effective)) {
    return effective.map((entry) => normalizeLooseAuthorValue(entry));
  }

  if (typeof effective === 'object') {
    return Object.fromEntries(
      Object.entries(effective as Record<string, unknown>)
        .map(([entryKey, entryValue]) => [entryKey, normalizeLooseAuthorValue(entryValue, entryKey)])
    );
  }

  return effective;
};

const moveTopLevelOutputsIntoConfig = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'outputs')) return value;
  const config = record.config && typeof record.config === 'object' && !Array.isArray(record.config)
    ? record.config as Record<string, unknown>
    : {};
  return {
    ...record,
    config: {
      ...config,
      outputs: config.outputs ?? record.outputs,
    },
  };
};

const OutputDefSchema = z.object({
  type: enumWithDefault(OUTPUT_TYPE_VALUES, 'string'),
  description: nullableString(),
  enum: arrayOf(nullableString()).optional(),
});

const ToolSpecPatchSchema = objectWithDefault(z.object({
  server: nullableString().optional(),
  toolkits: arrayOf(nullableString()).optional(),
  tools: arrayOf(nullableString()).optional(),
  search: nullableString().optional(),
  limit: nullableNumber(25, z.number().int().positive().max(200)).optional(),
}).partial());

const IdempotencyPatchSchema = objectWithDefault(z.object({
  key_source: arrayOf(nullableString()).optional(),
  scope: enumWithDefault(['list', 'global'], 'list').optional(),
}).partial());

const StepConfigPatchSchema = objectWithDefault(z.object({
  description: nullableString().optional(),
  id: nullableString().optional(),
  model: ProviderModelSchema.optional(),
  step_budget: nullableNumber(8, z.number().int().min(1).max(40)).optional(),
  concurrency: nullableNumber(10, z.number().int().min(1).max(200)).optional(),
  cache: nullableString().optional(),
  tool: ToolSpecPatchSchema.optional(),
  args: lenientRecord().optional(),
  outputs: lenientRecord(OutputDefSchema, { fromArrayKey: ['name', 'slug'] }).optional(),
  columns: lenientRecord(nullableString()).optional(),
  depends_on: arrayOf(nullableString()).optional(),
  prompt_file: nullableString().optional(),
  prompt_args: lenientRecord().optional(),
  condition: nullableString().optional(),
  idempotency: IdempotencyPatchSchema.optional(),
}).partial());

const SourceSearchPatchSchema = objectWithDefault(z.object({
  id: nullableString().optional(),
  description: nullableString().optional(),
  query: nullableString().optional(),
  model: ProviderModelSchema.optional(),
  max_results: nullableNumber(100, z.number().int().min(1).max(5000)).optional(),
  tool: ToolSpecPatchSchema.optional(),
  args: lenientRecord().optional(),
  output_map: lenientRecord(nullableString()).optional(),
  pagination: lenientRecord().optional(),
  manual_results: arrayOf(z.record(z.any())).optional(),
}).partial());

const SourceFilterPatchSchema = objectWithDefault(z.object({
  id: nullableString().optional(),
  description: nullableString().optional(),
  type: enumWithDefault(['field_check', 'semantic'], 'semantic').optional(),
  condition: z.any().optional(),
  config: StepConfigPatchSchema.optional(),
}).partial());

const EnrichStepPatchSchema = z.preprocess(moveTopLevelOutputsIntoConfig, objectWithDefault(z.object({
  id: nullableString().optional(),
  description: nullableString().optional(),
  config: StepConfigPatchSchema.optional(),
}).partial()));

const SequenceStepConfigPatchSchema = objectWithDefault(z.object({
  tool: ToolSpecPatchSchema.optional(),
  disposition_options: arrayOf(nullableString()).optional(),
  model: ProviderModelSchema.optional(),
  step_budget: nullableNumber(8, z.number().int().min(1).max(40)).optional(),
  concurrency: nullableNumber(10, z.number().int().min(1).max(200)).optional(),
  cache: nullableString().optional(),
  outputs: lenientRecord(OutputDefSchema, { fromArrayKey: ['name', 'slug'] }).optional(),
  columns: lenientRecord(nullableString()).optional(),
  idempotency: IdempotencyPatchSchema.optional(),
}).partial());

const SequenceStepPatchSchema = z.preprocess(moveTopLevelOutputsIntoConfig, objectWithDefault(z.object({
  id: nullableString().optional(),
  description: nullableString().optional(),
  template: z.union([nullableString(), arrayOf(nullableString())]).optional(),
  template_version: nullableNumber(1, z.number().int().min(1)).optional(),
  variables: lenientRecord().optional(),
  draft_approval_required: nullableBoolean(false).optional(),
  day: nullableNumber(0, z.number().int().min(0).max(365)).optional(),
  condition: nullableString().optional(),
  defer: nullableString().optional(),
  config: SequenceStepConfigPatchSchema.optional(),
}).partial()));

const SequencePatchSchema = objectWithDefault(z.object({
  working_days: z.preprocess((value) => {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) return value;
    return [value];
  }, z.array(z.enum(SEQUENCE_WORKING_DAY_VALUES)).min(1).optional()),
  non_working_day_policy: z.enum(NON_WORKING_DAY_POLICY_VALUES).optional(),
}).catchall(z.any()));

const TemplatePatchSchema = objectWithDefault(z.object({
  channel_hint: nullableString().optional(),
  versions: arrayOf(z.object({
    version: z.coerce.number().int().min(1),
    subject: nullableString().optional(),
    body: nullableString().optional(),
    variables: recordWithDefault().optional(),
    note: nullableString().optional(),
  }).partial()).optional(),
}).catchall(z.any()));

export const ConfigChangeSchema = z.discriminatedUnion('op', [
  // Add — append to the relevant array
  z.object({ op: z.literal('add_search'), search: SourceSearchPatchSchema }),
  z.object({ op: z.literal('add_filter'), filter: SourceFilterPatchSchema }),
  z.object({ op: z.literal('add_enrich'), step: EnrichStepPatchSchema }),
  z.object({
    op: z.literal('add_sequence_step'),
    sequence: nullableString('default'),
    step: SequenceStepPatchSchema,
  }),

  // Modify — find by id in the relevant array, deep-merge patch
  z.object({ op: z.literal('modify_search'), id: nullableString(), patch: recordWithDefault() }),
  z.object({ op: z.literal('modify_filter'), id: nullableString(), patch: recordWithDefault() }),
  z.object({ op: z.literal('modify_enrich'), id: nullableString(), patch: recordWithDefault() }),
  z.object({
    op: z.literal('modify_sequence_step'),
    sequence: nullableString('default'),
    id: nullableString(),
    patch: recordWithDefault(),
  }),

  // Remove — find by id and splice out
  z.object({ op: z.literal('remove_search'), id: nullableString() }),
  z.object({ op: z.literal('remove_filter'), id: nullableString() }),
  z.object({ op: z.literal('remove_enrich'), id: nullableString(), force: nullableBoolean(false).optional() }),
  z.object({
    op: z.literal('remove_sequence_step'),
    sequence: nullableString('default'),
    id: nullableString(),
  }),

  // Set — overwrite a top-level config field
  z.object({
    op: z.literal('set_score_axis'),
    axis: enumWithDefault(['fit', 'trigger'], 'fit'),
    patch: objectWithDefault(z.object({
      description: nullableString(),
      model: ProviderModelSchema.optional(),
    }).partial()),
  }),
  z.object({
    op: z.literal('set_channel'),
    channel: enumWithDefault(['email', 'mail', 'visit', 'sms', 'call'], 'email'),
    patch: recordWithDefault(),
  }),
  z.object({
    op: z.literal('set_sequence'),
    sequence: nullableString('default'),
    patch: SequencePatchSchema,
  }),
  z.object({
    op: z.literal('set_template'),
    template: nullableString(),
    patch: TemplatePatchSchema,
  }),
  z.object({
    op: z.literal('set_budget'),
    patch: recordWithDefault(),
  }),
  z.object({ op: z.literal('set_territory'), patch: recordWithDefault() }),
  z.object({ op: z.literal('set_identity'), identity: arrayOf(nullableString()) }),
]);

export const AuthorConfigOutputSchema = z.preprocess((value) => normalizeLooseAuthorValue(value), z.object({
  changes: arrayOf(ConfigChangeSchema),
  warnings: arrayOf(nullableString()),
  notes: arrayOf(nullableString()),
}));
