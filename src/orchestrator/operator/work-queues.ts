/**
 * Operator work queues: repair, enrichment hold, objection, callback, meeting,
 * recycle, re-entry, stage review, and manual task lists.
 *
 * Each list* returns a stable envelope: { queue, total, items, as_of }.
 * SQL is defensive — missing columns/tables yield empty queues, not throws.
 */

import { listPendingStageReviews } from '../policy/transition-audit.js';
import { listAwaitingManualTasks } from '../pipeline/manual.js';
import { OUTBOUND_ACTION_TYPES } from '../policy/sequence-outbound.js';

export type WorkQueueName =
  | 'repair'
  | 'enrichment_hold'
  | 'objection'
  | 'callback'
  | 'meeting'
  | 'recycle'
  | 'reentry'
  | 'stage_review'
  | 'manual'
  | 'reply';

export type WorkQueueItem = {
  record_id: string;
  business_name: string;
  reason: string;
  lifecycle_stage?: string;
  account_sequence_state?: string;
  work_state?: string;
  treatment_tier?: string;
  disposition_latest?: string;
  due_at?: string | null;
  [key: string]: unknown;
};

export type WorkQueueResult = {
  queue: WorkQueueName;
  total: number;
  items: WorkQueueItem[];
  as_of: string;
};

const text = (v: unknown) => String(v ?? '').trim();

function tableHasColumn(db: any, table: string, column: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    return cols.some((c) => String(c.name || '') === column);
  } catch {
    return false;
  }
}

function safeAll(db: any, sql: string, params: unknown[] = []): any[] {
  try {
    return db.prepare(sql).all(...params) || [];
  } catch {
    return [];
  }
}

function safeCount(db: any, sql: string, params: unknown[] = []): number {
  try {
    const row = db.prepare(sql).get(...params);
    return Number(row?.n ?? 0) || 0;
  } catch {
    return 0;
  }
}

function seqStateExpr(db: any): string {
  if (tableHasColumn(db, 'records', 'account_sequence_state')) {
    return `lower(COALESCE(NULLIF(account_sequence_state,''), sequence_status, ''))`;
  }
  return `lower(COALESCE(sequence_status, ''))`;
}

function baseSelect(db: any): string {
  const cols = [
    `_row_id AS record_id`,
    `COALESCE(business_name, '') AS business_name`,
  ];
  if (tableHasColumn(db, 'records', 'lifecycle_stage')) {
    cols.push(`COALESCE(lifecycle_stage, '') AS lifecycle_stage`);
  } else {
    cols.push(`'' AS lifecycle_stage`);
  }
  if (tableHasColumn(db, 'records', 'account_sequence_state')) {
    cols.push(`COALESCE(NULLIF(account_sequence_state,''), sequence_status, '') AS account_sequence_state`);
  } else {
    cols.push(`COALESCE(sequence_status, '') AS account_sequence_state`);
  }
  if (tableHasColumn(db, 'records', 'work_state')) {
    cols.push(`COALESCE(work_state, '') AS work_state`);
  } else {
    cols.push(`'' AS work_state`);
  }
  if (tableHasColumn(db, 'records', 'treatment_tier')) {
    cols.push(`COALESCE(treatment_tier, '') AS treatment_tier`);
  } else {
    cols.push(`'' AS treatment_tier`);
  }
  if (tableHasColumn(db, 'records', 'disposition_latest')) {
    cols.push(`COALESCE(disposition_latest, '') AS disposition_latest`);
  } else {
    cols.push(`'' AS disposition_latest`);
  }
  if (tableHasColumn(db, 'records', 'eligibility_outcome')) {
    cols.push(`COALESCE(eligibility_outcome, '') AS eligibility_outcome`);
  } else {
    cols.push(`'' AS eligibility_outcome`);
  }
  if (tableHasColumn(db, 'records', 'next_action_json')) {
    cols.push(`COALESCE(next_action_json, '') AS next_action_json`);
  } else {
    cols.push(`'' AS next_action_json`);
  }
  if (tableHasColumn(db, 'records', 'updated_at')) {
    cols.push(`COALESCE(updated_at, '') AS updated_at`);
  } else if (tableHasColumn(db, 'records', '_updated_at')) {
    cols.push(`COALESCE(_updated_at, '') AS updated_at`);
  } else {
    cols.push(`'' AS updated_at`);
  }
  return cols.join(',\n       ');
}

