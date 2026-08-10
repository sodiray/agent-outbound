/**
 * Declared-but-inert config keys must fail validation with a remedy.
 * "Accept and ignore" is the defect: a silent no-op looks like protection.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../dist/schemas/config.js';
import { withinEnrichmentCeiling } from '../dist/orchestrator/policy/cost-ledger.js';

const errorMentions = (errors, ...needles) => {
  const joined = errors.join('\n');
  return needles.every((needle) => joined.includes(needle));
};

// ---------------------------------------------------------------------------
// Group A — compliance / safety shaped
// ---------------------------------------------------------------------------

test('sequences.*.on_reply is rejected and names the hard-coded inbound path', () => {
  const result = normalizeConfig({
    sequences: { default: { on_reply: 'pause' } },
  });
  assert.ok(result.errors.length > 0, 'expected config error');
  assert.ok(
    errorMentions(result.errors, 'on_reply', 'inbound'),
    `message must name on_reply and inbound: ${JSON.stringify(result.errors)}`,
  );
});

test('sequences.*.on_bounce is rejected and points at structural bounce handling', () => {
  const result = normalizeConfig({
    sequences: { default: { on_bounce: 'stop' } },
  });
  assert.ok(result.errors.length > 0, 'expected config error');
  assert.ok(
    errorMentions(result.errors, 'on_bounce', 'bounce'),
    `message must name on_bounce and bounce path: ${JSON.stringify(result.errors)}`,
  );
  assert.ok(
    errorMentions(result.errors, 'policy.on_hard_bounce'),
    `message must point at policy.on_hard_bounce for optional suppression: ${JSON.stringify(result.errors)}`,
  );
});

test('sequences.*.on_opt_out is rejected and names the real compliance stop', () => {
  const result = normalizeConfig({
    sequences: { default: { on_opt_out: 'stop' } },
  });
  assert.ok(result.errors.length > 0, 'expected config error');
  assert.ok(
    errorMentions(result.errors, 'on_opt_out', 'suppress'),
    `message must name on_opt_out and suppress: ${JSON.stringify(result.errors)}`,
  );
});

test('suppression.global_list is rejected and points at suppress / the suppression table', () => {
  const result = normalizeConfig({
    suppression: { global_list: 'do-not-contact.txt' },
  });
  assert.ok(result.errors.length > 0, 'expected config error');
  assert.ok(
    errorMentions(result.errors, 'global_list', 'suppress'),
    `message must name global_list and suppress: ${JSON.stringify(result.errors)}`,
  );
});

test('sequences.*.start_when is rejected and says membership comes from assign / sequence_name', () => {
  const result = normalizeConfig({
    sequences: { default: { start_when: 'tier is A' } },
  });
  assert.ok(result.errors.length > 0, 'expected config error');
  assert.ok(
    errorMentions(result.errors, 'start_when', 'sequence_name'),
    `message must name start_when and sequence_name: ${JSON.stringify(result.errors)}`,
  );
});

// ---------------------------------------------------------------------------
// Group B — decoy enrichment ceilings vs real tiers.* control
// ---------------------------------------------------------------------------

for (const tier of ['A', 'B', 'C', 'D', 'enrichment_hold']) {
  test(`score.enrichment_budget.ceilings.${tier} (direct child) is rejected; remedy is ceilings.tiers.${tier}`, () => {
    const result = normalizeConfig({
      score: {
        enrichment_budget: {
          ceilings: { [tier]: 3 },
        },
      },
    });
    assert.ok(result.errors.length > 0, `expected error for ceilings.${tier}`);
    assert.ok(
      errorMentions(result.errors, `ceilings.${tier}`, `ceilings.tiers.${tier}`),
      `message must name decoy path and tiers remedy: ${JSON.stringify(result.errors)}`,
    );
  });
}

test('CONTROL: ceilings.tiers.A still validates and still enforces', () => {
  const result = normalizeConfig({
    score: {
      enrichment_budget: {
        ceilings: { tiers: { A: 3 } },
      },
    },
  });
  assert.deepEqual(result.errors, [], `correct form must validate: ${JSON.stringify(result.errors)}`);
  assert.equal(result.config.score.enrichment_budget.ceilings.tiers.A, 3);

  const under = withinEnrichmentCeiling({
    candidate_tier: 'A',
    enrichment_usd: 2.99,
    enrichmentBudget: result.config.score.enrichment_budget,
  });
  const over = withinEnrichmentCeiling({
    candidate_tier: 'A',
    enrichment_usd: 3.01,
    enrichmentBudget: result.config.score.enrichment_budget,
  });
  assert.equal(under.within_budget, true);
  assert.equal(under.ceiling, 3);
  assert.equal(over.within_budget, false);
  assert.equal(over.ceiling, 3);
});

// ---------------------------------------------------------------------------
// Group C — policy treatment twins (fit_rule_version is live; the others are not)
// ---------------------------------------------------------------------------

test('policy.deterministic_treatment is rejected; treatment is already rule-based', () => {
  const result = normalizeConfig({
    policy: { deterministic_treatment: true },
  });
  assert.ok(result.errors.length > 0, 'expected config error');
  assert.ok(
    errorMentions(result.errors, 'deterministic_treatment', 'rule-based'),
    `message must name deterministic_treatment and rule-based reality: ${JSON.stringify(result.errors)}`,
  );
});

test('policy.treatment_rule_version is rejected and names the live fit_rule_version twin', () => {
  const result = normalizeConfig({
    policy: { treatment_rule_version: 'treatment-v1' },
  });
  assert.ok(result.errors.length > 0, 'expected config error');
  assert.ok(
    errorMentions(result.errors, 'treatment_rule_version', 'fit_rule_version'),
    `message must name treatment_rule_version and the live fit_rule_version twin: ${JSON.stringify(result.errors)}`,
  );
});

test('CONTROL: policy.fit_rule_version still validates and is still consumed by fit-model resolution', async () => {
  const result = normalizeConfig({
    policy: { fit_rule_version: 'fit-v-control' },
    pipeline: [
      {
        kind: 'score',
        id: 'fit_stage',
        key: 'fit',
        model: 'openai/gpt-4o-mini',
        inputs: { account: { from: 'business_name', required: true } },
        criteria: [{ id: 'c1', weight: 1, description: 'control criterion' }],
        outputs: {
          fit_score: { type: 'number' },
          fit_breakdown: { type: 'json' },
          fit_reasoning: { type: 'string' },
        },
      },
    ],
  });
  assert.deepEqual(result.errors, [], `fit_rule_version must validate: ${JSON.stringify(result.errors)}`);
  assert.equal(result.config.policy.fit_rule_version, 'fit-v-control');

  const { resolvePipelineFitModel } = await import('../dist/orchestrator/scoring/fit-model.js');
  const resolved = resolvePipelineFitModel(result.config);
  assert.equal(resolved.declared, true);
  assert.equal(resolved.fitModel?.modelVersion, 'fit-v-control');
});

// ---------------------------------------------------------------------------
// Group D — list.territory visit knobs (routing uses channels.visit.tool + polygons)
// ---------------------------------------------------------------------------

const TERRITORY_INERT = [
  ['home_base', 'Boise, ID', ['home_base', 'channels.visit.tool']],
  ['max_visits_per_day', 8, ['max_visits_per_day', 'channels.visit.tool']],
  ['business_hours', { mon: '9-5' }, ['business_hours', 'channels.visit.tool']],
  ['preferred_visit_days', ['tue', 'wed'], ['preferred_visit_days', 'channels.visit.tool']],
  ['max_drive_radius_miles', 20, ['max_drive_radius_miles', 'channels.visit.tool']],
  ['exclude_zips', ['83702'], ['exclude_zips', 'channels.visit.tool']],
  ['visit_permit_required', true, ['visit_permit_required', 'channels.visit.tool']],
];

for (const [key, value, needles] of TERRITORY_INERT) {
  test(`list.territory.${key} is rejected and points at visit tool / polygons`, () => {
    const result = normalizeConfig({
      list: { territory: { [key]: value } },
    });
    assert.ok(result.errors.length > 0, `expected error for list.territory.${key}`);
    assert.ok(
      errorMentions(result.errors, ...needles),
      `message must name ${key} and visit routing reality: ${JSON.stringify(result.errors)}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Group E — retired global score surface (score.samples / score.minimum stay live)
// ---------------------------------------------------------------------------

for (const [key, value, needles] of [
  ['grading', 'graded', ['score.grading', '0–10']],
  ['model', 'openai/gpt-4o-mini', ['score.model', 'kind: score']],
  ['description', 'holistic fit', ['score.description', 'kind: score']],
  ['inputs', ['business_name'], ['score.inputs', 'kind: score']],
]) {
  test(`score.${key} is rejected; live scoring is pipeline kind: score stages`, () => {
    const result = normalizeConfig({
      score: { [key]: value },
    });
    assert.ok(result.errors.length > 0, `expected error for score.${key}`);
    assert.ok(
      errorMentions(result.errors, ...needles),
      `message must name score.${key} and pipeline score reality: ${JSON.stringify(result.errors)}`,
    );
  });
}

test('CONTROL: score.samples and score.minimum still validate', () => {
  const result = normalizeConfig({
    score: { samples: 3, minimum: 40 },
  });
  assert.deepEqual(result.errors, [], `samples/minimum must validate: ${JSON.stringify(result.errors)}`);
  assert.equal(result.config.score.samples, 3);
  assert.equal(result.config.score.minimum, 40);
});

// ---------------------------------------------------------------------------
// CONTROL overall — healthy config without inert keys
// ---------------------------------------------------------------------------

test('CONTROL: a config declaring none of the rejected keys validates with zero errors', () => {
  const result = normalizeConfig({
    policy: {
      prohibited_channels: ['sms'],
      enforce_readiness: true,
      fit_rule_version: 'healthy-fit-v1',
    },
    score: {
      samples: 1,
      minimum: 0,
      enrichment_budget: {
        ceilings: {
          foundational: 0.15,
          tiers: { A: 3, B: 1, C: 0.3, D: 0.15, enrichment_hold: 0.3 },
          mail_programs: { golden_ticket: 8 },
        },
      },
    },
    sequences: {
      default: {
        steps: [],
        working_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      },
    },
    suppression: {},
    list: { name: 'healthy', territory: {} },
    pipeline: [
      {
        kind: 'filter',
        id: 'keep_a',
        type: 'field_check',
        inputs: ['tier'],
        conditions: [{ field: 'tier', operator: 'eq', value: 'A' }],
      },
    ],
  });
  assert.deepEqual(result.errors, [], `healthy config must not error: ${JSON.stringify(result.errors)}`);
});
