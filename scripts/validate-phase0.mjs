import assert from 'node:assert/strict';
import {
  inferPipelineEdges,
  validatePipelineGraph,
} from '../src/orchestrator/lib/pipeline-graph.ts';

const producerStep = {
  kind: 'enrich',
  id: 'profile',
  outputs: {
    business_profile: {
      type: 'string',
      description: 'Business profile',
    },
  },
};

const consumerStep = {
  kind: 'filter',
  id: 'profile_gate',
  type: 'field_check',
  conditions: [
    { field: 'business_profile', operator: 'is_not_empty' },
  ],
};

const edgeConfig = {
  pipeline: [producerStep, consumerStep],
};

const inferred = inferPipelineEdges(edgeConfig);
assert.deepEqual(Array.from(inferred.get('profile_gate') || []), ['profile']);

const statusEdgeConfig = {
  pipeline: [
    {
      kind: 'enrich',
      id: 'site_profile',
      outputs: {
        services: {
          type: 'string',
          description: 'Services',
        },
      },
    },
    {
      kind: 'filter',
      id: 'scrape_quality_gate',
      type: 'field_check',
      conditions: [
        { field: 'site_profile__status', operator: 'eq', value: 'ok' },
      ],
    },
  ],
};
const statusInferred = inferPipelineEdges(statusEdgeConfig);
assert.deepEqual(Array.from(statusInferred.get('scrape_quality_gate') || []), ['site_profile']);

const cycle = validatePipelineGraph({
  pipeline: [
    { kind: 'filter', id: 'a', depends_on: ['b'] },
    { kind: 'filter', id: 'b', depends_on: ['a'] },
  ],
});
assert.ok(cycle.errors.some((error) => error.includes('cycle')));

const missingEdge = validatePipelineGraph(edgeConfig);
assert.ok(missingEdge.errors.some((error) => error.includes('missing depends_on')));

const correct = validatePipelineGraph({
  pipeline: [
    producerStep,
    { ...consumerStep, depends_on: ['profile'] },
  ],
});
assert.deepEqual(correct.errors, []);

console.log('phase0 validation ok');
console.log(JSON.stringify({
  inferred_profile_gate: Array.from(inferred.get('profile_gate') || []),
  inferred_scrape_quality_gate: Array.from(statusInferred.get('scrape_quality_gate') || []),
  cycle_errors: cycle.errors,
  missing_edge_errors: missingEdge.errors,
  correct_errors: correct.errors,
}, null, 2));
