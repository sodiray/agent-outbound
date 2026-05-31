import { z } from 'zod';
import { enumWithDefault, nullableBoolean, nullableString } from '../schema-helpers.js';

export const SyncCrmResultSchema = z.object({
  status: enumWithDefault(['synced', 'skipped', 'failed'], 'skipped'),
  company_id: nullableString(),
  person_id: nullableString(),
  deal_id: nullableString(),
  remote_dnc: nullableBoolean(false).optional(),
  reason: nullableString(),
});
