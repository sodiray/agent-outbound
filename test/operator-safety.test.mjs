/**
 * Operator surface safety gaps:
 * 1. Call board claim refuses email/linkedin/mail next_action without phone park
 * 2. Disposition allowlist on dispose
 * 3. Stage-review reject → paused_repair / human_review_repair (not stranded pending)
 * 4. Reply work queue + CLI/HTTP wiring
 * 5. Audit export decision-replay fields
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const {
  claimCallBoardEntry,
  disposeCallBoardEntry,
  nextActionIsNonPhoneDigital,
  recordHasOpenPhonePark,
} = await import('../dist/orchestrator/operator/call-board.js');
const {
  PHONE_CALL_DISPOSITIONS,
  isPhoneCallDisposition,
  assertPhoneCallDisposition,
} = await import('../dist/orchestrator/policy/phone-attempt.js');
const {
  authorizeStageReview,
} = await import('../dist/orchestrator/policy/transition-audit.js');
const {
  listReplyQueue,
  listWorkQueue,
  WORK_QUEUE_NAMES,
} = await import('../dist/orchestrator/operator/work-queues.js');
const { exportAuditLog } = await import('../dist/orchestrator/operator/timeline.js');
const {
  workQueuesCommand,
  queueReplyCommand,
  auditExportCommand,
} = await import('../dist/commands/operator-surfaces.js');
const {
  openListDb,
  ensureRecordColumns,
} = await import('../dist/orchestrator/runtime/db.js');

/** Wednesday 2026-08-05 16:00 UTC = 10:00 America/Boise (MDT) — inside attempt window. */
const BOISE_BUSINESS_MS = Date.parse('2026-08-05T16:00:00.000Z');

const projectYaml = () => `
list:
  name: Operator Safety
business:
  name: Mission
  description: Test
  icp: SMB
  offer: Automation
pipeline: []
sequences:
  default:
    steps: []
policy:
  review_required_for:
    - linkedin_connect
    - mail
`;

function createList() {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-op-safety-'));
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml());
  writeFileSync(join(listDir, 'operator.md'), 'ops');
  writeFileSync(join(listDir, 'mcp.json'), '{}');
  return listDir;
}

function seedRecord(db, overrides = {}) {
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: [
      'phone', 'contact_phone', 'treatment_tier', 'fit_score', 'suppressed',
      'lifecycle_stage', 'account_sequence_state', 'work_state', 'next_action_json',
      'call_claim_status', 'call_claimed_by', 'call_claimed_at', 'call_claim_expires_at',
      'call_attempt_count', 'contact_name', 'priority_lane', 'priority_rank',
      'readiness_json', 'cost_ledger_json',
      'stage_review_json', 'transition_audit_json',
      'inbound_pending_human_review', 'inbound_proposed_classification',
      'reply_classification_latest',
    ],
  });
  const r = {
    _row_id: 'acct_1',
    business_name: 'Safety Co',
    phone: '+12085550111',
    contact_phone: '+12085550111',
    treatment_tier: 'A',
    fit_score: 88,
    suppressed: 0,
    lifecycle_stage: 'contacted',
    account_sequence_state: 'active',
    work_state: 'idle',
    next_action_json: JSON.stringify({
      action_id: 'na_email',
      action_type: 'send_email',
      channel: 'email',
      account_id: 'acct_1',
      lifecycle_stage: 'contacted',
      sequence_state: 'active',
      work_state: 'executing_external_action',
      reason: 'email',
      on_success: 'wait',
    }),
    call_claim_status: 'open',
    call_attempt_count: 0,
    contact_name: 'Pat',
    ...overrides,
  };
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, phone, contact_phone,
      treatment_tier, fit_score, suppressed, lifecycle_stage, account_sequence_state,
      work_state, next_action_json, call_claim_status, call_attempt_count, contact_name,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, ?, 'default', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    r._row_id,
    r.business_name,
    r.phone,
    r.contact_phone,
    r.treatment_tier,
    r.fit_score,
    r.suppressed,
    r.lifecycle_stage,
    r.account_sequence_state,
    r.work_state,
    r.next_action_json,
    r.call_claim_status,
    r.call_attempt_count,
    r.contact_name,
    now, now, now, now,
  );
  return r;
}

