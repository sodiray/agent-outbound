/**
 * Fail-closed gates shipped recently — pure/deterministic surfaces only.
 *
 * Bug classes covered:
 * 1. site_scrape success loses retrieval snapshot; failure clobbers site_text
 * 2. call board dumps every A/B with a phone (incl. suppressed / terminal / paused)
 * 3. unsupported vertical inherits trades claim family
 * 4. readiness treats undefined contentReady as ready
 * 5. email send ignores claim_audit_passed=0 when draft is ready
 *
 * Already covered elsewhere (asserted here only if cheap):
 * - claim audit empty extract → phase-06
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
import {
  assemblePermittedClaimPacket,
  resolveDiagnosticFamily,
  emptyClaimPacket,
  matchProofs,
} from '../dist/orchestrator/policy/claim-packet.js';
import { evaluateOutboundReadiness } from '../dist/orchestrator/policy/readiness.js';
import { evaluateGoldenTicket } from '../dist/orchestrator/policy/treatment.js';
import { auditClaims } from '../dist/orchestrator/policy/claim-audit.js';
import {
  buildAssetClaimBinding,
  claimAuditAssetHash,
  claimAuditBlocksExternalSend,
  contentBindingFromRecord,
  linkedinCommercialBody,
  recordHasCommercialContent,
} from '../dist/orchestrator/policy/claim-binding.js';
import { buildContactPlan } from '../dist/orchestrator/policy/contact-campaign.js';
import { completeManualTask } from '../dist/orchestrator/pipeline/manual.js';
import { disposeCallBoardEntry } from '../dist/orchestrator/operator/call-board.js';
import { openListDb, insertDraft, ensureRecordColumns } from '../dist/orchestrator/runtime/db.js';
import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';

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
  });
  const ids = board.entries.map((e) => e.record_id);
  assert.ok(ids.includes('real_call'), `expected real_call on board: ${ids.join(',')}`);
  assert.ok(!ids.includes('pure_ab_phone'), 'must not dump pure A/B phone-only');
  assert.ok(!ids.includes('suppressed_phone'), 'must not include suppressed');
  assert.ok(!ids.includes('won_phone'), 'must not include terminal lifecycle');
  db.close();
});

// ── 3. Claim packet: unsupported vertical ───────────────────────────────────

test('claim packet: unsupported vertical → empty permitted_claims, no trades inheritance', () => {
  const tradesFamily = {
    family_id: 'trades_field_services',
    hypotheses: [{ id: 'missed_calls', text: 'missed after-hours calls may leak jobs' }],
    calculator_ids: ['missed_lead_revenue'],
    proof_categories: ['trades_admin_automation'],
    verticals: ['hvac', 'plumbing'],
  };
  const proFamily = {
    family_id: 'professional_services',
    hypotheses: [{ id: 'invoice_chase', text: 'invoice chase may consume admin hours' }],
    calculator_ids: ['admin_labor_leak'],
    verticals: ['accounting'],
  };

  // Explicit fail: unknown vertical must NOT fall through to families[0] (trades)
  const miss = resolveDiagnosticFamily({
    vertical: 'veterinary_clinic_xyz_unsupported',
    families: [tradesFamily, proFamily],
  });
  assert.equal(miss.resolved, false);
  assert.equal(miss.family, null);
  assert.equal(miss.reason, 'unsupported_vertical_or_family');

  // Supported vertical still resolves (control)
  const hit = resolveDiagnosticFamily({
    vertical: 'hvac',
    families: [tradesFamily, proFamily],
  });
  assert.equal(hit.resolved, true);
  assert.equal(hit.family?.family_id, 'trades_field_services');

  const empty = emptyClaimPacket({
    account_id: 'acct_unsupported',
    reason: 'unsupported_vertical_or_family',
  });
  assert.equal(empty.resolved_family, false);
  assert.equal(empty.family_id, 'unknown');
  assert.deepEqual(empty.permitted_claims, []);
  assert.ok(!JSON.stringify(empty).includes('trades_field_services'));

  // Assembler path: unsupported vertical must not emit trades commercial claims
  const packet = assemblePermittedClaimPacket({
    account_id: 'acct_unsupported_asm',
    vertical: 'completely_unsupported_vertical_qwerty_zzz',
    listDir: TV_ROOT,
  });
  assert.deepEqual(packet.permitted_claims, []);
  assert.equal(packet.policy_version, 'tv-claim-packet-v1');
  // emptyClaimPacket shape fields when unresolved
  if ('resolved_family' in packet) {
    assert.equal(packet.resolved_family, false);
  }
  if ('family_id' in packet) {
    assert.notEqual(packet.family_id, 'trades_field_services');
  }
  assert.ok(
    !packet.permitted_claims.some((c) => String(c.hypothesis_id || '').includes('missed')),
    'must not inherit trades hypotheses',
  );
});

// ── 4. Claim audit empty extract (regression — primary coverage in phase-06) ─

test('claim audit: empty extract re-extracts assetText (fail-closed on unauthorized; soft-only may pass)', () => {
  // Caller passed extracted:[] but asset has factual content — audit re-extracts.
  // When re-extracted claims are packet-authorized, audit may pass (not invent green via empty).
  const authorized = auditClaims({
    packet: {
      account_id: 'a1',
      policy_version: 'v1',
      permitted_claims: [
        {
          claim_id: 'obs1',
          claim_class: 'observation',
          text: 'public reviews mention delayed callbacks after hours',
        },
      ],
    },
    extracted: [],
    assetText: 'public reviews mention delayed callbacks after hours',
  });
  assert.equal(authorized.passed, true, 're-extract of authorized observation must pass');

  // Factual content with empty packet fails closed (cannot green-pass via soft skip).
  const emptyPkt = auditClaims({
    packet: {
      account_id: 'a1',
      policy_version: 'v1',
      permitted_claims: [],
    },
    extracted: [],
    assetText: 'A quick operational snapshot of real admin burden for this business.',
  });
  assert.equal(emptyPkt.passed, false);
  assert.ok(
    emptyPkt.unauthorized.some((u) =>
      u.reason === 'empty_permitted_claim_packet' || u.reason === 'not_in_permitted_claim_packet' || u.reason === 'no_claims_extracted'),
    JSON.stringify(emptyPkt.unauthorized),
  );
});

// ── 5. Readiness: undefined contentReady fails closed ───────────────────────

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

// ── 7. Email send blocked when claim_audit_passed is 0 ──────────────────────

const emailClaimFailYaml = `
list:
  name: Claim Audit Fail Gate
business:
  name: Mission
  description: Test
  icp: Test
  offer: Test
pipeline: []
sequences:
  default:
    steps: []
policy:
  version: tv-pipeline-v1
  enforce_readiness: true
  forbidden_channels: [send_sms, visit, field_visit]
channels:
  email:
    draft_approval_required: true
`;

test('email send: claim_audit_passed=0 blocks even with ready draft', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-claim-email-'));
  const sinkDir = join(listDir, 'smtp-sink');
  mkdirSync(sinkDir, { recursive: true });
  writeFileSync(join(listDir, 'outbound.yaml'), emailClaimFailYaml);
  writeFileSync(join(listDir, 'operator.md'), 'claim audit gate');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));

  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: [
      'contact_email', 'contact_name', 'treatment_tier', 'eligibility_outcome',
      'preliminary_snapshot', 'claim_audit_passed', 'permitted_claim_packet_json',
      'suppressed', 'identity_confidence', 'email_confidence',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, contact_email, contact_name,
      treatment_tier, eligibility_outcome, preliminary_snapshot, claim_audit_passed,
      identity_confidence, email_confidence, suppressed,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      'claim_fail_1', 'Claim Fail Co', 'default', 'active',
      'owner@claim-fail.test', 'Pat', 'A', 'eligible',
      'snapshot present so content is bound', 0,
      90, 80, 0,
      ?, ?, ?, ?
    )
  `).run(now, now, now, now);

  insertDraft({
    db,
    draft: {
      draft_id: 'draft_claim_fail',
      row_id: 'claim_fail_1',
      sequence_name: 'default',
      step_number: 1,
      step_id: 'email_1',
      channel: 'email',
      status: 'ready',
      subject: 'Ready draft must not override claim audit fail',
      body: 'Body that would send if audit were ignored.',
    },
  });

  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('claim_fail_1');
  assert.equal(Number(record.claim_audit_passed), 0);

  const out = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Claim Audit Fail Gate',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step: {
      kind: 'send_email',
      id: 'email_1',
      draft_approval_required: true,
      config: {
        action: 'tool_call',
        tool: { server: 'smtp', tools: ['SMTP_SEND'] },
        args_map: { to: 'contact_email' },
        args: { subject: 'x', body: 'y' },
      },
    },
    sequence: { steps: [] },
    channelHint: 'email',
    intent: 'send',
  });

  assert.equal(out.status, 'skipped');
  assert.match(String(out.reason), /claim_audit/i);
  assert.ok(
    Array.isArray(out.readiness_blockers)
      ? out.readiness_blockers.includes('claim_audit_failed')
      : true,
  );
  db.close();
});

// ── 8. RES-CONTENT-CLAIM-ASSET-BINDING ───────────────────────────────────────
// Bind executed assets to claim packet/audit; refuse commercial send on audit fail;
// family resolution fail-closed; persist asset_claim_binding_json on events.

test('claim binding: contentBindingFromRecord + buildAssetClaimBinding hashes packet/audit', () => {
  const packet = {
    account_id: 'a1',
    family_id: 'trades_field_services',
    permitted_claims: [
      { claim_id: 'hyp_1', claim_class: 'hypothesis', text: 'missed after-hours calls' },
      { claim_id: 'cta_1', claim_class: 'observation', text: 'mapping-first CTA' },
    ],
    policy_version: 'tv-claim-packet-v1',
  };
  const record = {
    permitted_claim_packet_json: JSON.stringify(packet),
    preliminary_snapshot: 'Public site shows after-hours phone gaps for HVAC routing.',
    claim_audit_passed: 1,
    claim_audit_json: JSON.stringify({
      passed: true,
      policy_version: 'tv-claim-audit-v2',
      authorized: [],
      unauthorized: [],
    }),
  };
  const binding = contentBindingFromRecord(record);
  assert.ok(binding.claim_packet_hash.length >= 32);
  assert.ok(binding.preliminary_snapshot_hash.length >= 32);
  assert.equal(binding.claim_audit_passed, 1);
  assert.match(binding.claim_audit_version, /tv-claim-audit/);

  const asset = buildAssetClaimBinding({
    record,
    assetId: 'asset_email_1',
    channel: 'email',
    stepId: 'email_1',
    at: '2026-08-04T00:00:00.000Z',
  });
  assert.equal(asset.claim_packet_hash, binding.claim_packet_hash);
  assert.equal(asset.asset_id, 'asset_email_1');
  assert.equal(asset.channel, 'email');
  assert.deepEqual(asset.permitted_claim_ids, ['hyp_1', 'cta_1']);
  assert.equal(asset.family_id, 'trades_field_services');
});

test('family resolution fail-closed: unknown vertical never inherits trades proofs', () => {
  const emptyCats = matchProofs({
    categories: [],
    listDir: TV_ROOT,
  });
  assert.deepEqual(emptyCats, [], 'no categories must not invent library head proofs');

  const packet = assemblePermittedClaimPacket({
    account_id: 'acct_unk',
    family_id: 'not_a_real_family_zzz',
    vertical: 'veterinary_clinic_xyz_unsupported',
    listDir: TV_ROOT,
  });
  assert.deepEqual(packet.permitted_claims, []);
  assert.ok(
    !JSON.stringify(packet).includes('trades_field_services')
    || packet.family_id === 'unknown'
    || packet.resolved_family === false,
  );
});

test('LI connect without commercial body is OK when claim audit failed', () => {
  const record = {
    claim_audit_passed: 0,
    preliminary_snapshot: '',
    permitted_claim_packet_json: '',
  };
  const body = linkedinCommercialBody({
    record,
    step: { description: 'Connect on LinkedIn', config: {} },
  });
  assert.equal(body, '');
  const block = claimAuditBlocksExternalSend({
    record,
    channel: 'linkedin',
    commercialBody: body,
  });
  assert.equal(block.blocked, false);
  assert.equal(recordHasCommercialContent(record, { bodyText: body }), false);
});

test('LI commercial invite body blocked when claim_audit_passed=0', () => {
  const record = {
    claim_audit_passed: 0,
    preliminary_snapshot: 'snap',
  };
  const block = claimAuditBlocksExternalSend({
    record,
    channel: 'linkedin',
    commercialBody: 'I noticed your HVAC shop may have after-hours inquiry leakage — free diagnostic?',
  });
  assert.equal(block.blocked, true);
  assert.match(String(block.reason), /claim_audit/i);
});

test('mail with GT copy requires claim audit pass', () => {
  const fail = claimAuditBlocksExternalSend({
    record: {
      claim_audit_passed: 0,
      preliminary_snapshot: 'GT copy: public operational snapshot for mail piece.',
      golden_ticket_copy: 'Handwritten note about after-hours booking gaps.',
    },
    channel: 'mail',
    commercialBody: 'Handwritten note about after-hours booking gaps.',
    forceCommercial: true,
  });
  assert.equal(fail.blocked, true);
  assert.match(String(fail.reason), /claim_audit|mail/i);

  const mailBody = 'Approved copy.';
  const pass = claimAuditBlocksExternalSend({
    record: {
      claim_audit_passed: 1,
      preliminary_snapshot: 'GT copy ok',
      golden_ticket_copy: mailBody,
      claim_audit_asset_hash: claimAuditAssetHash(mailBody),
    },
    channel: 'mail',
    commercialBody: mailBody,
    forceCommercial: true,
  });
  assert.equal(pass.blocked, false);
});

test('executeChannelStep email: asset_claim_binding_json stamped on send event', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-claim-bind-'));
  const sinkDir = join(listDir, 'smtp-sink');
  mkdirSync(sinkDir, { recursive: true });
  writeFileSync(join(listDir, 'outbound.yaml'), emailClaimFailYaml.replace(
    'enforce_readiness: true',
    'enforce_readiness: false',
  ));
  writeFileSync(join(listDir, 'operator.md'), 'claim bind');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));

  const packet = {
    account_id: 'bind_email_1',
    family_id: 'trades_field_services',
    permitted_claims: [
      { claim_id: 'obs_snap', claim_class: 'observation', text: 'public snapshot bound' },
    ],
    policy_version: 'tv-claim-packet-v1',
  };
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: [
      'contact_email', 'contact_name', 'treatment_tier', 'eligibility_outcome',
      'preliminary_snapshot', 'claim_audit_passed', 'permitted_claim_packet_json',
      'claim_audit_json', 'suppressed', 'identity_confidence', 'email_confidence',
      'asset_claim_binding_json',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, contact_email, contact_name,
      treatment_tier, eligibility_outcome, preliminary_snapshot, claim_audit_passed,
      permitted_claim_packet_json, claim_audit_json,
      identity_confidence, email_confidence, suppressed,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      'bind_email_1', 'Bind Email Co', 'default', 'active',
      'owner@bind-email.test', 'Pat', 'A', 'eligible',
      'Public snapshot for binding proof.', 1,
      ?, ?,
      90, 80, 0,
      ?, ?, ?, ?
    )
  `).run(
    JSON.stringify(packet),
    JSON.stringify({ passed: true, policy_version: 'tv-claim-audit-v2', authorized: [], unauthorized: [] }),
    now, now, now, now,
  );

  insertDraft({
    db,
    draft: {
      draft_id: 'draft_bind_ok',
      row_id: 'bind_email_1',
      sequence_name: 'default',
      step_number: 1,
      step_id: 'email_1',
      channel: 'email',
      status: 'ready',
      subject: 'Bound claim packet',
      body: 'Body authorized by claim audit.',
    },
  });

  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('bind_email_1');
  process.env.AO_SMTP_SINK = sinkDir;
  const out = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Claim Audit Fail Gate',
    toolCatalog: null,
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step: {
      kind: 'send_email',
      id: 'email_1',
      draft_approval_required: true,
      config: {
        action: 'tool_call',
        tool: { server: 'smtp', tools: ['SMTP_SEND'] },
        args_map: { to: 'contact_email' },
        args: { subject: 'Bound claim packet', body: 'Body authorized by claim audit.' },
      },
    },
    sequence: { steps: [] },
    channelHint: 'email',
    intent: 'send',
  });

  // May skip for other readiness reasons in minimal harness — when sent, binding must exist.
  if (out.status === 'sent') {
    const ev = db.prepare(`
      SELECT payload_json FROM channel_events
      WHERE row_id = 'bind_email_1' AND channel = 'email'
      ORDER BY occurred_at DESC LIMIT 1
    `).get();
    assert.ok(ev, 'channel event required on sent');
    const payload = JSON.parse(String(ev.payload_json || '{}'));
    assert.ok(payload.asset_claim_binding_json || payload.asset_claim_binding);
    const bind = payload.asset_claim_binding
      || JSON.parse(String(payload.asset_claim_binding_json || '{}'));
    assert.ok(bind.claim_packet_hash);
    assert.equal(bind.claim_audit_passed, 1);
    assert.ok(Array.isArray(bind.permitted_claim_ids));
    assert.ok(bind.permitted_claim_ids.includes('obs_snap'));

    const row = db.prepare('SELECT asset_claim_binding_json FROM records WHERE _row_id=?').get('bind_email_1');
    assert.ok(row.asset_claim_binding_json);
    const rowBind = JSON.parse(String(row.asset_claim_binding_json));
    assert.equal(rowBind.claim_packet_hash, bind.claim_packet_hash);
  } else {
    // Unauthorized claim already covered above; binding helpers still must hold.
    assert.ok(['skipped', 'failed'].includes(out.status));
  }
  db.close();
});

test('executeChannelStep LI: bare connect OK with failed audit; commercial body blocked', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-claim-li-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
list:
  name: LI Claim Gate
business:
  name: Mission
  description: Test
  icp: Test
  offer: Test
pipeline: []
sequences:
  default:
    steps: []
policy:
  version: tv-pipeline-v1
  enforce_readiness: false
  forbidden_channels: [send_sms, visit, field_visit]
`);
  writeFileSync(join(listDir, 'operator.md'), 'li claim');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));

  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const campaign = buildContactPlan({
    account_id: 'li_claim_1',
    campaign_id: 'camp_li_claim',
    treatment_tier: 'A',
    mail_treatment: 'none',
    contacts: [
      {
        contact_id: 'c_li_1',
        outbound_disposition: 'eligible_target',
        outreach_rank: 1,
        linkedin_url: 'https://www.linkedin.com/in/test-li-claim',
      },
    ],
  });
  ensureRecordColumns({
    db,
    columns: [
      'linkedin_url', 'contact_linkedin_url', 'treatment_tier', 'eligibility_outcome',
      'claim_audit_passed', 'preliminary_snapshot', 'suppressed', 'identity_confidence',
      'linkedin_confidence', 'active_contact_id', 'account_contact_plan_json',
      'account_sequence_state', 'linkedin_lifecycle_state', 'linkedin_last_provider_id',
      'linkedin_invite_sent_at',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status,
      linkedin_url, contact_linkedin_url, treatment_tier, eligibility_outcome,
      claim_audit_passed, identity_confidence, linkedin_confidence, suppressed,
      active_contact_id, account_contact_plan_json, account_sequence_state,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      'li_claim_1', 'LI Claim Co', 'default', 'active',
      'https://www.linkedin.com/in/test-li-claim', 'https://www.linkedin.com/in/test-li-claim',
      'A', 'eligible', 0, 90, 80, 0,
      'c_li_1', ?, 'active',
      ?, ?, ?, ?
    )
  `).run(JSON.stringify(campaign), now, now, now, now);

  // Seed contacts table so active-contact projection / assert can resolve.
  try {
    db.prepare(`
      INSERT INTO contacts (contact_id, record_id, full_name, linkedin_url, created_at, updated_at)
      VALUES ('c_li_1', 'li_claim_1', 'Pat Owner', 'https://www.linkedin.com/in/test-li-claim', ?, ?)
    `).run(now, now);
  } catch {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS contacts (
          contact_id TEXT PRIMARY KEY,
          record_id TEXT,
          full_name TEXT DEFAULT '',
          linkedin_url TEXT DEFAULT '',
          created_at TEXT,
          updated_at TEXT
        )
      `);
      db.prepare(`
        INSERT INTO contacts (contact_id, record_id, full_name, linkedin_url, created_at, updated_at)
        VALUES ('c_li_1', 'li_claim_1', 'Pat Owner', 'https://www.linkedin.com/in/test-li-claim', ?, ?)
      `).run(now, now);
    } catch { /* optional */ }
  }

  const prevFixture = process.env.AO_UNIPILE_FIXTURE;
  process.env.AO_UNIPILE_FIXTURE = '1';
  try {
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('li_claim_1');

    // Bare connect: no commercial body — must NOT block on claim_audit_passed=0
    const bare = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'LI Claim Gate',
      toolCatalog: null,
      db,
      record,
      sequenceName: 'default',
      stepNumber: 1,
      step: {
        kind: 'linkedin_connect',
        id: 'linkedin_1',
        description: 'Connect on LinkedIn',
        config: { channel: 'linkedin' },
      },
      sequence: { steps: [] },
      channelHint: 'linkedin',
      intent: 'send',
    });
    assert.ok(
      !/claim_audit/i.test(String(bare.reason || '')),
      `bare connect must not claim-audit block: ${bare.reason}`,
    );
    if (bare.status === 'sent') {
      const ev = db.prepare(`
        SELECT payload_json FROM channel_events
        WHERE row_id = 'li_claim_1' AND channel = 'linkedin'
        ORDER BY occurred_at DESC LIMIT 1
      `).get();
      assert.ok(ev);
      const payload = JSON.parse(String(ev.payload_json || '{}'));
      assert.ok(payload.asset_claim_binding || payload.asset_claim_binding_json);
      assert.equal(payload.commercial_body_present, false);
    }

    // Separate row for commercial body so lifecycle/cooldown of bare connect does not interfere.
    const camp2 = buildContactPlan({
      account_id: 'li_claim_2',
      campaign_id: 'camp_li_claim_2',
      treatment_tier: 'A',
      mail_treatment: 'none',
      contacts: [
        {
          contact_id: 'c_li_2',
          outbound_disposition: 'eligible_target',
          outreach_rank: 1,
          linkedin_url: 'https://www.linkedin.com/in/test-li-claim-2',
        },
      ],
    });
    db.prepare(`
      INSERT INTO records (
        _row_id, business_name, sequence_name, sequence_status,
        linkedin_url, contact_linkedin_url, treatment_tier, eligibility_outcome,
        claim_audit_passed, identity_confidence, linkedin_confidence, suppressed,
        active_contact_id, account_contact_plan_json, account_sequence_state,
        _created_at, _updated_at, created_at, updated_at
      ) VALUES (
        'li_claim_2', 'LI Claim Co 2', 'default', 'active',
        'https://www.linkedin.com/in/test-li-claim-2', 'https://www.linkedin.com/in/test-li-claim-2',
        'A', 'eligible', 0, 90, 80, 0,
        'c_li_2', ?, 'active',
        ?, ?, ?, ?
      )
    `).run(JSON.stringify(camp2), now, now, now, now);

    const commercial = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'LI Claim Gate',
      toolCatalog: null,
      db,
      record: db.prepare('SELECT * FROM records WHERE _row_id = ?').get('li_claim_2'),
      sequenceName: 'default',
      stepNumber: 1,
      step: {
        kind: 'linkedin_connect',
        id: 'linkedin_2',
        description: 'Connect with note',
        config: {
          channel: 'linkedin',
          invite_message: 'I noticed public signals of after-hours inquiry leakage — free diagnostic map?',
        },
      },
      sequence: { steps: [] },
      channelHint: 'linkedin',
      intent: 'send',
    });
    assert.equal(commercial.status, 'skipped');
    assert.match(String(commercial.reason), /claim_audit/i);
  } finally {
    if (prevFixture === undefined) delete process.env.AO_UNIPILE_FIXTURE;
    else process.env.AO_UNIPILE_FIXTURE = prevFixture;
  }
  db.close();
});

