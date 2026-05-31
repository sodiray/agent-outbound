import { z } from 'zod';
import { enumWithDefault, nullableString } from '../schema-helpers.js';

export const ClassifyReplyResultSchema = z.object({
  classification: enumWithDefault([
    'booking_intent',
    'question',
    'objection',
    'hard_no',
    'positive_signal',
    'out_of_office',
    'unsubscribe',
    'bounce',
  ], 'question'),
  reason: nullableString(),
});