// ── 1. Claim board: email next_action without phone park ───────────────────

test('nextActionIsNonPhoneDigital: send_email / linkedin / mail', () => {
  assert.equal(
    nextActionIsNonPhoneDigital({
      next_action_json: JSON.stringify({ action_type: 'send_email', channel: 'email' }),
    }),
    true,
  );
  assert.equal(
    nextActionIsNonPhoneDigital({
      next_action_json: JSON.stringify({ action_type: 'linkedin_connect', channel: 'linkedin' }),
    }),
    true,
  );
  assert.equal(
    nextActionIsNonPhoneDigital({
      next_action_json: JSON.stringify({ action_type: 'send_mail', channel: 'mail' }),
    }),
    true,
  );
  assert.equal(
    nextActionIsNonPhoneDigital({
      next_action_json: JSON.stringify({
        action_type: 'call_human',
        channel: 'phone',
        work_state: 'human_phone',
      }),
    }),
    false,
  );
});

test('claimCallBoardEntry: refuses email next_action with no open phone park', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  seedRecord(db, { _row_id: 'email_only' });

  assert.equal(recordHasOpenPhonePark(db, 'email_only'), false);

  assert.throws(
    () => claimCallBoardEntry({
      db,
      recordId: 'email_only',
      claimedBy: 'op1',
      nowMs: BOISE_BUSINESS_MS,
    }),
    /non-phone digital|send_email|no open phone park/i,
  );
  db.close();
});

test('claimCallBoardEntry: refuses linkedin next_action with no open phone park', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  seedRecord(db, {
    _row_id: 'li_only',
    next_action_json: JSON.stringify({
      action_id: 'na_li',
      action_type: 'linkedin_connect',
      channel: 'linkedin',
      account_id: 'li_only',
      lifecycle_stage: 'contacted',
      sequence_state: 'active',
      work_state: 'executing_external_action',
      reason: 'connect',
      on_success: 'wait',
    }),
  });

  assert.throws(
    () => claimCallBoardEntry({
      db,
      recordId: 'li_only',
      claimedBy: 'op1',
      nowMs: BOISE_BUSINESS_MS,
    }),
    /non-phone digital|linkedin|no open phone park/i,
  );
  db.close();
});

test('claimCallBoardEntry: allows phone next_action (no park required)', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  seedRecord(db, {
    _row_id: 'phone_ok',
    next_action_json: JSON.stringify({
      action_id: 'na_call',
      action_type: 'call_human',
      channel: 'phone',
      account_id: 'phone_ok',
      lifecycle_stage: 'contacted',
      sequence_state: 'active',
      work_state: 'human_commercial_followup',
      reason: 'phone',
      on_success: 'continue',
    }),
  });

  const claimed = claimCallBoardEntry({
    db,
    recordId: 'phone_ok',
    claimedBy: 'op1',
    nowMs: BOISE_BUSINESS_MS,
  });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.claimed_by, 'op1');
  db.close();
});

// ── 2. Disposition allowlist ───────────────────────────────────────────────

test('assertPhoneCallDisposition: allowlist + clear error', () => {
  for (const d of PHONE_CALL_DISPOSITIONS) {
    assert.equal(isPhoneCallDisposition(d), true);
    assert.equal(assertPhoneCallDisposition(d), d);
  }
  assert.equal(isPhoneCallDisposition('totally_fake'), false);
  assert.throws(
    () => assertPhoneCallDisposition('totally_fake'),
    /Invalid call disposition.*"totally_fake".*Allowed:/i,
  );
  assert.throws(
    () => assertPhoneCallDisposition(''),
    /Invalid call disposition/i,
  );
});

