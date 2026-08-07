import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openListDb, upsertRecord, getAssetsForRow } from '../dist/orchestrator/runtime/db.js';
import {
  TemplateCompositionError,
  composeStepTemplate,
  resolveStepTemplate,
} from '../dist/orchestrator/lib/templates.js';
import { normalizeConfig } from '../dist/schemas/config.js';

const makeList = () => mkdtempSync(join(tmpdir(), 'agent-outbound-template-composition-'));

const composeConfig = ({ inputs = {
  first_name: { from: 'contact_first_name', required: true },
  company: { from: 'business_name', required: true },
}, length = { max_words: 12, max_sentences: 2 } } = {}) => ({
  ai: {},
  templates: {
    intro: {
      versions: [{
        version: 1,
        composition: {
          model: 'anthropic/claude-haiku-4-5-20251001',
          brief: {
            subject: 'a concise introduction',
            sections: ['greeting', 'one factual reason for writing'],
          },
          inputs,
          rules: ['Use a warm, direct tone.'],
          length,
        },
      }],
    },
  },
});

const record = {
  _row_id: 'template-record-1',
  contact_first_name: 'Ada',
  business_name: 'Acme',
  secret: 'NOT GRANTED',
};

const step = { template: 'intro' };

const withDb = async (callback) => {
  const listDir = makeList();
  const db = openListDb({ listDir });
  upsertRecord({ db, row: record });
  try {
    return await callback({ db, listDir });
  } finally {
    db.close();
  }
};

test('existing substitution templates render byte-identically', () => {
  const config = {
    templates: {
      legacy: {
        versions: [{
          version: 1,
          subject: 'Hi {{ contact_name | default: friend }}',
          body: 'A {{missing | default: "default"}} / {{business_name}} note.',
          variables: { contact_name: 'contact_name' },
        }],
      },
    },
  };
  const resolved = resolveStepTemplate({
    config,
    step: { template: 'legacy' },
    record: { business_name: 'Acme', contact_name: '' },
  });
  assert.equal(resolved.subject, 'Hi friend');
  assert.equal(resolved.body, 'A default / Acme note.');
});

test('composing template produces an audited subject and body from declared inputs', async () => {
  await withDb(async ({ db, listDir }) => {
    assert.deepEqual(normalizeConfig(composeConfig()).errors, []);
    const composed = await composeStepTemplate({
      config: composeConfig(),
      step,
      record,
      db,
      listDir,
      generateObject: async () => ({
        object: {
          subject: 'Hello Ada',
          body: 'Ada, I am writing about Acme.',
          used_inputs: ['first_name', 'company'],
          grounding: [
            { text: 'Hello Ada', inputs: ['first_name'] },
            { text: 'Ada, I am writing about Acme.', inputs: ['first_name', 'company'] },
          ],
        },
        usage: { input_tokens: 4, output_tokens: 3, usd_cost: 0 },
        model: 'anthropic/claude-haiku-4-5-20251001',
        provider: 'anthropic',
      }),
    });
    assert.equal(composed.subject, 'Hello Ada');
    assert.equal(composed.body, 'Ada, I am writing about Acme.');
    const [asset] = getAssetsForRow({ db, rowId: record._row_id });
    const audit = JSON.parse(asset.outputs_json);
    assert.deepEqual(audit.inputs, { first_name: 'Ada', company: 'Acme' });
    assert.deepEqual(audit.used_inputs, ['first_name', 'company']);
    assert.deepEqual(audit.grounding, [
      { text: 'Hello Ada', inputs: ['first_name'] },
      { text: 'Ada, I am writing about Acme.', inputs: ['first_name', 'company'] },
    ]);
    assert.equal(audit.body, composed.body);
  });
});

test('composer cannot receive or cite an ungranted input, and missing required input fails cleanly', async () => {
  await withDb(async ({ db, listDir }) => {
    const prompt = { value: '' };
    await assert.rejects(
      composeStepTemplate({
        config: composeConfig(),
        step,
        record,
        db,
        listDir,
        generateObject: async (request) => {
          prompt.value = request.prompt;
          return {
            object: {
              subject: 'Hello Ada',
              body: 'NOT GRANTED',
              used_inputs: ['secret'],
              grounding: [
                { text: 'Hello Ada', inputs: ['first_name'] },
                { text: 'NOT GRANTED', inputs: ['secret'] },
              ],
            },
            usage: {},
          };
        },
      }),
      TemplateCompositionError,
    );
    assert.equal(prompt.value.includes('NOT GRANTED'), false);
    assert.equal(getAssetsForRow({ db, rowId: record._row_id }).length, 0);

    await assert.rejects(
      composeStepTemplate({
        config: composeConfig(),
        step,
        record: { ...record, contact_first_name: '' },
        db,
        listDir,
        generateObject: async () => {
          throw new Error('must not call model when required inputs are missing');
        },
      }),
      /required input "first_name" is missing or empty/,
    );
  });
});

test('composition enforces its body length budget and never persists partial or hole-bearing email', async () => {
  await withDb(async ({ db, listDir }) => {
    const invalidResults = [
      {
        subject: 'Hello Ada',
        body: 'One two three four five six seven eight nine ten eleven twelve thirteen.',
        used_inputs: ['first_name'],
        grounding: [
          { text: 'Hello Ada', inputs: ['first_name'] },
          { text: 'One two three four five six seven eight nine ten eleven twelve thirteen.', inputs: ['first_name'] },
        ],
      },
      {
        subject: 'Hello {{first_name}}',
        body: 'Hello Ada.',
        used_inputs: ['first_name'],
        grounding: [
          { text: 'Hello {{first_name}}', inputs: ['first_name'] },
          { text: 'Hello Ada.', inputs: ['first_name'] },
        ],
      },
    ];
    for (const object of invalidResults) {
      await assert.rejects(
        composeStepTemplate({
          config: composeConfig(),
          step,
          record,
          db,
          listDir,
          generateObject: async () => ({ object, usage: {} }),
        }),
        TemplateCompositionError,
      );
    }
    assert.equal(getAssetsForRow({ db, rowId: record._row_id }).length, 0);
  });
});
