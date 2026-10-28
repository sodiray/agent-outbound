import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readConfig } from '../orchestrator/lib/config.js';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';
import { openListDb } from '../orchestrator/runtime/db.js';
import { getMcpClient } from '../orchestrator/runtime/mcp.js';
import { listExternalEvents } from '../orchestrator/runtime/external-events.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';
import { runDeliveryPoll, runImapInboundPoll } from '../orchestrator/runtime/polling.js';

type Priority = 'urgent' | 'high' | 'normal' | 'low';
type PendingStatus = 'open' | 'claimed' | 'snoozed' | 'resolved' | 'dismissed';

type PendingRule = {
  id: string;
  observation?: string;
  kind: string;
  priority: Priority;
  after?: string;
};

type NotificationSink = {
  type: 'webhook' | 'command' | 'stdout' | 'file';
  url?: string;
  command?: string;
  args?: string[];
  path?: string;
};

type NotificationRoute = {
  events: string[];
  sink: string;
  coalesce_for?: string;
};

type OperationsConfig = {
  instructions?: string;
  objectives?: {
    primary?: string;
    secondary?: string[];
  };
  observations?: Array<{
    id: string;
    source: string;
    when?: Record<string, unknown>;
  }>;
  pending?: {
    rules?: PendingRule[];
  };
  notifications?: {
    coalesce_for?: string;
    notify_on?: string[];
    sinks?: Record<string, NotificationSink>;
    routes?: NotificationRoute[];
  };
  monitor?: {
    interval_seconds?: number;
  };
};

type Candidate = {
  dedupeKey: string;
  ruleId: string;
  kind: string;
  priority: Priority;
  subjectType: string;
  subjectId: string;
  summary: string;
  context: Record<string, unknown>;
  sourceState: Record<string, unknown>;
};

type PendingRow = Record<string, unknown>;

type PendingChanges = {
  pending_created: string[];
  pending_priority_changed: string[];
  review_requested: string[];
  pipeline_blocked: string[];
};

const PRIORITY_ORDER: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const asString = (value: unknown): string => String(value ?? '').trim();

const asStringArray = (value: unknown): string[] => asArray(value)
  .map(asString)
  .filter(Boolean);

const parseJsonObject = (value: unknown): Record<string, unknown> => {
  try {
    return asRecord(JSON.parse(asString(value) || '{}'));
  } catch {
    return {};
  }
};

const parseJsonValue = (value: string, label: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: `${label} must be valid JSON.`,
    });
  }
};

const nowIso = (): string => new Date().toISOString();

const stableId = (prefix: string, value: string): string => (
  `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 20)}`
);

