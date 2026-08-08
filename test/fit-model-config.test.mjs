import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateFitScore } from '../dist/orchestrator/policy/scoring.js';
import { applyOutboundPolicy } from '../dist/orchestrator/policy/apply-record.js';
import { treasureValleyTreatmentStrategy } from './fixtures/treatment-strategy.mjs';
import { treasureValleyFitModel } from './fixtures/fit-model.mjs';

test('pipeline-declared fit components score without built-in dimension identities', () => {
  const result = calculateFitScore([
    { id: 'speed_to_lead', grade: 8, evidence_ids: ['lead-time'] },
    { id: 'ticket_size', grade: 4, evidence_ids: ['orders'] },
  ], {
    criteria: [
      { id: 'speed_to_lead', weight: 0.5 },
      { id: 'ticket_size', weight: 0.5 },
    ],
    modelVersion: 'support-fit-v3',
  });

  assert.equal(result.fit_score, 60);
  assert.equal(result.fit_model_version, 'support-fit-v3');
  assert.deepEqual(result.missing_inputs, []);
});

test('an undeclared fit model produces no score instead of a silent zero', () => {
  const calculated = calculateFitScore([{ id: 'speed_to_lead', grade: 8 }]);
  assert.equal(calculated.fit_score, null);
  assert.equal(calculated.reason, 'fit_components_not_configured');

  const applied = applyOutboundPolicy({
    recomputeFitFromBreakdown: true,
    treatmentStrategy: treasureValleyTreatmentStrategy,
    record: {
      _row_id: 'no_fit_model',
      fit_score: 99,
      score_breakdown: JSON.stringify([{ id: 'speed_to_lead', grade: 8 }]),
    },
  });
  assert.equal(applied.patch.fit_score, null);
  assert.equal(JSON.parse(String(applied.patch.fit_calculation_json)).reason, 'fit_components_not_configured');
});

test('configured fit components with no grades remain unscored and do not band into treatment', () => {
  const ungraded = calculateFitScore([], treasureValleyFitModel);
  assert.equal(ungraded.fit_score, null);
  assert.equal(ungraded.reason, 'fit_not_graded');

  const missingBreakdown = treasureValleyFitModel.criteria.map(({ id }) => ({
    id,
    grade: 0,
    missing: true,
    evidence_ids: [],
  }));
  const applied = applyOutboundPolicy({
    recomputeFitFromBreakdown: true,
    fitModel: treasureValleyFitModel,
    treatmentStrategy: treasureValleyTreatmentStrategy,
    record: {
      _row_id: 'fit_not_graded',
      fit_score: 0,
      score_breakdown: JSON.stringify(missingBreakdown),
    },
  });
  assert.equal(applied.patch.fit_score, null);
  assert.equal(applied.treatment_tier, 'enrichment_hold');
  assert.match(String(applied.patch.treatment_reasons), /fit_band=unscored/);
  assert.equal(JSON.parse(String(applied.patch.fit_calculation_json)).reason, 'fit_not_graded');
});

test('all genuinely graded zero components preserve a zero fit score and breakdown', () => {
  const zeroes = calculateFitScore(treasureValleyFitModel.criteria.map(({ id }) => ({
    id,
    grade: 0,
    evidence_ids: [`obs_${id}`],
  })), treasureValleyFitModel);
  assert.equal(zeroes.fit_score, 0);
  assert.equal(zeroes.reason, undefined);
  assert.equal(zeroes.components.length, treasureValleyFitModel.criteria.length);
});

test('an equivalent Treasure Valley declaration preserves fit arithmetic and assessable normalization', () => {
  const complete = calculateFitScore([
    { id: 'operational_coordination_burden', grade: 8 },
    { id: 'repetition_and_volume', grade: 7 },
    { id: 'economic_impact_potential', grade: 8 },
    { id: 'operating_scale_surface_area', grade: 6 },
    { id: 'mission_delivery_compatibility', grade: 7 },
    { id: 'local_buying_autonomy', grade: 9 },
  ], treasureValleyFitModel);
  assert.equal(complete.fit_score, 74.7);
  assert.equal(complete.assessable_weight, 1);
  assert.deepEqual(complete.missing_inputs, []);

  const unassessable = calculateFitScore([
    { id: 'operational_coordination_burden', grade: 8 },
    { id: 'repetition_and_volume', grade: 8 },
    { id: 'economic_impact_potential', grade: 8 },
    { id: 'operating_scale_surface_area', grade: 8 },
    { id: 'mission_delivery_compatibility', grade: 8, unassessable: true },
    { id: 'local_buying_autonomy', grade: 8 },
  ], treasureValleyFitModel);
  assert.equal(unassessable.fit_score, 80);
  assert.equal(unassessable.assessable_weight, 0.8);
  assert.deepEqual(unassessable.missing_inputs, ['mission_delivery_compatibility']);
});
