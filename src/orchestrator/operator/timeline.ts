/**
 * Account timeline: interactions, pipeline events, channel events, lifecycle,
 * stage review transitions, next_action, reviews.
 */

export type TimelineEvent = {
  at: string;
  kind: string;
  source: string;
  summary: string;
  tense: 'occurred' | 'planned';
  provenance?: 'performed_and_evidenced' | 'dispatched_unverified';
  detail?: Record<string, unknown>;
};

export type AccountTimeline = {
  record_id: string;
  business_name: string;
  events: TimelineEvent[];
  current: {
    lifecycle_stage?: string;
    sequence_status?: string;
    work_state?: string;
    treatment_tier?: string;
    stage_review?: unknown;
    next_action?: unknown;
    readiness?: unknown;
  };
};

const parseJson = (v: unknown): unknown => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

/** Safe count helper — returns 0 when SQL fails (missing table/column). */
function safeCount(db: any, sql: string, params: unknown[] = []): number {
  try {
    const row = db.prepare(sql).get(...params);
    return Number(row?.n ?? 0) || 0;
  } catch {
    return 0;
  }
}

function tableHasColumn(db: any, table: string, column: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    return cols.some((c) => String(c.name || '') === column);
  } catch {
    return false;
  }
}

export function getAccountTimeline(input: {
  db: any;
  recordId: string;
  limit?: number;
}): AccountTimeline {
  const rid = String(input.recordId || '').trim();
  const limit = Math.max(1, Number(input.limit) || 100);
  const row = input.db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rid);
  if (!row) throw new Error(`Record not found: ${rid}`);

  const events: TimelineEvent[] = [];

  // --- pipeline_events (includes review/awaiting parks) ---
  try {
    const pe = input.db.prepare(`
      SELECT * FROM pipeline_events WHERE record_id = ? ORDER BY occurred_at DESC LIMIT ?
    `).all(rid, limit);
    for (const e of pe) {
      const reason = String(e.reason || '');
      const kind = String(e.kind || 'pipeline');
      const passed = Number(e.passed) === 1;
      const awaiting =
        !passed
        && (
          reason === 'awaiting_manual'
          || /stage.?review|awaiting|pending.?review|paused_review/i.test(reason)
          || /review|manual_task|human/i.test(kind)
        );
      const label = passed
        ? 'passed'
        : awaiting
          ? 'awaiting/review'
          : 'parked/fail';
      events.push({
        at: String(e.occurred_at || ''),
        kind: awaiting ? `pipeline_${kind}_awaiting` : kind,
        source: 'pipeline_events',
        summary: `${kind} ${e.step_id || ''} ${label}: ${reason}`.trim(),
        tense: 'occurred',
        provenance: Number(e.side_effecting) === 1 && passed ? 'dispatched_unverified' : undefined,
        detail: {
          step_id: e.step_id,
          passed: Number(e.passed),
          reason,
          wake_at: e.wake_at || undefined,
          side_effecting: e.side_effecting,
          awaiting_review: awaiting,
        },
      });
    }
  } catch {
    /* table may not exist */
  }

  // --- channel_events (sends, replies, delivery, etc.) ---
  try {
    const ce = input.db.prepare(`
      SELECT ce.*, timeline.tense, timeline.provenance
      FROM channel_events ce
      JOIN records_timeline timeline ON timeline.timeline_id = ce.event_id
      WHERE ce.row_id = ?
      ORDER BY ce.occurred_at DESC
      LIMIT ?
    `).all(rid, limit);
    for (const e of ce) {
      const channel = String(e.channel || '');
      const eventType = String(e.event_type || e.action || 'channel');
      const disposition = String(e.disposition || '');
      const notes = String(e.notes || '');
      const tense = e.tense === 'planned' ? 'planned' : 'occurred';
      const provenance = e.provenance === 'performed_and_evidenced'
        || e.provenance === 'dispatched_unverified'
        ? e.provenance
        : undefined;
      const parts = [
        tense,
        channel,
        eventType,
        disposition ? `disp=${disposition}` : '',
        provenance ? `provenance=${provenance}` : '',
        notes,
      ].filter(Boolean);
      events.push({
        at: String(e.occurred_at || e.created_at || ''),
        kind: eventType,
        source: 'channel_events',
        summary: parts.join(' · '),
        tense,
        provenance,
        detail: {
          channel,
          event_type: eventType,
          action: e.action,
          disposition: disposition || undefined,
          contact_id: e.contact_id || undefined,
          provider_id: e.provider_id || undefined,
          thread_id: e.thread_id || e.provider_thread_id || undefined,
          sequence_step: e.sequence_step || undefined,
          tense,
          provenance,
        },
      });
    }
  } catch {
    /* table may not exist */
  }

  // --- interactions (record_id only; no row_id / channel columns) ---
  try {
    const ix = input.db.prepare(`
      SELECT * FROM interactions
      WHERE record_id = ?
        AND COALESCE(deleted_at, '') = ''
      ORDER BY occurred_at DESC
      LIMIT ?
    `).all(rid, limit);
    for (const e of ix) {
      const kind = String(e.kind || 'interaction');
      const summaryText = String(e.summary || e.body || e.objections || e.contact || '');
      events.push({
        at: String(e.occurred_at || e.created_at || ''),
        kind,
        source: 'interactions',
        summary: `${kind}: ${summaryText}`.trim(),
        tense: 'occurred',
        detail: {
          interaction_id: e.interaction_id,
          contact: e.contact || undefined,
          objections: e.objections || undefined,
          follow_up_at: e.follow_up_at || undefined,
          follow_up_done_at: e.follow_up_done_at || undefined,
          created_by: e.created_by || undefined,
        },
      });
    }
  } catch {
    /* ignore */
  }

  // --- transition_audit_json ---
  try {
    const audits = parseJson(row.transition_audit_json);
    if (Array.isArray(audits)) {
      for (const a of audits.slice(-limit)) {
        events.push({
          at: String(a.occurred_at || ''),
          kind: String(a.kind || 'transition'),
          source: 'transition_audit',
          summary: `${a.kind}: ${a.from_state || ''} → ${a.to_state || ''} (${a.reason || ''})`,
          tense: 'occurred',
          detail: a,
        });
      }
    }
  } catch {
    /* ignore */
  }

  // --- stage_review_json transitions (pending / authorized / rejected / …) ---
  try {
    const review = parseJson(row.stage_review_json) as Record<string, unknown> | null;
    if (review && typeof review === 'object') {
      const status = String(review.status || 'unknown');
      const stageId = String(review.stage_id || '');
      const assetVersion = String(review.asset_version || '');
      const authorizedAt = String(review.authorized_at || '');
      const at =
        authorizedAt
        || String(row.updated_at || row._updated_at || '')
        || new Date().toISOString();
      events.push({
        at,
        kind: `stage_review_${status}`,
        source: 'stage_review_json',
        summary: `stage_review ${status} stage=${stageId} asset=${assetVersion}${
          review.notes ? `: ${review.notes}` : ''
        }`.trim(),
        tense: 'occurred',
        detail: {
          review_id: review.review_id,
          stage_id: stageId,
          asset_version: assetVersion,
          status,
          channel: review.channel,
          action_type: review.action_type,
          authorized_by: review.authorized_by,
          authorized_at: authorizedAt || undefined,
          notes: review.notes,
        },
      });
    }
  } catch {
    /* ignore */
  }

  if (row.policy_applied_at) {
    events.push({
      at: String(row.policy_applied_at),
      kind: 'policy_apply',
      source: 'record',
      summary: `policy applied treatment=${row.treatment_tier} priority=${row.priority_lane}`,
      tense: 'occurred',
    });
  }

  events.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  let next_action: unknown = null;
  let readiness: unknown = null;
  let stage_review: unknown = null;
  try {
    next_action = row.next_action_json ? parseJson(row.next_action_json) : null;
  } catch {
    next_action = row.next_action_json;
  }
  try {
    readiness = row.readiness_json ? parseJson(row.readiness_json) : null;
  } catch {
    readiness = row.readiness_json;
  }
  try {
    stage_review = row.stage_review_json ? parseJson(row.stage_review_json) : null;
  } catch {
    stage_review = row.stage_review_json;
  }

  return {
    record_id: rid,
    business_name: String(row.business_name || ''),
    events: events.slice(0, limit),
    current: {
      lifecycle_stage: String(row.lifecycle_stage || ''),
      sequence_status: String(row.sequence_status || ''),
      work_state: String(row.work_state || ''),
      treatment_tier: String(row.treatment_tier || ''),
      stage_review,
      next_action,
      readiness,
    },
  };
}

