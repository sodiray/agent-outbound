import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeEnrichmentStepOnRecords } from '../dist/orchestrator/enrichment/runner.js';
import { runGenerateStep } from '../dist/orchestrator/generate/runner.js';
import { runComposeStep } from '../dist/orchestrator/compose/runner.js';
import { runScoreStage } from '../dist/orchestrator/scoring/stage-runner.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { normalizeConfig } from '../dist/schemas/config.js';

const listDir = () => mkdtempSync(join(tmpdir(), 'agent-outbound-step-memoization-'));

const memoizedStep = (overrides = {}) => ({
  kind: 'enrich',
  id: 'expensive_lookup',
  inputs: {
    lookup_subject: { from: 'website' },
    lookup_mode: { value: 'primary' },
  },
  outputs: {
    lookup_result: { type: 'string', description: 'Settled lookup result.' },
  },
  ...overrides,
});

const currentRecord = (db) => db.prepare('SELECT * FROM records WHERE _row_id = ?').get('memoization-record');

const withDb = async (callback) => {
  const root = listDir();
  const db = openListDb({ listDir: root, readonly: false });
  ensureRecordColumns({ db, columns: ['website', 'lookup_result'] });
  upsertRecord({ db, row: { _row_id: 'memoization-record', business_name: 'Memo Inc.', website: 'https://one.example' } });
  try {
    return await callback({ db, root });
  } finally {
    db.close();
  }
};

const execute = ({ db, root, step, executeAction, force = false }) => executeEnrichmentStepOnRecords({
  db,
  listDir: root,
  config: { ai: {} },
  mcp: null,
  toolCatalog: null,
  step,
  rows: [currentRecord(db)],
  executeAction,
  force,
});

test('enrich steps memoize by default and replay identical outputs for unchanged resolved inputs', async () => {
  let providerCalls = 0;
  const executeAction = async ({ record }) => {
    providerCalls += 1;
    return { outputs: { lookup_result: `result:${record.website}` }, usage: {} };
  };

  await withDb(async ({ db, root }) => {
    const step = memoizedStep();
    const first = await execute({ db, root, step, executeAction });
    const firstOutput = currentRecord(db).lookup_result;
    const second = await execute({ db, root, step, executeAction });

    assert.equal(first.processed, 1);
    assert.equal(second.memoization_hits, 1);
    assert.equal(second.non_execution_reasons['memoization-record'], 'memoization_hit');
    assert.equal(providerCalls, 1);
    assert.equal(currentRecord(db).lookup_result, firstOutput);
    assert.equal(db.prepare('SELECT cache_ttl_seconds FROM staleness WHERE record_id = ? AND step_id = ?')
      .get('memoization-record', step.id).cache_ttl_seconds, 90 * 86400);

    const forced = await execute({ db, root, step, executeAction, force: true });
    assert.equal(forced.processed, 1);
    assert.equal(providerCalls, 2, '--force bypasses a memoized result');
  });
});

test('memoize: false opts out and re-executes each time', async () => {
  let providerCalls = 0;
  const executeAction = async () => {
    providerCalls += 1;
    return { outputs: { lookup_result: `result:${providerCalls}` }, usage: {} };
  };

  await withDb(async ({ db, root }) => {
    const step = memoizedStep({ memoize: false });
    await execute({ db, root, step, executeAction });
    const second = await execute({ db, root, step, executeAction });

    assert.equal(second.processed, 1);
    assert.equal(second.memoization_hits, 0);
    assert.equal(providerCalls, 2);
    assert.equal(currentRecord(db).lookup_result, 'result:2');
  });
});

test('memoized enrich steps invalidate when a declared input changes', async () => {
  let providerCalls = 0;
  const executeAction = async ({ record }) => {
    providerCalls += 1;
    return { outputs: { lookup_result: `result:${record.website}` }, usage: {} };
  };

  await withDb(async ({ db, root }) => {
    const step = memoizedStep();
    await execute({ db, root, step, executeAction });
    upsertRecord({ db, row: { ...currentRecord(db), website: 'https://two.example' } });
    const second = await execute({ db, root, step, executeAction });

    assert.equal(second.processed, 1);
    assert.equal(providerCalls, 2);
    assert.equal(currentRecord(db).lookup_result, 'result:https://two.example');
  });
});