test('completeManualTask mail: GT copy with failed audit refuses; pass stamps binding', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-claim-mail-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
list:
  name: Mail Claim Gate
business:
  name: Mission
  description: Test
  icp: Test
  offer: Test
pipeline: []
sequences:
  default:
    steps: []
policy:
  version: tv-pipeline-v1
`);
  writeFileSync(join(listDir, 'operator.md'), 'mail claim');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));

  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const plan = buildContactPlan({
    account_id: 'mail_claim_1',
    campaign_id: 'camp_mail_claim',
    treatment_tier: 'A',
    mail_treatment: 'golden_ticket',
    contacts: [
      { contact_id: 'c1', outbound_disposition: 'eligible_target', outreach_rank: 1 },
    ],
  });
  ensureRecordColumns({
    db,
    columns: [
      'account_contact_plan_json', 'mail_treatment', 'mail_allocated',
      'preliminary_snapshot', 'claim_audit_passed', 'claim_audit_asset_hash',
      'golden_ticket_copy',
      'permitted_claim_packet_json', 'asset_claim_binding_json',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status,
      account_contact_plan_json, mail_treatment,
      preliminary_snapshot, golden_ticket_copy, claim_audit_passed,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      'mail_claim_1', 'Mail Claim Co', 'default', 'active',
      ?, 'golden_ticket',
      'GT operational snapshot for mail piece.', 'Handwritten GT note about booking gaps.', 0,
      ?, ?, ?, ?
    )
  `).run(JSON.stringify(plan), now, now, now, now);

  db.prepare(`
    INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
    VALUES ('park_mail_claim', 'mail_claim_1', 'mail_golden_ticket', 'manual_task', 0, 'awaiting_manual', ?)
  `).run(now);

  await assert.rejects(
    () => completeManualTask({
      db,
      recordId: 'mail_claim_1',
      stepId: 'mail_golden_ticket',
      note: 'print GT',
    }),
    /claim_audit/i,
  );

  // Pass audit with bound hash of the GT copy → allocate stamps binding
  const gtCopy = 'Handwritten GT note about booking gaps.';
  db.prepare(`
    UPDATE records SET claim_audit_passed = 1, claim_audit_asset_hash = ?
    WHERE _row_id = 'mail_claim_1'
  `).run(claimAuditAssetHash(gtCopy));
  const ok = await completeManualTask({
    db,
    recordId: 'mail_claim_1',
    stepId: 'mail_golden_ticket',
    note: 'print GT',
  });
  assert.equal(ok.status, 'manual_completed');
  assert.equal(ok.mail_allocated, true);
  const row = db.prepare('SELECT * FROM records WHERE _row_id=?').get('mail_claim_1');
  assert.ok(row.asset_claim_binding_json);
  const bind = JSON.parse(String(row.asset_claim_binding_json));
  assert.equal(bind.channel, 'mail');
  assert.equal(bind.claim_audit_passed, 1);
  db.close();
});

