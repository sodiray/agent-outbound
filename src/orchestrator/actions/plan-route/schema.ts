import { z } from 'zod';
import { arrayOf, nullableNumber, nullableString } from '../schema-helpers.js';

export const RoutePlanSchema = z.object({
  route_date: nullableString(),
  total_drive_minutes: nullableNumber(0, z.number().int().nonnegative()),
  stops: arrayOf(z.object({
    record_id: nullableString(),
    stop_order: nullableNumber(1, z.number().int().positive()),
    scheduled_time: nullableString(),
    drive_minutes_from_prev: nullableNumber(0, z.number().int().nonnegative()),
    calendar_event_id: nullableString(),
    eta: nullableString(),
    notes: nullableString(),
  })),
  summary: nullableString(),
});