/** Decision/evidence view: why the system chose treatment/priority/withheld. */
export function getDecisionView(input: { db: any; recordId: string }) {
  const rid = String(input.recordId || '').trim();
  const row = input.db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rid);
  if (!row) throw new Error(`Record not found: ${rid}`);
  const parse = (v: unknown) => parseJson(v);
  return {
    record_id: rid,
    business_name: String(row.business_name || ''),
    treatment_tier: row.treatment_tier,
    treatment_reasons: row.treatment_reasons,
    treatment_json: parse(row.treatment_json),
    fit_score: row.fit_score,
    fit_evidence_confidence: row.fit_evidence_confidence,
    fit_calculation: parse(row.fit_calculation_json),
    priority_lane: row.priority_lane,
    priority_rank: row.priority_rank,
    priority_json: parse(row.priority_json),
    readiness: parse(row.readiness_json),
    evidence_resolution: parse(row.evidence_resolution_json),
    observations: parse(row.observations_json),
    contradictions: parse(row.contradictions_json),
    timing: parse(row.timing_json),
    reachability: parse(row.reachability_json),
    cost_ledger: parse(row.cost_ledger_json),
    next_action: parse(row.next_action_json),
    stage_review: parse(row.stage_review_json),
    withheld: {
      mail_program_eligible: row.mail_program_eligible,
      mail_treatment: row.mail_treatment,
    },
  };
}

