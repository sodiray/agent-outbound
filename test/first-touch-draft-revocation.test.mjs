import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';
import {
  ensureRecordColumns,
  insertDraft,
  insertOverride,
  openListDb,
  reconcileOverrides,
  revokeQueuedDraftsForSuppression,
  upsertRecord,
} from '../dist/orchestrator/runtime/db.js';
import { recordUnbudgetedLiveInteraction } from '../dist/orchestrator/runtime/live-interaction-budget.js';

const policyYaml = (firstTouchPolicy = '') => `
list:
  name: First Touch Draft Revocation
business:
  name: Test
  description: Test
  icp: Test
  offer: Test
pipeline: []
sequences:
  tier_a:
    steps:
      - kind: send_email
        id: tier_a_email_1
        day: 0
  tier_b:
    steps:
      - kind: send_email
        id: tier_b_email_1
        day: 0
  tier_c:
    steps:
      - kind: send_email
        id: tier_c_email_1
        day: 0
policy:
  enforce_readiness: false
${firstTouchPolicy}
`;

const nextAction = (recordId) => JSON.stringify({
  action_id: `na_${recordId}`,
  action_type: 'send_email',
  account_id: recordId,
  lifecycle_stage: 'contacted',
  sequence_state: 'active',
  work_state: 'executing_external_action',
  reason: 'test',
  on_success: 'continue',
});

const emailStep = (id) => ({
  kind: 'send_email',
  id,
  draft_approval_required: true,
  config: {
    action: 'tool_call',
    tool: {
      server: 'test_provider',
      tools: ['SEND'],
      effect: { class: 'human_contact', channel: 'email' },
    },
    args: { subject: 'Subject', body: 'Body' },
    output_map: { message_id: 'message_id', provider_id: 'message_id' },
    idempotency: { key_source: ['_row_id', 'step_id'], scope: 'list' },
    __tryTool: async () => ({ message_id: 'draft-message-id' }),
  },
});

