/**
 * Unknown CLI flags must be refused — never accepted and silently ignored.
 *
 * The original defect: `pipeline --force --only account_intelligence` ran the
 * entire pipeline while the operator believed they had scoped it to one step.
 * Recognised flags are spliced out of argv via consumeFlag/hasFlag; anything
 * still `--`-prefixed after parse is unrecognised by definition.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { openListDb } from '../dist/orchestrator/runtime/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'cli.js');

const minimalConfig = `
list:
  name: cli-unknown-flags
business:
  name: Probe
  description: Test
  icp: Test
  offer: Test
pipeline: []
sequences:
  default:
    steps: []
`;

const createList = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-cli-flags-'));
  writeFileSync(join(listDir, 'outbound.yaml'), minimalConfig);
  // Touch the list DB so read-only commands have a real list root.
  openListDb({ listDir, readonly: false }).close();
  return listDir;
};

const runCli = (args) => spawnSync(process.execPath, [CLI, ...args], {
  cwd: ROOT,
  encoding: 'utf8',
});

const parseEnvelope = (run) => {
  assert.ok(run.stdout && run.stdout.trim(), `expected JSON on stdout, stderr: ${run.stderr}`);
  return JSON.parse(run.stdout);
};

test('a fabricated flag on pipeline is refused and the message names the flag and command', () => {
  const listDir = createList();
  // Rejects at parse time — never reaches pipeline execution / model calls.
  const run = runCli(['pipeline', listDir, '--force', '--only', 'account_intelligence']);

  assert.notEqual(run.status, 0, 'unknown flags must exit non-zero');
  const payload = parseEnvelope(run);
  assert.equal(payload.ok, false, 'must use the failure envelope, not a bare string');
  assert.equal(payload.error?.code, 'INVALID_ARGUMENT');
  const message = String(payload.error?.message || '');
  assert.match(message, /--only/);
  assert.match(message, /pipeline/i);
  // Operator's next question is always "then what is it".
  assert.match(message, /Accepted flags:/i);
  // CONTROL (pipeline): every flag the path actually consumes appears here.
  // We do not invoke pipeline successfully under the spend cap; the accepted
  // list is how we prove those flags are registered, not ignored.
  for (const flag of ['--where', '--limit', '--dry-run', '--force', '--reapply', '--sample', '--concurrency']) {
    assert.match(message, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('CONTROL: positional arguments still parse', () => {
  const listDir = createList();
  // schema takes a positional list and an optional --table flag.
  const run = runCli(['schema', listDir, '--table', 'records']);

  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const payload = parseEnvelope(run);
  assert.equal(payload.ok, true);
  assert.ok(payload.result);
});

test('CONTROL: multi-flag read command still accepts its real flags', () => {
  const listDir = createList();
  const run = runCli([
    'query',
    listDir,
    '--sql', 'SELECT 1 AS ok',
    '--limit', '10',
    '--timeout-ms', '2000',
  ]);

  assert.equal(run.status, 0, `stderr: ${run.stderr}\nstdout: ${run.stdout}`);
  const payload = parseEnvelope(run);
  assert.equal(payload.ok, true);
});

test('unknown flag on a multi-flag command names the command and lists accepted flags', () => {
  const listDir = createList();
  const run = runCli([
    'query',
    listDir,
    '--sql', 'SELECT 1',
    '--not-a-real-flag', 'x',
  ]);

  assert.notEqual(run.status, 0);
  const payload = parseEnvelope(run);
  assert.equal(payload.ok, false);
  assert.equal(payload.error?.code, 'INVALID_ARGUMENT');
  assert.match(String(payload.error?.message || ''), /--not-a-real-flag/);
  assert.match(String(payload.error?.message || ''), /query/i);
  assert.match(String(payload.error?.message || ''), /--sql/);
});

// No command in this CLI intentionally forwards trailing args after a bare `--`
// separator (verified: no `--` passthrough in src/cli.ts). If one is added later,
// give it a dedicated control test that the tokens after `--` still pass through.