test('disposeCallBoardEntry: rejects arbitrary disposition strings', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  seedRecord(db, {
    _row_id: 'disp_1',
    next_action_json: JSON.stringify({
      action_id: 'na_call',
      action_type: 'call_human',
      channel: 'phone',
      account_id: 'disp_1',
      lifecycle_stage: 'contacted',
      sequence_state: 'active',
      work_state: 'human_commercial_followup',
      reason: 'phone',
      on_success: 'continue',
    }),
  });
  claimCallBoardEntry({
    db,
    recordId: 'disp_1',
    claimedBy: 'op1',
    nowMs: BOISE_BUSINESS_MS,
  });

  assert.throws(
    () => disposeCallBoardEntry({
      db,
      recordId: 'disp_1',
      disposition: 'left_voicemail_lol',
      disposedBy: 'op1',
    }),
    /Invalid call disposition.*"left_voicemail_lol"/i,
  );

  // Known disposition still works
  const ok = disposeCallBoardEntry({
    db,
    recordId: 'disp_1',
    disposition: 'no_answer',
    disposedBy: 'op1',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.disposition, 'no_answer');
  db.close();
});

// ── 3. Reject stage review must not strand ─────────────────────────────────

test('authorizeStageReview reject → paused_repair + human_review_repair', () => {
  const existing = {
    review_id: 'rev_rej',
    stage_id: 'email_send',
    asset_version: 'av_rej',
    status: 'pending',
    account_id: 'acct_rej',
    contact_id: 'c1',
    pending_action_snapshot: {
      action_id: 'na_x',
      action_type: 'send_email',
      contact_id: 'c1',
    },
  };

  const result = authorizeStageReview({
    review_id: 'rev_rej',
    stage_id: 'email_send',
    asset_version: 'av_rej',
    decision: 'reject',
    account_id: 'acct_rej',
    existing,
    lifecycle_stage: 'contacted',
    notes: 'claims wrong',
  });

  assert.ok(result && 'patch' in result);
  assert.equal(result.reason, 'rejected_review');
  assert.equal(result.patch.account_sequence_state, 'paused_repair');
  assert.equal(result.patch.work_state, 'channel_repair');
  assert.equal(result.authorization.status, 'rejected');

  const na = JSON.parse(result.patch.next_action_json);
  assert.equal(na.action_type, 'human_review_repair');
  assert.equal(na.sequence_state, 'paused_repair');
  // Must NOT leave stuck pending_human_review
  assert.notEqual(na.action_type, 'pending_human_review');
  assert.notEqual(result.patch.account_sequence_state, 'paused_review');
  assert.ok(
    String(na.reason).includes('claims wrong') || String(na.reason) === 'rejected_review',
  );
});

test('authorizeStageReview reject with recycle skip_action installs recycle path', () => {
  const existing = {
    review_id: 'rev_rec',
    stage_id: 'mail_1',
    asset_version: 'av1',
    status: 'pending',
    account_id: 'acct_rec',
    contact_id: null,
  };
  const result = authorizeStageReview({
    review_id: 'rev_rec',
    stage_id: 'mail_1',
    asset_version: 'av1',
    decision: 'reject',
    account_id: 'acct_rec',
    existing,
    lifecycle_stage: 'contacted',
    skip_action: {
      action_type: 'recycle_monitor',
      sequence_state: 'recycle_wait',
      work_state: 'waiting_time_or_event',
      reason: 'reject_to_recycle',
    },
  });
  assert.ok(result && 'patch' in result);
  assert.equal(result.reason, 'rejected_review');
  assert.equal(result.patch.account_sequence_state, 'recycle_wait');
  assert.equal(JSON.parse(result.patch.next_action_json).action_type, 'recycle_monitor');
});

// ── 4. Reply queue ─────────────────────────────────────────────────────────

