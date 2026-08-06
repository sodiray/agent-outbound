import assert from 'node:assert/strict';
import test from 'node:test';

import { validateTaxonomyLabels } from '../dist/orchestrator/policy/taxonomy.js';

const listDir = '/Users/rayepps/projects/mission/.outbound/treasure-valley';

/**
 * Regression for a live-validation defect. A model classified an HVAC
 * contractor as sub_vertical "HVAC"; the registry leaf is `hvac`. Exact,
 * case-sensitive matching rejected it, applied the fallback vertical
 * `other_local_smb`, and that vertical has no diagnostic family — so the
 * account was capped at Tier D and produced no outreach at all, while every
 * step reported success.
 */
test('taxonomy: formatting differences in an id do not send an account to the fallback', () => {
  for (const sub of ['HVAC', 'Hvac', 'hvac', 'H.V.A.C.', ' hvac ']) {
    const result = validateTaxonomyLabels({
      vertical: 'trades_field_services',
      sub_vertical: sub,
      listDir,
    });
    assert.equal(result.vertical, 'trades_field_services', `vertical for ${JSON.stringify(sub)}`);
    assert.equal(result.sub_vertical, 'hvac', `sub_vertical for ${JSON.stringify(sub)}`);
    assert.equal(result.fallback_applied, false, `fallback for ${JSON.stringify(sub)}`);
  }
});

test('taxonomy: a vertical label differing only in spacing and case still resolves', () => {
  const result = validateTaxonomyLabels({
    vertical: 'Trades Field Services',
    sub_vertical: 'Hvac',
    listDir,
  });
  assert.equal(result.vertical, 'trades_field_services');
  assert.equal(result.sub_vertical, 'hvac');
  assert.equal(result.fallback_applied, false);
});

/**
 * The other half of the same fix, and the more important half: normalization
 * is allowed to forgive FORM, never to guess MEANING. "Construction" is not a
 * spelling of trades_field_services — it names a different family with
 * different diagnostics. Mapping it would attach the wrong hypotheses and
 * economics to a real business, which is worse than falling back.
 */
test('taxonomy: a semantically wrong vertical still fails closed rather than being guessed', () => {
  const result = validateTaxonomyLabels({
    vertical: 'Construction',
    sub_vertical: 'HVAC',
    listDir,
  });
  assert.equal(result.fallback_applied, true);
  assert.equal(result.vertical, 'other_local_smb');
  assert.ok(
    result.reasons.some((r) => r.startsWith('unsupported_vertical:')),
    'the unsupported vertical must be reported, not silently mapped',
  );
});

test('taxonomy: an empty classification still falls back and says so', () => {
  const result = validateTaxonomyLabels({ vertical: '', sub_vertical: '', listDir });
  assert.equal(result.fallback_applied, true);
  assert.ok(result.reasons.includes('vertical_empty_fallback'));
});
