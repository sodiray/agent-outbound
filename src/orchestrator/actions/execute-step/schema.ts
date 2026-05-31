import { z } from 'zod';
import { nullableBoolean, nullableString, recordWithDefault } from '../schema-helpers.js';

export const ExecuteStepResultSchema = z.object({
  outputs: recordWithDefault(),
  artifacts: recordWithDefault(),
  summary: nullableString(),
  defer: nullableBoolean(false),
  reason: nullableString(),
  pagination: recordWithDefault().nullable().optional(),
});