const recordPendingEvent = ({
  db,
  pendingId,
  action,
  actor = '',
  reason = '',
  details = {},
  idempotencyKey = '',
  occurredAt = nowIso(),
}: {
  db: ReturnType<typeof openListDb>;
  pendingId: string;
  action: string;
  actor?: string;
  reason?: string;
  details?: Record<string, unknown>;
  idempotencyKey?: string;
  occurredAt?: string;
}): void => {
  const eventId = stableId(
    'pending_event',
    `${pendingId}:${action}:${idempotencyKey || occurredAt}`,
  );
  db.prepare(`
    INSERT OR IGNORE INTO pending_item_events (
      event_id, pending_id, action, actor, reason, details_json,
      idempotency_key, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    pendingId,
    action,
    actor,
    reason,
    JSON.stringify(details),
    idempotencyKey,
    occurredAt,
  );
};

const operationsConfig = (config: unknown): OperationsConfig => (
  asRecord(asRecord(config).operations) as OperationsConfig
);

const configuredRules = (config: unknown): PendingRule[] => {
  const pending = asRecord(operationsConfig(config).pending);
  return asArray(pending.rules)
    .map((value) => {
      const rule = asRecord(value);
      const id = asString(rule.id || rule.observation);
      const kind = asString(rule.kind || id);
      const rawPriority = asString(rule.priority || 'normal') as Priority;
      const priority = Object.hasOwn(PRIORITY_ORDER, rawPriority) ? rawPriority : 'normal';
      return {
        id,
        observation: asString(rule.observation) || undefined,
        kind,
        priority,
        after: asString(rule.after) || undefined,
      };
    })
    .filter((rule) => rule.id && rule.kind);
};

const durationDays = (value: string | undefined, fallback = 7): number => {
  const match = /^(\d+)\s*d$/i.exec(asString(value));
  if (!match) return fallback;
  return Math.max(1, Number(match[1]));
};

const durationMilliseconds = (
  value: string | undefined,
  fallback = 0,
): number => {
  const match = /^(\d+)\s*(ms|s|m|h)$/i.exec(asString(value));
  if (!match) return fallback;
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === 'ms'
    ? 1
    : unit === 's'
      ? 1_000
      : unit === 'm'
        ? 60_000
        : 3_600_000;
  return amount * multiplier;
};

const rowRecord = (row: unknown): Record<string, unknown> => asRecord(row);

const replyCandidates = (
  db: ReturnType<typeof openListDb>,
  rule: PendingRule,
): Candidate[] => {
  const rows = db.prepare(`
    SELECT ce.event_id, ce.row_id, ce.disposition, ce.occurred_at,
      r.business_name, r.pipeline_name, r.sequence_name, r.sequence_status
    FROM channel_events ce
    JOIN records r ON r._row_id = ce.row_id
    WHERE ce.action = 'reply_detected' OR ce.event_type = 'reply_detected'
    ORDER BY ce.occurred_at ASC
  `).all() as unknown[];
  return rows.map(rowRecord).map((row) => ({
    dedupeKey: `${rule.id}:${asString(row.event_id)}`,
    ruleId: rule.id,
    kind: rule.kind,
    priority: rule.priority,
    subjectType: 'prospect',
    subjectId: asString(row.row_id),
    summary: `${asString(row.business_name) || asString(row.row_id)} replied (${asString(row.disposition) || 'unclassified'})`,
    context: {
      prospect_id: asString(row.row_id),
      event_id: asString(row.event_id),
      disposition: asString(row.disposition),
      occurred_at: asString(row.occurred_at),
    },
    sourceState: row,
  }));
};

const followupCandidates = (
  db: ReturnType<typeof openListDb>,
  rule: PendingRule,
): Candidate[] => {
  const rows = db.prepare(`
    SELECT i.interaction_id, i.record_id, i.kind, i.summary, i.follow_up_at,
      r.business_name, r.pipeline_name, r.sequence_name
    FROM interactions i
    JOIN records r ON r._row_id = i.record_id
    WHERE trim(i.follow_up_at) != ''
      AND datetime(i.follow_up_at) <= datetime('now')
      AND trim(i.follow_up_done_at) = ''
      AND trim(i.deleted_at) = ''
    ORDER BY datetime(i.follow_up_at) ASC
  `).all() as unknown[];
  return rows.map(rowRecord).map((row) => ({
    dedupeKey: `${rule.id}:${asString(row.interaction_id)}`,
    ruleId: rule.id,
    kind: rule.kind,
    priority: rule.priority,
    subjectType: 'interaction',
    subjectId: asString(row.interaction_id),
    summary: `Follow up with ${asString(row.business_name) || asString(row.record_id)}: ${asString(row.summary)}`,
    context: {
      prospect_id: asString(row.record_id),
      interaction_id: asString(row.interaction_id),
      due_at: asString(row.follow_up_at),
    },
    sourceState: row,
  }));
};

const reviewCandidates = (
  db: ReturnType<typeof openListDb>,
  rule: PendingRule,
): Candidate[] => {
  const recordRows = db.prepare(`
    SELECT _row_id, business_name, pipeline_name, sequence_name,
      review_reason, review_flagged_at
    FROM records
    WHERE needs_review = 1
    ORDER BY datetime(review_flagged_at) ASC
  `).all() as unknown[];
  const draftRows = db.prepare(`
    SELECT d.draft_id, d.row_id, d.step_id, d.created_at, r.business_name
    FROM drafts d
    JOIN records r ON r._row_id = d.row_id
    WHERE d.status = 'pending_approval'
    ORDER BY datetime(d.created_at) ASC
  `).all() as unknown[];
  const records = recordRows.map(rowRecord).map((row) => ({
    dedupeKey: `${rule.id}:record:${asString(row._row_id)}`,
    ruleId: rule.id,
    kind: rule.kind,
    priority: rule.priority,
    subjectType: 'prospect',
    subjectId: asString(row._row_id),
    summary: `${asString(row.business_name) || asString(row._row_id)} requires review: ${asString(row.review_reason) || 'pipeline review'}`,
    context: {
      prospect_id: asString(row._row_id),
      review_reason: asString(row.review_reason),
    },
    sourceState: row,
  }));
  const drafts = draftRows.map(rowRecord).map((row) => ({
    dedupeKey: `${rule.id}:draft:${asString(row.draft_id)}`,
    ruleId: rule.id,
    kind: rule.kind,
    priority: rule.priority,
    subjectType: 'draft',
    subjectId: asString(row.draft_id),
    summary: `Draft for ${asString(row.business_name) || asString(row.row_id)} requires approval`,
    context: {
      prospect_id: asString(row.row_id),
      draft_id: asString(row.draft_id),
      step_id: asString(row.step_id),
    },
    sourceState: row,
  }));
  return [...records, ...drafts];
};

const routingCandidates = (
  db: ReturnType<typeof openListDb>,
  rule: PendingRule,
): Candidate[] => {
  const rows = db.prepare(`
    SELECT _row_id, business_name, pipeline_name, sequence_name,
      fit_score, priority_rank, created_at
    FROM records
    WHERE pipeline_name = 'unrouted'
      AND trim(disqualified_at) = ''
      AND suppressed = 0
    ORDER BY priority_rank DESC, fit_score DESC
  `).all() as unknown[];
  return rows.map(rowRecord).map((row) => ({
    dedupeKey: `${rule.id}:${asString(row._row_id)}`,
    ruleId: rule.id,
    kind: rule.kind,
    priority: rule.priority,
    subjectType: 'prospect',
    subjectId: asString(row._row_id),
    summary: `${asString(row.business_name) || asString(row._row_id)} is qualified but unrouted`,
    context: {
      prospect_id: asString(row._row_id),
      fit_score: Number(row.fit_score || 0),
      priority_rank: Number(row.priority_rank || 0),
    },
    sourceState: row,
  }));
};

const staleCandidates = (
  db: ReturnType<typeof openListDb>,
  rule: PendingRule,
): Candidate[] => {
  const days = durationDays(rule.after);
  const rows = db.prepare(`
    SELECT _row_id, business_name, pipeline_name, sequence_name,
      sequence_status, next_action_date, last_outreach_at, updated_at
    FROM records
    WHERE trim(disqualified_at) = ''
      AND suppressed = 0
      AND sequence_status IN ('active', 'engaged', 'idle')
      AND (
        (trim(next_action_date) = '' AND datetime(COALESCE(NULLIF(last_outreach_at, ''), updated_at)) <= datetime('now', ?))
        OR (trim(next_action_date) != '' AND datetime(next_action_date) < datetime('now', ?))
      )
    ORDER BY datetime(COALESCE(NULLIF(next_action_date, ''), NULLIF(last_outreach_at, ''), updated_at)) ASC
  `).all(`-${days} days`, `-${days} days`) as unknown[];
  return rows.map(rowRecord).map((row) => ({
    dedupeKey: `${rule.id}:${asString(row._row_id)}`,
    ruleId: rule.id,
    kind: rule.kind,
    priority: rule.priority,
    subjectType: 'prospect',
    subjectId: asString(row._row_id),
    summary: `${asString(row.business_name) || asString(row._row_id)} has no current next action`,
    context: {
      prospect_id: asString(row._row_id),
      pipeline: asString(row.pipeline_name),
      sequence: asString(row.sequence_name),
      sequence_status: asString(row.sequence_status),
      next_action_date: asString(row.next_action_date),
    },
    sourceState: row,
  }));
};

const errorCandidates = (
  db: ReturnType<typeof openListDb>,
  rule: PendingRule,
): Candidate[] => {
  const runRows = db.prepare(`
    SELECT run_id, phase, active_step, message, error, updated_at
    FROM run_state current_run
    WHERE status = 'error'
      AND NOT EXISTS (
        SELECT 1
        FROM run_state newer_run
        WHERE newer_run.phase = current_run.phase
          AND datetime(newer_run.updated_at) > datetime(current_run.updated_at)
      )
    ORDER BY datetime(updated_at) DESC
  `).all() as unknown[];
  const monitorRows = db.prepare(`
    SELECT phase, last_attempted_at, last_succeeded_at, last_error
    FROM operator_monitor_state
    WHERE trim(last_error) != ''
    ORDER BY datetime(last_attempted_at) DESC
  `).all() as unknown[];
  const runs = runRows.map(rowRecord).map((row) => ({
    dedupeKey: `${rule.id}:${asString(row.run_id)}`,
    ruleId: rule.id,
    kind: rule.kind,
    priority: rule.priority,
    subjectType: 'run',
    subjectId: asString(row.run_id),
    summary: `Pipeline run failed in ${asString(row.phase) || 'unknown phase'}: ${asString(row.error) || asString(row.message)}`,
    context: {
      run_id: asString(row.run_id),
      phase: asString(row.phase),
      active_step: asString(row.active_step),
    },
    sourceState: row,
  }));
  const monitorPhases = monitorRows.map(rowRecord).map((row) => ({
    dedupeKey: `${rule.id}:monitor:${asString(row.phase)}`,
    ruleId: rule.id,
    kind: rule.kind,
    priority: rule.priority,
    subjectType: 'monitor_phase',
    subjectId: asString(row.phase),
    summary: `Provider ${asString(row.phase)} polling is blocked: ${asString(row.last_error)}`,
    context: {
      phase: asString(row.phase),
      last_attempted_at: asString(row.last_attempted_at),
      last_succeeded_at: asString(row.last_succeeded_at),
    },
    sourceState: row,
  }));
  return [...runs, ...monitorPhases];
};

const candidatesForSelector = (
  db: ReturnType<typeof openListDb>,
  rule: PendingRule,
  selectorValue = '',
): Candidate[] => {
  const selector = `${rule.id} ${rule.observation || ''} ${rule.kind} ${selectorValue}`.toLowerCase();
  if (selector.includes('external_event')) return listExternalEvents(db).filter((row: Record<string, unknown>) => ['unmatched','ambiguous'].includes(asString(row.status))).map((row: Record<string, unknown>) => ({
    dedupeKey: `${rule.id}:${asString(row.source)}:${asString(row.event_id)}`, ruleId: rule.id, kind: rule.kind, priority: rule.priority,
    subjectType: 'external_event', subjectId: asString(row.event_id), summary: `External event requires review: ${asString(row.status)}`,
    context: row, sourceState: row,
  }));
  if (
    selector.includes('reply')
    || selector.includes('reply_detected')
    || selector.includes('"direction":"inbound"')
  ) return replyCandidates(db, rule);
  if (
    selector.includes('followup')
    || selector.includes('follow_up')
    || selector.includes('"follow_up":"overdue"')
  ) return followupCandidates(db, rule);
  if (
    selector.includes('review')
    || selector.includes('"review":"required"')
  ) return reviewCandidates(db, rule);
  if (selector.includes('unrouted') || selector.includes('routing')) return routingCandidates(db, rule);
  if (selector.includes('stale') || selector.includes('pipeline_health')) return staleCandidates(db, rule);
  if (selector.includes('error') || selector.includes('blocked')) return errorCandidates(db, rule);
  return [];
};

const configuredObservations = (config: unknown) => (
  asArray(operationsConfig(config).observations)
    .map((value) => {
      const observation = asRecord(value);
      return {
        id: asString(observation.id),
        source: asString(observation.source),
        when: asRecord(observation.when),
      };
    })
    .filter((observation) => observation.id && observation.source)
);

const deriveObservations = (
  db: ReturnType<typeof openListDb>,
  config: unknown,
): Candidate[] => {
  const observations = configuredObservations(config);
  if (observations.length === 0) {
    return configuredRules(config).flatMap((rule) => candidatesForSelector(db, rule));
  }
  return observations.flatMap((observation) => {
    const observationRule: PendingRule = {
      id: observation.id,
      kind: observation.id,
      priority: 'normal',
      after: asString(observation.when.next_action_missing_for) || undefined,
    };
    return candidatesForSelector(
      db,
      observationRule,
      `${observation.source} ${JSON.stringify(observation.when)}`,
    );
  });
};

const derivePendingCandidates = (
  db: ReturnType<typeof openListDb>,
  config: unknown,
  observations: Candidate[],
): Candidate[] => configuredRules(config).flatMap((rule) => {
  if (!rule.observation) return candidatesForSelector(db, rule);
  return observations
    .filter((observation) => observation.ruleId === rule.observation)
    .map((observation) => ({
      ...observation,
      dedupeKey: `${rule.id}:${rule.kind}:${observation.dedupeKey}`,
      ruleId: rule.id,
      kind: rule.kind,
      priority: rule.priority,
    }));
});

const reconcilePending = ({ listDir }: { listDir: string }) => {
  const configResult = readConfig(listDir);
  if (configResult.errors.length > 0) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: `Cannot reconcile pending work because outbound.yaml is invalid: ${configResult.errors.join('; ')}`,
      hint: 'Run agent-outbound config validate for details.',
    });
  }
  const db = openListDb({ listDir, readonly: false });
  try {
    const project = basename(listDir);
    const observedAt = nowIso();
    const observations = deriveObservations(db, configResult.config);
    const candidates = derivePendingCandidates(db, configResult.config, observations);
    const activeObservationKeys = new Set(observations.map((observation) => observation.dedupeKey));
    const activeKeys = new Set(candidates.map((candidate) => candidate.dedupeKey));
    const changes: PendingChanges = {
      pending_created: [],
      pending_priority_changed: [],
      review_requested: [],
      pipeline_blocked: [],
    };
    const upsertObservation = db.prepare(`
      INSERT INTO observations (
        observation_id, dedupe_key, project, rule_id, kind, subject_type,
        subject_id, summary, payload_json, active, first_observed_at,
        last_observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        summary = excluded.summary,
        payload_json = excluded.payload_json,
        active = 1,
        last_observed_at = excluded.last_observed_at
    `);
    const existingByKey = db.prepare(`
      SELECT pending_id, status, kind, priority, created_at
      FROM pending_items
      WHERE dedupe_key = ?
    `);
    const upsertPending = db.prepare(`
      INSERT INTO pending_items (
        pending_id, dedupe_key, project, rule_id, kind, priority, status,
        subject_type, subject_id, summary, context_json, source_state_json,
        observed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        kind = excluded.kind,
        priority = excluded.priority,
        summary = excluded.summary,
        context_json = excluded.context_json,
        source_state_json = excluded.source_state_json,
        observed_at = excluded.observed_at,
        updated_at = excluded.updated_at
    `);
    for (const observation of observations) {
      const observationId = stableId('obs', `${project}:${observation.dedupeKey}`);
      upsertObservation.run(
        observationId,
        observation.dedupeKey,
        project,
        observation.ruleId,
        observation.kind,
        observation.subjectType,
        observation.subjectId,
        observation.summary,
        JSON.stringify(observation.sourceState),
        observedAt,
        observedAt,
      );
    }
    for (const candidate of candidates) {
      const existing = rowRecord(existingByKey.get(candidate.dedupeKey));
      const pendingId = asString(existing.pending_id) || stableId('pending', `${project}:${candidate.dedupeKey}`);
      if (!existing.pending_id) {
        changes.pending_created.push(pendingId);
        if (candidate.kind.includes('review')) changes.review_requested.push(pendingId);
        if (
          candidate.kind.includes('blocked')
          || candidate.kind.includes('error')
        ) {
          changes.pipeline_blocked.push(pendingId);
        }
      }
      if (
        existing.pending_id
        && ['open', 'claimed', 'snoozed'].includes(asString(existing.status))
        && asString(existing.priority)
        && asString(existing.priority) !== candidate.priority
      ) {
        changes.pending_priority_changed.push(pendingId);
      }
      upsertPending.run(
        pendingId,
        candidate.dedupeKey,
        project,
        candidate.ruleId,
        candidate.kind,
        candidate.priority,
        candidate.subjectType,
        candidate.subjectId,
        candidate.summary,
        JSON.stringify(candidate.context),
        JSON.stringify(candidate.sourceState),
        observedAt,
        observedAt,
        observedAt,
      );
      if (!existing.pending_id) {
        recordPendingEvent({
          db,
          pendingId,
          action: 'created',
          details: {
            kind: candidate.kind,
            priority: candidate.priority,
            subject_type: candidate.subjectType,
            subject_id: candidate.subjectId,
          },
          occurredAt: observedAt,
        });
      } else {
        const hasHistory = Boolean(db.prepare(`
          SELECT 1 FROM pending_item_events
          WHERE pending_id = ?
          LIMIT 1
        `).get(pendingId));
        if (!hasHistory) {
          recordPendingEvent({
            db,
            pendingId,
            action: 'created',
            actor: 'agent-outbound',
            reason: 'history_initialized',
            details: {
              kind: asString(existing.kind),
              priority: asString(existing.priority),
            },
            occurredAt: asString(existing.created_at) || observedAt,
          });
        }
      }
      if (
        existing.pending_id
        && ['open', 'claimed', 'snoozed'].includes(asString(existing.status))
        && asString(existing.priority)
        && asString(existing.priority) !== candidate.priority
      ) {
        recordPendingEvent({
          db,
          pendingId,
          action: 'priority_changed',
          details: {
            from: asString(existing.priority),
            to: candidate.priority,
          },
          occurredAt: observedAt,
        });
      }
    }

    const activeRows = db.prepare(`
      SELECT pending_id, dedupe_key FROM pending_items
      WHERE status IN ('open', 'claimed', 'snoozed')
    `).all() as unknown[];
    const clearedIds = activeRows
      .map(rowRecord)
      .filter((row) => !activeKeys.has(asString(row.dedupe_key)))
      .map((row) => asString(row.pending_id));
    const clearPending = db.prepare(`
      UPDATE pending_items SET status = 'resolved',
        resolution_reason = 'source_condition_cleared',
        resolution_evidence_json = '{"automatic":true}',
        resolved_at = ?, updated_at = ?
      WHERE pending_id = ?
    `);
    for (const pendingId of clearedIds) {
      clearPending.run(observedAt, observedAt, pendingId);
      recordPendingEvent({
        db,
        pendingId,
        action: 'resolved',
        actor: 'agent-outbound',
        reason: 'source_condition_cleared',
        details: { automatic: true },
        occurredAt: observedAt,
      });
    }
    const observedRows = db.prepare(`
      SELECT observation_id, dedupe_key FROM observations WHERE active = 1
    `).all() as unknown[];
    const deactivateObservation = db.prepare(`
      UPDATE observations SET active = 0, last_observed_at = ?
      WHERE observation_id = ?
    `);
    for (const row of observedRows.map(rowRecord)) {
      if (activeObservationKeys.has(asString(row.dedupe_key))) continue;
      deactivateObservation.run(observedAt, asString(row.observation_id));
    }
    const awakenedSnoozes = db.prepare(`
      SELECT pending_id FROM pending_items
      WHERE status = 'snoozed'
        AND trim(snoozed_until) != ''
        AND datetime(snoozed_until) <= datetime('now')
    `).all().map(rowRecord).map((row) => asString(row.pending_id));
    db.prepare(`
      UPDATE pending_items SET status = 'open', snoozed_until = '',
        updated_at = ?
      WHERE status = 'snoozed'
        AND trim(snoozed_until) != ''
        AND datetime(snoozed_until) <= datetime('now')
    `).run(observedAt);
    for (const pendingId of awakenedSnoozes) {
      recordPendingEvent({
        db,
        pendingId,
        action: 'snooze_elapsed',
        actor: 'agent-outbound',
        occurredAt: observedAt,
      });
    }
    return {
      project,
      config: configResult.config,
      changes,
      clearedIds,
      observed: observations.length,
    };
  } finally {
    db.close();
  }
};

const hydratePending = (row: PendingRow): PendingRow => ({
  ...row,
  context: parseJsonObject(row.context_json),
  source_state: parseJsonObject(row.source_state_json),
  resolution_evidence: parseJsonObject(row.resolution_evidence_json),
  context_json: undefined,
  source_state_json: undefined,
  resolution_evidence_json: undefined,
});

const discoverListDirs = (root = process.cwd()): string[] => {
  if (existsSync(join(root, 'outbound.yaml'))) return [resolve(root)];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((path) => existsSync(join(path, 'outbound.yaml')));
};

const resolveTargets = ({ list = '', allLists = false }: { list?: string; allLists?: boolean }): string[] => {
  if (allLists) return discoverListDirs();
  if (list) return [resolveListDir(list)];
  const discovered = discoverListDirs();
  if (discovered.length === 1) return discovered;
  throw new AgentOutboundError({
    code: 'INVALID_ARGUMENT',
    message: 'Specify --list LIST or --all-lists.',
    hint: 'Run from a list directory or pass an explicit project path.',
  });
};

const monitorPhaseDue = ({
  db,
  phase,
  intervalMinutes,
}: {
  db: ReturnType<typeof openListDb>;
  phase: 'replies' | 'delivery';
  intervalMinutes: number;
}): boolean => {
  const row = rowRecord(db.prepare(`
    SELECT last_attempted_at
    FROM operator_monitor_state
    WHERE phase = ?
  `).get(phase));
  const lastAttemptedAt = asString(row.last_attempted_at);
  if (!lastAttemptedAt) return true;
  return Date.parse(lastAttemptedAt)
    + Math.max(1, intervalMinutes) * 60_000
    <= Date.now();
};

const recordMonitorPhase = ({
  db,
  phase,
  attemptedAt,
  succeeded,
  error = '',
}: {
  db: ReturnType<typeof openListDb>;
  phase: 'replies' | 'delivery';
  attemptedAt: string;
  succeeded: boolean;
  error?: string;
}): void => {
  db.prepare(`
    INSERT INTO operator_monitor_state (
      phase, last_attempted_at, last_succeeded_at, last_error
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(phase) DO UPDATE SET
      last_attempted_at = excluded.last_attempted_at,
      last_succeeded_at = CASE
        WHEN excluded.last_succeeded_at != ''
          THEN excluded.last_succeeded_at
        ELSE operator_monitor_state.last_succeeded_at
      END,
      last_error = excluded.last_error
  `).run(
    phase,
    attemptedAt,
    succeeded ? attemptedAt : '',
    error,
  );
};

const runDuePolling = async ({
  listDir,
  config,
}: {
  listDir: string;
  config: unknown;
}) => {
  const db = openListDb({ listDir, readonly: false });
  const watch = asRecord(asRecord(config).watch);
  const replyIntervalMinutes = Math.max(
    1,
    Number(watch.poll_inbound_minutes || watch.poll_replies_minutes || 5),
  );
  const deliveryIntervalMinutes = Math.max(
    1,
    Number(watch.poll_delivery_minutes || 15),
  );
  const due = {
    replies: monitorPhaseDue({
      db,
      phase: 'replies',
      intervalMinutes: replyIntervalMinutes,
    }),
    delivery: monitorPhaseDue({
      db,
      phase: 'delivery',
      intervalMinutes: deliveryIntervalMinutes,
    }),
  };
  if (!due.replies && !due.delivery) {
    db.close();
    return { replies: { due: false }, delivery: { due: false } };
  }
  const attemptedAt = nowIso();
  const mcpResult = await getMcpClient()
    .then((mcp) => ({ ok: true as const, mcp }))
    .catch((error) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    }));
  try {
    const replyResult = due.replies
      ? await runImapInboundPoll({ listDir, db, config }).then((result) => ({
          ok: true as const,
          result,
        })).catch((error) => ({
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        }))
      : null;
    const replyErrors = replyResult && 'error' in replyResult
      ? [replyResult.error]
      : replyResult && 'result' in replyResult
        ? replyResult.result.errors || []
        : [];
    if (due.replies) {
      recordMonitorPhase({
        db,
        phase: 'replies',
        attemptedAt,
        succeeded: replyErrors.length === 0,
        error: replyErrors.join('; '),
      });
    }
    const deliveryResult = due.delivery
      ? 'mcp' in mcpResult
        ? await runDeliveryPoll({
            mcp: mcpResult.mcp,
            listDir,
            db,
            config,
          }).then((result) => ({
            ok: true as const,
            result,
          })).catch((error) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }))
        : { ok: false as const, error: mcpResult.error }
      : null;
    const deliveryErrors = deliveryResult && 'error' in deliveryResult
      ? [deliveryResult.error]
      : deliveryResult && 'result' in deliveryResult
        ? deliveryResult.result.errors || []
        : [];
    if (due.delivery) {
      recordMonitorPhase({
        db,
        phase: 'delivery',
        attemptedAt,
        succeeded: deliveryErrors.length === 0,
        error: deliveryErrors.join('; '),
      });
    }
    return {
      replies: replyResult && 'error' in replyResult
        ? { due: true, error: replyResult.error }
        : replyResult && 'result' in replyResult
          ? { due: true, ...replyResult.result }
        : { due: false },
      delivery: deliveryResult && 'error' in deliveryResult
        ? { due: true, error: deliveryResult.error }
        : deliveryResult && 'result' in deliveryResult
          ? { due: true, ...deliveryResult.result }
        : { due: false },
    };
  } finally {
    db.close();
  }
};

const pendingRows = ({
  listDir,
  kind = '',
  priority = '',
  status = '',
}: {
  listDir: string;
  kind?: string;
  priority?: string;
  status?: string;
}): PendingRow[] => {
  reconcilePending({ listDir });
  const db = openListDb({ listDir, readonly: true });
  try {
    const statuses = status
      ? [status]
      : ['open', 'claimed', 'snoozed'];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT * FROM pending_items
      WHERE status IN (${placeholders})
        AND (? = '' OR kind = ?)
        AND (? = '' OR priority = ?)
      ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
          WHEN 'normal' THEN 2 ELSE 3 END,
        datetime(created_at) ASC
    `).all(...statuses, kind, kind, priority, priority) as unknown[];
    return rows.map(rowRecord).map(hydratePending);
  } finally {
    db.close();
  }
};

const summarizePending = (rows: PendingRow[]) => {
  const countBy = (field: string): Record<string, number> => rows.reduce<Record<string, number>>((counts, row) => {
    const value = asString(row[field]) || 'unknown';
    return { ...counts, [value]: Number(counts[value] || 0) + 1 };
  }, {} as Record<string, number>);
  return {
    total: rows.length,
    by_priority: countBy('priority'),
    by_kind: countBy('kind'),
    by_status: countBy('status'),
  };
};

export const pendingListCommand = ({
  list = '',
  allLists = false,
  kind = '',
  priority = '',
  status = '',
  summary = false,
}: {
  list?: string;
  allLists?: boolean;
  kind?: string;
  priority?: string;
  status?: string;
  summary?: boolean;
}) => {
  const targets = resolveTargets({ list, allLists });
  const projects = targets.map((listDir) => {
    const items = pendingRows({ listDir, kind, priority, status });
    return {
      project: basename(listDir),
      list: listDir,
      summary: summarizePending(items),
      ...(summary ? {} : { items }),
    };
  });
  const items = projects.flatMap((project) => (
    'items' in project ? project.items as PendingRow[] : []
  ));
  return {
    projects,
    summary: {
      projects: projects.length,
      total: projects.reduce((total, project) => total + project.summary.total, 0),
      ...(summary ? {} : summarizePending(items)),
    },
  };
};

const locatePending = ({ list = '', pendingId }: { list?: string; pendingId: string }) => {
  const targets = list ? [resolveListDir(list)] : discoverListDirs();
  for (const listDir of targets) {
    const db = openListDb({ listDir, readonly: true });
    try {
      const row = rowRecord(db.prepare('SELECT * FROM pending_items WHERE pending_id = ?').get(pendingId));
      if (row.pending_id) return { listDir, row: hydratePending(row) };
    } finally {
      db.close();
    }
  }
  throw new AgentOutboundError({
    code: 'NOT_FOUND',
    message: `Pending item not found: ${pendingId}`,
  });
};

export const pendingShowCommand = ({ list = '', pendingId }: { list?: string; pendingId: string }) => {
  const located = locatePending({ list, pendingId });
  const db = openListDb({ listDir: located.listDir, readonly: true });
  try {
    const history = db.prepare(`
      SELECT event_id, action, actor, reason, details_json,
        idempotency_key, occurred_at
      FROM pending_item_events
      WHERE pending_id = ?
      ORDER BY datetime(occurred_at) ASC, rowid ASC
    `).all(pendingId).map(rowRecord).map((event) => ({
      ...event,
      details: parseJsonObject(event.details_json),
      details_json: undefined,
    }));
    return {
      project: basename(located.listDir),
      item: {
        ...located.row,
        history,
      },
    };
  } finally {
    db.close();
  }
};

const assertReason = (action: string, reason: string): void => {
  if (reason) return;
  throw new AgentOutboundError({
    code: 'INVALID_ARGUMENT',
    message: `pending ${action} requires --reason.`,
  });
};

const assertPendingTransition = ({
  pendingId,
  action,
  currentStatus,
  allowedStatuses,
}: {
  pendingId: string;
  action: string;
  currentStatus: string;
  allowedStatuses: PendingStatus[];
}): void => {
  if (allowedStatuses.includes(currentStatus as PendingStatus)) return;
  throw new AgentOutboundError({
    code: 'INVALID_ARGUMENT',
    message: `Pending item ${pendingId} is ${currentStatus} and cannot be ${action}.`,
  });
};

export const pendingActionCommand = ({
  list = '',
  pendingId,
  action,
  owner = '',
  reason = '',
  until = '',
  taskId = '',
  leaseMinutes = 60,
  idemKey = '',
  evidenceJson = '',
  actionsJson = '',
}: {
  list?: string;
  pendingId: string;
  action: 'claim' | 'release' | 'resolve' | 'dismiss' | 'snooze';
  owner?: string;
  reason?: string;
  until?: string;
  taskId?: string;
  leaseMinutes?: number;
  idemKey?: string;
  evidenceJson?: string;
  actionsJson?: string;
}) => {
  const located = locatePending({ list, pendingId });
  const db = openListDb({ listDir: located.listDir, readonly: false });
  try {
    const current = rowRecord(db.prepare('SELECT * FROM pending_items WHERE pending_id = ?').get(pendingId));
    const idempotencyToken = idemKey ? `${action}:${idemKey}` : '';
    if (idempotencyToken && asString(current.idempotency_key) === idempotencyToken) {
      return {
        project: basename(located.listDir),
        item: hydratePending(current),
        already_done: true,
      };
    }
    const now = nowIso();
    const providedEvidence = evidenceJson
      ? parseJsonValue(evidenceJson, '--evidence-json')
      : undefined;
    const providedActions = actionsJson
      ? parseJsonValue(actionsJson, '--actions-json')
      : undefined;
    if (action === 'claim') {
      if (!owner) {
        throw new AgentOutboundError({
          code: 'INVALID_ARGUMENT',
          message: 'pending claim requires --owner.',
        });
      }
      const lease = new Date(Date.now() + Math.max(1, leaseMinutes) * 60_000).toISOString();
      const result = db.prepare(`
        UPDATE pending_items SET status = 'claimed', owner_id = ?,
          claimed_at = ?, claim_lease_expires_at = ?, delegated_task_id = ?,
          idempotency_key = ?, last_progress_at = ?, updated_at = ?
        WHERE pending_id = ?
          AND (
            status = 'open'
            OR (
              status = 'claimed'
              AND trim(claim_lease_expires_at) != ''
              AND datetime(claim_lease_expires_at) <= datetime('now')
            )
          )
      `).run(
        owner,
        now,
        lease,
        taskId,
        idempotencyToken,
        now,
        now,
        pendingId,
      );
      if (result.changes !== 1) {
        const latest = rowRecord(db.prepare(`
          SELECT status FROM pending_items WHERE pending_id = ?
        `).get(pendingId));
        throw new AgentOutboundError({
          code: 'INVALID_ARGUMENT',
          message: `Pending item ${pendingId} is ${asString(latest.status)} and cannot be claimed.`,
        });
      }
    }
    if (action === 'release') {
      assertReason(action, reason);
      assertPendingTransition({
        pendingId,
        action: 'released',
        currentStatus: asString(current.status),
        allowedStatuses: ['claimed'],
      });
      db.prepare(`
        UPDATE pending_items SET status = 'open', owner_id = '', claimed_at = '',
          claim_lease_expires_at = '', delegated_task_id = '',
          resolution_reason = ?, idempotency_key = ?, updated_at = ?
        WHERE pending_id = ?
      `).run(reason, idempotencyToken, now, pendingId);
    }
    if (action === 'resolve') {
      assertReason(action, reason);
      assertPendingTransition({
        pendingId,
        action: 'resolved',
        currentStatus: asString(current.status),
        allowedStatuses: ['open', 'claimed'],
      });
      const evidence = providedEvidence ?? parseJsonObject(current.source_state_json);
      const actions = providedActions ?? [];
      db.prepare(`
        UPDATE pending_items SET status = 'resolved', resolution_reason = ?,
          resolution_evidence_json = ?, resolved_at = ?, idempotency_key = ?,
          updated_at = ?
        WHERE pending_id = ?
      `).run(
        reason,
        JSON.stringify({
          actor: owner || asString(current.owner_id) || 'operator',
          source_state: evidence,
          actions,
        }),
        now,
        idempotencyToken,
        now,
        pendingId,
      );
    }
    if (action === 'dismiss') {
      assertReason(action, reason);
      assertPendingTransition({
        pendingId,
        action: 'dismissed',
        currentStatus: asString(current.status),
        allowedStatuses: ['open', 'claimed'],
      });
      db.prepare(`
        UPDATE pending_items SET status = 'dismissed', resolution_reason = ?,
          dismissed_at = ?, idempotency_key = ?, updated_at = ?
        WHERE pending_id = ?
      `).run(reason, now, idempotencyToken, now, pendingId);
    }
    if (action === 'snooze') {
      assertReason(action, reason);
      assertPendingTransition({
        pendingId,
        action: 'snoozed',
        currentStatus: asString(current.status),
        allowedStatuses: ['open', 'claimed'],
      });
      if (!until || !Number.isFinite(Date.parse(until))) {
        throw new AgentOutboundError({
          code: 'INVALID_ARGUMENT',
          message: 'pending snooze requires a valid --until timestamp.',
        });
      }
      db.prepare(`
        UPDATE pending_items SET status = 'snoozed', snoozed_until = ?,
          resolution_reason = ?, idempotency_key = ?, updated_at = ?
        WHERE pending_id = ?
      `).run(
        new Date(until).toISOString(),
        reason,
        idempotencyToken,
        now,
        pendingId,
      );
    }
    recordPendingEvent({
      db,
      pendingId,
      action,
      actor: owner || asString(current.owner_id) || 'operator',
      reason,
      details: {
        task_id: taskId,
        lease_minutes: action === 'claim' ? Math.max(1, leaseMinutes) : undefined,
        until: action === 'snooze' ? new Date(until).toISOString() : undefined,
        evidence: providedEvidence,
        actions: providedActions,
      },
      idempotencyKey: idempotencyToken,
      occurredAt: now,
    });
    const updated = rowRecord(db.prepare('SELECT * FROM pending_items WHERE pending_id = ?').get(pendingId));
    return {
      project: basename(located.listDir),
      action,
      item: hydratePending(updated),
    };
  } finally {
    db.close();
  }
};

const readOperatorInstructions = (listDir: string, pathValue: string): string => {
  if (!pathValue) return '';
  const path = isAbsolute(pathValue) ? pathValue : join(listDir, pathValue);
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
};

const approvalPolicy = (config: Record<string, unknown>) => {
  const sequenceSteps = Object.values(asRecord(config.sequences))
    .flatMap((sequence) => asArray(asRecord(sequence).steps))
    .map(asRecord);
  const pipelineSteps = asArray(config.pipeline).map(asRecord);
  const draftApprovalRequired = [...sequenceSteps, ...pipelineSteps].some((step) => (
    step.draft_approval_required === true
    || asRecord(step.config).draft_approval_required === true
  ));
  return { emailDraftApprovalRequired: draftApprovalRequired };
};

export const contextCommand = ({ list }: { list: string }) => {
  const listDir = resolveListDir(list);
  const configResult = readConfig(listDir);
  if (configResult.errors.length > 0) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: `Cannot compile context because outbound.yaml is invalid: ${configResult.errors.join('; ')}`,
    });
  }
  const config = asRecord(configResult.config);
  const operations = operationsConfig(config);
  const instructionsPath = asString(operations.instructions);
  const operatorInstructions = readOperatorInstructions(listDir, instructionsPath);
  const pipelines = asArray(config.pipeline)
    .map(asRecord)
    .filter((step) => asString(step.kind) === 'pipeline')
    .map((step) => asString(step.id))
    .filter(Boolean);
  const sequences = Object.keys(asRecord(config.sequences));
  const contextHash = createHash('sha256')
    .update(JSON.stringify(configResult.raw))
    .update(operatorInstructions)
    .digest('hex');
  const pending = pendingListCommand({ list: listDir, summary: true });
  const projectPendingSummary = asRecord(
    asArray(pending.projects)[0]
      ? asRecord(asArray(pending.projects)[0]).summary
      : {},
  );
  const business = asRecord(config.business);
  const listConfig = asRecord(config.list);
  return {
    project: basename(listDir),
    list: listDir,
    projectName: asString(listConfig.name) || basename(listDir),
    objective: asString(operations.objectives?.primary),
    secondaryObjectives: operations.objectives?.secondary || [],
    business: {
      name: asString(business.name),
      description: asString(business.description),
      icp: asString(business.icp),
      offer: asString(business.offer),
    },
    activePipelines: pipelines,
    activeSequences: sequences,
    approvalPolicy: approvalPolicy(config),
    operatorInstructions,
    pendingSummary: projectPendingSummary,
    configVersion: contextHash,
  };
};

