import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadVerticalTaxonomy,
  validateTaxonomyLabels,
} from '../dist/orchestrator/policy/taxonomy.js';
import { applyOutboundPolicy } from '../dist/orchestrator/policy/apply-record.js';

const taxonomy = {
  taxonomy_version: 'example-taxonomy-v1',
  fallback_vertical: 'other_services',
  fallback_sub_vertical: 'other_services',
  verticals: {
    services: {
      label: 'Services',
      sub_verticals: ['maintenance', 'other_services'],
    },
    other_services: {
      sub_verticals: ['other_services'],
    },
  },
};

/**
 * Regression for a live-validation defect. A model classified an HVAC
 * contractor as sub_vertical "HVAC"; the registry leaf is `hvac`. Exact,
 * case-sensitive matching rejected it, applied the fallback vertical
 * `other_local_smb`, and that vertical has no diagnostic family — so the
 * account was capped at Tier D and produced no outreach at all, while every
 * step reported success.
 */
test('taxonomy: formatting differences in an id do not send an account to the fallback', () => {
  for (const sub of ['Maintenance', 'MAINTENANCE', 'maintenance', 'M.A.I.N.T.E.N.A.N.C.E.', ' maintenance ']) {
    const result = validateTaxonomyLabels({
      vertical: 'services',
      sub_vertical: sub,
      taxonomy,
    });
    assert.equal(result.vertical, 'services', `vertical for ${JSON.stringify(sub)}`);
    assert.equal(result.sub_vertical, 'maintenance', `sub_vertical for ${JSON.stringify(sub)}`);
    assert.equal(result.fallback_applied, false, `fallback for ${JSON.stringify(sub)}`);
  }
});

test('taxonomy: a vertical label differing only in spacing and case still resolves', () => {
  const result = validateTaxonomyLabels({
    vertical: 'SERVICES',
    sub_vertical: 'Maintenance',
    taxonomy,
  });
  assert.equal(result.vertical, 'services');
  assert.equal(result.sub_vertical, 'maintenance');
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
    vertical: 'Different market',
    sub_vertical: 'Maintenance',
    taxonomy,
  });
  assert.equal(result.fallback_applied, true);
  assert.equal(result.vertical, 'other_services');
  assert.ok(
    result.reasons.some((r) => r.startsWith('unsupported_vertical:')),
    'the unsupported vertical must be reported, not silently mapped',
  );
});

test('taxonomy: an empty classification still falls back and says so', () => {
  const result = validateTaxonomyLabels({ vertical: '', sub_vertical: '', taxonomy });
  assert.equal(result.fallback_applied, true);
  assert.ok(result.reasons.includes('vertical_empty_fallback'));
});

test('taxonomy: a missing list-local registry never resolves another pipeline taxonomy', () => {
  const missingListDir = join(tmpdir(), `agent-outbound-no-taxonomy-${randomUUID()}`);
  assert.equal(loadVerticalTaxonomy(missingListDir), null);

  const result = validateTaxonomyLabels({
    vertical: 'services',
    sub_vertical: 'maintenance',
    listDir: missingListDir,
  });
  assert.deepEqual(result, {
    ok: false,
    vertical: 'services',
    sub_vertical: 'maintenance',
    taxonomy_version: 'unresolved',
    fallback_applied: false,
    reasons: ['taxonomy_not_loaded'],
  });
});

test('taxonomy: policy application holds records when taxonomy resolution fails', () => {
  const missingListDir = join(tmpdir(), `agent-outbound-no-taxonomy-${randomUUID()}`);
  const result = applyOutboundPolicy({
    listDir: missingListDir,
    record: {
      _row_id: 'taxonomy_unresolved',
      is_a_business: true,
      vertical: 'services',
      sub_vertical: 'maintenance',
      fit_score: 90,
      fit_evidence_confidence: 80,
      identity_confidence: 90,
      classification_confidence: 90,
    },
  });
  assert.equal(result.treatment_tier, 'enrichment_hold');
  assert.equal(result.mail_treatment, 'none');
  assert.ok(result.patch.treatment_reasons.includes('taxonomy_not_loaded'));
  assert.ok(result.patch.treatment_reasons.includes('taxonomy_resolution_forced_hold'));
});
