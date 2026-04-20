import { z } from 'zod';

export const ClassifyReplyResultSchema = z.object({
  classification: z.enum(['positive', 'negative', 'ooo', 'auto', 'bounce']).default('negative'),
  reason: z.string().default(''),
});
