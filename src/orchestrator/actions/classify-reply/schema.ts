import { z } from 'zod';

export const ClassifyReplyResultSchema = z.object({
  classification: z.enum([
    'booking_intent',
    'question',
    'objection',
    'hard_no',
    'positive_signal',
    'out_of_office',
    'unsubscribe',
    'bounce',
  ]).default('question'),
  reason: z.string().default(''),
});
