import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  didExecuteStep,
  executeStepBatch,
  shouldGuardDeclaredOutputWrites,
} from '../dist/orchestrator/pipeline/step-executor.js';
import { executeEnrichmentStepOnRecords } from '../dist/orchestrator/enrichment/runner.js';
import { executeDecideStepOnRecords } from '../dist/orchestrator/decide/runner.js';
import { runGenerateStep } from '../dist/orchestrator/generate/runner.js';
import { runComposeStep } from '../dist/orchestrator/compose/runner.js';
import { runScoreStage } from '../dist/orchestrator/scoring/stage-runner.js';
import { PipelineStepSchema } from '../dist/schemas/config.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';

// Conformance, not features. A runner's bookkeeping is the thing under test:
// when a step does no work for a record and still reports `passed: true`, it
// must SAY it did no work (`executed: false`) or attach the declared-output
// write claims that make its pass checkable. A cached path that reports neither
// reaches the declared-output guard with an empty write map, the guard falls
// back to demanding every declared output on the record, and every record whose
// optional outputs are legitimately blank is hard-errored — which then cascades
// through depends_on and strands the record.
//
// That is what shipped: the memoization work introduced 'memoization_hit' as a
// new spelling of "did not execute" and the guard's reason regex did not know
// it. Non-execution is a value now, so a new cache path has to state it, and
// this file is what fails when it doesn't.

const RECORD_ID = 'conformance-record';

/**
 * Every step kind must be classified. The list is read from the config schema,
 * so a newly added kind — the vehicle a new runner arrives in — fails here
 * until someone decides which column it belongs in.
 */
const CACHED_PASS_KINDS = new Set([
  // Kinds with a path that returns `passed: true` without doing the work.
  'enrich',
  'generate',
  'compose',
  'score',
  'extract',
  'await_event',
  'decide',
]);

const NO_CACHED_PASS_KINDS = {
  // Kinds with no cache/replay path of their own. Their only non-execution is
  // the shared `when` gate, which states `executed: false` in one place
  // (skippedWhenOutcome) and is pinned by pipeline-when-gates.test.mjs.
  action: 'Uses the shared idempotency boundary; completed skips explicitly state non-execution.',
  filter: 'Re-evaluates its conditions on every run; nothing is cached.',
  exit: 'Re-evaluates its conditions on every run; nothing is cached.',
  contact_source: 'Promotes from the record every run; nothing is cached.',
  assign: 'Routes from the record every run; nothing is cached.',
  review: 'Reads override rows every run; a pass means a human verdict exists.',
  wait: 'Passes unconditionally; declares no outputs.',
  manual_task: 'Never passes from the engine — it parks for a human.',
  pipeline: 'A container; flattened before execution, never executed.',
  on_event: 'A turn container; its inner steps execute through the event-turn runner.',
  send_email: 'Engine-owned transmitter; its skips are passed:false or state executed:false.',
  send_sms: 'Engine-owned transmitter; its skips are passed:false or state executed:false.',
  linkedin_connect: 'Engine-owned transmitter; its skips are passed:false or state executed:false.',
};

/**
 * The invariant, for a step that declares outputs: a passing outcome the guard
 * will check must carry write claims. Without them the guard falls back to
 * "every declared output must be present on the record", which hard-errors any
 * record whose optional outputs are legitimately blank. An outcome the guard
 * exempts — one that states it did no work and claims nothing — is fine.
 */
const assertGuardableOutcome = (outcome, label) => {
  assert.ok(outcome, `${label}: outcome missing`);
  if (!outcome.passed) return;
  if (!shouldGuardDeclaredOutputWrites(outcome)) return;
  assert.ok(
    outcome.declaredOutputWrites && typeof outcome.declaredOutputWrites === 'object',
    `${label}: a guarded pass must attach declared-output write claims, or the guard falls back to `
    + 'demanding every declared output on the record',
  );
};

/** A cache hit did no work, so it must say so. Silence here is the shipped defect. */
const assertStatedNonExecution = (outcome, label) => {
  assertGuardableOutcome(outcome, label);
  assert.equal(
    outcome.executed,
    false,
    `${label}: a step that replayed a cached result must report executed: false`,
  );
};