function orderByUpdated(): string {
  return `ORDER BY COALESCE(updated_at, '') DESC, record_id ASC`;
}

function mapRow(row: any, reason: string, extra: Record<string, unknown> = {}): WorkQueueItem {
  return {
    record_id: text(row.record_id),
    business_name: text(row.business_name),
    reason,
    lifecycle_stage: text(row.lifecycle_stage) || undefined,
    account_sequence_state: text(row.account_sequence_state) || undefined,
    work_state: text(row.work_state) || undefined,
    treatment_tier: text(row.treatment_tier) || undefined,
    disposition_latest: text(row.disposition_latest) || undefined,
    due_at: extra.due_at != null ? (extra.due_at as string | null) : null,
    ...extra,
  };
}

function page(items: WorkQueueItem[], limit: number, offset: number): WorkQueueItem[] {
  return items.slice(offset, offset + limit);
}

function envelope(
  queue: WorkQueueName,
  items: WorkQueueItem[],
  limit: number,
  offset: number,
  total?: number,
): WorkQueueResult {
  return {
    queue,
    total: total ?? items.length,
    items: page(items, limit, offset),
    as_of: new Date().toISOString(),
  };
}

function repairReason(row: any): string {
  const reasons: string[] = [];
  const seq = text(row.account_sequence_state).toLowerCase();
  const work = text(row.work_state).toLowerCase();
  if (seq === 'paused_repair') reasons.push('paused_repair');
  if (work === 'channel_repair') reasons.push('channel_repair');
  if (isTruthyFlag(row.material_contradiction)) reasons.push('material_contradiction');
  const ie = text(row.integrity_errors || row.integrity_errors_json);
  if (ie && ie !== '[]' && ie !== 'null' && ie !== '{}') reasons.push('integrity_errors');
  const na = text(row.next_action_json).toLowerCase();
  if (na.includes('channel_repair') || na.includes('"action_type":"repair"')) {
    reasons.push('next_action_repair');
  }
  return reasons.join(',') || 'repair';
}

function isTruthyFlag(v: unknown): boolean {
  if (v == null || v === '') return false;
  if (typeof v === 'boolean') return v;
  const n = Number(v);
  if (Number.isFinite(n)) return n !== 0;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1' || s === '1.0';
}

/**
 * Repair queue: paused_repair / channel_repair / material_contradiction /
 * non-empty integrity_errors (when column present).
 */
