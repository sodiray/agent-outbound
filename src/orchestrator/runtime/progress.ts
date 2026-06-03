const nowIso = () => new Date().toISOString();

const makeRunId = (phase: string) => `${phase}-${nowIso()}-${Math.floor(Math.random() * 1e6)}`;

const hasDefined = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key) && typeof value[key] !== 'undefined';

export const beginRun = (db: any, opts: { phase: string; message?: string; activeStep?: string; target?: number }): string => {
  try {
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

export const endRun = (db: any, runId: string, opts?: { status?: 'done' | 'error'; message?: string; error?: string }): void => {
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
