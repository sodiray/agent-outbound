/**
 * RES-EVIDENCE-ARCHITECTURE: immutable retrieval → observation → resolution.
 *
 * 1. Retrieval success writes content-hashed snapshot before observations.
 * 2. Observations cite snapshot source_id (not live mutable rereads alone).
 * 3. Policy prefers durable trail; mutable fallback is provisional: true.
 * 4. Policy re-apply never clobbers durable observations with thin extracts.
 * 5. Failure never erases prior good retrieval snapshot / non-blank fields.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyOutboundPolicy,
} from '../dist/orchestrator/policy/apply-record.js';
import {
  buildEnrichEvidencePatch,
  buildObservationStore,
  buildRetrievalSnapshot,
  contentHashFromBody,
  extractObservationsFromRecord,
  hasDurableEvidenceTrail,
  mergeObservationsPreferDurable,
  parseLastRetrievalSnapshot,
  parseStoredObservations,
  preservePriorNonBlankFields,
  resolveFieldPreferringEvidence,
} from '../dist/orchestrator/policy/evidence.js';

const SITE = '# Peak HVAC\n\nBoise after-hours emergency service. Licensed and bonded.';

test('contentHashFromBody is stable sha256 hex', () => {
  const a = contentHashFromBody(SITE);
  const b = contentHashFromBody(SITE);
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(contentHashFromBody(''), '');
});

test('buildRetrievalSnapshot: content_hash + content-addressed source_id', () => {
  const snap = buildRetrievalSnapshot({
    source: 'FIRECRAWL_SCRAPE',
    provider: 'firecrawl',
    step_id: 'site_scrape',
    record_id: 'acct_hash',
    path: 'site_text',
    body: SITE,
    retrieved_at: '2026-08-01T12:00:00.000Z',
  });
  assert.ok(snap.content_hash);
  assert.equal(snap.content_hash, contentHashFromBody(SITE));
  assert.ok(snap.source_id.includes(snap.content_hash.slice(0, 16)));
  assert.equal(snap.kind, 'retrieval');
  assert.ok((snap.excerpt || snap.body || '').includes('Peak HVAC'));
  // Same content → same source_id (idempotent)
  const snap2 = buildRetrievalSnapshot({
    source: 'FIRECRAWL_SCRAPE',
    provider: 'firecrawl',
    step_id: 'site_scrape',
    record_id: 'acct_hash',
    path: 'site_text',
    body: SITE,
    retrieved_at: '2026-08-02T00:00:00.000Z',
  });
  assert.equal(snap2.source_id, snap.source_id);
});

test('buildEnrichEvidencePatch success: snapshot before observations, source_id linked, content_hash set', () => {
  const patch = buildEnrichEvidencePatch({
    record: {
      _row_id: 'acct_ok',
      website: 'https://peak.example',
      site_text: '',
    },
    step_id: 'site_scrape',
    step_config: {
      action: 'tool_call',
      tool: { server: 'firecrawl', tools: ['FIRECRAWL_SCRAPE'] },
      output_map: { site_text: 'data.markdown' },
    },
    outputs: { site_text: SITE },
    provider: 'firecrawl',
  });

  const snap = parseLastRetrievalSnapshot(patch.last_retrieval_snapshot_json);
  assert.ok(snap);
  assert.equal(snap.kind, 'retrieval');
  assert.ok(snap.content_hash, 'retrieval success must set content_hash');
  assert.equal(snap.content_hash, contentHashFromBody(SITE));
  assert.ok(snap.retrieved_at);
  assert.ok(snap.source || snap.provider);

  const store = JSON.parse(String(patch.observations_json));
  const obs = store.observations || [];
  assert.ok(obs.length >= 1, 'must write observations from outputs');
  const siteObs = obs.find((o) => o.predicate === 'site_text' || o.predicate === 'markdown');
  assert.ok(siteObs, 'site_text observation required');
  assert.equal(siteObs.source_id, snap.source_id, 'observation must cite snapshot source_id');
  assert.equal(siteObs.provisional, false, 'enrich-backed observations are durable');
  assert.ok(!obs.some((o) => o.support_status === 'tool_failure'));
});

test('buildEnrichEvidencePatch scalar success still writes retrieval snapshot + source_id', () => {
  const patch = buildEnrichEvidencePatch({
    record: { _row_id: 'acct_li', company_resolution: '' },
    step_id: 'linkedin_company_resolution',
    step_config: {
      action: 'linkedin_company_resolution',
    },
    outputs: {
      company_resolution: 'resolved',
      place_id: 'places/ChIJxyz',
      business_name: 'Peak HVAC LLC',
      resolution_source: 'places',
    },
    provider: 'places',
  });
  const snap = parseLastRetrievalSnapshot(patch.last_retrieval_snapshot_json);
  assert.ok(snap, 'scalar success must still write last_retrieval_snapshot');
  assert.ok(snap.content_hash, 'scalar retrieval needs content_hash');
  assert.equal(snap.kind, 'retrieval');
  const store = JSON.parse(String(patch.observations_json));
  const resObs = (store.observations || []).find((o) => o.predicate === 'company_resolution');
  assert.ok(resObs);
  assert.equal(resObs.source_id, snap.source_id);
  assert.equal(resObs.provisional, false);
  assert.equal(resObs.value, 'resolved');
});

test('extractObservationsFromRecord marks mutable rereads provisional', () => {
  const obs = extractObservationsFromRecord({
    _row_id: 'acct_prov',
    business_name: 'Live Name',
    place_id: 'p1',
    company_resolution: 'resolved',
    source: 'geo_tiles',
    sourced_at: '2026-08-01T00:00:00.000Z',
  });
  assert.ok(obs.length >= 1);
  assert.ok(
    obs.filter((o) => o.predicate !== 'tool_failure').every((o) => o.provisional === true),
    'mutable-field extracts must be provisional',
  );
});

test('resolveFieldPreferringEvidence: durable obs wins; scalar is provisional', () => {
  const durable = {
    evidence_id: 'obs_acct_site_scrape_site_text',
    predicate: 'site_text',
    value: 'FROM_SNAPSHOT',
    support_status: 'literal_support',
    source_id: 'ret_good',
    observed_at: '2026-07-01T00:00:00.000Z',
    provisional: false,
  };
  const record = {
    _row_id: 'acct_pref',
    site_text: 'LIVE_MUTABLE_OVERWRITE_ATTEMPT',
    observations_json: JSON.stringify({ observations: [durable] }),
    last_retrieval_snapshot_json: JSON.stringify({
      source_id: 'ret_good',
      provider: 'firecrawl',
      source: 'FIRECRAWL_SCRAPE',
      retrieved_at: '2026-07-01T00:00:00.000Z',
      path: 'site_text',
      excerpt: 'FROM_SNAPSHOT',
      content_hash: contentHashFromBody('FROM_SNAPSHOT'),
      kind: 'retrieval',
    }),
  };
  const hit = resolveFieldPreferringEvidence({ field: 'site_text', record });
  assert.equal(hit.value, 'FROM_SNAPSHOT');
  assert.equal(hit.provisional, false);
  assert.equal(hit.source, 'stored_observation');

  const scalarOnly = resolveFieldPreferringEvidence({
    field: 'business_name',
    record: { _row_id: 'x', business_name: 'Only Scalar' },
  });
  assert.equal(scalarOnly.value, 'Only Scalar');
  assert.equal(scalarOnly.provisional, true);
  assert.match(scalarOnly.source, /provisional/);
});

test('policy re-apply does not clobber durable observations with thin provisional extracts', () => {
  const durableSite = {
    evidence_id: 'obs_durable_site_scrape_site_text',
    predicate: 'site_text',
    value: 'DURABLE_SCRAPE_EXCERPT',
    support_status: 'literal_support',
    source_id: 'ret_durable',
    observed_at: '2026-06-01T00:00:00.000Z',
    provisional: false,
  };
  const durableName = {
    evidence_id: 'obs_durable_site_scrape_business_name',
    predicate: 'business_name',
    value: 'Durable Corp',
    support_status: 'literal_support',
    source_id: 'ret_durable',
    observed_at: '2026-06-01T00:00:00.000Z',
    provisional: false,
  };
  const goodSnap = {
    source_id: 'ret_durable',
    provider: 'firecrawl',
    source: 'FIRECRAWL_SCRAPE',
    retrieved_at: '2026-06-01T00:00:00.000Z',
    path: 'site_text',
    excerpt: 'DURABLE_SCRAPE_EXCERPT',
    content_hash: contentHashFromBody('DURABLE_SCRAPE_EXCERPT'),
    kind: 'retrieval',
  };

  const record = {
    _row_id: 'acct_no_clobber',
    // Live mutable fields deliberately disagree with durable trail
    business_name: 'MUTATED_LIVE_NAME',
    site_text: 'MUTATED_LIVE_SITE',
    place_id: 'places/ChIJkeep',
    company_resolution: 'resolved',
    is_a_business: true,
    fit_score: 70,
    identity_confidence: 85,
    source: 'geo_tiles',
    sourced_at: '2026-05-01T00:00:00.000Z',
    last_retrieval_snapshot_json: JSON.stringify(goodSnap),
    source_snapshots_json: JSON.stringify([goodSnap]),
    observations_json: JSON.stringify({
      account_id: 'acct_no_clobber',
      snapshots: [goodSnap],
      observations: [durableSite, durableName],
      contradictions: [],
    }),
  };

  assert.equal(hasDurableEvidenceTrail(record), true);

  const r = applyOutboundPolicy({ record });
  const store = JSON.parse(String(r.patch.observations_json));
  const site = store.observations.find((o) => o.predicate === 'site_text');
  const name = store.observations.find((o) => o.predicate === 'business_name');
  assert.ok(site);
  assert.equal(site.value, 'DURABLE_SCRAPE_EXCERPT');
  assert.equal(site.provisional, false);
  assert.equal(site.source_id, 'ret_durable');
  assert.ok(name);
  assert.equal(name.value, 'Durable Corp');
  assert.equal(name.provisional, false);

  // last_retrieval_snapshot preserved through policy apply
  const last = parseLastRetrievalSnapshot(r.patch.last_retrieval_snapshot_json);
  assert.ok(last);
  assert.equal(last.source_id, 'ret_durable');
  assert.equal(last.kind, 'retrieval');
  assert.ok(last.content_hash);

  // identity + contradictions still durable columns
  assert.ok(r.patch.identity_resolution_json);
  assert.ok(r.patch.contradictions_json != null);
});

test('mergeObservationsPreferDurable: provisional never displaces durable same predicate', () => {
  const durable = {
    evidence_id: 'obs_d',
    predicate: 'company_resolution',
    value: 'resolved',
    support_status: 'literal_support',
    source_id: 'ret_1',
    observed_at: '2026-01-01T00:00:00.000Z',
    provisional: false,
  };
  const provisional = {
    evidence_id: 'obs_p',
    predicate: 'company_resolution',
    value: 'unresolvable',
    support_status: 'literal_support',
    observed_at: '2026-08-01T00:00:00.000Z',
    provisional: true,
  };
  const merged = mergeObservationsPreferDurable([durable], [provisional]);
  const hit = merged.find((o) => o.predicate === 'company_resolution');
  assert.equal(hit.value, 'resolved');
  assert.equal(hit.provisional, false);
});

test('failure: preserves prior last_retrieval + prior site_text blank-clobber guard', () => {
  const priorSite = 'GOOD SITE that must survive empty failure';
  const goodSnap = {
    source_id: 'ret_prior',
    provider: 'firecrawl',
    source: 'FIRECRAWL_SCRAPE',
    retrieved_at: '2026-07-01T00:00:00.000Z',
    path: 'site_text',
    excerpt: priorSite,
    body: priorSite,
    content_hash: contentHashFromBody(priorSite),
    kind: 'retrieval',
  };
  const failPatch = buildEnrichEvidencePatch({
    record: {
      _row_id: 'acct_fail',
      site_text: priorSite,
      last_retrieval_snapshot_json: JSON.stringify(goodSnap),
      source_snapshots_json: JSON.stringify([goodSnap]),
      observations_json: JSON.stringify({
        observations: [{
          evidence_id: 'obs_prior_site',
          predicate: 'site_text',
          value: priorSite.slice(0, 40),
          support_status: 'literal_support',
          source_id: 'ret_prior',
          observed_at: '2026-07-01T00:00:00.000Z',
          provisional: false,
        }],
      }),
    },
    step_id: 'site_scrape',
    step_config: {
      action: 'tool_call',
      tool: { server: 'firecrawl', tools: ['FIRECRAWL_SCRAPE'] },
      output_map: { site_text: 'data.markdown' },
    },
    outputs: { site_text: '' },
    error: 'timeout',
    failed: true,
  });

  const last = parseLastRetrievalSnapshot(failPatch.last_retrieval_snapshot_json);
  assert.equal(last?.source_id, 'ret_prior');
  assert.equal(last?.kind, 'retrieval');

  const store = JSON.parse(String(failPatch.observations_json));
  assert.ok((store.observations || []).some((o) => o.support_status === 'tool_failure'));
  assert.ok(
    (store.observations || []).some(
      (o) => o.predicate === 'site_text' && o.provisional === false,
    ),
    'prior durable site_text observation must remain',
  );

  const applied = preservePriorNonBlankFields({
    record: { site_text: priorSite, place_id: 'p1' },
    patch: { site_text: '', place_id: '', last_error: 'timeout', ...failPatch },
  });
  assert.equal(applied.site_text, undefined);
  assert.equal(applied.place_id, undefined);
  assert.equal(applied.last_error, 'timeout');
});

test('buildObservationStore: provisional extracts only fill gaps; durable preferred', () => {
  const durable = {
    evidence_id: 'obs_d_name',
    predicate: 'business_name',
    value: 'From Trail',
    support_status: 'literal_support',
    source_id: 'ret_1',
    observed_at: '2026-01-01T00:00:00.000Z',
    provisional: false,
  };
  const store = buildObservationStore({
    _row_id: 'acct_store',
    business_name: 'Live Mutation',
    place_id: 'p_live',
    address: '9 Oak',
    source: 'places',
    sourced_at: '2026-08-01T00:00:00.000Z',
    company_resolution: 'resolved',
    observations_json: JSON.stringify({ observations: [durable] }),
    last_retrieval_snapshot_json: JSON.stringify({
      source_id: 'ret_1',
      provider: 'firecrawl',
      retrieved_at: '2026-01-01T00:00:00.000Z',
      kind: 'retrieval',
      content_hash: 'abc',
    }),
  });
  const name = store.observations.find((o) => o.predicate === 'business_name');
  assert.equal(name.value, 'From Trail');
  assert.equal(name.provisional, false);
  // place_id gap filled provisionally from mutable
  const place = store.observations.find((o) => o.predicate === 'place_id');
  assert.ok(place);
  assert.equal(place.value, 'p_live');
  assert.equal(place.provisional, true);
});

test('applyOutboundPolicy: company_resolution from durable obs beats mutated scalar', () => {
  const durable = {
    evidence_id: 'obs_res',
    predicate: 'company_resolution',
    value: 'resolved',
    support_status: 'literal_support',
    source_id: 'ret_li',
    observed_at: '2026-01-01T00:00:00.000Z',
    provisional: false,
  };
  const r = applyOutboundPolicy({
    record: {
      _row_id: 'acct_res',
      // Mutated live field would wrongly hold if preferred
      company_resolution: 'unresolvable',
      is_a_business: true,
      fit_score: 60,
      identity_confidence: 80,
      observations_json: JSON.stringify({ observations: [durable] }),
      last_retrieval_snapshot_json: JSON.stringify({
        source_id: 'ret_li',
        provider: 'places',
        retrieved_at: '2026-01-01T00:00:00.000Z',
        kind: 'retrieval',
        content_hash: 'x',
      }),
    },
  });
  // Durable resolved → eligible, not enrichment_hold
  assert.equal(r.eligibility_outcome, 'eligible');
  const env = JSON.parse(String(r.patch.evidence_resolution_json));
  assert.equal(env.eligibility_outcome, 'eligible');
});
