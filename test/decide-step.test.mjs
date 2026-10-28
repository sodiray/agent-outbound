import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { pipelineCommand } from '../dist/commands/index.js';
import { configValidateCommand } from '../dist/commands/safety.js';
import { reviewPassCommand } from '../dist/commands/review.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { readConfig } from '../dist/orchestrator/lib/config.js';
import { ingestExternalEvents } from '../dist/orchestrator/runtime/external-events.js';

const healthyAnswers = ({ confidence = 0.9 } = {}) => ({
  answers: {
    company_type: { type: 'choice', choice: 'mep', confidence, probabilities: { mep: 0.9, other: 0.1 } },
    fit_score: { type: 'score', score: 1.5, confidence: 0.7, probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 } },
    is_estimator: { type: 'noul', noul: 0.8 },
    stage: { type: 'choice', choice: 'active', confidence: 0.8, probabilities: { active: 0.8, inactive: 0.2 } },
  },
  usage: { input_tokens: 4, output_tokens: 2 },
});

const withFakeJev = async (t, handler, callback) => {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    await handler({ request: JSON.parse(Buffer.concat(chunks).toString('utf8')), response });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if ((error).code === 'EPERM') {
      t.skip('local TCP listeners are unavailable in this sandbox');
      return undefined;
    }
    throw error;
  }
  const address = server.address();
  const priorUrl = process.env.JEV_BASE_URL;
  const priorKey = process.env.TEST_JEV_KEY;
  const priorTimeout = process.env.JEV_TIMEOUT_MS;
  process.env.JEV_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.TEST_JEV_KEY = 'fake-key';
  process.env.JEV_TIMEOUT_MS = '50';
  try {
    return await callback();
  } finally {
    if (priorUrl === undefined) delete process.env.JEV_BASE_URL; else process.env.JEV_BASE_URL = priorUrl;
    if (priorKey === undefined) delete process.env.TEST_JEV_KEY; else process.env.TEST_JEV_KEY = priorKey;
    if (priorTimeout === undefined) delete process.env.JEV_TIMEOUT_MS; else process.env.JEV_TIMEOUT_MS = priorTimeout;
    await new Promise((resolve) => server.close(resolve));
  }
};

const yamlFor = ({ includeReview = false } = {}) => `
ai:
  defaults:
    research: openai/gpt-4o-mini
  decide:
    model: jev-1.13.0
    api_key_env: TEST_JEV_KEY
source:
  identity: [title, company]
sequences:
  default: { steps: [] }
pipeline:
  - kind: decide
    id: decide_fit
    state: [title, company]
    questions:
      company_type:
        type: choice
        instructions: Classify this company.
        options: { mep: MEP subcontractor, other: Other }
      fit_score:
        type: score
        instructions: Rate fit.
        levels: [poor, possible, strong]
      is_estimator:
        type: yes_no
        instructions: Is this person an estimator?
      stage:
        type: choice
        instructions: Classify the stage.
        options_file: stages.yaml
        option_text: applies_when
${includeReview ? `  - kind: review
    id: confidence_review
    depends_on: [decide_fit]
    when:
      conditions:
        - field: company_type_confidence
          operator: lt
          value: 0.8
    fields: [company, company_type_confidence]
    edit_fields: [company]
` : ''}`;

const onEventDecideYamlFor = ({ untilField = 'stage' } = {}) => `
ai:
  defaults:
    research: openai/gpt-4o-mini
  decide:
    model: jev-1.13.0
    api_key_env: TEST_JEV_KEY
pipeline:
  - kind: on_event
    id: reply_turn
    source: fixture
    event: inbound
    reference_field: conversation_ref
    event_fields:
      inbound_text: text
    until:
      conditions:
        - field: ${untilField}
          operator: eq
          value: closed
    steps:
      - kind: decide
        id: classify_stage
        state: [inbound_text]
        questions:
          stage:
            type: choice
            instructions: Classify the conversation stage.
            options_file: stages.yaml
            option_text: applies_when
`;

const fixture = ({ yaml = yamlFor(), rows = [{ _row_id: 'decide-1', business_name: 'Decide One', title: 'Estimator', company: 'Acme MEP' }] } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'agent-outbound-decide-'));
  writeFileSync(join(root, 'outbound.yaml'), yaml);
  writeFileSync(join(root, 'stages.yaml'), 'active:\n  applies_when: Work is active.\n  guidance: Send a technical message.\ninactive:\n  applies_when: Work is inactive.\n  guidance: Do not contact.\n');
  const db = openListDb({ listDir: root, readonly: false });
  rows.forEach((row) => upsertRecord({ db, row }));
  db.close();
  return root;
};

const row = (root, id) => {
  const db = openListDb({ listDir: root, readonly: true });
  try { return db.prepare('SELECT * FROM records WHERE _row_id = ?').get(id); } finally { db.close(); }
};

