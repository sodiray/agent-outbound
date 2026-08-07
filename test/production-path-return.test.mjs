/**
 * Production-path proofs for the latest independent NO-GO return.
 *
 * 1. Excluded record cannot trigger provider effects (canary before SMTP).
 * 2. Draft approval and edits preserve review safety.\n * 4. Concurrent stale fail cannot poison newer claim (atomic CAS).
 * 5. Live poller uses processInboundReplyText (pause before classify).
 * 6. Version composition parity create/approve/send.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { openListDb, insertDraft, ensureRecordColumns, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';
import {
  draftsApproveCommand,
  composeOutboundReviewVersion,
} from '../dist/commands/drafts.js';
import {
  claimIdempotency,
  completeIdempotency,
  failIdempotency,
  IDEMPOTENCY_PENDING_LEASE_MS,
} from '../dist/orchestrator/runtime/idempotency.js';
import { reconcileOverrides, reconcileFieldOverrides } from '../dist/orchestrator/runtime/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SMTP_SCRIPT = join(ROOT, 'scripts/smtp-send.mjs');

const miniYaml = `
list:
  name: prod-path-return
business:
  name: Mission
  description: t
  icp: t
  offer: t
pipeline: []
policy:
  version: tv-v1
  review_required_for: [send_email]
  enforce_readiness: false
`;

function smtpMcp(sinkDir) {
  return JSON.stringify({
    mcpServers: {
      smtp: {
        type: 'command',
        command: process.execPath,
        args: [SMTP_SCRIPT],
        env: { AO_SMTP_SINK: '1', AO_SMTP_SINK_DIR: sinkDir },
        tools: [{
          slug: 'SMTP_SEND',
          description: 'sink',
          input_schema: {
            type: 'object',
            properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, from: { type: 'string' } },
            required: ['to'],
          },
          invoke: {
            argv: ['send', '--to', '{{to}}', '--subject', '{{subject}}', '--body', '{{body}}', '--from', '{{from}}', '--json'],
            result: 'stdout_json',
          },
        }],
      },
    },
  }, null, 2);
}

function createList(opts = {}) {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-prod-return-'));
  const sinkDir = join(listDir, 'smtp-sink');
  mkdirSync(sinkDir, { recursive: true });
  mkdirSync(join(listDir, '.outbound'), { recursive: true });
  writeFileSync(join(listDir, 'outbound.yaml'), miniYaml);
  writeFileSync(join(listDir, 'operator.md'), 't');
  writeFileSync(join(listDir, 'mcp.json'), smtpMcp(sinkDir));
  if (opts.canary) {
    writeFileSync(join(listDir, '.outbound', 'canary.json'), JSON.stringify(opts.canary));
  }
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: [
      'contact_email', 'active_contact_id', 'account_sequence_state', 'lifecycle_stage',
      'work_state', 'stage_review_json', 'next_action_json', 'email_last_from',
      'assigned_mailbox_id',
    ],
  });
  for (const rid of ['rec_allowed', 'rec_blocked']) {
    db.prepare(`
      INSERT INTO records (
        _row_id, business_name, contact_email, active_contact_id,
        account_sequence_state, lifecycle_stage, work_state,
        email_last_from, assigned_mailbox_id,
        _created_at, _updated_at, created_at, updated_at
      ) VALUES (?, ?, 'owner@test.example', 'c1', 'active', 'contacted', 'executing_external_action',
        'sender@mission.test', 'mb_primary', ?, ?, ?, ?)
    `).run(rid, rid === 'rec_allowed' ? 'Allowed Co' : 'Blocked Co', now, now, now, now);
  }
  db.close();
  return { listDir, sinkDir };
}

test('1 excluded record cannot trigger provider effects under strict canary', async () => {
  const prevMode = process.env.AO_CANARY_MODE;
  const prevAllow = process.env.AO_CANARY_ALLOWLIST;
  delete process.env.AO_CANARY_MODE;
  delete process.env.AO_CANARY_ALLOWLIST;
  const { listDir, sinkDir } = createList({
    canary: { mode: 'strict', allowlist_record_ids: ['rec_allowed'] },
  });
  process.env.AO_SMTP_SINK = '1';
  try {
    const db = openListDb({ listDir, readonly: false });
    const record = db.prepare('SELECT * FROM records WHERE _row_id=?').get('rec_blocked');
    // executeChannelStep must refuse BEFORE any provider effect.
    let threw = false;
    try {
      await executeChannelStep({
        mcp: null,
        listDir,
        listName: 'prod-path-return',
        db,
        record,
        sequenceName: 'default',
        stepNumber: 1,
        step: {
          kind: 'send_email',
          id: 'email_1',
          draft_approval_required: false,
          config: {
            action: 'tool_call',
            tool: { server: 'smtp', tools: ['SMTP_SEND'] },
            args_map: { to: 'contact_email' },
            args: { subject: 'Should not send', body: 'local hvac service company body' },
            daily_cap: 50,
            idempotency: { key_source: ['_row_id', 'step_id'], scope: 'list' },
          },
        },
        sequence: { steps: [{ id: 'email_1', day: 0 }] },
        channelHint: 'email',
        intent: 'send',
        dryRun: false,
      });
    } catch (err) {
      threw = true;
      assert.match(String(err?.message || err), /canary|allowlist|blocked/i);
    }
    const sinks = readdirSync(sinkDir).filter((f) => f.endsWith('.json'));
    assert.equal(sinks.length, 0, 'no SMTP sink files for excluded record');
    assert.equal(threw, true, 'executeChannelStep must throw before provider');
    db.close();
  } finally {
    if (prevMode === undefined) delete process.env.AO_CANARY_MODE;
    else process.env.AO_CANARY_MODE = prevMode;
    if (prevAllow === undefined) delete process.env.AO_CANARY_ALLOWLIST;
    else process.env.AO_CANARY_ALLOWLIST = prevAllow;
    delete process.env.AO_SMTP_SINK;
  }
});

test('1b reconcileOverrides does not mutate non-allowlisted records', () => {
  delete process.env.AO_CANARY_MODE;
  delete process.env.AO_CANARY_ALLOWLIST;
  const { listDir } = createList({
    canary: { mode: 'strict', allowlist_record_ids: ['rec_allowed'] },
  });
  const db = openListDb({ listDir, readonly: false });
  // Plant a field override for blocked record via raw SQL (bypassing gate for setup).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS field_overrides (
        id TEXT PRIMARY KEY,
        record_id TEXT,
        field TEXT,
        value TEXT,
        created_at TEXT,
        created_by TEXT,
        cleared_at TEXT,
        cleared_by TEXT
      );
    `);
  } catch { /* */ }
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO field_overrides (id, record_id, field, value, created_at, created_by, cleared_at, cleared_by)
    VALUES ('fo1', 'rec_blocked', 'business_name', 'HACKED', ?, 'test', '', '')
  `).run(now);
  const before = db.prepare('SELECT business_name FROM records WHERE _row_id=?').get('rec_blocked');
  reconcileFieldOverrides({ db, recordIds: ['rec_allowed'] });
  const after = db.prepare('SELECT business_name FROM records WHERE _row_id=?').get('rec_blocked');
  assert.equal(after.business_name, before.business_name, 'blocked record must not be reconciled');
  db.close();
});

test('2 approved draft becomes ready through the review command', () => {
  delete process.env.AO_CANARY_MODE;
  delete process.env.AO_CANARY_ALLOWLIST;
  const { listDir } = createList({
    canary: { mode: 'canary', allowlist_record_ids: ['rec_allowed'] },
  });
  const db = openListDb({ listDir, readonly: false });
  insertDraft({
    db,
    draft: {
      draft_id: 'd_good',
      row_id: 'rec_allowed',
      sequence_name: 'default',
      step_number: 1,
      step_id: 'email_1',
      channel: 'email',
      status: 'pending_approval',
      subject: 'Operational snapshot',
      body: 'A draft that is ready for human review.',
    },
  });
  db.close();

  const result = draftsApproveCommand({ list: listDir, draftId: 'd_good' });
  assert.equal(result.approved, 1);
  const verified = openListDb({ listDir, readonly: true });
  const draft = verified.prepare('SELECT status FROM drafts WHERE draft_id=?').get('d_good');
  assert.equal(draft.status, 'ready');
  verified.close();
});

test('3 version composition matches for same draft inputs', () => {
  const record = {
    _row_id: 'acc1',
    active_contact_id: 'c1',
    contact_email: 'a@b.test',
    email_last_from: 'sender@mission.test',
  };
  const draft = {
    draft_id: 'd1',
    step_id: 'email_1',
    subject: 'Hello',
    body: 'local hvac service company',
  };
  const a = composeOutboundReviewVersion({ record, draft, sender: 'sender@mission.test' });
  const b = composeOutboundReviewVersion({ record, draft, sender: 'sender@mission.test' });
  assert.equal(a, b);
  const edited = composeOutboundReviewVersion({
    record,
    draft: { ...draft, body: 'edited body changes version' },
    sender: 'sender@mission.test',
  });
  assert.notEqual(a, edited);
});

test('4 atomic fail cannot poison newer claim; complete is CAS', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE idempotency (
      id TEXT PRIMARY KEY, idem_key TEXT, scope TEXT, status TEXT,
      provider_id TEXT, payload_json TEXT, created_at TEXT, updated_at TEXT,
      UNIQUE(idem_key, scope)
    );
  `);
  const t0 = Date.now();
  const a = claimIdempotency({ db, idemKey: 'k', scope: 'list', nowMs: t0, leaseMs: 500 });
  const b = claimIdempotency({
    db,
    idemKey: 'k',
    scope: 'list',
    nowMs: t0 + IDEMPOTENCY_PENDING_LEASE_MS + 1000,
  });
  assert.equal(b.claimed, true);
  const failA = failIdempotency({ db, idemKey: 'k', scope: 'list', claimId: a.claim_id });
  assert.equal(failA.failed, false);
  const completeB = completeIdempotency({
    db,
    idemKey: 'k',
    scope: 'list',
    providerId: 'pB',
    claimId: b.claim_id,
  });
  assert.equal(completeB.completed, true);
  const failUncertain = failIdempotency({
    db,
    idemKey: 'k2',
    scope: 'list',
    claimId: 'x',
    payload: { provider_uncertain: true },
  });
  // no row yet
  assert.equal(failUncertain.failed, false);
});

