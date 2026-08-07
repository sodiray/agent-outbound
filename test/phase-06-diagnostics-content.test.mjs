/**
 * Phase 6 — diagnostic registries and economic calculations.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import yaml from 'js-yaml';

import { calculateEconomicScenario } from '../dist/orchestrator/policy/economics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TV_ROOT =
  process.env.TV_ROOT ||
  '/Users/rayepps/projects/mission/.outbound/treasure-valley';
const TV_YAML = join(TV_ROOT, 'outbound.yaml');
const DIAG = join(TV_ROOT, 'build/registries/diagnostic-families.json');
const PROOF = join(TV_ROOT, 'build/assets/proof-library.json');
const REQUIRED_DIAG_OUTPUTS = [
  'diagnostic_hypotheses_json',
  'economic_scenarios_json',
  'proof_match_ids',
  'preliminary_snapshot',
];

const loadJson = (path) => {
  assert.ok(existsSync(path), `missing asset: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
};

test('phase-06: economic admin_labor_leak calculates range with assumptions', () => {
  const insuff = calculateEconomicScenario({ scenario_id: 'admin_labor_leak' });
  assert.equal(insuff.evidence_status, 'insufficient');
  assert.equal(insuff.annual_low_usd, null);
  assert.equal(insuff.annual_high_usd, null);
  assert.ok(insuff.missing_inputs.includes('weekly_admin_hours'));

  const calculated = calculateEconomicScenario({
    scenario_id: 'admin_labor_leak',
    weekly_admin_hours: 10,
    hourly_loaded_cost: 40,
  });
  assert.equal(calculated.evidence_status, 'calculated');
  assert.equal(calculated.annual_low_usd, Math.round(19200 * 0.7));
  assert.equal(calculated.annual_high_usd, Math.round(19200 * 1.3));
  assert.ok(calculated.assumptions.some((assumption) => /weeks_per_year=48/.test(assumption)));
});

test('phase-06: economic missed_lead_revenue requires leads and job value', () => {
  const noLeads = calculateEconomicScenario({
    scenario_id: 'missed_lead_revenue',
    avg_job_value: 3500,
  });
  assert.equal(noLeads.evidence_status, 'insufficient');
  assert.ok(noLeads.missing_inputs.includes('missed_leads_per_month'));

  const calculated = calculateEconomicScenario({
    scenario_id: 'missed_lead_revenue',
    missed_leads_per_month: 4,
    avg_job_value: 3500,
    close_rate: 0.25,
  });
  assert.equal(calculated.evidence_status, 'calculated');
  assert.equal(calculated.annual_low_usd, Math.round(42000 * 0.6));
  assert.equal(calculated.annual_high_usd, Math.round(42000 * 1.4));
});

test('phase-06: unknown economic scenario is insufficient without invented numbers', () => {
  const result = calculateEconomicScenario({ scenario_id: 'exact_annual_leakage_fantasy' });
  assert.equal(result.evidence_status, 'insufficient');
  assert.equal(result.annual_low_usd, null);
  assert.equal(result.annual_high_usd, null);
  assert.ok(result.missing_inputs.includes('unknown_scenario_id'));
});

test('phase-06: proof library has Mission provenance and structured restrictions', () => {
  const library = loadJson(PROOF);
  assert.equal(library.library_version, 'tv-proof-v1');
  assert.ok(Array.isArray(library.proofs));
  assert.ok(library.proofs.length >= 1);

  for (const proof of library.proofs) {
    assert.ok(proof.proof_id);
    assert.ok(proof.category);
    assert.ok(String(proof.provenance || '').includes('Mission'));
    assert.ok(Array.isArray(proof.usage_restrictions) && proof.usage_restrictions.length > 0);
  }
});

test('phase-06: diagnostic families retain supported workflow and calculator metadata', () => {
  const registry = loadJson(DIAG);
  assert.equal(registry.registry_version, 'tv-diagnostic-v1');
  assert.equal(registry.offer, 'diagnostic_partnership');

  for (const familyId of [
    'trades_field_services',
    'construction_project_services',
    'professional_advisory_services',
    'healthcare_clinical',
    'default',
  ]) {
    const family = registry.families[familyId];
    assert.ok(family, `missing family: ${familyId}`);
    assert.ok(Array.isArray(family.workflow_areas) && family.workflow_areas.length > 0);
    assert.ok(Array.isArray(family.hypotheses) && family.hypotheses.length > 0);
    assert.ok(Array.isArray(family.discovery_questions) && family.discovery_questions.length > 0);
    assert.ok(Array.isArray(family.economic_calculators) && family.economic_calculators.length > 0);
  }
});

test('phase-06: diagnostic content is not gated on the treatment it feeds', () => {
  const config = yaml.load(readFileSync(TV_YAML, 'utf8'));
  const step = config.pipeline.find((candidate) => candidate.id === 'diagnostic_content_pack');
  assert.ok(step);
  assert.equal(step.kind, 'generate');
  assert.ok(step.depends_on.includes('treatment_assignment'));
  assert.ok(step.depends_on.includes('account_intelligence'));

  const outputs = Object.keys(step.outputs || {});
  for (const output of REQUIRED_DIAG_OUTPUTS) {
    assert.ok(outputs.includes(output), `missing output: ${output}`);
  }
  // Content is an INPUT to treatment, so it must not be gated on treatment's
  // output. Gating on `treatment_tier in [A,B,C]` produced a live deadlock:
  // no content -> treatment assigns enrichment_hold -> the content step skips
  // itself for not being A/B/C -> content is never produced. Every Treasure
  // Valley account was stuck in it and could never send.
  //
  // Tier D is the one legitimate exclusion: it permits no proactive outbound,
  // so generating content for it is wasted spend.
  const treatmentTier = step.when.conditions.find((condition) => condition.field === 'treatment_tier');
  assert.equal(treatmentTier.operator, 'not_in');
  assert.deepEqual(treatmentTier.value, ['D']);
  assert.ok(
    !(treatmentTier.value || []).some((tier) => ['A', 'B', 'C'].includes(tier)),
    'content generation must not require a tier that depends on content',
  );
});
