/**
 * RES-CHANNEL-COMPLETENESS residual suite.
 *
 * 1. Bounce/DSN: provider bounce → mark email invalid / suppress contact, durable + idempotent
 * 2. Phone leases: claim / release / expire + owner-gated dispose
 * 3. LinkedIn lifecycle: invite_sent / accepted / declined / message_allowed + execute gates
 * 4. Mail provider: allocate → submit → confirm/failed via sink adapter
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  openListDb,
  ensureRecordColumns,
  insertDraft,
  upsertContact,
} from '../dist/orchestrator/runtime/db.js';
import {
  applyEmailBounce,
  detectBounceFromText,
  resolveBounceScope,
  resolveBounceType,
  SOFT_BOUNCE_HARDEN_THRESHOLD,
} from '../dist/orchestrator/policy/bounce.js';
import { processBounceEvent } from '../dist/orchestrator/runtime/bounce-process.js';
import { processInboundReplyText } from '../dist/orchestrator/runtime/inbound-reply-process.js';
import { applyInboundReplyClassification } from '../dist/orchestrator/policy/inbound-reply.js';
import {
  claimCallBoardEntry,
  releaseCallBoardClaim,
  expireCallBoardLeases,
  disposeCallBoardEntry,
  isClaimLeaseActive,
  isCallLeaseOwner,
  callClaimExpiresAt,
  CALL_CLAIM_LEASE_MS,
} from '../dist/orchestrator/operator/call-board.js';
import {
  evaluateLinkedinConnectGate,
  evaluateLinkedinMessageGate,
  applyLinkedinInviteSent,
  applyLinkedinInviteAccepted,
  applyLinkedinInviteDeclined,
  parseLinkedinLifecycleState,
  canTransitionLinkedinLifecycle,
} from '../dist/orchestrator/policy/linkedin-lifecycle.js';
import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';
import {
  createMailProviderSink,
  applyMailSubmitted,
  applyMailConfirmed,
  parseMailProviderStatus,
  listMailSinkPieces,
} from '../dist/orchestrator/channels/mail-provider.js';
import {
  completeManualTask,
  submitMailWithIdempotency,
} from '../dist/orchestrator/pipeline/manual.js';
import {
  getAccountCostTotals,
  releaseAccountCostReservation,
  reserveAccountCost,
  settleAccountCostReservation,
} from '../dist/orchestrator/lib/costs.js';
import {
  buildContactPlan,
  allocateMail,
  parseAccountCampaignFromRecord,
} from '../dist/orchestrator/policy/contact-campaign.js';
import { evaluateCampaignProcess } from '../dist/orchestrator/policy/campaign-process.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const projectYaml = `
list:
  name: Channel Completeness
business:
  name: Mission
  description: Test
  icp: Test
  offer: Test
pipeline:
  - kind: pipeline
    id: tier_a
    steps:
      - kind: linkedin_connect
        id: linkedin_1
        side_effecting: true
        config:
          channel: linkedin
      - kind: manual_task
        id: mail_standard
        config:
          task_type: standard_postcard
          channel: mail
sequences:
  default:
    steps: []
policy:
  version: tv-pipeline-v1
  enforce_readiness: false
channels:
  linkedin:
    connect_cooldown_hours: 24
  mail:
    provider: sink
`;

const nextActionJson = (accountId) => JSON.stringify({
  action_id: `na_${accountId}`,
  action_type: 'prepare_outbound',
  account_id: accountId,
  contact_id: 'c1',
  lifecycle_stage: 'contacted',
  sequence_state: 'active',
  work_state: 'executing_external_action',
  reason: 'channel-completeness fixture',
  on_success: 'continue',
});

const createList = (recordOverrides = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-ch-complete-'));
  mkdirSync(join(listDir, 'mail-sink'), { recursive: true });
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml);
  writeFileSync(join(listDir, 'operator.md'), 'channel completeness');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const base = {
    _row_id: 'cc_fixture_1',
    business_name: 'Completeness HVAC',
    contact_email: 'owner@example-cc.test',
    contact_name: 'Pat Owner',
    contact_phone: '208-555-0100',
    phone: '208-555-0100',
    address: '1 Main St',
    city: 'Boise',
    state: 'ID',
    zip: '83702',
    fit_score: 80,
    identity_confidence: 90,
    email_confidence: 80,
    treatment_tier: 'A',
    eligibility_outcome: 'eligible',
    lifecycle_stage: 'contacted',
    account_sequence_state: 'active',
    sequence_status: 'active',
    sequence_name: 'default',
    pipeline_name: 'tier_a',
    active_contact_id: 'c1',
    contact_id: 'c1',
    next_action_json: nextActionJson('cc_fixture_1'),
    linkedin_url: 'https://www.linkedin.com/in/pat-owner',
    _created_at: now,
    _updated_at: now,
    created_at: now,
    updated_at: now,
    ...recordOverrides,
  };
  ensureRecordColumns({ db, columns: Object.keys(base) });
  const cols = Object.keys(base);
  db.prepare(
    `INSERT INTO records (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
  ).run(...cols.map((k) => base[k]));
  return { listDir, db, now };
};

const seedContact = ({ db, rowId, contactId, email, title = 'Manager', primary = false }) => {
  upsertContact({
    db,
    contact: {
      row_id: rowId,
      contact_id: contactId,
      name: contactId,
      title,
      email,
      is_primary: primary ? 1 : 0,
      email_verification_status: 'valid',
      email_verification_confidence: 100,
    },
  });
};

// ---------------------------------------------------------------------------
// 1. Bounce / DSN
// ---------------------------------------------------------------------------

test('bounce: detectBounceFromText hard/soft/null', () => {
  assert.equal(detectBounceFromText('Delivery Status Notification: user unknown 5.1.1'), 'hard');
  assert.equal(detectBounceFromText('Mailbox full — temporary failure 4.2.2'), 'soft');
  assert.equal(detectBounceFromText('Thanks for reaching out, interested in a call'), null);
  assert.equal(detectBounceFromText('Out of office until Monday'), null);
  assert.equal(resolveBounceType({ classification: 'bounce' }), 'hard');
});

test('bounce: recipient-specific hard failure is contact-scoped in pure policy', () => {
  const applied = applyEmailBounce({
    record: {
      _row_id: 'b1',
      active_contact_id: 'c1',
      contact_email: 'bad@example.test',
      lifecycle_stage: 'contacted',
      account_sequence_state: 'active',
      sequence_status: 'active',
    },
    bounceType: 'hard',
    source: 'dsn',
    messageId: 'dsn_msg_1',
    snippet: 'user unknown',
  });
  assert.equal(applied.bounce_type, 'hard');
  assert.equal(applied.scope, 'contact');
  assert.equal(applied.already_applied, false);
  assert.equal(Number(applied.patch.email_bounced), 0);
  assert.equal(applied.patch.email_status, '');
  assert.equal(applied.patch.email_bounce_type, 'hard');
  assert.equal(Number(applied.patch.dne_email), 0);
  assert.equal(applied.sequence_status, 'active');
  assert.equal(applied.patch.account_sequence_state, 'active');
  assert.ok(applied.patch.suppressed_contact_ids.includes('c1'));
  assert.equal(resolveBounceScope({ contactId: 'c1', snippet: '550 relay denied for domain' }), 'account');
  assert.equal(resolveBounceScope({ contactId: 'c1', snippet: 'untyped DSN failure' }), 'account');
});

test('bounce: soft hardens after threshold; processBounceEvent is idempotent', () => {
  const { db } = createList({ _row_id: 'b_soft', contact_email: 'soft@example.test' });
  ensureRecordColumns({
    db,
    columns: [
      'email_bounced', 'email_status', 'email_bounce_type', 'email_soft_bounce_count',
      'dne_email', 'suppressed_contact_ids_json', 'email_last_bounce_message_id',
    ],
  });

  let last;
  for (let i = 0; i < SOFT_BOUNCE_HARDEN_THRESHOLD; i += 1) {
    last = processBounceEvent({
      db,
      recordId: 'b_soft',
      messageId: `soft_msg_${i}`,
      bounceType: 'soft',
      source: 'smtp',
      snippet: 'mailbox full temporary failure',
    });
  }
  assert.equal(last.bounce_type, 'hard');
  assert.equal(last.hardened_from_soft, true);
  assert.equal(Number(last.record.email_soft_bounce_count), SOFT_BOUNCE_HARDEN_THRESHOLD);

  // Same messageId again → no-op
  const replay = processBounceEvent({
    db,
    recordId: 'b_soft',
    messageId: `soft_msg_${SOFT_BOUNCE_HARDEN_THRESHOLD - 1}`,
    bounceType: 'soft',
    source: 'smtp',
  });
  assert.equal(replay.already_applied, true);
  assert.equal(Number(replay.record.email_soft_bounce_count), SOFT_BOUNCE_HARDEN_THRESHOLD);
  db.close();
});

test('bounce: processInboundReplyText routes DSN text without inventing reply engagement', async () => {
  const { db } = createList({ _row_id: 'b_dsn', email_thread_id: 'thr_dsn' });
  seedContact({
    db,
    rowId: 'b_dsn',
    contactId: 'c1',
    email: 'owner@example-cc.test',
    title: 'Owner',
    primary: true,
  });
  const out = await processInboundReplyText({
    db,
    recordId: 'b_dsn',
    replyText: 'Mail Delivery Failed: Delivery Status Notification — user unknown 5.1.1',
    messageId: 'dsn_inbound_1',
    threadId: 'thr_dsn',
  });
  assert.equal(out.classification, 'bounce');
  assert.equal(out.sequence_status, 'active');
  assert.equal(Number(out.record.email_bounced), 0);
  assert.equal(Number(out.record.dne_email), 0);
  assert.equal(Number(db.prepare('SELECT dne_email FROM contacts WHERE contact_id = ?').get('c1').dne_email), 1);

  // Idempotent reprocess
  const again = await processInboundReplyText({
    db,
    recordId: 'b_dsn',
    replyText: 'Mail Delivery Failed: Delivery Status Notification — user unknown 5.1.1',
    messageId: 'dsn_inbound_1',
    threadId: 'thr_dsn',
  });
  assert.equal(again.classification, 'bounce');
  assert.equal(Number(again.record.email_bounced), 0);

  const events = db.prepare(
    `SELECT action, disposition FROM channel_events WHERE row_id = ?`,
  ).all('b_dsn');
  const bounces = events.filter((e) => e.action === 'bounce_detected');
  assert.equal(bounces.length, 1, 'exactly one durable bounce event');
  db.close();
});

test('bounce: classifier path via applyInboundReplyClassification uses shared bounce policy', () => {
  const applied = applyInboundReplyClassification({
    record: {
      _row_id: 'b_cls',
      active_contact_id: 'c9',
      lifecycle_stage: 'contacted',
      account_sequence_state: 'active',
    },
    classification: 'bounce',
    snippet: 'returned mail: permanent failure',
    messageId: 'cls_bounce_1',
  });
  assert.equal(applied.sequence_status, 'bounced');
  assert.equal(Number(applied.patch.email_bounced), 1);
  assert.equal(applied.channel_event.action, 'bounce_detected');
  assert.deepEqual(applied.patch.suppressed_contact_ids, []);
});

test('bounce: recipient hard bounce suppresses one contact and rotates to the next eligible contact', () => {
  const plan = buildContactPlan({
    account_id: 'bounce_rotate',
    campaign_id: 'bounce_rotate_campaign',
    treatment_tier: 'A',
    contacts: [
      { contact_id: 'c_owner', outbound_disposition: 'eligible_target', outreach_rank: 1 },
      { contact_id: 'c_manager', outbound_disposition: 'eligible_target', outreach_rank: 2 },
    ],
  });
  const { db } = createList({
    _row_id: 'bounce_rotate',
    active_contact_id: 'c_owner',
    contact_id: 'c_owner',
    account_contact_plan_json: JSON.stringify(plan),
  });
  seedContact({ db, rowId: 'bounce_rotate', contactId: 'c_owner', email: 'owner@example.test', title: 'Owner', primary: true });
  seedContact({ db, rowId: 'bounce_rotate', contactId: 'c_manager', email: 'manager@example.test', title: 'Service Manager' });

  const applied = processBounceEvent({
    db,
    recordId: 'bounce_rotate',
    messageId: 'bounce_rotate_1',
    bounceType: 'hard',
    snippet: '550 5.1.1 user unknown',
    bounceAt: '2026-08-07T16:00:00.000Z',
  });

  const campaign = parseAccountCampaignFromRecord(applied.record);
  assert.equal(applied.scope, 'contact');
  assert.equal(applied.rotated, true);
  assert.equal(Number(applied.record.dne_email), 0);
  assert.equal(campaign.active_contact_id, 'c_manager');
  assert.deepEqual(campaign.held_contact_ids, []);
  assert.equal(Number(db.prepare('SELECT dne_email FROM contacts WHERE contact_id = ?').get('c_owner').dne_email), 1);
  assert.equal(Number(db.prepare('SELECT dne_email FROM contacts WHERE contact_id = ?').get('c_manager').dne_email), 0);
  db.close();
});

test('bounce: only-contact recipient hard bounce leaves no eligible email target', () => {
  const plan = buildContactPlan({
    account_id: 'bounce_only',
    campaign_id: 'bounce_only_campaign',
    treatment_tier: 'A',
    contacts: [{ contact_id: 'c_only', outbound_disposition: 'eligible_target', outreach_rank: 1 }],
  });
  const { db } = createList({
    _row_id: 'bounce_only',
    active_contact_id: 'c_only',
    contact_id: 'c_only',
    account_contact_plan_json: JSON.stringify(plan),
  });
  seedContact({ db, rowId: 'bounce_only', contactId: 'c_only', email: 'only@example.test', title: 'Owner', primary: true });

  const applied = processBounceEvent({
    db,
    recordId: 'bounce_only',
    messageId: 'bounce_only_1',
    bounceType: 'hard',
    snippet: 'recipient rejected: user unknown',
  });

  const campaign = parseAccountCampaignFromRecord(applied.record);
  assert.equal(applied.scope, 'contact');
  assert.equal(campaign.active_contact_id, null);
  assert.deepEqual(campaign.held_contact_ids, []);
  assert.equal(Number(db.prepare('SELECT dne_email FROM contacts WHERE contact_id = ?').get('c_only').dne_email), 1);
  db.close();
});

test('bounce: domain-level failure closes the account email channel', () => {
  const { db } = createList({ _row_id: 'bounce_domain' });
  seedContact({ db, rowId: 'bounce_domain', contactId: 'c1', email: 'owner@example.test', title: 'Owner', primary: true });

  const applied = processBounceEvent({
    db,
    recordId: 'bounce_domain',
    messageId: 'bounce_domain_1',
    bounceType: 'hard',
    snippet: '550 relay denied: no MX record for recipient domain',
  });

  assert.equal(applied.scope, 'account');
  assert.equal(applied.sequence_status, 'bounced');
  assert.equal(Number(applied.record.dne_email), 1);
  assert.equal(Number(db.prepare('SELECT dne_email FROM contacts WHERE contact_id = ?').get('c1').dne_email), 0);
  db.close();
});

test('bounce: rotation preserves quiet period and per-contact allowance gates', () => {
  const plan = buildContactPlan({
    account_id: 'bounce_cadence',
    campaign_id: 'bounce_cadence_campaign',
    treatment_tier: 'A',
    contacts: [
      { contact_id: 'c_first', outbound_disposition: 'eligible_target', outreach_rank: 1 },
      { contact_id: 'c_next', outbound_disposition: 'eligible_target', outreach_rank: 2 },
    ],
  });
  const bouncedAt = '2026-08-07T16:00:00.000Z';
  const { db } = createList({
    _row_id: 'bounce_cadence',
    active_contact_id: 'c_first',
    contact_id: 'c_first',
    automated_actions_used: 999,
    account_contact_plan_json: JSON.stringify(plan),
  });
  seedContact({ db, rowId: 'bounce_cadence', contactId: 'c_first', email: 'first@example.test', title: 'Owner', primary: true });
  seedContact({ db, rowId: 'bounce_cadence', contactId: 'c_next', email: 'next@example.test', title: 'Manager' });

  const applied = processBounceEvent({
    db,
    recordId: 'bounce_cadence',
    messageId: 'bounce_cadence_1',
    bounceType: 'hard',
    snippet: 'user unknown',
    bounceAt: bouncedAt,
  });
  const campaign = parseAccountCampaignFromRecord(applied.record);
  const immediatelyAfterRotation = evaluateCampaignProcess({
    campaign,
    treatment_tier: 'A',
    automated_actions_used: Number(applied.record.automated_actions_used),
    last_rotation_at: String(applied.record.last_contact_rotation_at),
    asOf: bouncedAt,
  });
  const afterQuietPeriodAtAllowance = evaluateCampaignProcess({
    campaign,
    treatment_tier: 'A',
    automated_actions_used: 999,
    last_rotation_at: String(applied.record.last_contact_rotation_at),
    asOf: '2026-08-12T16:00:00.000Z',
  });

  assert.equal(Number(applied.record.automated_actions_used), 0);
  assert.ok(immediatelyAfterRotation.blockers.some((blocker) => blocker.startsWith('inter_contact_quiet_period:')));
  assert.ok(afterQuietPeriodAtAllowance.blockers.some((blocker) => blocker.startsWith('per_contact_allowance_exceeded:')));
  db.close();
});

// ---------------------------------------------------------------------------
// 2. Phone leases
// ---------------------------------------------------------------------------

/** Wednesday 10:00 America/Boise — claim path enforces attempt window. */
const BOISE_BUSINESS_MS = Date.parse('2026-08-05T16:00:00.000Z');
const BOISE_PHONE_POLICY = { timeZone: 'America/Boise' };

