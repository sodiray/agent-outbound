/**
 * Phase A3 — idempotency key construction + executeChannelStep claim wiring.
 *
 * Bug classes:
 * - Multi-step sequences with key_source [_row_id, step_id] collapse to one key
 *   when step_id is only known at execution time (not a record column).
 * - Contact rotation reuses the wrong contact's send key when active_contact_id
 *   is not preferred from execution context.
 * - execute.ts forgets to pass context into buildIdempotencyKey before claim.
 *
 * Pure unit tests + live claim path under AO_PIPELINE_FIXTURE (no live SMTP).
 * dryRun must not claim/complete idempotency (product behavior) — claim tests
 * therefore run dryRun:false with the tool_call fixture so send succeeds offline.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildIdempotencyKey,
  getIdempotencyRecord,
} from '../dist/orchestrator/runtime/idempotency.js';
import { openListDb, ensureRecordColumns } from '../dist/orchestrator/runtime/db.js';
import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';
import { NEXT_ACTION_POLICY_VERSION } from '../dist/orchestrator/policy/lifecycle.js';

// --- Pure: buildIdempotencyKey ---------------------------------------------

test('buildIdempotencyKey: context step_id wins over missing record.step_id', () => {
  const record = { _row_id: 'acct_1' }; // no step_id column on record during send
  const withoutContext = buildIdempotencyKey({
    keySource: ['_row_id', 'step_id'],
    record,
    scope: 'list',
  });
  assert.equal(withoutContext, 'list:acct_1|');

  const withContext = buildIdempotencyKey({
    keySource: ['_row_id', 'step_id'],
    record,
    scope: 'list',
    context: { step_id: 'email_1' },
  });
  assert.equal(withContext, 'list:acct_1|email_1');
  assert.notEqual(withContext, withoutContext);
});

test('buildIdempotencyKey: context step_id wins over empty/whitespace record.step_id', () => {
  const record = { _row_id: 'acct_1', step_id: '   ' };
  const key = buildIdempotencyKey({
    keySource: ['_row_id', 'step_id'],
    record,
    scope: 'list',
    context: { step_id: 'email_2' },
  });
  assert.equal(key, 'list:acct_1|email_2');
});

test('buildIdempotencyKey: context active_contact_id used when in key_source', () => {
  // Record may lack active_contact_id, or carry a stale one; context pins the send identity.
  const record = { _row_id: 'acct_1', active_contact_id: 'c_stale' };
  const key = buildIdempotencyKey({
    keySource: ['_row_id', 'active_contact_id'],
    record,
    scope: 'list',
    context: { active_contact_id: 'c_owner' },
  });
  assert.equal(key, 'list:acct_1|c_owner');

  const missingOnRecord = buildIdempotencyKey({
    keySource: ['_row_id', 'active_contact_id'],
    record: { _row_id: 'acct_1' },
    scope: 'list',
    context: { active_contact_id: 'c_om' },
  });
  assert.equal(missingOnRecord, 'list:acct_1|c_om');
});

test('buildIdempotencyKey: two different step ids → two different keys for same row', () => {
  const record = { _row_id: 'acct_tv_1' };
  const keySource = ['_row_id', 'step_id'];
  const k1 = buildIdempotencyKey({
    keySource,
    record,
    scope: 'list',
    context: { step_id: 'email_1' },
  });
  const k2 = buildIdempotencyKey({
    keySource,
    record,
    scope: 'list',
    context: { step_id: 'email_2' },
  });
  assert.equal(k1, 'list:acct_tv_1|email_1');
  assert.equal(k2, 'list:acct_tv_1|email_2');
  assert.notEqual(k1, k2);

  // Collapse bug: without context both keys are identical (same empty step_id).
  const collapsed1 = buildIdempotencyKey({ keySource, record, scope: 'list' });
  const collapsed2 = buildIdempotencyKey({ keySource, record, scope: 'list' });
  assert.equal(collapsed1, collapsed2);
  assert.equal(collapsed1, 'list:acct_tv_1|');
});

test('buildIdempotencyKey: record value used when context omits the token', () => {
  const key = buildIdempotencyKey({
    keySource: ['_row_id', 'step_id'],
    record: { _row_id: 'acct_1', step_id: 'from_record' },
    scope: 'list',
    context: {},
  });
  assert.equal(key, 'list:acct_1|from_record');
});

test('buildIdempotencyKey: default-appends contact when key_source omits it', () => {
  // YAML only listed _row_id + step_id — still pin targeted contact so rotation
  // cannot reuse another contact's send key.
  const withoutContact = buildIdempotencyKey({
    keySource: ['_row_id', 'step_id'],
    record: { _row_id: 'acct_1' },
    scope: 'list',
    context: { step_id: 'email_1' },
  });
  assert.equal(withoutContact, 'list:acct_1|email_1');

  const withContact = buildIdempotencyKey({
    keySource: ['_row_id', 'step_id'],
    record: { _row_id: 'acct_1' },
    scope: 'list',
    context: { step_id: 'email_1', active_contact_id: 'c_owner' },
  });
  assert.equal(withContact, 'list:acct_1|email_1|c_owner');
  assert.notEqual(withContact, withoutContact);

  // Two contacts → two keys for the same step.
  const otherContact = buildIdempotencyKey({
    keySource: ['_row_id', 'step_id'],
    record: { _row_id: 'acct_1' },
    scope: 'list',
    context: { step_id: 'email_1', active_contact_id: 'c_ops' },
  });
  assert.equal(otherContact, 'list:acct_1|email_1|c_ops');
  assert.notEqual(withContact, otherContact);
});

test('buildIdempotencyKey: default-appends step_id when key_source omits it', () => {
  const key = buildIdempotencyKey({
    keySource: ['_row_id'],
    record: { _row_id: 'acct_1' },
    scope: 'list',
    context: { step_id: 'email_2', active_contact_id: 'c1' },
  });
  assert.equal(key, 'list:acct_1|email_2|c1');
});

test('buildIdempotencyKey: does not double-append tokens already in key_source', () => {
  const key = buildIdempotencyKey({
    keySource: ['_row_id', 'step_id', 'active_contact_id'],
    record: { _row_id: 'acct_1' },
    scope: 'list',
    context: { step_id: 'email_1', active_contact_id: 'c_owner', channel: 'email' },
  });
  // step + contact listed → only channel is default-pinned.
  assert.equal(key, 'list:acct_1|email_1|c_owner|email');
});

test('buildIdempotencyKey: multi-channel keys do not collide on partial key_source', () => {
  const base = {
    keySource: ['_row_id', 'step_id'],
    record: { _row_id: 'acct_mc' },
    scope: 'list',
  };
  const emailKey = buildIdempotencyKey({
    ...base,
    context: { step_id: 'touch_1', active_contact_id: 'c1', channel: 'email' },
  });
  const linkedinKey = buildIdempotencyKey({
    ...base,
    context: { step_id: 'touch_1', active_contact_id: 'c1', channel: 'linkedin' },
  });
  const phoneKey = buildIdempotencyKey({
    ...base,
    context: { step_id: 'touch_1', active_contact_id: 'c1', channel: 'phone' },
  });
  const mailKey = buildIdempotencyKey({
    ...base,
    context: { step_id: 'touch_1', active_contact_id: 'c1', channel: 'mail' },
  });
  assert.equal(emailKey, 'list:acct_mc|touch_1|c1|email');
  assert.equal(linkedinKey, 'list:acct_mc|touch_1|c1|linkedin');
  assert.equal(phoneKey, 'list:acct_mc|touch_1|c1|phone');
  assert.equal(mailKey, 'list:acct_mc|touch_1|c1|mail');
  const keys = [emailKey, linkedinKey, phoneKey, mailKey];
  assert.equal(new Set(keys).size, 4, 'channels must not share a key');
});

// --- executeChannelStep claim path ----------------------------------------

const projectYaml = `
list:
  name: Idempotency Key Test
business:
  name: Mission
  description: Test
  icp: Test
  offer: Test
pipeline: []
sequences:
  default:
    steps:
      - kind: send_email
        id: email_1
        day: 0
      - kind: send_email
        id: email_2
        day: 3
policy:
  version: tv-pipeline-v1
  prohibited_channels: [sms]
  prohibited_task_types: [visit, field_visit]
  enforce_readiness: false
channels:
  email:
    draft_approval_required: false
`;

const nextAction = (accountId, overrides = {}) => ({
  action_id: `na_send_${accountId}`,
  action_type: 'send_email',
  account_id: accountId,
  contact_id: 'c_owner',
  lifecycle_stage: 'contacted',
  sequence_state: 'active',
  work_state: 'executing_external_action',
  reason: 'test send',
  on_success: 'continue',
  policy_version: NEXT_ACTION_POLICY_VERSION,
  ...overrides,
});

const seedList = (recordOverrides = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-idem-key-'));
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml);
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const rowId = String(recordOverrides._row_id || 'acct_idem_1');
  ensureRecordColumns({
    db,
    columns: [
      'lifecycle_stage',
      'account_sequence_state',
      'work_state',
      'next_action_json',
      'active_contact_id',
      'contact_id',
      'treatment_tier',
      'suppressed',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      contact_email, lifecycle_stage, account_sequence_state, work_state, next_action_json,
      active_contact_id, treatment_tier, suppressed,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      ?, 'Idem HVAC', 'default', 'active', 0,
      'owner@example-idem.test', 'contacted', 'active', 'executing_external_action', ?,
      ?, 'B', 0,
      ?, ?, ?, ?
    )
  `).run(
    rowId,
    JSON.stringify(nextAction(rowId)),
    String(recordOverrides.active_contact_id || 'c_owner'),
    now,
    now,
    now,
    now,
  );
  return { listDir, db, rowId };
};

const emailStep = (id, keySource) => ({
  kind: 'send_email',
  id,
  config: {
    action: 'tool_call',
    tool: { server: 'noop', tools: ['NOOP'] },
    daily_cap: 999,
    args: { subject: 'Idempotency harness', body: 'Fixture body' },
    idempotency: {
      key_source: keySource,
      scope: 'list',
    },
  },
});

/** Live claim path: dryRun never claims; fixture avoids network for tool_call send. */
const withPipelineFixture = async (fn) => {
  const prev = process.env.AO_PIPELINE_FIXTURE;
  process.env.AO_PIPELINE_FIXTURE = '1';
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.AO_PIPELINE_FIXTURE;
    else process.env.AO_PIPELINE_FIXTURE = prev;
  }
};

