/**
 * Phase 4 — autonomous classification and enrichment (isolated validation).
 *
 * Proves, without live Monid / model spend:
 * 1. vertical-taxonomy.json loads and matches the controlled registry contract
 * 2. treatment thin-evidence path assigns enrichment_hold and blocks readiness
 * 3. outbound.yaml account_intelligence generate step exists with required outputs
 * 4. treatment_assignment enrich + enrichment_hold route are wired in config
 * 5. Monid is present as static config for scrape (no live HTTP)
 *
 * Complete-when (plan Phase 4): eligible account receives attempted classification
 * and contact results for allowed research depth, no unsupported labels, no runtime
 * human research dependency. This suite validates structural + deterministic policy
 * surfaces only; live generate classification is out of scope here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';
import {
  assignTreatmentTier,
  assignTreatmentAndMail,
  enrichmentBudgetRemaining,
} from '../dist/orchestrator/policy/treatment.js';
import { assignCandidateTier } from '../dist/orchestrator/policy/scoring.js';
import { evaluateOutboundReadiness } from '../dist/orchestrator/policy/readiness.js';
import {
  validateTaxonomyLabels,
  isControlledVerticalPair as registryControlledPair,
  loadVerticalTaxonomy,
} from '../dist/orchestrator/policy/taxonomy.js';
import { applyOutboundPolicy } from '../dist/orchestrator/policy/apply-record.js';
import {
  treasureValleyEnrichmentBudget,
  treasureValleyCandidateTier,
  treasureValleyGoldenTicket,
  treasureValleyPostcard,
  treasureValleyTreatmentStrategy,
} from './fixtures/treatment-strategy.mjs';
import { representativePipelineRoot, representativePipelineYaml, representativeTaxonomy } from './fixtures/pipelines/representative.mjs';

const TV_ROOT = representativePipelineRoot;
const TV_YAML = representativePipelineYaml;
const TAXONOMY = representativeTaxonomy;

const REQUIRED_ACCOUNT_INTELLIGENCE_OUTPUTS = [
  'regulatory_context',
  'ownership_type',
  'owner_operated',
  'local_buying_authority',
  'primary_buyer_role',
  'likely_champion_role',
  'size_tier',
  'classification_confidence',
  'classification_evidence',
  'account_classification_json',
];

const EXPECTED_TOP_VERTICALS = [
  'trades_field_services',
  'construction_project_services',
  'automotive_equipment',
  'manufacturing_distribution_logistics',
  'professional_advisory_services',
  'healthcare_clinical',
  'personal_care_wellness',
  'property_real_estate',
  'retail_hospitality_food',
  'education_child_family_services',
  'agriculture_animal_rural_services',
  'technology_communications',
  'other_local_smb',
];

function loadTvConfig() {
  return yaml.load(readFileSync(TV_YAML, 'utf8'));
}

function collectSteps(steps, acc = []) {
  for (const s of steps || []) {
    acc.push(s);
    if (s.steps) collectSteps(s.steps, acc);
  }
  return acc;
}

function isControlledVerticalPair(taxonomy, vertical, subVertical) {
  const entry = taxonomy.verticals?.[vertical];
  if (!entry) return false;
  return Array.isArray(entry.sub_verticals) && entry.sub_verticals.includes(subVertical);
}

// ── Taxonomy load ────────────────────────────────────────────────────────────

test('phase-04: vertical-taxonomy.json loads with version, fallbacks, and seed verticals', () => {
  const raw = readFileSync(TAXONOMY, 'utf8');
  // Must be parseable JSON (registry asset, not prose)
  const taxonomy = JSON.parse(raw);

  assert.equal(taxonomy.taxonomy_version, 'representative-v1');
  assert.equal(taxonomy.fallback_vertical, 'other_local_smb');
  assert.equal(taxonomy.fallback_sub_vertical, 'other_local_smb');
  assert.ok(taxonomy.verticals && typeof taxonomy.verticals === 'object');

  for (const v of EXPECTED_TOP_VERTICALS) {
    assert.ok(taxonomy.verticals[v], `missing top-level vertical: ${v}`);
    assert.ok(
      Array.isArray(taxonomy.verticals[v].sub_verticals) &&
        taxonomy.verticals[v].sub_verticals.length >= 1,
      `vertical ${v} needs sub_verticals`,
    );
  }

  // HVAC fixture path is a controlled pair
  assert.ok(
    isControlledVerticalPair(taxonomy, 'trades_field_services', 'hvac'),
    'trades_field_services/hvac must be controlled',
  );

  // Fallback pair is self-consistent
  assert.ok(
    isControlledVerticalPair(
      taxonomy,
      taxonomy.fallback_vertical,
      taxonomy.fallback_sub_vertical,
    ),
  );

  // Every sub_vertical is a non-empty string identifier (no free-form blanks)
  for (const [vid, entry] of Object.entries(taxonomy.verticals)) {
    for (const sub of entry.sub_verticals) {
      assert.equal(typeof sub, 'string');
      assert.ok(/^[a-z][a-z0-9_]*$/.test(sub), `bad sub_vertical id ${vid}/${sub}`);
    }
  }

  // Unsupported label rejection helper (registry contract used by validate paths)
  assert.equal(isControlledVerticalPair(taxonomy, 'made_up_vertical', 'hvac'), false);
  assert.equal(
    isControlledVerticalPair(taxonomy, 'trades_field_services', 'not_a_real_leaf'),
    false,
  );
});

// ── account_intelligence step contract ───────────────────────────────────────

test('phase-04: vertical_classify and account_intelligence expose their required outputs', () => {
  const cfg = loadTvConfig();
  const all = collectSteps(cfg.pipeline);
  const verticalClassify = all.find((s) => s.id === 'vertical_classify');
  const ai = all.find((s) => s.id === 'account_intelligence');

  assert.ok(verticalClassify, 'vertical_classify step missing from pipeline');
  assert.equal(verticalClassify.kind, 'enrich');
  for (const key of ['vertical', 'sub_vertical']) {
    assert.ok(verticalClassify.outputs?.[key], `missing vertical_classify output: ${key}`);
    assert.ok(verticalClassify.outputs[key].type, `output ${key} needs type`);
  }
  assert.ok(ai, 'account_intelligence step missing from pipeline');
  assert.equal(ai.kind, 'generate');
  assert.ok(ai.model, 'account_intelligence must declare a model');
  assert.ok(Array.isArray(ai.depends_on) && ai.depends_on.length >= 1);

  // Upstream evidence steps must exist (public-evidence path, not human queue)
  for (const dep of ['site_profile', 'decision_makers', 'franchise_profile']) {
    assert.ok(
      ai.depends_on.includes(dep),
      `account_intelligence should depend on ${dep}`,
    );
    assert.ok(
      all.some((s) => s.id === dep),
      `upstream step ${dep} missing`,
    );
  }

  const outputs = ai.outputs || {};
  for (const key of REQUIRED_ACCOUNT_INTELLIGENCE_OUTPUTS) {
    assert.ok(outputs[key], `missing account_intelligence output: ${key}`);
    assert.ok(outputs[key].type, `output ${key} needs type`);
  }

  // Classification confidence is numeric for treatment gates
  assert.equal(outputs.classification_confidence.type, 'number');
  assert.equal(outputs.identity_confidence, undefined);
});

test('phase-04: treatment_assignment enrich + enrichment_hold route are configured', () => {
  const cfg = loadTvConfig();
  const all = collectSteps(cfg.pipeline);

  const ta = all.find((s) => s.id === 'treatment_assignment');
  assert.ok(ta, 'treatment_assignment missing');
  assert.equal(ta.kind, 'enrich');
  assert.equal(ta.action, 'policy_apply');
  assert.ok((ta.depends_on || []).includes('account_intelligence'));
  assert.ok(ta.outputs?.treatment_tier);
  assert.match(String(ta.outputs.treatment_tier.description || ''), /enrichment_hold/);

  const assign = all.find((s) => s.id === 'sequence_assign');
  assert.ok(assign);
  assert.equal(assign.fallback, 'enrichment_hold');

  const hold = all.find((s) => s.id === 'enrichment_hold');
  assert.ok(hold, 'enrichment_hold pipeline missing');
  assert.equal(hold.kind, 'pipeline');
  assert.equal(hold.manual, true);
  assert.deepEqual(hold.steps || [], []);
});

// ── Monid static config (no live call) ───────────────────────────────────────

test('phase-04: Monid scrape is statically configured; suite never calls live Monid', () => {
  const cfg = loadTvConfig();
  const all = collectSteps(cfg.pipeline);
  const monidSteps = all.filter(
    (s) => s.tool?.server === 'monid' || JSON.stringify(s.tool || {}).includes('MONID'),
  );

  assert.ok(monidSteps.length >= 1, 'expected at least one Monid-configured tool step');
  const scrape = monidSteps.find((s) => s.id === 'site_scrape');
  assert.ok(scrape, 'site_scrape Monid step missing');
  assert.equal(scrape.kind, 'enrich');
  assert.equal(scrape.action, 'tool_call');
  assert.equal(scrape.tool.server, 'monid');
  assert.ok(
    (scrape.tool.tools || []).includes('MONID__CONTEXT_DEV__WEB_SCRAPE_MARKDOWN'),
  );

  // Guard: this suite must not invent fake live Monid responses — only config + policy.
  // Presence of static tool name is enough; no network I/O is performed here.
  assert.equal(typeof scrape.tool.tools[0], 'string');
});

// ── Treatment enrichment_hold path ───────────────────────────────────────────

test('phase-04: thin evidence / unscored fit → treatment_tier enrichment_hold', () => {
  // Strong fit, insufficient evidence confidence
  const thin = assignTreatmentTier({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    fitScore: 85,
    fitEvidenceConfidence: 30,
  });
  assert.equal(thin.tier, 'enrichment_hold');
  assert.ok(thin.reasons.some((r) => /insufficient_evidence|unscored/.test(r) || r.includes('fit_evidence_band=below40')));

  // Unscored fit
  const unscored = assignTreatmentTier({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    fitScore: null,
    fitEvidenceConfidence: 90,
  });
  assert.equal(unscored.tier, 'enrichment_hold');

  // Full assignment + mail: hold does not open mail by default
  const full = assignTreatmentAndMail({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    goldenTicket: treasureValleyGoldenTicket,
    postcard: treasureValleyPostcard,
    fitScore: 88,
    fitEvidenceConfidence: 25,
    identityConfidence: 90,
    buyerConfidence: 70,
    mailAddressReady: true,
  });
  assert.equal(full.treatment_tier, 'enrichment_hold');
  assert.equal(full.mail_treatment, 'none');
  assert.equal(full.mail_program_eligible, false);
});

test('phase-04: a pipeline may restrict an enrichment tier from outbound readiness', () => {
  const readiness = evaluateOutboundReadiness({
    eligible: true,
    suppressed: false,
    identityConfidence: 90,
    materialContradiction: false,
    treatmentTier: 'enrichment_hold',
    channels: { email: { ready: true, confidence: 80 } },
    contentReady: true,
    claimAuditPassed: true,
    withinBudget: true,
    hasNextAction: true,
    contactPolicy: { tiers: { enrichment_hold: { permitted_channels: [] } } },
    confidenceProfile: {
      identity_confidence: 90,
      classification_confidence: 40,
      fit_evidence_confidence: 25,
      buyer_confidence: 50,
      timing_confidence: 20,
      email_confidence: 80,
    },
    proposedAction: { channel: 'email', kind: 'send_email' },
  });
  assert.equal(readiness.ready, false);
  assert.ok(
    (readiness.blockers || []).includes('tier_channel_not_permitted'),
    `expected declared tier-channel blocker, got ${JSON.stringify(readiness.blockers)}`,
  );
});

test('phase-04: candidate tier + enrichment ceilings support decision-driven depth', () => {
  assert.equal(assignCandidateTier(90, treasureValleyCandidateTier).candidate_tier, 'A');
  assert.equal(assignCandidateTier(null).candidate_tier, '');

  const holdBudget = enrichmentBudgetRemaining({
    enrichmentBudget: treasureValleyEnrichmentBudget,
    candidateOrTreatment: 'enrichment_hold',
    spentUsd: 0.1,
  });
  assert.equal(holdBudget.withinBudget, true);
  assert.ok(holdBudget.remaining > 0);
});

// ── Controlled fixture label against registry ────────────────────────────────

test('phase-04: representative HVAC fixture uses controlled taxonomy labels only', () => {
  const taxonomy = JSON.parse(readFileSync(TAXONOMY, 'utf8'));
  // Simulated post-classification fields (fixture — not live model output)
  const fixtureClassification = {
    vertical: 'trades_field_services',
    sub_vertical: 'hvac',
    taxonomy_version: taxonomy.taxonomy_version,
    ownership_type: 'independent',
    primary_buyer_role: 'owner_operator',
    size_tier: 'small',
  };

  assert.ok(
    isControlledVerticalPair(
      taxonomy,
      fixtureClassification.vertical,
      fixtureClassification.sub_vertical,
    ),
  );
  assert.equal(fixtureClassification.taxonomy_version, 'representative-v1');

  // No unsupported invented vertical may pass the registry check
  assert.equal(
    isControlledVerticalPair(taxonomy, 'invented_smb_type', 'foo'),
    false,
  );

  // Runtime validator agrees (same registry path)
  const v = validateTaxonomyLabels({
    vertical: fixtureClassification.vertical,
    sub_vertical: fixtureClassification.sub_vertical,
    listDir: TV_ROOT,
  });
  assert.equal(v.ok, true);
  assert.equal(v.fallback_applied, false);
  assert.equal(v.vertical, 'trades_field_services');
  assert.equal(v.sub_vertical, 'hvac');
});

// ── Runtime taxonomy validation (write-time reject / safe fallback) ──────────

test('phase-04: validateTaxonomyLabels rejects unsupported labels with controlled fallbacks', () => {
  const loaded = loadVerticalTaxonomy(TV_ROOT);
  assert.ok(loaded, 'taxonomy must load from TV listDir');

  // Controlled pair accepted
  const good = validateTaxonomyLabels({
    vertical: 'trades_field_services',
    sub_vertical: 'hvac',
    listDir: TV_ROOT,
  });
  assert.equal(good.ok, true);
  assert.equal(good.fallback_applied, false);
  assert.ok(registryControlledPair(good.vertical, good.sub_vertical, loaded));

  // Unsupported top-level → global fallback pair
  const badV = validateTaxonomyLabels({
    vertical: 'invented_smb_type',
    sub_vertical: 'foo',
    listDir: TV_ROOT,
  });
  assert.equal(badV.fallback_applied, true);
  assert.ok(badV.reasons.some((r) => r.includes('unsupported_vertical')));
  assert.equal(badV.vertical, 'other_local_smb');
  assert.equal(badV.sub_vertical, 'other_local_smb');
  assert.ok(registryControlledPair(badV.vertical, badV.sub_vertical, loaded));

  // Known vertical, unknown leaf → vertical's other_* leaf (not global other_local_smb)
  const badSub = validateTaxonomyLabels({
    vertical: 'trades_field_services',
    sub_vertical: 'chimney_service',
    listDir: TV_ROOT,
  });
  assert.equal(badSub.fallback_applied, true);
  assert.ok(badSub.reasons.some((r) => r.includes('unsupported_sub_vertical')));
  assert.equal(badSub.vertical, 'trades_field_services');
  assert.equal(badSub.sub_vertical, 'other_trades_field_services');
  assert.equal(badSub.candidate_sub_vertical, 'chimney_service');
  assert.ok(registryControlledPair(badSub.vertical, badSub.sub_vertical, loaded));
});

test('phase-04: applyOutboundPolicy writes only controlled taxonomy labels', () => {
  // Eligible HVAC with controlled labels survives apply
  const hvac = applyOutboundPolicy({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    listDir: TV_ROOT,
    record: {
      _row_id: 'p4_hvac',
      business_name: 'Boise HVAC Co',
      is_a_business: true,
      vertical: 'trades_field_services',
      sub_vertical: 'hvac',
      fit_score: 88,
      fit_evidence_confidence: 75,
      identity_confidence: 90,
      classification_confidence: 80,
    },
  });
  assert.equal(hvac.patch.vertical, 'trades_field_services');
  assert.equal(hvac.patch.sub_vertical, 'hvac');
  assert.equal(hvac.patch.taxonomy_version, 'representative-v1');
  assert.ok(['A', 'B', 'C', 'D', 'enrichment_hold'].includes(hvac.treatment_tier));

  // Unsupported free-text labels are rewritten at apply — no invented production ids
  const junk = applyOutboundPolicy({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    listDir: TV_ROOT,
    record: {
      _row_id: 'p4_junk',
      business_name: 'Mystery Biz',
      is_a_business: true,
      vertical: 'made_up_vertical',
      sub_vertical: 'not_real_leaf',
      fit_score: 70,
      fit_evidence_confidence: 50,
      identity_confidence: 70,
    },
  });
  assert.equal(junk.patch.vertical, 'other_local_smb');
  assert.equal(junk.patch.sub_vertical, 'other_local_smb');
  assert.equal(junk.patch.taxonomy_fallback_applied, 1);
  assert.ok(junk.patch.taxonomy_validation_json);
  const tv = JSON.parse(String(junk.patch.taxonomy_validation_json));
  assert.equal(tv.fallback_applied, true);
  assert.ok(tv.reasons.some((r) => String(r).includes('unsupported')));
});