test('phone lease: claim / release / expire + owner gate on dispose', () => {
  const { db } = createList({
    _row_id: 'phone_1',
    contact_phone: '208-555-0199',
    phone: '208-555-0199',
    treatment_tier: 'A',
    next_action_json: JSON.stringify({
      action_id: 'na_call',
      action_type: 'call_human',
      account_id: 'phone_1',
      lifecycle_stage: 'contacted',
      sequence_state: 'active',
      work_state: 'human_commercial_followup',
      reason: 'phone work',
      on_success: 'continue',
      channel: 'phone',
    }),
  });
  ensureRecordColumns({
    db,
    columns: [
      'call_claim_status', 'call_claimed_by', 'call_claimed_at', 'call_claim_expires_at',
      'call_attempt_count', 'call_disposition',
    ],
  });

  const claimed = claimCallBoardEntry({
    db,
    recordId: 'phone_1',
    claimedBy: 'alice',
    nowMs: BOISE_BUSINESS_MS,
    phonePolicy: BOISE_PHONE_POLICY,
  });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.claimed_by, 'alice');
  assert.ok(claimed.claim_expires_at);
  const row = db.prepare('SELECT * FROM records WHERE _row_id=?').get('phone_1');
  assert.equal(isClaimLeaseActive(row), true);
  assert.equal(isCallLeaseOwner(row, 'alice'), true);
  assert.equal(isCallLeaseOwner(row, 'bob'), false);

  // Bob cannot steal claim
  assert.throws(
    () => claimCallBoardEntry({
      db,
      recordId: 'phone_1',
      claimedBy: 'bob',
      nowMs: BOISE_BUSINESS_MS,
      phonePolicy: BOISE_PHONE_POLICY,
    }),
    /Already claimed by alice/i,
  );

  // Bob cannot dispose while alice holds lease
  assert.throws(
    () => disposeCallBoardEntry({
      db,
      recordId: 'phone_1',
      disposition: 'completed',
      disposedBy: 'bob',
    }),
    /lease held by alice/i,
  );

  // Alice can release
  const released = releaseCallBoardClaim({
    db,
    recordId: 'phone_1',
    releasedBy: 'alice',
  });
  assert.equal(released.released, true);
  const afterRelease = db.prepare('SELECT * FROM records WHERE _row_id=?').get('phone_1');
  assert.equal(String(afterRelease.call_claim_status), 'open');
  assert.equal(isClaimLeaseActive(afterRelease), false);

  // Re-claim and expire
  claimCallBoardEntry({
    db,
    recordId: 'phone_1',
    claimedBy: 'carol',
    nowMs: BOISE_BUSINESS_MS,
    phonePolicy: BOISE_PHONE_POLICY,
  });
  // Force expiry by backdating lease
  ensureRecordColumns({ db, columns: ['call_claim_expires_at'] });
  db.prepare(`UPDATE records SET call_claim_expires_at = ? WHERE _row_id = ?`).run(
    new Date(Date.now() - 60_000).toISOString(),
    'phone_1',
  );
  const expired = expireCallBoardLeases({ db });
  assert.ok(expired.expired >= 1);
  assert.ok(expired.record_ids.includes('phone_1'));
  const open = db.prepare('SELECT * FROM records WHERE _row_id=?').get('phone_1');
  assert.equal(String(open.call_claim_status), 'open');
  assert.equal(String(open.call_claimed_by || ''), '');

  // After expire, bob may claim and dispose
  claimCallBoardEntry({
    db,
    recordId: 'phone_1',
    claimedBy: 'bob',
    nowMs: BOISE_BUSINESS_MS,
    phonePolicy: BOISE_PHONE_POLICY,
  });
  const disposed = disposeCallBoardEntry({
    db,
    recordId: 'phone_1',
    disposition: 'completed',
    disposedBy: 'bob',
  });
  assert.equal(disposed.ok, true);
  assert.equal(disposed.call_attempt_count, 1);
  db.close();
});