/**
 * Compact cost ledger for audit export (totals only — not full entry history).
 * Enough to reconstruct spend posture at decision time without dumping every line.
 */
function costLedgerSummary(raw: unknown): {
  total_usd: number;
  enrichment_usd: number;
  execution_usd: number;
  entry_count: number;
  ledger_version?: string;
  updated_at?: string;
} | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const entries = Array.isArray(o.entries) ? o.entries : [];
  return {
    total_usd: Number(o.total_usd) || 0,
    enrichment_usd: Number(o.enrichment_usd) || 0,
    execution_usd: Number(o.execution_usd) || 0,
    entry_count: entries.length,
    ledger_version: o.ledger_version != null ? String(o.ledger_version) : undefined,
    updated_at: o.updated_at != null ? String(o.updated_at) : undefined,
  };
}

/** Pull readiness.blockers (array) from readiness_json when present. */
function readinessBlockers(raw: unknown): string[] {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object') return [];
  const blockers = (parsed as { blockers?: unknown }).blockers;
  if (!Array.isArray(blockers)) return [];
  return blockers.map((b) => String(b)).filter(Boolean);
}

/**
 * Export transition_audit / stage_review / decision surfaces as JSON.
 * Scope: one record, or the whole list (capped by limit).
 * Canary operators use this instead of grepping SQLite.
 *
 * Decision-replay fields (fit_score, treatment_tier, readiness blockers,
 * stage_review and cost_ledger summary let operators reconstruct
 * the last treatment/priority/readiness decision without a second query.
 */