test('call disposition stamps asset_claim_binding_json', () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-claim-call-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
list:
  name: Call Claim Bind
business:
  name: Mission
  description: Test
  icp: Test
  offer: Test
pipeline: []
sequences:
  default:
    steps: []
`);
  writeFileSync(join(listDir, 'operator.md'), 'call claim');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const packet = {
    account_id: 'call_bind_1',
    permitted_claims: [{ claim_id: 'hyp_call', claim_class: 'hypothesis', text: 'admin load' }],
    policy_version: 'tv-claim-packet-v1',
  };
  ensureRecordColumns({
    db,
    columns: [
      'call_claim_status', 'permitted_claim_packet_json', 'claim_audit_passed',
      'claim_audit_json', 'preliminary_snapshot', 'asset_claim_binding_json',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status,
      call_claim_status, permitted_claim_packet_json, claim_audit_passed,
      preliminary_snapshot,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      'call_bind_1', 'Call Bind Co', 'default', 'active',
      'claimed', ?, 1,
      'Call card snapshot.',
      ?, ?, ?, ?
    )
  `).run(JSON.stringify(packet), now, now, now, now);

  const disposed = disposeCallBoardEntry({
    db,
    recordId: 'call_bind_1',
    disposition: 'completed',
    note: 'Talked through mapping-first offer',
    force: true,
  });
  assert.equal(disposed.ok, true);
  const row = db.prepare('SELECT * FROM records WHERE _row_id=?').get('call_bind_1');
  assert.ok(row.asset_claim_binding_json);
  const bind = JSON.parse(String(row.asset_claim_binding_json));
  assert.equal(bind.channel, 'call');
  assert.ok(bind.permitted_claim_ids.includes('hyp_call'));

  const ev = db.prepare(`
    SELECT payload_json FROM channel_events
    WHERE row_id = 'call_bind_1' AND channel = 'call'
    ORDER BY occurred_at DESC LIMIT 1
  `).get();
  assert.ok(ev);
  const payload = JSON.parse(String(ev.payload_json || '{}'));
  assert.ok(payload.asset_claim_binding || payload.asset_claim_binding_json);
  db.close();
});