const ingestEvent = ({ root, event }) => {
  const loaded = readConfig(root);
  assert.deepEqual(loaded.errors, []);
  const db = openListDb({ listDir: root, readonly: false });
  try {
    return ingestExternalEvents({ db, config: loaded.config, listDir: root, events: [event] });
  } finally {
    db.close();
  }
};

test('decide pipeline writes typed Jev outputs and option-file extras', async (t) => {
  const seen = [];
  await withFakeJev(t, async ({ request, response }) => {
    seen.push(request);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(healthyAnswers()));
  }, async () => {
    const root = fixture();
    await pipelineCommand({ list: root });
    const result = row(root, 'decide-1');
    assert.equal(result.company_type, 'mep');
    assert.equal(result.company_type_confidence, 0.9);
    assert.deepEqual(JSON.parse(result.company_type_probabilities), { mep: 0.9, other: 0.1 });
    assert.equal(result.fit_score, 1.5);
    assert.equal(result.fit_score_confidence, 0.7);
    assert.deepEqual(JSON.parse(result.fit_score_probabilities), { 0: 0.1, 1: 0.3, 2: 0.6 });
    assert.equal(result.is_estimator, 0.8);
    assert.equal(result.stage_guidance, 'Send a technical message.');
    assert.deepEqual(seen[0].questions.stage.criteria, { active: 'Work is active.', inactive: 'Work is inactive.' });
  });
});

test('decide pipeline retries 500, timeout, and malformed answers without writing decisions', async (t) => {
  const modes = ['500', 'timeout', 'malformed'];
  for (const mode of modes) {
    const state = { mode, calls: 0 };
    await withFakeJev(t, async ({ response }) => {
      state.calls += 1;
      if (state.mode === '500') { response.statusCode = 500; response.end('nope'); return; }
      if (state.mode === 'timeout') { setTimeout(() => response.end(JSON.stringify(healthyAnswers())), 100); return; }
      if (state.mode === 'malformed') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ answers: { company_type: { type: 'choice' } } })); return; }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(healthyAnswers()));
    }, async () => {
      const root = fixture();
      await pipelineCommand({ list: root });
      const failed = row(root, 'decide-1');
      assert.equal(failed.company_type, '');
      assert.equal(failed.fit_score, null);
      assert.equal(failed.is_estimator, null);
      state.mode = 'healthy';
      await pipelineCommand({ list: root });
      assert.equal(row(root, 'decide-1').company_type, 'mep', mode);
      assert.equal(state.calls, 2, mode);
    });
  }
});

test('decide config validation requires model and key only when decide is configured', async () => {
  const priorKey = process.env.TEST_JEV_KEY;
  delete process.env.TEST_JEV_KEY;
  try {
    const withDecide = fixture();
    const missing = await configValidateCommand({ list: withDecide });
    assert.ok(missing.errors.some((error) => error.includes('TEST_JEV_KEY')));
    const noModel = fixture({ yaml: yamlFor().replace('    model: jev-1.13.0\n', '') });
    process.env.TEST_JEV_KEY = 'fake-key';
    const model = await configValidateCommand({ list: noModel });
    assert.ok(model.errors.some((error) => error.includes('ai.decide.model')));
    const invalidEmpty = fixture({ yaml: yamlFor().replace('    questions:', '    on_error: empty\n    questions:') });
    const empty = await configValidateCommand({ list: invalidEmpty });
    assert.ok(empty.errors.some((error) => error.includes('on_error')));
    delete process.env.TEST_JEV_KEY;
    const withoutDecide = fixture({ yaml: 'sequences:\n  default: { steps: [] }\npipeline: []\n' });
    const clear = await configValidateCommand({ list: withoutDecide });
    assert.equal(clear.errors.length, 0);
  } finally {
    if (priorKey === undefined) delete process.env.TEST_JEV_KEY; else process.env.TEST_JEV_KEY = priorKey;
  }
});

test('on_event until accepts an inner decide choice output', async () => {
  const priorKey = process.env.TEST_JEV_KEY;
  process.env.TEST_JEV_KEY = 'fake-key';
  try {
    const result = await configValidateCommand({ list: fixture({ yaml: onEventDecideYamlFor() }) });
    assert.deepEqual(result.errors, []);
  } finally {
    if (priorKey === undefined) delete process.env.TEST_JEV_KEY; else process.env.TEST_JEV_KEY = priorKey;
  }
});

test('on_event until accepts inner decide confidence and options-file extra outputs', async () => {
  const priorKey = process.env.TEST_JEV_KEY;
  process.env.TEST_JEV_KEY = 'fake-key';
  try {
    for (const untilField of ['stage_confidence', 'stage_guidance']) {
      const result = await configValidateCommand({ list: fixture({ yaml: onEventDecideYamlFor({ untilField }) }) });
      assert.deepEqual(result.errors, [], untilField);
    }
  } finally {
    if (priorKey === undefined) delete process.env.TEST_JEV_KEY; else process.env.TEST_JEV_KEY = priorKey;
  }
});