const assertNotHardErrored = (outcome, label) => {
  assert.equal(outcome.passed, true, `${label}: a cache hit must still pass`);
  assert.ok(!outcome.errored, `${label}: a cache hit must not be an error (${outcome.reason})`);
  assert.doesNotMatch(
    String(outcome.reason || ''),
    /^declared_outputs_unwritten/,
    `${label}: a cache hit must not be failed by the declared-output guard`,
  );
};

const withDb = async (callback, { columns = [], row = {} } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'agent-outbound-step-conformance-'));
  const db = openListDb({ listDir: root, readonly: false });
  ensureRecordColumns({ db, columns: ['website', ...columns] });
  upsertRecord({
    db,
    row: { _row_id: RECORD_ID, business_name: 'Conformance Inc.', website: 'https://one.example', ...row },
  });
  try {
    return await callback({ db, root, current: () => db.prepare('SELECT * FROM records WHERE _row_id = ?').get(RECORD_ID) });
  } finally {
    db.close();
  }
};

const context = ({ db, root, composeGenerateObject }) => ({
  db,
  listDir: root,
  config: { ai: {} },
  aiConfig: {},
  mcp: null,
  toolCatalog: null,
  ...(composeGenerateObject ? { composeGenerateObject } : {}),
});

test('every pipeline step kind is classified as cached-pass or no-cached-pass', () => {
  // Programmatic enumeration: a new runner needs a new kind in the schema, and
  // an unclassified kind fails here rather than silently skipping conformance.
  const declared = PipelineStepSchema.options.map((option) => option.shape.kind.value);
  const classified = new Set([...CACHED_PASS_KINDS, ...Object.keys(NO_CACHED_PASS_KINDS)]);

  const unclassified = declared.filter((kind) => !classified.has(kind));
  assert.deepEqual(
    unclassified,
    [],
    'a new step kind must be classified in this file: either it has a path that passes without '
    + 'executing (add it to CACHED_PASS_KINDS and give it a behavioural case below) or it does not '
    + '(add it to NO_CACHED_PASS_KINDS with the reason).',
  );

  const stale = [...classified].filter((kind) => !declared.includes(kind));
  assert.deepEqual(stale, [], 'classified kinds that the schema no longer declares');

  for (const kind of Object.keys(NO_CACHED_PASS_KINDS)) {
    assert.ok(String(NO_CACHED_PASS_KINDS[kind] || '').trim(), `${kind} needs a stated reason`);
  }
});

test('every cached-pass kind has a behavioural case in this file', () => {
  // Guards the guard: a kind may not be listed as cached-pass and then left
  // unexercised. Read from this file's own source so the coverage claim cannot
  // drift from the tests that actually exist.
  const source = readFileSync(new URL(import.meta.url), 'utf8');
  const uncovered = [...CACHED_PASS_KINDS].filter((kind) => !source.includes(`test('${kind}: `));
  assert.deepEqual(
    uncovered,
    [],
    "each cached-pass kind needs a test named `<kind>: ...` driving its cache-hit path",
  );
});

test('enrich: a cache hit states non-execution and never trips the declared-output guard', async () => {
  // The production case, end to end. The step declares an optional output the
  // business legitimately has no value for (no Google reviews). First pass runs
  // the provider; the second goes through executeStepBatch — including the
  // declared-output guard — and touches no provider at all because it is a
  // cache hit. Before non-execution was a value, that second pass hard-errored.
  const step = {
    kind: 'enrich',
    id: 'conformance_enrich',
    inputs: { subject: { from: 'website' } },
    outputs: {
      resolution: { type: 'string', description: 'Settled resolution.' },
      rating_count: { type: 'integer', description: 'Review count when the business has reviews.' },
    },
  };
  await withDb(async ({ db, root, current }) => {
    const first = await executeEnrichmentStepOnRecords({
      db,
      listDir: root,
      config: { ai: {} },
      mcp: null,
      toolCatalog: null,
      step,
      rows: [current()],
      executeAction: async () => ({ outputs: { resolution: 'resolved' }, usage: {} }),
      force: false,
    });
    assert.equal(first.processed, 1);

    const outcome = (await executeStepBatch(context({ db, root }), step, step.id, [current()])).get(RECORD_ID);
    assertStatedNonExecution(outcome, 'enrich cache hit');
    assertNotHardErrored(outcome, 'enrich cache hit');
    assert.equal(shouldGuardDeclaredOutputWrites(outcome), false, 'a claimless non-execution is exempt');
  }, { columns: ['resolution', 'rating_count'] });
});

