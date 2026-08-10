/**
 * run_state.status vocabulary:
 *   running | done | incomplete | error | interrupted
 *
 * Problem A — awaiting human review must not be filed as error.
 * Problem B — stale running rows (killed process) reconcile to interrupted;
 *             a live heartbeating run must not be touched.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  beginRun,
  endRun,
  heartbeat,
  pipelineRunTerminalMessage,
  pipelineRunTerminalStatus,
  reconcileStaleRunningRuns,
  DEFAULT_STALE_RUNNING_MS,
} from '../dist/orchestrator/runtime/progress.js';
import { openListDb } from '../dist/orchestrator/runtime/db.js';
import { getProgress } from '../dist/viz/data.js';
import { monitorOnceCommand, pendingListCommand } from '../dist/commands/operator.js';

const createList = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-run-state-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
list:
  name: Run State Test
business:
  name: Test
  description: Test
  icp: Test
  offer: Test
pipeline: []
sequences:
  default:
    steps: []
operations:
  observations:
    - id: pipeline_blocked
      source: operator_monitor_state
      when:
        status: error
  pending:
    rules:
      - id: repair_pipeline
        observation: pipeline_blocked
        kind: pipeline_blocked
        priority: urgent
`);
  return listDir;
};

const insertRun = (db, {
  runId,
  phase = 'pipeline',
  status = 'running',
  message = '',
  error = '',
  startedAt,
  updatedAt,
}) => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO run_state (
      run_id, phase, active_step, message, target_count, done_count,
      status, error, started_at, updated_at
    ) VALUES (?, ?, '', ?, 0, 0, ?, ?, ?, ?)
  `).run(
    runId,
    phase,
    message,
    status,
    error,
    startedAt || now,
    updatedAt || now,
  );
};

// --- Pure terminal-status rule ---------------------------------------------

test('pipelineRunTerminalStatus: awaiting review alone is incomplete (not error, not done)', () => {
  assert.equal(pipelineRunTerminalStatus({ errored: 0, awaiting_review: 30 }), 'incomplete');
  assert.equal(pipelineRunTerminalStatus({ errored: 0, awaiting_review: 1 }), 'incomplete');
  assert.match(
    pipelineRunTerminalMessage({ errored: 0, awaiting_review: 30, survivors: 10 }),
    /Pipeline incomplete · 0 errored records need retry · 30 awaiting review/,
  );
});

test('pipelineRunTerminalStatus: genuine record errors stay error (needs attention)', () => {
  assert.equal(pipelineRunTerminalStatus({ errored: 3, awaiting_review: 0 }), 'error');
  assert.equal(pipelineRunTerminalStatus({ errored: 1, awaiting_review: 0 }), 'error');
  assert.match(
    pipelineRunTerminalMessage({ errored: 3, awaiting_review: 0, survivors: 5 }),
    /Pipeline incomplete · 3 errored records need retry · 0 awaiting review/,
  );
});

test('pipelineRunTerminalStatus: mixed — errored dominates awaiting review (asserted rule)', () => {
  // Rule: record-level errors dominate. Awaiting review does not clear the need for attention.
  assert.equal(pipelineRunTerminalStatus({ errored: 1, awaiting_review: 30 }), 'error');
  assert.equal(pipelineRunTerminalStatus({ errored: 2, awaiting_review: 14 }), 'error');
  assert.notEqual(pipelineRunTerminalStatus({ errored: 1, awaiting_review: 30 }), 'incomplete');
});

test('pipelineRunTerminalStatus: clean finish is done', () => {
  assert.equal(pipelineRunTerminalStatus({ errored: 0, awaiting_review: 0 }), 'done');
  assert.match(
    pipelineRunTerminalMessage({ errored: 0, awaiting_review: 0, survivors: 42 }),
    /Pipeline complete · 42 survivors · 0 awaiting review/,
  );
});

// --- endRun / beginRun persistence -----------------------------------------

test('endRun persists incomplete status for awaiting-review completion', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  try {
    const runId = beginRun(db, { phase: 'pipeline', message: 'test' });
    endRun(db, runId, {
      status: pipelineRunTerminalStatus({ errored: 0, awaiting_review: 12 }),
      message: pipelineRunTerminalMessage({ errored: 0, awaiting_review: 12, survivors: 4 }),
    });
    const row = db.prepare('SELECT status, message FROM run_state WHERE run_id = ?').get(runId);
    assert.equal(row.status, 'incomplete');
    assert.notEqual(row.status, 'error');
    assert.match(String(row.message), /12 awaiting review/);
  } finally {
    db.close();
  }
});

test('endRun persists error when records errored (with or without awaiting review)', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  try {
    const onlyErrored = beginRun(db, { phase: 'pipeline' });
    endRun(db, onlyErrored, {
      status: pipelineRunTerminalStatus({ errored: 2, awaiting_review: 0 }),
      message: pipelineRunTerminalMessage({ errored: 2, awaiting_review: 0 }),
    });
    assert.equal(
      db.prepare('SELECT status FROM run_state WHERE run_id = ?').get(onlyErrored).status,
      'error',
    );

    const both = beginRun(db, { phase: 'pipeline' });
    endRun(db, both, {
      status: pipelineRunTerminalStatus({ errored: 1, awaiting_review: 30 }),
      message: pipelineRunTerminalMessage({ errored: 1, awaiting_review: 30 }),
    });
    assert.equal(
      db.prepare('SELECT status FROM run_state WHERE run_id = ?').get(both).status,
      'error',
    );
  } finally {
    db.close();
  }
});

// --- Stale running reconciliation (Problem B) ------------------------------

test('reconcileStaleRunningRuns: stale pipeline running → interrupted; live run untouched', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  try {
    const now = new Date();
    const staleAt = new Date(now.getTime() - DEFAULT_STALE_RUNNING_MS - 5_000).toISOString();
    const liveAt = now.toISOString();

    insertRun(db, {
      runId: 'stale-pipeline-1',
      phase: 'pipeline',
      status: 'running',
      message: 'Filtering…',
      startedAt: staleAt,
      updatedAt: staleAt,
    });
    insertRun(db, {
      runId: 'live-pipeline-1',
      phase: 'pipeline',
      status: 'running',
      message: 'Filtering…',
      startedAt: liveAt,
      updatedAt: liveAt,
    });
    // Scoring can sit quiet during a long LLM call — must not be reconciled by default.
    insertRun(db, {
      runId: 'quiet-scoring-1',
      phase: 'scoring',
      status: 'running',
      startedAt: staleAt,
      updatedAt: staleAt,
    });

    const n = reconcileStaleRunningRuns(db, { now: liveAt });
    assert.equal(n, 1, 'only the stale pipeline row should reconcile');

    const stale = db.prepare('SELECT status, message FROM run_state WHERE run_id = ?').get('stale-pipeline-1');
    assert.equal(stale.status, 'interrupted');
    assert.match(String(stale.message), /interrupted/i);
    assert.notEqual(stale.status, 'error');
    assert.notEqual(stale.status, 'done');

    const live = db.prepare('SELECT status FROM run_state WHERE run_id = ?').get('live-pipeline-1');
    assert.equal(live.status, 'running', 'genuinely active run must not be touched');

    const scoring = db.prepare('SELECT status FROM run_state WHERE run_id = ?').get('quiet-scoring-1');
    assert.equal(scoring.status, 'running', 'non-heartbeat phases must not be auto-interrupted');
  } finally {
    db.close();
  }
});

test('beginRun reconciles stale pipeline rows before inserting the new run', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  try {
    const now = new Date();
    const staleAt = new Date(now.getTime() - 60_000).toISOString();
    insertRun(db, {
      runId: 'killed-pipeline',
      phase: 'pipeline',
      status: 'running',
      startedAt: staleAt,
      updatedAt: staleAt,
    });

    const newId = beginRun(db, { phase: 'pipeline', message: 'next run' });
    assert.ok(newId);

    const killed = db.prepare('SELECT status FROM run_state WHERE run_id = ?').get('killed-pipeline');
    assert.equal(killed.status, 'interrupted');

    const next = db.prepare('SELECT status FROM run_state WHERE run_id = ?').get(newId);
    assert.equal(next.status, 'running');
  } finally {
    db.close();
  }
});

test('heartbeat keeps a live run safe from stale reconciliation', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  try {
    const runId = beginRun(db, { phase: 'pipeline' });
    // Simulate wall-clock passage then a heartbeat (as the 3s timer does).
    const past = new Date(Date.now() - 60_000).toISOString();
    db.prepare('UPDATE run_state SET updated_at = ? WHERE run_id = ?').run(past, runId);
    heartbeat(db, runId);

    const n = reconcileStaleRunningRuns(db);
    assert.equal(n, 0);
    assert.equal(
      db.prepare('SELECT status FROM run_state WHERE run_id = ?').get(runId).status,
      'running',
    );
  } finally {
    db.close();
  }
});

// --- Existing consumers must still behave correctly ------------------------

test('getProgress surfaces incomplete and interrupted without treating them as running', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  try {
    insertRun(db, {
      runId: 'incomplete-run',
      phase: 'pipeline',
      status: 'incomplete',
      message: 'Pipeline incomplete · 0 errored records need retry · 5 awaiting review',
      updatedAt: new Date().toISOString(),
    });
  } finally {
    db.close();
  }

  const progress = getProgress(listDir);
  assert.equal(progress.run?.status, 'incomplete');
  assert.notEqual(progress.run?.status, 'error');
  assert.notEqual(progress.run?.status, 'running');
});

test('operator error surface still selects status=error; incomplete and interrupted are not errors', async () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  try {
    // Latest per phase wins for errorCandidates (NOT EXISTS newer updated_at).
    // Seed older non-error terminals first, then the genuine error as newest.
    insertRun(db, {
      runId: 'awaiting-only',
      phase: 'pipeline',
      status: 'incomplete',
      message: 'Pipeline incomplete · 0 errored records need retry · 10 awaiting review',
      updatedAt: new Date(Date.now() - 2000).toISOString(),
    });
    insertRun(db, {
      runId: 'killed-run',
      phase: 'pipeline',
      status: 'interrupted',
      message: 'Run interrupted',
      updatedAt: new Date(Date.now() - 1000).toISOString(),
    });
    insertRun(db, {
      runId: 'real-error',
      phase: 'pipeline',
      status: 'error',
      message: 'Pipeline incomplete · 2 errored records need retry · 0 awaiting review',
      error: 'eval failed',
      updatedAt: new Date().toISOString(),
    });
  } finally {
    db.close();
  }

  // Materialize pending from run_state via the same path operators use.
  await monitorOnceCommand({ list: listDir });
  const pending = pendingListCommand({ list: listDir });
  const items = (pending.projects || []).flatMap((project) => project.items || []);
  const blob = JSON.stringify(items);

  // status = 'error' still surfaces as needing attention.
  assert.ok(
    blob.includes('real-error') || /Pipeline run failed/i.test(blob) || blob.includes('eval failed'),
    `expected error run in operator pending surface, got: ${blob.slice(0, 800)}`,
  );
  // incomplete / interrupted must not be treated as run errors.
  assert.doesNotMatch(blob, /awaiting-only/);
  assert.doesNotMatch(blob, /killed-run/);

  // Direct contract of the consumer query (status = 'error' only).
  const verifyDb = openListDb({ listDir, readonly: true });
  try {
    const errorRuns = verifyDb.prepare(`
      SELECT run_id FROM run_state
      WHERE status = 'error'
        AND NOT EXISTS (
          SELECT 1 FROM run_state newer
          WHERE newer.phase = run_state.phase
            AND datetime(newer.updated_at) > datetime(run_state.updated_at)
        )
    `).all().map((row) => row.run_id);
    assert.deepEqual(errorRuns, ['real-error']);

    const incompleteOrInterrupted = verifyDb.prepare(`
      SELECT run_id, status FROM run_state WHERE status IN ('incomplete', 'interrupted')
    `).all();
    assert.equal(incompleteOrInterrupted.length, 2);
    // Re-running the errorCandidates filter must not include them.
    for (const row of incompleteOrInterrupted) {
      assert.notEqual(row.status, 'error');
    }
  } finally {
    verifyDb.close();
  }
});

test('historical error/done/running rows remain readable (no migration required)', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  try {
    insertRun(db, { runId: 'hist-error', status: 'error', phase: 'pipeline' });
    insertRun(db, { runId: 'hist-done', status: 'done', phase: 'scoring' });
    insertRun(db, { runId: 'hist-running', status: 'running', phase: 'briefs' });

    const statuses = db.prepare('SELECT run_id, status FROM run_state ORDER BY run_id').all();
    assert.deepEqual(
      statuses.map((r) => [r.run_id, r.status]),
      [
        ['hist-done', 'done'],
        ['hist-error', 'error'],
        ['hist-running', 'running'],
      ],
    );
  } finally {
    db.close();
  }
});
