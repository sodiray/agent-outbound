import assert from 'node:assert/strict';
import { runDataflowCore } from '../src/orchestrator/pipeline/dataflow.ts';

const record = (id) => ({ _row_id: id, business_name: id });

const step = ({
  id,
  kind = 'filter',
  tier = 0,
  cost = 0,
  dropGate = false,
  deps = [],
}) => ({
  id,
  index: 0,
  step: { id, kind },
  kind,
  tier,
  cost,
  dropGate,
  deps,
  executable: true,
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runScenario = async ({
  records,
  steps,
  concurrency = 10,
  outcomes = {},
  delays = {},
}) => {
  const events = [];
  const started = {};
  const result = await runDataflowCore({
    records,
    steps: steps.map((entry, index) => ({ ...entry, index })),
    concurrency,
    loadStep: async (selected, row) => {
      const key = `${row._row_id}:${selected.id}`;
      events.push(`start:${key}`);
      started[key] = Date.now();
      await delay(Number(delays[key] || delays[selected.id] || 0));
      const configured = outcomes[key] || outcomes[selected.id] || { passed: true, reason: '' };
      events.push(`finish:${key}`);
      return configured;
    },
    onStepOutcome: async (_recordState, selected, outcome) => {
      events.push(`persist:${selected.id}`);
      return {
        dropped: selected.dropGate && !outcome.passed,
      };
    },
  });
  return { events, result, started };
};

const indexOf = (events, value) => {
  const index = events.indexOf(value);
  assert.notEqual(index, -1, `${value} missing from ${JSON.stringify(events)}`);
  return index;
};

const readiness = await runScenario({
  records: [record('ready')],
  steps: [
    step({ id: 'dep_source', dropGate: false }),
    step({ id: 'independent', tier: 1 }),
    step({ id: 'dependent', tier: 1, deps: ['dep_source'] }),
  ],
});
assert.ok(indexOf(readiness.events, 'persist:dep_source') < indexOf(readiness.events, 'start:ready:dependent'));
assert.ok(indexOf(readiness.events, 'start:ready:independent') < indexOf(readiness.events, 'start:ready:dependent'));

const funnel = await runScenario({
  records: [record('funnel')],
  steps: [
    step({ id: 'expensive_enrich', kind: 'enrich', tier: 2, cost: 10 }),
    step({ id: 'cheap_gate', tier: 0, cost: 0, dropGate: true }),
  ],
  delays: { cheap_gate: 10 },
});
assert.ok(indexOf(funnel.events, 'persist:cheap_gate') < indexOf(funnel.events, 'start:funnel:expensive_enrich'));

const pendingDropGate = await runScenario({
  records: [record('pending_drop'), record('pending_drop')],
  steps: [
    step({ id: 'slow_drop_gate', tier: 0, cost: 0, dropGate: true }),
    step({ id: 'expensive_enrich', kind: 'enrich', tier: 2, cost: 10 }),
  ],
  concurrency: 2,
  delays: { slow_drop_gate: 20 },
  outcomes: {
    slow_drop_gate: { passed: false, reason: 'drop' },
  },
});
assert.equal(pendingDropGate.events.filter((event) => event === 'start:pending_drop:slow_drop_gate').length, 1);
assert.equal(pendingDropGate.events.includes('start:pending_drop:expensive_enrich'), false);

const postCheapSurvivors = await runScenario({
  records: [record('survive_a'), record('survive_b'), record('drop_c')],
  steps: [
    step({ id: 'cheap_field_gate', tier: 0, cost: 0, dropGate: true }),
    step({ id: 'semantic_gate', tier: 1, cost: 1, dropGate: true }),
    step({ id: 'profile_enrich', kind: 'enrich', tier: 2, cost: 10 }),
    step({ id: 'post_enrich_field_gate', tier: 0, cost: 0, dropGate: true, deps: ['profile_enrich'] }),
  ],
  concurrency: 3,
  outcomes: {
    'drop_c:cheap_field_gate': { passed: false, reason: 'drop' },
  },
});
['survive_a', 'survive_b'].forEach((id) => {
  ['cheap_field_gate', 'semantic_gate', 'profile_enrich', 'post_enrich_field_gate'].forEach((stepId) => {
    assert.ok(postCheapSurvivors.events.includes(`start:${id}:${stepId}`), `${id} did not execute ${stepId}`);
  });
  assert.ok(indexOf(postCheapSurvivors.events, `persist:cheap_field_gate`) < indexOf(postCheapSurvivors.events, `start:${id}:semantic_gate`));
  assert.ok(indexOf(postCheapSurvivors.events, `persist:semantic_gate`) < indexOf(postCheapSurvivors.events, `start:${id}:profile_enrich`));
  assert.ok(indexOf(postCheapSurvivors.events, `persist:profile_enrich`) < indexOf(postCheapSurvivors.events, `start:${id}:post_enrich_field_gate`));
});
assert.equal(postCheapSurvivors.events.includes('start:drop_c:semantic_gate'), false);
assert.equal(postCheapSurvivors.events.includes('start:drop_c:profile_enrich'), false);

const early = await runScenario({
  records: [record('slow'), record('fast')],
  steps: [step({ id: 'only_step' })],
  concurrency: 2,
  delays: {
    'slow:only_step': 80,
    'fast:only_step': 1,
  },
});
assert.deepEqual(early.result.completed_order.slice(0, 1), ['fast']);

const drop = await runScenario({
  records: [record('dropme')],
  steps: [
    step({ id: 'drop_gate', dropGate: true }),
    step({ id: 'downstream', tier: 1, deps: ['drop_gate'] }),
  ],
  outcomes: {
    drop_gate: { passed: false, reason: 'no' },
  },
});
assert.equal(drop.events.includes('start:dropme:downstream'), false);

const capped = await runScenario({
  records: [record('c1'), record('c2'), record('c3'), record('c4'), record('c5')],
  steps: [step({ id: 'cap_step' })],
  concurrency: 2,
  delays: { cap_step: 20 },
});
assert.ok(capped.result.max_active_advancers <= 2, `max active ${capped.result.max_active_advancers} exceeded cap`);

const summary = {
  readiness_events: readiness.events,
  funnel_events: funnel.events,
  pending_drop_gate_events: pendingDropGate.events,
  post_cheap_survivor_events: postCheapSurvivors.events,
  early_completion_order: early.result.completed_order,
  drop_events: drop.events,
  max_active_advancers: capped.result.max_active_advancers,
};

console.log(`phase2 validation ok ${JSON.stringify(summary)}`);
