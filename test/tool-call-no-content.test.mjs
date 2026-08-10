/**
 * tool_call enrich: empty/degraded provider payloads must not write confident falsey
 * declared outputs. Absence of evidence is not evidence of absence.
 *
 * Emptiness signal: non-empty strings and finite numbers anywhere in the raw
 * provider payload count as usable content; booleans alone do not.
 *
 * Partial payload rule: when the raw payload has usable content, every mapped
 * output is written as returned — including genuine all-false boolean rows and
 * sparse subsets. Content is decided on the raw payload, never by whether the
 * extracted booleans "look plausible".
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  executeToolCallAction,
  providerResultHasUsableContent,
  PROVIDER_RETURNED_NO_CONTENT_REASON,
} from '../dist/orchestrator/enrichment/actions/tool-call.js';
import { executeEnrichmentStepOnRecords } from '../dist/orchestrator/enrichment/runner.js';
import { executeStepBatch } from '../dist/orchestrator/pipeline/step-executor.js';
import { isPresentDeclaredOutputValue } from '../dist/orchestrator/lib/declared-outputs.js';
import {
  ensureRecordColumns,
  hasPassedStep,
  openListDb,
} from '../dist/orchestrator/runtime/db.js';

const boolish = (value) => {
  if (value === true || value === 1 || value === '1' || value === '1.0') return 1;
  if (value === false || value === 0 || value === '0' || value === '0.0') return 0;
  return value;
};

const isAbsent = (value) => !isPresentDeclaredOutputValue(value);

const CAPABILITY_OUTPUTS = {
  has_online_booking: { type: 'boolean', description: 'Online booking widget.' },
  has_online_payment: { type: 'boolean', description: 'Online payment.' },
  has_chat: { type: 'boolean', description: 'Live chat.' },
  has_storefront: { type: 'boolean', description: 'E-commerce storefront.' },
};

const CAPABILITY_OUTPUT_MAP = {
  has_online_booking: 'extract.has_online_booking',
  has_online_payment: 'extract.has_online_payment',
  has_chat: 'extract.has_chat',
  has_storefront: 'extract.has_storefront',
};

const ALL_FALSE_EXTRACT = {
  has_online_booking: false,
  has_online_payment: false,
  has_chat: false,
  has_storefront: false,
};

const PARTIAL_EXTRACT = {
  has_online_booking: true,
  has_online_payment: false,
  has_chat: false,
  has_storefront: true,
};

const capabilityStep = ({ tryResult, tryError } = {}) => ({
  kind: 'enrich',
  id: 'site_capabilities',
  action: 'tool_call',
  inputs: ['website'],
  tool: {
    server: 'scrape',
    tools: ['SCRAPE_EXTRACT'],
    effect: { class: 'data_lookup' },
  },
  args_map: { url: 'website' },
  output_map: CAPABILITY_OUTPUT_MAP,
  outputs: CAPABILITY_OUTPUTS,
  __tryTool: async () => {
    if (tryError) throw tryError;
    return tryResult;
  },
});

const createRecord = (rowId = 'record_1') => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-tool-call-no-content-'));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({ db, columns: ['website'] });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, website, sequence_name, sequence_status,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, 'Example Account', 'https://example.test', 'default', 'idle', ?, ?, ?, ?)
  `).run(rowId, now, now, now, now);
  return { listDir, db, rowId };
};

const recordFor = (db, rowId = 'record_1') => (
  db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId)
);

const runStep = ({ db, listDir, step, force = true }) => executeEnrichmentStepOnRecords({
  db,
  listDir,
  config: { ai: {} },
  mcp: null,
  toolCatalog: null,
  step,
  rows: [recordFor(db)],
  stepId: step.id,
  force,
});

// ---------------------------------------------------------------------------
// Pure emptiness signal
// ---------------------------------------------------------------------------

test('providerResultHasUsableContent: empty / boolean-only / blank-markdown are not content', () => {
  assert.equal(providerResultHasUsableContent(null), false);
  assert.equal(providerResultHasUsableContent({}), false);
  assert.equal(providerResultHasUsableContent(''), false);
  assert.equal(providerResultHasUsableContent({ markdown: '' }), false);
  assert.equal(providerResultHasUsableContent({ markdown: '   ' }), false);
  assert.equal(providerResultHasUsableContent({ extract: ALL_FALSE_EXTRACT }), false);
  assert.equal(providerResultHasUsableContent({
    success: true,
    markdown: '',
    data: { extract: ALL_FALSE_EXTRACT },
  }), false);
  assert.equal(providerResultHasUsableContent({
    success: true,
    markdown: '',
    extract: ALL_FALSE_EXTRACT,
  }), false);
});

test('providerResultHasUsableContent: non-empty text or numbers count as content', () => {
  assert.equal(providerResultHasUsableContent({ markdown: '# Welcome to Bob\'s Plumbing' }), true);
  assert.equal(providerResultHasUsableContent({
    markdown: 'Contact us today for a free quote.',
    extract: ALL_FALSE_EXTRACT,
  }), true);
  assert.equal(providerResultHasUsableContent({ data: { markdown: 'body text', extract: PARTIAL_EXTRACT } }), true);
  assert.equal(providerResultHasUsableContent({ message_id: 'msg_abc' }), true);
  assert.equal(providerResultHasUsableContent({ rating: 0 }), true);
  assert.equal(providerResultHasUsableContent({ rating: 4.5 }), true);
});

// ---------------------------------------------------------------------------
// executeToolCallAction unit behaviour
// ---------------------------------------------------------------------------

test('tool_call: no usable content does not map declared outputs and names the reason', async () => {
  delete process.env.AO_PIPELINE_FIXTURE;
  delete process.env.AO_STEP_FIXTURE;
  const result = await executeToolCallAction({
    listDir: '/tmp',
    stepId: 'site_capabilities',
    stepConfig: {
      tool: { server: 'scrape', tools: ['SCRAPE_EXTRACT'], effect: { class: 'data_lookup' } },
      output_map: CAPABILITY_OUTPUT_MAP,
      outputs: CAPABILITY_OUTPUTS,
      __tryTool: async () => ({
        result: {
          success: true,
          markdown: '',
          extract: ALL_FALSE_EXTRACT,
        },
        provider: 'scrape',
        usage: { usd_cost: 0.01, tool_calls: [], tool_costs: [] },
      }),
    },
    record: { website: 'https://example.test' },
  });
  assert.deepEqual(result.outputs, {});
  assert.equal(result.reason, PROVIDER_RETURNED_NO_CONTENT_REASON);
});

test('tool_call: genuine all-false from non-empty payload still maps normally', async () => {
  delete process.env.AO_PIPELINE_FIXTURE;
  delete process.env.AO_STEP_FIXTURE;
  const result = await executeToolCallAction({
    listDir: '/tmp',
    stepId: 'site_capabilities',
    stepConfig: {
      tool: { server: 'scrape', tools: ['SCRAPE_EXTRACT'], effect: { class: 'data_lookup' } },
      output_map: CAPABILITY_OUTPUT_MAP,
      outputs: CAPABILITY_OUTPUTS,
      __tryTool: async () => ({
        result: {
          markdown: 'We are a phone-only local shop. Call us. No online tools.',
          extract: ALL_FALSE_EXTRACT,
        },
        provider: 'scrape',
      }),
    },
    record: { website: 'https://example.test' },
  });
  assert.equal(result.reason, undefined);
  assert.deepEqual(result.outputs, ALL_FALSE_EXTRACT);
});

test('tool_call: partially-populated extract with content writes exactly the mapped values', async () => {
  delete process.env.AO_PIPELINE_FIXTURE;
  delete process.env.AO_STEP_FIXTURE;
  const result = await executeToolCallAction({
    listDir: '/tmp',
    stepId: 'site_capabilities',
    stepConfig: {
      tool: { server: 'scrape', tools: ['SCRAPE_EXTRACT'], effect: { class: 'data_lookup' } },
      output_map: CAPABILITY_OUTPUT_MAP,
      outputs: CAPABILITY_OUTPUTS,
      __tryTool: async () => ({
        result: {
          markdown: 'Book online. Visit our shop.',
          extract: PARTIAL_EXTRACT,
        },
        provider: 'scrape',
      }),
    },
    record: { website: 'https://example.test' },
  });
  assert.equal(result.reason, undefined);
  assert.deepEqual(result.outputs, PARTIAL_EXTRACT);
});

test('tool_call: contentful string-only success is unaffected (normal map path)', async () => {
  delete process.env.AO_PIPELINE_FIXTURE;
  delete process.env.AO_STEP_FIXTURE;
  const result = await executeToolCallAction({
    listDir: '/tmp',
    stepId: 'site_scrape',
    stepConfig: {
      tool: { server: 'scrape', tools: ['SCRAPE'], effect: { class: 'data_lookup' } },
      output_map: { site_text: 'markdown' },
      outputs: { site_text: { type: 'string' } },
      __tryTool: async () => ({
        result: { markdown: 'Full website body with plenty of text to read.' },
        provider: 'scrape',
      }),
    },
    record: { website: 'https://example.test' },
  });
  assert.equal(result.reason, undefined);
  assert.equal(result.outputs.site_text, 'Full website body with plenty of text to read.');
});

// ---------------------------------------------------------------------------
// Enrich runner + step executor integration
// ---------------------------------------------------------------------------

test('enrich tool_call no-content: does not write declared outputs and records non-pass', async () => {
  const { listDir, db } = createRecord();
  try {
    const step = capabilityStep({
      tryResult: {
        result: { success: true, markdown: '', extract: ALL_FALSE_EXTRACT },
        provider: 'scrape',
        usage: { usd_cost: 0.01, tool_calls: [], tool_costs: [] },
      },
    });
    const summary = await runStep({ db, listDir, step });
    const row = recordFor(db);

    assert.equal(summary.recorded_non_success.record_1, PROVIDER_RETURNED_NO_CONTENT_REASON);
    assert.equal(summary.non_execution_reasons.record_1, PROVIDER_RETURNED_NO_CONTENT_REASON);
    assert.ok(isAbsent(row.has_online_booking), 'has_online_booking must remain absent');
    assert.ok(isAbsent(row.has_online_payment), 'has_online_payment must remain absent');
    assert.ok(isAbsent(row.has_chat), 'has_chat must remain absent');
    assert.ok(isAbsent(row.has_storefront), 'has_storefront must remain absent');
    // Declared-output bookkeeping: nothing provided.
    const writes = summary.declared_output_writes.record_1;
    for (const key of Object.keys(CAPABILITY_OUTPUTS)) {
      assert.equal(writes[key].provided, false, `${key} must not be marked provided`);
    }

    const outcome = (await executeStepBatch(
      { db, listDir, config: { ai: {} }, force: true },
      step,
      step.id,
      [recordFor(db)],
    )).get('record_1');
    assert.equal(outcome.passed, false);
    assert.equal(outcome.errored, false);
    assert.equal(outcome.reason, PROVIDER_RETURNED_NO_CONTENT_REASON);
    assert.equal(hasPassedStep({ db, recordId: 'record_1', stepId: step.id }), false);
  } finally {
    db.close();
  }
});

test('enrich tool_call genuine all-false from content still writes 0s normally', async () => {
  const { listDir, db } = createRecord('all-false-content');
  try {
    const step = capabilityStep({
      tryResult: {
        result: {
          markdown: 'Phone-only business. Call (208) 555-0100. No online booking.',
          extract: ALL_FALSE_EXTRACT,
        },
        provider: 'scrape',
      },
    });
    // Override row id for this fixture
    const stepWithId = { ...step, id: 'site_capabilities' };
    const summary = await executeEnrichmentStepOnRecords({
      db,
      listDir,
      config: { ai: {} },
      mcp: null,
      toolCatalog: null,
      step: stepWithId,
      rows: [recordFor(db, 'all-false-content')],
      stepId: stepWithId.id,
      force: true,
    });
    const row = recordFor(db, 'all-false-content');

    assert.equal(summary.recorded_non_success['all-false-content'], undefined);
    assert.equal(boolish(row.has_online_booking), 0);
    assert.equal(boolish(row.has_online_payment), 0);
    assert.equal(boolish(row.has_chat), 0);
    assert.equal(boolish(row.has_storefront), 0);
    assert.equal(row.site_capabilities__status, 'ok');

    const outcome = (await executeStepBatch(
      { db, listDir, config: { ai: {} }, force: true },
      stepWithId,
      stepWithId.id,
      [recordFor(db, 'all-false-content')],
    )).get('all-false-content');
    // Second force run rewrites the same all-false row — still a normal pass path.
    assert.equal(outcome.passed, true);
    assert.notEqual(outcome.reason, PROVIDER_RETURNED_NO_CONTENT_REASON);
  } finally {
    db.close();
  }
});

test('enrich tool_call partial payload with content writes mixed booleans as returned', async () => {
  const { listDir, db } = createRecord('partial-content');
  try {
    const step = capabilityStep({
      tryResult: {
        result: {
          markdown: 'Book online at our storefront. Phone support only — no chat.',
          extract: PARTIAL_EXTRACT,
        },
        provider: 'scrape',
      },
    });
    await executeEnrichmentStepOnRecords({
      db,
      listDir,
      config: { ai: {} },
      mcp: null,
      toolCatalog: null,
      step,
      rows: [recordFor(db, 'partial-content')],
      stepId: step.id,
      force: true,
    });
    const row = recordFor(db, 'partial-content');
    assert.equal(boolish(row.has_online_booking), 1);
    assert.equal(boolish(row.has_online_payment), 0);
    assert.equal(boolish(row.has_chat), 0);
    assert.equal(boolish(row.has_storefront), 1);
    assert.equal(row.site_capabilities__status, 'ok');
  } finally {
    db.close();
  }
});

test('after no-content non-pass the step re-runs rather than being treated as satisfied', async () => {
  const { listDir, db } = createRecord('rerun-me');
  let calls = 0;
  const step = capabilityStep({
    tryResult: {
      result: { success: true, markdown: '', extract: ALL_FALSE_EXTRACT },
      provider: 'scrape',
    },
  });
  // Count invocations via wrapping __tryTool
  step.__tryTool = async () => {
    calls += 1;
    return {
      result: { success: true, markdown: '', extract: ALL_FALSE_EXTRACT },
      provider: 'scrape',
    };
  };
  try {
    const first = await executeEnrichmentStepOnRecords({
      db,
      listDir,
      config: { ai: {} },
      mcp: null,
      toolCatalog: null,
      step,
      rows: [recordFor(db, 'rerun-me')],
      stepId: step.id,
      force: true,
    });
    assert.equal(first.recorded_non_success['rerun-me'], PROVIDER_RETURNED_NO_CONTENT_REASON);
    assert.equal(calls, 1);
    assert.ok(isAbsent(recordFor(db, 'rerun-me').has_online_booking));

    // Without force: must not skip as fresh/satisfied — declared outputs absent + no durable cache.
    const second = await executeEnrichmentStepOnRecords({
      db,
      listDir,
      config: { ai: {} },
      mcp: null,
      toolCatalog: null,
      step,
      rows: [recordFor(db, 'rerun-me')],
      stepId: step.id,
      force: false,
    });
    assert.equal(second.skipped_fresh, 0, 'must not skip as fresh after no-content');
    assert.equal(calls, 2, 'provider must be called again');
    assert.equal(second.recorded_non_success['rerun-me'], PROVIDER_RETURNED_NO_CONTENT_REASON);
    assert.equal(hasPassedStep({ db, recordId: 'rerun-me', stepId: step.id }), false);
  } finally {
    db.close();
  }
});

test('after a normal content write the step is completely unaffected by no-content handling', async () => {
  const { listDir, db } = createRecord('durable-ok');
  const step = capabilityStep({});
  step.__tryTool = async () => ({
    result: {
      markdown: 'We take appointments online.',
      extract: { ...ALL_FALSE_EXTRACT, has_online_booking: true },
    },
    provider: 'scrape',
  });
  try {
    const summary = await executeEnrichmentStepOnRecords({
      db,
      listDir,
      config: { ai: {} },
      mcp: null,
      toolCatalog: null,
      step,
      rows: [recordFor(db, 'durable-ok')],
      stepId: step.id,
      force: true,
    });
    const row = recordFor(db, 'durable-ok');
    assert.equal(summary.recorded_non_success['durable-ok'], undefined);
    assert.equal(boolish(row.has_online_booking), 1);
    assert.equal(boolish(row.has_online_payment), 0);
    assert.equal(row.site_capabilities__status, 'ok');

    const outcome = (await executeStepBatch(
      { db, listDir, config: { ai: {} }, force: true },
      step,
      step.id,
      [recordFor(db, 'durable-ok')],
    )).get('durable-ok');
    assert.equal(outcome.passed, true);
    assert.notEqual(outcome.reason, PROVIDER_RETURNED_NO_CONTENT_REASON);
  } finally {
    db.close();
  }
});
