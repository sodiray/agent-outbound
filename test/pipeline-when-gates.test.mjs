import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeStepBatch } from '../dist/orchestrator/pipeline/step-executor.js';
import { runDataflowCore, runPipelineDataflow } from '../dist/orchestrator/pipeline/dataflow.js';
import { skippedWhenOutcome, shouldRunForRecord } from '../dist/orchestrator/lib/step-when.js';
import { normalizeConfig } from '../dist/schemas/config.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';

const listDir = () => mkdtempSync(join(tmpdir(), 'agent-outbound-when-gates-'));

const whenTierA = {
  match: 'all',
  conditions: [{ field: 'tier', operator: 'eq', value: 'A' }],
};

const composeStep = {
  kind: 'compose',
  id: 'compose_copy',
  model: 'anthropic/claude-haiku-4-5-20251001',
  structure: { message: 'One factual sentence.' },
  inputs: { account: { from: 'business_name' }, tier: { from: 'tier' } },
  length: { max_words: 10 },
  outputs: { message: { type: 'string', description: 'Message.' } },
  when: whenTierA,
};

const extractStep = {
  kind: 'extract',
  id: 'extract_email',
  from: 'site_text',
  inputs: ['tier', 'site_text', 'domain', 'website'],
  using: 'email',
  outputs: { discovered_email: { type: 'string', description: 'Email.' } },
  when: whenTierA,
};

const filterStep = {
  kind: 'filter',
  id: 'filter_tier_a',
  type: 'field_check',
  inputs: ['tier'],
  conditions: [{ field: 'tier', operator: 'eq', value: 'A' }],
  when: whenTierA,
};

const assignStep = {
  kind: 'assign',
  id: 'assign_route',
  target: 'sequence_name',
  fallback: 'holding',
  inputs: ['tier', 'sequence_status'],
  rules: [{ sequence: 'qualified', conditions: [{ field: 'tier', operator: 'eq', value: 'A' }] }],
  when: whenTierA,
};

const waitStep = { kind: 'wait', id: 'wait_one_day', after: '1d', inputs: ['tier'], when: whenTierA };
const manualTaskStep = { kind: 'manual_task', id: 'phone_1', config: { task_type: 'human_phone' }, inputs: ['tier'], when: whenTierA };
const sendEmailStep = { kind: 'send_email', id: 'email_1', side_effecting: true, inputs: ['tier'], when: whenTierA };
const linkedinStep = { kind: 'linkedin_connect', id: 'linkedin_1', side_effecting: true, inputs: ['tier'], when: whenTierA };

const supportedSteps = [
  { kind: 'enrich', id: 'enrich_one', inputs: ['tier'], when: whenTierA },
  { kind: 'generate', id: 'generate_one', inputs: ['tier'], when: whenTierA },
  { kind: 'review', id: 'review_one', inputs: ['tier'], when: whenTierA },
  filterStep,
  composeStep,
  extractStep,
  assignStep,
  waitStep,
  manualTaskStep,
  sendEmailStep,
  linkedinStep,
];

const malformedWhen = { conditionz: [] };

const normalizePipeline = (pipeline) => normalizeConfig({
  source: { identity: ['tier'] },
  sequences: { default: { steps: [] } },
  pipeline,
});

const schemaStep = (step) => (
  step.kind === 'assign'
    ? {
      ...step,
      fallback: 'default',
      rules: [{ sequence: 'default', conditions: [{ field: 'tier', operator: 'eq', value: 'A' }] }],
    }
    : step
);

test('when validates for every meaningful executable kind', () => {
  for (const step of supportedSteps) {
    const configuredStep = schemaStep(step);
    assert.deepEqual(normalizePipeline([configuredStep]).errors, [], step.kind);
    assert.ok(
      normalizePipeline([{ ...configuredStep, when: malformedWhen }]).errors.length > 0,
      `${step.kind} must reject a malformed when predicate`,
    );
  }
});