export function exportAuditLog(input: {
  db: any;
  recordId?: string;
  limit?: number;
}): {
  exported_at: string;
  count: number;
  records: Array<{
    record_id: string;
    business_name: string;
    transition_audit: unknown;
    stage_review: unknown;
    fit_score?: number | null;
    treatment_tier?: string;
    priority_lane?: string;
    priority_rank?: number | null;
    readiness_blockers?: string[];
    cost_ledger_summary?: {
      total_usd: number;
      enrichment_usd: number;
      execution_usd: number;
      entry_count: number;
      ledger_version?: string;
      updated_at?: string;
    } | null;
    account_sequence_state?: string;
    work_state?: string;
    lifecycle_stage?: string;
    next_action?: unknown;
    readiness?: unknown;
  }>;
} {
  const rid = String(input.recordId || '').trim();
  const limit = Math.max(1, Number(input.limit) || 500);

  let rows: Array<Record<string, unknown>> = [];
  try {
    if (rid) {
      const one = input.db.prepare(`
        SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1
      `).get(rid, rid) as Record<string, unknown> | undefined;
      rows = one ? [one] : [];
    } else {
      rows = input.db.prepare(`
        SELECT * FROM records
        WHERE COALESCE(transition_audit_json, '') != ''
           OR COALESCE(stage_review_json, '') != ''
        ORDER BY COALESCE(updated_at, _updated_at, created_at) DESC
        LIMIT ?
      `).all(limit) as Array<Record<string, unknown>>;
    }
  } catch {
    // Minimal column set for older schemas.
    try {
      if (rid) {
        const one = input.db.prepare(`
          SELECT _row_id, business_name, transition_audit_json, stage_review_json
          FROM records WHERE _row_id = ? LIMIT 1
        `).get(rid) as Record<string, unknown> | undefined;
        rows = one ? [one] : [];
      } else {
        rows = input.db.prepare(`
          SELECT _row_id, business_name, transition_audit_json, stage_review_json
          FROM records
          WHERE COALESCE(transition_audit_json, '') != ''
             OR COALESCE(stage_review_json, '') != ''
          LIMIT ?
        `).all(limit) as Array<Record<string, unknown>>;
      }
    } catch {
      rows = [];
    }
  }

  const records = rows.map((row) => {
    const recordId = String(row._row_id || row.id || '');
    const readiness = parseJson(row.readiness_json);
    const fitRaw = row.fit_score;
    const fit_score = fitRaw == null || fitRaw === ''
      ? null
      : (Number.isFinite(Number(fitRaw)) ? Number(fitRaw) : null);
    const rankRaw = row.priority_rank;
    const priority_rank = rankRaw == null || rankRaw === ''
      ? null
      : (Number.isFinite(Number(rankRaw)) ? Number(rankRaw) : null);

    return {
      record_id: recordId,
      business_name: String(row.business_name || ''),
      transition_audit: parseJson(row.transition_audit_json),
      stage_review: parseJson(row.stage_review_json),
      fit_score,
      treatment_tier: row.treatment_tier != null ? String(row.treatment_tier) : undefined,
      priority_lane: row.priority_lane != null ? String(row.priority_lane) : undefined,
      priority_rank,
      readiness_blockers: readinessBlockers(row.readiness_json),
      cost_ledger_summary: costLedgerSummary(row.cost_ledger_json),
      account_sequence_state: row.account_sequence_state != null
        ? String(row.account_sequence_state)
        : (row.sequence_status != null ? String(row.sequence_status) : undefined),
      work_state: row.work_state != null ? String(row.work_state) : undefined,
      lifecycle_stage: row.lifecycle_stage != null ? String(row.lifecycle_stage) : undefined,
      next_action: parseJson(row.next_action_json),
      readiness,
    };
  });

  return {
    exported_at: new Date().toISOString(),
    count: records.length,
    records,
  };
}

