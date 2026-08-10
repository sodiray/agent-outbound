const nowIso = () => new Date().toISOString();

const makeRunId = (phase: string) => `${phase}-${nowIso()}-${Math.floor(Math.random() * 1e6)}`;

const hasDefined = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key) && typeof value[key] !== 'undefined';

/**
 * Terminal and in-flight values for run_state.status.
 *
 * - running     — process is actively working this run
 * - done        — finished fully; no open work that needs attention
 * - incomplete  — finished cleanly with work held for a human (e.g. review gate);
 *                 not a failure
 * - error       — finished with genuine failures that need attention (record-level
 *                 execution errors, thrown exceptions)
 * - interrupted — process was killed/cancelled; row reconciled after the fact
 *
 * Historical rows may still carry older values; consumers must tolerate unknowns.
 */
export type RunStatus = 'running' | 'done' | 'incomplete' | 'error' | 'interrupted';

export type RunTerminalStatus = Exclude<RunStatus, 'running'>;

/**
 * Phases that maintain a continuous heartbeat (updated_at every few seconds for
 * the whole run). Only these can be reconciled as interrupted from staleness
 * without risking a live long-quiet phase (e.g. scoring mid-LLM).
 */
export const CONTINUOUS_HEARTBEAT_PHASES = ['pipeline'] as const;

/** Missed heartbeats before a continuous-heartbeat run is treated as dead (3s interval × 10). */
export const DEFAULT_STALE_RUNNING_MS = 30_000;

/**
 * Decide terminal status for a pipeline that finished its process cleanly.
 *
 * Rule: record-level errors dominate. Awaiting review alone is incomplete (expected
 * gate). Both together is error — the run needs attention for the errored records.
 */
export const pipelineRunTerminalStatus = (summary: {
  errored?: number;
  awaiting_review?: number;
}): 'done' | 'incomplete' | 'error' => {
  if (Number(summary.errored || 0) > 0) return 'error';
  if (Number(summary.awaiting_review || 0) > 0) return 'incomplete';
  return 'done';
};

export const pipelineRunTerminalMessage = (summary: {
  errored?: number;
  awaiting_review?: number;
  survivors?: number;
}): string => {
  const errored = Number(summary.errored || 0);
  const awaiting = Number(summary.awaiting_review || 0);
  const survivors = Number(summary.survivors || 0);
  if (errored > 0 || awaiting > 0) {
    return `Pipeline incomplete · ${errored} errored records need retry · ${awaiting} awaiting review`;
  }
  return `Pipeline complete · ${survivors} survivors · ${awaiting} awaiting review`;
};

/**
 * Mark continuous-heartbeat runs stuck in `running` as `interrupted` when their
 * updated_at is older than maxAgeMs. Safe for pipeline (3s heartbeat for the
 * whole run). Does not touch other phases — scoring/briefs/automations only
 * tick on record completion and a multi-minute quiet period is normal.
 *
 * Returns the number of rows reconciled.
 */
export const reconcileStaleRunningRuns = (
  db: any,
  opts?: {
    maxAgeMs?: number;
    now?: string;
    phases?: readonly string[];
    /** When set, never touch this run_id (the run we are about to keep alive). */
    excludeRunId?: string;
  },
): number => {
  try {
    const maxAgeMs = Math.max(1, Number(opts?.maxAgeMs || DEFAULT_STALE_RUNNING_MS));
    const now = String(opts?.now || nowIso());
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) return 0;
    const cutoff = new Date(nowMs - maxAgeMs).toISOString();
    const phases = (opts?.phases && opts.phases.length > 0)
      ? [...opts.phases]
      : [...CONTINUOUS_HEARTBEAT_PHASES];
    const excludeRunId = String(opts?.excludeRunId || '');
    const placeholders = phases.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT run_id
      FROM run_state
      WHERE status = 'running'
        AND phase IN (${placeholders})
        AND updated_at < ?
        AND (? = '' OR run_id != ?)
    `).all(...phases, cutoff, excludeRunId, excludeRunId) as Array<{ run_id?: string }>;

    let count = 0;
    const update = db.prepare(`
      UPDATE run_state
      SET status = ?, message = ?, updated_at = ?
      WHERE run_id = ? AND status = 'running'
    `);
    for (const row of rows) {
      const runId = String(row?.run_id || '');
      if (!runId) continue;
      const result = update.run(
        'interrupted',
        'Run interrupted · process stopped without a terminal status (reconciled on next start)',
        now,
        runId,
      );
      count += Number(result?.changes || 0);
    }
    return count;
  } catch {
    return 0;
  }
};

export const beginRun = (db: any, opts: { phase: string; message?: string; activeStep?: string; target?: number }): string => {
  try {
    // Reconcile phantoms left by killed processes before recording a new run.
    reconcileStaleRunningRuns(db);
    const now = nowIso();
    const runId = makeRunId(opts.phase);
    db.prepare(`
      INSERT INTO run_state (
        run_id,
        phase,
        active_step,
        message,
        target_count,
        done_count,
        status,
        error,
        started_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(runId, opts.phase, opts.activeStep || '', opts.message || '', opts.target || 0, 0, 'running', '', now, now);
    return runId;
  } catch {
    return '';
  }
};

export const tickProgress = (db: any, runId: string, patch: { done?: number; target?: number; activeStep?: string; message?: string; stepIndex?: number; stepTotal?: number }): void => {
  try {
    if (!runId) return;
    const updates = [
      hasDefined(patch, 'done') ? { fragment: 'done_count = ?', value: patch.done } : null,
      hasDefined(patch, 'target') ? { fragment: 'target_count = ?', value: patch.target } : null,
      hasDefined(patch, 'activeStep') ? { fragment: 'active_step = ?', value: patch.activeStep } : null,
      hasDefined(patch, 'message') ? { fragment: 'message = ?', value: patch.message } : null,
      hasDefined(patch, 'stepIndex') ? { fragment: 'step_index = ?', value: patch.stepIndex } : null,
      hasDefined(patch, 'stepTotal') ? { fragment: 'step_total = ?', value: patch.stepTotal } : null,
    ].filter(Boolean) as { fragment: string; value: string | number | undefined }[];
    if (updates.length === 0) return;
    db.prepare(`UPDATE run_state SET ${[...updates.map((update) => update.fragment), 'updated_at = ?'].join(', ')} WHERE run_id = ?`)
      .run(...updates.map((update) => update.value), nowIso(), runId);
  } catch {
    return;
  }
};

export const heartbeat = (db: any, runId: string): void => {
  try {
    if (!runId) return;
    db.prepare('UPDATE run_state SET updated_at = ? WHERE run_id = ?').run(nowIso(), runId);
  } catch {
    return;
  }
};

export const endRun = (db: any, runId: string, opts?: { status?: RunTerminalStatus; message?: string; error?: string }): void => {
  try {
    if (!runId) return;
    const updates = [
      { fragment: 'status = ?', value: opts?.status || 'done' },
      hasDefined(opts || {}, 'message') ? { fragment: 'message = ?', value: opts?.message } : null,
      hasDefined(opts || {}, 'error') ? { fragment: 'error = ?', value: opts?.error } : null,
    ].filter(Boolean) as { fragment: string; value: string | undefined }[];
    db.prepare(`UPDATE run_state SET ${[...updates.map((update) => update.fragment), 'updated_at = ?'].join(', ')} WHERE run_id = ?`)
      .run(...updates.map((update) => update.value), nowIso(), runId);
  } catch {
    return;
  }
};
