import { randomUUID } from 'node:crypto';

type Db = {
  prepare: (sql: string) => {
    get: (...values: unknown[]) => { n?: unknown } | undefined;
    run: (...values: unknown[]) => unknown;
  };
  transaction: <T>(fn: () => T) => () => T;
};

const dayStartIso = (value: string | Date) => {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
};

/** Reservation interaction_type for a per-mailbox email daily cap. */
export const mailboxCapInteractionType = (mailboxId: string) => `mailbox:${String(mailboxId || '').trim()}`;

export const reserveChannelDailyCap = ({
  db,
  channel,
  interactionType,
  cap,
  at,
  mailboxId = '',
}: {
  db: Db;
  channel: string;
  interactionType: string;
  cap: number;
  at: string | Date;
  /** When set, count channel_events by payload.mailbox_id (per-mailbox email caps). */
  mailboxId?: string;
}) => db.transaction(() => {
  const dayStart = dayStartIso(at);
  const nextDay = new Date(dayStart);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const scopedMailbox = String(mailboxId || '').trim();
  const used = db.prepare(`
    SELECT (
      SELECT COUNT(*)
      FROM channel_events
      WHERE channel = ?
        AND (action IN ('executed', 'sent') OR event_type IN ('executed', 'sent'))
        AND occurred_at >= ?
        AND occurred_at < ?
        AND (
          CASE
            WHEN ? != '' THEN
              json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.mailbox_id') = ?
            ELSE (
              json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.interaction_type') = ?
              OR (
                ? = 'invite'
                AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.linkedin_lifecycle_state') = 'invite_sent'
              )
            )
          END
        )
    ) + (
      SELECT COUNT(*)
      FROM channel_daily_cap_reservations
      WHERE channel = ?
        AND interaction_type = ?
        AND day_start = ?
        AND status IN ('reserved', 'accepted')
    ) AS n
  `).get(
    channel,
    dayStart,
    nextDay.toISOString(),
    scopedMailbox,
    scopedMailbox,
    interactionType,
    interactionType,
    channel,
    interactionType,
    dayStart,
  );
  if (Number(used?.n || 0) >= cap) return { allowed: false as const };

  const reservationId = randomUUID();
  db.prepare(`
    INSERT INTO channel_daily_cap_reservations (
      reservation_id, channel, interaction_type, day_start, status, created_at
    ) VALUES (?, ?, ?, ?, 'reserved', ?)
  `).run(reservationId, channel, interactionType, dayStart, new Date(at).toISOString());
  return { allowed: true as const, reservationId };
})();

export const acceptChannelDailyCapReservation = ({
  db,
  reservationId,
  at,
}: {
  db: Db;
  reservationId: string;
  at: string | Date;
}) => {
  db.prepare(`
    UPDATE channel_daily_cap_reservations
    SET status = 'accepted', accepted_at = ?
    WHERE reservation_id = ? AND status = 'reserved'
  `).run(new Date(at).toISOString(), reservationId);
};

export const releaseChannelDailyCapReservation = ({ db, reservationId }: { db: Db; reservationId: string }) => {
  db.prepare(`
    DELETE FROM channel_daily_cap_reservations
    WHERE reservation_id = ? AND status = 'reserved'
  `).run(reservationId);
};

export const settleChannelDailyCapReservation = ({ db, reservationId }: { db: Db; reservationId: string }) => {
  db.prepare(`
    DELETE FROM channel_daily_cap_reservations
    WHERE reservation_id = ? AND status = 'accepted'
  `).run(reservationId);
};
