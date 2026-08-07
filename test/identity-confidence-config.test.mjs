import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../dist/schemas/config.js';
import {
  buildIdentityResolution,
  deriveIdentityConfidence,
} from '../dist/orchestrator/policy/evidence.js';
import { applyOutboundPolicy } from '../dist/orchestrator/policy/apply-record.js';
import { evaluateOutboundReadiness } from '../dist/orchestrator/policy/readiness.js';

const resolvedPlacesRecord = ({ website = false } = {}) => ({
  _row_id: 'identity_config_record',
  business_name: 'Mavericks Property Maintenance',
  address: '750 W Ustick Rd, Meridian, ID',
  place_id: 'ChIJidentity',
  company_resolution: 'resolved',
  ...(website
    ? {
      website: 'https://mavericks.example',
      observations_json: JSON.stringify({
        observations: [{
          evidence_id: 'website_literal',
          predicate: 'website',
          value: 'https://mavericks.example',
          support_status: 'literal_support',
          source_id: 'website_source',
          observed_at: '2026-08-07T00:00:00.000Z',
        }],
      }),
    }
    : {}),
});

const treasureValleyIdentityConfig = () => normalizeConfig({
  score: {
    identity_confidence: {
      weights: {
        business_name: 30,
        address: 30,
        place_id: 25,
        website: 15,
      },
    },
  },
}).config.score.identity_confidence;

test('identity-confidence defaults preserve the current literal-support values', () => {
  const defaults = normalizeConfig({ score: {} }).config.score.identity_confidence;
  assert.deepEqual(defaults, {
    weights: {
      business_name: 30,
      address: 30,
      website: 20,
      place_id: 20,
    },
    penalties: {
      unresolved_alternative: 10,
      open_contradiction: 25,
      maximum_total: 40,
    },
  });

  const complete = buildIdentityResolution(resolvedPlacesRecord({ website: true }));
  assert.equal(complete.identity_confidence, 100);
  const contradicted = {
    ...complete,
    resolutions: complete.resolutions.map((resolution) => (
      resolution.field === 'business_name'
        ? {
          ...resolution,
          contradictions: [{
            contradiction_id: 'name_conflict',
            field: 'business_name',
            values: ['Mavericks Property Maintenance', 'Mavericks Plumbing'],
            evidence_ids: ['website_literal'],
            status: 'open',
            noted_at: '2026-08-07T00:00:00.000Z',
          }],
        }
        : resolution
    )),
  };
  assert.equal(deriveIdentityConfidence(contradicted), 75);
});

test('configured identity weights make a Places-identified business reachable without a website', () => {
  const identityConfig = treasureValleyIdentityConfig();
  assert.deepEqual(identityConfig.weights, {
    business_name: 30,
    address: 30,
    website: 15,
    place_id: 25,
  });

  const withoutWebsite = buildIdentityResolution(resolvedPlacesRecord(), identityConfig);
  const withWebsite = buildIdentityResolution(resolvedPlacesRecord({ website: true }), identityConfig);
  assert.equal(withoutWebsite.identity_confidence, 85);
  assert.equal(withWebsite.identity_confidence, 100);
  assert.equal(applyOutboundPolicy({
    record: resolvedPlacesRecord(),
    identityConfidence: identityConfig,
  }).patch.identity_confidence, 85);

  const readiness = evaluateOutboundReadiness({
    eligible: true,
    suppressed: false,
    identityConfidence: withoutWebsite.identity_confidence,
    materialContradiction: false,
    treatmentTier: 'B',
    channels: {},
    hasNextAction: true,
  });
  assert.ok(!readiness.blockers.includes('identity_confidence_below_80'));
});

test('identity confidence remains fail-closed and config rejects malformed policies', () => {
  const identityConfig = treasureValleyIdentityConfig();
  assert.equal(buildIdentityResolution({
    _row_id: 'unresolved_identity',
    company_resolution: 'unresolved',
  }, identityConfig).identity_confidence, 0);

  const malformedConfigs = [
    {
      score: {
        identity_confidence: {
          weights: { business_name: 30, address: 30, website: 30, place_id: 20 },
        },
      },
    },
    {
      score: {
        identity_confidence: {
          weights: { business_name: -1, address: 30, website: 21, place_id: 50 },
        },
      },
    },
    {
      score: {
        identity_confidence: {
          penalties: { open_contradiction: -25 },
        },
      },
    },
  ];
  for (const config of malformedConfigs) {
    assert.ok(normalizeConfig(config).errors.length > 0);
  }
});
