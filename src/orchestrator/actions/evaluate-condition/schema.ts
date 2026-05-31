import { z } from 'zod';
import { nullableBoolean, nullableString } from '../schema-helpers.js';

export const ConditionResultSchema = z.object({
  passed: nullableBoolean(false),
  defer: nullableBoolean(false),
  reason: nullableString(),
});
