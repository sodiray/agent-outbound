import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { zodSchema } from 'ai';
import { normalizeConfig } from '../dist/schemas/config.js';
import { buildComposeResultSchema, runComposeStep } from '../dist/orchestrator/compose/runner.js';
import { resolveStepTemplate } from '../dist/orchestrator/lib/templates.js';
import { getAssetsForRow, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';

const listDir = () => mkdtempSync(join(tmpdir(), 'agent-outbound-compose-step-'));

const step = ({ length = { max_words: 12, max_sentences: 2 } } = {}) => ({
  kind: 'compose',
  id: 'channel_copy',
  model: 'anthropic/claude-haiku-4-5-20251001',
  structure: {
    headline: 'A short factual headline.',
    message: ['A greeting.', 'One concise factual point.'],
  },
  inputs: {
    person: { from: 'contact_first_name', required: true },
    account: { from: 'business_name', required: true },
  },
  rules: ['Use a direct tone.'],
  length,
  outputs: {
    headline: { type: 'string', description: 'Short factual headline.' },
    message: { type: 'string', description: 'Structured text.' },
  },
});

const record = {
  _row_id: 'compose-record-1',
  contact_first_name: 'Ada',
  business_name: 'Acme',
  secret: 'NOT GRANTED',
};

const withDb = async (callback) => {
  const root = listDir();
  const db = openListDb({ listDir: root });
  upsertRecord({ db, row: record });
  try {
    return await callback({ db, listDir: root });
  } finally {
    db.close();
  }
};

const validObject = {
  outputs: {
    headline: 'Hello Ada',
    message: 'Ada, this is about Acme.',
  },
  used_inputs: ['person', 'account'],
  grounding: [
    { output: 'headline', text: 'Hello Ada', inputs: ['person'] },
    { output: 'message', text: 'Ada, this is about Acme.', inputs: ['person', 'account'] },
  ],
};

const liveStep = () => ({
  ...step({ length: { max_words: 80, max_sentences: 8 } }),
  structure: {
    email_subject: 'Account name.',
    email_body: ['Greeting.', 'Grounded copy.', 'Call to action.', 'Sign off as Ray from Mission.'],
  },
  inputs: {
    person: { from: 'contact_first_name', required: true },
    account: { from: 'business_name', required: true },
    friction: { value: 'Manual staff coordination for inquiries and payments.', required: true },
  },
  outputs: {
    email_subject: { type: 'string', description: 'Subject.' },
    email_body: { type: 'string', description: 'Body.' },
  },
});

const liveObject = {
  outputs: {
    email_subject: 'Liberty Asset Group',
    email_body: 'Hi Alex,\n\nEvery inquiry and payment at your firm requires manual staff coordination.\n\nI can give you a quick read on where your time is being spent.\n\nWorth a conversation?\n\nRay\nMission',
  },
  used_inputs: ['person', 'account', 'friction'],
  grounding: [
    { output: 'email_body', text: 'Hi Alex,', inputs: ['person'] },
    { output: 'email_subject', text: 'Liberty Asset Group', inputs: ['account'] },
    { output: 'email_body', text: 'Every inquiry and payment at your firm requires manual staff coordination.', inputs: ['friction', 'account'] },
    { output: 'email_body', text: 'I can give you a quick read on where your time is being spent.', inputs: ['friction'] },
    { output: 'email_body', text: 'Worth a conversation?', inputs: ['friction'] },
  ],
};

test('substitution templates remain byte-identical and compose is a validated atomic pipeline step', () => {
  const legacy = resolveStepTemplate({
    config: { templates: { legacy: { versions: [{ version: 1, subject: 'Hi {{name}}', body: 'A {{missing | default: ok}} note.' }] } } },
    step: { template: 'legacy' },
    record: { name: 'Ada' },
  });
  assert.equal(legacy.subject, 'Hi Ada');
  assert.equal(legacy.body, 'A ok note.');
  assert.deepEqual(normalizeConfig({ pipeline: [step()] }).errors, []);
  const executor = readFileSync(new URL('../src/orchestrator/pipeline/step-executor.ts', import.meta.url), 'utf8');
  assert.match(executor, /kind === 'compose'\) return executeComposeBatch/);
});