const createList = ({ firstTouchPolicy = '', rowId = 'first_touch_record' } = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-first-touch-'));
  writeFileSync(join(listDir, 'outbound.yaml'), policyYaml(firstTouchPolicy));
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: ['lifecycle_stage', 'account_sequence_state', 'work_state', 'next_action_json'],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      contact_email, lifecycle_stage, account_sequence_state, work_state, next_action_json,
      suppressed, _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, 'First Touch Co', 'tier_a', 'active', 0, ?, 'contacted', 'active',
      'executing_external_action', ?, 0, ?, ?, ?, ?)
  `).run(rowId, `${rowId}@example.test`, nextAction(rowId), now, now, now, now);
  return { listDir, db, rowId };
};

const draftFirstEmail = async ({ listDir, db, rowId, sequenceName = 'tier_a' }) => {
  const step = emailStep(`${sequenceName}_email_1`);
  return executeChannelStep({
    mcp: null,
    listDir,
    listName: 'First Touch Draft Revocation',
    toolCatalog: null,
    db,
    record: db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId),
    sequenceName,
    stepNumber: 1,
    step,
    sequence: { steps: [step] },
    channelHint: 'email',
    intent: 'draft',
  });
};

const pendingDraft = ({ db, rowId, draftId }) => {
  insertDraft({
    db,
    draft: {
      draft_id: draftId,
      row_id: rowId,
      sequence_name: 'tier_a',
      step_number: 1,
      step_id: 'tier_a_email_1',
      channel: 'email',
      status: 'pending_approval',
      subject: 'Subject',
      body: 'Body',
    },
  });
};

test('a delivered sibling email first touch prevents a re-tiered record from queuing another email first touch', async () => {
  const { listDir, db, rowId } = createList({
    firstTouchPolicy: `  first_touch:\n    suppress_sibling_sequence_channels: [email]`,
  });
  recordUnbudgetedLiveInteraction({
    db,
    recordId: rowId,
    contactId: 'contact_1',
    channel: 'email',
    stepId: 'tier_c_email_1',
    providerId: 'live-tier-c-email-1',
    sequenceName: 'tier_c',
    stepNumber: 1,
  });

  const result = await draftFirstEmail({ listDir, db, rowId });
  assert.equal(result.status, 'skipped', JSON.stringify(result));
  assert.match(String(result.reason), /sibling.*first.*touch/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE row_id = ? AND status = 'pending_approval'").get(rowId).n, 0);
  db.close();
});

test('an email-only sibling-first-touch declaration still permits deliberate LinkedIn then email first touches', async () => {
  const { listDir, db, rowId } = createList({
    firstTouchPolicy: `  first_touch:\n    suppress_sibling_sequence_channels: [email]`,
  });
  recordUnbudgetedLiveInteraction({
    db,
    recordId: rowId,
    contactId: 'contact_1',
    channel: 'linkedin',
    stepId: 'tier_c_linkedin_1',
    providerId: 'live-tier-c-linkedin-1',
  });

  const result = await draftFirstEmail({ listDir, db, rowId });
  assert.equal(result.status, 'drafted', JSON.stringify(result));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE row_id = ? AND status = 'pending_approval'").get(rowId).n, 1);
  db.close();
});

test('a pipeline without a sibling-first-touch declaration continues to queue as it did before', async () => {
  const { listDir, db, rowId } = createList();
  recordUnbudgetedLiveInteraction({
    db,
    recordId: rowId,
    contactId: 'contact_1',
    channel: 'email',
    stepId: 'tier_c_email_1',
    providerId: 'live-tier-c-email-1',
  });

  const result = await draftFirstEmail({ listDir, db, rowId });
  assert.equal(result.status, 'drafted', JSON.stringify(result));
  db.close();
});

test('disqualification revokes every queued draft with an audit reason', () => {
  const { db, rowId } = createList({ rowId: 'disqualified_record' });
  pendingDraft({ db, rowId, draftId: 'draft_disqualified' });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  upsertRecord({
    db,
    row: {
      ...record,
      lifecycle_stage: 'disqualified',
      disqualified_at: '2026-08-09T12:00:00.000Z',
      disqualified_gate: 'eligibility_gate',
      disqualify_reason: 'out_of_territory',
    },
  });

  const draft = db.prepare('SELECT status, reason FROM drafts WHERE draft_id = ?').get('draft_disqualified');
  assert.deepEqual(draft, { status: 'revoked', reason: 'record_disqualified' });
  db.close();
});

test('a human drop override revokes every queued draft with an audit reason', () => {
  const { db, rowId } = createList({ rowId: 'override_disqualified_record' });
  pendingDraft({ db, rowId, draftId: 'draft_override_disqualified' });
  insertOverride({ db, recordId: rowId, kind: 'drop', reason: 'operator decision' });
  reconcileOverrides({ db });

  const draft = db.prepare('SELECT status, reason FROM drafts WHERE draft_id = ?').get('draft_override_disqualified');
  assert.deepEqual(draft, { status: 'revoked', reason: 'record_disqualified' });
  db.close();
});

test('a global email suppression revokes matching queued email drafts with an audit reason', () => {
  const { db, rowId } = createList({ rowId: 'globally_suppressed_record' });
  pendingDraft({ db, rowId, draftId: 'draft_global_suppression' });
  revokeQueuedDraftsForSuppression({
    db,
    value: `${rowId}@example.test`,
    valueType: 'email',
    reason: 'manual_suppress',
  });

  const draft = db.prepare('SELECT status, reason FROM drafts WHERE draft_id = ?').get('draft_global_suppression');
  assert.deepEqual(draft, {
    status: 'revoked',
    reason: 'global_email_suppression:manual_suppress',
  });
  db.close();
});

for (const [name, patch, reason] of [
  ['opt-out', { suppressed: 1, suppressed_reason: 'opt_out' }, 'record_opted_out'],
  ['suppression', { suppressed: 1, suppressed_reason: 'global_suppression' }, 'record_suppressed'],
  ['DNC', { suppressed: 1, suppressed_reason: 'crm_dnc' }, 'record_dnc'],
]) {
  test(`${name} after a draft is queued revokes that draft`, () => {
    const { db, rowId } = createList({ rowId: `revocation_${name}` });
    const draftId = `draft_${name}`;
    pendingDraft({ db, rowId, draftId });
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
    upsertRecord({ db, row: { ...record, ...patch } });

    const draft = db.prepare('SELECT status, reason FROM drafts WHERE draft_id = ?').get(draftId);
    assert.deepEqual(draft, { status: 'revoked', reason });
    db.close();
  });
}
