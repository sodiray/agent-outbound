/**
 * `manual complete` is the command that finishes a physical-mail task. Its
 * stdout envelope must describe what actually happened — a refusal must not
 * print `ok: true`, and a success must not print an empty result.
 *
 * These go through the real CLI process because the defect lived in the CLI
 * wiring (an un-awaited async command whose Promise serialised to `{}`), not in
 * the command itself. A test importing the command directly cannot see it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

// A phone task, so the success path does not need the account-campaign plan
// that mail allocation requires. The defect is in the CLI envelope, which is
// the same code for every manual task.
const config = {
  pipeline: [{
    kind: 'manual_task',
    id: 'phone_call',
    config: { task_type: 'human_phone', channel: 'phone' },
  }],
};

const setup = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-manual-cli-'));
  writeFileSync(join(listDir, 'outbound.yaml'), JSON.stringify(config));
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: ['business_name', 'address'] });
  upsertRecord({ db, row: { _row_id: 'rec-1', business_name: 'Probe Co', address: '1 Main St' } });
  db.prepare(`
    INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
    VALUES ('ev-1', 'rec-1', 'phone_call', 'manual_task', 0, 'awaiting_manual', '2026-08-09T18:00:00Z')
  `).run();
  db.close();
  return listDir;
};

const runComplete = (listDir, record) => spawnSync(
  process.execPath,
  [CLI, 'manual', 'complete', listDir, record, '--step', 'phone_call', '--note', 'probe'],
  { encoding: 'utf8' },
);

test('a completion that succeeds prints its actual result, not an empty envelope', () => {
  const listDir = setup();
  const run = runComplete(listDir, 'rec-1');

  assert.equal(run.status, 0, `expected success, stderr: ${run.stderr}`);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.ok, true);
  // The bug printed a serialised Promise, which is `{}` — indistinguishable
  // from a completion that did nothing.
  assert.notDeepEqual(payload.result, {}, 'an un-awaited Promise serialises to {}; the result must be real');
  assert.ok(Object.keys(payload.result).length > 0);
});

test('a refused completion reports the refusal on stdout instead of ok:true', () => {
  const listDir = setup();
  // No such record — the command must refuse rather than report success.
  const run = runComplete(listDir, 'no-such-record');

  assert.notEqual(run.status, 0, 'a refusal must exit non-zero');
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.ok, false, `a refused completion printed a success envelope: ${run.stdout.trim()}`);
  // The reason has to travel on stdout with the envelope, not only as a stack
  // trace on stderr that a JSON-parsing caller never sees.
  assert.ok(String(payload.error?.message || '').length > 0);
});