export function listRepairQueue(input: {
  db: any;
  limit?: number;
  offset?: number;
}): WorkQueueResult {
  const limit = Math.max(1, Number(input.limit) || 100);
  const offset = Math.max(0, Number(input.offset) || 0);
  const db = input.db;
  const seq = seqStateExpr(db);
  const clauses: string[] = [`${seq} = 'paused_repair'`];

  if (tableHasColumn(db, 'records', 'work_state')) {
    clauses.push(`lower(COALESCE(work_state, '')) = 'channel_repair'`);
  }
  if (tableHasColumn(db, 'records', 'material_contradiction')) {
    // TEXT/REAL/INTEGER columns may hold 1, '1', '1.0', 'true', etc.
    clauses.push(`(
      CAST(material_contradiction AS REAL) != 0
      OR lower(trim(CAST(material_contradiction AS TEXT))) IN ('1','1.0','true','yes')
    )`);
  }
  if (tableHasColumn(db, 'records', 'integrity_errors')) {
    clauses.push(`(
      COALESCE(integrity_errors, '') != ''
      AND trim(COALESCE(integrity_errors, '')) NOT IN ('[]', 'null', '{}')
    )`);
  }
  if (tableHasColumn(db, 'records', 'integrity_errors_json')) {
    clauses.push(`(
      COALESCE(integrity_errors_json, '') != ''
      AND trim(COALESCE(integrity_errors_json, '')) NOT IN ('[]', 'null', '{}')
    )`);
  }
  if (tableHasColumn(db, 'records', 'next_action_json')) {
    clauses.push(`(
      lower(COALESCE(next_action_json, '')) LIKE '%channel_repair%'
      OR lower(COALESCE(next_action_json, '')) LIKE '%"action_type":"repair"%'
    )`);
  }

  const selectExtra: string[] = [];
  if (tableHasColumn(db, 'records', 'material_contradiction')) {
    selectExtra.push('material_contradiction');
  } else {
    selectExtra.push('0 AS material_contradiction');
  }
  if (tableHasColumn(db, 'records', 'integrity_errors')) {
    selectExtra.push('integrity_errors');
  } else if (tableHasColumn(db, 'records', 'integrity_errors_json')) {
    selectExtra.push('integrity_errors_json AS integrity_errors');
  } else {
    selectExtra.push(`'' AS integrity_errors`);
  }

  const where = clauses.join(' OR ');
  const rows = safeAll(
    db,
    `SELECT ${baseSelect(db)},
       ${selectExtra.join(', ')}
     FROM records
     WHERE ${where}
     ${orderByUpdated()}
     LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  const total = safeCount(db, `SELECT COUNT(*) AS n FROM records WHERE ${where}`);
  const items = rows.map((r) => mapRow(r, repairReason(r), {
    material_contradiction: isTruthyFlag(r.material_contradiction),
    integrity_errors: text(r.integrity_errors) || undefined,
  }));
  return envelope('repair', items, limit, 0, total);
}

/**
 * Enrichment hold: only an explicit treatment or eligibility outcome may place a
 * record in this queue. Generic research work is not a hold assignment.
 */
export function listEnrichmentHoldQueue(input: {
  db: any;
  limit?: number;
  offset?: number;
}): WorkQueueResult {
  const limit = Math.max(1, Number(input.limit) || 100);
  const offset = Math.max(0, Number(input.offset) || 0);
  const db = input.db;
  const clauses: string[] = [];
  if (tableHasColumn(db, 'records', 'treatment_tier')) {
    clauses.push(`lower(COALESCE(treatment_tier, '')) = 'enrichment_hold'`);
  }
  if (tableHasColumn(db, 'records', 'eligibility_outcome')) {
    clauses.push(`lower(COALESCE(eligibility_outcome, '')) = 'enrichment_hold'`);
  }
  if (clauses.length === 0) {
    return envelope('enrichment_hold', [], limit, offset, 0);
  }
  const where = clauses.join(' OR ');
  const rows = safeAll(
    db,
    `SELECT ${baseSelect(db)}
     FROM records
     WHERE ${where}
     ${orderByUpdated()}
     LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  const total = safeCount(db, `SELECT COUNT(*) AS n FROM records WHERE ${where}`);
  const items = rows.map((r) => {
    const reasons: string[] = [];
    if (text(r.treatment_tier).toLowerCase() === 'enrichment_hold') reasons.push('treatment_tier');
    if (text(r.eligibility_outcome).toLowerCase() === 'enrichment_hold') reasons.push('eligibility_outcome');
    return mapRow(r, reasons.join(',') || 'enrichment_hold', {
      eligibility_outcome: text(r.eligibility_outcome) || undefined,
    });
  });
  return envelope('enrichment_hold', items, limit, 0, total);
}

/**
 * Objection queue: disposition / reply classification = objection (or callback_requested from objection path).
 */
export function listObjectionQueue(input: {
  db: any;
  limit?: number;
  offset?: number;
}): WorkQueueResult {
  const limit = Math.max(1, Number(input.limit) || 100);
  const offset = Math.max(0, Number(input.offset) || 0);
  const db = input.db;
  const clauses: string[] = [];

  if (tableHasColumn(db, 'records', 'disposition_latest')) {
    clauses.push(`lower(COALESCE(disposition_latest, '')) IN ('objection', 'callback_requested')`);
  }
  if (tableHasColumn(db, 'records', 'reply_classification_latest')) {
    clauses.push(`lower(COALESCE(reply_classification_latest, '')) = 'objection'`);
  }
  if (tableHasColumn(db, 'records', 'email_reply_classification')) {
    clauses.push(`lower(COALESCE(email_reply_classification, '')) = 'objection'`);
  }
  if (tableHasColumn(db, 'records', 'next_action_json')) {
    clauses.push(`lower(COALESCE(next_action_json, '')) LIKE '%objection_inbound%'`);
  }

  // Also surface interaction-side objections when table exists.
  let interactionIds = new Set<string>();
  try {
    const ix = safeAll(
      db,
      `SELECT DISTINCT record_id FROM interactions
       WHERE COALESCE(deleted_at, '') = ''
         AND (
           lower(kind) = 'objection'
           OR COALESCE(objections, '') != ''
         )
       LIMIT 500`,
    );
    interactionIds = new Set(ix.map((r) => text(r.record_id)).filter(Boolean));
  } catch {
    /* no interactions table */
  }

  if (clauses.length === 0 && interactionIds.size === 0) {
    return envelope('objection', [], limit, offset, 0);
  }

  const where = clauses.length ? clauses.join(' OR ') : '0';
  const rows = clauses.length
    ? safeAll(
      db,
      `SELECT ${baseSelect(db)}
       FROM records
       WHERE ${where}
       ${orderByUpdated()}
       LIMIT ?`,
      [Math.max(limit + offset, 200)],
    )
    : [];

  const byId = new Map<string, any>();
  for (const r of rows) byId.set(text(r.record_id), r);

  // Pull any interaction-only objections not already in rows.
  for (const rid of interactionIds) {
    if (byId.has(rid)) continue;
    const extra = safeAll(
      db,
      `SELECT ${baseSelect(db)} FROM records WHERE _row_id = ? LIMIT 1`,
      [rid],
    );
    if (extra[0]) byId.set(rid, extra[0]);
  }

  const items = [...byId.values()].map((r) => {
    const reasons: string[] = [];
    const disp = text(r.disposition_latest).toLowerCase();
    if (disp === 'objection' || disp === 'callback_requested') reasons.push(`disposition:${disp}`);
    if (interactionIds.has(text(r.record_id))) reasons.push('interaction_objection');
    return mapRow(r, reasons.join(',') || 'objection');
  });
  items.sort((a, b) => text(b.record_id).localeCompare(text(a.record_id)));
  return envelope('objection', items, limit, offset, items.length);
}

/**
 * Callback queue: disposition callback / disposition_follow_up_at due / callback_at due.
 */
export function listCallbackQueue(input: {
  db: any;
  limit?: number;
  offset?: number;
  /** ISO now; default current time. Used for due comparisons. */
  now?: string;
}): WorkQueueResult {
  const limit = Math.max(1, Number(input.limit) || 100);
  const offset = Math.max(0, Number(input.offset) || 0);
  const db = input.db;
  const now = text(input.now) || new Date().toISOString();
  const clauses: string[] = [];

  if (tableHasColumn(db, 'records', 'disposition_latest')) {
    clauses.push(`lower(COALESCE(disposition_latest, '')) IN (
      'callback', 'callback_requested', 'call_back', 'callback_scheduled'
    )`);
  }
  if (tableHasColumn(db, 'records', 'call_last_disposition')) {
    clauses.push(`lower(COALESCE(call_last_disposition, '')) LIKE '%callback%'`);
  }
  if (tableHasColumn(db, 'records', 'disposition_follow_up_at')) {
    // Due or soon: any non-empty follow-up time (operator list; filter due in reason).
    clauses.push(`COALESCE(disposition_follow_up_at, '') != ''`);
  }
  if (tableHasColumn(db, 'records', 'callback_at')) {
    clauses.push(`COALESCE(callback_at, '') != ''`);
  }
  if (tableHasColumn(db, 'records', 'next_action_json')) {
    clauses.push(`(
      lower(COALESCE(next_action_json, '')) LIKE '%callback%'
      OR lower(COALESCE(next_action_json, '')) LIKE '%call_human%'
    )`);
  }

  if (clauses.length === 0) {
    return envelope('callback', [], limit, offset, 0);
  }

  const selectExtra: string[] = [];
  if (tableHasColumn(db, 'records', 'disposition_follow_up_at')) {
    selectExtra.push(`COALESCE(disposition_follow_up_at, '') AS disposition_follow_up_at`);
  } else {
    selectExtra.push(`'' AS disposition_follow_up_at`);
  }
  if (tableHasColumn(db, 'records', 'callback_at')) {
    selectExtra.push(`COALESCE(callback_at, '') AS callback_at`);
  } else {
    selectExtra.push(`'' AS callback_at`);
  }

  const where = clauses.join(' OR ');
  const rows = safeAll(
    db,
    `SELECT ${baseSelect(db)},
       ${selectExtra.join(', ')}
     FROM records
     WHERE ${where}
     ${orderByUpdated()}
     LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  const total = safeCount(db, `SELECT COUNT(*) AS n FROM records WHERE ${where}`);
  const items = rows.map((r) => {
    const followUp = text(r.disposition_follow_up_at) || text(r.callback_at) || null;
    const due = followUp && followUp <= now;
    const reasons: string[] = [];
    const disp = text(r.disposition_latest).toLowerCase();
    if (disp.includes('callback')) reasons.push(`disposition:${disp}`);
    if (followUp) reasons.push(due ? 'callback_due' : 'callback_scheduled');
    return mapRow(r, reasons.join(',') || 'callback', {
      due_at: followUp,
      is_due: Boolean(due),
    });
  });
  return envelope('callback', items, limit, 0, total);
}

/**
 * Meeting queue: lifecycle meeting_booked / disposition meeting / meeting_booked_at set.
 */
export function listMeetingQueue(input: {
  db: any;
  limit?: number;
  offset?: number;
}): WorkQueueResult {
  const limit = Math.max(1, Number(input.limit) || 100);
  const offset = Math.max(0, Number(input.offset) || 0);
  const db = input.db;
  const clauses: string[] = [];

  if (tableHasColumn(db, 'records', 'lifecycle_stage')) {
    clauses.push(`lower(COALESCE(lifecycle_stage, '')) = 'meeting_booked'`);
  }
  if (tableHasColumn(db, 'records', 'disposition_latest')) {
    clauses.push(`lower(COALESCE(disposition_latest, '')) IN (
      'meeting_booked', 'booked_meeting', 'meeting', 'qualified_conversation'
    )`);
  }
  if (tableHasColumn(db, 'records', 'meeting_booked_at')) {
    clauses.push(`COALESCE(meeting_booked_at, '') != ''`);
  }
  if (tableHasColumn(db, 'records', 'reply_classification_latest')) {
    clauses.push(`lower(COALESCE(reply_classification_latest, '')) IN ('booking_intent', 'meeting_booked')`);
  }
  if (tableHasColumn(db, 'records', 'email_reply_classification')) {
    clauses.push(`lower(COALESCE(email_reply_classification, '')) IN ('booking_intent', 'meeting_booked')`);
  }
  if (tableHasColumn(db, 'records', 'work_state')) {
    clauses.push(`lower(COALESCE(work_state, '')) IN ('meeting_prep_or_completion', 'human_commercial_followup')
      AND lower(COALESCE(lifecycle_stage, '')) = 'meeting_booked'`);
  }

  if (clauses.length === 0) {
    return envelope('meeting', [], limit, offset, 0);
  }

  const selectExtra = tableHasColumn(db, 'records', 'meeting_booked_at')
    ? [`COALESCE(meeting_booked_at, '') AS meeting_booked_at`]
    : [`'' AS meeting_booked_at`];

  const where = clauses.join(' OR ');
  const rows = safeAll(
    db,
    `SELECT ${baseSelect(db)},
       ${selectExtra.join(', ')}
     FROM records
     WHERE ${where}
     ${orderByUpdated()}
     LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  const total = safeCount(db, `SELECT COUNT(*) AS n FROM records WHERE ${where}`);
  const items = rows.map((r) => {
    const reasons: string[] = [];
    if (text(r.lifecycle_stage).toLowerCase() === 'meeting_booked') reasons.push('lifecycle_meeting_booked');
    if (text(r.meeting_booked_at)) reasons.push('meeting_booked_at');
    const disp = text(r.disposition_latest).toLowerCase();
    if (['meeting_booked', 'booked_meeting', 'meeting', 'qualified_conversation'].includes(disp)) {
      reasons.push(`disposition:${disp}`);
    }
    return mapRow(r, reasons.join(',') || 'meeting', {
      meeting_booked_at: text(r.meeting_booked_at) || undefined,
    });
  });
  return envelope('meeting', items, limit, 0, total);
}

/**
 * Recycle queue: recycle_wait sequence / lifecycle recycled / priority recycle_monitoring.
 */
export function listRecycleQueue(input: {
  db: any;
  limit?: number;
  offset?: number;
}): WorkQueueResult {
  const limit = Math.max(1, Number(input.limit) || 100);
  const offset = Math.max(0, Number(input.offset) || 0);
  const db = input.db;
  const seq = seqStateExpr(db);
  const clauses = [
    `${seq} = 'recycle_wait'`,
  ];
  if (tableHasColumn(db, 'records', 'lifecycle_stage')) {
    clauses.push(`lower(COALESCE(lifecycle_stage, '')) = 'recycled'`);
  }
  if (tableHasColumn(db, 'records', 'priority_lane')) {
    clauses.push(`lower(COALESCE(priority_lane, '')) IN ('recycle_monitoring', 'recycle')`);
  }
  if (tableHasColumn(db, 'records', 'next_action_json')) {
    clauses.push(`(
      lower(COALESCE(next_action_json, '')) LIKE '%recycle_monitor%'
      OR lower(COALESCE(next_action_json, '')) LIKE '%await_reply_or_recycle%'
    )`);
  }

  const selectExtra = tableHasColumn(db, 'records', 'priority_lane')
    ? [`COALESCE(priority_lane, '') AS priority_lane`]
    : [`'' AS priority_lane`];

  const where = clauses.join(' OR ');
  const rows = safeAll(
    db,
    `SELECT ${baseSelect(db)},
       ${selectExtra.join(', ')}
     FROM records
     WHERE ${where}
     ${orderByUpdated()}
     LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  const total = safeCount(db, `SELECT COUNT(*) AS n FROM records WHERE ${where}`);
  const items = rows.map((r) => {
    const reasons: string[] = [];
    if (text(r.account_sequence_state).toLowerCase() === 'recycle_wait') reasons.push('recycle_wait');
    if (text(r.lifecycle_stage).toLowerCase() === 'recycled') reasons.push('lifecycle_recycled');
    if (['recycle_monitoring', 'recycle'].includes(text(r.priority_lane).toLowerCase())) {
      reasons.push(`priority:${text(r.priority_lane)}`);
    }
    return mapRow(r, reasons.join(',') || 'recycle', {
      priority_lane: text(r.priority_lane) || undefined,
    });
  });
  return envelope('recycle', items, limit, 0, total);
}

/**
 * Re-entry queue: reentry_evaluation work / reentry next_action / reentry sequence markers.
 */
export function listReentryQueue(input: {
  db: any;
  limit?: number;
  offset?: number;
}): WorkQueueResult {
  const limit = Math.max(1, Number(input.limit) || 100);
  const offset = Math.max(0, Number(input.offset) || 0);
  const db = input.db;
  const clauses: string[] = [];

  if (tableHasColumn(db, 'records', 'work_state')) {
    clauses.push(`lower(COALESCE(work_state, '')) = 'reentry_evaluation'`);
  }
  if (tableHasColumn(db, 'records', 'next_action_json')) {
    clauses.push(`(
      lower(COALESCE(next_action_json, '')) LIKE '%reentry%'
      OR lower(COALESCE(next_action_json, '')) LIKE '%re-entry%'
      OR lower(COALESCE(next_action_json, '')) LIKE '%re_entry%'
    )`);
  }
  const seq = seqStateExpr(db);
  clauses.push(`${seq} LIKE '%reentry%'`);
  clauses.push(`${seq} LIKE '%re_entry%'`);
  if (tableHasColumn(db, 'records', 'reentry_allowed')) {
    clauses.push(`(
      reentry_allowed = 1
      OR lower(CAST(reentry_allowed AS TEXT)) IN ('1','true','yes')
    )`);
  }

  const where = clauses.join(' OR ');
  const rows = safeAll(
    db,
    `SELECT ${baseSelect(db)}
     FROM records
     WHERE ${where}
     ${orderByUpdated()}
     LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  const total = safeCount(db, `SELECT COUNT(*) AS n FROM records WHERE ${where}`);
  const items = rows.map((r) => {
    const reasons: string[] = [];
    if (text(r.work_state).toLowerCase() === 'reentry_evaluation') reasons.push('reentry_evaluation');
    if (/reentry|re_entry|re-entry/i.test(text(r.next_action_json))) reasons.push('next_action_reentry');
    if (/reentry|re_entry/i.test(text(r.account_sequence_state))) reasons.push('sequence_reentry');
    return mapRow(r, reasons.join(',') || 'reentry');
  });
  return envelope('reentry', items, limit, 0, total);
}

/**
 * Stage review queue — wraps listPendingStageReviews (open by default).
 */
export function listStageReviewQueue(input: {
  db: any;
  limit?: number;
  offset?: number;
  status?: string;
}): WorkQueueResult {
  const limit = Math.max(1, Number(input.limit) || 100);
  const offset = Math.max(0, Number(input.offset) || 0);
  const listed = listPendingStageReviews({
    db: input.db,
    status: input.status || 'open',
    limit,
    offset,
  });
  const items: WorkQueueItem[] = (listed.reviews || []).map((r) => ({
    record_id: text(r.record_id),
    business_name: text(r.business_name),
    reason: `stage_review:${text(r.status) || 'pending'}`,
    account_sequence_state: text(r.account_sequence_state) || undefined,
    work_state: text(r.work_state) || undefined,
    due_at: null,
    stage_id: r.stage_id,
    review_id: r.review_id,
    asset_version: r.asset_version,
    status: r.status,
    channel: r.channel,
    action_type: r.action_type,
  }));
  return {
    queue: 'stage_review',
    total: Number(listed.total) || items.length,
    items,
    as_of: listed.as_of || new Date().toISOString(),
  };
}

/**
 * Manual queue — wraps listAwaitingManualTasks.
 */
export function listManualQueue(input: {
  db: any;
  config?: unknown;
  limit?: number;
  offset?: number;
  taskType?: string;
  listDir?: string;
  reconcile?: boolean;
}): WorkQueueResult {
  const limit = Math.max(1, Number(input.limit) || 100);
  const offset = Math.max(0, Number(input.offset) || 0);
  const listed = listAwaitingManualTasks({
    db: input.db,
    config: input.config,
    taskType: input.taskType || '',
    limit,
    offset,
    listDir: input.listDir || '',
    reconcile: Boolean(input.reconcile),
  });
  const items: WorkQueueItem[] = (listed.tasks || []).map((t) => ({
    record_id: text(t.record_id),
    business_name: text(t.business_name),
    reason: `awaiting_manual:${text(t.task_type) || 'manual'}`,
    due_at: text(t.parked_at) || null,
    step_id: t.step_id,
    task_type: t.task_type,
    contact_name: t.contact_name,
    contact_email: t.contact_email,
    sequence_name: t.sequence_name,
    pipeline_name: t.pipeline_name,
    parked_at: t.parked_at,
  }));
  return {
    queue: 'manual',
    total: Number(listed.total) || items.length,
    items,
    as_of: new Date().toISOString(),
  };
}

/**
 * Reply queue: inbound replies awaiting human review.
 * - inbound_pending_human_review = 1, OR
 * - account_sequence_state = paused_inbound AND inbound_proposed_classification set
 */
export function listReplyQueue(input: {
  db: any;
  limit?: number;
  offset?: number;
}): WorkQueueResult {
  const limit = Math.max(1, Number(input.limit) || 100);
  const offset = Math.max(0, Number(input.offset) || 0);
  const db = input.db;
  const clauses: string[] = [];

  if (tableHasColumn(db, 'records', 'inbound_pending_human_review')) {
    clauses.push(`(
      CAST(inbound_pending_human_review AS REAL) != 0
      OR lower(trim(CAST(inbound_pending_human_review AS TEXT))) IN ('1','1.0','true','yes')
    )`);
  }

  const seq = seqStateExpr(db);
  const hasProposed = tableHasColumn(db, 'records', 'inbound_proposed_classification');
  if (hasProposed) {
    clauses.push(`(
      ${seq} = 'paused_inbound'
      AND COALESCE(NULLIF(trim(inbound_proposed_classification), ''), '') != ''
    )`);
  } else {
    // Without proposed-classification column, still surface paused_inbound.
    clauses.push(`${seq} = 'paused_inbound'`);
  }

  if (clauses.length === 0) {
    return envelope('reply', [], limit, offset, 0);
  }

  const selectExtra: string[] = [];
  if (tableHasColumn(db, 'records', 'inbound_pending_human_review')) {
    selectExtra.push('inbound_pending_human_review');
  } else {
    selectExtra.push('0 AS inbound_pending_human_review');
  }
  if (hasProposed) {
    selectExtra.push(`COALESCE(inbound_proposed_classification, '') AS inbound_proposed_classification`);
  } else {
    selectExtra.push(`'' AS inbound_proposed_classification`);
  }
  if (tableHasColumn(db, 'records', 'reply_classification_latest')) {
    selectExtra.push(`COALESCE(reply_classification_latest, '') AS reply_classification_latest`);
  } else if (tableHasColumn(db, 'records', 'email_reply_classification')) {
    selectExtra.push(`COALESCE(email_reply_classification, '') AS reply_classification_latest`);
  } else {
    selectExtra.push(`'' AS reply_classification_latest`);
  }

  const where = clauses.join(' OR ');
  const rows = safeAll(
    db,
    `SELECT ${baseSelect(db)},
       ${selectExtra.join(', ')}
     FROM records
     WHERE ${where}
     ${orderByUpdated()}
     LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  const total = safeCount(db, `SELECT COUNT(*) AS n FROM records WHERE ${where}`);
  const items = rows.map((r) => {
    const reasons: string[] = [];
    if (isTruthyFlag(r.inbound_pending_human_review)) reasons.push('inbound_pending_human_review');
    if (text(r.account_sequence_state).toLowerCase() === 'paused_inbound') {
      reasons.push('paused_inbound');
    }
    const proposed = text(r.inbound_proposed_classification);
    if (proposed) reasons.push(`proposed:${proposed}`);
    return mapRow(r, reasons.join(',') || 'reply', {
      inbound_pending_human_review: isTruthyFlag(r.inbound_pending_human_review),
      inbound_proposed_classification: proposed || undefined,
      reply_classification_latest: text(r.reply_classification_latest) || undefined,
    });
  });
  return envelope('reply', items, limit, 0, total);
}

export const WORK_QUEUE_NAMES: WorkQueueName[] = [
  'repair',
  'enrichment_hold',
  'objection',
  'callback',
  'meeting',
  'recycle',
  'reentry',
  'stage_review',
  'manual',
  'reply',
];

const QUEUE_FNS: Record<WorkQueueName, (input: {
  db: any;
  config?: unknown;
  limit?: number;
  offset?: number;
  status?: string;
  taskType?: string;
  now?: string;
  listDir?: string;
  reconcile?: boolean;
}) => WorkQueueResult> = {
  repair: listRepairQueue,
  enrichment_hold: listEnrichmentHoldQueue,
  objection: listObjectionQueue,
  callback: listCallbackQueue,
  meeting: listMeetingQueue,
  recycle: listRecycleQueue,
  reentry: listReentryQueue,
  stage_review: listStageReviewQueue,
  manual: listManualQueue,
  reply: listReplyQueue,
};

/**
 * Dispatch a named work queue. Unknown names throw.
 */
export function listWorkQueue(input: {
  db: any;
  config?: unknown;
  queue: string;
  limit?: number;
  offset?: number;
  status?: string;
  taskType?: string;
  now?: string;
  listDir?: string;
  reconcile?: boolean;
}): WorkQueueResult {
  const name = text(input.queue).toLowerCase().replace(/-/g, '_') as WorkQueueName;
  const fn = QUEUE_FNS[name];
  if (!fn) {
    throw new Error(
      `Unknown work queue "${input.queue}". Valid: ${WORK_QUEUE_NAMES.join(', ')}`,
    );
  }
  return fn(input);
}

/**
 * Snapshot counts for all work queues (cheap portfolio view).
 */
export function listAllWorkQueueCounts(input: {
  db: any;
  limit?: number;
}): {
  as_of: string;
  queues: Record<WorkQueueName, number>;
  samples?: Partial<Record<WorkQueueName, WorkQueueItem[]>>;
} {
  const sampleLimit = Math.min(5, Math.max(0, Number(input.limit) || 0));
  const queues = {} as Record<WorkQueueName, number>;
  const samples: Partial<Record<WorkQueueName, WorkQueueItem[]>> = {};
  for (const name of WORK_QUEUE_NAMES) {
    const result = QUEUE_FNS[name]({ db: input.db, limit: sampleLimit || 1, offset: 0 });
    queues[name] = result.total;
    if (sampleLimit > 0) samples[name] = result.items.slice(0, sampleLimit);
  }
  return {
    as_of: new Date().toISOString(),
    queues,
    ...(sampleLimit > 0 ? { samples } : {}),
  };
}

/** Exported for health: outbound action type set. */
export { OUTBOUND_ACTION_TYPES };