test('executeChannelStep claim: context step_id yields distinct keys per step for same row', async () => {
  await withPipelineFixture(async () => {
    const { listDir, db, rowId } = seedList();
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
    // Records do not store the executing step_id while a step runs.
    assert.equal(record.step_id, undefined);

    const keySource = ['_row_id', 'step_id'];
    // Execute always pins channel + contact + recipient when omitted from key_source.
    const pinCtx = {
      active_contact_id: 'c_owner',
      contact_id: 'c_owner',
      channel: 'email',
      recipient: 'owner@example-idem.test',
    };
    const expected1 = buildIdempotencyKey({
      keySource,
      record,
      scope: 'list',
      context: { step_id: 'email_1', ...pinCtx },
    });
    const expected2 = buildIdempotencyKey({
      keySource,
      record,
      scope: 'list',
      context: { step_id: 'email_2', ...pinCtx },
    });
    assert.notEqual(expected1, expected2);
    assert.equal(expected1, `list:${rowId}|email_1|c_owner|email|to:owner@example-idem.test`);
    assert.equal(expected2, `list:${rowId}|email_2|c_owner|email|to:owner@example-idem.test`);

    const first = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Idempotency Key Test',
      toolCatalog: null,
      db,
      record,
      sequenceName: 'default',
      stepNumber: 1,
      step: emailStep('email_1', keySource),
      sequence: { steps: [{ id: 'email_1' }, { id: 'email_2' }] },
      channelHint: 'email',
      intent: 'send',
      dryRun: false,
    });
    assert.equal(first.status, 'sent', `gate/claim failed: ${JSON.stringify(first)}`);

    const row1 = getIdempotencyRecord({ db, idemKey: expected1, scope: 'list' });
    assert.ok(row1, `expected idempotency row for ${expected1}`);
    assert.equal(row1.status, 'sent');

    // Same row, different step — must not hit "Already sent" from collapsed key.
    // Reuse the in-memory record (stale after progression) so the assertion is on
    // claim-key context wiring, not sequencer re-due logic.
    const second = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Idempotency Key Test',
      toolCatalog: null,
      db,
      record,
      sequenceName: 'default',
      stepNumber: 2,
      step: emailStep('email_2', keySource),
      sequence: { steps: [{ id: 'email_1' }, { id: 'email_2' }] },
      channelHint: 'email',
      intent: 'send',
      dryRun: false,
    });
    assert.equal(second.status, 'sent', `second step blocked: ${JSON.stringify(second)}`);
    assert.ok(
      !/already sent/i.test(String(second.reason || '')),
      String(second.reason),
    );

    const row2 = getIdempotencyRecord({ db, idemKey: expected2, scope: 'list' });
    assert.ok(row2, `expected idempotency row for ${expected2}`);
    assert.equal(row2.status, 'sent');

    const all = db.prepare('SELECT idem_key, status FROM idempotency ORDER BY idem_key').all();
    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((r) => r.idem_key).sort(),
      [expected1, expected2].sort(),
    );

    // Replay same step is idempotent skip (claim path completed).
    const replay = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Idempotency Key Test',
      toolCatalog: null,
      db,
      record,
      sequenceName: 'default',
      stepNumber: 1,
      step: emailStep('email_1', keySource),
      sequence: { steps: [{ id: 'email_1' }] },
      channelHint: 'email',
      intent: 'send',
      dryRun: false,
    });
    assert.equal(replay.status, 'skipped');
    assert.match(String(replay.reason), /already sent/i);

    db.close();
  });
});