test('listReplyQueue: inbound_pending_human_review or paused_inbound+proposed', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();

  seedRecord(db, {
    _row_id: 'reply_pending',
    account_sequence_state: 'paused_inbound',
    work_state: 'human_commercial_followup',
  });
  seedRecord(db, {
    _row_id: 'reply_proposed',
    account_sequence_state: 'paused_inbound',
    work_state: 'human_commercial_followup',
  });
  seedRecord(db, {
    _row_id: 'reply_none',
    account_sequence_state: 'active',
    work_state: 'idle',
  });

  db.prepare(`
    UPDATE records SET inbound_pending_human_review = 1,
      inbound_proposed_classification = 'interested',
      reply_classification_latest = 'interested',
      updated_at = ?
    WHERE _row_id = 'reply_pending'
  `).run(now);
  db.prepare(`
    UPDATE records SET inbound_pending_human_review = 0,
      inbound_proposed_classification = 'objection',
      updated_at = ?
    WHERE _row_id = 'reply_proposed'
  `).run(now);

  const q = listReplyQueue({ db, limit: 50 });
  assert.equal(q.queue, 'reply');
  const ids = q.items.map((i) => i.record_id);
  assert.ok(ids.includes('reply_pending'), `expected reply_pending: ${ids.join(',')}`);
  assert.ok(ids.includes('reply_proposed'), `expected reply_proposed: ${ids.join(',')}`);
  assert.ok(!ids.includes('reply_none'), 'active with no inbound flag must not appear');

  const viaDispatch = listWorkQueue({ db, queue: 'reply' });
  assert.equal(viaDispatch.queue, 'reply');
  assert.ok(viaDispatch.total >= 2);

  assert.ok(WORK_QUEUE_NAMES.includes('reply'));

  // Command wrappers
  const cmd = workQueuesCommand({ list: listDir, queue: 'reply' });
  assert.equal(cmd.queue, 'reply');
  assert.ok(cmd.items.some((i) => i.record_id === 'reply_pending'));

  const alias = queueReplyCommand({ list: listDir });
  assert.equal(alias.queue, 'reply');
  assert.ok(alias.total >= 2);

  db.close();
});

// ── 5. Audit export decision replay ────────────────────────────────────────

test('exportAuditLog: includes decision-replay fields', () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  seedRecord(db, {
    _row_id: 'aud_1',
    fit_score: 91,
    treatment_tier: 'A',
  });

  db.prepare(`
    UPDATE records SET
      priority_lane = 'priority_outreach',
      priority_rank = 3,
      readiness_json = ?,
      cost_ledger_json = ?,
      stage_review_json = ?,
      transition_audit_json = ?
    WHERE _row_id = 'aud_1'
  `).run(
    JSON.stringify({ ready: false, blockers: ['content_not_ready'] }),
    JSON.stringify({
      account_id: 'aud_1',
      entries: [{ entry_id: 'e1', kind: 'enrichment', amount_usd: 0.4 }],
      total_usd: 1.25,
      enrichment_usd: 0.4,
      execution_usd: 0.85,
      ledger_version: 'tv-cost-ledger-v1',
      updated_at: new Date().toISOString(),
    }),
    JSON.stringify({
      review_id: 'r1',
      stage_id: 'linkedin_1',
      asset_version: 'av1',
      status: 'authorized',
    }),
    JSON.stringify([{ kind: 'human_decision', reason: 'authorized_resume_outbound' }]),
  );

  const pure = exportAuditLog({ db, recordId: 'aud_1' });
  assert.equal(pure.count, 1);
  const rec = pure.records[0];
  assert.equal(rec.record_id, 'aud_1');
  assert.equal(rec.fit_score, 91);
  assert.equal(rec.treatment_tier, 'A');
  assert.equal(rec.priority_lane, 'priority_outreach');
  assert.equal(rec.priority_rank, 3);
  assert.deepEqual(rec.readiness_blockers, ['content_not_ready']);
  assert.ok(rec.cost_ledger_summary);
  assert.equal(rec.cost_ledger_summary.total_usd, 1.25);
  assert.equal(rec.cost_ledger_summary.enrichment_usd, 0.4);
  assert.equal(rec.cost_ledger_summary.execution_usd, 0.85);
  assert.equal(rec.cost_ledger_summary.entry_count, 1);
  assert.equal(rec.stage_review.stage_id, 'linkedin_1');
  assert.ok(rec.readiness);

  const cmd = auditExportCommand({ list: listDir, record: 'aud_1' });
  assert.equal(cmd.records[0].fit_score, 91);
  assert.ok(Array.isArray(cmd.records[0].readiness_blockers));
  assert.ok(cmd.records[0].cost_ledger_summary?.total_usd === 1.25);

  db.close();
});