test('phone lease: callClaimExpiresAt uses default 2h window', () => {
  const from = Date.parse('2026-08-01T12:00:00.000Z');
  const exp = callClaimExpiresAt(from);
  assert.equal(Date.parse(exp) - from, CALL_CLAIM_LEASE_MS);
});

// ---------------------------------------------------------------------------
// 3. LinkedIn lifecycle
// ---------------------------------------------------------------------------

test('linkedin lifecycle: transitions + connect/message gates', () => {
  assert.equal(canTransitionLinkedinLifecycle('none', 'invite_sent'), true);
  assert.equal(canTransitionLinkedinLifecycle('invite_sent', 'accepted'), true);
  assert.equal(canTransitionLinkedinLifecycle('invite_sent', 'declined'), true);
  assert.equal(canTransitionLinkedinLifecycle('declined', 'invite_sent'), false);

  let record = { _row_id: 'li1' };
  assert.equal(parseLinkedinLifecycleState(record), 'none');
  assert.equal(evaluateLinkedinConnectGate(record).allowed, true);

  const sent = applyLinkedinInviteSent({ record, providerId: 'inv_1' });
  record = sent.patch;
  assert.equal(sent.state, 'invite_sent');
  assert.equal(evaluateLinkedinConnectGate(record).allowed, false);
  assert.match(evaluateLinkedinConnectGate(record).reason, /invite_already_sent|already/);
  assert.equal(evaluateLinkedinMessageGate(record).allowed, false);

  const accepted = applyLinkedinInviteAccepted({ record });
  record = accepted.patch;
  assert.equal(accepted.state, 'message_allowed');
  assert.equal(evaluateLinkedinConnectGate(record).allowed, false);
  assert.equal(evaluateLinkedinConnectGate(record).reason, 'linkedin_already_connected');
  assert.equal(evaluateLinkedinMessageGate(record).allowed, true);

  const declined = applyLinkedinInviteDeclined({
    record: applyLinkedinInviteSent({ record: { _row_id: 'li2' }, providerId: 'x' }).patch,
  });
  assert.equal(declined.state, 'declined');
  assert.equal(evaluateLinkedinConnectGate(declined.patch).allowed, false);
  assert.equal(evaluateLinkedinConnectGate(declined.patch).reason, 'linkedin_lifecycle_declined');
});

