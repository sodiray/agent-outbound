import { z } from 'zod';

export const RoutePlanSchema = z.object({
  route_date: z.string(),
  total_drive_minutes: z.number().int().nonnegative().default(0),
  stops: z.array(z.object({
    record_id: z.string(),
    stop_order: z.number().int().positive(),
    scheduled_time: z.string().default(''),
    drive_minutes_from_prev: z.number().int().nonnegative().default(0),
    calendar_event_id: z.string().default(''),
    eta: z.string().default(''),
    notes: z.string().default(''),
  })),
  summary: z.string().default(''),
});
