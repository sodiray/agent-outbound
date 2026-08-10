/**
 * Pre-provider enrichment cost ceiling.
 *
 * Bug classes:
 * 1. Tiered record over enrichment spend still calls tool_call / model provider
 * 2. policy_apply (cheap local) wrongly blocked by ceiling
 * 3. Pre-tier early enrich gated when treatment/candidate tier not set yet
 * 4. wrong tier ceiling selected (A/B/C/D/hold/foundational/golden)
 * 5. cost_events not preferred when db present (stale ledger understates spend)
 *
 * Surfaces: evaluateEnrichmentCeilingGate (+ helpers) and executeEnrichmentAction.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  evaluateEnrichmentCeilingGate,
  isExpensiveEnrichProviderAction,
  recordHasEnrichmentTier,
  withinEnrichmentCeiling,
  enrichmentSpendUsd,
  parseCostLedger,
  appendCostEntry,
  ledgerFromCostEventRows,
} from '../dist/orchestrator/policy/cost-ledger.js';
import { treasureValleyEnrichmentBudget, treasureValleyTreatmentStrategy } from './fixtures/treatment-strategy.mjs';

const ENRICHMENT_COST_CEILINGS = treasureValleyEnrichmentBudget.ceilings;
const TIER_CEILINGS = ENRICHMENT_COST_CEILINGS.tiers;
import {
  executeEnrichmentAction,
  executeEnrichmentStepOnRecords,
  isEnrichmentCeilingSkip,
} from '../dist/orchestrator/enrichment/runner.js';
import {
  openListDb,
  ensureRecordColumns,
  insertCostEvent,
} from '../dist/orchestrator/runtime/db.js';
import { cleanupSockets, withActivityContext } from '../dist/orchestrator/runtime/activity.js';

// Ensure fixture mode cannot bypass the pre-provider gate in this file.
delete process.env.AO_PIPELINE_FIXTURE;
delete process.env.AO_STEP_FIXTURE;

const dummySchema = { parse: (x) => x };

const overspentRecord = (tier = 'C', enrichmentUsd = 5) => ({
  _row_id: 'ceil_acct_1',
  treatment_tier: tier,
  enrichment_cost_usd: enrichmentUsd,
  cost_ledger_json: JSON.stringify(
    appendCostEntry(parseCostLedger(null, 'ceil_acct_1'), {
      kind: 'enrichment',
      amount_usd: enrichmentUsd,
    }),
  ),
});

const underCeilingRecord = (tier = 'C', enrichmentUsd = 0.1) => ({
  _row_id: 'ceil_acct_under',
  treatment_tier: tier,
  enrichment_cost_usd: enrichmentUsd,
});

// ---------------------------------------------------------------------------
// withinEnrichmentCeiling — tier table
// ---------------------------------------------------------------------------

test('withinEnrichmentCeiling: tier table (at/under/over + golden floor)', () => {
  const cases = [
    { name: 'A under', tier: 'A', spend: 2.99, within: true, ceiling: TIER_CEILINGS.A },
    { name: 'A at ceiling', tier: 'A', spend: 3, within: true, ceiling: TIER_CEILINGS.A },
    { name: 'A over', tier: 'A', spend: 3.01, within: false, ceiling: TIER_CEILINGS.A },
    { name: 'B under', tier: 'B', spend: 0.99, within: true, ceiling: TIER_CEILINGS.B },
    { name: 'B over', tier: 'B', spend: 1.01, within: false, ceiling: TIER_CEILINGS.B },
    { name: 'C under', tier: 'C', spend: 0.3, within: true, ceiling: TIER_CEILINGS.C },
    { name: 'C over', tier: 'C', spend: 0.31, within: false, ceiling: TIER_CEILINGS.C },
    { name: 'D over', tier: 'D', spend: 0.16, within: false, ceiling: TIER_CEILINGS.D },
    { name: 'enrichment_hold over', tier: 'enrichment_hold', spend: 0.31, within: false, ceiling: TIER_CEILINGS.enrichment_hold },
    { name: 'foundational default', tier: '', spend: 0.16, within: false, ceiling: ENRICHMENT_COST_CEILINGS.foundational },
    { name: 'candidate_tier preferred when treatment empty', candidate: 'B', spend: 1.01, within: false, ceiling: TIER_CEILINGS.B },
    {
      name: 'declared mail program raises floor to 8',
      tier: 'C',
      spend: 5,
      mailProgram: 'golden_ticket',
      within: true,
      ceiling: ENRICHMENT_COST_CEILINGS.golden_ticket_total,
    },
    {
      name: 'declared mail program over total',
      tier: 'A',
      spend: 8.01,
      mailProgram: 'golden_ticket',
      within: false,
      ceiling: ENRICHMENT_COST_CEILINGS.golden_ticket_total,
    },
  ];

  for (const c of cases) {
    const result = withinEnrichmentCeiling({
      enrichmentBudget: treasureValleyEnrichmentBudget,
      treatment_tier: c.tier,
      candidate_tier: c.candidate,
      enrichment_usd: c.spend,
      mail_treatment: c.mailProgram,
    });
    assert.equal(result.within_budget, c.within, c.name);
    assert.equal(result.ceiling, c.ceiling, `${c.name} ceiling`);
    if (!c.within) {
      assert.match(String(result.reason || ''), /enrichment_cost_exceeded/);
    }
  }
});

// ---------------------------------------------------------------------------
// Helpers: expensive action + tier presence
// ---------------------------------------------------------------------------

test('isExpensiveEnrichProviderAction: provider-bound vs free local', () => {
  assert.equal(isExpensiveEnrichProviderAction({ action: 'tool_call' }), true);
  assert.equal(isExpensiveEnrichProviderAction({ action: 'decision_makers' }), true);
  assert.equal(isExpensiveEnrichProviderAction({ action: 'model' }), true);
  assert.equal(isExpensiveEnrichProviderAction({}), true); // default model path
  assert.equal(isExpensiveEnrichProviderAction({ action: 'policy_apply' }), false);
  assert.equal(isExpensiveEnrichProviderAction({ action: 'POLICY_APPLY' }), false);
  assert.equal(isExpensiveEnrichProviderAction({ action: 'linkedin_company_resolution' }), false);
});

test('recordHasEnrichmentTier: treatment or candidate only', () => {
  assert.equal(recordHasEnrichmentTier({ treatment_tier: 'C' }), true);
  assert.equal(recordHasEnrichmentTier({ candidate_tier: 'B' }), true);
  assert.equal(recordHasEnrichmentTier({ treatment_tier: 'A', candidate_tier: 'B' }), true);
  assert.equal(recordHasEnrichmentTier({ treatment_tier: '', candidate_tier: '' }), false);
  assert.equal(recordHasEnrichmentTier({ treatment_tier: '  ' }), false);
  assert.equal(recordHasEnrichmentTier({}), false);
  assert.equal(recordHasEnrichmentTier(null), false);
});

// ---------------------------------------------------------------------------
// evaluateEnrichmentCeilingGate
// ---------------------------------------------------------------------------

test('gate: tool_call over ceiling → apply, !within_budget, reason enrichment_ceiling', () => {
  const gate = evaluateEnrichmentCeilingGate({
    enrichmentBudget: treasureValleyEnrichmentBudget,
    record: overspentRecord('C', 5),
    stepConfig: { action: 'tool_call', tool: { server: 'hunter', tools: ['HUNTER_EMAIL_FINDER'] } },
  });
  assert.equal(gate.apply, true);
  assert.equal(gate.within_budget, false);
  assert.equal(gate.reason, 'enrichment_ceiling');
  assert.ok(gate.enrichment_usd >= 5);
  assert.equal(gate.ceiling, TIER_CEILINGS.C);
  assert.match(String(gate.detail || ''), /enrichment_ceiling/);
});

test('gate: model enrich (empty action) over ceiling → blocked same as tool_call', () => {
  const gate = evaluateEnrichmentCeilingGate({
    enrichmentBudget: treasureValleyEnrichmentBudget,
    record: overspentRecord('B', 2),
    stepConfig: { action: '', outputs: { site_summary: { type: 'string' } } },
  });
  assert.equal(gate.apply, true);
  assert.equal(gate.within_budget, false);
  assert.equal(gate.reason, 'enrichment_ceiling');
  assert.equal(gate.ceiling, TIER_CEILINGS.B);
});

test('gate: same action under ceiling → proceeds (apply + within_budget)', () => {
  const gate = evaluateEnrichmentCeilingGate({
    enrichmentBudget: treasureValleyEnrichmentBudget,
    record: underCeilingRecord('C', 0.1),
    stepConfig: { action: 'tool_call' },
  });
  assert.equal(gate.apply, true);
  assert.equal(gate.within_budget, true);
  assert.equal(gate.reason, undefined);
  assert.equal(gate.ceiling, TIER_CEILINGS.C);
  assert.ok(gate.enrichment_usd <= 0.1);
});

test('gate: an undeclared enrichment budget is unconstrained', () => {
  const gate = evaluateEnrichmentCeilingGate({
    record: overspentRecord('C', 5),
    stepConfig: { action: 'tool_call' },
  });

  assert.equal(gate.apply, true);
  assert.equal(gate.within_budget, true);
  assert.equal(gate.ceiling, Number.POSITIVE_INFINITY);
  assert.equal(gate.reason, undefined);
});

test('executeEnrichmentAction: an undeclared enrichment budget reaches the configured provider', async () => {
  const provider = { calls: 0 };
  const result = await executeEnrichmentAction({
    mcp: null,
    listDir: mkdtempSync(join(tmpdir(), 'ao-unconfigured-budget-')),
    stepId: 'site_lookup',
    description: 'lookup',
    stepConfig: {
      action: 'tool_call',
      tool: {
        server: 'test',
        tools: ['LOOKUP'],
        effect: { class: 'data_enrichment' },
      },
      output_map: { site_summary: 'summary' },
      __tryTool: async () => {
        provider.calls += 1;
        return { result: { summary: 'enriched' }, provider: 'test' };
      },
    },
    record: overspentRecord('C', 5),
    aiConfig: {},
    context: {},
    outputSchema: dummySchema,
  });

  assert.equal(isEnrichmentCeilingSkip(result), false);
  assert.equal(provider.calls, 1);
  assert.equal(result.outputs.site_summary, 'enriched');
});

test('gate: an explicitly empty budget names its missing configuration distinctly', () => {
  const gate = evaluateEnrichmentCeilingGate({
    enrichmentBudget: {},
    record: overspentRecord('C', 5),
    stepConfig: { action: 'tool_call' },
  });

  assert.equal(gate.within_budget, false);
  assert.equal(gate.reason, 'enrichment_budget_not_configured');
});

test('runner emits the unconfigured-budget reason instead of enrichment_ceiling', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-unconfigured-budget-event-'));
  writeFileSync(join(listDir, 'outbound.yaml'), 'list: { name: budget-event }\npipeline: []\n');
  writeFileSync(join(listDir, 'operator.md'), 'budget event');
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const record = {
    ...overspentRecord('C', 5),
    business_name: 'Budget Event Co',
    sequence_name: 'default',
    sequence_status: 'idle',
    _created_at: now,
    _updated_at: now,
    created_at: now,
    updated_at: now,
  };
  const columns = Object.keys(record);
  ensureRecordColumns({ db, columns });
  db.prepare(`INSERT INTO records (${columns.join(', ')}) VALUES (${columns.map((column) => `@${column}`).join(', ')})`).run(record);

  try {
    await withActivityContext({ listDir }, () => executeEnrichmentStepOnRecords({
      db,
      listDir,
      config: { score: { enrichment_budget: {} } },
      mcp: null,
      toolCatalog: null,
      step: {
        kind: 'enrich',
        id: 'site_lookup',
        action: 'tool_call',
        outputs: { site_summary: { type: 'string' } },
      },
      rows: [record],
      force: true,
    }));

    const event = db.prepare(`
      SELECT payload_json
      FROM activity_history
      WHERE event = 'row_skipped'
      ORDER BY occurred_at DESC
      LIMIT 1
    `).get();
    assert.equal(JSON.parse(event.payload_json).reason, 'enrichment_budget_not_configured');
  } finally {
    db.close();
    cleanupSockets();
  }
});

test('gate: policy_apply never blocked even when enrichment spend is huge', () => {
  const gate = evaluateEnrichmentCeilingGate({
    enrichmentBudget: treasureValleyEnrichmentBudget,
    record: overspentRecord('C', 99),
    stepConfig: { action: 'policy_apply' },
  });
  assert.equal(gate.apply, false);
  assert.equal(gate.within_budget, true);
  assert.equal(gate.reason, undefined);
});

test('gate: linkedin_company_resolution not gated (free local path)', () => {
  const gate = evaluateEnrichmentCeilingGate({
    enrichmentBudget: treasureValleyEnrichmentBudget,
    record: overspentRecord('A', 10),
    stepConfig: { action: 'linkedin_company_resolution' },
  });
  assert.equal(gate.apply, false);
  assert.equal(gate.within_budget, true);
});

test('gate: no treatment_tier/candidate_tier → not gated even if spend high', () => {
  const gate = evaluateEnrichmentCeilingGate({
    enrichmentBudget: treasureValleyEnrichmentBudget,
    record: {
      _row_id: 'early_enrich',
      enrichment_cost_usd: 50,
      // no treatment_tier / candidate_tier — foundational pre-tier enrich
    },
    stepConfig: { action: 'tool_call' },
  });
  assert.equal(gate.apply, false);
  assert.equal(gate.within_budget, true);
  assert.equal(gate.reason, undefined);
  assert.equal(
    recordHasEnrichmentTier({ enrichment_cost_usd: 50 }),
    false,
  );
});

test('gate: candidate_tier alone is enough to apply ceiling', () => {
  const gate = evaluateEnrichmentCeilingGate({
    enrichmentBudget: treasureValleyEnrichmentBudget,
    record: {
      _row_id: 'cand_only',
      candidate_tier: 'C',
      enrichment_cost_usd: 1,
    },
    stepConfig: { action: 'decision_makers' },
  });
  assert.equal(gate.apply, true);
  assert.equal(gate.within_budget, false);
  assert.equal(gate.reason, 'enrichment_ceiling');
});

// ---------------------------------------------------------------------------
// cost_events hydration
// ---------------------------------------------------------------------------

test('gate: cost_events hydration used when db present (overrides understated scalar)', () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-ceil-hydrate-'));
  writeFileSync(
    join(listDir, 'outbound.yaml'),
    `list: { name: ceil-hydrate }\npipeline: []\nscore: { criteria: [] }\nsequences: { default: { steps: [] } }\n`,
  );
  writeFileSync(join(listDir, 'operator.md'), 'ceil');
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const rowId = 'hydrate_ceil_1';

  ensureRecordColumns({
    db,
    columns: ['treatment_tier', 'enrichment_cost_usd', 'cost_ledger_json'],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, treatment_tier,
      enrichment_cost_usd, _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, 'Hydrate Co', 'default', 'idle', 'C', 0.05, ?, ?, ?, ?)
  `).run(rowId, now, now, now, now);

  // Production event log says real spend is well over C ceiling ($0.30)
  insertCostEvent({
    db,
    event: {
      id: randomUUID(),
      record_id: rowId,
      step_id: 'site_scrape_enrich',
      model: 'gpt-test',
      usd_cost: 0.5,
      provider: 'openai',
      tool_calls: [],
      occurred_at: now,
    },
  });

  const record = {
    _row_id: rowId,
    treatment_tier: 'C',
    // Stale scalar would incorrectly pass under ceiling
    enrichment_cost_usd: 0.05,
  };

  const withoutDb = evaluateEnrichmentCeilingGate({
    enrichmentBudget: treasureValleyEnrichmentBudget,
    record,
    stepConfig: { action: 'tool_call' },
  });
  assert.equal(withoutDb.within_budget, true, 'stale scalar alone is under C ceiling');

  const withDb = evaluateEnrichmentCeilingGate({
    enrichmentBudget: treasureValleyEnrichmentBudget,
    db,
    record,
    stepConfig: { action: 'tool_call' },
  });
  assert.equal(withDb.apply, true);
  assert.equal(withDb.within_budget, false, 'cost_events must drive spend when db present');
  assert.equal(withDb.reason, 'enrichment_ceiling');
  assert.ok(withDb.enrichment_usd >= 0.5);
  assert.ok(withDb.recordPatch, 'hydration should return a record patch');
  assert.ok(Number(withDb.recordPatch.enrichment_cost_usd) >= 0.5);

  db.close();
});

test('ledgerFromCostEventRows: tool_calls on model step counts toward enrichment', () => {
  const ledger = ledgerFromCostEventRows('acct_tool', [
    {
      id: 'e1',
      step_id: 'research_step',
      usd_cost: 0.4,
      tool_calls: ['FIRECRAWL_SCRAPE'],
      occurred_at: new Date().toISOString(),
    },
  ]);
  assert.ok(ledger.enrichment_usd >= 0.4);
  assert.equal(enrichmentSpendUsd({ ledger }), ledger.enrichment_usd);
});

// ---------------------------------------------------------------------------
// Integration: executeEnrichmentAction
// ---------------------------------------------------------------------------

test('executeEnrichmentAction: tool_call over ceiling skips with enrichment_ceiling (no provider)', async () => {
  const result = await executeEnrichmentAction({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    enrichmentBudget: treasureValleyEnrichmentBudget,
    mcp: null, // would throw if provider path reached
    listDir: mkdtempSync(join(tmpdir(), 'ao-ceil-exec-')),
    stepId: 'email_finder',
    description: 'find email',
    stepConfig: {
      action: 'tool_call',
      tool: { server: 'hunter', tools: ['HUNTER_EMAIL_FINDER'] },
    },
    record: overspentRecord('C', 5),
    aiConfig: {},
    context: {},
    outputSchema: dummySchema,
  });

  assert.equal(isEnrichmentCeilingSkip(result), true);
  assert.equal(result.skipped, true);
  assert.equal(result.skip_reason, 'enrichment_ceiling');
  assert.equal(result.provider, 'cost_blocked');
  assert.equal(result.artifacts?.reason, 'enrichment_ceiling');
  assert.equal(result.usage?.usd_cost, 0);
  assert.deepEqual(result.usage?.tool_calls || [], []);
  assert.match(String(result.skip_detail || ''), /enrichment_ceiling|enrichment_cost_exceeded/);
});

test('executeEnrichmentAction: model-style enrich over ceiling skips before model path', async () => {
  const result = await executeEnrichmentAction({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    enrichmentBudget: treasureValleyEnrichmentBudget,
    mcp: null,
    listDir: mkdtempSync(join(tmpdir(), 'ao-ceil-model-')),
    stepId: 'site_research',
    description: 'research',
    stepConfig: {
      // empty action → generic model enrich path after the gate
      outputs: { research_notes: { type: 'string' } },
    },
    record: overspentRecord('B', 2),
    aiConfig: { model: 'should-not-be-called' },
    context: {},
    outputSchema: dummySchema,
  });

  assert.equal(isEnrichmentCeilingSkip(result), true);
  assert.equal(result.provider, 'cost_blocked');
  assert.equal(result.skip_reason, 'enrichment_ceiling');
});

test('executeEnrichmentAction: policy_apply is not blocked by enrichment ceiling', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-ceil-policy-'));
  writeFileSync(
    join(listDir, 'outbound.yaml'),
    `list: { name: ceil-policy }
business: { name: Mission, description: t, icp: t, offer: t }
pipeline:
  - kind: enrich
    id: treatment_assignment
    action: policy_apply
    depends_on: []
score:
  grading: graded
  criteria:
    - id: operational_coordination_burden
      weight: 0.22
      description: x
    - id: repetition_and_volume
      weight: 0.18
      description: x
    - id: economic_impact_potential
      weight: 0.2
      description: x
    - id: operating_scale_surface_area
      weight: 0.15
      description: x
    - id: mission_delivery_compatibility
      weight: 0.15
      description: x
    - id: local_buying_autonomy
      weight: 0.1
      description: x
  minimum: 0
sequences:
  default:
    steps: []
`,
  );
  writeFileSync(join(listDir, 'operator.md'), 'ceil policy');

  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const rowId = 'policy_over_ceil';
  const breakdown = JSON.stringify([
    { id: 'operational_coordination_burden', grade: 8, reasoning: 'multi-crew' },
    { id: 'repetition_and_volume', grade: 8, reasoning: 'daily' },
    { id: 'economic_impact_potential', grade: 7, reasoning: 'ticket' },
    { id: 'operating_scale_surface_area', grade: 7, reasoning: 'fleet' },
    { id: 'mission_delivery_compatibility', grade: 8, reasoning: 'soft' },
    { id: 'local_buying_autonomy', grade: 9, reasoning: 'owner' },
  ]);

  ensureRecordColumns({
    db,
    columns: [
      'score_breakdown', 'fit_score', 'identity_confidence', 'buyer_confidence',
      'address_rdi', 'contact_email', 'company_resolution', 'treatment_tier',
      'enrichment_cost_usd', 'cost_ledger_json',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, fit_score, score_breakdown,
      identity_confidence, buyer_confidence, address_rdi, contact_email, company_resolution,
      treatment_tier, enrichment_cost_usd,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, 'Overspend HVAC', 'default', 'idle', 80, ?, 90, 75, 'Commercial',
      'owner@example-ceil.test', 'resolved', 'C', 99, ?, ?, ?, ?)
  `).run(rowId, breakdown, now, now, now, now);

  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const result = await executeEnrichmentAction({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    enrichmentBudget: treasureValleyEnrichmentBudget,
    db,
    mcp: null,
    listDir,
    stepId: 'treatment_assignment',
    description: 'policy',
    stepConfig: { action: 'policy_apply', outputs: { treatment_tier: { type: 'string' } } },
    record,
    aiConfig: {},
    context: {},
    outputSchema: dummySchema,
  });

  assert.equal(isEnrichmentCeilingSkip(result), false);
  assert.notEqual(result.provider, 'cost_blocked');
  assert.equal(result.provider, 'policy');
  assert.ok(result.outputs?.treatment_tier, 'policy_apply must still run and write tier');
  db.close();
});

test('executeEnrichmentAction: early enrich without tier is not ceiling-gated', async () => {
  // Under no-tier path the gate does not apply. Fixture mode would also skip the
  // gate, so we only assert the pure gate + that non-fixture no-tier would reach
  // tool_call (which needs mcp). Unit gate already covers !apply; here we only
  // confirm overspent *tiered* path is the one that sets cost_blocked.
  const early = evaluateEnrichmentCeilingGate({
    enrichmentBudget: treasureValleyEnrichmentBudget,
    record: { _row_id: 'early', enrichment_cost_usd: 99 },
    stepConfig: { action: 'tool_call' },
  });
  assert.equal(early.apply, false);

  const tiered = evaluateEnrichmentCeilingGate({
    enrichmentBudget: treasureValleyEnrichmentBudget,
    record: overspentRecord('C', 99),
    stepConfig: { action: 'tool_call' },
  });
  assert.equal(tiered.apply, true);
  assert.equal(tiered.within_budget, false);
});
