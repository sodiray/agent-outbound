/**
 * Proves policy modules are on the production path (scoring apply, enrich action,
 * channel guard, CLI policy apply) — not test-only imports.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { openListDb, ensureRecordColumns, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { applyOutboundPolicy as applyRawOutboundPolicy } from '../dist/orchestrator/policy/apply-record.js';
import {
  executeEnrichmentAction,
  executeEnrichmentStepOnRecords,
} from '../dist/orchestrator/enrichment/runner.js';
import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';
import { executeStepBatch } from '../dist/orchestrator/pipeline/step-executor.js';
import { policyApplyCommand } from '../dist/commands/index.js';
import { calculateFitScore } from '../dist/orchestrator/policy/scoring.js';
import { treasureValleyTreatmentStrategy } from './fixtures/treatment-strategy.mjs';
import { treasureValleyFitModel } from './fixtures/fit-model.mjs';

const applyOutboundPolicy = (input) => applyRawOutboundPolicy({ fitModel: treasureValleyFitModel, ...input });

const require = createRequire(import.meta.url);

const projectYaml = `
list:
  name: Policy Wire Test
business:
  name: Mission
  description: Test
  icp: Test
  offer: Test
pipeline:
  - kind: enrich
    id: treatment_assignment
    action: policy_apply
    depends_on: []
    outputs:
      treatment_tier:
        type: string
        description: treatment tier
      priority_rank:
        type: number
        description: priority rank
  - kind: pipeline
    id: tier_b
    steps:
      - kind: send_email
        id: email_1
        side_effecting: true
        draft_approval_required: true
        config:
          action: tool_call
sequences:
  default:
    steps: []
policy:
  version: tv-pipeline-v1
  prohibited_channels: [sms]
  prohibited_task_types: [visit, field_visit]
  enforce_readiness: true
score:
  treatment: ${JSON.stringify(treasureValleyTreatmentStrategy)}
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
channels:
  email:
    draft_approval_required: true
`;

const createList = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-policy-wire-'));
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml);
  writeFileSync(join(listDir, 'operator.md'), 'test');
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const breakdown = JSON.stringify([
    { id: 'operational_coordination_burden', grade: 8, reasoning: 'multi-crew admin' },
    { id: 'repetition_and_volume', grade: 8, reasoning: 'daily jobs' },
    { id: 'economic_impact_potential', grade: 7, reasoning: 'high ticket' },
    { id: 'operating_scale_surface_area', grade: 7, reasoning: 'fleet signals' },
    { id: 'mission_delivery_compatibility', grade: 8, reasoning: 'software surface' },
    { id: 'local_buying_autonomy', grade: 9, reasoning: 'owner operated' },
  ]);
  const fit = calculateFitScore([
    { id: 'operational_coordination_burden', grade: 8 },
    { id: 'repetition_and_volume', grade: 8 },
    { id: 'economic_impact_potential', grade: 7 },
    { id: 'operating_scale_surface_area', grade: 7 },
    { id: 'mission_delivery_compatibility', grade: 8 },
    { id: 'local_buying_autonomy', grade: 9 },
  ], treasureValleyFitModel);
  ensureRecordColumns({
    db,
    columns: [
      'score_breakdown', 'fit_score', 'identity_confidence', 'buyer_confidence',
      'address_rdi', 'contact_email', 'company_resolution', 'business_name',
    ],
  });
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, fit_score, score_breakdown,
      identity_confidence, buyer_confidence, address_rdi, contact_email, company_resolution,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, ?, 'default', 'idle', ?, ?, 90, 75, 'Commercial', 'owner@example-hvac.test', 'resolved', ?, ?, ?, ?)
  `).run('fixture_hvac_1', 'Boise Peak HVAC', fit.fit_score, breakdown, now, now, now, now);

  // two contacts for multi-contact campaign
  db.prepare(`
    INSERT INTO contacts (
      contact_id, row_id, name, full_name, email, role, is_primary, created_at, updated_at
    ) VALUES
      ('c_owner', 'fixture_hvac_1', 'Alex Rivera', 'Alex Rivera', 'alex@example-hvac.test', 'primary', 1, ?, ?),
      ('c_om', 'fixture_hvac_1', 'Sam Lee', 'Sam Lee', 'office@example-hvac.test', 'secondary', 0, ?, ?)
  `).run(now, now, now, now);
  db.close();
  return listDir;
};

test('enrich action policy_apply writes treatment and next_action via production enrich path', async () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_hvac_1');
  const result = await executeEnrichmentAction({
    db,
    mcp: null,
    listDir,
    stepId: 'treatment_assignment',
    description: 'policy',
    stepConfig: { action: 'policy_apply', outputs: { treatment_tier: { type: 'string' } } },
    record,
    aiConfig: {},
    context: {},
    treatmentStrategy: treasureValleyTreatmentStrategy,
    outputSchema: { parse: (x) => x },
  });
  assert.ok(result.outputs.treatment_tier);
  assert.ok(['A', 'B', 'C', 'D', 'enrichment_hold'].includes(String(result.outputs.treatment_tier)));
  assert.notEqual(Number(result.outputs.priority_rank), Number(record.fit_score));
  assert.equal(
    db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_hvac_1').treatment_tier,
    undefined,
    'action execution must not mutate before runner validation',
  );
  const summary = await executeEnrichmentStepOnRecords({
    db,
    listDir,
    config: { ai: {}, score: { treatment: treasureValleyTreatmentStrategy } },
    mcp: null,
    toolCatalog: null,
    step: {
      kind: 'enrich',
      id: 'treatment_assignment',
      action: 'policy_apply',
      outputs: {
        treatment_tier: { type: 'string' },
        priority_rank: { type: 'number' },
      },
    },
    rows: [record],
    stepId: 'treatment_assignment',
    force: true,
  });
  assert.equal(summary.processed, 1);
  const updated = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_hvac_1');
  assert.ok(updated.treatment_tier);
  assert.ok(String(updated.next_action_json || '').includes('action_id'));
  // Production enrich path must load contacts and write campaign plan (not CLI-only).
  assert.ok(updated.account_contact_plan_json, 'policy_apply must write account_contact_plan_json when contacts exist');
  const plan = JSON.parse(updated.account_contact_plan_json);
  assert.equal(plan.active_contact_id, 'c_owner');
  assert.deepEqual(plan.held_contact_ids, ['c_om']);
  assert.equal(updated.active_contact_id, 'c_owner');
  db.close();
});

test('channel execute blocks send_sms and visit on production path', async () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('fixture_hvac_1');
  const sms = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Policy Wire Test',
    db,
    record,
    sequenceName: 'default',
    stepNumber: 1,
    step: { kind: 'send_sms', id: 'sms_1', config: {} },
    sequence: { steps: [] },
    channelHint: 'sms',
    intent: 'send',
  });
  assert.equal(sms.status, 'skipped');
  assert.match(String(sms.reason), /forbidden|sms|SMS|not permitted/i);

  const visit = await executeChannelStep({
    mcp: null,
    listDir,
    listName: 'Policy Wire Test',
    db,
    record,
    sequenceName: 'default',
    stepNumber: 2,
    step: { kind: 'manual_task', id: 'field_visit', config: { task_type: 'visit' } },
    sequence: { steps: [] },
    channelHint: 'visit',
    intent: 'send',
  });
  assert.equal(visit.status, 'skipped');
  assert.match(String(visit.reason), /forbidden|visit|not permitted/i);
  db.close();
});

test('pipeline step batch rejects send_sms and visit task types', async () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  const rows = db.prepare('SELECT * FROM records WHERE _row_id = ?').all('fixture_hvac_1');
  const ctx = {
    db,
    listDir,
    config: require('js-yaml').load(readFileSync(join(listDir, 'outbound.yaml'), 'utf8')),
    aiConfig: {},
    mcp: null,
    toolCatalog: null,
  };
  const smsMap = await executeStepBatch(ctx, { kind: 'send_sms', id: 'sms_x' }, 'sms_x', rows);
  const smsOut = smsMap.get('fixture_hvac_1');
  assert.equal(smsOut.errored, true);
  assert.match(smsOut.reason, /prohibits channel/i);

  const visitMap = await executeStepBatch(
    ctx,
    { kind: 'manual_task', id: 'field_visit', config: { task_type: 'visit' } },
    'field_visit',
    rows,
  );
  const visitOut = visitMap.get('fixture_hvac_1');
  assert.equal(visitOut.errored, true);
  db.close();
});

test('policy apply CLI command updates real SQLite project', async () => {
  const listDir = createList();
  const result = await policyApplyCommand({ list: listDir, where: "_row_id = 'fixture_hvac_1'" });
  assert.equal(result.updated, 1);
  assert.ok(result.tiers);
  const db = openListDb({ listDir, readonly: true });
  const row = db.prepare('SELECT treatment_tier, priority_rank, next_action_json, account_contact_plan_json FROM records WHERE _row_id = ?')
    .get('fixture_hvac_1');
  assert.ok(row.treatment_tier);
  assert.ok(row.next_action_json);
  const plan = JSON.parse(row.account_contact_plan_json || '{}');
  assert.equal(plan.active_contact_id, 'c_owner');
  assert.deepEqual(plan.held_contact_ids, ['c_om']);
  db.close();
});

test('applyOutboundPolicy does not mirror priority to fit', () => {
  const fit = calculateFitScore([
    { id: 'operational_coordination_burden', grade: 9 },
    { id: 'repetition_and_volume', grade: 9 },
    { id: 'economic_impact_potential', grade: 9 },
    { id: 'operating_scale_surface_area', grade: 9 },
    { id: 'mission_delivery_compatibility', grade: 9 },
    { id: 'local_buying_autonomy', grade: 9 },
  ], treasureValleyFitModel);
  const r = applyOutboundPolicy({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    record: {
      _row_id: 'x',
      fit_score: fit.fit_score,
      score_breakdown: JSON.stringify([
        { id: 'operational_coordination_burden', grade: 9, reasoning: 'a', evidence_ids: ['e1'] },
        { id: 'repetition_and_volume', grade: 9, reasoning: 'b', evidence_ids: ['e2'] },
        { id: 'economic_impact_potential', grade: 9, reasoning: 'c', evidence_ids: ['e3'] },
        { id: 'operating_scale_surface_area', grade: 9, reasoning: 'd', evidence_ids: ['e4'] },
        { id: 'mission_delivery_compatibility', grade: 9, reasoning: 'e', evidence_ids: ['e5'] },
        { id: 'local_buying_autonomy', grade: 9, reasoning: 'f', evidence_ids: ['e6'] },
      ]),
      identity_confidence: 90,
      buyer_confidence: 80,
      classification_confidence: 90,
      address_rdi: 'Commercial',
      timing_score: 10,
      named_buyer_status: 'confirmed',
      observed_buyer_name: 'Alex Rivera',
      buyer_affiliation_status: 'confirmed',
      buying_center_role: 'owner',
    },
    recomputeFitFromBreakdown: true,
  });
  assert.notEqual(r.priority_rank, r.patch.fit_score);
  assert.ok(['A', 'B'].includes(r.treatment_tier));
});

test('applyOutboundPolicy writes evidence_resolution_json envelope', () => {
  const r = applyOutboundPolicy({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    record: {
      _row_id: 'acct_ev',
      score_breakdown: JSON.stringify([
        {
          id: 'operational_coordination_burden',
          grade: 8,
          reasoning: 'multi-crew',
          evidence_ids: ['obs_1', 'obs_2'],
        },
        { id: 'repetition_and_volume', grade: 7, reasoning: 'volume', evidence_ids: ['obs_2'] },
        // remaining fit components intentionally missing → missing_inputs
      ]),
      identity_confidence: 90,
      buyer_confidence: 70,
      address_rdi: 'Commercial',
      timing_score: 20,
    },
    recomputeFitFromBreakdown: true,
  });

  assert.ok(r.patch.evidence_resolution_json, 'evidence_resolution_json must be on patch');
  const env = JSON.parse(String(r.patch.evidence_resolution_json));
  assert.equal(env.account_id, 'acct_ev');
  assert.equal(typeof env.fit_score, 'number');
  assert.ok(env.fit_evidence_confidence != null);
  assert.ok(env.treatment_tier);
  assert.ok(env.eligibility_outcome);
  assert.ok(Array.isArray(env.missing_inputs));
  assert.ok(env.missing_inputs.includes('economic_impact_potential'));
  assert.deepEqual(env.contradictions, []);
  assert.ok(env.policy_versions && typeof env.policy_versions === 'object');
  assert.ok(env.policy_versions.treatment);
  assert.ok(env.policy_versions.next_action);
  assert.ok(env.generated_at);
  assert.match(String(env.generated_at), /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Array.isArray(env.source_observation_refs));
  assert.deepEqual(env.source_observation_refs, ['obs_1', 'obs_2']);
});

test('re-applyOutboundPolicy preserves rotation and mail_allocated (no double mail)', async () => {
  const { applyOutboundPolicy } = await import('../dist/orchestrator/policy/apply-record.js');
  const {
    buildContactPlan,
    rotateContact,
    allocateMail,
    mergeContactPlan,
  } = await import('../dist/orchestrator/policy/contact-campaign.js');

  const contacts = [
    { contact_id: 'c1', outbound_disposition: 'eligible_target', outreach_rank: 1 },
    { contact_id: 'c2', outbound_disposition: 'eligible_target', outreach_rank: 2 },
  ];
  let plan = buildContactPlan({
    account_id: 'acct_merge',
    campaign_id: 'camp_merge',
    contacts,
    treatment_tier: 'B',
    mail_treatment: 'standard_postcard',
  });
  assert.equal(plan.active_contact_id, 'c1');
  plan = rotateContact({ campaign: plan, reason: 'exhaust_c1' }).campaign;
  assert.equal(plan.active_contact_id, 'c2');
  plan = allocateMail({ campaign: plan, mail_treatment: 'standard_postcard' });
  assert.equal(plan.mail_allocated, true);

  const fresh = buildContactPlan({
    account_id: 'acct_merge',
    campaign_id: 'camp_merge_fresh',
    contacts,
    treatment_tier: 'B',
    mail_treatment: 'standard_postcard',
  });
  // Fresh always starts at c1 / mail false — merge must preserve state.
  assert.equal(fresh.active_contact_id, 'c1');
  assert.equal(fresh.mail_allocated, false);
  const merged = mergeContactPlan({ fresh, existing: plan });
  assert.equal(merged.active_contact_id, 'c2', 'merge must keep rotated active contact');
  assert.deepEqual(merged.held_contact_ids, []);
  assert.equal(merged.mail_allocated, true, 'merge must keep mail_allocated');
  assert.throws(
    () => allocateMail({ campaign: merged, mail_treatment: 'standard_postcard' }),
    /already allocated/i,
  );

  // Full applyOutboundPolicy path: record carries prior plan JSON
  const reapplied = applyOutboundPolicy({
    treatmentStrategy: treasureValleyTreatmentStrategy,
    record: {
      _row_id: 'acct_merge',
      fit_score: 70,
      fit_evidence_confidence: 80,
      identity_confidence: 90,
      address_rdi: 'Commercial',
      account_contact_plan_json: JSON.stringify(plan),
      active_contact_id: 'c2',
    },
    contacts,
    campaignId: 'camp_merge',
  });
  const planAfter = JSON.parse(String(reapplied.patch.account_contact_plan_json || '{}'));
  assert.equal(planAfter.active_contact_id, 'c2');
  assert.equal(planAfter.mail_allocated, true);
  assert.equal(reapplied.patch.active_contact_id, 'c2');
  assert.throws(
    () => allocateMail({ campaign: planAfter, mail_treatment: 'standard_postcard' }),
    /already allocated/i,
  );
});
