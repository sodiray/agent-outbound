import { z } from 'zod';
import {
  EnrichStepSchema,
  ProviderModelSchema,
  SequenceStepSchema,
  SourceFilterSchema,
  SourceSearchSchema,
} from '../../../schemas/config.js';
import { NON_WORKING_DAY_POLICY_VALUES, SEQUENCE_WORKING_DAY_VALUES } from '../../lib/working-days.js';
import {
  arrayOf,
  enumWithDefault,
  nullableBoolean,
  nullableString,
  objectWithDefault,
  recordWithDefault,
} from '../schema-helpers.js';

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
  z.object({ op: z.literal('add_search'), search: SourceSearchSchema }),
  z.object({ op: z.literal('add_filter'), filter: SourceFilterSchema }),
  z.object({ op: z.literal('add_enrich'), step: EnrichStepSchema }),
  z.object({
    op: z.literal('add_sequence_step'),
    sequence: nullableString('default'),
    step: SequenceStepSchema,
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

export const AuthorConfigOutputSchema = z.object({
  changes: arrayOf(ConfigChangeSchema),
  warnings: arrayOf(nullableString()),
  notes: arrayOf(nullableString()),
});