test('executeChannelStep claim: active_contact_id from record is pinned into key when in key_source', async () => {
  await withPipelineFixture(async () => {
    const { listDir, db, rowId } = seedList({ active_contact_id: 'c_owner' });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
    const keySource = ['_row_id', 'active_contact_id'];
    // Execute always passes channel=email for send_email — default pin includes it
    // when key_source omits channel.
    const expected = buildIdempotencyKey({
      keySource,
      record,
      scope: 'list',
      context: {
        step_id: 'email_1',
        active_contact_id: 'c_owner',
        contact_id: 'c_owner',
        channel: 'email',
        recipient: 'owner@example-idem.test',
      },
    });
    assert.equal(expected, `list:${rowId}|c_owner|email_1|email|to:owner@example-idem.test`);

    const out = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Idempotency Key Test',
      toolCatalog: null,
      db,
      record,
      sequenceName: 'default',
      stepNumber: 1,
      step: emailStep('email_1', keySource),
      sequence: { steps: [{ id: 'email_1' }] },
      channelHint: 'email',
      intent: 'send',
      dryRun: false,
    });
    assert.equal(out.status, 'sent', JSON.stringify(out));

    const row = getIdempotencyRecord({ db, idemKey: expected, scope: 'list' });
    assert.ok(row, `missing claim for ${expected}`);
    assert.equal(row.status, 'sent');
    db.close();
  });
});