/** Commercial vs activity metrics separation. */
export function getCommercialMetrics(input: { db: any }) {
  const treatment = (() => {
    try {
      return input.db.prepare(`
        SELECT COALESCE(treatment_tier,'') AS tier, COUNT(*) AS n FROM records GROUP BY 1
      `).all();
    } catch {
      return [];
    }
  })();

  const hasDisposition = tableHasColumn(input.db, 'records', 'disposition_latest');
  const hasReplyClass =
    tableHasColumn(input.db, 'records', 'reply_classification_latest')
    || tableHasColumn(input.db, 'records', 'email_reply_classification');
  const hasMeetingBookedAt = tableHasColumn(input.db, 'records', 'meeting_booked_at');
  const hasLifecycle = tableHasColumn(input.db, 'records', 'lifecycle_stage');

  // Meetings: interactions kinds + disposition_latest + reply classification + lifecycle.
  const meetingsFromInteractions = safeCount(
    input.db,
    `SELECT COUNT(*) AS n FROM interactions
     WHERE COALESCE(deleted_at,'') = ''
       AND lower(kind) IN ('meeting','qualified_conversation','meeting_booked','booked_meeting')`,
  );

  const meetingsFromDisposition = hasDisposition
    ? safeCount(
      input.db,
      `SELECT COUNT(*) AS n FROM records
       WHERE lower(COALESCE(disposition_latest,'')) IN (
         'meeting_booked','booked_meeting','qualified_conversation','meeting'
       )`,
    )
    : 0;

  const meetingsFromReply = hasReplyClass
    ? safeCount(
      input.db,
      `SELECT COUNT(*) AS n FROM records
       WHERE lower(COALESCE(NULLIF(reply_classification_latest,''), email_reply_classification, ''))
             IN ('booking_intent','meeting_booked')`,
    )
    : 0;

  const meetingRecordClauses: string[] = [];
  if (hasDisposition) {
    meetingRecordClauses.push(`lower(COALESCE(disposition_latest,'')) IN (
      'meeting_booked','booked_meeting','qualified_conversation','meeting')`);
  }
  if (hasReplyClass) {
    meetingRecordClauses.push(`lower(COALESCE(NULLIF(reply_classification_latest,''), email_reply_classification, ''))
      IN ('booking_intent','meeting_booked')`);
  }
  if (hasLifecycle) {
    meetingRecordClauses.push(`lower(COALESCE(lifecycle_stage,'')) = 'meeting_booked'`);
  }
  if (hasMeetingBookedAt) {
    meetingRecordClauses.push(`COALESCE(meeting_booked_at,'') != ''`);
  }
  const meetingsFromRecords = meetingRecordClauses.length
    ? safeCount(input.db, `SELECT COUNT(*) AS n FROM records WHERE ${meetingRecordClauses.join(' OR ')}`)
    : 0;

  // Objections: interaction objections field + disposition/classification.
  const objectionsFromInteractions = safeCount(
    input.db,
    `SELECT COUNT(*) AS n FROM interactions
     WHERE COALESCE(deleted_at,'') = ''
       AND (
         lower(kind) = 'objection'
         OR COALESCE(objections,'') != ''
       )`,
  );

  const objectionsFromDisposition = hasDisposition
    ? safeCount(
      input.db,
      `SELECT COUNT(*) AS n FROM records
       WHERE lower(COALESCE(disposition_latest,'')) IN ('objection','callback_requested')`,
    )
    : 0;

  const objectionsFromReply = hasReplyClass
    ? safeCount(
      input.db,
      `SELECT COUNT(*) AS n FROM records
       WHERE lower(COALESCE(NULLIF(reply_classification_latest,''), email_reply_classification, ''))
             = 'objection'`,
    )
    : 0;

  const objectionRecordClauses: string[] = [];
  if (hasDisposition) {
    objectionRecordClauses.push(
      `lower(COALESCE(disposition_latest,'')) IN ('objection','callback_requested')`,
    );
  }
  if (hasReplyClass) {
    objectionRecordClauses.push(
      `lower(COALESCE(NULLIF(reply_classification_latest,''), email_reply_classification, '')) = 'objection'`,
    );
  }
  const objectionsFromRecords = objectionRecordClauses.length
    ? safeCount(input.db, `SELECT COUNT(*) AS n FROM records WHERE ${objectionRecordClauses.join(' OR ')}`)
    : 0;

  // Prefer record-side union when disposition/classification exist; fall back to interactions.
  const meetings = Math.max(meetingsFromInteractions, meetingsFromRecords);
  const objections = Math.max(objectionsFromInteractions, objectionsFromRecords);

  const replies = safeCount(
    input.db,
    `SELECT COUNT(*) AS n FROM records WHERE COALESCE(email_last_reply_at,'') != ''`,
  );
  const sends = safeCount(
    input.db,
    `SELECT COUNT(*) AS n FROM pipeline_events
     WHERE kind IN ('send_email','linkedin_connect') AND passed = 1`,
  );
  const channelSends = safeCount(
    input.db,
    `SELECT COUNT(*) AS n FROM channel_events
     WHERE lower(event_type) LIKE '%sent%'
        OR lower(COALESCE(action,'')) LIKE '%sent%'
        OR lower(event_type) IN ('email_sent','linkedin_connect_sent','sent')`,
  );
  const dq = safeCount(
    input.db,
    `SELECT COUNT(*) AS n FROM records WHERE COALESCE(disqualified_at,'') != ''`,
  );

  return {
    commercial: {
      meetings_or_qualified: Number(meetings),
      meetings_sources: {
        interactions: meetingsFromInteractions,
        disposition_latest: meetingsFromDisposition,
        reply_classification: meetingsFromReply,
        records_union: meetingsFromRecords,
      },
      objections: Number(objections),
      objections_sources: {
        interactions: objectionsFromInteractions,
        disposition_latest: objectionsFromDisposition,
        reply_classification: objectionsFromReply,
        records_union: objectionsFromRecords,
      },
      replies: Number(replies),
      disqualified: Number(dq),
      treatment_distribution: treatment,
    },
    activity: {
      sends_completed: Number(Math.max(sends, channelSends)),
      pipeline_sends: Number(sends),
      channel_sends: Number(channelSends),
      note: 'Activity volume is not commercial success',
    },
    generated_at: new Date().toISOString(),
  };
}
