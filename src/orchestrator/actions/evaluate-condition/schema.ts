import { z } from 'zod';

export const ConditionResultSchema = z.object({
  passed: z.boolean(),
  defer: z.boolean().default(false),
  reason: z.string().default(''),
});
