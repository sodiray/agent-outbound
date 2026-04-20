import { z } from 'zod';

export const SyncCrmResultSchema = z.object({
  status: z.enum(['synced', 'skipped', 'failed']).default('skipped'),
  company_id: z.string().default(''),
  person_id: z.string().default(''),
  deal_id: z.string().default(''),
  remote_dnc: z.boolean().optional(),
  reason: z.string().default(''),
});
