/**
 * Phase 3 intake / identity / evidence / resolution isolation suite.
 *
 * Drives **shipped** AgentOutbound policy + TV config only (no reimplementation).
 * Mandated coverage:
 *  1. classifyEligibility cases (hard eligibility outcomes)
 *  2. evidence_resolution_json from applyOutboundPolicy
 *  3. company_resolution gate config presence (TV outbound.yaml)
 *  4. source snapshots, observations, contradictions, identity_resolution on policy path
 *
 * Complete-when: a raw sourced record becomes one canonical account whose
 * consequential facts, conflicts, unknowns, source snapshots, and resolution
 * history are inspectable and reproducible via applyOutboundPolicy.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';

import {
  applyOutboundPolicy,
  buildEvidenceResolutionEnvelope,
} from '../dist/orchestrator/policy/apply-record.js';
import {
  classifyEligibility,
} from '../dist/orchestrator/policy/readiness.js';
import {
  buildObservationStore,
  buildSourceSnapshotFromRecord,
  deriveIdentityConfidence,
  detectContradictions,
  extractObservationsFromRecord,
  buildIdentityResolution,
} from '../dist/orchestrator/policy/evidence.js';
import { treasureValleyTreatmentStrategy } from './fixtures/treatment-strategy.mjs';

const TV_YAML =
  process.env.TV_PROJECT_PATH
    ? `${process.env.TV_PROJECT_PATH}/outbound.yaml`
    : '/Users/rayepps/projects/mission/.outbound/treasure-valley/outbound.yaml';

const baseEligibility = {
  isBusiness: true,
  permanentlyClosed: false,
  outOfTerritory: false,
  isDuplicate: false,
  isNonSmbOrg: false,
  corporateNoLocalAuthority: false,
  identityUnresolved: false,
  suppressed: false,
};

// ---------------------------------------------------------------------------
// 1. classifyEligibility cases
// ---------------------------------------------------------------------------

test('classifyEligibility: passed hard eligibility → eligible', () => {
  const r = classifyEligibility(baseEligibility);
  assert.equal(r.outcome, 'eligible');
  assert.deepEqual(r.reasons, ['passed_hard_eligibility']);
  assert.ok(Array.isArray(r.evidence_ids));
});

test('classifyEligibility: suppressed wins first', () => {
  const r = classifyEligibility({ ...baseEligibility, suppressed: true });
  assert.equal(r.outcome, 'suppressed');
  assert.ok(r.reasons.includes('suppression_rule'));
});

test('classifyEligibility: not_a_business → disqualified', () => {
  const r = classifyEligibility({ ...baseEligibility, isBusiness: false });
  assert.equal(r.outcome, 'disqualified');
  assert.ok(r.reasons.includes('not_a_business'));
});

test('classifyEligibility: permanently_closed → disqualified', () => {
  const r = classifyEligibility({ ...baseEligibility, permanentlyClosed: true });
  assert.equal(r.outcome, 'disqualified');
  assert.ok(r.reasons.includes('permanently_closed'));
});

test('classifyEligibility: out_of_territory → disqualified', () => {
  const r = classifyEligibility({ ...baseEligibility, outOfTerritory: true });
  assert.equal(r.outcome, 'disqualified');
  assert.ok(r.reasons.includes('out_of_territory'));
});

test('classifyEligibility: duplicate_canonical_record → disqualified', () => {
  const r = classifyEligibility({ ...baseEligibility, isDuplicate: true });
  assert.equal(r.outcome, 'disqualified');
  assert.ok(r.reasons.includes('duplicate_canonical_record'));
});

test('classifyEligibility: non_smb_organization → disqualified (category alone is not enough; flag required)', () => {
  // Category (e.g. healthcare) alone never disqualifies — only explicit non-SMB org flag.
  const okVertical = classifyEligibility({
    ...baseEligibility,
    isNonSmbOrg: false,
  });
  assert.equal(okVertical.outcome, 'eligible');

  const school = classifyEligibility({ ...baseEligibility, isNonSmbOrg: true });
  assert.equal(school.outcome, 'disqualified');
  assert.ok(school.reasons.includes('non_smb_organization'));
});

test('classifyEligibility: corporate_no_local_authority → disqualified', () => {
  const r = classifyEligibility({
    ...baseEligibility,
    corporateNoLocalAuthority: true,
  });
  assert.equal(r.outcome, 'disqualified');
  assert.ok(r.reasons.includes('corporate_no_local_authority'));
});

test('classifyEligibility: identity_unresolved → enrichment_hold (not disqualified)', () => {
  const r = classifyEligibility({
    ...baseEligibility,
    identityUnresolved: true,
  });
  assert.equal(r.outcome, 'enrichment_hold');
  assert.ok(r.reasons.includes('identity_unresolved'));
});

test('classifyEligibility: reasonEvidenceIds are preserved on outcome', () => {
  const r = classifyEligibility({
    ...baseEligibility,
    permanentlyClosed: true,
    reasonEvidenceIds: ['obs_closed_1', 'snap_places_9'],
  });
  assert.equal(r.outcome, 'disqualified');
  assert.deepEqual(r.evidence_ids, ['obs_closed_1', 'snap_places_9']);
});

test('classifyEligibility: priority order suppressed > not_business > closed > territory > duplicate > non_smb > corporate > identity', () => {
  // Suppressed beats everything else when true.
  const multi = classifyEligibility({
    isBusiness: false,
    permanentlyClosed: true,
    outOfTerritory: true,
    isDuplicate: true,
    isNonSmbOrg: true,
    corporateNoLocalAuthority: true,
    identityUnresolved: true,
    suppressed: true,
  });
  assert.equal(multi.outcome, 'suppressed');

  // Without suppressed, not_a_business wins over later flags.
  const notBiz = classifyEligibility({
    isBusiness: false,
    permanentlyClosed: true,
    outOfTerritory: true,
    isDuplicate: true,
    isNonSmbOrg: true,
    corporateNoLocalAuthority: true,
    identityUnresolved: true,
    suppressed: false,
  });
  assert.equal(notBiz.outcome, 'disqualified');
  assert.deepEqual(notBiz.reasons, ['not_a_business']);
});

// ---------------------------------------------------------------------------
// 2. evidence_resolution_json from applyOutboundPolicy
// ---------------------------------------------------------------------------

test('applyOutboundPolicy: writes evidence_resolution_json with required envelope fields', () => {
  const r = applyOutboundPolicy({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    record: {
      _row_id: 'acct_phase3_ev',
      business_name: 'Meridian Peak Plumbing',
      place_id: 'places/ChIJphase3',
      company_resolution: 'resolved',
      is_a_business: true,
      score_breakdown: JSON.stringify([
        {
          id: 'operational_coordination_burden',
          grade: 8,
          reasoning: 'multi-crew dispatch',
          evidence_ids: ['obs_crew', 'obs_reviews'],
        },
        {
          id: 'repetition_and_volume',
          grade: 7,
          reasoning: 'repeat admin loops',
          evidence_ids: ['obs_reviews'],
        },
        // remaining fit components missing → missing_inputs populated
      ]),
      identity_confidence: 88,
      buyer_confidence: 60,
      address_rdi: 'Commercial',
      timing_score: 15,
    },
    recomputeFitFromBreakdown: true,
  });

  assert.ok(r.patch.evidence_resolution_json, 'evidence_resolution_json must be set');
  const env = JSON.parse(String(r.patch.evidence_resolution_json));

  assert.equal(env.account_id, 'acct_phase3_ev');
  assert.equal(typeof env.fit_score, 'number');
  assert.ok(env.fit_evidence_confidence != null);
  assert.ok(env.treatment_tier);
  assert.equal(env.eligibility_outcome, 'eligible');
  assert.ok(Array.isArray(env.missing_inputs));
  assert.ok(env.missing_inputs.includes('economic_impact_potential'));
  assert.ok(Array.isArray(env.contradictions));
  // No material conflict on this record → empty list (still inspectable)
  assert.deepEqual(env.contradictions, []);
  assert.ok(env.policy_versions && typeof env.policy_versions === 'object');
  assert.ok(env.policy_versions.treatment);
  assert.ok(env.policy_versions.next_action);
  assert.ok(env.generated_at);
  assert.match(String(env.generated_at), /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Array.isArray(env.source_observation_refs));
  assert.deepEqual(env.source_observation_refs, ['obs_crew', 'obs_reviews']);

  // Evidence contract surfaces persisted alongside envelope
  assert.ok(r.patch.observations_json, 'observations_json must be set');
  assert.ok(r.patch.identity_resolution_json, 'identity_resolution_json must be set');
  assert.ok(JSON.parse(String(r.patch.observations_json)).snapshots, 'authoritative snapshots must be set');
  assert.ok(r.patch.contradictions_json != null, 'contradictions_json must be set');

  // Top-level eligibility fields also written for operators
  assert.equal(r.patch.eligibility_outcome, 'eligible');
  assert.ok(String(r.patch.eligibility_reasons).includes('passed_hard_eligibility'));
  assert.equal(r.eligibility_outcome, 'eligible');
});

test('applyOutboundPolicy: material_contradiction populates inspectable contradictions', () => {
  const r = applyOutboundPolicy({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    record: {
      _row_id: 'acct_conflict',
      business_name: 'Conflict Co',
      place_id: 'places/ChIJconflict',
      source: 'geo_tiles',
      source_query: 'HVAC Boise',
      sourced_at: '2026-08-01T12:00:00.000Z',
      company_resolution: 'resolved',
      is_a_business: true,
      fit_score: 60,
      identity_confidence: 85,
      material_contradiction: true,
    },
  });
  const env = JSON.parse(String(r.patch.evidence_resolution_json));
  assert.ok(Array.isArray(env.contradictions));
  assert.ok(env.contradictions.length >= 1, 'material contradiction must surface on envelope');
  assert.equal(env.contradictions[0].field, 'material_contradiction');
  assert.equal(env.contradictions[0].status, 'open');

  const stored = JSON.parse(String(r.patch.contradictions_json));
  assert.ok(stored.length >= 1);
  const store = JSON.parse(String(r.patch.observations_json));
  assert.ok(store.snapshots.length >= 1);
  assert.ok(store.observations.length >= 1);
  assert.ok(store.identity_resolution);
  assert.equal(store.identity_resolution.company_resolution, 'resolved');
});

test('applyOutboundPolicy: unresolvable company_resolution → eligibility enrichment_hold', () => {
  const r = applyOutboundPolicy({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    record: {
      _row_id: 'acct_unresolvable',
      company_resolution: 'unresolvable',
      is_a_business: true,
      fit_score: 50,
      identity_confidence: 40,
    },
  });
  assert.equal(r.eligibility_outcome, 'enrichment_hold');
  const env = JSON.parse(String(r.patch.evidence_resolution_json));
  assert.equal(env.eligibility_outcome, 'enrichment_hold');
  assert.ok(String(r.patch.eligibility_reasons).includes('identity_unresolved'));
});

test('applyOutboundPolicy: permanently closed → disqualified terminal next_action', () => {
  const r = applyOutboundPolicy({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    record: {
      _row_id: 'acct_closed',
      company_resolution: 'resolved',
      is_a_business: true,
      business_status: 'CLOSED_PERMANENTLY',
      fit_score: 70,
      identity_confidence: 90,
    },
  });
  assert.equal(r.eligibility_outcome, 'disqualified');
  assert.equal(r.patch.lifecycle_stage, 'disqualified');
  assert.equal(r.next_action.action_type, 'terminal_recordkeeping');
  const env = JSON.parse(String(r.patch.evidence_resolution_json));
  assert.equal(env.eligibility_outcome, 'disqualified');
});

test('buildEvidenceResolutionEnvelope: pure helper is stable and optional refs', () => {
  const a = buildEvidenceResolutionEnvelope({
    account_id: 'a1',
    fit_score: 72,
    fit_evidence_confidence: 80,
    treatment_tier: 'B',
    eligibility_outcome: 'eligible',
    missing_inputs: ['buyer'],
    contradictions: [{ field: 'owner', a: 'x', b: 'y' }],
    policy_versions: { treatment: 'tv-treatment-v1' },
    generated_at: '2026-08-04T12:00:00.000Z',
    source_observation_refs: ['obs_1'],
  });
  assert.equal(a.account_id, 'a1');
  assert.equal(a.fit_score, 72);
  assert.deepEqual(a.missing_inputs, ['buyer']);
  assert.equal(a.contradictions.length, 1);
  assert.deepEqual(a.source_observation_refs, ['obs_1']);
  assert.equal(a.generated_at, '2026-08-04T12:00:00.000Z');

  const b = buildEvidenceResolutionEnvelope({
    account_id: 'a2',
    fit_score: null,
    fit_evidence_confidence: null,
    treatment_tier: 'enrichment_hold',
    eligibility_outcome: 'enrichment_hold',
    policy_versions: {},
  });
  assert.equal(b.source_observation_refs, undefined);
  assert.ok(b.generated_at);
});

// ---------------------------------------------------------------------------
// 3. company_resolution gate config presence (TV)
// ---------------------------------------------------------------------------

function loadTv() {
  assert.ok(existsSync(TV_YAML), `TV config missing: ${TV_YAML}`);
  return yaml.load(readFileSync(TV_YAML, 'utf8'));
}

test('TV config: linkedin_company_resolution enrich step + company_resolved_gate exist', () => {
  const cfg = loadTv();
  const pipeline = Array.isArray(cfg.pipeline) ? cfg.pipeline : [];

  const resolution = pipeline.find((s) => s.id === 'linkedin_company_resolution');
  assert.ok(resolution, 'missing pipeline step id=linkedin_company_resolution');
  assert.equal(resolution.kind, 'enrich');
  assert.equal(resolution.action, 'linkedin_company_resolution');
  assert.ok(resolution.outputs?.company_resolution, 'outputs.company_resolution required');
  assert.equal(resolution.outputs.company_resolution.type, 'string');

  const gate = pipeline.find((s) => s.id === 'company_resolved_gate');
  assert.ok(gate, 'missing pipeline step id=company_resolved_gate');
  assert.equal(gate.kind, 'filter');
  assert.equal(gate.type, 'field_check');
  assert.equal(gate.on_fail, 'drop');
  assert.ok(
    Array.isArray(gate.depends_on) && gate.depends_on.includes('linkedin_company_resolution'),
    'gate must depend on linkedin_company_resolution',
  );
  const cond = (gate.conditions || []).find((c) => c.field === 'company_resolution');
  assert.ok(cond, 'gate must check field company_resolution');
  assert.equal(cond.operator, 'eq');
  assert.equal(cond.value, 'resolved');
});

test('TV config: source identity + strategies feed intake path', () => {
  const cfg = loadTv();
  assert.ok(cfg.source, 'source block required');
  assert.ok(Array.isArray(cfg.source.identity));
  assert.ok(cfg.source.identity.includes('name'));
  assert.ok(cfg.source.identity.includes('address'));
  assert.equal(cfg.source.dedup_key, 'place_id');

  const strategies = cfg.source.strategies || [];
  const kinds = strategies.map((s) => s.kind);
  assert.ok(kinds.includes('geo_tiles'), 'geo_tiles strategy required for broad SMB universe');
  assert.ok(
    kinds.includes('linkedin_profile_search'),
    'linkedin_profile_search strategy required (person-first → company resolution)',
  );

  // Source-time exclusions exist (not_a_business_place, junk_name)
  const exclude = cfg.source.exclude || [];
  const descs = exclude.map((e) => e.description);
  assert.ok(descs.includes('not_a_business_place'));
  assert.ok(descs.includes('junk_name'));
});

// ---------------------------------------------------------------------------
// Complete-when: raw → canonical account with inspectable facts/conflicts/
// unknowns/snapshots/resolution history (reproducible on re-apply)
// ---------------------------------------------------------------------------

test('Complete-when: raw-shaped sourced record → canonical account with inspectable evidence + resolution history', () => {
  // Simulates a Places-sourced row after identity normalize (place_id present,
  // company_resolution resolved) entering policy_apply.
  const rawShaped = {
    _row_id: 'places_tv_hvac_001',
    business_name: 'Boise Peak HVAC',
    place_id: 'places/ChIJraw001',
    google_place_id: 'places/ChIJraw001',
    primary_type: 'hvac_contractor',
    website: 'https://example-boise-hvac.test',
    address: '1234 Fairview Ave, Boise, ID',
    phone: '208-555-0100',
    company_resolution: 'resolved',
    resolution_source: 'places',
    is_a_business: true,
    business_status: 'OPERATIONAL',
    source: 'geo_tiles',
    source_query: 'hvac_contractor near Boise',
    sourced_at: '2026-08-01T10:00:00.000Z',
    source_cost_usd: 0.02,
    score_breakdown: JSON.stringify([
      {
        id: 'operational_coordination_burden',
        grade: 8,
        reasoning: 'dispatch + multi van',
        evidence_ids: ['obs_maps_photos'],
      },
      {
        id: 'repetition_and_volume',
        grade: 8,
        reasoning: 'review volume',
        evidence_ids: ['obs_reviews'],
      },
      {
        id: 'economic_impact_potential',
        grade: 7,
        reasoning: 'ticket size signals',
        evidence_ids: ['obs_reviews'],
      },
      {
        id: 'operating_scale_surface_area',
        grade: 6,
        reasoning: 'single site',
        evidence_ids: ['obs_maps_photos'],
      },
      {
        id: 'mission_delivery_compatibility',
        grade: 8,
        reasoning: 'admin heavy trades',
        evidence_ids: ['obs_reviews'],
      },
      {
        id: 'local_buying_autonomy',
        grade: 9,
        reasoning: 'independent',
        evidence_ids: ['obs_site'],
      },
    ]),
    identity_confidence: 90,
    buyer_confidence: 70,
    address_rdi: 'Commercial',
    contact_email: 'office@example-boise-hvac.test',
    timing_score: 25,
  };

  const r = applyOutboundPolicy({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    record: rawShaped,
    recomputeFitFromBreakdown: true,
  });

  // One canonical account id preserved
  assert.equal(r.patch.eligibility_outcome, 'eligible');
  assert.ok(['A', 'B', 'C', 'D', 'enrichment_hold'].includes(r.treatment_tier));
  assert.ok(r.next_action);
  assert.equal(r.next_action.account_id, 'places_tv_hvac_001');

  // Inspectable evidence / resolution surface (policy envelope)
  const env = JSON.parse(String(r.patch.evidence_resolution_json));
  assert.equal(env.account_id, 'places_tv_hvac_001');
  assert.equal(env.eligibility_outcome, 'eligible');
  assert.ok(typeof env.fit_score === 'number');
  assert.ok(env.policy_versions.fit || env.policy_versions.treatment);
  assert.ok(env.source_observation_refs.includes('obs_maps_photos'));
  assert.ok(env.source_observation_refs.includes('obs_reviews'));
  assert.ok(env.generated_at);
  assert.ok(Array.isArray(env.contradictions));

  // Source snapshots inspectable
  const snapshots = JSON.parse(String(r.patch.observations_json)).snapshots;
  assert.ok(Array.isArray(snapshots) && snapshots.length >= 1);
  assert.equal(snapshots[0].provider, 'geo_tiles');
  assert.equal(snapshots[0].query, 'hvac_contractor near Boise');
  assert.equal(snapshots[0].retrieved_at, '2026-08-01T10:00:00.000Z');
  assert.ok(snapshots[0].source_id);

  // Atomic observations (consequential facts) inspectable
  const store = JSON.parse(String(r.patch.observations_json));
  assert.equal(store.account_id, 'places_tv_hvac_001');
  assert.ok(store.observations.some((o) => o.predicate === 'business_name' && o.value === 'Boise Peak HVAC'));
  assert.ok(store.observations.some((o) => o.predicate === 'place_id'));
  assert.ok(store.observations.some((o) => o.predicate === 'company_resolution' && o.value === 'resolved'));
  assert.ok(store.observations.every((o) => o.evidence_id && o.support_status && o.observed_at));

  // Identity / field resolution history inspectable
  const idRes = JSON.parse(String(r.patch.identity_resolution_json));
  assert.equal(idRes.account_id, 'places_tv_hvac_001');
  assert.equal(idRes.place_id, 'places/ChIJraw001');
  assert.equal(idRes.company_resolution, 'resolved');
  assert.ok(Array.isArray(idRes.resolutions) && idRes.resolutions.length >= 1);
  const nameRes = idRes.resolutions.find((x) => x.field === 'business_name');
  assert.ok(nameRes);
  assert.equal(nameRes.value, 'Boise Peak HVAC');
  assert.ok(Array.isArray(nameRes.evidence_ids));
  assert.ok(Array.isArray(nameRes.alternatives));
  assert.ok(nameRes.resolved_at);

  // Reproducible: same inputs → same structural eligibility / treatment / facts
  const r2 = applyOutboundPolicy({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    record: { ...rawShaped, next_action_json: r.patch.next_action_json },
    recomputeFitFromBreakdown: true,
  });
  assert.equal(r2.eligibility_outcome, r.eligibility_outcome);
  assert.equal(r2.treatment_tier, r.treatment_tier);
  const env2 = JSON.parse(String(r2.patch.evidence_resolution_json));
  assert.equal(env2.eligibility_outcome, env.eligibility_outcome);
  assert.equal(env2.fit_score, env.fit_score);
  assert.deepEqual(env2.missing_inputs, env.missing_inputs);
  assert.deepEqual(env2.source_observation_refs, env.source_observation_refs);

  const store2 = JSON.parse(String(r2.patch.observations_json));
  assert.deepEqual(
    store2.observations.map((o) => ({ p: o.predicate, v: o.value, s: o.support_status })),
    store.observations.map((o) => ({ p: o.predicate, v: o.value, s: o.support_status })),
  );
  const idRes2 = JSON.parse(String(r2.patch.identity_resolution_json));
  assert.equal(idRes2.place_id, idRes.place_id);
  assert.equal(idRes2.resolutions.find((x) => x.field === 'business_name')?.value, nameRes.value);
});

test('evidence helpers: snapshot + observations + identity + contradictions pure path', () => {
  const record = {
    _row_id: 'pure_ev_1',
    business_name: 'Pure Co',
    alternate_name: 'Other Co',
    name_conflict: true,
    place_id: 'p1',
    address: '9 Oak',
    source: 'places',
    sourced_at: '2026-07-01T00:00:00.000Z',
    company_resolution: 'resolved',
    is_a_business: true,
    business_status: 'OPERATIONAL',
  };
  const snap = buildSourceSnapshotFromRecord(record);
  assert.ok(snap);
  assert.equal(snap.provider, 'places');
  const obs = extractObservationsFromRecord(record);
  assert.ok(obs.some((o) => o.predicate === 'business_name'));
  const ctr = detectContradictions({ record, observations: obs });
  assert.ok(ctr.some((c) => c.field === 'business_name'));
  const id = buildIdentityResolution(record);
  assert.equal(id.resolutions.find((r) => r.field === 'business_name')?.value, 'Pure Co');
  const store = buildObservationStore(record);
  assert.ok(store.snapshots.length >= 1);
  assert.ok(store.contradictions.length >= 1);
});

test('identity confidence: fully literal-supported identity scores high; unresolved and open contradiction fail closed', () => {
  const fullyResolved = buildIdentityResolution({
    _row_id: 'identity_confidence_high',
    business_name: 'Top Shelf Heating and Cooling',
    address: '123 Main St, Boise, ID',
    website: 'https://topshelf.example',
    place_id: 'ChIJt8Qe',
    company_resolution: 'resolved',
    observations_json: JSON.stringify({
      observations: [{
        evidence_id: 'obs_website',
        predicate: 'website',
        value: 'https://topshelf.example',
        support_status: 'literal_support',
        source_id: 'site_1',
        observed_at: '2026-08-06T00:00:00.000Z',
        provisional: false,
      }],
    }),
  });
  assert.equal(fullyResolved.identity_confidence, 100);

  const unresolved = buildIdentityResolution({
    _row_id: 'identity_confidence_unresolved',
    business_name: 'Unknown Heating',
    place_id: 'ChIJunknown',
    company_resolution: 'unresolved',
  });
  assert.equal(unresolved.identity_confidence, 0);

  const contradicted = {
    ...fullyResolved,
    resolutions: fullyResolved.resolutions.map((resolution) => (
      resolution.field === 'business_name'
        ? {
          ...resolution,
          contradictions: [{
            contradiction_id: 'name_conflict',
            field: 'business_name',
            values: ['Top Shelf Heating and Cooling', 'Top Shelf Plumbing'],
            evidence_ids: ['obs_website'],
            status: 'open',
            noted_at: '2026-08-06T00:00:00.000Z',
          }],
        }
        : resolution
    )),
  };
  assert.equal(deriveIdentityConfidence(contradicted), 75);
});
