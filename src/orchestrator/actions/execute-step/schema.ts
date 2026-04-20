import { z } from 'zod';

export const ExecuteStepResultSchema = z.object({
  outputs: z.record(z.any()).default({}),
  artifacts: z.record(z.any()).default({}),
  summary: z.string().default(''),
  defer: z.boolean().default(false),
  reason: z.string().default(''),
  pagination: z.record(z.any()).nullable().optional(),
});
