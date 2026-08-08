import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeEnrichmentStepOnRecords } from '../dist/orchestrator/enrichment/runner.js';
import { executeStepBatch } from '../dist/orchestrator/pipeline/step-executor.js';
import { runDataflowCore } from '../dist/orchestrator/pipeline/dataflow.js';
import { AgentOutboundError } from '../dist/orchestrator/runtime/contract.js';
import { ensureRecordColumns, openListDb } from '../dist/orchestrator/runtime/db.js';

const createRecord = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-enrich-on-error-'));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({ db, columns: ['website', 'site_text'] });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, website, sequence_name, sequence_status,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES ('record_1', 'Example Account', 'https://missing.example.test', 'default', 'idle', ?, ?, ?, ?)
  `).run(now, now, now, now);
  return { listDir, db };
};

const recordFor = (db) => db.prepare('SELECT * FROM records WHERE _row_id = ?').get('record_1');

const toolStep = ({ onError = 'empty', error = new Error('HTTP 404 Not Found') } = {}) => ({
  kind: 'enrich',
  id: 'remote_lookup',
  action: 'tool_call',
  on_error: onError,
  tool: {
    server: 'provider',
    tools: ['FETCH'],
    effect: { class: 'data_lookup' },
  },
  args_map: { url: 'website' },
  output_map: { site_text: 'markdown' },
  outputs: { site_text: { type: 'string' } },
  __tryTool: async () => { throw error; },
});

const execute = ({ db, listDir, step }) => executeEnrichmentStepOnRecords({
  db,
  listDir,
  config: { ai: {} },
  mcp: null,
  toolCatalog: null,
  step,
  rows: [recordFor(db)],
  stepId: 'remote_lookup',
  force: true,
});

test('on_error: empty keeps a record-local tool failure visible without stranding later steps', async () => {
  const { listDir, db } = createRecord();
  try {
    const step = toolStep();
    const summary = await execute({ db, listDir, step });
    const failedRecord = recordFor(db);

    assert.equal(summary.failed, 1);
    assert.deepEqual(summary.handled_errors, ['record_1']);
    assert.equal(summary.errors.length, 1);
    assert.match(summary.errors[0].error, /tool_call:remote_lookup: provider waterfall exhausted.*404/i);
    assert.equal(failedRecord.remote_lookup__status, 'failed');
    assert.equal(failedRecord.site_text, '');
    assert.equal(failedRecord.retry_count, 1);
    assert.match(failedRecord.last_error, /tool_call:remote_lookup: provider waterfall exhausted.*404/i);

    const context = { db, listDir, config: { ai: {} }, mcp: null, toolCatalog: null, force: true };
    const outcome = (await executeStepBatch(context, step, 'remote_lookup', [recordFor(db)])).get('record_1');
    assert.equal(outcome.passed, false);
    assert.equal(outcome.errored, false);

    const ran = [];
    await runDataflowCore({
      records: [recordFor(db)],
      concurrency: 1,
      isTimeReady: () => true,
      steps: [
        { id: 'remote_lookup', kind: 'enrich', deps: [], executable: true, step },
        { id: 'later_step', kind: 'assign', deps: ['remote_lookup'], executable: true, step: { kind: 'assign' } },
      ],
      loadStep: async (selected, record) => {
        ran.push(selected.id);
        if (selected.id === 'later_step') return { passed: true, reason: '' };
        return (await executeStepBatch(context, step, selected.id, [record])).get('record_1');
      },
      onStepOutcome: async (recordState, _selected, stepOutcome) => ({
        record: recordFor(db) || recordState.record,
        errored: Boolean(stepOutcome.errored),
      }),
    });
    assert.deepEqual(ran, ['remote_lookup', 'later_step']);
  } finally {
    db.close();
  }
});

test('on_error: fail keeps a record-local tool failure record-fatal', async () => {
  const { listDir, db } = createRecord();
  try {
    const outcome = (await executeStepBatch(
      { db, listDir, config: { ai: {} }, mcp: null, toolCatalog: null, force: true },
      toolStep({ onError: 'fail' }),
      'remote_lookup',
      [recordFor(db)],
    )).get('record_1');
    assert.equal(outcome.passed, false);
    assert.equal(outcome.errored, true);
    assert.match(outcome.reason, /provider waterfall exhausted.*404/i);
  } finally {
    db.close();
  }
});

test('URL-targeted provider HTTP 400 degrades to empty while the record remains runnable', async () => {
  const { listDir, db } = createRecord();
  try {
    const step = toolStep({ error: new Error('Invalid input: HTTP 400') });
    const outcome = (await executeStepBatch(
      { db, listDir, config: { ai: {} }, mcp: null, toolCatalog: null, force: true },
      step,
      'remote_lookup',
      [recordFor(db)],
    )).get('record_1');
    assert.equal(outcome.passed, false);
    assert.equal(outcome.errored, false);
    assert.equal(recordFor(db).remote_lookup__status, 'failed');
  } finally {
    db.close();
  }
});

test('URL-targeted HTML parse failure degrades to empty while the record remains runnable', async () => {
  const { listDir, db } = createRecord();
  try {
    const step = toolStep({ error: new Error("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON") });
    const outcome = (await executeStepBatch(
      { db, listDir, config: { ai: {} }, mcp: null, toolCatalog: null, force: true },
      step,
      'remote_lookup',
      [recordFor(db)],
    )).get('record_1');
    assert.equal(outcome.passed, false);
    assert.equal(outcome.errored, false);
    assert.equal(recordFor(db).remote_lookup__status, 'failed');
  } finally {
    db.close();
  }
});

test('budget, auth, and configuration failures remain record-fatal with on_error: empty', async () => {
  const budget = createRecord();
  try {
    await assert.rejects(
      () => executeStepBatch(
        { db: budget.db, listDir: budget.listDir, config: { ai: {} }, mcp: null, toolCatalog: null, force: true },
        toolStep({ error: new AgentOutboundError({ code: 'BUDGET_EXCEEDED', message: 'enrichment budget exceeded' }) }),
        'remote_lookup',
        [recordFor(budget.db)],
      ),
      /enrichment budget exceeded/i,
    );
  } finally {
    budget.db.close();
  }

  const auth = createRecord();
  try {
    const outcome = (await executeStepBatch(
      { db: auth.db, listDir: auth.listDir, config: { ai: {} }, mcp: null, toolCatalog: null, force: true },
      toolStep({ error: new Error('HTTP 401 unauthorized') }),
      'remote_lookup',
      [recordFor(auth.db)],
    )).get('record_1');
    assert.equal(outcome.errored, true);
  } finally {
    auth.db.close();
  }

  const config = createRecord();
  try {
    const outcome = (await executeStepBatch(
      { db: config.db, listDir: config.listDir, config: { ai: {} }, mcp: null, toolCatalog: null, force: true },
      { ...toolStep(), tool: {}, waterfall: [] },
      'remote_lookup',
      [recordFor(config.db)],
    )).get('record_1');
    assert.equal(outcome.errored, true);
  } finally {
    config.db.close();
  }
});

test('objectless model output fails only that record cleanly', async () => {
  const { listDir, db } = createRecord();
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO records (
        _row_id, business_name, website, sequence_name, sequence_status,
        _created_at, _updated_at, created_at, updated_at
      ) VALUES ('record_2', 'Healthy Account', 'https://healthy.example.test', 'default', 'idle', ?, ?, ?, ?)
    `).run(now, now, now, now);
    const rows = db.prepare('SELECT * FROM records WHERE _row_id IN (?, ?) ORDER BY _row_id').all('record_1', 'record_2');
    const summary = await executeEnrichmentStepOnRecords({
      db,
      listDir,
      config: { ai: {} },
      mcp: null,
      toolCatalog: null,
      step: {
        id: 'site_profile',
        kind: 'enrich',
        outputs: { site_profile_summary: { type: 'string' } },
      },
      rows,
      stepId: 'site_profile',
      force: true,
      executeAction: async ({ record }) => {
        if (record._row_id === 'record_1') {
          throw new Error('execute-step failed (site_profile): No object generated: response did not match schema.');
        }
        return {
          outputs: { site_profile_summary: 'available' },
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, usd_cost: 0, tool_calls: [], tool_costs: [] },
          model: 'test',
          provider: 'test',
        };
      },
    });
    assert.equal(summary.failed, 1);
    assert.equal(summary.processed, 1);
    assert.match(summary.errors[0].error, /No object generated: response did not match schema/i);
    assert.equal(recordFor(db).site_profile__status, 'failed');
    assert.match(recordFor(db).last_error, /No object generated: response did not match schema/i);
    const healthy = db.prepare('SELECT site_profile__status, site_profile_summary FROM records WHERE _row_id = ?').get('record_2');
    assert.deepEqual(healthy, { site_profile__status: 'ok', site_profile_summary: 'available' });
  } finally {
    db.close();
  }
});