test('unknown pipeline step keys are validation errors and container dependencies are explicitly rejected', () => {
  const unknownKey = normalizePipeline([{ ...filterStep, safety_gate: true }]);
  assert.ok(unknownKey.errors.some((error) => error.includes('pipeline[0].safety_gate')));
  assert.ok(!unknownKey.warnings.some((warning) => warning.includes('pipeline[0].safety_gate')));

  const containerDependency = normalizePipeline([{
    kind: 'pipeline',
    id: 'nested_campaign',
    depends_on: ['prepare_records'],
    steps: [],
  }]);
  assert.ok(containerDependency.errors.some((error) => (
    error.includes('pipeline[0].depends_on is not supported on kind: pipeline')
  )));
});

const withDb = async (callback) => {
  const root = listDir();
  const db = openListDb({ listDir: root, readonly: false });
  ensureRecordColumns({ db, columns: ['tier', 'site_text', 'discovered_email', 'message'] });
  upsertRecord({
    db,
    row: {
      _row_id: 'tier_a',
      business_name: 'Alpha',
      tier: 'A',
      site_text: 'contact@alpha.example',
      sequence_name: 'default',
      sequence_status: 'idle',
    },
  });
  upsertRecord({
    db,
    row: {
      _row_id: 'tier_b',
      business_name: 'Beta',
      tier: 'B',
      site_text: 'contact@beta.example',
      sequence_name: 'default',
      sequence_status: 'idle',
    },
  });
  try {
    return await callback({
      db,
      root,
      records: db.prepare('SELECT * FROM records WHERE _row_id IN (?, ?) ORDER BY _row_id').all('tier_a', 'tier_b'),
    });
  } finally {
    db.close();
  }
};

const expectedSkip = (record, root) => skippedWhenOutcome(shouldRunForRecord({
  record,
  predicate: whenTierA,
  listDir: root,
}));

test('newly gated kinds execute matches and return the shared skip outcome for non-matches', async () => {
  await withDb(async ({ db, root, records }) => {
    const context = {
      db,
      listDir: root,
      config: { ai: {} },
      aiConfig: {},
      mcp: null,
      toolCatalog: null,
      composeGenerateObject: async () => ({
        object: {
          outputs: { message: 'Alpha message.' },
          used_inputs: ['account'],
          grounding: [{ output: 'message', text: 'Alpha message.', inputs: ['account'] }],
        },
        usage: {},
      }),
    };
    const cases = [composeStep, extractStep, assignStep, waitStep, manualTaskStep, sendEmailStep, linkedinStep];
    for (const step of cases) {
      const currentRecords = db.prepare('SELECT * FROM records WHERE _row_id IN (?, ?) ORDER BY _row_id').all('tier_a', 'tier_b');
      const outcomes = await executeStepBatch(context, step, step.id, currentRecords);
      const matched = outcomes.get('tier_a');
      const skipped = outcomes.get('tier_b');
      assert.ok(matched, `${step.kind} matched outcome`);
      assert.ok(skipped, `${step.kind} skipped outcome`);
      assert.doesNotMatch(String(matched.reason || ''), /^skipped:/i, `${step.kind} must execute matching records`);
      assert.deepEqual(
        { passed: skipped.passed, reason: skipped.reason, errored: skipped.errored },
        { ...expectedSkip(currentRecords[1], root), errored: undefined },
        `${step.kind} must use the shared skip outcome`,
      );
    }
    assert.equal(db.prepare('SELECT discovered_email FROM records WHERE _row_id = ?').get('tier_a').discovered_email, 'contact@alpha.example');
    assert.equal(db.prepare('SELECT sequence_name FROM records WHERE _row_id = ?').get('tier_a').sequence_name, 'qualified');
  });
});

test('enrich, generate, and newly gated steps report the identical when-skip shape', async () => {
  await withDb(async ({ db, root, records }) => {
    const context = { db, listDir: root, config: { ai: {} }, aiConfig: {}, mcp: null, toolCatalog: null };
    const skipped = records[1];
    const expected = { ...expectedSkip(skipped, root), errored: undefined };
    const cases = [
      { kind: 'enrich', id: 'enrich_gate', inputs: ['tier'], when: whenTierA },
      { kind: 'generate', id: 'generate_gate', inputs: ['tier'], when: whenTierA },
      extractStep,
      waitStep,
    ];
    for (const step of cases) {
      const outcome = (await executeStepBatch(context, step, step.id, [skipped])).get('tier_b');
      assert.deepEqual(
        { passed: outcome.passed, reason: outcome.reason, errored: outcome.errored },
        expected,
        step.kind,
      );
    }
  });
});

