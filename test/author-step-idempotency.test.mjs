import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { draftsApproveCommand } from '../dist/commands/drafts.js';
import { executeStepBatch } from '../dist/orchestrator/pipeline/step-executor.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { normalizeConfig } from '../dist/schemas/config.js';

const listDir = () => mkdtempSync(join(tmpdir(), 'ao-author-idempotency-'));

// An author-built step that spends money through a tool the engine has never
// heard of. Approval gates the first invocation; idempotency is the only thing
// that can stop the second.
const purchaseStep = ({ idempotency, memoize } = {}) => ({
  kind: 'enrich',
  id: 'purchase_gift_card',
  description: 'Purchase the approved gift card through the author-owned provider.',
  side_effecting: true,
  draft_approval_required: true,
  ...(idempotency ? { idempotency } : {}),
  ...(memoize === undefined ? {} : { memoize }),
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

const setup = (step) => {
  const root = listDir();
  writeFileSync(join(root, 'outbound.yaml'), JSON.stringify({ pipeline: [step] }));
  const db = openListDb({ listDir: root, readonly: false });
  ensureRecordColumns({ db, columns: ['gift_card_receipt'] });
  upsertRecord({ db, row: { _row_id: 'gift-card-record', business_name: 'Approval Required Co' } });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('gift-card-record');
  return { db, root, record };
};

const executionContext = ({ db, root, step }) => ({
  db,
  listDir: root,
  config: { pipeline: [step] },
  aiConfig: {},
  mcp: null,
  toolCatalog: null,
});

/** Run the step to completion: park for approval, approve, then run again. */
const runApprovedTwice = async ({ db, root, record, step, attempts }) => {
  const executable = {
    ...step,
    __tryTool: async (_tool, args) => {
      attempts.push(args);
      return { result: { receipt: `receipt-${attempts.length}` }, provider: 'gift_cards' };
    },
  };
  const ctx = () => executionContext({ db, root, step: executable });
  const run = async () => (await executeStepBatch(ctx(), executable, executable.id, [record]))
    .get('gift-card-record');

  const parked = await run();
  assert.equal(parked?.parked, true, 'first run must park for approval');
  const draft = db.prepare('SELECT draft_id FROM drafts WHERE row_id = ? AND step_id = ?')
    .get('gift-card-record', executable.id);
  assert.equal(draftsApproveCommand({ list: root, draftId: draft.draft_id }).approved, 1);

  const first = await run();
  const second = await run();
  return { first, second };
};

test('an author-built step may declare idempotency', () => {
  const declared = normalizeConfig({
    pipeline: [purchaseStep({ idempotency: { key_source: ['_row_id'], scope: 'list' } })],
  });
  assert.deepEqual(declared.errors, []);
  assert.deepEqual(declared.config.pipeline[0].idempotency, { key_source: ['_row_id'], scope: 'list' });
});

test('a declared author effect is invoked once, not once per run', async () => {
  const step = purchaseStep({ idempotency: { key_source: ['_row_id'] } });
  const { db, root, record } = setup(step);
  const attempts = [];
  try {
    const { first, second } = await runApprovedTwice({ db, root, record, step, attempts });

    assert.equal(first?.passed, true);
    assert.equal(attempts.length, 1, 'the approved effect runs on the first pass');

    assert.equal(attempts.length, 1, 'the second pass must not re-invoke a completed effect');
    assert.match(String(second?.reason), /^skipped_idempotent/);

    const claim = db.prepare('SELECT * FROM idempotency').all();
    assert.equal(claim.length, 1);
    assert.equal(claim[0].status, 'sent');
  } finally {
    db.close();
  }
});

// Control: the same step without the declaration re-invokes every run. Without
// this, the test above would pass just as well against a step that never runs.
test('without the declaration the same effect re-runs every pass', async () => {
  const step = purchaseStep({ memoize: {} });
  const { db, root, record } = setup(step);
  const attempts = [];
  try {
    const { first, second } = await runApprovedTwice({ db, root, record, step, attempts });
    assert.equal(first?.passed, true);
    assert.equal(second?.passed, true);
    assert.equal(attempts.length, 2, 'side-effecting steps never gain duplicate-execution protection from memoization');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM idempotency').get().n, 0);
  } finally {
    db.close();
  }
});

// A declared effect that failed may still have happened. Retrying it silently —
// which the runner used to do inside a single batch — is a second purchase.
test('a declared effect that fails is not retried, and needs a person before it runs again', async () => {
  const step = purchaseStep({ idempotency: { key_source: ['_row_id'] } });
  const { db, root, record } = setup(step);
  const attempts = [];
  const executable = {
    ...step,
    __tryTool: async (_tool, args) => {
      attempts.push(args);
      throw new Error('provider_declined');
    },
  };
  const ctx = () => executionContext({ db, root, step: executable });
  const run = async () => (await executeStepBatch(ctx(), executable, executable.id, [record]))
    .get('gift-card-record');
  try {
    await run();
    const draft = db.prepare('SELECT draft_id FROM drafts WHERE row_id = ? AND step_id = ?')
      .get('gift-card-record', executable.id);
    draftsApproveCommand({ list: root, draftId: draft.draft_id });

    const failed = await run();
    assert.equal(failed?.passed, false);
    assert.equal(attempts.length, 1, 'the engine must not silently attempt the effect twice');
    assert.equal(db.prepare('SELECT status FROM idempotency').get().status, 'uncertain');

    const blocked = await run();
    assert.equal(blocked?.passed, false);
    assert.match(String(blocked?.reason), /^idempotency_requires_reconcile/);
    assert.equal(attempts.length, 1, 'an unreconciled effect is never re-attempted');
  } finally {
    db.close();
  }
});

// Control on the retry suppression: a step that touches nothing still gets the
// runner's second attempt, so the change above is scoped to the declaration.
test('a step that declares no side effect keeps its automatic retry', async () => {
  const step = { ...purchaseStep(), side_effecting: false, draft_approval_required: false };
  const { db, root, record } = setup(step);
  const attempts = [];
  const executable = {
    ...step,
    __tryTool: async (_tool, args) => {
      attempts.push(args);
      if (attempts.length === 1) throw new Error('provider_declined');
      return { result: { receipt: 'receipt-after-retry' }, provider: 'gift_cards' };
    },
  };
  try {
    const outcome = (await executeStepBatch(
      executionContext({ db, root, step: executable }),
      executable,
      executable.id,
      [record],
    )).get('gift-card-record');
    assert.equal(outcome?.passed, true);
    assert.equal(attempts.length, 2);
  } finally {
    db.close();
  }
});