test('changing only tool arguments invalidates an enrich memoization result with byte-identical declared inputs', async () => {
  let providerCalls = 0;
  const executeAction = async () => {
    providerCalls += 1;
    return { outputs: { lookup_result: `result:${providerCalls}` }, usage: {} };
  };

  await withDb(async ({ db, root }) => {
    const onePage = memoizedStep({
      tool: { server: 'web', name: 'crawl_site' },
      args: { max_pages: 1 },
    });
    const eightPages = { ...onePage, args: { max_pages: 8 } };

    await execute({ db, root, step: onePage, executeAction });
    const second = await execute({ db, root, step: eightPages, executeAction });

    assert.equal(second.processed, 1);
    assert.equal(providerCalls, 2);
  });
});

test('changing only a model or description invalidates an enrich memoization result', async () => {
  let providerCalls = 0;
  const executeAction = async () => {
    providerCalls += 1;
    return { outputs: { lookup_result: `result:${providerCalls}` }, usage: {} };
  };

  await withDb(async ({ db, root }) => {
    const initial = memoizedStep({ model: 'openai/gpt-4.1-mini', description: 'Classify the supplied website.' });
    const changedModel = { ...initial, model: 'anthropic/claude-haiku-4.5' };
    const changedDescription = { ...changedModel, description: 'Classify the supplied website with full coverage.' };

    await execute({ db, root, step: initial, executeAction });
    await execute({ db, root, step: changedModel, executeAction });
    await execute({ db, root, step: changedDescription, executeAction });

    assert.equal(providerCalls, 3);
  });
});

test('v1 memoization entries never serve results under the v2 fingerprint scheme', async () => {
  let providerCalls = 0;
  const executeAction = async () => {
    providerCalls += 1;
    return { outputs: { lookup_result: `result:${providerCalls}` }, usage: {} };
  };

  await withDb(async ({ db, root }) => {
    const step = memoizedStep();
    await execute({ db, root, step, executeAction });
    db.prepare('UPDATE staleness SET policy_hash = ? WHERE record_id = ? AND step_id = ?')
      .run('step-memoization-v1', 'memoization-record', step.id);

    const second = await execute({ db, root, step, executeAction });

    assert.equal(second.processed, 1);
    assert.equal(providerCalls, 2);
  });
});

test('memoized enrich steps never cache provider errors', async () => {
  let providerCalls = 0;
  const executeAction = async () => {
    providerCalls += 1;
    throw new Error('temporary provider outage');
  };

  await withDb(async ({ db, root }) => {
    const step = memoizedStep();
    const first = await execute({ db, root, step, executeAction });
    const callsAfterFirstRun = providerCalls;
    const second = await execute({ db, root, step, executeAction });

    assert.equal(first.failed, 1);
    assert.equal(second.failed, 1);
    assert.ok(providerCalls > callsAfterFirstRun, 'the next run must call the provider again');
    assert.equal(db.prepare('SELECT 1 FROM staleness WHERE record_id = ? AND step_id = ?')
      .get('memoization-record', step.id), undefined);
  });
});

test('memoization config rejects unknown keys', () => {
  const valid = normalizeConfig({ pipeline: [memoizedStep({ memoize: { ttl_days: 30 } })] });
  const validKinds = normalizeConfig({ pipeline: [
    {
      kind: 'generate', id: 'memoized_generate_config', inputs: ['website'], memoize: {},
      outputs: { generated_result: { type: 'string', description: 'Generated result.' } },
    },
    {
      kind: 'score', id: 'memoized_score_config', key: 'fit', model: 'openrouter/anthropic/claude-haiku-4.5', memoize: {},
      inputs: ['website'], criteria: [],
      outputs: { fit_score: { type: 'number' }, fit_breakdown: { type: 'json' }, fit_reasoning: { type: 'string' } },
    },
    {
      kind: 'compose', id: 'memoized_compose_config', model: 'openrouter/anthropic/claude-haiku-4.5', memoize: {},
      inputs: { subject: { from: 'website' } }, structure: { headline: 'Headline.' }, length: { max_words: 10 },
      outputs: { headline: { type: 'string', description: 'Headline.' } },
    },
  ] });
  const invalid = normalizeConfig({ pipeline: [memoizedStep({ memoize: { ttl_dyas: 30 } })] });
  const optOut = normalizeConfig({ pipeline: [memoizedStep({ memoize: false })] });

  assert.deepEqual(valid.errors, []);
  assert.deepEqual(validKinds.errors, []);
  assert.deepEqual(optOut.errors, []);
  assert.ok(invalid.errors.length > 0);
  assert.match(invalid.error, /ttl_dyas|Unrecognized key/i);
});