const notificationConfiguration = (config: unknown) => {
  const notifications = operationsConfig(config).notifications || {};
  return {
    coalesceFor: notifications.coalesce_for,
    sinks: notifications.sinks || {},
    routes: notifications.routes || [],
    notifyOn: notifications.notify_on || [],
  };
};

const deliverSink = async ({
  listDir,
  sink,
  payload,
}: {
  listDir: string;
  sink: NotificationSink;
  payload: Record<string, unknown>;
}): Promise<void> => {
  const body = `${JSON.stringify(payload)}\n`;
  if (sink.type === 'stdout') {
    process.stdout.write(body);
    return;
  }
  if (sink.type === 'file') {
    const pathValue = asString(sink.path);
    if (!pathValue) throw new Error('File notification sink requires path.');
    const path = isAbsolute(pathValue) ? pathValue : join(listDir, pathValue);
    appendFileSync(path, body);
    return;
  }
  if (sink.type === 'command') {
    const command = asString(sink.command);
    if (!command) throw new Error('Command notification sink requires command.');
    const result = spawnSync(command, sink.args || [], {
      input: body,
      encoding: 'utf8',
      cwd: listDir,
    });
    if (result.status !== 0) {
      throw new Error(asString(result.stderr) || `Notification command exited ${result.status}`);
    }
    return;
  }
  const url = asString(sink.url);
  if (!url) throw new Error('Webhook notification sink requires url.');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Webhook returned ${response.status}`);
};

const enqueuePendingNotifications = ({
  listDir,
  config,
  changes,
}: {
  listDir: string;
  config: unknown;
  changes: PendingChanges;
}) => {
  const changedEvents = Object.entries(changes)
    .filter(([, pendingIds]) => pendingIds.length > 0);
  if (changedEvents.length === 0) return { enqueued: 0, coalesced: 0 };
  const notification = notificationConfiguration(config);
  const configuredRoutes = notification.routes.flatMap((route) => {
    const events = changedEvents
      .map(([event]) => event)
      .filter((event) => (
        route.events.includes(event)
        || route.events.includes('pending_changed')
      ));
    return events.length > 0 ? [{ ...route, events }] : [];
  });
  const fallbackRoutes: NotificationRoute[] = Object.keys(notification.sinks)
    .flatMap((sink) => {
      const events = changedEvents
        .map(([event]) => event)
        .filter((event) => (
          notification.notifyOn.includes(event)
          || notification.notifyOn.includes('pending_changed')
        ));
      return events.length > 0 ? [{ events, sink }] : [];
    });
  const routes = configuredRoutes.length > 0 ? configuredRoutes : fallbackRoutes;
  const routeGroups = routes.reduce<Record<string, NotificationRoute>>((groups, route) => {
    const existing = groups[route.sink];
    return {
      ...groups,
      [route.sink]: {
        sink: route.sink,
        events: [...new Set([
          ...(existing?.events || []),
          ...route.events,
        ])].sort(),
        coalesce_for: route.coalesce_for
          || existing?.coalesce_for,
      },
    };
  }, {});
  const project = basename(listDir);
  const db = openListDb({ listDir, readonly: false });
  try {
    const results = Object.values(routeGroups).map((route) => {
      const sink = notification.sinks[route.sink];
      if (!sink) return 'skipped';
      const pendingIds = [
        ...new Set(route.events.flatMap((event) => changes[event as keyof PendingChanges])),
      ].sort();
      const rows = pendingRows({ listDir })
        .filter((item) => pendingIds.includes(asString(item.pending_id)));
      const now = new Date();
      const coalesceMs = durationMilliseconds(
        route.coalesce_for || notification.coalesceFor,
      );
      const existing = rowRecord(db.prepare(`
        SELECT * FROM notification_deliveries
        WHERE sink = ? AND event = 'pending_changed' AND status = 'pending'
        ORDER BY datetime(created_at) DESC
        LIMIT 1
      `).get(route.sink));
      const existingDeliveryId = asString(existing.delivery_id);
      if (existingDeliveryId) {
        const existingPayload = parseJsonObject(existing.payload_json);
        const coalescedPendingIds = [
          ...new Set([
            ...asStringArray(existingPayload.pendingIds),
            ...pendingIds,
          ]),
        ].sort();
        const events = [
          ...new Set([
            ...asStringArray(existingPayload.events),
            ...route.events,
          ]),
        ].sort();
        const pendingRowsForPayload = pendingRows({ listDir })
          .filter((item) => coalescedPendingIds.includes(asString(item.pending_id)));
        const payload = {
          ...existingPayload,
          events,
          pendingIds: coalescedPendingIds,
          summary: summarizePending(pendingRowsForPayload),
          occurredAt: now.toISOString(),
        };
        // Coalesce merges into the existing pending delivery without extending
        // available_at. The first-enqueue deadline (created_at + coalesce_for)
        // is firm: batching must not starve a row that keeps receiving events.
        // Failure backoff is the only path that may push available_at forward.
        db.prepare(`
          UPDATE notification_deliveries
          SET payload_json = ?, updated_at = ?
          WHERE delivery_id = ?
        `).run(
          JSON.stringify(payload),
          now.toISOString(),
          existingDeliveryId,
        );
        return 'coalesced';
      }
      const availableAt = new Date(now.getTime() + coalesceMs).toISOString();
      const dedupeKey = `${project}:${route.sink}:pending_changed:${now.toISOString()}`;
      const deliveryId = stableId('delivery', dedupeKey);
      const payload = {
        event: 'pending_changed',
        events: route.events,
        deliveryId,
        projects: [project],
        pendingIds,
        summary: summarizePending(rows),
        occurredAt: now.toISOString(),
      };
      db.prepare(`
        INSERT INTO notification_deliveries (
          delivery_id, dedupe_key, sink, event, status, attempts,
          payload_json, available_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending_changed', 'pending', 0, ?, ?, ?, ?)
      `).run(
        deliveryId,
        dedupeKey,
        route.sink,
        JSON.stringify(payload),
        availableAt,
        now.toISOString(),
        now.toISOString(),
      );
      return 'enqueued';
    });
    return {
      enqueued: results.filter((result) => result === 'enqueued').length,
      coalesced: results.filter((result) => result === 'coalesced').length,
    };
  } finally {
    db.close();
  }
};

const deliverDueNotifications = async ({
  listDir,
  config,
}: {
  listDir: string;
  config: unknown;
}) => {
  const notification = notificationConfiguration(config);
  const db = openListDb({ listDir, readonly: false });
  try {
    const deliveries = db.prepare(`
      SELECT * FROM notification_deliveries
      WHERE status IN ('pending', 'failed')
        AND datetime(available_at) <= datetime('now')
      ORDER BY datetime(available_at) ASC
    `).all().map(rowRecord);
    const results = await Promise.all(deliveries.map(async (delivery) => {
      const deliveryId = asString(delivery.delivery_id);
      const sink = notification.sinks[asString(delivery.sink)];
      if (!sink) {
        db.prepare(`
          UPDATE notification_deliveries
          SET status = 'failed', attempts = attempts + 1,
            last_error = ?, available_at = ?, updated_at = ?
          WHERE delivery_id = ?
        `).run(
          `Notification sink "${asString(delivery.sink)}" is not configured.`,
          new Date(Date.now() + 300_000).toISOString(),
          nowIso(),
          deliveryId,
        );
        return false;
      }
      try {
        await deliverSink({
          listDir,
          sink,
          payload: parseJsonObject(delivery.payload_json),
        });
        db.prepare(`
          UPDATE notification_deliveries SET status = 'delivered',
            attempts = attempts + 1, delivered_at = ?, last_error = '',
            updated_at = ? WHERE delivery_id = ?
        `).run(nowIso(), nowIso(), deliveryId);
        return true;
      } catch (error) {
        const attempts = Number(delivery.attempts || 0) + 1;
        const retrySeconds = Math.min(300, 5 * (2 ** Math.min(attempts - 1, 6)));
        db.prepare(`
          UPDATE notification_deliveries SET status = 'failed',
            attempts = ?, last_error = ?, available_at = ?, updated_at = ?
          WHERE delivery_id = ?
        `).run(
          attempts,
          error instanceof Error ? error.message : String(error),
          new Date(Date.now() + retrySeconds * 1_000).toISOString(),
          nowIso(),
          deliveryId,
        );
        return false;
      }
    }));
    return {
      attempted: results.length,
      delivered: results.filter(Boolean).length,
      failed: results.filter((result) => !result).length,
    };
  } finally {
    db.close();
  }
};

export const monitorOnceCommand = async ({
  list = '',
  allLists = false,
}: {
  list?: string;
  allLists?: boolean;
}) => {
  const targets = resolveTargets({ list, allLists });
  const projects = [];
  for (const listDir of targets) {
    const configResult = readConfig(listDir);
    if (configResult.errors.length > 0) {
      throw new AgentOutboundError({
        code: 'INVALID_ARGUMENT',
        message: `Cannot monitor because outbound.yaml is invalid: ${configResult.errors.join('; ')}`,
        hint: 'Run agent-outbound config validate for details.',
      });
    }
    const ingestion = await runDuePolling({
      listDir,
      config: configResult.config,
    });
    const reconciliation = reconcilePending({ listDir });
    const queuedNotifications = enqueuePendingNotifications({
      listDir,
      config: reconciliation.config,
      changes: reconciliation.changes,
    });
    const notifications = await deliverDueNotifications({
      listDir,
      config: reconciliation.config,
    });
    projects.push({
      project: reconciliation.project,
      ingestion,
      observed: reconciliation.observed,
      pending_created: reconciliation.changes.pending_created.length,
      pending_priority_changed: reconciliation.changes.pending_priority_changed.length,
      review_requested: reconciliation.changes.review_requested.length,
      pipeline_blocked: reconciliation.changes.pipeline_blocked.length,
      pending_cleared: reconciliation.clearedIds.length,
      queued_notifications: queuedNotifications,
      notifications,
    });
  }
  return { projects };
};

export const monitorCommand = async ({
  list = '',
  allLists = false,
  intervalSeconds = 15,
  once = false,
}: {
  list?: string;
  allLists?: boolean;
  intervalSeconds?: number;
  once?: boolean;
}) => {
  const first = await monitorOnceCommand({ list, allLists });
  if (once) return first;
  const interval = Math.max(5, intervalSeconds) * 1000;
  return new Promise<Record<string, unknown>>((resolvePromise) => {
    const timer = setInterval(() => {
      void monitorOnceCommand({ list, allLists }).catch((error) => {
        process.stderr.write(`AgentOutbound monitor error: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }, interval);
    const stop = () => {
      clearInterval(timer);
      resolvePromise({ stopped: true, interval_seconds: interval / 1000 });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
};
