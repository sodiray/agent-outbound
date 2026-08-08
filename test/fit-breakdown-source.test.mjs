/**
 * fit_breakdown vs score_breakdown selection — shipped applyOutboundPolicy path.
 * Guards against legacy ticket_size score_breakdown wiping commercial fit / treatment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treasureValleyTreatmentStrategy } from './fixtures/treatment-strategy.mjs';

const {
  applyOutboundPolicy,
  selectFitBreakdownSource,
  recoverLegacyFitScore,
} = await import('../dist/orchestrator/policy/index.js');

const commercialBreakdown = [
  { id: 'operational_coordination_burden', grade: 8, reasoning: 'multi-channel ops', evidence_ids: ['obs_ops'] },
  { id: 'repetition_and_volume', grade: 7, reasoning: 'repeat volume', evidence_ids: ['obs_vol'] },
  { id: 'economic_impact_potential', grade: 9, reasoning: 'high ticket', evidence_ids: ['obs_econ'] },
  { id: 'operating_scale_surface_area', grade: 6, reasoning: 'local scale', evidence_ids: ['obs_scale'] },
  { id: 'mission_delivery_compatibility', grade: 8, reasoning: 'agent fit', evidence_ids: ['obs_del'] },
  { id: 'local_buying_autonomy', grade: 8, reasoning: 'owner local', evidence_ids: ['obs_buy'] },
];

const legacyScoreBreakdown = [
  { id: 'ticket_size', grade: 8, weight: 0.3, reasoning: 'legacy' },
  { id: 'walk_in_decision_maker_access', grade: 9, weight: 0.3, reasoning: 'legacy walk-in' },
];

const legacyFitBreakdownPoints = [
  { id: 'vertical_admin_heavy', points: 25, sub_score: 1, weight: 0.25, verdict: 'yes' },
  { id: 'owner_reachable', points: 25, sub_score: 1, weight: 0.25, verdict: 'yes' },
  { id: 'brick_mortar', points: 30, sub_score: 1, weight: 0.3, verdict: 'yes' },
  { id: 'alive_and_right_sized', points: 20, sub_score: 1, weight: 0.2, verdict: 'yes' },
];

test('selectFitBreakdownSource prefers fit_breakdown commercial over score_breakdown legacy', () => {
  const sel = selectFitBreakdownSource({
    fit_breakdown: JSON.stringify(commercialBreakdown),
    score_breakdown: JSON.stringify(legacyScoreBreakdown),
  });
  assert.equal(sel.source, 'fit_breakdown');
  assert.equal(sel.hasCommercialComponents, true);
  assert.ok(sel.breakdown.some((b) => b.id === 'operational_coordination_burden'));
});

test('selectFitBreakdownSource uses score_breakdown when it has commercial ids', () => {
  const sel = selectFitBreakdownSource({
    fit_breakdown: JSON.stringify(legacyFitBreakdownPoints),
    score_breakdown: JSON.stringify(commercialBreakdown),
  });
  assert.equal(sel.source, 'score_breakdown');
  assert.equal(sel.hasCommercialComponents, true);
});

test('selectFitBreakdownSource returns none when only legacy ticket_size exists', () => {
  const sel = selectFitBreakdownSource({
    score_breakdown: JSON.stringify(legacyScoreBreakdown),
  });
  assert.equal(sel.source, 'none');
  assert.equal(sel.hasCommercialComponents, false);
});

test('recoverLegacyFitScore sums fit_breakdown points (Butter Classics shape)', () => {
  const recovered = recoverLegacyFitScore({
    fit_breakdown: JSON.stringify(legacyFitBreakdownPoints),
    score_breakdown: JSON.stringify(legacyScoreBreakdown),
  });
  assert.equal(recovered, 100);
});

test('applyOutboundPolicy recomputes fit from commercial fit_breakdown not legacy score_breakdown', () => {
  const out = applyOutboundPolicy({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    recomputeFitFromBreakdown: true,
    record: {
      _row_id: 'acct_fit_src',
      is_a_business: true,
      company_resolution: 'resolved',
      identity_confidence: 90,
      fit_score: 0,
      fit_breakdown: JSON.stringify(commercialBreakdown),
      score_breakdown: JSON.stringify(legacyScoreBreakdown),
    },
  });
  assert.ok(Number(out.patch.fit_score) >= 70, `expected commercial fit, got ${out.patch.fit_score}`);
  assert.notEqual(out.treatment_tier, 'D');
  const calc = JSON.parse(String(out.patch.fit_calculation_json));
  assert.ok(calc.components.some((c) => c.id === 'operational_coordination_burden' && c.grade === 8));
  assert.equal(out.patch.fit_breakdown_source, 'fit_breakdown');
});

test('applyOutboundPolicy does NOT zero fit_score when only legacy score_breakdown present', () => {
  const out = applyOutboundPolicy({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    recomputeFitFromBreakdown: true,
    record: {
      _row_id: 'acct_legacy',
      is_a_business: true,
      company_resolution: 'resolved',
      identity_confidence: 85,
      fit_score: 0,
      // Stale wiped fit; legacy points should recover ~100
      fit_breakdown: JSON.stringify(legacyFitBreakdownPoints),
      score_breakdown: JSON.stringify(legacyScoreBreakdown),
      fit_evidence_confidence: 45,
    },
  });
  assert.ok(Number(out.patch.fit_score) >= 80, `recovered fit expected >=80 got ${out.patch.fit_score}`);
  assert.equal(out.treatment_tier, 'B');
  assert.match(String(out.patch.treatment_reasons), /fit_band=80-100/);
  // Must not write all-missing commercial zero calculation as authoritative fit
  const calc = JSON.parse(String(out.patch.fit_calculation_json || '{}'));
  assert.notEqual(calc.fit_score, 0);
  assert.ok(
    calc.calculation_rule_version === 'tv-fit-legacy-recovery-v1'
      || Number(calc.fit_score) >= 80,
  );
});

test('Butter Classics shape: recovery + treatment consistent (no fit0/tierB contradiction)', () => {
  const out = applyOutboundPolicy({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    recomputeFitFromBreakdown: true,
    record: {
      _row_id: 'ChIJEecJ8V9XrlQRv7AnWgVQMOw',
      business_name: 'Butter Classics',
      is_a_business: true,
      company_resolution: 'resolved',
      identity_confidence: 70,
      fit_score: 0,
      fit_evidence_confidence: 45,
      fit_breakdown: JSON.stringify(legacyFitBreakdownPoints),
      score_breakdown: JSON.stringify([
        { id: 'ticket_size', grade: 8, weight: 0.3 },
        { id: 'walk_in_decision_maker_access', grade: 9, weight: 0.3 },
      ]),
      treatment_tier: 'B',
      treatment_reasons: 'fit_band=80-100; fit_evidence_band=40-59; high_fit_thin_evidence_postcard_exception_path',
    },
  });
  assert.ok(Number(out.patch.fit_score) >= 80);
  assert.equal(out.treatment_tier, 'B');
  assert.match(String(out.patch.treatment_reasons), /fit_band=80-100/);
  // explainable: fit and treatment agree
  assert.ok(Number(out.patch.fit_score) >= 80 && out.treatment_tier === 'B');
});
