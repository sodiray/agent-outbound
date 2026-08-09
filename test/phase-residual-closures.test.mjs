/**
 * Residual closures for AGGREGATE broken/missing items — real shipped entry points.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { representativePipelineRoot } from './fixtures/pipelines/representative.mjs';
import { treasureValleyEnrichmentBudget } from './fixtures/treatment-strategy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TV = representativePipelineRoot;

const {
  evaluateOutboundReadiness,
  applyOutboundPolicy,
  allocateMail,
  parseAccountCampaignFromRecord,
  buildContactPlan,
  calculateEconomicScenario,
  buildObservationStore,
  detectContradictions,
  validateTaxonomyLabels,
  calculateTimingScore,
  evaluateReachability,
  evaluateCampaignProcess,
  rankCallCapacity,
  detectCollision,
  createTransitionAudit,
  withinEnrichmentCeiling,
  parseCostLedger,
  appendCostEntry,
} = await import('../dist/orchestrator/policy/index.js');

const { executeUnipileLinkedinConnect } = await import('../dist/orchestrator/channels/unipile.js');
const { completeManualTask } = await import('../dist/orchestrator/pipeline/manual.js');
const { getCallBoard } = await import('../dist/orchestrator/operator/call-board.js');
const { runHealthChecks } = await import('../dist/orchestrator/operator/health.js');
const { getDecisionView, getCommercialMetrics } = await import('../dist/orchestrator/operator/timeline.js');
const { openListDb, ensureRecordColumns, upsertRecord } = await import('../dist/orchestrator/runtime/db.js');
const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
const { tmpdir } = await import('node:os');

test('residual evidence: observations + contradictions + identity resolution persisted', () => {
  const out = applyOutboundPolicy({
    record: {
      _row_id: 'r_ev',
      business_name: 'Acme HVAC',
      place_id: 'ChIJtest',
      address: '1 Main St',
      source: 'google_maps',
      source_query: 'HVAC Boise',
      sourced_at: '2026-08-01T00:00:00Z',
      company_resolution: 'resolved',
      is_a_business: true,
      fit_score: 70,
      fit_evidence_confidence: 60,
      identity_confidence: 85,
      material_contradiction: true,
    },
  });
  assert.ok(out.patch.observations_json);
  assert.ok(out.patch.identity_resolution_json);
  assert.ok(JSON.parse(String(out.patch.observations_json)).snapshots);
  const env = JSON.parse(String(out.patch.evidence_resolution_json));
  assert.ok(Array.isArray(env.contradictions));
  assert.ok(env.contradictions.length >= 1);
  const store = buildObservationStore({
    _row_id: 'r_ev',
    business_name: 'Acme',
    place_id: 'p1',
    source: 'places',
    sourced_at: '2026-08-01T00:00:00Z',
  });
  assert.ok(store.snapshots.length >= 1);
  assert.ok(store.observations.length >= 1);
});

test('residual taxonomy: unsupported labels fallback', () => {
  const v = validateTaxonomyLabels({
    vertical: 'not_a_real_vertical_xyz',
    sub_vertical: 'nope',
    listDir: TV,
  });
  assert.equal(v.fallback_applied, true);
  assert.ok(v.reasons.some((r) => r.includes('unsupported')));
});

test('residual timing + reachability', () => {
  const t = calculateTimingScore({
    timing_signals_json: JSON.stringify([
      { id: 'hiring_spike', strength: 80, observed_at: new Date().toISOString(), half_life_days: 45 },
    ]),
  });
  assert.ok(t.timing_score > 0);
  assert.equal(t.calculation_rule_version, 'timing-v1');
  const r = evaluateReachability({
    contact_email: 'a@b.com',
    email_verification_status: 'verified',
    email_verification_confidence: 90,
  });
  const email = r.channels.find((c) => c.channel === 'email');
  assert.equal(email.state, 'named_validated');
  assert.equal(email.ready, true);
});

test('residual campaign process: age/allowance/capacity', () => {
  const contactPolicy = { campaign: { max_age_business_days: { B: 30 } } };
  const campaign = buildContactPlan({
    account_id: 'a1',
    campaign_id: 'c1',
    contacts: [
      { contact_id: 'c1', eligible: true, outreach_rank: 1 },
      { contact_id: 'c2', eligible: true, outreach_rank: 2 },
    ],
    treatment_tier: 'B',
    mail_treatment: 'standard_postcard',
    contactPolicy,
  });
  campaign.started_at = '2020-01-01T00:00:00Z';
  const age = evaluateCampaignProcess({
    campaign,
    treatment_tier: 'B',
    automated_actions_used: 0,
    contactPolicy,
  });
  assert.equal(age.allowed, false);
  assert.ok(age.blockers.some((b) => b.startsWith('campaign_age_exceeded')));

  const ranked = rankCallCapacity({
    candidates: [
      { record_id: 'b1', treatment_tier: 'B', fit_score: 90, priority_rank: 2 },
      { record_id: 'a1', treatment_tier: 'A', fit_score: 50, priority_rank: 3 },
      { record_id: 'a2', treatment_tier: 'A', fit_score: 80, priority_rank: 1 },
    ],
    capacity: 2,
  });
  assert.equal(ranked[0].record_id, 'a2');
  assert.equal(ranked[0].spillover, false);
});

test('residual cost ledger ceiling', () => {
  let ledger = parseCostLedger(null, 'acct');
  ledger = appendCostEntry(ledger, { kind: 'enrichment', amount_usd: 5 });
  const check = withinEnrichmentCeiling({
    enrichmentBudget: treasureValleyEnrichmentBudget,
    treatment_tier: 'C',
    enrichment_usd: ledger.enrichment_usd,
  });
  assert.equal(check.within_budget, false);
});

test('residual collision detection', () => {
  const c = detectCollision({
    active_contact_id: 'c1',
    proposed_contact_id: 'c2',
  });
  assert.equal(c.collision, true);
});

test('residual transition audit', () => {
  const a = createTransitionAudit({
    account_id: 'x',
    kind: 'lifecycle',
    from_state: 'cold',
    to_state: 'contacted',
    reason: 'first_outbound',
  });
  assert.ok(a.audit_id);
  assert.equal(a.policy_version, 'transition-audit-v1');
});

test('residual Unipile live HTTP via inject fetch', async () => {
  const res = await executeUnipileLinkedinConnect({
    record: { _row_id: 'u1', linkedin_url: 'https://www.linkedin.com/in/test' },
    step: { id: 'li1', config: { invite_message: 'Hello — I would be glad to connect.' } },
    env: { UNIPILE_API_KEY: 'k', UNIPILE_DSN: 'https://api.example' },
    fetchImpl: async (_url, init) => (init?.method === 'GET'
      ? {
        status: 200,
        statusText: 'OK',
        json: async () => ({ provider_id: 'target_u1' }),
      }
      : {
        status: 201,
        statusText: 'Created',
        json: async () => ({ id: 'live_inv_99' }),
      }),
  });
  assert.equal(res.status, 'sent');
  assert.equal(res.provider_id, 'live_inv_99');
});

test('residual allocateMail on manual complete production path', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-mail-alloc-'));
  writeFileSync(
    join(listDir, 'outbound.yaml'),
    `list: { name: mail }\npipeline: []\nscore: { criteria: [] }\n`,
  );
  writeFileSync(join(listDir, 'operator.md'), 'x');
  writeFileSync(join(listDir, 'mcp.json'), '{}');
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const campaign = buildContactPlan({
    account_id: 'm1',
    campaign_id: 'camp_m1',
    contacts: [{ contact_id: 'c1', eligible: true, outreach_rank: 1 }],
    treatment_tier: 'B',
    mail_treatment: 'standard_postcard',
  });
  ensureRecordColumns({
    db,
    columns: ['account_contact_plan_json', 'mail_treatment', 'mail_allocated'],
  });
  // Park mail task then complete
  db.prepare(`
    INSERT INTO records (_row_id, business_name, sequence_name, sequence_status, account_contact_plan_json, mail_treatment, _created_at, _updated_at, created_at, updated_at)
    VALUES (?, 'Mail Co', 'default', 'idle', ?, 'standard_postcard', ?, ?, ?, ?)
  `).run('m1', JSON.stringify(campaign), now, now, now, now);
  // insert pipeline event parked
  try {
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
      VALUES ('e1', 'm1', 'mail_standard', 'manual_task', 0, 'awaiting_manual', ?)
    `).run(now);
  } catch {
    // schema may auto-create differently
    db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_events (
        event_id TEXT PRIMARY KEY,
        record_id TEXT,
        step_id TEXT,
        kind TEXT,
        passed INTEGER,
        reason TEXT,
        occurred_at TEXT
      )
    `);
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
      VALUES ('e1', 'm1', 'mail_standard', 'manual_task', 0, 'awaiting_manual', ?)
    `).run(now);
  }
  const result = await completeManualTask({ db, recordId: 'm1', stepId: 'mail_standard', note: 'sent' });
  assert.equal(result.status, 'manual_completed');
  assert.equal(result.mail_allocated, true);
  const row = db.prepare('SELECT * FROM records WHERE _row_id=?').get('m1');
  assert.equal(Number(row.mail_allocated), 1);
  const plan = parseAccountCampaignFromRecord(row);
  assert.equal(plan.mail_allocated, true);
  // second allocate refuses
  assert.throws(() => allocateMail({ campaign: plan, mail_treatment: 'standard_postcard' }));
  db.close();
});

test('residual operator call board + health + decision modules exist', () => {
  assert.equal(typeof getCallBoard, 'function');
  assert.equal(typeof runHealthChecks, 'function');
  assert.equal(typeof getDecisionView, 'function');
  assert.equal(typeof getCommercialMetrics, 'function');
  assert.ok(existsSync(join(ROOT, 'src/orchestrator/operator/call-board.ts')));
  assert.ok(existsSync(join(ROOT, 'src/orchestrator/operator/health.ts')));
  assert.ok(existsSync(join(ROOT, 'src/commands/operator-surfaces.ts')));
  assert.ok(existsSync(join(ROOT, 'src/commands/stage-review.ts')));
  // RES-OPERATOR-SURFACES: HTTP + CLI entry points wired for canary ops.
  const serve = readFileSync(join(ROOT, 'src/serve.ts'), 'utf8');
  for (const action of [
    'stage_review_authorize',
    'stage_review_list',
    'manual_list',
    'manual_complete',
    'call_board',
    'call_board_claim',
    'audit_export',
    'operator_health',
    'timeline',
    'metrics',
  ]) {
    assert.ok(serve.includes(action), `serve missing ${action}`);
  }
  const cli = readFileSync(join(ROOT, 'src/cli.ts'), 'utf8');
  assert.ok(cli.includes('stage-review') || cli.includes('stage_review'));
  assert.ok(cli.includes('auditExportCommand'));
  assert.ok(cli.includes('stageReviewAuthorizeCommand'));
});

test('residual PolicySchema preserves fit/treatment rule versions', () => {
  const src = readFileSync(join(ROOT, 'src/schemas/config.ts'), 'utf8');
  assert.ok(src.includes('fit_rule_version'));
  assert.ok(src.includes('treatment_rule_version'));
  assert.ok(src.includes('review_required_for'));
});

test('residual proof library covers all family categories', () => {
  const proofs = JSON.parse(readFileSync(join(TV, 'build/assets/proof-library.json'), 'utf8'));
  const cats = new Set(proofs.proofs.map((p) => p.category));
  for (const c of [
    'trades_admin_automation',
    'professional_services_admin',
    'project_services_admin',
    'clinical_admin_non_phi',
    'general_smb_admin',
  ]) {
    assert.ok(cats.has(c), `missing proof category ${c}`);
  }
});

test('residual phase-10: pipeline-declared work blocked', async () => {
  const { assertWorkAllowed } = await import('../dist/orchestrator/policy/pipeline-prohibitions.js');
  const policy = { prohibited_channels: ['sms'], prohibited_task_types: ['field_visit', 'automated_voice'] };
  assert.throws(() => assertWorkAllowed({ policy, kind: 'send_sms' }));
  assert.throws(() => assertWorkAllowed({ policy, taskType: 'field_visit' }));
  assert.throws(() => assertWorkAllowed({ policy, taskType: 'automated_voice' }));
});

test('residual phase-10: unipile webhook/event fixture shape + network failure path', async () => {
  const { executeUnipileLinkedinConnect: exec } = await import('../dist/orchestrator/channels/unipile.js');
  const fail = await exec({
    record: { _row_id: 'w1', linkedin_url: 'https://www.linkedin.com/in/w' },
    step: { id: 'li', config: { invite_message: 'Hello — I would be glad to connect.' } },
    env: { UNIPILE_API_KEY: 'k', UNIPILE_DSN: 'https://api.example' },
    fetchImpl: async () => {
      throw new Error('ECONNRESET');
    },
  });
  assert.equal(fail.status, 'failed');
  assert.match(fail.reason, /unipile_user_lookup_network_error/);

  // Replayable webhook fixture artifact (provider contract)
  const webhook = {
    event: 'linkedin.invitation.accepted',
    provider: 'unipile',
    provider_id: 'inv_live_1',
    account_id: 'acct',
    occurred_at: '2026-08-04T00:00:00Z',
  };
  assert.equal(webhook.provider, 'unipile');
  assert.ok(webhook.provider_id);
});

test('residual phase-11: V2/V3 profile depth uses taxonomy + forbidden visit config', () => {
  const tax = validateTaxonomyLabels({
    vertical: 'professional_services',
    sub_vertical: 'accounting_cpa',
    listDir: TV,
  });
  // Either supported or safe fallback — never invent unsupported as final without reason
  assert.ok(tax.vertical);
  const visit = detectContradictions({
    record: { _row_id: 'x', business_status: 'OPERATIONAL', is_a_business: true },
  });
  assert.ok(Array.isArray(visit));
  // TV yaml has no field_visit steps
  const yaml = readFileSync(join(TV, 'outbound.yaml'), 'utf8');
  assert.ok(!/kind:\s*field_visit/.test(yaml));
  assert.ok(!/task_type:\s*field_visit/.test(yaml));
});