test('compose response schema requires each declared output by name', async () => {
  const oneOutputStep = {
    ...step(),
    structure: { single: 'One short factual sentence.' },
    outputs: { single: { type: 'string', description: 'One short factual sentence.' } },
  };
  const threeOutputStep = {
    ...step(),
    structure: { first: 'First.', second: 'Second.', third: 'Third.' },
    outputs: {
      first: { type: 'string', description: 'First.' },
      second: { type: 'string', description: 'Second.' },
      third: { type: 'string', description: 'Third.' },
    },
  };
  const schemas = await Promise.all([oneOutputStep, threeOutputStep].map(async (configuredStep) => (
    zodSchema(buildComposeResultSchema(configuredStep)).jsonSchema
  )));

  assert.deepEqual(schemas[0].properties.outputs.properties, {
    single: { type: 'string', minLength: 1 },
  });
  assert.deepEqual(schemas[0].properties.outputs.required, ['single']);
  assert.deepEqual(Object.keys(schemas[1].properties.outputs.properties), ['first', 'second', 'third']);
  assert.deepEqual(schemas[1].properties.outputs.required, ['first', 'second', 'third']);
  assert.equal(schemas[0].properties.outputs.additionalProperties, false);
  assert.equal(schemas[1].properties.outputs.additionalProperties, false);
});

test('compose writes arbitrary declared outputs and persists an auditable asset', async () => {
  await withDb(async ({ db, listDir: root }) => {
    const result = await runComposeStep({
      db,
      listDir: root,
      config: { ai: {} },
      step: step(),
      rows: [record],
      stepId: 'channel_copy',
      generateObject: async () => ({ object: validObject, usage: { input_tokens: 4, output_tokens: 3, usd_cost: 0 } }),
    });
    assert.equal(result.failed, 0, JSON.stringify(result.errors));
    assert.deepEqual(result.declared_output_writes[record._row_id], {
      headline: { provided: true, value: 'Hello Ada' },
      message: { provided: true, value: 'Ada, this is about Acme.' },
    });
    const [asset] = getAssetsForRow({ db, rowId: record._row_id });
    const audit = JSON.parse(asset.outputs_json);
    assert.deepEqual(audit.inputs, { person: 'Ada', account: 'Acme' });
    assert.deepEqual(audit.outputs, validObject.outputs);
    assert.deepEqual(audit.grounding, validObject.grounding);
  });
});

test('compose accepts the live response when only non-assertive boilerplate is uncited', async () => {
  await withDb(async ({ db, listDir: root }) => {
    const liveRecord = { ...record, contact_first_name: 'Alex', business_name: 'Liberty Asset Group' };
    const result = await runComposeStep({
      db,
      listDir: root,
      config: { ai: {} },
      step: liveStep(),
      rows: [liveRecord],
      stepId: 'channel_copy',
      generateObject: async () => ({ object: liveObject, usage: {} }),
    });
    assert.equal(result.failed, 0, JSON.stringify(result.errors));
    assert.deepEqual(result.declared_output_writes[liveRecord._row_id], {
      email_subject: { provided: true, value: 'Liberty Asset Group' },
      email_body: { provided: true, value: liveObject.outputs.email_body },
    });
  });
});

test('compose permits uncited structural language that makes no factual assertion', async () => {
  await withDb(async ({ db, listDir: root }) => {
    const result = await runComposeStep({
      db,
      listDir: root,
      config: { ai: {} },
      step: liveStep(),
      rows: [record],
      stepId: 'channel_copy',
      generateObject: async () => ({
        object: {
          outputs: {
            email_subject: 'Acme',
            email_body: 'Hello Ada,\n\nWorth a conversation?\n\nRay\nMission',
          },
          used_inputs: ['account'],
          grounding: [{ output: 'email_subject', text: 'Acme', inputs: ['account'] }],
        },
        usage: {},
      }),
    });
    assert.equal(result.failed, 0, JSON.stringify(result.errors));
  });
});

