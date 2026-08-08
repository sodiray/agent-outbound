import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';
import { ensureRecordColumns, openListDb } from '../dist/orchestrator/runtime/db.js';
import {
  commitLiveInteraction,
  getLiveInteractionBudgetStatus,
  reserveLiveInteraction,
} from '../dist/orchestrator/runtime/live-interaction-budget.js';

const budgetYaml = (budget) => `
list:
  name: Live Interaction Budget Test
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
  enforce_readiness: false
${budget ? `live_interaction_budget:
  max_accounts: ${budget.max_accounts}
  max_interactions: ${budget.max_interactions}
` : ''}`;

const nextAction = (recordId, contactId) => JSON.stringify({
  action_id: `na_${recordId}`,
  action_type: 'send_email',
  account_id: recordId,
  contact_id: contactId,
  lifecycle_stage: 'contacted',
  sequence_state: 'active',
  work_state: 'executing_external_action',
  reason: 'live interaction budget test',
  on_success: 'continue',
});

const createList = ({ budget = null } = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-live-budget-'));
  writeFileSync(join(listDir, 'outbound.yaml'), budgetYaml(budget));
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  return { listDir, db: openListDb({ listDir, readonly: false }) };
};

const insertRecord = ({ db, recordId, contactId = `contact_${recordId}` }) => {
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: ['lifecycle_stage', 'account_sequence_state', 'work_state', 'next_action_json', 'active_contact_id'],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, contact_email,
      lifecycle_stage, account_sequence_state, work_state, next_action_json, active_contact_id,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, ?, 'default', 'active', ?, 'contacted', 'active', 'executing_external_action', ?, ?, ?, ?, ?, ?)
  `).run(
    recordId,
    `Business ${recordId}`,
    `${recordId}@example.test`,
    nextAction(recordId, contactId),
    contactId,
    now,
    now,
    now,
    now,
  );
  return db.prepare('SELECT * FROM records WHERE _row_id = ?').get(recordId);
};

const emailStep = ({ stepId, provider }) => ({
  kind: 'send_email',
  id: stepId,
  config: {
    action: 'tool_call',
    tool: {
      server: 'test_provider',
      tools: ['SEND'],
      effect: { class: 'human_contact', channel: 'email' },
    },
    daily_cap: 999,
    args: { subject: 'Test', body: 'Test body' },
    output_map: { message_id: 'message_id', provider_id: 'message_id' },
    idempotency: { key_source: ['_row_id'], scope: 'list' },
    __tryTool: provider,
  },
});

const executeEmail = ({ db, listDir, record, step }) => executeChannelStep({
  mcp: null,
  listDir,
  listName: 'Live Interaction Budget Test',
  toolCatalog: null,
  db,
  record,
  sequenceName: 'default',
  stepNumber: 1,
  step,
  sequence: { steps: [] },
  channelHint: 'email',
  intent: 'send',
});

const seedAcceptedLiveInteraction = ({ db, recordId, contactId, stepId = 'seed_step' }) => {
  const budget = { max_accounts: 25, max_interactions: 25 };
  const reserved = reserveLiveInteraction({
    db,
    budget,
    recordId,
    contactId,
    channel: 'email',
    stepId,
  });
  assert.equal(reserved.allowed, true);
  commitLiveInteraction({
    db,
    recordId,
    contactId,
    channel: 'email',
    stepId,
    providerId: `provider_${recordId}_${stepId}`,
  });
};

test('live interaction budget: interaction cap refuses before provider invocation', async () => {
  const { listDir, db } = createList({ budget: { max_accounts: 10, max_interactions: 1 } });
  const first = insertRecord({ db, recordId: 'acct_first' });
  seedAcceptedLiveInteraction({ db, recordId: first._row_id, contactId: first.active_contact_id });
  const second = insertRecord({ db, recordId: 'acct_second' });
  const calls = { value: 0 };
  const out = await executeEmail({
    db,
    listDir,
    record: second,
    step: emailStep({
      stepId: 'email_1',
      provider: async () => {
        calls.value += 1;
        return { result: { message_id: 'must_not_send' }, provider: 'test_provider' };
      },
    }),
  });
  assert.equal(out.status, 'skipped');
  assert.equal(out.reason, 'live_interaction_budget_exhausted');
  assert.equal(calls.value, 0);
  db.close();
});

test('live interaction budget: account cap blocks a new account and allows an already-contacted account', async () => {
  const { listDir, db } = createList({ budget: { max_accounts: 1, max_interactions: 3 } });
  const contacted = insertRecord({ db, recordId: 'acct_contacted' });
  const newAccount = insertRecord({ db, recordId: 'acct_new' });
  seedAcceptedLiveInteraction({ db, recordId: contacted._row_id, contactId: contacted.active_contact_id });
  const calls = { value: 0 };
  const provider = async () => {
    calls.value += 1;
    return { result: { message_id: `provider_${calls.value}` }, provider: 'test_provider' };
  };
  const blocked = await executeEmail({
    db,
    listDir,
    record: newAccount,
    step: emailStep({ stepId: 'email_1', provider }),
  });
  assert.equal(blocked.status, 'skipped');
  assert.equal(blocked.reason, 'live_interaction_budget_exhausted');
  const allowed = await executeEmail({
    db,
    listDir,
    record: contacted,
    step: emailStep({ stepId: 'email_2', provider }),
  });
  assert.equal(allowed.status, 'sent');
  assert.equal(calls.value, 1);
  db.close();
});

test('live interaction budget: sink mode is ledgered but does not consume the live budget', async () => {
  const { listDir, db } = createList({ budget: { max_accounts: 1, max_interactions: 1 } });
  const record = insertRecord({ db, recordId: 'acct_sink' });
  const previous = process.env.AO_SMTP_SINK;
  process.env.AO_SMTP_SINK = '1';
  try {
    const out = await executeEmail({
      db,
      listDir,
      record,
      step: emailStep({
        stepId: 'email_1',
        provider: async () => ({ result: { message_id: 'sink_provider' }, provider: 'test_provider' }),
      }),
    });
    assert.equal(out.status, 'sent');
    const status = getLiveInteractionBudgetStatus({
      db,
      budget: { max_accounts: 1, max_interactions: 1 },
    });
    assert.deepEqual(status.usage, { accounts: 0, interactions: 0 });
    assert.equal(status.items[0].delivery_mode, 'sink');
  } finally {
    if (previous === undefined) delete process.env.AO_SMTP_SINK;
    else process.env.AO_SMTP_SINK = previous;
    db.close();
  }
});

test('live interaction budget: retry for the same step and contact is not counted twice', async () => {
  const { listDir, db } = createList({ budget: { max_accounts: 10, max_interactions: 10 } });
  const record = insertRecord({ db, recordId: 'acct_retry' });
  const calls = { value: 0 };
  const step = emailStep({
    stepId: 'email_1',
    provider: async () => {
      calls.value += 1;
      return { result: { message_id: 'provider_retry' }, provider: 'test_provider' };
    },
  });
  const first = await executeEmail({ db, listDir, record, step });
  const replay = await executeEmail({ db, listDir, record, step });
  assert.equal(first.status, 'sent');
  assert.equal(replay.status, 'skipped');
  assert.equal(calls.value, 1);
  const status = getLiveInteractionBudgetStatus({
    db,
    budget: { max_accounts: 10, max_interactions: 10 },
  });
  assert.deepEqual(status.usage, { accounts: 1, interactions: 1 });
  db.close();
});

test('live interaction budget: counts are derived from the ledger after reopening the database', () => {
  const { listDir, db } = createList({ budget: { max_accounts: 10, max_interactions: 10 } });
  seedAcceptedLiveInteraction({ db, recordId: 'acct_restart', contactId: 'contact_restart' });
  db.close();
  const reopened = openListDb({ listDir, readonly: false });
  const status = getLiveInteractionBudgetStatus({
    db: reopened,
    budget: { max_accounts: 10, max_interactions: 10 },
  });
  assert.deepEqual(status.usage, { accounts: 1, interactions: 1 });
  reopened.close();
});

test('live interaction budget: unreadable ledger refuses before provider invocation', async () => {
  const { listDir, db } = createList({ budget: { max_accounts: 10, max_interactions: 10 } });
  const record = insertRecord({ db, recordId: 'acct_unreadable' });
  db.exec('DROP TABLE live_interaction_ledger');
  const calls = { value: 0 };
  const out = await executeEmail({
    db,
    listDir,
    record,
    step: emailStep({
      stepId: 'email_1',
      provider: async () => {
        calls.value += 1;
        return { result: { message_id: 'must_not_send' }, provider: 'test_provider' };
      },
    }),
  });
  assert.equal(out.status, 'skipped');
  assert.equal(out.reason, 'live_interaction_budget_ledger_unreadable');
  assert.equal(calls.value, 0);
  db.close();
});

test('live interaction budget: no configured budget preserves unlimited send behavior', async () => {
  const { listDir, db } = createList();
  const record = insertRecord({ db, recordId: 'acct_unlimited' });
  const calls = { value: 0 };
  const out = await executeEmail({
    db,
    listDir,
    record,
    step: emailStep({
      stepId: 'email_1',
      provider: async () => {
        calls.value += 1;
        return { result: { message_id: 'provider_unlimited' }, provider: 'test_provider' };
      },
    }),
  });
  assert.equal(out.status, 'sent');
  assert.equal(calls.value, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM live_interaction_ledger').get().n, 0);
  db.close();
});

// Regression: the sink test must mirror each channel's REAL stub check.
// A previous form matched any AO_*SINK*/AO_*FIXTURE* variable, so simulating
// physical mail (AO_MAIL_SINK=1) made live email look like sink and silently
// uncapped it. Fail-open on the send path is the one thing this budget exists
// to prevent.
test('live interaction budget: sink detection is per-channel and cannot be tripped by another channel', async () => {
  const { isSinkOrFixtureMode } = await import(
    '../dist/orchestrator/runtime/live-interaction-budget.js'
  );

  // Stubbing physical mail or LinkedIn must NOT excuse a live email send.
  assert.equal(isSinkOrFixtureMode('email', { AO_MAIL_SINK: '1' }), false);
  assert.equal(isSinkOrFixtureMode('email', { AO_UNIPILE_FIXTURE: '1' }), false);
  assert.equal(isSinkOrFixtureMode('email', { AO_PIPELINE_FIXTURE: '1' }), false);

  // Stubbing email must NOT excuse a live LinkedIn action.
  assert.equal(isSinkOrFixtureMode('linkedin', { AO_SMTP_SINK: '1' }), false);
  assert.equal(isSinkOrFixtureMode('linkedin', { AO_MAIL_SINK: '1' }), false);

  // Each channel honors its own stub, exactly as the provider hop tests it.
  assert.equal(isSinkOrFixtureMode('email', { AO_SMTP_SINK: '1' }), true);
  assert.equal(isSinkOrFixtureMode('linkedin', { AO_UNIPILE_FIXTURE: '1' }), true);
  assert.equal(isSinkOrFixtureMode('linkedin', { AO_UNIPILE_FIXTURE: 'true' }), true);

  // mailboxes.ts requires exactly '1'; a truthy-but-different value still sends
  // live, so the budget must not treat it as sink.
  assert.equal(isSinkOrFixtureMode('email', { AO_SMTP_SINK: 'yes' }), false);
  assert.equal(isSinkOrFixtureMode('email', { AO_SMTP_SINK: '0' }), false);
  assert.equal(isSinkOrFixtureMode('email', {}), false);
});