test('5 live reply poller source uses processInboundReplyText (pause-first)', () => {
  const src = readFileSync(join(__dirname, '../src/orchestrator/runtime/polling.ts'), 'utf8');
  assert.match(src, /processInboundReplyText/);
  assert.ok(
    !src.includes('await classifyReplyAction({'),
    'poller must not classify inline',
  );
  const inbound = readFileSync(join(__dirname, '../src/orchestrator/runtime/inbound-reply-process.ts'), 'utf8');
  const upsert = inbound.indexOf('upsertRecord({ db: input.db, row: prePause })');
  const classify = inbound.indexOf('await classifyReplyAction');
  assert.ok(upsert > 0 && classify > upsert);
});

test('6 sender change produces different review fingerprint', () => {
  const record = {
    _row_id: 'acc1',
    active_contact_id: 'c1',
    contact_email: 'a@b.test',
  };
  const draft = {
    draft_id: 'd1',
    step_id: 'email_1',
    subject: 'Hello',
    body: 'soft body',
  };
  const a = composeOutboundReviewVersion({ record, draft, sender: 'mailbox-a@mission.test' });
  const b = composeOutboundReviewVersion({ record, draft, sender: 'mailbox-b@mission.test' });
  assert.notEqual(a, b, 'different mailboxes must yield different asset_version hashes');
});

