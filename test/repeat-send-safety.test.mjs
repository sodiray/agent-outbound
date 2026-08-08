import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { reconcileCommand } from '../dist/commands/index.js';
import {
  claimIdempotency,
  completeIdempotency,
  getIdempotencyRecord,
} from '../dist/orchestrator/runtime/idempotency.js';
import { runProviderWaterfall } from '../dist/orchestrator/enrichment/actions/tool-call.js';
import { createLobMailProvider } from '../dist/orchestrator/channels/mail-provider.js';
import { unipileLiveInvite } from '../dist/orchestrator/channels/unipile.js';
import { openListDb, ensureRecordColumns } from '../dist/orchestrator/runtime/db.js';
import { runHealthChecks } from '../dist/orchestrator/operator/health.js';

const openIdempotencyDb = () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE idempotency (
      id TEXT PRIMARY KEY,
      idem_key TEXT NOT NULL,
      scope TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_id TEXT,
      payload_json TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(idem_key, scope)
    );
  `);
  return db;
};

test('reconciliation quarantines stale send claims and prevents an automatic re-claim', () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-reconcile-uncertain-'));
  writeFileSync(join(listDir, 'outbound.yaml'), 'list:\n  name: reconcile\npipeline: []\n');
  writeFileSync(join(listDir, 'operator.md'), 'ops');
  const db = openListDb({ listDir, readonly: false });
  const staleAt = new Date(Date.now() - 120 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO idempotency (id, idem_key, scope, status, provider_id, payload_json, created_at, updated_at)
    VALUES ('stale_claim', 'list:record|email', 'list', 'pending', '', '{}', ?, ?)
  `).run(staleAt, staleAt);
  db.close();

  const reconciled = reconcileCommand({ list: listDir, staleMinutes: 30 });
  assert.equal(reconciled.pending_marked_uncertain, 1);

  const verified = openListDb({ listDir, readonly: false });
  assert.equal(
    getIdempotencyRecord({ db: verified, idemKey: 'list:record|email', scope: 'list' }).status,
    'uncertain',
  );
  assert.equal(
    claimIdempotency({ db: verified, idemKey: 'list:record|email', scope: 'list' }).claimed,
    false,
  );
  assert.equal(
    completeIdempotency({
      db: verified,
      idemKey: 'list:record|email',
      scope: 'list',
      providerId: 'unobserved-provider-id',
    }).completed,
    false,
  );
  verified.close();
});

test('external transmissions never waterfall after an ambiguous primary failure', async () => {
  const calls = [];
  await assert.rejects(
    () => runProviderWaterfall({
      stepId: 'send',
      externalSend: true,
      chain: [
        { server: 'primary', tools: ['SEND'] },
        { server: 'fallback', tools: ['SEND'] },
      ],
      tryTool: async (spec) => {
        calls.push(spec.server);
        if (spec.server === 'primary') throw new Error('socket hang up after request write');
        return { result: { message_id: 'fallback_message' }, provider: 'fallback' };
      },
    }),
    /waterfall exhausted|socket hang up/i,
  );
  assert.deepEqual(calls, ['primary']);
});

test('post-write network errors are explicitly uncertain for Lob and Unipile', async () => {
  const lob = createLobMailProvider({
    apiKey: 'test-key',
    fetchImpl: async () => { throw new Error('connection reset after request write'); },
  });
  const mail = await lob.submit({
    recordId: 'record_1',
    treatment: 'postcard',
    to: { address_line_1: '1 Test Way' },
  });
  assert.equal(mail.status, 'uncertain');
  assert.equal(mail.outcome_unknown, true);

  const invite = await unipileLiveInvite({
    dsn: 'https://unipile.example.test',
    apiKey: 'test-key',
    linkedinUrl: 'prospect-id',
    targetProviderId: 'provider-user-1',
    targetPublicIdentifier: 'prospect-id',
    message: 'Hello.',
    fetchImpl: async () => { throw new Error('connection reset after request write'); },
  });
  assert.equal(invite.outcome_unknown, true);
});

test('health excludes never-enrolled disqualified records but retains genuinely in-play contradictions', () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-health-enrollment-'));
  writeFileSync(join(listDir, 'outbound.yaml'), 'list:\n  name: health\npipeline: []\n');
  writeFileSync(join(listDir, 'operator.md'), 'ops');
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({
    db,
    columns: ['lifecycle_stage', 'account_sequence_state', 'next_action_json', 'disqualified_at'],
  });
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, lifecycle_stage,
      account_sequence_state, next_action_json, disqualified_at,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, ?, 'default', 'idle', 'disqualified', ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('never_started', 'Never Started', '', '', now, now, now, now, now);
  insert.run(
    'in_play',
    'In Play',
    'active',
    JSON.stringify({ action_type: 'send_email' }),
    now,
    now,
    now,
    now,
    now,
  );

  const report = runHealthChecks({ db, limit: 50 });
  const contradictions = report.issues.filter((issue) => issue.code === 'in_play_disqualified_contradiction');
  assert.deepEqual(contradictions.map((issue) => issue.record_id), ['in_play']);
  assert.equal(contradictions[0].severity, 'error');
  db.close();
});

test('idempotency claims remain exclusive for concurrent workers', () => {
  const db = openIdempotencyDb();
  const first = claimIdempotency({ db, idemKey: 'list:record|send', scope: 'list' });
  const second = claimIdempotency({ db, idemKey: 'list:record|send', scope: 'list' });
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  db.close();
});

test('launchDraft preserves a configured idempotency key for non-email sends', () => {
  const runnerSource = readFileSync(
    new URL('../src/orchestrator/sequencer/runner.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(runnerSource, /idempotency:\s*null/);
});