test('a skipped gate resolves normally, so its dependent runs unchanged', async () => {
  await withDb(async ({ db, root, records }) => {
    const skippedRecord = records[1];
    const context = { db, listDir: root, config: { ai: {} }, aiConfig: {}, mcp: null, toolCatalog: null };
    const ran = [];
    await runDataflowCore({
      records: [skippedRecord],
      concurrency: 1,
      isTimeReady: () => true,
      steps: [
        { id: extractStep.id, kind: 'extract', deps: [], executable: true, step: extractStep },
        { id: 'dependent', kind: 'assign', deps: [extractStep.id], executable: true, step: { kind: 'assign' } },
      ],
      loadStep: async (selected, record) => {
        ran.push(selected.id);
        if (selected.id === 'dependent') return { passed: true, reason: '' };
        return (await executeStepBatch(context, extractStep, extractStep.id, [record])).get('tier_b');
      },
      onStepOutcome: async (recordState, _selected, outcome) => ({
        record: recordState.record,
        errored: Boolean(outcome.errored),
      }),
    });
    assert.deepEqual(ran, ['extract_email', 'dependent']);
  });
});

test('a step with no when always runs', async () => {
  await withDb(async ({ db, root, records }) => {
    const step = { ...extractStep };
    delete step.when;
    const outcome = (await executeStepBatch(
      { db, listDir: root, config: { ai: {} }, aiConfig: {}, mcp: null, toolCatalog: null },
      step,
      step.id,
      [records[1]],
    )).get('tier_b');
    assert.equal(outcome.passed, true);
    assert.equal(outcome.reason, 'extracted:email:1:site_text');
  });
});

test('a filter skipped by when remains in play and records a distinct passed skip event', async () => {
  const root = listDir();
  writeFileSync(join(root, 'outbound.yaml'), `
ai:
  default_model: anthropic/claude-haiku-4-5-20251001
pipeline:
  - kind: filter
    id: tier_a_gate
    type: field_check
    inputs: [tier, evaluate_gate]
    when:
      match: all
      conditions:
        - field: evaluate_gate
          operator: eq
          value: yes
    match: all
    conditions:
      - field: tier
        operator: eq
        value: A
`);
  const db = openListDb({ listDir: root, readonly: false });
  ensureRecordColumns({ db, columns: ['tier', 'evaluate_gate'] });
  upsertRecord({
    db,
    row: { _row_id: 'filter_passed', business_name: 'Alpha', tier: 'A', evaluate_gate: 'yes' },
  });
  upsertRecord({
    db,
    row: { _row_id: 'filter_skipped', business_name: 'Beta', tier: 'B', evaluate_gate: 'no' },
  });
  upsertRecord({
    db,
    row: { _row_id: 'filter_dropped', business_name: 'Gamma', tier: 'B', evaluate_gate: 'yes' },
  });
  db.close();

  await runPipelineDataflow({ listDir: root });

  const check = openListDb({ listDir: root, readonly: true });
  try {
    const events = check.prepare(`
      SELECT record_id, passed, reason
      FROM pipeline_events
      WHERE step_id = 'tier_a_gate'
      ORDER BY record_id
    `).all();
    assert.deepEqual(events, [
      { record_id: 'filter_dropped', passed: 0, reason: 'Tier is "B" — expected "A"' },
      { record_id: 'filter_passed', passed: 1, reason: '' },
      { record_id: 'filter_skipped', passed: 1, reason: 'skipped:Evaluate gate is "no" — expected "yes"' },
    ]);
    assert.equal(
      check.prepare('SELECT disqualified_at FROM records WHERE _row_id = ?').get('filter_skipped').disqualified_at,
      '',
    );
    assert.notEqual(
      check.prepare('SELECT disqualified_at FROM records WHERE _row_id = ?').get('filter_dropped').disqualified_at,
      '',
    );
  } finally {
    check.close();
  }
});