test('executeChannelStep claim: default-appends contact when YAML key_source omits it', async () => {
  await withPipelineFixture(async () => {
    const { listDir, db, rowId } = seedList({ active_contact_id: 'c_owner' });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
    // YAML only lists _row_id — step_id, contact, and channel must still pin.
    const keySource = ['_row_id'];
    const expected = buildIdempotencyKey({
      keySource,
      record,
      scope: 'list',
      context: {
        step_id: 'email_1',
        active_contact_id: 'c_owner',
        contact_id: 'c_owner',
        channel: 'email',
        recipient: 'owner@example-idem.test',
      },
    });
    assert.equal(expected, `list:${rowId}|email_1|c_owner|email|to:owner@example-idem.test`);

    const out = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Idempotency Key Test',
      toolCatalog: null,
      db,
      record,
      sequenceName: 'default',
      stepNumber: 1,
      step: emailStep('email_1', keySource),
      sequence: { steps: [{ id: 'email_1' }] },
      channelHint: 'email',
      intent: 'send',
      dryRun: false,
    });
    assert.equal(out.status, 'sent', JSON.stringify(out));

    const row = getIdempotencyRecord({ db, idemKey: expected, scope: 'list' });
    assert.ok(row, `missing claim for ${expected}`);
    assert.equal(row.status, 'sent');

    // Replay same partial key_source still hits the default-pinned identity.
    const replay = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Idempotency Key Test',
      toolCatalog: null,
      db,
      record,
      sequenceName: 'default',
      stepNumber: 1,
      step: emailStep('email_1', keySource),
      sequence: { steps: [{ id: 'email_1' }] },
      channelHint: 'email',
      intent: 'send',
      dryRun: false,
    });
    assert.equal(replay.status, 'skipped');
    assert.match(String(replay.reason), /already sent/i);

    db.close();
  });
});
