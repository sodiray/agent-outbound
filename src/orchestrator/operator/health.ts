/**
 * Operator health checks: orphaned actions, missing successors, collisions,
 * impossible state, provider drift signals, Phase G portfolio checks.
 */

import { checkStateIntegrity, parseNextActionFromRecord } from '../policy/lifecycle.js';
import { parseAccountCampaignFromRecord } from '../policy/contact-campaign.js';
import { OUTBOUND_ACTION_TYPES } from '../policy/sequence-outbound.js';
import { isAffirmativeFlag } from '../policy/booleanish.js';

export type HealthIssue = {
  code: string;
  severity: 'error' | 'warning';
  record_id?: string;
  detail: string;
};

export type HealthReport = {
  ok: boolean;
  checked_at: string;
  sample_size: number;
  issues: HealthIssue[];
  counts: Record<string, number>;
};

/** Safe count — missing table/column returns 0. */
function safeCount(db: any, sql: string, params: unknown[] = []): number {
  try {
    const row = db.prepare(sql).get(...params);
    return Number(row?.n ?? 0) || 0;
  } catch {
    return 0;
  }
}

function safeAll(db: any, sql: string, params: unknown[] = []): any[] {
  try {
    return db.prepare(sql).all(...params) || [];
  } catch {
    return [];
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

export function runHealthChecks(input: {
  db: any;
  limit?: number;
}): HealthReport {
  const limit = Math.max(1, Number(input.limit) || 500);
  const issues: HealthIssue[] = [];
  const counts: Record<string, number> = {
    missing_next_action: 0,
    integrity_error: 0,
    orphaned_active: 0,
    collision: 0,
    visit_path: 0,
    impossible_treatment: 0,
    open_paused_review: 0,
    suppressed_active_sequence: 0,
    cost_events_without_ledger: 0,
    false_pipeline_health: 0,
    sourced_review_pileup: 0,
    tier_d_with_outbound_next_action: 0,
    in_play_disqualified_contradiction: 0,
  };

  // ----- Portfolio-level aggregate checks (not limited to sample) -----

  const hasAccountSeq = tableHasColumn(input.db, 'records', 'account_sequence_state');
  const hasCostLedger = tableHasColumn(input.db, 'records', 'cost_ledger_json');

  // Open paused_review queue (sequence + account_sequence_state when present).
  const pausedWhere = hasAccountSeq
    ? `(lower(COALESCE(account_sequence_state, '')) = 'paused_review'
        OR lower(COALESCE(sequence_status, '')) = 'paused_review')`
    : `lower(COALESCE(sequence_status, '')) = 'paused_review'`;
  const openPausedReview = safeCount(
    input.db,
    `SELECT COUNT(*) AS n FROM records WHERE ${pausedWhere}`,
  );
  counts.open_paused_review = openPausedReview;
  if (openPausedReview > 0) {
    const selectCols = hasAccountSeq
      ? `_row_id, business_name, account_sequence_state, sequence_status, work_state`
      : `_row_id, business_name, sequence_status, work_state`;
    const sample = safeAll(
      input.db,
      `SELECT ${selectCols}
       FROM records
       WHERE ${pausedWhere}
       ORDER BY updated_at DESC
       LIMIT 25`,
    );
    for (const r of sample) {
      issues.push({
        code: 'open_paused_review',
        severity: 'warning',
        record_id: String(r._row_id || ''),
        detail: `open stage review: seq=${r.account_sequence_state || r.sequence_status} work=${r.work_state || ''} (${r.business_name || ''})`,
      });
    }
    if (openPausedReview > sample.length) {
      issues.push({
        code: 'open_paused_review_count',
        severity: 'warning',
        detail: `${openPausedReview} records in paused_review (${sample.length} listed)`,
      });
    }
  }

  // Suppressed + active sequence_status inconsistency.
  const suppressedActive = safeAll(
    input.db,
    `SELECT _row_id, business_name, sequence_status, suppressed, suppressed_reason
     FROM records
     WHERE COALESCE(suppressed, 0) != 0
       AND lower(COALESCE(sequence_status,'')) = 'active'
     ORDER BY updated_at DESC
     LIMIT ?`,
    [Math.min(limit, 100)],
  );
  counts.suppressed_active_sequence = safeCount(
    input.db,
    `SELECT COUNT(*) AS n FROM records
     WHERE COALESCE(suppressed, 0) != 0
       AND lower(COALESCE(sequence_status,'')) = 'active'`,
  );
  for (const r of suppressedActive) {
    issues.push({
      code: 'suppressed_active_sequence',
      severity: 'error',
      record_id: String(r._row_id || ''),
      detail: `suppressed=1 but sequence_status=active (${r.business_name || ''}; reason=${r.suppressed_reason || ''})`,
    });
  }

  // cost_events rows without hydrated cost_ledger_json on the record.
  if (tableHasColumn(input.db, 'cost_events', 'record_id')) {
    if (!hasCostLedger) {
      const distinctWithCosts = safeCount(
        input.db,
        `SELECT COUNT(DISTINCT record_id) AS n FROM cost_events WHERE COALESCE(record_id,'') != ''`,
      );
      counts.cost_events_without_ledger = distinctWithCosts;
      if (distinctWithCosts > 0) {
        issues.push({
          code: 'cost_events_without_ledger',
          severity: 'warning',
          detail: `${distinctWithCosts} records have cost_events but records.cost_ledger_json column is missing (hydrate path unavailable)`,
        });
      }
    } else {
      const ledgerMissing = `(
        r._row_id IS NULL
        OR r.cost_ledger_json IS NULL
        OR TRIM(COALESCE(r.cost_ledger_json, '')) IN ('', '{}', 'null')
      )`;
      const costOrphans = safeAll(
        input.db,
        `SELECT ce.record_id AS record_id,
                COUNT(*) AS event_n,
                SUM(COALESCE(ce.usd_cost, 0)) AS total_usd,
                r.business_name AS business_name
         FROM cost_events ce
         LEFT JOIN records r ON r._row_id = ce.record_id
         WHERE COALESCE(ce.record_id, '') != ''
           AND ${ledgerMissing}
         GROUP BY ce.record_id
         ORDER BY event_n DESC
         LIMIT ?`,
        [Math.min(limit, 50)],
      );
      counts.cost_events_without_ledger = safeCount(
        input.db,
        `SELECT COUNT(DISTINCT ce.record_id) AS n
         FROM cost_events ce
         LEFT JOIN records r ON r._row_id = ce.record_id
         WHERE COALESCE(ce.record_id, '') != ''
           AND ${ledgerMissing}`,
      );
      for (const r of costOrphans) {
        issues.push({
          code: 'cost_events_without_ledger',
          severity: 'warning',
          record_id: String(r.record_id || ''),
          detail: `${r.event_n} cost_events (≈$${Number(r.total_usd || 0).toFixed(4)}) without cost_ledger_json hydrate (${r.business_name || r.record_id || ''})`,
        });
      }
    }
  }

  // ----- Portfolio health expansions (detection only) -----

  // false_pipeline_health: looks "active / in pipeline" but has no usable next_action
  // (or next_action is terminal wait with empty payload) — naive pipeline health is false.
  const hasNextActionJson = tableHasColumn(input.db, 'records', 'next_action_json');
  const hasNextActionDate = tableHasColumn(input.db, 'records', 'next_action_date');
  const hasWorkState = tableHasColumn(input.db, 'records', 'work_state');
  const emptyNextAction = hasNextActionJson
    ? `(
         COALESCE(next_action_json, '') = ''
         OR trim(COALESCE(next_action_json, '')) IN ('{}', 'null', '[]')
       )`
    : `1=0`;
  const staleNextDate = hasNextActionDate
    ? `(
         COALESCE(next_action_date, '') != ''
         AND datetime(next_action_date) < datetime('now', '-14 days')
       )`
    : `1=0`;
  const falseHealthWhere = `
     COALESCE(disqualified_at,'') = ''
       AND COALESCE(suppressed, 0) = 0
       AND (
         lower(COALESCE(sequence_status, '')) IN ('active', 'engaged')
         ${hasAccountSeq ? `OR lower(COALESCE(account_sequence_state, '')) = 'active'` : ''}
       )
       AND (${emptyNextAction} OR ${staleNextDate})
  `;
  const falseHealthRows = safeAll(
    input.db,
    `SELECT _row_id, business_name, sequence_status,
            ${hasAccountSeq ? 'account_sequence_state,' : ''}
            ${hasWorkState ? 'work_state,' : `'' AS work_state,`}
            ${hasNextActionJson ? 'next_action_json,' : `'' AS next_action_json,`}
            ${hasNextActionDate ? 'next_action_date' : `'' AS next_action_date`}
     FROM records
     WHERE ${falseHealthWhere}
     ORDER BY updated_at DESC
     LIMIT ?`,
    [Math.min(limit, 50)],
  );
  counts.false_pipeline_health = safeCount(
    input.db,
    `SELECT COUNT(*) AS n FROM records WHERE ${falseHealthWhere}`,
  );
  for (const r of falseHealthRows) {
    issues.push({
      code: 'false_pipeline_health',
      severity: 'warning',
      record_id: String(r._row_id || ''),
      detail: `active sequence without usable next_action (${r.business_name || ''}; next_action_date=${r.next_action_date || '∅'})`,
    });
  }

  // sourced_review_pileup: many records parked on sourced_review (or similarly named) review step.
  const SOURCED_REVIEW_PILEUP_THRESHOLD = 25;
  const sourcedReviewCount = safeCount(
    input.db,
    `SELECT COUNT(DISTINCT e.record_id) AS n
     FROM pipeline_events e
     JOIN records r ON r._row_id = e.record_id
     WHERE e.kind = 'review'
       AND e.passed = 0
       AND e.reason = 'awaiting_review'
       AND (
         lower(COALESCE(e.step_id, '')) LIKE '%sourced_review%'
         OR lower(COALESCE(e.step_id, '')) = 'sourced_review'
         OR lower(COALESCE(e.step_id, '')) LIKE 'sourced%'
       )
       AND COALESCE(r.disqualified_at, '') = ''
       AND lower(trim(CAST(COALESCE(r.suppressed, 0) AS TEXT))) IN ('', '0', 'false', 'no', 'off')
       AND NOT EXISTS (
         SELECT 1 FROM pipeline_events done
         WHERE done.record_id = e.record_id
           AND done.step_id = e.step_id
           AND done.kind = 'review'
           AND done.passed = 1
           AND done.occurred_at > e.occurred_at
       )`,
  );
  counts.sourced_review_pileup = sourcedReviewCount;
  if (sourcedReviewCount >= SOURCED_REVIEW_PILEUP_THRESHOLD) {
    issues.push({
      code: 'sourced_review_pileup',
      severity: 'warning',
      detail: `${sourcedReviewCount} records awaiting sourced_review (threshold ${SOURCED_REVIEW_PILEUP_THRESHOLD})`,
    });
  } else if (sourcedReviewCount > 0) {
    // Still report sample for visibility when non-zero but under threshold.
    const sample = safeAll(
      input.db,
      `SELECT DISTINCT e.record_id AS record_id, r.business_name AS business_name, e.step_id AS step_id
       FROM pipeline_events e
       JOIN records r ON r._row_id = e.record_id
       WHERE e.kind = 'review'
         AND e.passed = 0
         AND e.reason = 'awaiting_review'
         AND lower(COALESCE(e.step_id, '')) LIKE '%sourced%'
         AND COALESCE(r.disqualified_at, '') = ''
       LIMIT 10`,
    );
    for (const r of sample) {
      issues.push({
        code: 'sourced_review_pending',
        severity: 'warning',
        record_id: String(r.record_id || ''),
        detail: `awaiting ${r.step_id || 'sourced_review'} (${r.business_name || ''})`,
      });
    }
  }

  // tier_d_with_outbound_next_action: Tier D (recycle/monitor) must not hold outbound next_action.
  if (tableHasColumn(input.db, 'records', 'treatment_tier')
    && tableHasColumn(input.db, 'records', 'next_action_json')) {
    const tierDRows = safeAll(
      input.db,
      `SELECT _row_id, business_name, treatment_tier, next_action_json
       FROM records
       WHERE upper(COALESCE(treatment_tier, '')) = 'D'
         AND COALESCE(next_action_json, '') != ''
         AND COALESCE(disqualified_at, '') = ''
       ORDER BY updated_at DESC
       LIMIT ?`,
      [Math.min(limit, 100)],
    );
    for (const r of tierDRows) {
      let actionType = '';
      try {
        const na = typeof r.next_action_json === 'string'
          ? JSON.parse(r.next_action_json)
          : r.next_action_json;
        actionType = String(na?.action_type || '').trim().toLowerCase();
      } catch {
        const m = String(r.next_action_json || '').match(/"action_type"\s*:\s*"([^"]+)"/i);
        actionType = m ? m[1].toLowerCase() : '';
      }
      if (!actionType || !OUTBOUND_ACTION_TYPES.has(actionType)) continue;
      counts.tier_d_with_outbound_next_action += 1;
      issues.push({
        code: 'tier_d_with_outbound_next_action',
        severity: 'error',
        record_id: String(r._row_id || ''),
        detail: `treatment_tier=D with outbound next_action=${actionType} (${r.business_name || ''})`,
      });
    }
  }

  // in_play + disqualified contradiction: disqualified_at set (or lifecycle disqualified)
  // while still treated as active/in-play sequence.
  {
    const hasLifecycle = tableHasColumn(input.db, 'records', 'lifecycle_stage');
    const dqClauses = [`COALESCE(disqualified_at, '') != ''`];
    if (hasLifecycle) {
      dqClauses.push(`lower(COALESCE(lifecycle_stage, '')) = 'disqualified'`);
    }
    const inPlayActive = `
      (
        lower(COALESCE(sequence_status, '')) IN ('active', 'engaged', 'idle')
        ${hasAccountSeq ? `OR lower(COALESCE(account_sequence_state, '')) IN ('active', 'paused_review', 'paused_inbound', 'waiting')` : ''}
      )
    `;
    const contraWhere = `(${dqClauses.join(' OR ')}) AND ${inPlayActive}`;
    const contraRows = safeAll(
      input.db,
      `SELECT _row_id, business_name, sequence_status, disqualified_at,
              ${hasAccountSeq ? 'account_sequence_state,' : ''}
              ${hasLifecycle ? 'lifecycle_stage,' : ''}
              suppressed
       FROM records
       WHERE ${contraWhere}
       ORDER BY updated_at DESC
       LIMIT ?`,
      [Math.min(limit, 50)],
    );
    counts.in_play_disqualified_contradiction = safeCount(
      input.db,
      `SELECT COUNT(*) AS n FROM records WHERE ${contraWhere}`,
    );
    for (const r of contraRows) {
      issues.push({
        code: 'in_play_disqualified_contradiction',
        severity: 'error',
        record_id: String(r._row_id || ''),
        detail: `disqualified but still in-play (seq=${r.account_sequence_state || r.sequence_status || ''}; dq=${r.disqualified_at || r.lifecycle_stage || ''}; ${r.business_name || ''})`,
      });
    }
  }

  // ----- Per-record sample integrity (existing checks) -----
  const rows = input.db.prepare(`
    SELECT * FROM records
    WHERE COALESCE(disqualified_at,'') = '' AND COALESCE(suppressed,0) = 0
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit);

  for (const row of rows) {
    const rid = String(row._row_id || row.id || '');
    const nextRaw = row.next_action_json;
    if (!nextRaw) {
      counts.missing_next_action += 1;
      issues.push({
        code: 'missing_next_action',
        severity: 'error',
        record_id: rid,
        detail: 'Active record has no next_action_json',
      });
    }

    try {
      const next = parseNextActionFromRecord(row);
      const integrity = checkStateIntegrity({
        lifecycle_stage: String(row.lifecycle_stage || 'cold') as any,
        sequence_state: String(row.account_sequence_state || row.sequence_status || 'not_started') as any,
        work_state: String(row.work_state || 'idle') as any,
        next_action: next as any,
        suppressed: isAffirmativeFlag(row.suppressed, { failClosed: true }),
        treatment_tier: String(row.treatment_tier || ''),
        active_contact_id: String(row.active_contact_id || '') || null,
      });
      for (const i of integrity.filter((x) => x.severity === 'error')) {
        counts.integrity_error += 1;
        issues.push({
          code: i.code,
          severity: 'error',
          record_id: rid,
          detail: i.message || i.code,
        });
      }
    } catch {
      /* parse failures counted via missing */
    }

    if (String(row.sequence_status) === 'active' && !nextRaw) {
      counts.orphaned_active += 1;
      issues.push({
        code: 'orphaned_active_sequence',
        severity: 'error',
        record_id: rid,
        detail: 'sequence_status=active without next_action',
      });
    }

    if (row.channel_or_contact_collision || row.collision_json) {
      try {
        const c = typeof row.collision_json === 'string' ? JSON.parse(row.collision_json) : row.collision_json;
        if (c?.collision || row.channel_or_contact_collision) {
          counts.collision += 1;
          issues.push({
            code: 'collision',
            severity: 'warning',
            record_id: rid,
            detail: JSON.stringify(c?.reasons || ['flagged']),
          });
        }
      } catch {
        /* ignore */
      }
    }

    const na = String(nextRaw || '').toLowerCase();
    if (na.includes('visit') || na.includes('field_visit') || na.includes('door')) {
      counts.visit_path += 1;
      issues.push({
        code: 'legacy_visit_path',
        severity: 'error',
        record_id: rid,
        detail: 'next_action references visit/door work',
      });
    }

    const tier = String(row.treatment_tier || '');
    if (tier && !['A', 'B', 'C', 'D', 'enrichment_hold'].includes(tier)) {
      counts.impossible_treatment += 1;
      issues.push({
        code: 'impossible_treatment_tier',
        severity: 'error',
        record_id: rid,
        detail: `Unknown treatment_tier=${tier}`,
      });
    }

    // Duplicate active contact target check via campaign plan.
    const plan = parseAccountCampaignFromRecord(row);
    if (plan?.active_contact_id && plan.held_contact_ids?.includes(plan.active_contact_id)) {
      issues.push({
        code: 'active_also_held',
        severity: 'error',
        record_id: rid,
        detail: 'active_contact_id also in held queue',
      });
    }
  }

  // Cap issues list for operator readability.
  const capped = issues.slice(0, 200);
  return {
    ok: capped.filter((i) => i.severity === 'error').length === 0,
    checked_at: new Date().toISOString(),
    sample_size: rows.length,
    issues: capped,
    counts,
  };
}