test('on_event until still rejects an unknown inner field', async () => {
  const priorKey = process.env.TEST_JEV_KEY;
  process.env.TEST_JEV_KEY = 'fake-key';
  try {
    const result = await configValidateCommand({ list: fixture({ yaml: onEventDecideYamlFor({ untilField: 'stage_typo' }) }) });
    assert.deepEqual(result.errors, ['on_event "reply_turn" until references unknown field "stage_typo".']);
  } finally {
    if (priorKey === undefined) delete process.env.TEST_JEV_KEY; else process.env.TEST_JEV_KEY = priorKey;
  }
});

test('on_event ignores a second event after an inner decide closes the conversation', async (t) => {
  await withFakeJev(t, async ({ response }) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      answers: {
        stage: { type: 'choice', choice: 'closed', confidence: 0.95, probabilities: { closed: 0.95, active: 0.05 } },
      },
      usage: { input_tokens: 4, output_tokens: 2 },
    }));
  }, async () => {
    const root = fixture({ yaml: onEventDecideYamlFor(), rows: [{ _row_id: 'event-decide-1', business_name: 'Decide One', conversation_ref: 'conversation-1' }] });
    const db = openListDb({ listDir: root, readonly: false });
    ensureRecordColumns({ db, columns: ['conversation_ref'] });
    upsertRecord({ db, row: { ...db.prepare('SELECT * FROM records WHERE _row_id = ?').get('event-decide-1'), conversation_ref: 'conversation-1' } });
    db.close();
    ingestEvent({ root, event: { id: 'event-1', source: 'fixture', type: 'inbound', reference: 'conversation-1', occurred_at: '2026-01-01T00:00:00.000Z', data: { text: 'Please close this.' } } });
    await pipelineCommand({ list: root });
    assert.equal(row(root, 'event-decide-1').stage, 'closed');
    ingestEvent({ root, event: { id: 'event-2', source: 'fixture', type: 'inbound', reference: 'conversation-1', occurred_at: '2026-01-01T00:01:00.000Z', data: { text: 'Still closed.' } } });
    await pipelineCommand({ list: root });
    const dbAfter = openListDb({ listDir: root, readonly: true });
    try {
      assert.deepEqual(dbAfter.prepare('SELECT event_id, status FROM event_turns ORDER BY turn_index').all(), [
        { event_id: 'event-1', status: 'completed' },
        { event_id: 'event-2', status: 'ignored' },
      ]);
    } finally {
      dbAfter.close();
    }
  });
});

test('decide confidence review parks only low-confidence records and review edits are audited', async (t) => {
  await withFakeJev(t, async ({ request, response }) => {
    const confidence = request.state.company === 'Low Co' ? 0.6 : 0.95;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(healthyAnswers({ confidence })));
  }, async () => {
    const root = fixture({
      yaml: yamlFor({ includeReview: true }),
      rows: [
        { _row_id: 'decide-low', business_name: 'Low Co', title: 'Estimator', company: 'Low Co' },
        { _row_id: 'decide-high', business_name: 'High Co', title: 'Estimator', company: 'High Co' },
      ],
    });
    await pipelineCommand({ list: root });
    const db = openListDb({ listDir: root, readonly: true });
    const awaiting = db.prepare("SELECT record_id FROM pipeline_events WHERE step_id = 'confidence_review' AND reason = 'awaiting_review'").all();
    db.close();
    assert.deepEqual(awaiting.map((entry) => entry.record_id), ['decide-low']);
    const approved = reviewPassCommand({ list: root, ref: 'decide-low', stage: 'confidence_review', edits: { company: 'Corrected Co' } });
    assert.equal(approved.status, 'review_approved');
    const edited = row(root, 'decide-low');
    assert.equal(edited.company, 'Corrected Co');
    assert.match(edited.transition_audit_json, /review:confidence_review: edited company/);
    assert.throws(() => reviewPassCommand({ list: root, ref: 'decide-low', stage: 'confidence_review', edits: { title: 'Forbidden' } }), /does not allow edits to: title/);
  });
});

test('decide options-file guidance changes invalidate memoization', async (t) => {
  const calls = { count: 0 };
  await withFakeJev(t, async ({ response }) => {
    calls.count += 1;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(healthyAnswers()));
  }, async () => {
    const root = fixture();
    await pipelineCommand({ list: root });
    await pipelineCommand({ list: root });
    assert.equal(calls.count, 1);
    writeFileSync(join(root, 'stages.yaml'), 'active:\n  applies_when: Work is active.\n  guidance: Updated guidance.\ninactive:\n  applies_when: Work is inactive.\n  guidance: Do not contact.\n');
    await pipelineCommand({ list: root });
    assert.equal(calls.count, 2);
    assert.equal(row(root, 'decide-1').stage_guidance, 'Updated guidance.');
  });
});
