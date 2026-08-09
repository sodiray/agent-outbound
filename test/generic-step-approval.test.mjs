import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { draftsApproveCommand, draftsListCommand, draftsRejectCommand } from '../dist/commands/drafts.js';
import { executeStepBatch } from '../dist/orchestrator/pipeline/step-executor.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { normalizeConfig } from '../dist/schemas/config.js';

const listDir = () => mkdtempSync(join(tmpdir(), 'ao-generic-step-approval-'));

const approvalStep = () => ({
  kind: 'enrich',
  id: 'purchase_gift_card',
  description: 'Purchase the approved gift card through the author-owned provider.',
  side_effecting: true,
  draft_approval_required: true,
  review: {
    purpose: 'Approve this author-owned purchase before it is invoked.',
    present: [{ field: 'business_name', label: 'Recipient' }],
  },
  action: 'tool_call',
  tool: {
    server: 'gift_cards',
    tools: ['PURCHASE_GIFT_CARD'],
    effect: { class: 'data_enrichment' },
  },
  output_map: { gift_card_receipt: 'receipt' },
  outputs: {
    gift_card_receipt: { type: 'string', description: 'Provider receipt.' },
  },
  inputs: ['business_name'],
});

const setup = () => {
  const root = listDir();
  const step = approvalStep();
  writeFileSync(join(root, 'outbound.yaml'), JSON.stringify({ pipeline: [step] }));
  const db = openListDb({ listDir: root, readonly: false });
  ensureRecordColumns({ db, columns: ['gift_card_receipt'] });
  upsertRecord({
    db,
    row: { _row_id: 'gift-card-record', business_name: 'Approval Required Co' },
  });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('gift-card-record');
  return { db, root, record, step };
};

const executionContext = ({ db, root, step }) => ({
  db,
  listDir: root,
  config: { pipeline: [step] },
  aiConfig: {},
  mcp: null,
  toolCatalog: null,
});

test('a generic step may declare side effects and draft approval while send_email still requires true', () => {
  const generic = normalizeConfig({ pipeline: [approvalStep()] });
  assert.deepEqual(generic.errors, []);

  const manual = normalizeConfig({
    pipeline: [{ kind: 'manual_task', id: 'phone_1' }],
  });
  assert.deepEqual(manual.errors, []);
  assert.equal(manual.config.pipeline[0].side_effecting, true);

  const transmitter = normalizeConfig({
    pipeline: [{
      kind: 'send_email',
      id: 'email_1',
      side_effecting: false,
      config: { channel: 'email' },
    }],
  });
  assert.ok(transmitter.errors.some((error) => /side_effecting: true/i.test(error)));
});

test('a generic approved step parks before its author-owned effect and executes only after approval', async () => {
  const { db, root, record, step } = setup();
  const attempts = [];
  const executable = {
    ...step,
    __tryTool: async (_tool, args) => {
      attempts.push(args);
      return { result: { receipt: 'gift-card-receipt-1' }, provider: 'gift_cards' };
    },
  };
  try {
    const pending = (await executeStepBatch(
      executionContext({ db, root, step: executable }),
      executable,
      executable.id,
      [record],
    )).get('gift-card-record');

    assert.equal(pending?.passed, false);
    assert.equal(pending?.parked, true);
    assert.equal(attempts.length, 0);
    const draft = db.prepare('SELECT * FROM drafts WHERE row_id = ? AND step_id = ?')
      .get('gift-card-record', executable.id);
    assert.equal(draft.status, 'pending_approval');
    assert.equal(draft.channel, 'author_step');
    assert.equal(JSON.parse(draft.artifacts_json).approval_type, 'author_step');
    const queued = draftsListCommand({ list: root, status: 'pending_approval' }).rows[0];
    assert.equal(queued.author_step_approval.guarantee, 'author_declared_unverified');
    assert.deepEqual(queued.author_step_approval.review_presentation.present, [{
      field: 'business_name',
      label: 'Recipient',
      value: 'Approval Required Co',
    }]);
    assert.equal(queued.content_equivalence.status, 'not_applicable');

    assert.equal(draftsApproveCommand({ list: root, draftId: draft.draft_id }).approved, 1);
    const approved = (await executeStepBatch(
      executionContext({ db, root, step: executable }),
      executable,
      executable.id,
      [record],
    )).get('gift-card-record');

    assert.equal(approved?.passed, true);
    assert.equal(attempts.length, 1);
  } finally {
    db.close();
  }
});

test('rejecting a generic approval means its author-owned effect is never invoked', async () => {
  const { db, root, record, step } = setup();
  const attempts = [];
  const executable = {
    ...step,
    __tryTool: async (_tool, args) => {
      attempts.push(args);
      return { result: { receipt: 'gift-card-receipt-2' }, provider: 'gift_cards' };
    },
  };
  try {
    await executeStepBatch(
      executionContext({ db, root, step: executable }),
      executable,
      executable.id,
      [record],
    );
    const draft = db.prepare('SELECT draft_id FROM drafts WHERE row_id = ? AND step_id = ?')
      .get('gift-card-record', executable.id);
    assert.equal(draftsRejectCommand({ list: root, draftId: draft.draft_id }).status, 'rejected');

    const rejected = (await executeStepBatch(
      executionContext({ db, root, step: executable }),
      executable,
      executable.id,
      [record],
    )).get('gift-card-record');

    assert.equal(rejected?.passed, false);
    assert.equal(rejected?.parked, true);
    assert.match(String(rejected?.reason), /rejected/i);
    assert.equal(attempts.length, 0);
  } finally {
    db.close();
  }
});