test('linkedin lifecycle: executeChannelStep honors invite_sent + sets lifecycle on send', async () => {
  const prevKey = process.env.UNIPILE_API_KEY;
  const prevDsn = process.env.UNIPILE_DSN;
  const prevFix = process.env.AO_UNIPILE_FIXTURE;
  process.env.UNIPILE_API_KEY = 'test-key';
  process.env.UNIPILE_DSN = 'https://api.unipile.test';
  process.env.AO_UNIPILE_FIXTURE = '1';
  try {
    const { listDir, db } = createList({ _row_id: 'li_exec' });
    const record = db.prepare('SELECT * FROM records WHERE _row_id=?').get('li_exec');

    const sent = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Channel Completeness',
      db,
      record,
      sequenceName: 'default',
      stepNumber: 1,
      step: { kind: 'linkedin_connect', id: 'linkedin_1', config: { channel: 'linkedin' } },
      sequence: { steps: [] },
      channelHint: 'linkedin',
      intent: 'send',
    });
    assert.equal(sent.status, 'sent');
    const after = db.prepare('SELECT * FROM records WHERE _row_id=?').get('li_exec');
    assert.equal(String(after.linkedin_lifecycle_state), 'invite_sent');
    assert.ok(String(after.linkedin_last_provider_id || '').startsWith('unipile_fixture_'));

    // Lifecycle gate alone refuses re-invite (independent of wait/succession).
    const gate = evaluateLinkedinConnectGate(after);
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /invite_already_sent|already/);

    // Production execute also skips when outbound is allowed again but lifecycle blocks.
    db.prepare(`UPDATE records SET next_action_json = ?, account_sequence_state = 'active' WHERE _row_id = ?`)
      .run(nextActionJson('li_exec'), 'li_exec');
    const reseeded = db.prepare('SELECT * FROM records WHERE _row_id=?').get('li_exec');
    const again = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Channel Completeness',
      db,
      record: reseeded,
      sequenceName: 'default',
      stepNumber: 1,
      step: { kind: 'linkedin_connect', id: 'linkedin_1', config: { channel: 'linkedin' } },
      sequence: { steps: [] },
      channelHint: 'linkedin',
      intent: 'send',
    });
    assert.equal(again.status, 'skipped');
    assert.match(String(again.reason), /already|invite/i);

    // Declined blocks connect (lifecycle runs after contact assert — seed active contact).
    ensureRecordColumns({
      db,
      columns: [
        'linkedin_lifecycle_state', 'linkedin_url', 'identity_confidence', 'fit_score',
        'treatment_tier', 'eligibility_outcome', 'active_contact_id', 'contact_id', 'next_action_json',
      ],
    });
    db.prepare(`
      INSERT INTO records (
        _row_id, business_name, sequence_name, sequence_status, account_sequence_state,
        linkedin_lifecycle_state, linkedin_url, active_contact_id, contact_id,
        identity_confidence, fit_score, treatment_tier, eligibility_outcome,
        next_action_json, _created_at, _updated_at, created_at, updated_at
      ) VALUES (
        'li_dec', 'Dec', 'default', 'active', 'active',
        'declined', ?, 'c1', 'c1',
        90, 80, 'A', 'eligible',
        ?, datetime('now'), datetime('now'), datetime('now'), datetime('now')
      )
    `).run('https://www.linkedin.com/in/dec', nextActionJson('li_dec'));
    const decRow = db.prepare('SELECT * FROM records WHERE _row_id=?').get('li_dec');
    assert.equal(evaluateLinkedinConnectGate(decRow).reason, 'linkedin_lifecycle_declined');
    const blocked = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Channel Completeness',
      db,
      record: decRow,
      sequenceName: 'default',
      stepNumber: 1,
      step: { kind: 'linkedin_connect', id: 'linkedin_1', config: { channel: 'linkedin' } },
      sequence: { steps: [] },
      channelHint: 'linkedin',
      intent: 'send',
    });
    assert.equal(blocked.status, 'skipped');
    assert.equal(blocked.reason, 'linkedin_lifecycle_declined');
    db.close();
  } finally {
    if (prevKey === undefined) delete process.env.UNIPILE_API_KEY;
    else process.env.UNIPILE_API_KEY = prevKey;
    if (prevDsn === undefined) delete process.env.UNIPILE_DSN;
    else process.env.UNIPILE_DSN = prevDsn;
    if (prevFix === undefined) delete process.env.AO_UNIPILE_FIXTURE;
    else process.env.AO_UNIPILE_FIXTURE = prevFix;
  }
});

