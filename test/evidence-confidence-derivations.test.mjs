import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveBuyerConfidence,
  deriveMailAddressReady,
  deriveMailConfidence,
} from '../dist/orchestrator/policy/evidence.js';
import { applyOutboundPolicy } from '../dist/orchestrator/policy/apply-record.js';
import { evaluateReachability } from '../dist/orchestrator/policy/timing-reachability.js';

const durableObservation = (predicate, value) => ({
  evidence_id: `evidence_${predicate}`,
  predicate,
  value,
  support_status: 'literal_support',
  source_id: `provider_${predicate}`,
  observed_at: '2026-08-01T00:00:00.000Z',
  provisional: false,
});

const completeFitBreakdown = () => JSON.stringify([
  'operational_coordination_burden',
  'repetition_and_volume',
  'economic_impact_potential',
  'operating_scale_surface_area',
  'mission_delivery_compatibility',
  'local_buying_autonomy',
].map((id) => ({ id, grade: 10, evidence_ids: [`evidence_${id}`] })));

const fullyEvidencedRecord = () => ({
  _row_id: 'evidence_confidence_complete',
  business_name: 'Example Organization',
  address: '100 Main Street',
  city: 'Example City',
  state: 'EX',
  postal_code: '12345',
  website: 'https://example.test',
  place_id: 'provider-place-id',
  company_resolution: 'resolved',
  is_a_business: true,
  classification_confidence: 90,
  score_breakdown: completeFitBreakdown(),
  timing_score: 90,
  named_buyer_status: 'confirmed',
  observed_buyer_name: 'Taylor Morgan',
  buying_center_role: 'principal',
  buyer_affiliation_status: 'confirmed',
  local_buying_authority: 'yes',
  mailing_address: '100 Main Street',
  address_rdi: 'commercial',
  address_normalized: true,
  address_validation_status: 'deliverable',
  golden_ticket_asset_ready: true,
  golden_ticket_cohort_ok: true,
  observations_json: JSON.stringify({
    observations: [
      durableObservation('website', 'https://example.test'),
      durableObservation('observed_buyer_name', 'Taylor Morgan'),
      durableObservation('buying_center_role', 'principal'),
      durableObservation('buyer_affiliation_status', 'confirmed'),
    ],
  }),
});

test('buyer confidence requires a resolved named decision-maker with provider support', () => {
  const evidenced = fullyEvidencedRecord();
  assert.equal(deriveBuyerConfidence(evidenced), 100);
  assert.equal(deriveBuyerConfidence({ named_buyer_status: 'confirmed' }), 0);
});

test('mail confidence combines commercial delivery, complete normalization, and validation evidence', () => {
  const evidenced = fullyEvidencedRecord();
  assert.equal(deriveMailConfidence(evidenced), 100);
  assert.equal(deriveMailConfidence({}), 0);
  assert.ok(deriveMailConfidence({
    address: '100 Main Street',
    address_rdi: 'residential',
  }) < 90);
  assert.ok(deriveMailConfidence({
    address: '100 Main Street',
    address_rdi: 'commercial',
  }) < 90);
});

test('commercial RDI mail readiness remains independent from mail confidence', () => {
  const record = { address: '100 Main Street', address_rdi: 'commercial' };
  const mail = evaluateReachability(record).channels.find((channel) => channel.channel === 'mail');
  assert.equal(deriveMailAddressReady(record), true);
  assert.equal(mail.ready, true);
  assert.equal(mail.confidence, 0);
});

test('policy persists evidence-derived confidence and awards Golden Ticket only to complete evidence', () => {
  const complete = applyOutboundPolicy({
    record: fullyEvidencedRecord(),
    recomputeFitFromBreakdown: true,
  });
  assert.equal(complete.patch.buyer_confidence, 100);
  assert.equal(complete.patch.mail_confidence, 100);
  assert.equal(complete.patch.mail_address_ready, 1);
  assert.equal(complete.patch.golden_ticket_eligible, 1);
  assert.ok(!complete.enrichment_repair_plan?.steps.some((step) => step.field === 'buyer_confidence'));

  const thin = applyOutboundPolicy({
    record: {
      ...fullyEvidencedRecord(),
      _row_id: 'evidence_confidence_thin',
      named_buyer_status: '',
      observed_buyer_name: '',
      buyer_affiliation_status: '',
      buying_center_role: '',
      local_buying_authority: '',
      address_rdi: 'residential',
      address_validation_status: '',
      observations_json: JSON.stringify({ observations: [] }),
    },
    recomputeFitFromBreakdown: true,
  });
  assert.equal(thin.patch.golden_ticket_eligible, 0);
  assert.ok(Number(thin.patch.buyer_confidence) < 80);
  assert.ok(Number(thin.patch.mail_confidence) < 90);
});
