/**
 * Enrichment hold → repair next_action, buyer affiliation fail-closed, plan depth order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  applyOutboundPolicy,
  planEnrichmentRepair,
  collectBuyerResolutionHoldReasons,
  resolveBuyerAffiliationFromRecord,
  evaluateOutboundReadiness,
  evaluateGoldenTicket,
  assignTreatmentAndMail,
  WORK_STATES,
  NON_OUTBOUND_ACTION_TYPES,
} = await import('../dist/orchestrator/policy/index.js');

test('WORK_STATES / NON_OUTBOUND include enrichment_repair', () => {
  assert.ok(WORK_STATES.includes('enrichment_repair'));
  assert.ok(NON_OUTBOUND_ACTION_TYPES.has('enrichment_repair'));
});

test('planEnrichmentRepair: foundational → candidate_tier → targeted order', () => {
  const plan = planEnrichmentRepair({
    record: {
      _row_id: 'r1',
      // no identity / fit / buyer
    },
    hold_reasons: ['unscored_fit'],
    treatment_tier: 'enrichment_hold',
    candidate_tier: 'hold',
  });
  assert.equal(plan.next_depth, 'foundational');
  assert.ok(plan.steps.length > 0);
  const depths = plan.steps.map((s) => s.depth);
  // Never jump: first targeted index must be after last foundational/candidate if any targeted
  let maxFound = -1;
  let maxCand = -1;
  let firstTargeted = Infinity;
  depths.forEach((d, i) => {
    if (d === 'foundational') maxFound = i;
    if (d === 'candidate_tier') maxCand = i;
    if (d === 'targeted' && firstTargeted === Infinity) firstTargeted = i;
  });
  if (firstTargeted !== Infinity) {
    assert.ok(firstTargeted > maxFound, 'targeted must follow foundational');
    assert.ok(firstTargeted > maxCand || maxCand < 0, 'targeted must follow candidate_tier');
  }
  assert.ok(plan.steps.some((s) => s.field === 'company_resolution' || s.field === 'identity_confidence'));
  assert.ok(plan.steps.some((s) => s.depth === 'candidate_tier'));
  assert.ok(plan.steps.some((s) => s.field === 'named_buyer_status' || s.field === 'observed_buyer_name'));
});

test('applyOutboundPolicy: enrichment_hold → next_action enrichment_repair + hold reasons', () => {
  const out = applyOutboundPolicy({
    record: {
      _row_id: 'hold_repair_1',
      is_a_business: true,
      company_resolution: 'resolved',
      fit_score: 88,
      fit_evidence_confidence: 25,
      identity_confidence: 90,
    },
  });
  assert.equal(out.treatment_tier, 'enrichment_hold');
  assert.equal(out.next_action?.action_type, 'enrichment_repair');
  assert.equal(out.next_action?.work_state, 'enrichment_repair');
  assert.equal(out.patch.work_state, 'enrichment_repair');
  const reasons = JSON.parse(String(out.patch.enrichment_hold_reasons_json || '[]'));
  assert.ok(Array.isArray(reasons) && reasons.length > 0, 'hold reasons persisted');
  assert.ok(
    reasons.some((r) => String(r).includes('enrichment_hold') || String(r).includes('insufficient') || String(r).includes('treatment')),
    `expected hold reason codes, got ${JSON.stringify(reasons)}`,
  );
  assert.ok(out.patch.enrichment_repair_plan_json);
  const plan = JSON.parse(String(out.patch.enrichment_repair_plan_json));
  assert.ok(plan.steps?.length > 0);
  assert.ok(['foundational', 'candidate_tier', 'targeted'].includes(plan.next_depth));
  assert.equal(out.enrichment_repair_plan?.account_id, 'hold_repair_1');
});

test('applyOutboundPolicy: unresolved buyer affiliation holds (not invent confirmed)', () => {
  const out = applyOutboundPolicy({
    record: {
      _row_id: 'aff_unres',
      is_a_business: true,
      company_resolution: 'resolved',
      fit_score: 90,
      fit_evidence_confidence: 90,
      identity_confidence: 90,
      classification_confidence: 90,
      buyer_confidence: 80,
      named_buyer_status: 'confirmed',
      observed_buyer_name: 'Pat Owner',
      buyer_affiliation_status: 'unresolved',
      buying_center_role: 'owner',
    },
  });
  assert.equal(out.treatment_tier, 'enrichment_hold');
  assert.equal(out.next_action?.action_type, 'enrichment_repair');
  const reasons = JSON.parse(String(out.patch.enrichment_hold_reasons_json || '[]'));
  assert.ok(
    reasons.includes('buyer_affiliation_unresolved')
    || reasons.some((r) => String(r).includes('affiliation')),
    JSON.stringify(reasons),
  );
  // Never invent confirmed affiliation in patch when unresolved was supplied
  assert.equal(out.patch.buyer_affiliation_status, 'unresolved');
});

test('applyOutboundPolicy: tier A missing named buyer → hold + repair', () => {
  const out = applyOutboundPolicy({
    record: {
      _row_id: 'tier_a_no_buyer',
      is_a_business: true,
      company_resolution: 'resolved',
      fit_score: 90,
      fit_evidence_confidence: 90,
      identity_confidence: 90,
      classification_confidence: 90,
      buyer_confidence: 80,
      // omit named buyer + affiliation
    },
  });
  assert.equal(out.treatment_tier, 'enrichment_hold');
  assert.equal(out.next_action?.action_type, 'enrichment_repair');
  const reasons = JSON.parse(String(out.patch.enrichment_hold_reasons_json || '[]'));
  assert.ok(
    reasons.some((r) => String(r).includes('named_buyer')),
    JSON.stringify(reasons),
  );
});

test('readiness: tier A requires named buyer + affiliation; unresolved blocks any tier', () => {
  const base = {
    eligible: true,
    suppressed: false,
    identityConfidence: 90,
    materialContradiction: false,
    channels: { email: { ready: true, confidence: 80 } },
    contentReady: true,
    claimAuditPassed: true,
    withinBudget: true,
    hasNextAction: true,
  };
  const missingBuyer = evaluateOutboundReadiness({
    ...base,
    treatmentTier: 'A',
  });
  assert.equal(missingBuyer.ready, false);
  assert.ok(missingBuyer.blockers.includes('named_buyer_status_missing'));
  assert.ok(missingBuyer.blockers.includes('named_buyer_name_missing'));
  assert.ok(missingBuyer.blockers.includes('buyer_affiliation_status_missing'));
  assert.ok(missingBuyer.blockers.includes('buying_center_role_missing'));

  const unresolved = evaluateOutboundReadiness({
    ...base,
    treatmentTier: 'B',
    namedBuyerStatus: 'confirmed',
    namedBuyerName: 'Pat',
    buyerAffiliationStatus: 'unresolved',
    buyingCenterRole: 'gm',
  });
  assert.equal(unresolved.ready, false);
  assert.ok(unresolved.blockers.includes('buyer_affiliation_unresolved'));

  const okA = evaluateOutboundReadiness({
    ...base,
    treatmentTier: 'A',
    namedBuyerStatus: 'confirmed',
    namedBuyerName: 'Pat',
    buyerAffiliationStatus: 'confirmed',
    buyingCenterRole: 'owner',
  });
  assert.equal(okA.ready, true, JSON.stringify(okA.blockers));
});

test('GT: missing / unresolved affiliation fails closed', () => {
  const base = {
    treatmentTier: 'A',
    fitScore: 90,
    fitEvidenceConfidence: 90,
    identityConfidence: 90,
    classificationConfidence: 90,
    buyerConfidence: 80,
    mailConfidence: 90,
    timingScore: 75,
    mailAddressReady: true,
    assetReady: true,
    namedBuyerStatus: 'confirmed',
    namedBuyerName: 'Alex',
    buyerAffiliationStatus: 'confirmed',
    buyingCenterRole: 'owner',
    localBuyingAuthority: 'confirmed',
    cohortCapacityOk: true,
  };
  assert.equal(evaluateGoldenTicket(base).eligible, true);

  const missing = evaluateGoldenTicket({ ...base, buyerAffiliationStatus: null });
  assert.equal(missing.eligible, false);
  assert.ok(missing.withheld.includes('buyer_affiliation_status_missing'));

  const unres = evaluateGoldenTicket({ ...base, buyerAffiliationStatus: 'unresolved' });
  assert.equal(unres.eligible, false);
  assert.ok(unres.withheld.includes('buyer_affiliation_unresolved'));

  const noRole = evaluateGoldenTicket({ ...base, buyingCenterRole: null });
  assert.equal(noRole.eligible, false);
  assert.ok(noRole.withheld.includes('buying_center_role_missing'));
});

test('resolveBuyerAffiliationFromRecord: never invents confirmed from blank', () => {
  const empty = resolveBuyerAffiliationFromRecord({});
  assert.equal(empty.status, null);
  assert.equal(empty.role, null);
  const reasons = collectBuyerResolutionHoldReasons({
    treatmentTier: 'A',
    namedBuyerStatus: null,
    namedBuyerName: null,
    affiliation: empty,
  });
  assert.ok(reasons.includes('named_buyer_status_missing'));
  assert.ok(reasons.includes('buyer_affiliation_status_missing'));
});

test('field_evidence_json carries confidence + source_ids from durable observations', () => {
  const out = applyOutboundPolicy({
    record: {
      _row_id: 'fev1',
      is_a_business: true,
      company_resolution: 'resolved',
      business_name: 'Acme HVAC',
      fit_score: 40,
      fit_evidence_confidence: 70,
      identity_confidence: 85,
      observations_json: JSON.stringify({
        account_id: 'fev1',
        contract_version: 'tv-evidence-v1',
        generated_at: '2026-08-01T00:00:00Z',
        snapshots: [],
        observations: [
          {
            evidence_id: 'obs_name_1',
            predicate: 'business_name',
            value: 'Acme HVAC',
            support_status: 'literal_support',
            source_id: 'snap_site_1',
            observed_at: '2026-08-01T00:00:00Z',
            provisional: false,
          },
        ],
        contradictions: [],
      }),
    },
  });
  const fe = JSON.parse(String(out.patch.field_evidence_json || '{}'));
  assert.equal(fe.business_name?.value, 'Acme HVAC');
  assert.equal(fe.business_name?.provisional, false);
  assert.ok(typeof fe.business_name?.confidence === 'number' && fe.business_name.confidence >= 90);
  assert.ok(Array.isArray(fe.business_name?.source_ids));
  assert.ok(fe.business_name.source_ids.includes('snap_site_1'));
});

test('assignTreatmentAndMail: GT still requires named buyer (matrix regression)', () => {
  const g = assignTreatmentAndMail({
    fitScore: 90,
    fitEvidenceConfidence: 90,
    identityConfidence: 90,
    classificationConfidence: 90,
    buyerConfidence: 80,
    mailConfidence: 90,
    timingScore: 75,
    mailAddressReady: true,
    // no named buyer
    goldenTicketGates: { assetReady: true, mailReady: true, cohortCapacityOk: true },
    cohortCapacityOk: true,
    cumulativeEnrichmentCostUsd: 1,
  });
  assert.equal(g.treatment_tier, 'A');
  assert.notEqual(g.mail_treatment, 'golden_ticket');
  assert.ok(
    g.mail_withheld_reasons.some((w) => w.includes('named_buyer')),
  );
});
