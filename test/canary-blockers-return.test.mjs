/**
 * Requirement-level tests for the latest independent review return items:
 * 1. Canary isolation at DB mutation boundary (drafts approve blocked)
 * 2. Draft create review version includes body/subject (compatible with send)
 * 3. failIdempotency ownership
 * 4. Inbound pause before classification
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import {
  openListDb,
  insertDraft,
  updateDraft,
  upsertRecord,
  enforceCanaryRecordMutation,
} from '../dist/orchestrator/runtime/db.js';
import { draftsApproveCommand } from '../dist/commands/drafts.js';
import {
  resolveStageAssetVersion,
} from '../dist/orchestrator/policy/stage-review-gate.js';
import {
  claimIdempotency,
  failIdempotency,
  completeIdempotency,
  IDEMPOTENCY_PENDING_LEASE_MS,
} from '../dist/orchestrator/runtime/idempotency.js';
import { processInboundReplyText } from '../dist/orchestrator/runtime/inbound-reply-process.js';

const miniYaml = `
list:
  name: canary-blocker-list
business:
  name: Mission
  description: t
  icp: t
  offer: t
pipeline: []
policy:
  version: tv-v1
  review_required_for: [send_email]
`;

function createList() {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-canary-return-'));
  writeFileSync(join(listDir, 'outbound.yaml'), miniYaml);
  writeFileSync(join(listDir, 'operator.md'), 't');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO records (_row_id, business_name, _created_at, _updated_at, created_at, updated_at)
    VALUES ('rec_allowed', 'Allowed Co', ?, ?, ?, ?)
  `).run(now, now, now, now);
  db.prepare(`
    INSERT INTO records (_row_id, business_name, _created_at, _updated_at, created_at, updated_at)
    VALUES ('rec_blocked', 'Blocked Co', ?, ?, ?, ?)
  `).run(now, now, now, now);
  db.close();
  return listDir;
}

test('1 canary: strict mode blocks draft approve on non-allowlisted record via DB gate', () => {
  const listDir = createList();
  // List-local canary marker so the temp list itself is authorized; records still filtered.
  mkdirSync(join(listDir, '.outbound'), { recursive: true });
  writeFileSync(join(listDir, '.outbound', 'canary.json'), JSON.stringify({
    mode: 'strict',
    allowlist_record_ids: ['rec_allowed'],
  }));
  const prevMode = process.env.AO_CANARY_MODE;
  const prevAllow = process.env.AO_CANARY_ALLOWLIST;
  // Prefer list-local config; clear env to avoid list-name blocks
  delete process.env.AO_CANARY_MODE;
  delete process.env.AO_CANARY_ALLOWLIST;
  try {
    const db = openListDb({ listDir, readonly: false });
    insertDraft({
      db,
      draft: {
        draft_id: 'd_ok',
        row_id: 'rec_allowed',
        sequence_name: 'default',
        step_number: 1,
        step_id: 'email_1',
        channel: 'email',
        status: 'pending_approval',
        subject: 'ok',
        body: 'ok body',
      },
    });
    // Non-allowlisted draft insert must throw at DB boundary.
    assert.throws(
      () => insertDraft({
        db,
        draft: {
          draft_id: 'd_bad',
          row_id: 'rec_blocked',
          sequence_name: 'default',
          step_number: 1,
          step_id: 'email_1',
          channel: 'email',
          status: 'pending_approval',
          subject: 'bad',
          body: 'bad body',
        },
      }),
      /canary|allowlist|not allow|blocked/i,
    );
    db.close();

    // Approve path for blocked record — plant draft with raw sqlite then openListDb approve.
    const raw = new Database(join(listDir, '.outbound', 'prospects.db'));
    raw.prepare(`
      INSERT INTO drafts (draft_id, row_id, sequence_name, step_number, step_id, channel, status, subject, body, created_at, updated_at)
      VALUES ('d_smuggle', 'rec_blocked', 'default', 1, 'email_1', 'email', 'pending_approval', 's', 'b', datetime('now'), datetime('now'))
    `).run();
    raw.close();

    assert.throws(
      () => draftsApproveCommand({ list: listDir, draftId: 'd_smuggle' }),
      /canary|allowlist|not allow|blocked/i,
    );
  } finally {
    if (prevMode === undefined) delete process.env.AO_CANARY_MODE;
    else process.env.AO_CANARY_MODE = prevMode;
    if (prevAllow === undefined) delete process.env.AO_CANARY_ALLOWLIST;
    else process.env.AO_CANARY_ALLOWLIST = prevAllow;
  }
});

test('2 draft/send review versions match when body included at open', () => {
  const openVersion = resolveStageAssetVersion({
    accountId: 'acc1',
    activeContactId: 'c1',
    recipient: 'a@b.test',
    stepId: 'email_1',
    draftId: 'd1',
    subjectText: 'Subj',
    bodyText: 'Exact body that will be approved',
  });
  const sendVersion = resolveStageAssetVersion({
    accountId: 'acc1',
    activeContactId: 'c1',
    recipient: 'a@b.test',
    stepId: 'email_1',
    draftId: 'd1',
    subjectText: 'Subj',
    bodyText: 'Exact body that will be approved',
  });
  assert.equal(openVersion, sendVersion);
  const withoutBody = resolveStageAssetVersion({
    accountId: 'acc1',
    activeContactId: 'c1',
    recipient: 'a@b.test',
    stepId: 'email_1',
    draftId: 'd1',
  });
  assert.notEqual(openVersion, withoutBody, 'body omission must change version');
});

test('3 failIdempotency refuses to poison a newer claim', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE idempotency (
      id TEXT PRIMARY KEY, idem_key TEXT, scope TEXT, status TEXT,
      provider_id TEXT, payload_json TEXT, created_at TEXT, updated_at TEXT,
      UNIQUE(idem_key, scope)
    );
  `);
  const t0 = Date.now();
  const a = claimIdempotency({ db, idemKey: 'k', scope: 'list', nowMs: t0, leaseMs: 1000 });
  assert.equal(a.claimed, true);
  const b = claimIdempotency({
    db,
    idemKey: 'k',
    scope: 'list',
    nowMs: t0 + IDEMPOTENCY_PENDING_LEASE_MS + 2000,
  });
  assert.equal(b.claimed, true, 'expired lease reclaimed by B');
  // Stale worker A tries to fail — must not wipe B's claim
  const failA = failIdempotency({
    db,
    idemKey: 'k',
    scope: 'list',
    claimId: a.claim_id,
    payload: { error: 'stale' },
  });
  assert.equal(failA.failed, false);
  assert.equal(failA.reason, 'not_owner');
  completeIdempotency({
    db,
    idemKey: 'k',
    scope: 'list',
    providerId: 'msg_b',
    claimId: b.claim_id,
  });
  const row = db.prepare('SELECT * FROM idempotency WHERE idem_key = ?').get('k');
  assert.equal(row.status, 'sent');
  assert.equal(row.provider_id, 'msg_b');
});

test('4 inbound pause is persisted before classification completes', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../src/orchestrator/runtime/inbound-reply-process.ts'), 'utf8');
  const upsertBefore = src.indexOf('upsertRecord({ db: input.db, row: prePause })');
  // First call to classifyReplyAction after imports (not the import line).
  const classifyCall = src.indexOf('await classifyReplyAction');
  assert.ok(upsertBefore > 0, 'prePause upsert must exist');
  assert.ok(classifyCall > 0, 'classifyReplyAction await must exist');
  assert.ok(
    upsertBefore < classifyCall,
    'prePause upsert must run before await classifyReplyAction',
  );
});