// ---------------------------------------------------------------------------
// 4. Mail provider path
// ---------------------------------------------------------------------------

test('mail provider: sink allocate → submit → confirm', async () => {
  const { listDir, db, now } = createList({ _row_id: 'mail_1' });
  const campaign = buildContactPlan({
    account_id: 'mail_1',
    campaign_id: 'camp_mail_1',
    contacts: [{ contact_id: 'c1', outbound_disposition: 'eligible_target', outreach_rank: 1 }],
    treatment_tier: 'A',
    mail_treatment: 'standard_postcard',
  });
  ensureRecordColumns({
    db,
    columns: [
      'account_contact_plan_json', 'mail_treatment', 'mail_allocated', 'mail_allocated_at',
      'mail_provider_status', 'mail_last_piece_id',
    ],
  });
  db.prepare(`
    UPDATE records SET account_contact_plan_json = ?, mail_treatment = 'standard_postcard', mail_allocated = 0
    WHERE _row_id = 'mail_1'
  `).run(JSON.stringify(campaign));

  try {
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
      VALUES ('mail_park_1', 'mail_1', 'mail_standard', 'manual_task', 0, 'awaiting_manual', ?)
    `).run(now);
  } catch {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_events (
        event_id TEXT PRIMARY KEY,
        record_id TEXT,
        step_id TEXT,
        kind TEXT,
        passed INTEGER,
        reason TEXT,
        occurred_at TEXT
      )
    `);
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
      VALUES ('mail_park_1', 'mail_1', 'mail_standard', 'manual_task', 0, 'awaiting_manual', ?)
    `).run(now);
  }

  const sink = createMailProviderSink({ sinkDir: join(listDir, 'mail-sink') });
  const completed = await completeManualTask({
    db,
    listDir,
    recordId: 'mail_1',
    stepId: 'mail_standard',
    note: 'mailed via sink',
    mailProvider: sink,
  });
  assert.equal(completed.status, 'manual_completed');
  assert.equal(completed.mail_allocated, true);
  assert.equal(completed.mail_provider_status, 'submitted');
  assert.ok(completed.mail_piece_id);

  const row = db.prepare('SELECT * FROM records WHERE _row_id=?').get('mail_1');
  assert.equal(Number(row.mail_allocated), 1);
  assert.equal(String(row.mail_provider_status), 'submitted');
  assert.ok(String(row.mail_last_piece_id).startsWith('sink_piece_'));
  assert.equal(parseMailProviderStatus(row), 'submitted');
  assert.ok(listMailSinkPieces(join(listDir, 'mail-sink')).length >= 1);

  const status = await sink.getStatus(String(row.mail_last_piece_id));
  const confirmed = applyMailConfirmed({ record: row, statusResult: status });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.patch.mail_provider_status, 'confirmed');

  // allocate once
  const plan = parseAccountCampaignFromRecord(row);
  assert.equal(plan.mail_allocated, true);
  assert.throws(() => allocateMail({ campaign: plan, mail_treatment: 'standard_postcard' }));

  // Failed submit path
  const failSink = createMailProviderSink({
    sinkDir: join(listDir, 'mail-sink-fail'),
    failSubmit: true,
  });
  const failApplied = applyMailSubmitted({
    record: { _row_id: 'x', mail_allocated: 1 },
    result: await failSink.submit({
      recordId: 'x',
      treatment: 'standard_postcard',
      to: { name: 'x' },
    }),
  });
  assert.equal(failApplied.status, 'failed');
  db.close();
});

test('mail provider: accepted submission is idempotent across caller replay', async () => {
  const { db } = createList({ _row_id: 'mail_idempotent_1' });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('mail_idempotent_1');
  const calls = [];
  const provider = {
    name: 'mail_fixture',
    submit: async (request) => {
      calls.push(request);
      return {
        ok: true,
        piece_id: 'piece_idempotent_1',
        status: 'submitted',
        reason: 'accepted',
        cost_cents: 125,
        provider: 'mail_fixture',
      };
    },
    getStatus: async (pieceId) => ({
      piece_id: pieceId,
      status: 'submitted',
      reason: 'accepted',
      provider: 'mail_fixture',
    }),
  };
  const request = {
    recordId: 'mail_idempotent_1',
    treatment: 'standard_postcard',
    to: {
      name: 'Channel Fixture',
      address_line_1: '100 Main St',
      address_city: 'Boise',
      address_state: 'ID',
      address_zip: '83702',
    },
    template_id: 'postcard_v1',
    metadata: { step_id: 'mail_standard' },
  };

  const first = await submitMailWithIdempotency({
    db,
    provider,
    request,
    record,
    stepId: 'mail_standard',
    contentVersion: 'postcard_asset_v1',
  });
  const replay = await submitMailWithIdempotency({
    db,
    provider,
    request,
    record,
    stepId: 'mail_standard',
    contentVersion: 'postcard_asset_v1',
  });
  assert.equal(first.piece_id, 'piece_idempotent_1');
  assert.equal(replay.piece_id, first.piece_id);
  assert.equal(calls.length, 1);
  assert.equal(
    db.prepare(`SELECT status FROM idempotency WHERE provider_id = ?`).get(first.piece_id).status,
    'sent',
  );
  db.close();
});

test('mail provider: ambiguous network failure becomes uncertain and cannot blind-resend', async () => {
  const { db } = createList({ _row_id: 'mail_uncertain_1' });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('mail_uncertain_1');
  const calls = [];
  const provider = {
    name: 'mail_fixture',
    submit: async (request) => {
      calls.push(request);
      throw new Error('connection_lost_after_submit');
    },
    getStatus: async (pieceId) => ({
      piece_id: pieceId,
      status: 'unknown',
      reason: 'unknown',
      provider: 'mail_fixture',
    }),
  };
  const input = {
    db,
    provider,
    request: {
      recordId: 'mail_uncertain_1',
      treatment: 'golden_ticket',
      to: {
        name: 'Channel Fixture',
        address_line_1: '200 Main St',
        address_city: 'Boise',
        address_state: 'ID',
        address_zip: '83702',
      },
      template_id: 'golden_v1',
      metadata: { step_id: 'mail_golden' },
    },
    record,
    stepId: 'mail_golden',
    contentVersion: 'golden_asset_v1',
  };

  await assert.rejects(() => submitMailWithIdempotency(input), /connection_lost_after_submit/);
  await assert.rejects(
    () => submitMailWithIdempotency(input),
    /provider_uncertain_requires_reconcile/,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    db.prepare(`SELECT status FROM idempotency WHERE status = 'uncertain'`).get().status,
    'uncertain',
  );
  db.close();
});

test('cost reservations: reserve, release, settle, replay, ceiling, and high-cost gates are durable', () => {
  const { db } = createList({
    _row_id: 'cost_reservation_1',
    golden_ticket_eligible: 1,
  });
  const standard = reserveAccountCost({
    db,
    recordId: 'cost_reservation_1',
    stepId: 'mail_standard',
    kind: 'mail',
    amountUsd: 1.25,
    ceilingUsd: 10,
    reservationId: 'cost_standard',
  });
  assert.equal(standard.allowed, true);
  assert.equal(standard.totals.reserved_usd, 1.25);

  const ineligible = reserveAccountCost({
    db,
    recordId: 'cost_reservation_1',
    stepId: 'mail_golden',
    kind: 'mail',
    amountUsd: 8,
    ceilingUsd: 10,
    reservationId: 'cost_ineligible',
    highCost: true,
    highCostEligible: false,
  });
  assert.equal(ineligible.allowed, false);
  assert.equal(ineligible.reason, 'high_cost_not_eligible');

  const released = releaseAccountCostReservation({
    db,
    reservationId: 'cost_standard',
    reason: 'provider_not_called',
  });
  assert.equal(released.released, true);
  assert.equal(released.totals.exposure_usd, 0);
  assert.equal(
    Number(
      db.prepare(`
        SELECT golden_ticket_eligible FROM records WHERE _row_id = 'cost_reservation_1'
      `).get().golden_ticket_eligible,
    ),
    1,
  );

  const golden = reserveAccountCost({
    db,
    recordId: 'cost_reservation_1',
    stepId: 'mail_golden',
    kind: 'mail',
    amountUsd: 8,
    ceilingUsd: 10,
    reservationId: 'cost_golden',
    highCost: true,
    highCostEligible: true,
  });
  assert.equal(golden.allowed, true, JSON.stringify(golden));

  const settled = settleAccountCostReservation({
    db,
    reservationId: 'cost_golden',
    actualUsd: 7.75,
    provider: 'mail_fixture',
  });
  assert.equal(settled.settled, true);
  assert.deepEqual(getAccountCostTotals({ db, recordId: 'cost_reservation_1' }), {
    record_id: 'cost_reservation_1',
    actual_usd: 7.75,
    reserved_usd: 0,
    exposure_usd: 7.75,
  });
  const replay = settleAccountCostReservation({
    db,
    reservationId: 'cost_golden',
    actualUsd: 7.75,
    provider: 'mail_fixture',
  });
  assert.equal(replay.reason, 'already_settled');
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS n FROM cost_events
      WHERE id = 'cost_reservation_cost_golden'
    `).get().n,
    1,
  );
  db.close();
});

test('channel-completeness package root present', () => {
  assert.ok(existsSync(join(ROOT, 'package.json')));
  assert.ok(existsSync(join(ROOT, 'src/orchestrator/policy/bounce.ts')));
  assert.ok(existsSync(join(ROOT, 'src/orchestrator/policy/linkedin-lifecycle.ts')));
  assert.ok(existsSync(join(ROOT, 'src/orchestrator/channels/mail-provider.ts')));
  assert.ok(existsSync(join(ROOT, 'src/orchestrator/runtime/bounce-process.ts')));
});