test('side-effecting send steps cannot enable memoization', () => {
  const result = normalizeConfig({ pipeline: [{
    kind: 'send_email',
    id: 'external_send',
    side_effecting: true,
    memoize: {},
    inputs: [],
  }] });

  assert.ok(result.errors.length > 0);
  assert.match(result.error, /memoization.*side-effecting|Expected never/i);
});

test('memoized generate steps replay their settled output and re-execute when a declared input changes', async () => {
  let providerCalls = 0;
  const step = {
    kind: 'generate',
    id: 'memoized_generate',
    inputs: { subject: { from: 'website' } },
    outputs: { generated_result: { type: 'string', description: 'Generated result.' } },
    memoize: {},
  };
  await withDb(async ({ db, root }) => {
    ensureRecordColumns({ db, columns: ['generated_result'] });
    const run = () => runGenerateStep({
      db,
      listDir: root,
      config: { ai: {} },
      step,
      rows: [currentRecord(db)],
      executeAction: async ({ record }) => {
        providerCalls += 1;
        return { outputs: { generated_result: `generated:${record.website}` }, usage: {} };
      },
    });
    await run();
    const firstOutput = currentRecord(db).generated_result;
    const second = await run();
    assert.equal(providerCalls, 1);
    assert.equal(second.memoization_hits, 1);
    assert.equal(second.non_execution_reasons['memoization-record'], 'memoization_hit');
    assert.equal(currentRecord(db).generated_result, firstOutput);

    upsertRecord({ db, row: { ...currentRecord(db), website: 'https://changed.example' } });
    await run();
    assert.equal(providerCalls, 2);
    assert.equal(currentRecord(db).generated_result, 'generated:https://changed.example');
  });
});

test('memoized compose steps replay their settled output and re-execute when a declared input changes', async () => {
  let providerCalls = 0;
  const step = {
    kind: 'compose',
    id: 'memoized_compose',
    model: 'openrouter/anthropic/claude-haiku-4.5',
    inputs: { subject: { from: 'website' } },
    structure: { headline: 'A brief headline.' },
    length: { max_words: 10 },
    outputs: { headline: { type: 'string', description: 'Headline.' } },
    memoize: {},
  };
  await withDb(async ({ db, root }) => {
    ensureRecordColumns({ db, columns: ['headline'] });
    const run = () => runComposeStep({
      db,
      listDir: root,
      config: { ai: {} },
      step,
      rows: [currentRecord(db)],
      stepId: step.id,
      generateObject: async () => {
        providerCalls += 1;
        return { object: { outputs: { headline: 'A brief note' } }, usage: {} };
      },
    });
    await run();
    const firstOutput = currentRecord(db).headline;
    const second = await run();
    assert.equal(providerCalls, 1);
    assert.equal(second.memoization_hits, 1);
    assert.equal(second.non_execution_reasons['memoization-record'], 'memoization_hit');
    assert.equal(currentRecord(db).headline, firstOutput);

    upsertRecord({ db, row: { ...currentRecord(db), website: 'https://changed.example' } });
    await run();
    assert.equal(providerCalls, 2);
  });
});