test('compose rejects uncited factual claims and reports grounding rather than schema failure', async () => {
  await withDb(async ({ db, listDir: root }) => {
    const claims = [
      'Acme',
      'Boise',
      'Acme has 80 employees.',
      'Acme is based in Boise.',
      'Acme offers commercial lending.',
    ];
    for (const claim of claims) {
      const result = await runComposeStep({
        db,
        listDir: root,
        config: { ai: {} },
        step: liveStep(),
        rows: [record],
        stepId: 'channel_copy',
        generateObject: async () => ({
          object: {
            outputs: {
              email_subject: 'Acme',
              email_body: `Hello Ada,\n\n${claim}\n\nRay\nMission`,
            },
            used_inputs: ['account'],
            grounding: [{ output: 'email_subject', text: 'Acme', inputs: ['account'] }],
          },
          usage: {},
        }),
      });
      assert.equal(result.failed, 1, claim);
      assert.match(result.errors[0].error, /grounding error/i);
      assert.doesNotMatch(result.errors[0].error, /schema/i);
    }
  });
});

test('compose never receives or accepts ungranted facts, and missing required input fails only that record', async () => {
  await withDb(async ({ db, listDir: root }) => {
    const prompt = { value: '' };
    const denied = await runComposeStep({
      db,
      listDir: root,
      config: { ai: {} },
      step: step(),
      rows: [record],
      stepId: 'channel_copy',
      generateObject: async (request) => {
        prompt.value = request.prompt;
        return {
          object: {
            ...validObject,
            outputs: { headline: 'Hello Ada', message: 'NOT GRANTED' },
            used_inputs: ['secret'],
            grounding: [
              { output: 'headline', text: 'Hello Ada', inputs: ['person'] },
              { output: 'message', text: 'NOT GRANTED', inputs: ['secret'] },
            ],
          },
          usage: {},
        };
      },
    });
    assert.equal(prompt.value.includes('NOT GRANTED'), false);
    assert.equal(denied.failed, 1);
    assert.match(denied.errors[0].error, /ungranted inputs/);
    assert.equal(getAssetsForRow({ db, rowId: record._row_id }).length, 0);

    const missing = await runComposeStep({
      db,
      listDir: root,
      config: { ai: {} },
      step: step(),
      rows: [{ ...record, contact_first_name: '' }],
      stepId: 'channel_copy',
      generateObject: async () => {
        throw new Error('model must not be called');
      },
    });
    assert.equal(missing.failed, 1);
    assert.match(missing.errors[0].error, /required input "person"/);
  });
});

test('compose rejects over-budget, partial, hole-bearing, and ungrounded outputs without persisting an asset', async () => {
  await withDb(async ({ db, listDir: root }) => {
    const invalid = [
      {
        ...validObject,
        outputs: { headline: 'Hello Ada', message: 'One two three four five six seven eight nine ten eleven twelve.' },
        grounding: [
          { output: 'headline', text: 'Hello Ada', inputs: ['person'] },
          { output: 'message', text: 'One two three four five six seven eight nine ten eleven twelve.', inputs: ['person'] },
        ],
      },
      {
        ...validObject,
        outputs: { headline: 'Hello {{person}}', message: 'Ada, this is about Acme.' },
        grounding: [
          { output: 'headline', text: 'Hello {{person}}', inputs: ['person'] },
          { output: 'message', text: 'Ada, this is about Acme.', inputs: ['person', 'account'] },
        ],
      },
      {
        ...validObject,
        outputs: { headline: 'Hello Ada' },
        grounding: [{ output: 'headline', text: 'Hello Ada', inputs: ['person'] }],
      },
      {
        ...validObject,
        grounding: [{ output: 'headline', text: 'Hello Ada', inputs: ['person'] }],
      },
    ];
    for (const object of invalid) {
      const result = await runComposeStep({
        db,
        listDir: root,
        config: { ai: {} },
        step: step(),
        rows: [record],
        stepId: 'channel_copy',
        generateObject: async () => ({ object, usage: {} }),
      });
      assert.equal(result.failed, 1);
    }
    assert.equal(getAssetsForRow({ db, rowId: record._row_id }).length, 0);
  });
});
