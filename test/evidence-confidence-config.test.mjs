import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../dist/schemas/config.js';
import {
  deriveBuyerConfidence,
  deriveMailConfidence,
  derivePhoneConfidence,
} from '../dist/orchestrator/policy/evidence.js';
import { applyOutboundPolicy } from '../dist/orchestrator/policy/apply-record.js';

const durableObservation = (predicate, value) => ({
  evidence_id: `evidence_${predicate}`,
  predicate,
  value,
  support_status: 'literal_support',
  source_id: `provider_${predicate}`,
  observed_at: '2026-08-07T00:00:00.000Z',
  provisional: false,
});

const fullyEvidencedBuyer = () => ({
  observed_buyer_name: 'Taylor Morgan',
  named_buyer_status: 'confirmed',
  buying_center_role: 'principal',
  buyer_affiliation_status: 'confirmed',
  local_buying_authority: 'yes',
  observations_json: JSON.stringify({
    observations: [
      durableObservation('observed_buyer_name', 'Taylor Morgan'),
      durableObservation('buying_center_role', 'principal'),
      durableObservation('buyer_affiliation_status', 'confirmed'),
    ],
  }),
});

const fullyEvidencedMail = () => ({
  address: '100 Main Street',
  city: 'Example City',
  state: 'EX',
  postal_code: '12345',
  address_rdi: 'commercial',
  address_normalized: true,
  address_validation_status: 'deliverable',
});

test('phone, buyer, and mail confidence defaults preserve current values', () => {
  const defaults = normalizeConfig({ score: {} }).config.score;
  assert.deepEqual(defaults.phone_confidence, {
    weights: { present: 15, well_formed: 35, structured_source: 35 },
    penalties: { unstructured_maximum: 50 },
  });
  assert.deepEqual(defaults.buyer_confidence, {
    weights: {
      named: 25,
      named_literal_support: 25,
      decision_authority: 20,
      role_literal_support: 10,
      affiliation: 10,
      affiliation_literal_support: 10,
    },
    penalties: { open_contradiction: 30, maximum_total: 60 },
  });
  assert.deepEqual(defaults.mail_confidence, {
    weights: {
      address_present: 15,
      address_complete: 25,
      commercial_delivery_indicator: 30,
      validation_evidence: 30,
    },
    penalties: { open_contradiction: 0, maximum_total: 0 },
  });

  assert.equal(derivePhoneConfidence({ phone: 'malformed' }), 15);
  assert.equal(derivePhoneConfidence({ phone: '+12085551212' }), 50);
  assert.equal(derivePhoneConfidence({ phone: '+12085551212', phone_source_kind: 'structured' }), 85);
  assert.equal(deriveBuyerConfidence(fullyEvidencedBuyer()), 100);
  assert.equal(deriveMailConfidence(fullyEvidencedMail()), 100);
});

test('configured phone, buyer, and mail confidence overrides are honored', () => {
  const score = normalizeConfig({
    score: {
      phone_confidence: {
        weights: { present: 20, well_formed: 30, structured_source: 40 },
        penalties: { unstructured_maximum: 45 },
      },
      buyer_confidence: {
        weights: {
          named: 30,
          named_literal_support: 20,
          decision_authority: 20,
          role_literal_support: 10,
          affiliation: 10,
          affiliation_literal_support: 10,
        },
      },
      mail_confidence: {
        weights: {
          address_present: 20,
          address_complete: 20,
          commercial_delivery_indicator: 30,
          validation_evidence: 30,
        },
      },
    },
  }).config.score;

  assert.equal(
    derivePhoneConfidence({ phone: '+12085551212', phone_source_kind: 'structured' }, score.phone_confidence),
    90,
  );
  assert.equal(derivePhoneConfidence({ phone: '+12085551212' }, score.phone_confidence), 45);
  assert.equal(
    deriveBuyerConfidence({ observed_buyer_name: 'Taylor Morgan', named_buyer_status: 'confirmed' }, score.buyer_confidence),
    30,
  );
  assert.equal(deriveMailConfidence({ address: '100 Main Street' }, score.mail_confidence), 20);

  assert.equal(applyOutboundPolicy({
    record: { _row_id: 'phone_override', phone: '+12085551212', phone_source_kind: 'structured' },
    phoneConfidence: score.phone_confidence,
  }).patch.phone_confidence, 90);
  assert.equal(applyOutboundPolicy({
    record: { _row_id: 'buyer_override', observed_buyer_name: 'Taylor Morgan', named_buyer_status: 'confirmed' },
    buyerConfidence: score.buyer_confidence,
  }).patch.buyer_confidence, 30);
  assert.equal(applyOutboundPolicy({
    record: { _row_id: 'mail_override', address: '100 Main Street' },
    mailConfidence: score.mail_confidence,
  }).patch.mail_confidence, 20);
});

test('confidence config rejects malformed phone, buyer, and mail policies', () => {
  const malformedConfigs = [
    { score: { phone_confidence: { weights: { present: -1 } } } },
    {
      score: {
        phone_confidence: {
          weights: { present: 20, well_formed: 40, structured_source: 50 },
        },
      },
    },
    { score: { buyer_confidence: { penalties: { open_contradiction: -30 } } } },
    {
      score: {
        buyer_confidence: {
          weights: {
            named: 30,
            named_literal_support: 30,
            decision_authority: 20,
            role_literal_support: 10,
            affiliation: 10,
            affiliation_literal_support: 10,
          },
        },
      },
    },
    { score: { mail_confidence: { penalties: { maximum_total: -1 } } } },
    {
      score: {
        mail_confidence: {
          weights: {
            address_present: 20,
            address_complete: 30,
            commercial_delivery_indicator: 30,
            validation_evidence: 30,
          },
        },
      },
    },
  ];

  for (const config of malformedConfigs) {
    assert.ok(normalizeConfig(config).errors.length > 0);
  }
});

test('phone, buyer, and mail confidence remain fail-closed without evidence', () => {
  assert.equal(derivePhoneConfidence({}), 0);
  assert.equal(deriveBuyerConfidence({}), 0);
  assert.equal(deriveMailConfidence({}), 0);
});
