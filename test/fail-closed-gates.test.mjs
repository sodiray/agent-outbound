/**
 * Fail-closed gates shipped recently — pure/deterministic surfaces only.
 *
 * Bug classes covered:
 * 1. site_scrape success loses retrieval snapshot; failure clobbers site_text
 * 2. call board dumps every A/B with a phone (incl. suppressed / terminal / paused)
 * 3. readiness treats undefined contentReady as ready
 *
 * Already covered elsewhere (asserted here only if cheap):
 * - golden ticket null fit → phase-05
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  buildEnrichEvidencePatch,
  latestRetrievalSnapshot,
  preservePriorNonBlankFields,
  parseStoredObservations,
} from '../dist/orchestrator/policy/evidence.js';
import {
  isCallBoardEligible,
  isRecordSuppressed,
  isTerminalLifecycle,
  isSequenceStateBlockingCallBoard,
  getCallBoard,
} from '../dist/orchestrator/operator/call-board.js';
import { evaluateOutboundReadiness } from '../dist/orchestrator/policy/readiness.js';
import { evaluateGoldenTicket } from '../dist/orchestrator/policy/treatment.js';
import { openListDb, ensureRecordColumns } from '../dist/orchestrator/runtime/db.js';
import { completeManualTask } from '../dist/orchestrator/pipeline/manual.js';
import {
  treasureValleyGoldenTicket,
  treasureValleyTreatmentStrategy,
} from './fixtures/treatment-strategy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TV_ROOT =
  process.env.TV_ROOT ||
  '/Users/rayepps/projects/mission/.outbound/treasure-valley';

// ── 1. Evidence: site_scrape success + failure preserve ─────────────────────

test('evidence: site_scrape success writes authoritative retrieval snapshot', () => {
  const siteMarkdown = '# Acme HVAC\n\nWe service Boise and Meridian. After-hours calls welcome.';
  const patch = buildEnrichEvidencePatch({
    record: {
      _row_id: 'acct_scrape_ok',
      website: 'https://acme-hvac.example',
      site_text: '',
    },
    step_id: 'site_scrape',
    step_config: {
      action: 'tool_call',
      tool: { server: 'firecrawl', tools: ['FIRECRAWL_SCRAPE'] },
      output_map: { site_text: 'data.markdown' },
    },
    outputs: { site_text: siteMarkdown },
    provider: 'firecrawl',
  });

  const snap = latestRetrievalSnapshot(patch);
  assert.ok(snap, 'snapshot must parse');
  assert.equal(snap.kind, 'retrieval');
  assert.ok(
    snap.excerpt.includes('Acme HVAC') || snap.excerpt.includes('Boise'),
    'snapshot must carry a bounded scrape excerpt',
  );
  assert.match(String(snap.source || snap.provider || ''), /firecrawl|FIRECRAWL|site_scrape/i);

  const store = parseStoredObservations(patch.observations_json);
  assert.ok(Array.isArray(store) ? store.length >= 0 : true);
  // observations_json is ObservationStore object or list depending on path
  const obsList = Array.isArray(store)
    ? store
    : (store?.observations || []);
  assert.ok(
    !obsList.some((o) => o.support_status === 'tool_failure'),
    'success path must not emit tool_failure',
  );
});

test('evidence: failure preserves prior site_text + adds tool_failure; keeps good last snap', () => {
  const priorSite =
    'PRIOR SITE BODY: established markdown that must never be wiped by empty failure.';
  const goodSnap = {
    source_id: 'ret_prior_good',
    provider: 'firecrawl',
    source: 'FIRECRAWL_SCRAPE',
    retrieved_at: '2026-07-01T00:00:00.000Z',
    path: 'site_text',
    excerpt: priorSite.slice(0, 200),
    body: priorSite,
    kind: 'retrieval',
  };

  const failPatch = buildEnrichEvidencePatch({
    record: {
      _row_id: 'acct_scrape_fail',
      website: 'https://acme-hvac.example',
      site_text: priorSite,
      last_retrieval_snapshot_json: JSON.stringify(goodSnap),
      observations_json: JSON.stringify({
        account_id: 'acct_scrape_fail',
        snapshots: [goodSnap],
        observations: [],
        contradictions: [],
      }),
      source_snapshots_json: JSON.stringify([goodSnap]),
    },
    step_id: 'site_scrape',
    step_config: {
      action: 'tool_call',
      tool: { server: 'firecrawl', tools: ['FIRECRAWL_SCRAPE'] },
      output_map: { site_text: 'data.markdown' },
    },
    outputs: { site_text: '' },
    error: 'FIRECRAWL_SCRAPE timeout after 30s',
    failed: true,
    provider: 'firecrawl',
  });

  // Failure observation present
  const storeRaw = JSON.parse(String(failPatch.observations_json));
  const observations = storeRaw.observations || storeRaw;
  assert.ok(
    observations.some(
      (o) => o.support_status === 'tool_failure' || o.predicate === 'tool_failure',
    ),
    `expected tool_failure observation, got ${JSON.stringify(observations).slice(0, 400)}`,
  );

  // Prior good retrieval must not be replaced by a failure-only snapshot.
  const last = latestRetrievalSnapshot(failPatch);
  assert.ok(last, 'last snap still present');
  assert.equal(last.kind, 'retrieval', 'must keep prior retrieval, not overwrite with tool_failure');
  assert.equal(last.source_id, 'ret_prior_good');

  // Blank output must not clobber prior site_text when merged via preserve helper
  const applied = preservePriorNonBlankFields({
    record: { site_text: priorSite, business_name: 'Acme' },
    patch: {
      site_text: '',
      last_error: 'FIRECRAWL_SCRAPE timeout after 30s',
      ...failPatch,
    },
  });
  assert.equal(applied.site_text, undefined, 'blank site_text key dropped so prior is preserved');
  assert.equal(applied.last_error, 'FIRECRAWL_SCRAPE timeout after 30s');
});

// ── 2. Call board eligibility ───────────────────────────────────────────────

const eligibleBase = {
  _row_id: 'cb1',
  treatment_tier: 'A',
  phone: '+12085551212',
  suppressed: 0,
  lifecycle_stage: 'contacted',
  account_sequence_state: 'active',
  call_claim_status: 'open',
  next_action_json: JSON.stringify({
    action_id: 'na1',
    action_type: 'manual_task',
    channel: 'phone',
    work_state: 'human_phone',
  }),
};

// Structural gates only — phone attempt window/ceiling covered in phone-attempt-policy.test.mjs
const structuralEligibleOpts = (park) => ({
  hasOpenPhonePark: park,
  enforcePhoneAttemptPolicy: false,
});

test('call board: isCallBoardEligible excludes suppressed, terminal, paused_*, pure A/B phone-only', () => {
  // Happy path: open phone park
  assert.equal(
    isCallBoardEligible(eligibleBase, structuralEligibleOpts(true)),
    true,
  );
  // Happy path: next_action is phone, no park
  assert.equal(
    isCallBoardEligible(eligibleBase, structuralEligibleOpts(false)),
    true,
  );

  const cases = [
    {
      name: 'suppressed',
      row: { ...eligibleBase, suppressed: 1 },
      park: true,
      expected: false,
      predicate: () => isRecordSuppressed({ suppressed: 1 }),
    },
    {
      name: 'terminal won',
      row: { ...eligibleBase, lifecycle_stage: 'won' },
      park: true,
      expected: false,
      predicate: () => isTerminalLifecycle({ lifecycle_stage: 'won' }),
    },
    {
      name: 'terminal lost',
      row: { ...eligibleBase, lifecycle_stage: 'lost' },
      park: true,
      expected: false,
    },
    {
      name: 'terminal disqualified',
      row: { ...eligibleBase, lifecycle_stage: 'disqualified' },
      park: true,
      expected: false,
    },
    {
      name: 'paused_review',
      row: { ...eligibleBase, account_sequence_state: 'paused_review' },
      park: true,
      expected: false,
      predicate: () => isSequenceStateBlockingCallBoard({ account_sequence_state: 'paused_review' }),
    },
    {
      name: 'paused_inbound',
      row: { ...eligibleBase, account_sequence_state: 'paused_inbound' },
      park: true,
      expected: false,
    },
    {
      name: 'paused_repair',
      row: { ...eligibleBase, account_sequence_state: 'paused_repair' },
      park: true,
      expected: false,
    },
    {
      name: 'completed sequence',
      row: { ...eligibleBase, account_sequence_state: 'completed' },
      park: true,
      expected: false,
    },
    {
      name: 'cancelled sequence',
      row: { ...eligibleBase, account_sequence_state: 'cancelled' },
      park: true,
      expected: false,
    },
    {
      name: 'pure A/B with phone only (no park, no phone next_action)',
      row: {
        ...eligibleBase,
        treatment_tier: 'A',
        phone: '+12085559999',
        next_action_json: JSON.stringify({
          action_id: 'na_email',
          action_type: 'send_email',
          channel: 'email',
        }),
      },
      park: false,
      expected: false,
    },
    {
      name: 'no phone number',
      row: { ...eligibleBase, phone: '', contact_phone: '' },
      park: true,
      expected: false,
    },
    {
      name: 'claim completed never resurfaces',
      row: { ...eligibleBase, call_claim_status: 'completed' },
      park: true,
      expected: false,
    },
  ];

  for (const c of cases) {
    assert.equal(
      isCallBoardEligible(c.row, structuralEligibleOpts(c.park)),
      c.expected,
      c.name,
    );
    if (c.predicate) assert.equal(c.predicate(), true, `${c.name} predicate`);
  }
});

test('call board: getCallBoard does not dump pure A/B phone-only records', () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-callboard-'));
  writeFileSync(
    join(listDir, 'outbound.yaml'),
    `list: { name: callboard }\npipeline: []\nscore: { criteria: [] }\nsequences: { default: { steps: [] } }\n`,
  );
  writeFileSync(join(listDir, 'operator.md'), 'call board');
  writeFileSync(join(listDir, 'mcp.json'), '{}');
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();

  ensureRecordColumns({
    db,
    columns: [
      'phone', 'contact_phone', 'treatment_tier', 'fit_score', 'suppressed',
      'lifecycle_stage', 'account_sequence_state', 'next_action_json',
      'call_claim_status', 'call_claimed_by', 'call_claimed_at', 'contact_name',
    ],
  });

  // Pure A/B with phone, email next_action — must NOT appear
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, phone, treatment_tier,
      fit_score, suppressed, lifecycle_stage, account_sequence_state, next_action_json,
      call_claim_status, contact_name,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, 'Phone Only Co', 'default', 'active', ?, 'A', 90, 0, 'contacted', 'active', ?, 'open', 'Alex',
      ?, ?, ?, ?)
  `).run(
    'pure_ab_phone',
    '+12085550001',
    JSON.stringify({ action_id: 'e1', action_type: 'send_email', channel: 'email' }),
    now, now, now, now,
  );

  // Suppressed with phone next_action — must NOT appear
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, phone, treatment_tier,
      fit_score, suppressed, lifecycle_stage, account_sequence_state, next_action_json,
      call_claim_status, contact_name,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, 'Suppressed Co', 'default', 'active', ?, 'A', 95, 1, 'contacted', 'active', ?, 'open', 'Sam',
      ?, ?, ?, ?)
  `).run(
    'suppressed_phone',
    '+12085550002',
    JSON.stringify({ action_id: 'p1', action_type: 'manual_task', channel: 'phone', work_state: 'human_phone' }),
    now, now, now, now,
  );

  // Terminal lifecycle — must NOT appear
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, phone, treatment_tier,
      fit_score, suppressed, lifecycle_stage, account_sequence_state, next_action_json,
      call_claim_status, contact_name,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, 'Won Co', 'default', 'completed', ?, 'A', 99, 0, 'won', 'completed', ?, 'open', 'Won',
      ?, ?, ?, ?)
  `).run(
    'won_phone',
    '+12085550003',
    JSON.stringify({ action_id: 'p2', action_type: 'manual_task', channel: 'phone' }),
    now, now, now, now,
  );

  // Valid phone next_action — MUST appear
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, phone, treatment_tier,
      fit_score, suppressed, lifecycle_stage, account_sequence_state, next_action_json,
      call_claim_status, contact_name,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, 'Real Call Co', 'default', 'active', ?, 'A', 88, 0, 'contacted', 'active', ?, 'open', 'Riley',
      ?, ?, ?, ?)
  `).run(
    'real_call',
    '+12085550004',
    JSON.stringify({
      action_id: 'p3',
      action_type: 'manual_task',
      channel: 'phone',
      work_state: 'human_phone',
    }),
    now, now, now, now,
  );

  // Fixed Boise business-hours instant so attempt-window policy does not flake off-hours.
  const board = getCallBoard({
    db,
    capacity: 25,
    nowMs: Date.parse('2026-08-05T16:00:00.000Z'),
    phonePolicy: { timeZone: 'America/Boise' },
  });
  const ids = board.entries.map((e) => e.record_id);
  assert.ok(ids.includes('real_call'), `expected real_call on board: ${ids.join(',')}`);
  assert.ok(!ids.includes('pure_ab_phone'), 'must not dump pure A/B phone-only');
  assert.ok(!ids.includes('suppressed_phone'), 'must not include suppressed');
  assert.ok(!ids.includes('won_phone'), 'must not include terminal lifecycle');
  db.close();
});

test('readiness: undefined contentReady fails closed (content_not_ready)', () => {
  const base = {
    eligible: true,
    suppressed: false,
    identityConfidence: 90,
    materialContradiction: false,
    treatmentTier: 'A',
    channels: { email: { ready: true, confidence: 80 } },
    claimAuditPassed: true,
    withinBudget: true,
    hasNextAction: true,
    namedBuyerStatus: 'confirmed',
    namedBuyerName: 'Alex Rivera',
    buyerAffiliationStatus: 'confirmed',
    buyingCenterRole: 'owner',
    proposedAction: { channel: 'email', kind: 'send_email' },
  };

  // Explicit omit — undefined must not readiness-pass
  const omitted = evaluateOutboundReadiness({ ...base });
  assert.equal(omitted.ready, false);
  assert.ok(omitted.blockers.includes('content_not_ready'));

  const explicitUndefined = evaluateOutboundReadiness({
    ...base,
    contentReady: undefined,
  });
  assert.equal(explicitUndefined.ready, false);
  assert.ok(explicitUndefined.blockers.includes('content_not_ready'));

  const nullContent = evaluateOutboundReadiness({
    ...base,
    contentReady: null,
  });
  assert.equal(nullContent.ready, false);
  assert.ok(nullContent.blockers.includes('content_not_ready'));

  // Control: only true passes
  const ok = evaluateOutboundReadiness({ ...base, contentReady: true });
  assert.equal(ok.ready, true, JSON.stringify(ok.blockers));
});

// ── 6. Golden ticket null fit (regression — primary coverage in phase-05) ───

test('golden ticket: null fitScore fails closed with fit_score_missing', () => {
  const g = evaluateGoldenTicket({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    goldenTicket: treasureValleyGoldenTicket,
    treatmentTier: 'A',
    fitScore: null,
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
    localBuyingAuthority: 'confirmed',
    cohortCapacityOk: true,
  });
  assert.equal(g.eligible, false);
  assert.ok(g.withheld.includes('fit_score_missing'));
  assert.ok(!g.withheld.includes('fit_below_85'));
});
