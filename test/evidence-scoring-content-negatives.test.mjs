/**
 * RES-EVIDENCE / RES-SCORING / RES-CONTENT — requirement-level negative tests.
 * Fail closed: each rule refuses the unsafe path.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyOutboundPolicy,
  deriveFitEvidenceConfidence,
} from '../dist/orchestrator/policy/apply-record.js';
import {
  buildEnrichEvidencePatch,
  buildObservationStore,
  extractObservationsFromOutputs,
  isWeakAuthoritySource,
  mergeObservationLists,
  parseStoredObservations,
  resolveFieldPreferringEvidence,
} from '../dist/orchestrator/policy/evidence.js';
import {
  evaluateOutboundReadiness,
} from '../dist/orchestrator/policy/readiness.js';
import {
  claimAuditAssetHash,
  claimAuditAssetHashMismatch,
  claimAuditBlocksExternalSend,
} from '../dist/orchestrator/policy/claim-binding.js';
import { allocateMail } from '../dist/orchestrator/policy/contact-campaign.js';

// ── RES-EVIDENCE ─────────────────────────────────────────────────────────────

test('RES-EVIDENCE: model/fixture/self are weak authority sources', () => {
  assert.equal(isWeakAuthoritySource('model'), true);
  assert.equal(isWeakAuthoritySource('fixture'), true);
  assert.equal(isWeakAuthoritySource('self'), true);
  assert.equal(isWeakAuthoritySource('fixture_account_intelligence'), true);
  assert.equal(isWeakAuthoritySource('model_score'), true);
  assert.equal(isWeakAuthoritySource('firecrawl'), false);
  assert.equal(isWeakAuthoritySource('places'), false);
});

test('RES-EVIDENCE: model/fixture/self observations are provisional (not sole durable authority)', () => {
  const modelObs = extractObservationsFromOutputs({
    record: { _row_id: 'acct_model' },
    outputs: { business_name: 'Invented Co', company_resolution: 'resolved' },
    source_id: 'ret_model_1',
    step_id: 'model_enrich',
    source: 'model',
    provider: 'model',
  });
  assert.ok(modelObs.length >= 1);
  assert.ok(
    modelObs.every((o) => o.provisional === true),
    'model-sourced observations must be provisional',
  );

  const fixtureObs = extractObservationsFromOutputs({
    record: { _row_id: 'acct_fix' },
    outputs: { business_name: 'Fixture HVAC' },
    source_id: 'ret_fix_1',
    step_id: 'fixture_generate',
    source: 'fixture_account_intelligence',
    provider: 'fixture',
  });
  assert.ok(fixtureObs.every((o) => o.provisional === true));

  const toolObs = extractObservationsFromOutputs({
    record: { _row_id: 'acct_tool' },
    outputs: { business_name: 'Real Places Name' },
    source_id: 'ret_places_1',
    step_id: 'places_lookup',
    source: 'GOOGLE_MAPS',
    provider: 'places',
  });
  assert.ok(toolObs.every((o) => o.provisional === false));
});

test('RES-EVIDENCE: policy prefers non-model durable over model-only observations', () => {
  const durablePlaces = {
    evidence_id: 'obs_places_name',
    predicate: 'business_name',
    value: 'Places Truth',
    support_status: 'literal_support',
    source_id: 'ret_places',
    observed_at: '2026-01-01T00:00:00.000Z',
    provisional: false,
  };
  const modelObs = {
    evidence_id: 'obs_model_name',
    predicate: 'business_name',
    value: 'Model Invention',
    support_status: 'literal_support',
    source_id: 'ret_model',
    observed_at: '2026-08-01T00:00:00.000Z',
    provisional: false, // claimed durable but weak authority
  };
  const resolved = resolveFieldPreferringEvidence({
    field: 'business_name',
    record: {
      _row_id: 'acct_pref',
      source_snapshots_json: JSON.stringify([
        {
          source_id: 'ret_places',
          provider: 'places',
          source: 'GOOGLE_MAPS',
          retrieved_at: '2026-01-01T00:00:00.000Z',
          kind: 'retrieval',
        },
        {
          source_id: 'ret_model',
          provider: 'model',
          source: 'model',
          retrieved_at: '2026-08-01T00:00:00.000Z',
          kind: 'retrieval',
        },
      ]),
      observations_json: JSON.stringify({ observations: [modelObs, durablePlaces] }),
    },
  });
  assert.equal(resolved.value, 'Places Truth');
  assert.equal(resolved.provisional, false);
  assert.equal(resolved.source, 'stored_observation');
});

test('RES-EVIDENCE: model-only field resolution is provisional (not sole authority)', () => {
  const modelOnly = {
    evidence_id: 'obs_model_only',
    predicate: 'company_resolution',
    value: 'resolved',
    support_status: 'literal_support',
    source_id: 'ret_model_only',
    observed_at: '2026-08-01T00:00:00.000Z',
    provisional: false,
  };
  const resolved = resolveFieldPreferringEvidence({
    field: 'company_resolution',
    record: {
      _row_id: 'acct_model_only',
      source_snapshots_json: JSON.stringify([
        {
          source_id: 'ret_model_only',
          provider: 'model',
          source: 'model',
          retrieved_at: '2026-08-01T00:00:00.000Z',
          kind: 'retrieval',
        },
      ]),
      observations_json: JSON.stringify({ observations: [modelOnly] }),
    },
  });
  assert.equal(resolved.value, 'resolved');
  assert.equal(resolved.provisional, true, 'model sole authority must be provisional');
  assert.equal(resolved.source, 'stored_observation_weak_authority');
});

test('RES-EVIDENCE: observation refresh appends history (no wholesale replace)', () => {
  const prior = {
    evidence_id: 'obs_prior_site',
    predicate: 'site_text',
    value: 'prior site excerpt',
    support_status: 'literal_support',
    source_id: 'ret_prior',
    observed_at: '2026-01-01T00:00:00.000Z',
    provisional: false,
  };
  const patch = buildEnrichEvidencePatch({
    record: {
      _row_id: 'acct_append',
      website: 'https://example.test',
      observations_json: JSON.stringify({ observations: [prior] }),
      source_snapshots_json: JSON.stringify([
        {
          source_id: 'ret_prior',
          provider: 'firecrawl',
          source: 'FIRECRAWL_SCRAPE',
          retrieved_at: '2026-01-01T00:00:00.000Z',
          kind: 'retrieval',
          content_hash: 'aaa',
          excerpt: 'prior site excerpt',
        },
      ]),
      last_retrieval_snapshot_json: JSON.stringify({
        source_id: 'ret_prior',
        provider: 'firecrawl',
        retrieved_at: '2026-01-01T00:00:00.000Z',
        kind: 'retrieval',
        content_hash: 'aaa',
      }),
    },
    step_id: 'site_scrape_2',
    step_config: {
      action: 'tool_call',
      tool: { server: 'firecrawl', tools: ['FIRECRAWL_SCRAPE'] },
      output_map: { site_text: 'data.markdown' },
    },
    outputs: { site_text: '# New scrape body with more content for hash uniqueness' },
    provider: 'firecrawl',
  });

  const store = JSON.parse(String(patch.observations_json));
  const obs = store.observations || [];
  assert.ok(
    obs.some((o) => o.evidence_id === 'obs_prior_site'),
    'prior observation must remain after refresh',
  );
  assert.ok(
    obs.some((o) => o.predicate === 'site_text' && o.evidence_id !== 'obs_prior_site'),
    'new observation must be appended',
  );

  // Retrieval history list preserved (not only last_*)
  const hist = JSON.parse(String(patch.retrieval_snapshots_json || '[]'));
  assert.ok(Array.isArray(hist) && hist.length >= 2, 'must preserve retrieval history list');
  assert.ok(hist.some((s) => s.source_id === 'ret_prior'));
  const last = JSON.parse(String(patch.last_retrieval_snapshot_json));
  assert.notEqual(last.source_id, 'ret_prior', 'last_* advances to newest');
});

test('RES-EVIDENCE: wholesale replace only with rebuild_observations flag', () => {
  const priorA = {
    evidence_id: 'obs_hist_a',
    predicate: 'business_name',
    value: 'Old Name',
    support_status: 'literal_support',
    source_id: 'ret_a',
    observed_at: '2026-01-01T00:00:00.000Z',
    provisional: false,
  };
  const priorB = {
    evidence_id: 'obs_hist_b',
    predicate: 'business_name',
    value: 'Also Old',
    support_status: 'inferred',
    source_id: 'ret_b',
    observed_at: '2026-02-01T00:00:00.000Z',
    provisional: true,
  };
  const record = {
    _row_id: 'acct_rebuild',
    business_name: 'Live Name',
    observations_json: JSON.stringify({ observations: [priorA, priorB] }),
  };
  const appended = buildObservationStore(record);
  const nameCount = appended.observations.filter((o) => o.predicate === 'business_name').length;
  assert.ok(nameCount >= 2, 'default append keeps history for same predicate');

  const rebuilt = buildObservationStore({ ...record, rebuild_observations: true }, { rebuildObservations: true });
  const rebuiltNames = rebuilt.observations.filter((o) => o.predicate === 'business_name');
  // Rebuild collapses singleton to durable-preferring winner
  assert.equal(rebuiltNames.length, 1);
  assert.equal(rebuiltNames[0].value, 'Old Name');
  assert.equal(rebuiltNames[0].provisional, false);
});

test('RES-EVIDENCE: deriveFitEvidenceConfidence returns 0 without evidence_ids', () => {
  const conf = deriveFitEvidenceConfidence([
    { id: 'operational_coordination_burden', grade: 9, reasoning: 'looks busy', evidence_ids: [] },
    { id: 'repetition_and_volume', grade: 8, reasoning: 'many jobs', evidence_ids: [] },
    { id: 'economic_impact_potential', grade: 8, reasoning: 'money', evidence_ids: [] },
    { id: 'operating_scale_surface_area', grade: 7, reasoning: 'scale', evidence_ids: [] },
    { id: 'mission_delivery_compatibility', grade: 7, reasoning: 'ok', evidence_ids: [] },
    { id: 'local_buying_autonomy', grade: 9, reasoning: 'owner', evidence_ids: [] },
  ]);
  assert.equal(conf, 0);
});

// ── RES-SCORING ──────────────────────────────────────────────────────────────

test('RES-SCORING: thin evidence confidence < 40 forces enrichment_hold (not B/C)', () => {
  const out = applyOutboundPolicy({
    record: {
      _row_id: 'acct_thin_conf',
      is_a_business: true,
      company_resolution: 'resolved',
      fit_score: 88,
      fit_evidence_confidence: 30,
      identity_confidence: 90,
      contact_email: 'a@b.test',
      email_confidence: 80,
      email_validated: true,
    },
  });
  assert.equal(out.treatment_tier, 'enrichment_hold');
  assert.notEqual(out.treatment_tier, 'B');
  assert.notEqual(out.treatment_tier, 'C');
  assert.equal(out.mail_treatment, 'none');
});

test('RES-SCORING: zero evidence_ids on all fit components forces enrichment_hold (not B/C)', () => {
  const breakdown = [
    { id: 'operational_coordination_burden', grade: 9, reasoning: 'busy', evidence_ids: [] },
    { id: 'repetition_and_volume', grade: 8, reasoning: 'volume', evidence_ids: [] },
    { id: 'economic_impact_potential', grade: 8, reasoning: 'econ', evidence_ids: [] },
    { id: 'operating_scale_surface_area', grade: 7, reasoning: 'scale', evidence_ids: [] },
    { id: 'mission_delivery_compatibility', grade: 7, reasoning: 'fit', evidence_ids: [] },
    { id: 'local_buying_autonomy', grade: 9, reasoning: 'owner', evidence_ids: [] },
  ];
  const out = applyOutboundPolicy({
    record: {
      _row_id: 'acct_thin_ids',
      is_a_business: true,
      company_resolution: 'resolved',
      fit_score: 85,
      // Invented-high confidence must not open B when components cite nothing.
      fit_evidence_confidence: 75,
      fit_breakdown: JSON.stringify(breakdown),
      identity_confidence: 90,
      contact_email: 'a@b.test',
      email_confidence: 80,
      email_validated: true,
    },
  });
  assert.equal(out.treatment_tier, 'enrichment_hold');
  assert.ok(
    String(out.patch.treatment_reasons || '').includes('thin_evidence')
    || String(out.patch.treatment_reasons || '').includes('zero_evidence'),
    `expected thin_evidence reason, got ${out.patch.treatment_reasons}`,
  );
});

test('RES-SCORING: baseline readiness fails closed with no_usable_channel without proposedAction', () => {
  const r = evaluateOutboundReadiness({
    eligible: true,
    suppressed: false,
    identityConfidence: 90,
    materialContradiction: false,
    treatmentTier: 'B',
    channels: {
      email: { ready: false, confidence: 0 },
      phone: { ready: false },
      mail: { ready: false, confidence: 50 },
    },
    contentReady: true,
    claimAuditPassed: true,
    withinBudget: true,
    hasNextAction: true,
    // no proposedAction
  });
  assert.equal(r.ready, false);
  assert.ok(r.blockers.includes('no_usable_channel'));
});

test('RES-SCORING: ready=true without confidence is not usable', () => {
  const r = evaluateOutboundReadiness({
    eligible: true,
    suppressed: false,
    identityConfidence: 90,
    materialContradiction: false,
    treatmentTier: 'B',
    channels: {
      email: { ready: true }, // no confidence
    },
    contentReady: true,
    claimAuditPassed: true,
    withinBudget: true,
    hasNextAction: true,
  });
  assert.equal(r.ready, false);
  assert.ok(r.blockers.includes('no_usable_channel'));
});

test('RES-SCORING: mail_treatment none forces mail ready false; allocateMail throws', () => {
  const r = evaluateOutboundReadiness({
    eligible: true,
    suppressed: false,
    identityConfidence: 90,
    materialContradiction: false,
    treatmentTier: 'B',
    mailTreatment: 'none',
    channels: {
      email: { ready: true, confidence: 80 },
      mail: { ready: true, confidence: 95 },
    },
    contentReady: true,
    claimAuditPassed: true,
    withinBudget: true,
    hasNextAction: true,
  });
  assert.ok(!r.permitted_channels.includes('mail'));
  // Mail not ready under none — if proposed mail would block.
  const mailProposed = evaluateOutboundReadiness({
    eligible: true,
    suppressed: false,
    identityConfidence: 90,
    materialContradiction: false,
    treatmentTier: 'B',
    mailTreatment: 'none',
    channels: {
      email: { ready: true, confidence: 80 },
      mail: { ready: true, confidence: 95 },
    },
    contentReady: true,
    claimAuditPassed: true,
    withinBudget: true,
    hasNextAction: true,
    proposedAction: { channel: 'mail', kind: 'manual_task', taskType: 'standard_postcard' },
  });
  assert.equal(mailProposed.ready, false);
  assert.ok(mailProposed.blockers.includes('mail_not_ready'));

  // allocateMail already throws on none
  assert.throws(
    () => allocateMail({
      campaign: {
        account_id: 'a1',
        campaign_id: 'c1',
        treatment_tier: 'B',
        mail_treatment: 'none',
        contacts: [{ contact_id: 'c1', eligible: true }],
        started_at: new Date().toISOString(),
        mail_allocated: false,
      },
      mail_treatment: 'standard_postcard',
    }),
    /mail_treatment|mail permission/i,
  );
});

test('RES-SCORING: applyOutboundPolicy mail_treatment none never marks mail ready', () => {
  const out = applyOutboundPolicy({
    record: {
      _row_id: 'acct_mail_none',
      is_a_business: true,
      company_resolution: 'resolved',
      fit_score: 40,
      fit_evidence_confidence: 70,
      identity_confidence: 90,
      address: '1 Main St Boise ID',
      mail_address_ready: true,
      address_rdi: 'commercial',
      mail_confidence: 95,
      contact_email: 'a@b.test',
      email_confidence: 80,
      email_validated: true,
      preliminary_snapshot: 'snap',
      claim_audit_passed: 1,
      next_action_json: JSON.stringify({ action_id: 'na1', action_type: 'send_email' }),
    },
  });
  // Weak fit → D, mail none
  assert.equal(out.mail_treatment, 'none');
  const readiness = JSON.parse(String(out.patch.readiness_json));
  assert.ok(!readiness.permitted_channels.includes('mail'));
});

// ── RES-CONTENT ──────────────────────────────────────────────────────────────

test('RES-CONTENT: claim_audit_asset_hash is stable hash of exact assetText', () => {
  const text = 'Public reviews mention delayed callbacks after hours.';
  const a = claimAuditAssetHash(text);
  const b = claimAuditAssetHash(text);
  assert.equal(a, b);
  assert.ok(a.length >= 32);
  assert.notEqual(a, claimAuditAssetHash(text + ' changed'));
});

test('RES-CONTENT: send refuses when body hash differs from claim_audit_asset_hash', () => {
  const audited = 'Audited copy about public callback gaps.';
  const hash = claimAuditAssetHash(audited);
  const record = {
    claim_audit_passed: 1,
    claim_audit_asset_hash: hash,
    preliminary_snapshot: audited,
    permitted_claim_packet_json: JSON.stringify({ permitted_claims: [{ claim_id: 'c1' }] }),
  };

  // Matching body → not blocked by hash
  const ok = claimAuditAssetHashMismatch({ record, bodyText: audited });
  assert.equal(ok.blocked, false);

  // Changed copy → refuse
  const bad = claimAuditAssetHashMismatch({
    record,
    bodyText: 'Changed copy inventing $80,000 loss.',
  });
  assert.equal(bad.blocked, true);
  assert.ok(String(bad.reason || '').includes('claim_audit_asset_hash_mismatch'));

  // Email send path
  const emailBlock = claimAuditBlocksExternalSend({
    config: { policy: { enforce_readiness: true } },
    record,
    channel: 'email',
    stepKind: 'send_email',
    commercialBody: 'Totally different email body after audit.',
  });
  assert.equal(emailBlock.blocked, true);
  assert.ok(String(emailBlock.reason || '').includes('claim_audit_asset_hash_mismatch'));

  // LinkedIn commercial body
  const liBlock = claimAuditBlocksExternalSend({
    config: {},
    record,
    channel: 'linkedin',
    commercialBody: 'Changed LI invite note.',
  });
  assert.equal(liBlock.blocked, true);

  // Mail copy
  const mailBlock = claimAuditBlocksExternalSend({
    config: {},
    record,
    channel: 'mail',
    commercialBody: 'Changed postcard copy.',
  });
  assert.equal(mailBlock.blocked, true);

  // No hash stored + claim_audit_passed=1 + body → fail closed (review return #3)
  const noHash = claimAuditAssetHashMismatch({
    record: { claim_audit_passed: 1 },
    bodyText: 'anything',
  });
  assert.equal(noHash.blocked, true);
  assert.match(String(noHash.reason), /missing/i);
});

test('RES-CONTENT: matching audited body is not refused by hash gate', () => {
  const audited = 'I noticed public reviews mention delayed callbacks after hours.';
  const hash = claimAuditAssetHash(audited);
  const block = claimAuditBlocksExternalSend({
    config: { policy: { enforce_readiness: true } },
    record: {
      claim_audit_passed: 1,
      claim_audit_asset_hash: hash,
      preliminary_snapshot: audited,
    },
    channel: 'email',
    commercialBody: audited,
  });
  // May still block for other reasons if claim failed — but not hash mismatch
  assert.ok(!String(block.reason || '').includes('claim_audit_asset_hash_mismatch'));
});

test('RES-EVIDENCE: mergeObservationLists appends distinct evidence_ids (history)', () => {
  const a = {
    evidence_id: 'obs_1',
    predicate: 'address',
    value: '1 Main',
    support_status: 'literal_support',
    observed_at: '2026-01-01T00:00:00.000Z',
    provisional: false,
  };
  const b = {
    evidence_id: 'obs_2',
    predicate: 'address',
    value: '1 Main St',
    support_status: 'literal_support',
    observed_at: '2026-02-01T00:00:00.000Z',
    provisional: false,
  };
  const merged = mergeObservationLists([a], [b]);
  assert.equal(merged.length, 2);
  assert.deepEqual(
    parseStoredObservations(JSON.stringify({ observations: merged })).map((o) => o.evidence_id).sort(),
    ['obs_1', 'obs_2'],
  );
});