test('decide: a cache hit states non-execution and never repeats the Jev request', async (t) => {
  let calls = 0;
  const server = createServer((_request, response) => {
    calls += 1;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ answers: { kind: { type: 'choice', choice: 'yes', confidence: 0.9, probabilities: { yes: 0.9, no: 0.1 } } }, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('local TCP listeners are unavailable in this sandbox');
      return;
    }
    throw error;
  }
  const address = server.address();
  const previousKey = process.env.JEV_API_KEY;
  const previousUrl = process.env.JEV_BASE_URL;
  process.env.JEV_API_KEY = 'test';
  process.env.JEV_BASE_URL = `http://127.0.0.1:${address.port}`;
  try {
    await withDb(async ({ db, root, current }) => {
      const step = { kind: 'decide', id: 'conformance_decide', state: ['website'], questions: { kind: { type: 'choice', instructions: 'classify', options: { yes: 'yes', no: 'no' } } } };
      const config = { ai: { decide: { model: 'jev-1.13.0', api_key_env: 'JEV_API_KEY' } } };
      await executeDecideStepOnRecords({ db, listDir: root, config, step, stepId: step.id, rows: [current()] });
      const cached = await executeStepBatch({ ...context({ db, root }), config }, step, step.id, [current()]);
      assertStatedNonExecution(cached.get(RECORD_ID), 'decide cache hit');
      assert.equal(calls, 1);
    });
  } finally {
    if (previousKey === undefined) delete process.env.JEV_API_KEY; else process.env.JEV_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.JEV_BASE_URL; else process.env.JEV_BASE_URL = previousUrl;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('generate: a cache hit states non-execution and its claims stay checkable', async () => {
  const step = {
    kind: 'generate',
    id: 'conformance_generate',
    inputs: { subject: { from: 'website' } },
    outputs: { generated_result: { type: 'string', description: 'Generated result.' } },
    memoize: {},
    __executeAction: async ({ record }) => ({ outputs: { generated_result: `generated:${record.website}` }, usage: {} }),
  };
  await withDb(async ({ db, root, current }) => {
    await runGenerateStep({
      db,
      listDir: root,
      config: { ai: {} },
      step,
      rows: [current()],
      stepId: step.id,
      executeAction: step.__executeAction,
    });

    const outcome = (await executeStepBatch(context({ db, root }), step, step.id, [current()])).get(RECORD_ID);
    assertStatedNonExecution(outcome, 'generate cache hit');
    assertNotHardErrored(outcome, 'generate cache hit');
    // A cached generate replays real values, so it claims them — and a claim is
    // checked whether or not the step ran.
    assert.equal(shouldGuardDeclaredOutputWrites(outcome), true, 'a claimed value stays guarded');
  }, { columns: ['generated_result'] });
});

test('compose: a cache hit states non-execution and its claims stay checkable', async () => {
  const step = {
    kind: 'compose',
    id: 'conformance_compose',
    model: 'openrouter/anthropic/claude-haiku-4.5',
    inputs: { subject: { from: 'website' } },
    structure: { headline: 'A brief headline.' },
    length: { max_words: 10 },
    outputs: { headline: { type: 'string', description: 'Headline.' } },
    memoize: {},
  };
  await withDb(async ({ db, root, current }) => {
    const composeGenerateObject = async () => ({ object: { outputs: { headline: 'A brief note' } }, usage: {} });
    await runComposeStep({
      db,
      listDir: root,
      config: { ai: {} },
      step,
      rows: [current()],
      stepId: step.id,
      generateObject: composeGenerateObject,
    });

    const outcome = (await executeStepBatch(
      context({ db, root, composeGenerateObject: async () => { throw new Error('a cache hit must not call the model'); } }),
      step,
      step.id,
      [current()],
    )).get(RECORD_ID);
    assertStatedNonExecution(outcome, 'compose cache hit');
    assertNotHardErrored(outcome, 'compose cache hit');
    assert.equal(shouldGuardDeclaredOutputWrites(outcome), true, 'a claimed value stays guarded');
  }, { columns: ['headline'] });
});

test('score: a cache hit states non-execution instead of relying on its cache predicate', async () => {
  // score's memoization branch attaches no write claims. Today that is harmless
  // only because its cache predicate happens to require every declared output
  // to exist first — an accident of a neighbouring check, not a statement. The
  // statement is `executed: false`; without it, the day that predicate loosens
  // is the day score reproduces the enrich defect.
  const step = {
    kind: 'score',
    id: 'conformance_score',
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
  await withDb(async ({ db, root, current }) => {
    await runScoreStage({
      db,
      listDir: root,
      config: { ai: {}, score: { samples: 1 } },
      step,
      rows: [current()],
      stepId: step.id,
      generateObject: async () => ({
        object: {
          criteria: [{ id: 'fit', grade: 6, assessable: true, reasoning: 'Declared evidence supports fit.' }],
          summary_reasoning: 'Settled score.',
        },
        usage: {},
      }),
    });

    const outcome = (await executeStepBatch(context({ db, root }), step, step.id, [current()])).get(RECORD_ID);
    assertStatedNonExecution(outcome, 'score cache hit');
    assertNotHardErrored(outcome, 'score cache hit');
    assert.equal(shouldGuardDeclaredOutputWrites(outcome), false, 'a claimless non-execution is exempt');
  });
});

test('extract: a cache hit states non-execution and its claims stay checkable', async () => {
  const step = {
    kind: 'extract',
    id: 'conformance_extract',
    from: 'site_text',
    inputs: ['site_text', 'domain', 'website'],
    using: 'email',
    select: 'first',
    outputs: { discovered_email: { type: 'string', description: 'Email.' } },
  };
  await withDb(async ({ db, root, current }) => {
    const first = (await executeStepBatch(context({ db, root }), step, step.id, [current()])).get(RECORD_ID);
    assertGuardableOutcome(first, 'extract first pass');
    assert.equal(first.passed, true);

    const outcome = (await executeStepBatch(context({ db, root }), step, step.id, [current()])).get(RECORD_ID);
    assertStatedNonExecution(outcome, 'extract cache hit');
    assertNotHardErrored(outcome, 'extract cache hit');
    assert.equal(shouldGuardDeclaredOutputWrites(outcome), true, 'a claimed value stays guarded');
  }, { columns: ['site_text', 'domain', 'discovered_email'], row: { site_text: 'reach us at contact@one.example' } });
});

test('a step that did no work and claims nothing is exempt; a claim is always checked', () => {
  // The contract in two lines, independent of any runner: the exemption comes
  // from the stated boolean, never from how the reason happens to be spelled.
  assert.equal(shouldGuardDeclaredOutputWrites({ passed: true, executed: false, reason: 'any_new_spelling' }), false);
  assert.equal(shouldGuardDeclaredOutputWrites({ passed: true, reason: 'skipped:anything' }), true);
  assert.equal(
    shouldGuardDeclaredOutputWrites({
      passed: true,
      executed: false,
      reason: 'any_new_spelling',
      declaredOutputWrites: { website: { provided: true, value: 'https://one.example' } },
    }),
    true,
  );
  // Absent means executed — the fail-closed default, so a runner that says
  // nothing keeps the guard armed rather than silently disarming it.
  assert.equal(didExecuteStep({}), true);
  assert.equal(didExecuteStep({ executed: false }), false);
});


test('await_event: consumption replay carries declared write claims', async () => {
  const { ingestExternalEvents } = await import('../dist/orchestrator/runtime/external-events.js');
  await withDb(async ({ db, root, current }) => {
    const step = {kind: 'await_event', id: 'external', source: 'fixture', event: 'ready', reference_field: 'ref', inputs: ['ref'], output_map: {value: 'text'}, outputs: {value: {type: 'string', description: 'Result'}}};
    const config = {pipeline: [step]};
    ingestExternalEvents({db, listDir: root, config, events: [{source: 'fixture', id: 'one', type: 'ready', reference: 'opaque', occurred_at: '2026-01-01T00:00:00.000Z', data: {text: 'result'}}]});
    await executeStepBatch({...context({db, root}), config}, step, step.id, [current()]);
    const replay = (await executeStepBatch({...context({db, root}), config}, step, step.id, [current()])).get(RECORD_ID);
    assertGuardableOutcome(replay, 'await_event replay');
    assertNotHardErrored(replay, 'await_event replay');
  }, {columns: ['ref'], row: {ref: 'opaque'}});
});