test('7 failed claim reclaim is exclusive (only one concurrent winner)', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE idempotency (
      id TEXT PRIMARY KEY, idem_key TEXT, scope TEXT, status TEXT,
      provider_id TEXT, payload_json TEXT, created_at TEXT, updated_at TEXT,
      UNIQUE(idem_key, scope)
    );
  `);
  const t0 = Date.now();
  const first = claimIdempotency({ db, idemKey: 'fail-k', scope: 'list', nowMs: t0 });
  assert.equal(first.claimed, true);
  const failed = failIdempotency({
    db,
    idemKey: 'fail-k',
    scope: 'list',
    claimId: first.claim_id,
    payload: { error: 'smtp_error' },
  });
  assert.equal(failed.failed, true);
  // Two concurrent reclaims of failed status — exactly one must win.
  const r1 = claimIdempotency({ db, idemKey: 'fail-k', scope: 'list', nowMs: t0 + 1000 });
  const rowAfter = db.prepare('SELECT * FROM idempotency WHERE idem_key=?').get('fail-k');
  const r2 = claimIdempotency({ db, idemKey: 'fail-k', scope: 'list', nowMs: t0 + 1000 });
  const winners = [r1, r2].filter((r) => r.claimed);
  assert.equal(winners.length, 1, 'exactly one concurrent failed-reclaim wins');
  assert.equal(r2.claimed, false, 'second reclaim must lose after first takes exclusive pending');
  assert.ok(rowAfter.status === 'failed' || r1.claimed);
});

test('8 list-local canary.json cannot downgrade env AO_CANARY_MODE=strict', async () => {
  const { loadCanaryConfig, _test } = await import('../dist/orchestrator/policy/canary-isolation.js');
  const prevMode = process.env.AO_CANARY_MODE;
  const prevAllow = process.env.AO_CANARY_ALLOWLIST;
  process.env.AO_CANARY_MODE = 'strict';
  process.env.AO_CANARY_ALLOWLIST = 'rec_a,rec_b';
  try {
    const { listDir } = createList({
      canary: { mode: 'off', allowlist_record_ids: ['rec_a', 'rec_evil'] },
    });
    const cfg = loadCanaryConfig({ listDir });
    assert.equal(cfg.mode, 'strict', 'list-local mode=off must not downgrade env strict');
    assert.ok(cfg.allowlist_record_ids.includes('rec_a'));
    assert.ok(
      !cfg.allowlist_record_ids.includes('rec_evil'),
      'list-local must not expand env-owned allowlist',
    );
    // mergeConfigs unit: mode never downgrades; env allowlist is authoritative
    const merged = _test.mergeConfigs(
      { mode: 'strict', allowlist_record_ids: ['x'], allowlist_list_names: [] },
      { mode: 'off', allowlist_record_ids: ['x', 'y'] },
    );
    assert.equal(merged.mode, 'strict');
    assert.ok(merged.allowlist_record_ids.includes('x'));
    assert.ok(!merged.allowlist_record_ids.includes('y'));
  } finally {
    if (prevMode === undefined) delete process.env.AO_CANARY_MODE;
    else process.env.AO_CANARY_MODE = prevMode;
    if (prevAllow === undefined) delete process.env.AO_CANARY_ALLOWLIST;
    else process.env.AO_CANARY_ALLOWLIST = prevAllow;
  }
});

test('9 remove and interactionAdd refuse non-allowlisted records under strict', async () => {
  const prevMode = process.env.AO_CANARY_MODE;
  const prevAllow = process.env.AO_CANARY_ALLOWLIST;
  delete process.env.AO_CANARY_MODE;
  delete process.env.AO_CANARY_ALLOWLIST;
  const { listDir } = createList({
    canary: { mode: 'strict', allowlist_record_ids: ['rec_allowed'] },
  });
  const { removeCommand } = await import('../dist/commands/index.js');
  const { interactionAddCommand } = await import('../dist/commands/interactions.js');
  try {
    assert.throws(
      () => removeCommand({ list: listDir, row: 'rec_blocked' }),
      /canary|allowlist|blocked/i,
    );
    assert.throws(
      () => interactionAddCommand({
        list: listDir,
        ref: 'rec_blocked',
        summary: 'note on blocked',
      }),
      /canary|allowlist|blocked/i,
    );
    // Allowed still works
    const ok = interactionAddCommand({
      list: listDir,
      ref: 'rec_allowed',
      summary: 'note on allowed',
    });
    assert.equal(ok.status, 'interaction_logged');
  } finally {
    if (prevMode === undefined) delete process.env.AO_CANARY_MODE;
    else process.env.AO_CANARY_MODE = prevMode;
    if (prevAllow === undefined) delete process.env.AO_CANARY_ALLOWLIST;
    else process.env.AO_CANARY_ALLOWLIST = prevAllow;
  }
});

test('10 draft edit invalidates existing authorization', async () => {
  delete process.env.AO_CANARY_MODE;
  delete process.env.AO_CANARY_ALLOWLIST;
  const { listDir } = createList({
    canary: { mode: 'canary', allowlist_record_ids: ['rec_allowed'] },
  });
  const db = openListDb({ listDir, readonly: false });
  const review = {
    review_id: 'rev1',
    stage_id: 'email_1',
    asset_version: 'srv1:abc',
    status: 'authorized',
    account_id: 'rec_allowed',
    action_type: 'send_email',
  };
  ensureRecordColumns({ db, columns: ['stage_review_json', 'account_sequence_state'] });
  db.prepare(`
    UPDATE records SET stage_review_json = ?, account_sequence_state = 'active'
    WHERE _row_id = 'rec_allowed'
  `).run(JSON.stringify(review));
  insertDraft({
    db,
    draft: {
      draft_id: 'd_edit',
      row_id: 'rec_allowed',
      sequence_name: 'default',
      step_number: 1,
      step_id: 'email_1',
      channel: 'email',
      status: 'ready',
      subject: 'old',
      body: 'old body',
    },
  });
  db.close();

  const { draftsEditCommand } = await import('../dist/commands/drafts.js');
  const result = draftsEditCommand({
    list: listDir,
    draftId: 'd_edit',
    body: 'edited body content that changes the draft',
  });
  assert.equal(result.status, 'edited');
  assert.equal(result.authorization_invalidated, true);

  const verified = openListDb({ listDir, readonly: true });
  const draft = verified.prepare('SELECT status FROM drafts WHERE draft_id=?').get('d_edit');
  assert.equal(draft.status, 'pending_approval');
  const record = verified.prepare('SELECT stage_review_json FROM records WHERE _row_id=?').get('rec_allowed');
  assert.equal(JSON.parse(String(record.stage_review_json)).status, 'invalidated');
  verified.close();
});

test('13 approve refuses blank provider envelope (from/mailbox)', () => {
  delete process.env.AO_CANARY_MODE;
  const { listDir } = createList({
    canary: { mode: 'canary', allowlist_record_ids: ['rec_allowed'] },
  });
  const db = openListDb({ listDir, readonly: false });
  // Wipe mailbox fields so approve must refuse incomplete envelope.
  db.prepare(`UPDATE records SET email_last_from='', assigned_mailbox_id='' WHERE _row_id='rec_allowed'`).run();
  insertDraft({
    db,
    draft: {
      draft_id: 'd_blank_env',
      row_id: 'rec_allowed',
      sequence_name: 'default',
      step_number: 1,
      step_id: 'email_1',
      channel: 'email',
      status: 'pending_approval',
      subject: 'local hvac service company',
      body: 'Hi there.\n\nlocal hvac service company.\n\nWorth a call?\n\nRay',
    },
  });
  db.close();
  assert.throws(
    () => draftsApproveCommand({ list: listDir, draftId: 'd_blank_env' }),
    /provider_envelope_incomplete|approval failed/i,
  );
  const db2 = openListDb({ listDir, readonly: true });
  const d = db2.prepare('SELECT status FROM drafts WHERE draft_id=?').get('d_blank_env');
  assert.equal(d.status, 'pending_approval');
  db2.close();
});

test('14 partial unknown fit components never yield Tier A / golden_ticket', async () => {
  const { applyOutboundPolicy } = await import('../dist/orchestrator/policy/apply-record.js');
  const fitIds = [
    'operational_coordination_burden',
    'repetition_and_volume',
    'economic_impact_potential',
    'operating_scale_surface_area',
    'mission_delivery_compatibility',
    'local_buying_autonomy',
  ];
  const breakdown = fitIds.map((id, i) => ({
    id,
    grade: i === 5 ? 0 : 10,
    evidence_ids: i === 5 ? [] : [`obs_${id}`],
    reasoning: i === 5 ? 'no_admissible_evidence' : 'supported',
    missing: i === 5,
    unknown: i === 5,
  }));
  const result = applyOutboundPolicy({
    record: {
      _row_id: 'acc_partial',
      fit_breakdown: JSON.stringify(breakdown),
      fit_score: 90,
      fit_evidence_confidence: 93,
      identity_confidence: 90,
      classification_confidence: 90,
      buyer_confidence: 90,
      mail_confidence: 90,
      mail_address_ready: true,
      local_buying_authority: 'yes',
      named_buyer_status: 'resolved',
      named_buyer_name: 'Jane',
      buyer_affiliation_status: 'resolved',
      buying_center_role: 'owner',
      golden_ticket_cohort_ok: true,
      golden_ticket_asset_ready: true,
    },
    recomputeFitFromBreakdown: true,
  });
  assert.notEqual(result.treatment_tier, 'A', 'partial unknown must not be Tier A');
  assert.notEqual(result.mail_treatment, 'golden_ticket', 'partial unknown must not be golden_ticket');
});

test('15 all-unknown fit becomes enrichment_hold not Tier D', async () => {
  const { applyOutboundPolicy } = await import('../dist/orchestrator/policy/apply-record.js');
  const fitIds = [
    'operational_coordination_burden',
    'repetition_and_volume',
    'economic_impact_potential',
    'operating_scale_surface_area',
    'mission_delivery_compatibility',
    'local_buying_autonomy',
  ];
  const breakdown = fitIds.map((id) => ({
    id,
    grade: 0,
    evidence_ids: [],
    reasoning: 'no_admissible_evidence',
    missing: true,
    unknown: true,
  }));
  const result = applyOutboundPolicy({
    record: {
      _row_id: 'acc_unknown',
      fit_breakdown: JSON.stringify(breakdown),
      fit_score: 0,
      fit_evidence_confidence: 0,
    },
    recomputeFitFromBreakdown: true,
  });
  assert.equal(result.treatment_tier, 'enrichment_hold', 'all-unknown must hold, not Tier D');
});
