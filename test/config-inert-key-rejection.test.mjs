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
// CONTROL overall — healthy config without inert keys
// ---------------------------------------------------------------------------

test('CONTROL: a config declaring none of the rejected keys validates with zero errors', () => {
  const result = normalizeConfig({
    policy: {
      prohibited_channels: ['sms'],
      enforce_readiness: true,
    },
    score: {
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
