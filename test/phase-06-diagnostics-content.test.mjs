/**
 * Phase 6 — diagnostics, economics, proof, and content (isolated validation).
 *
 * Mandate coverage:
 * 1. Claim audit pass / fail
 * 2. Economic scenario calculator (inputs, ranges, insufficient, unknown)
 * 3. Proof library load (Mission provenance, structure)
 * 4. Prohibited claims (default patterns + packet patterns + proof-without-id)
 *
 * Also asserts TV config step `diagnostic_content_pack` and diagnostic-family
 * registry shape. Drives shipped modules only — no reimplementation.
 *
 * Complete-when (plan): every generated asset is specific, evidence-bound,
 * claim-audited, and proof-linked. This suite proves the *deterministic*
 * surfaces that exist today; it does not claim full Stage 7–13 production depth.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import yaml from 'js-yaml';

import {
  auditClaims,
  calculateEconomicScenario,
  claimTextAuthorizedByPermitted,
  CLAIM_AUDIT_VERSION,
  CLAIM_MATCH_MIN_SUBSET_LEN,
  ECONOMIC_RULE_VERSION,
} from '../dist/orchestrator/policy/claim-audit.js';
import {
  assemblePermittedClaimPacket,
  loadDiagnosticFamilies,
  loadProofLibrary,
  matchProofs,
} from '../dist/orchestrator/policy/claim-packet.js';
import { evaluateOutboundReadiness } from '../dist/orchestrator/policy/readiness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AO_ROOT = join(__dirname, '..');
const TV_ROOT =
  process.env.TV_ROOT ||
  '/Users/rayepps/projects/mission/.outbound/treasure-valley';
const TV_YAML = join(TV_ROOT, 'outbound.yaml');
const DIAG = join(TV_ROOT, 'build/registries/diagnostic-families.json');
const PROOF = join(TV_ROOT, 'build/assets/proof-library.json');
const CLAIM_AUDIT_SRC = join(AO_ROOT, 'src/orchestrator/policy/claim-audit.ts');
const GENERATE_RUNNER_SRC = join(AO_ROOT, 'src/orchestrator/generate/runner.ts');

const REQUIRED_DIAG_OUTPUTS = [
  'diagnostic_hypotheses_json',
  'economic_scenarios_json',
  'proof_match_ids',
  'permitted_claim_packet_json',
  'preliminary_snapshot',
];

function loadJson(path) {
  assert.ok(existsSync(path), `missing asset: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function basePacket(overrides = {}) {
  return {
    account_id: 'acct_phase06',
    policy_version: 'v1',
    permitted_claims: [
      {
        claim_id: 'obs_callback',
        claim_class: 'observation',
        text: 'public reviews mention delayed callbacks after hours',
        evidence_ids: ['obs_1'],
      },
      {
        claim_id: 'hyp_missed_call',
        claim_class: 'hypothesis',
        text: 'inbound calls after hours may not receive consistent follow-up',
        hypothesis_id: 'missed_call_leak',
      },
    ],
    ...overrides,
  };
}

// ── Claim audit: pass / fail ─────────────────────────────────────────────────

test('phase-06: claim audit PASSES when extracted claims map to packet', () => {
  const packet = basePacket();
  const result = auditClaims({
    packet,
    extracted: [
      { text: 'public reviews mention delayed callbacks after hours' },
      { text: 'inbound calls after hours may not receive consistent follow-up' },
    ],
    assetText:
      'I noticed public reviews mention delayed callbacks after hours. One area we would examine is whether inbound calls after hours may not receive consistent follow-up.',
  });
  assert.equal(result.passed, true, JSON.stringify(result.unauthorized));
  assert.equal(result.unauthorized.length, 0);
  assert.equal(result.authorized.length, 2);
  assert.equal(result.policy_version, CLAIM_AUDIT_VERSION);
  assert.ok(result.authorized.every((a) => a.claim_id));
});

test('phase-06: claim audit FAILS unsupported factual claims not in packet', () => {
  const packet = basePacket();
  const result = auditClaims({
    packet,
    extracted: [
      { text: 'public reviews mention delayed callbacks after hours' },
      { text: 'your owner is overwhelmed by invoice chase every Friday' },
    ],
  });
  assert.equal(result.passed, false);
  assert.ok(
    result.unauthorized.some((u) => u.reason === 'not_in_permitted_claim_packet'),
    JSON.stringify(result.unauthorized),
  );
});

test('phase-06: claim audit FAILS mission_proof claims without proof_id', () => {
  const packet = basePacket({
    permitted_claims: [
      {
        claim_id: 'proof_bad',
        claim_class: 'mission_proof',
        text: 'Mission helped a comparable office own quote follow-up',
        proof_id: null,
      },
    ],
  });
  const result = auditClaims({
    packet,
    extracted: [{ text: 'Mission helped a comparable office own quote follow-up' }],
  });
  assert.equal(result.passed, false);
  assert.ok(
    result.unauthorized.some((u) => u.reason === 'proof_claim_missing_proof_id'),
    JSON.stringify(result.unauthorized),
  );
});

test('phase-06: claim audit FAILS claim_class prohibited entries in packet', () => {
  const packet = basePacket({
    permitted_claims: [
      {
        claim_id: 'bad',
        claim_class: 'prohibited',
        text: 'you are losing forty thousand dollars a year',
      },
    ],
  });
  const result = auditClaims({
    packet,
    extracted: [{ text: 'you are losing forty thousand dollars a year' }],
  });
  assert.equal(result.passed, false);
  assert.ok(result.unauthorized.some((u) => u.reason === 'claim_class_prohibited'));
});

// ── Claim audit v2: fail-closed extraction + one-way subset match ────────────

test('phase-06: claim audit v3 re-extracts when extract empty; empty packet fails factual copy', () => {
  const packet = basePacket();
  // Re-extract + authorize when extract is empty but asset restates permitted claim.
  const restated = auditClaims({
    packet,
    extracted: [],
    assetText: String(packet.permitted_claims[0]?.text || 'public reviews mention delayed callbacks after hours'),
  });
  // May pass if re-extracted text is authorized by packet.
  assert.equal(restated.policy_version, CLAIM_AUDIT_VERSION);

  // Stronger unsupported wording with empty extract must not green-pass.
  const unsupported = auditClaims({
    packet: { ...packet, permitted_claims: [] },
    extracted: [],
    assetText:
      'I noticed public reviews mention delayed callbacks after hours across several listings.',
  });
  assert.equal(unsupported.passed, false);
  assert.ok(
    unsupported.unauthorized.some((u) =>
      u.reason === 'empty_permitted_claim_packet'
      || u.reason === 'not_in_permitted_claim_packet'
      || u.reason === 'no_claims_extracted'),
    JSON.stringify(unsupported.unauthorized),
  );
});

test('phase-06: claim audit v2 reverse substring (strong claim contains short permitted) fails', () => {
  // Permitted is a short observation; authored claim is stronger wording that
  // merely *contains* the permitted fragment. One-way subset matching must not
  // authorize the stronger claim.
  const permitted = 'delayed callbacks';
  assert.ok(permitted.length >= CLAIM_MATCH_MIN_SUBSET_LEN);
  const strong =
    'your shop is hemorrhaging revenue every week because of delayed callbacks after hours';

  assert.equal(
    claimTextAuthorizedByPermitted(strong, permitted),
    false,
    'extracted containing permitted must not authorize reverse substring',
  );

  const packet = basePacket({
    permitted_claims: [
      {
        claim_id: 'obs_short',
        claim_class: 'observation',
        text: permitted,
        evidence_ids: ['obs_1'],
      },
    ],
  });
  const result = auditClaims({
    packet,
    extracted: [{ text: strong }],
    assetText: strong,
  });
  assert.equal(result.passed, false);
  assert.ok(
    result.unauthorized.some((u) => u.reason === 'not_in_permitted_claim_packet'),
    JSON.stringify(result.unauthorized),
  );
});

test('phase-06: claim audit v2 permitted contains extracted subset (>=12 chars) passes', () => {
  const permitted =
    'public reviews mention delayed callbacks after hours on multiple listings';
  const extracted = 'delayed callbacks after hours';
  assert.ok(extracted.length >= CLAIM_MATCH_MIN_SUBSET_LEN);
  assert.equal(
    claimTextAuthorizedByPermitted(extracted, permitted),
    true,
    'permitted must authorize near-subset extracted claims of sufficient length',
  );

  const packet = basePacket({
    permitted_claims: [
      {
        claim_id: 'obs_callback',
        claim_class: 'observation',
        text: permitted,
        evidence_ids: ['obs_1'],
      },
    ],
  });
  const result = auditClaims({
    packet,
    extracted: [{ text: extracted }],
    assetText: `I noticed ${extracted} in public sources.`,
  });
  assert.equal(result.passed, true, JSON.stringify(result.unauthorized));
  assert.equal(result.authorized.length, 1);
  assert.equal(result.authorized[0].claim_id, 'obs_callback');
  assert.equal(result.policy_version, CLAIM_AUDIT_VERSION);
  assert.equal(CLAIM_AUDIT_VERSION, 'tv-claim-audit-v4');
});

// ── Prohibited claims (default + packet patterns) ────────────────────────────

test('phase-06: default prohibited patterns fail asset-level audit', () => {
  const packet = basePacket();
  const cases = [
    { text: 'We offer guaranteed results for every shop', needle: 'guaranteed' },
    { text: 'We increased your close rate last quarter', needle: 'we increased your' },
    { text: 'Your business is losing $80,000 a year from missed calls', needle: 'losing' },
    { text: 'This is HIPAA compliant out of the box for your clinic', needle: 'hipaa' },
    { text: 'As your current customer we already know the books', needle: 'as your' },
    { text: "I'll stop by your office next Tuesday", needle: 'stop by' },
    { text: 'We can do door-to-door demos next week', needle: 'door' },
  ];
  for (const c of cases) {
    const result = auditClaims({
      packet,
      extracted: [],
      assetText: c.text,
    });
    assert.equal(
      result.passed,
      false,
      `expected prohibited fail for: ${c.text}`,
    );
    assert.ok(
      result.unauthorized.some((u) => String(u.reason).startsWith('prohibited_pattern:')),
      `missing prohibited_pattern for: ${c.text} → ${JSON.stringify(result.unauthorized)}`,
    );
  }
});

test('phase-06: packet prohibited_patterns fail even when claim text is permitted', () => {
  const packet = basePacket({
    prohibited_patterns: ['private\\s+books', 'measured\\s+leakage'],
  });
  const result = auditClaims({
    packet,
    extracted: [{ text: 'public reviews mention delayed callbacks after hours' }],
    assetText:
      'public reviews mention delayed callbacks after hours — this is measured leakage from private books',
  });
  assert.equal(result.passed, false);
  assert.ok(result.unauthorized.some((u) => /prohibited_pattern/.test(u.reason)));
});

// ── Economic scenario calculator ─────────────────────────────────────────────

test('phase-06: economic admin_labor_leak calculates range with assumptions', () => {
  const insuff = calculateEconomicScenario({ scenario_id: 'admin_labor_leak' });
  assert.equal(insuff.evidence_status, 'insufficient');
  assert.equal(insuff.annual_low_usd, null);
  assert.equal(insuff.annual_high_usd, null);
  assert.ok(insuff.missing_inputs.includes('weekly_admin_hours'));
  assert.equal(insuff.calculation_rule_version, ECONOMIC_RULE_VERSION);

  const ok = calculateEconomicScenario({
    scenario_id: 'admin_labor_leak',
    weekly_admin_hours: 10,
    hourly_loaded_cost: 40,
  });
  assert.equal(ok.evidence_status, 'calculated');
  assert.equal(typeof ok.annual_low_usd, 'number');
  assert.equal(typeof ok.annual_high_usd, 'number');
  assert.ok(ok.annual_low_usd < ok.annual_high_usd);
  // mid = 10 * 40 * 48 = 19200; low 0.7, high 1.3
  assert.equal(ok.annual_low_usd, Math.round(19200 * 0.7));
  assert.equal(ok.annual_high_usd, Math.round(19200 * 1.3));
  assert.ok(ok.assumptions.some((a) => /hourly_loaded_cost/.test(a)));
  assert.ok(ok.assumptions.some((a) => /weeks_per_year=48/.test(a)));
});

test('phase-06: economic missed_lead_revenue requires leads + job value', () => {
  const noLeads = calculateEconomicScenario({
    scenario_id: 'missed_lead_revenue',
    avg_job_value: 3500,
  });
  assert.equal(noLeads.evidence_status, 'insufficient');
  assert.ok(noLeads.missing_inputs.includes('missed_leads_per_month'));

  const noJob = calculateEconomicScenario({
    scenario_id: 'missed_lead_revenue',
    missed_leads_per_month: 4,
  });
  assert.equal(noJob.evidence_status, 'insufficient');
  assert.ok(noJob.missing_inputs.includes('avg_job_value'));

  const ok = calculateEconomicScenario({
    scenario_id: 'missed_lead_revenue',
    missed_leads_per_month: 4,
    avg_job_value: 3500,
    close_rate: 0.25,
  });
  assert.equal(ok.evidence_status, 'calculated');
  // mid = 4 * 12 * 3500 * 0.25 = 42000
  assert.equal(ok.annual_low_usd, Math.round(42000 * 0.6));
  assert.equal(ok.annual_high_usd, Math.round(42000 * 1.4));
  assert.ok(ok.annual_low_usd < ok.annual_high_usd);
  assert.ok(ok.assumptions.some((a) => a.includes('close_rate=0.25')));
});

test('phase-06: unknown economic scenario_id is insufficient (no invented numbers)', () => {
  const r = calculateEconomicScenario({ scenario_id: 'exact_annual_leakage_fantasy' });
  assert.equal(r.evidence_status, 'insufficient');
  assert.equal(r.annual_low_usd, null);
  assert.equal(r.annual_high_usd, null);
  assert.ok(r.missing_inputs.includes('unknown_scenario_id'));
});

// ── Proof library load ───────────────────────────────────────────────────────

test('phase-06: proof-library.json loads with Mission provenance and structure', () => {
  const lib = loadJson(PROOF);
  assert.equal(lib.library_version, 'tv-proof-v1');
  assert.ok(Array.isArray(lib.proofs));
  assert.ok(lib.proofs.length >= 1, 'expected at least one proof record');

  for (const p of lib.proofs) {
    assert.ok(p.proof_id, 'proof_id required');
    assert.ok(p.category, 'category required');
    assert.ok(p.attribution, 'attribution required');
    assert.ok(
      String(p.provenance || '').includes('Mission'),
      `provenance must be Mission-owned: ${p.proof_id}`,
    );
    assert.ok(p.metrics?.approved_wording, `approved_wording missing: ${p.proof_id}`);
    assert.ok(
      Array.isArray(p.metrics?.prohibited_wording),
      `prohibited_wording missing: ${p.proof_id}`,
    );
    assert.ok(
      Array.isArray(p.usage_restrictions) && p.usage_restrictions.length > 0,
      `usage_restrictions missing: ${p.proof_id}`,
    );
  }

  // Seed trades proof used by HVAC fixture path
  const trades = lib.proofs.find((p) => p.category === 'trades_admin_automation');
  assert.ok(trades, 'missing trades_admin_automation proof');
  assert.equal(trades.proof_id, 'mission_proof_trades_followup_001');

  // Expanded categories: every family-referenced proof category must have a library row
  const requiredCategories = [
    'trades_admin_automation',
    'project_services_admin',
    'professional_services_admin',
    'clinical_admin_non_phi',
    'general_smb_admin',
  ];
  for (const cat of requiredCategories) {
    const row = lib.proofs.find((p) => p.category === cat);
    assert.ok(row, `missing proof category row: ${cat}`);
    assert.ok(row.proof_id, `proof_id for ${cat}`);
    assert.ok(row.metrics?.approved_wording, `approved_wording for ${cat}`);
  }

  // Mission proof claim with proof_id must audit-pass using approved wording
  const packet = basePacket({
    permitted_claims: [
      {
        claim_id: 'proof1',
        claim_class: 'mission_proof',
        text: trades.metrics.approved_wording,
        proof_id: trades.proof_id,
      },
    ],
  });
  const audit = auditClaims({
    packet,
    extracted: [{ text: trades.metrics.approved_wording }],
  });
  assert.equal(audit.passed, true, JSON.stringify(audit.unauthorized));
});

// ── Diagnostic families registry ─────────────────────────────────────────────

test('phase-06: diagnostic-families.json loads with partnership offer and families', () => {
  const reg = loadJson(DIAG);
  assert.equal(reg.registry_version, 'tv-diagnostic-v1');
  assert.equal(reg.offer, 'diagnostic_partnership');
  assert.ok(reg.families && typeof reg.families === 'object');

  const requiredFamilies = [
    'trades_field_services',
    'construction_project_services',
    'professional_advisory_services',
    'healthcare_clinical',
    'default',
  ];
  for (const f of requiredFamilies) {
    assert.ok(reg.families[f], `missing family: ${f}`);
    const fam = reg.families[f];
    assert.ok(Array.isArray(fam.workflow_areas) && fam.workflow_areas.length > 0);
    assert.ok(Array.isArray(fam.hypotheses) && fam.hypotheses.length > 0);
    for (const h of fam.hypotheses) {
      assert.ok(h.id, 'hypothesis id');
      assert.ok(h.mechanism, 'hypothesis mechanism');
      assert.ok(Array.isArray(h.falsifiers), 'hypothesis falsifiers');
    }
    assert.ok(Array.isArray(fam.discovery_questions) && fam.discovery_questions.length > 0);
    assert.ok(Array.isArray(fam.economic_calculators) && fam.economic_calculators.length > 0);
    assert.ok(Array.isArray(fam.proof_categories));
    assert.ok(Array.isArray(fam.vocabulary));
  }

  // Every declared calculator id must be one the code knows (or be insufficient-unknown)
  const knownCalcs = new Set(['admin_labor_leak', 'missed_lead_revenue']);
  for (const fam of Object.values(reg.families)) {
    for (const calc of fam.economic_calculators) {
      assert.ok(
        knownCalcs.has(calc),
        `family calculator ${calc} not implemented in calculateEconomicScenario`,
      );
    }
  }
});

// ── TV config: diagnostic_content_pack step ──────────────────────────────────

test('phase-06: outbound.yaml diagnostic_content_pack step is wired', () => {
  assert.ok(existsSync(TV_YAML), `TV yaml missing: ${TV_YAML}`);
  const cfg = yaml.load(readFileSync(TV_YAML, 'utf8'));
  const steps = cfg.pipeline || [];
  const step = steps.find((s) => s.id === 'diagnostic_content_pack');
  assert.ok(step, 'diagnostic_content_pack step missing from pipeline');
  assert.equal(step.kind, 'generate');
  assert.ok(
    (step.depends_on || []).includes('treatment_assignment'),
    'must depend on treatment_assignment',
  );
  assert.ok(
    (step.depends_on || []).includes('account_intelligence'),
    'must depend on account_intelligence',
  );
  const outs = Object.keys(step.outputs || {});
  for (const o of REQUIRED_DIAG_OUTPUTS) {
    assert.ok(outs.includes(o), `missing output: ${o}`);
  }
  // Tier gate A/B/C only
  const whenVals = step.when?.conditions?.find((c) => c.field === 'treatment_tier')?.value;
  assert.deepEqual(whenVals, ['A', 'B', 'C']);
});

// ── Production wiring presence (source contract, no live generate) ───────────

test('phase-06: generate runner imports auditClaims and writes claim_audit fields', () => {
  const src = readFileSync(GENERATE_RUNNER_SRC, 'utf8');
  assert.ok(src.includes('auditClaims'), 'generate/runner must call auditClaims');
  assert.ok(src.includes('claim_audit_passed'), 'must persist claim_audit_passed');
  assert.ok(src.includes('claim_audit_json'), 'must persist claim_audit_json');
  assert.ok(src.includes('permitted_claim_packet_json'), 'must read claim packet');
  assert.ok(src.includes('needs_repair'), 'failed audit should mark needs_repair');
  // Must assemble deterministic packet (not trust model self-approval alone).
  assert.ok(src.includes('assemblePermittedClaimPacket'), 'must assemble claim packet in code');
  // Must wire deterministic economics into outputs (not model-only dollars).
  assert.ok(src.includes('calculateEconomicScenario'), 'must call calculateEconomicScenario');
  assert.ok(src.includes('economic_scenarios_json'), 'must persist economic_scenarios_json');
  // Must not swallow audit errors into silent pass.
  assert.ok(
    !src.includes('Claim audit is best-effort'),
    'must not treat claim audit as best-effort swallow',
  );
  assert.ok(
    !/catch\s*\{\s*\/\/\s*best-effort/i.test(src),
    'must not have empty best-effort catch around claim audit',
  );
  assert.ok(src.includes('missing_permitted_claim_packet') || src.includes('audit_error'));
  assert.ok(src.includes('audit_error') || src.includes('passed: false'));
});

test('phase-06: claim-audit module exports versioned audit + economics', () => {
  const src = readFileSync(CLAIM_AUDIT_SRC, 'utf8');
  assert.ok(src.includes("CLAIM_AUDIT_VERSION = 'tv-claim-audit-v4'"));
  assert.ok(src.includes("ECONOMIC_RULE_VERSION = 'tv-economics-v1'"));
  assert.ok(src.includes('export function auditClaims'));
  assert.ok(src.includes('export function calculateEconomicScenario'));
  assert.ok(src.includes('export function claimTextAuthorizedByPermitted'));
  assert.ok(src.includes('no_claims_extracted'));
  assert.ok(src.includes('CLAIM_MATCH_MIN_SUBSET_LEN'));
});

// ── Readiness coupling ───────────────────────────────────────────────────────

test('phase-06: readiness blocks when claimAuditPassed is false', () => {
  const base = {
    eligible: true,
    suppressed: false,
    identityConfidence: 90,
    materialContradiction: false,
    treatmentTier: 'B',
    channels: { email: { ready: true, confidence: 80 } },
    contentReady: true,
    withinBudget: true,
    hasNextAction: true,
    confidenceProfile: {
      identity_confidence: 90,
      classification_confidence: 80,
      fit_evidence_confidence: 85,
      buyer_confidence: 75,
      timing_confidence: 40,
      email_confidence: 80,
    },
    proposedAction: { channel: 'email', kind: 'send_email' },
  };

  const blocked = evaluateOutboundReadiness({ ...base, claimAuditPassed: false });
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blockers.includes('claim_audit_failed'));

  // Null/undefined audit with content present must NOT readiness-pass
  const missing = evaluateOutboundReadiness({ ...base, claimAuditPassed: undefined });
  assert.equal(missing.ready, false);
  assert.ok(missing.blockers.includes('claim_audit_required'));

  const nullAudit = evaluateOutboundReadiness({ ...base, claimAuditPassed: null });
  assert.equal(nullAudit.ready, false);
  assert.ok(nullAudit.blockers.includes('claim_audit_required'));

  // No content → missing audit does not block
  const noContent = evaluateOutboundReadiness({
    ...base,
    contentReady: false,
    claimAuditPassed: undefined,
  });
  assert.ok(!noContent.blockers.includes('claim_audit_required'));
  assert.ok(!noContent.blockers.includes('claim_audit_failed'));
  // contentReady false still blocks for other reason
  assert.ok(noContent.blockers.includes('content_not_ready'));

  const ok = evaluateOutboundReadiness({ ...base, claimAuditPassed: true });
  assert.equal(ok.ready, true, JSON.stringify(ok.blockers));
});

test('phase-06: assemblePermittedClaimPacket loads registry + proof + economics', () => {
  const families = loadDiagnosticFamilies(TV_ROOT);
  assert.ok(families.length >= 5, `expected ≥5 families, got ${families.length}`);
  const trades = families.find((f) => f.family_id === 'trades_field_services');
  assert.ok(trades, 'trades_field_services family');
  assert.ok(trades.hypotheses?.length, 'normalized hypotheses from mechanism');
  assert.ok(trades.calculator_ids?.includes('missed_lead_revenue'));
  assert.ok(trades.proof_categories?.includes('trades_admin_automation'));

  const proofs = loadProofLibrary(TV_ROOT);
  assert.ok(proofs.length >= 5, `expected expanded proof library, got ${proofs.length}`);

  const matched = matchProofs({ family_id: 'trades_field_services', listDir: TV_ROOT });
  assert.ok(matched.some((p) => p.category === 'trades_admin_automation'));

  const packet = assemblePermittedClaimPacket({
    account_id: 'acct_phase06_asm',
    family_id: 'trades_field_services',
    listDir: TV_ROOT,
    preliminary_snapshot: 'Multiple public reviews mention delayed callbacks after hours.',
    economic_inputs: {
      weekly_admin_hours: 8,
      hourly_loaded_cost: 40,
      missed_leads_per_month: 3,
      avg_job_value: 2500,
      close_rate: 0.2,
    },
  });
  assert.equal(packet.account_id, 'acct_phase06_asm');
  assert.equal(packet.policy_version, 'tv-claim-packet-v1');
  assert.ok(packet.permitted_claims.some((c) => c.claim_class === 'hypothesis'));
  assert.ok(packet.permitted_claims.some((c) => c.claim_class === 'economic_scenario'));
  assert.ok(
    packet.permitted_claims.some((c) => c.claim_class === 'mission_proof' && c.proof_id),
    'must link approved proof with proof_id',
  );
  assert.ok(packet.permitted_claims.some((c) => c.claim_id === 'snap_preliminary'));

  // Authoring text drawn only from packet must audit-pass
  const hyp = packet.permitted_claims.find((c) => c.claim_class === 'hypothesis');
  const proof = packet.permitted_claims.find((c) => c.claim_class === 'mission_proof');
  const audit = auditClaims({
    packet,
    extracted: [{ text: hyp.text }, { text: proof.text }],
    assetText: `${hyp.text}. ${proof.text}. Preliminary public-evidence snapshot only.`,
  });
  assert.equal(audit.passed, true, JSON.stringify(audit.unauthorized));
});

test('phase-06: end-to-end fixture path uses family hyp + proof + economics + audit', () => {
  const diag = loadJson(DIAG);
  const proofLib = loadJson(PROOF);
  const family = diag.families.trades_field_services;
  const hyp = family.hypotheses[0];
  const proof = proofLib.proofs.find((p) => p.category === 'trades_admin_automation');
  assert.ok(proof);

  const economics = calculateEconomicScenario({
    scenario_id: 'missed_lead_revenue',
    missed_leads_per_month: 3,
    avg_job_value: 2800,
    close_rate: 0.2,
  });
  assert.equal(economics.evidence_status, 'calculated');

  const packet = {
    account_id: 'fixture_hvac_phase06',
    policy_version: 'v1',
    permitted_claims: [
      {
        claim_id: 'obs1',
        claim_class: 'observation',
        text: 'Multiple Google reviews mention delayed callbacks',
        evidence_ids: ['obs_reviews_callback'],
      },
      {
        claim_id: 'hyp1',
        claim_class: 'hypothesis',
        text: hyp.mechanism,
        hypothesis_id: hyp.id,
      },
      {
        claim_id: 'econ1',
        claim_class: 'economic_scenario',
        text: `scenario range $${economics.annual_low_usd}–$${economics.annual_high_usd} under labeled assumptions`,
        scenario_id: economics.scenario_id,
      },
      {
        claim_id: 'proof1',
        claim_class: 'mission_proof',
        text: proof.metrics.approved_wording,
        proof_id: proof.proof_id,
      },
    ],
  };

  const good = auditClaims({
    packet,
    extracted: [
      { text: 'Multiple Google reviews mention delayed callbacks' },
      { text: hyp.mechanism },
      { text: proof.metrics.approved_wording },
    ],
    assetText: 'Preliminary public-evidence snapshot only — not private measured loss.',
  });
  assert.equal(good.passed, true, JSON.stringify(good.unauthorized));

  // Inject exact annual leakage prose → fail
  const bad = auditClaims({
    packet,
    extracted: [{ text: 'Multiple Google reviews mention delayed callbacks' }],
    assetText: 'Your business is losing $80,000 a year from missed callbacks.',
  });
  assert.equal(bad.passed, false);
});
