import { z } from 'zod';
import {
  EnrichStepSchema,
  SequenceStepSchema,
  SourceFilterSchema,
  SourceSearchSchema,
} from '../../../schemas/config.js';

export const ConfigChangeSchema = z.discriminatedUnion('op', [
  // Add — append to the relevant array
  z.object({ op: z.literal('add_search'), search: SourceSearchSchema }),
  z.object({ op: z.literal('add_filter'), filter: SourceFilterSchema }),
  z.object({ op: z.literal('add_enrich'), step: EnrichStepSchema }),
  z.object({
    op: z.literal('add_sequence_step'),
    sequence: z.string().default('default'),
    step: SequenceStepSchema,
  }),

  // Modify — find by id in the relevant array, deep-merge patch
  z.object({ op: z.literal('modify_search'), id: z.string(), patch: z.record(z.any()).default({}) }),
  z.object({ op: z.literal('modify_filter'), id: z.string(), patch: z.record(z.any()).default({}) }),
  z.object({ op: z.literal('modify_enrich'), id: z.string(), patch: z.record(z.any()).default({}) }),
  z.object({
    op: z.literal('modify_sequence_step'),
    sequence: z.string().default('default'),
    id: z.string(),
    patch: z.record(z.any()).default({}),
  }),

  // Remove — find by id and splice out
  z.object({ op: z.literal('remove_search'), id: z.string() }),
  z.object({ op: z.literal('remove_filter'), id: z.string() }),
  z.object({ op: z.literal('remove_enrich'), id: z.string(), force: z.boolean().optional() }),
  z.object({
    op: z.literal('remove_sequence_step'),
    sequence: z.string().default('default'),
    id: z.string(),
  }),

  // Set — overwrite a top-level config field
  z.object({
    op: z.literal('set_score_axis'),
    axis: z.enum(['fit', 'trigger']),
    patch: z.object({
      description: z.string().default(''),
      model: z.enum(['haiku', 'sonnet', 'opus']).default('haiku'),
    }).partial().default({}),
  }),
  z.object({
    op: z.literal('set_channel'),
    channel: z.enum(['email', 'mail', 'visit', 'sms', 'call']),
    patch: z.record(z.any()).default({}),
  }),
  z.object({ op: z.literal('set_territory'), patch: z.record(z.any()).default({}) }),
  z.object({ op: z.literal('set_identity'), identity: z.array(z.string()) }),
]);

export const AuthorConfigOutputSchema = z.object({
  changes: z.array(ConfigChangeSchema).default([]),
  warnings: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});
