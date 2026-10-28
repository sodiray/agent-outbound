import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeStepBatch } from '../dist/orchestrator/pipeline/step-executor.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';

const createRecord = (columns = []) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-explicit-empty-'));
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: ['website', ...columns] });
  upsertRecord({
    db,
    row: {
      _row_id: 'record_1',
      business_name: 'Example Account',
      website: 'https://example.test',
      email: 'old@example.test',
      email_confidence: 'auto_eligible',
    },
  });
  return { db, listDir };
};

const recordFor = (db) => db.prepare('SELECT * FROM records WHERE _row_id = ?').get('record_1');

const contextFor = ({ db, listDir, force = true }) => ({
  db,
  listDir,
  config: { ai: {} },
  mcp: null,
  toolCatalog: null,
  force,
});

const lookupStep = ({ id = 'discover_work_email', outputs, outputMap, tryTool, onError = 'fail', inputs = ['website'], argsMap = { url: 'website' } }) => ({
  kind: 'enrich',
  id,
  action: 'tool_call',
  inputs,
  on_error: onError,
  tool: { server: 'provider', tools: ['LOOKUP'], effect: { class: 'data_lookup' } },
  args_map: argsMap,
  outputs,
  output_map: outputMap,
  __tryTool: tryTool,
});

const execute = async ({ db, listDir, step, force = true }) => (
  await executeStepBatch(contextFor({ db, listDir, force }), step, step.id, [recordFor(db)])
).get('record_1');

test('a successful tool result explicitly blanks declared outputs and passes the write guard', async () => {
  const { db, listDir } = createRecord(['email', 'phone', 'aliases']);
  try {
    const outcome = await execute({
      db,
      listDir,
      step: lookupStep({
        outputs: {
          email: { type: 'string' },
          phone: { type: 'string' },
          aliases: { type: 'string' },
        },
        outputMap: { email: 'email', phone: 'phone', aliases: 'aliases' },
        tryTool: async () => ({
          result: { contact_status: 'needs_better_contact', email: '', phone: null, aliases: [] },
          provider: 'provider',
          usage: {},
        }),
      }),
    });

    assert.equal(outcome.passed, true);
    assert.equal(outcome.errored, undefined);
    assert.doesNotMatch(String(outcome.reason || ''), /declared_outputs_unwritten/);
    assert.deepEqual(
      db.prepare('SELECT email, phone, aliases FROM records WHERE _row_id = ?').get('record_1'),
      { email: '', phone: '', aliases: '' },
    );
  } finally {
    db.close();
  }
});

test('on_error empty preserves an existing value after a record-scoped provider failure', async () => {
  const { db, listDir } = createRecord(['email']);
  try {
    await execute({
      db,
      listDir,
      step: lookupStep({
        onError: 'empty',
        outputs: { email: { type: 'string' }, contact_status: { type: 'string' } },
        outputMap: { email: 'email', contact_status: 'contact_status' },
        tryTool: async () => { throw new Error('HTTP 404 Not Found'); },
      }),
    });
    assert.equal(recordFor(db).email, 'old@example.test');
  } finally {
    db.close();
  }
});

test('a timeout preserves an existing value', async () => {
  const { db, listDir } = createRecord(['email']);
  try {
    await execute({
      db,
      listDir,
      step: lookupStep({
        outputs: { email: { type: 'string' } },
        outputMap: { email: 'email' },
        tryTool: async () => { throw new Error('ETIMEDOUT provider'); },
      }),
    });
    assert.equal(recordFor(db).email, 'old@example.test');
  } finally {
    db.close();
  }
});

test('a successful result missing a declared key preserves that value', async () => {
  const { db, listDir } = createRecord(['email']);
  try {
    const outcome = await execute({
      db,
      listDir,
      step: lookupStep({
        outputs: { email: { type: 'string' } },
        outputMap: { email: 'email' },
        tryTool: async () => ({ result: { contact_status: 'needs_better_contact' }, provider: 'provider', usage: {} }),
      }),
    });
    assert.equal(outcome.passed, true);
    assert.equal(recordFor(db).email, 'old@example.test');
  } finally {
    db.close();
  }
});

test('a blanked upstream output makes a downstream step re-evaluate on its next pass', async () => {
  const { db, listDir } = createRecord(['email', 'email_confidence']);
  try {
    const discover = lookupStep({
      outputs: { email: { type: 'string' } },
      outputMap: { email: 'email' },
      tryTool: async () => ({ result: { contact_status: 'needs_better_contact', email: '' }, provider: 'provider', usage: {} }),
    });
    let confidenceCalls = 0;
    const confidence = lookupStep({
      id: 'email_confidence',
      inputs: ['email'],
      argsMap: { email: 'email' },
      outputs: { email_confidence: { type: 'string' } },
      outputMap: { email_confidence: 'email_confidence' },
      tryTool: async (_tool, args) => {
        confidenceCalls += 1;
        return {
          result: { source: 'confidence_lookup', email_confidence: args.email ? 'auto_eligible' : 'ineligible' },
          provider: 'provider',
          usage: {},
        };
      },
    });

    // Establish a staleness entry for the previously non-empty email.
    await execute({ db, listDir, step: confidence, force: false });
    await execute({ db, listDir, step: discover });
    const outcome = await execute({ db, listDir, step: confidence, force: false });

    assert.equal(outcome.passed, true);
    assert.equal(confidenceCalls, 2);
    assert.equal(recordFor(db).email_confidence, 'ineligible');
  } finally {
    db.close();
  }
});
