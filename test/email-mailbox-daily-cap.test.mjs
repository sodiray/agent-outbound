/**
 * Per-mailbox email daily caps: reserve-then-act (same channel_daily_cap_reservations
 * table as LinkedIn invites). Proves concurrent selection+send cannot over-send,
 * failed sends release capacity, uncapped mailboxes are untouched, precedence, and
 * round-robin rotation without double-count.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';
import {
  mailboxCapInteractionType,
  releaseChannelDailyCapReservation,
  reserveChannelDailyCap,
} from '../dist/orchestrator/lib/channel-daily-caps.js';
import {
  countMailboxSendsToday,
  loadMailboxesCatalog,
  selectMailboxId,
} from '../dist/orchestrator/lib/mailboxes.js';
import { ensureRecordColumns, openListDb } from '../dist/orchestrator/runtime/db.js';

const now = '2026-08-09T12:00:00.000Z';

const writeMailboxCatalog = (listDir, { dailyCap, pool = ['mb_a'], strategy = 'fixed' } = {}) => {
  const mailboxesDir = join(listDir, 'mailboxes');
  mkdirSync(mailboxesDir, { recursive: true });
  const mailboxes = pool.map((id, index) => {
    const cap = Array.isArray(dailyCap) ? dailyCap[index] : dailyCap;
    const capYaml = cap === undefined ? '' : `\n    daily_cap: ${cap}`;
    return `  - id: ${id}
    label: ${id}
    email: ${id}@example.test
    provider: smtp
    enabled: true${capYaml}
    credentials:
      SMTP_HOST: smtp.example.test
      SMTP_USER: ${id}@example.test
      SMTP_PASS: secret
      SMTP_FROM: ${id}@example.test`;
  }).join('\n');
  writeFileSync(join(mailboxesDir, 'mailboxes.yaml'), `version: 1
selection:
  strategy: ${strategy}
  default: ${pool[0]}
  pool: [${pool.join(', ')}]
mailboxes:
${mailboxes}
`);
  return join(mailboxesDir, 'mailboxes.yaml');
};

const createList = ({ dailyCap, pool, strategy, envDailyCap } = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-email-mailbox-cap-'));
  writeMailboxCatalog(listDir, { dailyCap, pool, strategy });
  writeFileSync(join(listDir, 'outbound.yaml'), `
list:
  name: Email mailbox daily cap
business:
  name: Mission
  description: Test
  icp: Test
  offer: Test
pipeline: []
sequences:
  default:
    steps: []
policy:
  version: test
  enforce_readiness: false
mailboxes:
  dir: mailboxes
  allow_inline_secrets: true
`);
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  if (envDailyCap !== undefined) process.env.AO_EMAIL_DAILY_CAP = String(envDailyCap);
  return { listDir, db: openListDb({ listDir, readonly: false }) };
};

const insertRecord = ({ db, id }) => {
  ensureRecordColumns({
    db,
    columns: [
      'lifecycle_stage', 'treatment_tier', 'eligibility_outcome',
      'active_contact_id', 'account_contact_plan_json', 'contact_email',
    ],
  });
  const contactId = `contact-${id}`;
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, contact_name, contact_email, lifecycle_stage, sequence_name, sequence_status,
      treatment_tier, eligibility_outcome, active_contact_id, account_contact_plan_json,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'contacted', 'default', 'active', 'B', 'eligible', ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `Business ${id}`,
    'Pat Owner',
    `${id}@recipient.test`,
    contactId,
    JSON.stringify({
      active_contact_id: contactId,
      held_contact_ids: [],
      ordered_target_contact_ids: [contactId],
    }),
    now,
    now,
    now,
    now,
  );
  db.prepare(`
    INSERT INTO contacts (
      contact_id, id, row_id, name, full_name, email, created_at, updated_at
    ) VALUES (?, ?, ?, 'Pat Owner', 'Pat Owner', ?, ?, ?)
  `).run(contactId, contactId, id, `${id}@recipient.test`, now, now);
  return db.prepare('SELECT * FROM records WHERE _row_id = ?').get(id);
};

const emailStep = ({ stepId, provider, dailyCap, mailbox }) => ({
  kind: 'send_email',
  id: stepId,
  config: {
    action: 'tool_call',
    tool: {
      server: 'test_provider',
      tools: ['SEND'],
      effect: { class: 'human_contact', channel: 'email' },
    },
    ...(dailyCap !== undefined ? { daily_cap: dailyCap } : {}),
    ...(mailbox ? { mailbox } : {}),
    args: { subject: 'Hello', body: 'Body text for send.' },
    output_map: { message_id: 'message_id', provider_id: 'message_id' },
    idempotency: { key_source: ['_row_id', 'step_id'], scope: 'list' },
    __tryTool: provider,
  },
});

const sendEmail = ({ listDir, db, record, step, at = now }) => executeChannelStep({
  mcp: null,
  listDir,
  listName: 'Email mailbox daily cap',
  toolCatalog: null,
  db,
  record,
  sequenceName: 'default',
  stepNumber: 1,
  step,
  sequence: { steps: [step] },
  channelHint: 'email',
  intent: 'send',
  dryRun: false,
  now: at,
});

const countEmailEvents = (db, mailboxId) => Number(db.prepare(`
  SELECT COUNT(*) AS n
  FROM channel_events
  WHERE channel = 'email'
    AND (action IN ('executed', 'sent') OR event_type IN ('executed', 'sent'))
    AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.mailbox_id') = ?
`).get(mailboxId)?.n || 0);

const countReservations = (db, mailboxId) => Number(db.prepare(`
  SELECT COUNT(*) AS n
  FROM channel_daily_cap_reservations
  WHERE channel = 'email'
    AND interaction_type = ?
    AND status IN ('reserved', 'accepted')
`).get(mailboxCapInteractionType(mailboxId))?.n || 0);

test('concurrent selection+send against mailbox daily_cap:2 yields at most 2 sends', async () => {
  const prevEnv = process.env.AO_EMAIL_DAILY_CAP;
  delete process.env.AO_EMAIL_DAILY_CAP;
  const { listDir, db } = createList({ dailyCap: 2, pool: ['mb_a'], strategy: 'fixed' });
  try {
    // Explicit interleaving: hold every provider call until two workers have
    // passed the cap gate and entered the provider (the third must lose at
    // reserve while those two still hold capacity). Under check-then-act all
    // three could pass a cap of 2 before any event is written; reserve-then-act
    // admits only two provider invocations.
    let inProvider = 0;
    let releaseBarrier;
    const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
    const providerCalls = { n: 0 };

    const provider = async () => {
      inProvider += 1;
      if (inProvider === 2) releaseBarrier();
      await barrier;
      providerCalls.n += 1;
      return {
        result: { message_id: `msg_${providerCalls.n}_${inProvider}`, ok: true },
        provider: 'test_provider',
      };
    };

    const records = ['c1', 'c2', 'c3'].map((id) => insertRecord({ db, id }));
    const results = await Promise.all(records.map((record, index) => sendEmail({
      listDir,
      db,
      record,
      step: emailStep({
        stepId: `email_${index + 1}`,
        provider,
        mailbox: 'mb_a',
      }),
    })));

    const sent = results.filter((r) => r.status === 'sent');
    const skipped = results.filter((r) => r.status === 'skipped');
    assert.equal(sent.length, 2, `expected 2 sends, got ${JSON.stringify(results)}`);
    assert.equal(skipped.length, 1, `expected 1 skip, got ${JSON.stringify(results)}`);
    assert.ok(
      skipped[0].reason.includes('Daily email cap reached'),
      `unexpected skip reason: ${skipped[0].reason}`,
    );
    assert.equal(providerCalls.n, 2, 'provider must not be invoked beyond the cap');
    assert.equal(countEmailEvents(db, 'mb_a'), 2);
    assert.equal(countReservations(db, 'mb_a'), 0, 'accepted reservations must be settled');
  } finally {
    db.close();
    if (prevEnv === undefined) delete process.env.AO_EMAIL_DAILY_CAP;
    else process.env.AO_EMAIL_DAILY_CAP = prevEnv;
  }
});

test('failed send releases mailbox daily-cap reservation so capacity is not leaked', async () => {
  const prevEnv = process.env.AO_EMAIL_DAILY_CAP;
  delete process.env.AO_EMAIL_DAILY_CAP;
  const { listDir, db } = createList({ dailyCap: 1, pool: ['mb_a'], strategy: 'fixed' });
  try {
    const failRecord = insertRecord({ db, id: 'fail-1' });
    const failed = await sendEmail({
      listDir,
      db,
      record: failRecord,
      step: emailStep({
        stepId: 'email_fail',
        mailbox: 'mb_a',
        provider: async () => ({
          result: { ok: false, error: 'smtp_rejected' },
          provider: 'test_provider',
        }),
      }),
    });
    assert.equal(failed.status, 'failed', JSON.stringify(failed));
    assert.equal(countReservations(db, 'mb_a'), 0, 'failed send must release reservation');
    assert.equal(countMailboxSendsToday(db, 'mb_a', now), 0);

    const okRecord = insertRecord({ db, id: 'ok-1' });
    const sent = await sendEmail({
      listDir,
      db,
      record: okRecord,
      step: emailStep({
        stepId: 'email_ok',
        mailbox: 'mb_a',
        provider: async () => ({
          result: { message_id: 'msg_ok', ok: true },
          provider: 'test_provider',
        }),
      }),
    });
    assert.equal(sent.status, 'sent', JSON.stringify(sent));
    assert.equal(countEmailEvents(db, 'mb_a'), 1);
  } finally {
    db.close();
    if (prevEnv === undefined) delete process.env.AO_EMAIL_DAILY_CAP;
    else process.env.AO_EMAIL_DAILY_CAP = prevEnv;
  }
});

test('mailbox with no daily_cap declared is unaffected by reservation path', async () => {
  const prevEnv = process.env.AO_EMAIL_DAILY_CAP;
  // Cap high enough that the legacy global check does not interfere.
  process.env.AO_EMAIL_DAILY_CAP = '50';
  const { listDir, db } = createList({ pool: ['mb_free'], strategy: 'fixed' });
  try {
    const record = insertRecord({ db, id: 'uncapped-1' });
    const out = await sendEmail({
      listDir,
      db,
      record,
      step: emailStep({
        stepId: 'email_uncapped',
        mailbox: 'mb_free',
        provider: async () => ({
          result: { message_id: 'msg_uncapped', ok: true },
          provider: 'test_provider',
        }),
      }),
    });
    assert.equal(out.status, 'sent', JSON.stringify(out));
    const reservations = Number(db.prepare(`
      SELECT COUNT(*) AS n FROM channel_daily_cap_reservations WHERE channel = 'email'
    `).get()?.n || 0);
    assert.equal(reservations, 0, 'uncapped mailbox must not write reservations');
    assert.equal(countEmailEvents(db, 'mb_free'), 1);
  } finally {
    db.close();
    if (prevEnv === undefined) delete process.env.AO_EMAIL_DAILY_CAP;
    else process.env.AO_EMAIL_DAILY_CAP = prevEnv;
  }
});

test('per-mailbox daily_cap takes precedence over AO_EMAIL_DAILY_CAP env default', async () => {
  const prevEnv = process.env.AO_EMAIL_DAILY_CAP;
  process.env.AO_EMAIL_DAILY_CAP = '1';
  // Mailbox allows 2; env would only allow 1 — mailbox must win.
  const { listDir, db } = createList({ dailyCap: 2, pool: ['mb_a'], strategy: 'fixed' });
  try {
    const first = await sendEmail({
      listDir,
      db,
      record: insertRecord({ db, id: 'prec-1' }),
      step: emailStep({
        stepId: 'email_p1',
        mailbox: 'mb_a',
        provider: async () => ({ result: { message_id: 'm1', ok: true }, provider: 'test_provider' }),
      }),
    });
    const second = await sendEmail({
      listDir,
      db,
      record: insertRecord({ db, id: 'prec-2' }),
      step: emailStep({
        stepId: 'email_p2',
        mailbox: 'mb_a',
        provider: async () => ({ result: { message_id: 'm2', ok: true }, provider: 'test_provider' }),
      }),
    });
    const third = await sendEmail({
      listDir,
      db,
      record: insertRecord({ db, id: 'prec-3' }),
      step: emailStep({
        stepId: 'email_p3',
        mailbox: 'mb_a',
        provider: async () => ({ result: { message_id: 'm3', ok: true }, provider: 'test_provider' }),
      }),
    });
    assert.equal(first.status, 'sent', JSON.stringify(first));
    assert.equal(second.status, 'sent', JSON.stringify(second));
    assert.equal(third.status, 'skipped', JSON.stringify(third));
    assert.equal(third.reason, 'Daily email cap reached (2).');
    assert.equal(countEmailEvents(db, 'mb_a'), 2);
  } finally {
    db.close();
    if (prevEnv === undefined) delete process.env.AO_EMAIL_DAILY_CAP;
    else process.env.AO_EMAIL_DAILY_CAP = prevEnv;
  }
});

test('round_robin rotation across a mailbox pool does not double-count capacity', async () => {
  const prevEnv = process.env.AO_EMAIL_DAILY_CAP;
  const prevNow = process.env.AO_NOW;
  delete process.env.AO_EMAIL_DAILY_CAP;
  // Align selection (nowIso) with reserve/send `at` so day_start matches.
  process.env.AO_NOW = now;
  const { listDir, db } = createList({
    dailyCap: [1, 1],
    pool: ['mb_a', 'mb_b'],
    strategy: 'round_robin',
  });
  try {
    const catalog = loadMailboxesCatalog({
      listDir,
      config: { mailboxes: { dir: 'mailboxes', allow_inline_secrets: true } },
    });
    assert.ok(catalog);

    // Explicit check-then-act race on the reserve helper: two concurrent reserves
    // against cap 1 — only one allowed (constructs the interleaving at the lock).
    const r1 = reserveChannelDailyCap({
      db,
      channel: 'email',
      interactionType: mailboxCapInteractionType('mb_a'),
      cap: 1,
      at: now,
      mailboxId: 'mb_a',
    });
    const r2 = reserveChannelDailyCap({
      db,
      channel: 'email',
      interactionType: mailboxCapInteractionType('mb_a'),
      cap: 1,
      at: now,
      mailboxId: 'mb_a',
    });
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, false);
    // Holding the reservation fills mb_a; selection must rotate to mb_b.
    assert.equal(countMailboxSendsToday(db, 'mb_a', now), 1);
    assert.equal(
      selectMailboxId({ catalog, db, record: {}, stepConfig: {}, listDefault: '' }),
      'mb_b',
    );
    releaseChannelDailyCapReservation({ db, reservationId: r1.reservationId });
    assert.equal(countMailboxSendsToday(db, 'mb_a', now), 0);

    // End-to-end: first send uses mb_a (cap 1), second rotates to mb_b — one event each.
    const s1 = await sendEmail({
      listDir,
      db,
      record: insertRecord({ db, id: 'rot-1' }),
      step: emailStep({
        stepId: 'email_r1',
        provider: async () => ({ result: { message_id: 'rot1', ok: true }, provider: 'test_provider' }),
      }),
    });
    const s2 = await sendEmail({
      listDir,
      db,
      record: insertRecord({ db, id: 'rot-2' }),
      step: emailStep({
        stepId: 'email_r2',
        provider: async () => ({ result: { message_id: 'rot2', ok: true }, provider: 'test_provider' }),
      }),
    });
    assert.equal(s1.status, 'sent', JSON.stringify(s1));
    assert.equal(s2.status, 'sent', JSON.stringify(s2));
    assert.equal(countEmailEvents(db, 'mb_a'), 1);
    assert.equal(countEmailEvents(db, 'mb_b'), 1);
    assert.equal(countMailboxSendsToday(db, 'mb_a', now), 1);
    assert.equal(countMailboxSendsToday(db, 'mb_b', now), 1);
  } finally {
    db.close();
    if (prevEnv === undefined) delete process.env.AO_EMAIL_DAILY_CAP;
    else process.env.AO_EMAIL_DAILY_CAP = prevEnv;
    if (prevNow === undefined) delete process.env.AO_NOW;
    else process.env.AO_NOW = prevNow;
  }
});