test('memoized score steps cache the complete sampled result and invalidate declared inputs and samples', async () => {
  let providerCalls = 0;
  const step = {
    kind: 'score',
    id: 'memoized_score',
    key: 'fit',
    model: 'openrouter/anthropic/claude-haiku-4.5',
    inputs: { evidence: { from: 'website' } },
    criteria: [{ id: 'fit', weight: 1, description: 'Declared evidence fit.' }],
    outputs: {
      fit_score: { type: 'number' },
      fit_breakdown: { type: 'json' },
      fit_reasoning: { type: 'string' },
    },
    memoize: {},
  };
  await withDb(async ({ db, root }) => {
    const run = (samples) => runScoreStage({
      db,
      listDir: root,
      config: { ai: {}, score: { samples } },
      step,
      rows: [currentRecord(db)],
      generateObject: async () => {
        providerCalls += 1;
        return {
          object: {
            criteria: [{ id: 'fit', grade: 6, assessable: true, reasoning: 'Declared evidence supports fit.' }],
            summary_reasoning: 'Settled score.',
          },
          usage: {},
        };
      },
    });
    await run(3);
    const first = currentRecord(db);
    const second = await run(3);
    assert.equal(providerCalls, 3, 'a cached samples: 3 result must not create another draw');
    assert.equal(second.get('memoization-record').reason, 'memoization_hit');
    assert.equal(currentRecord(db).fit_score, first.fit_score);
    assert.equal(JSON.parse(currentRecord(db).fit_breakdown).samples, 3);

    upsertRecord({ db, row: { ...currentRecord(db), website: 'https://changed.example' } });
    await run(3);
    assert.equal(providerCalls, 6, 'a changed declared input re-executes all three draws');

    await run(2);
    assert.equal(providerCalls, 8, 'changing samples invalidates the memoized full sampled result');
    assert.equal(JSON.parse(currentRecord(db).fit_breakdown).samples, 2);
  });
});

test('memoized generate, compose, and score errors re-execute and never leave a staleness entry', async () => {
  const generateStep = {
    kind: 'generate', id: 'memoized_generate_error', inputs: { subject: { from: 'website' } }, memoize: {},
    outputs: { generated_result: { type: 'string', description: 'Generated result.' } },
  };
  const composeStep = {
    kind: 'compose', id: 'memoized_compose_error', model: 'openrouter/anthropic/claude-haiku-4.5', memoize: {},
    inputs: { subject: { from: 'website' } }, structure: { headline: 'Headline.' }, length: { max_words: 10 },
    outputs: { headline: { type: 'string', description: 'Headline.' } },
  };
  const scoreStep = {
    kind: 'score', id: 'memoized_score_error', key: 'fit', model: 'openrouter/anthropic/claude-haiku-4.5', memoize: {},
    inputs: { subject: { from: 'website' } }, criteria: [{ id: 'fit', weight: 1, description: 'Declared fit.' }],
    outputs: { fit_score: { type: 'number' }, fit_breakdown: { type: 'json' }, fit_reasoning: { type: 'string' } },
  };
  await withDb(async ({ db, root }) => {
    let generateCalls = 0;
    const runGenerate = () => runGenerateStep({
      db, listDir: root, config: { ai: {} }, step: generateStep, rows: [currentRecord(db)],
      executeAction: async () => { generateCalls += 1; throw new Error('temporary generate outage'); },
    });
    await runGenerate();
    await runGenerate();
    assert.equal(generateCalls, 2);

    let composeCalls = 0;
    const runCompose = () => runComposeStep({
      db, listDir: root, config: { ai: {} }, step: composeStep, rows: [currentRecord(db)], stepId: composeStep.id,
      generateObject: async () => { composeCalls += 1; throw new Error('temporary compose outage'); },
    });
    await runCompose();
    await runCompose();
    assert.equal(composeCalls, 2);

    let scoreCalls = 0;
    const runScore = () => runScoreStage({
      db, listDir: root, config: { ai: {} }, step: scoreStep, rows: [currentRecord(db)],
      generateObject: async () => { scoreCalls += 1; throw new Error('temporary score outage'); },
    });
    await runScore();
    await runScore();
    assert.equal(scoreCalls, 2);

    for (const stepId of [generateStep.id, composeStep.id, scoreStep.id]) {
      assert.equal(db.prepare('SELECT 1 FROM staleness WHERE record_id = ? AND step_id = ?')
        .get('memoization-record', stepId), undefined);
    }
  });
});
