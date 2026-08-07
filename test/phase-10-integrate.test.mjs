/**
 * Phase 10 — Integrate and harden the complete pipeline.
 *
 * Complete-when (pipeline-build-plan): the complete pipeline can execute
 * deterministically in controlled tests, all documented invariants are
 * enforced, and no known gap requires manual database repair as its normal
 * operating mechanism.
 *
 * Closures covered here + residual suite:
 * - TV yaml has no field_visit / send_sms (or other forbidden) steps via findForbiddenSteps
 * - config policy.enforce_readiness is true and survives normalizeConfig
 * - PolicySchema preserves fit/treatment rule versions + review_required_for
 * - treatment_assignment is action: policy_apply (deterministic, not LLM)
 * - production importers exist and wire policy modules (read source files)
 * - yaml / yarn harness invariants
 * - lifecycle state machine permitted + prohibited transitions
 * - policy apply idempotency of treatment tier under re-apply (pure)
 * - residual failure injection (forbidden work + Unipile network) in residual suite
 *
 * Does NOT authorize bulk production send (Phase 12 activation posture).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import yaml from 'js-yaml';
import { findForbiddenSteps } from '../dist/orchestrator/policy/forbidden-channels.js';
import {
  canTransitionLifecycle,
  assertLifecycleTransition,
  createInitialColdState,
  checkStateIntegrity,
  completeActionAndCreateSuccessor,
  LIFECYCLE_STAGES,
} from '../dist/orchestrator/policy/lifecycle.js';
import { applyOutboundPolicy } from '../dist/orchestrator/policy/apply-record.js';
import { calculateFitScore } from '../dist/orchestrator/policy/scoring.js';
import { normalizeConfig } from '../dist/schemas/config.js';
import { readConfig } from '../dist/orchestrator/lib/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AO_ROOT = join(__dirname, '..');
const TV_ROOT = '/Users/rayepps/projects/mission/.outbound/treasure-valley';
const TV_YAML = join(TV_ROOT, 'outbound.yaml');

const PRODUCTION_IMPORTERS = [
  {
    path: 'src/orchestrator/scoring/runner.ts',
    mustInclude: ['applyOutboundPolicy', 'calculateFitScore', 'loadCampaignContactsFromDb'],
  },
  {
    path: 'src/orchestrator/enrichment/runner.ts',
    mustInclude: ["action === 'policy_apply'", 'applyOutboundPolicy', 'loadCampaignContactsFromDb'],
  },
  {
    path: 'src/orchestrator/channels/execute.ts',
    mustInclude: ['guardChannelExecution', 'assertWorkAllowed', 'advanceAfterSuccessfulAction'],
  },
  {
    path: 'src/orchestrator/pipeline/step-executor.ts',
    mustInclude: ['isForbiddenTaskType', 'isForbiddenChannelKind', 'forbidden_work:send_sms'],
  },
  {
    path: 'src/commands/index.ts',
    mustInclude: ['applyOutboundPolicy', 'policyApplyCommand'],
  },
  {
    path: 'src/orchestrator/sequencer/runner.ts',
    mustInclude: ['shouldExecuteSequenceOutbound'],
  },
  {
    path: 'src/orchestrator/channels/unipile.ts',
    mustInclude: ['linkedin'],
  },
  {
    path: 'src/orchestrator/policy/forbidden-channels.ts',
    mustInclude: ['findForbiddenSteps', 'send_sms', 'field_visit'],
  },
  {
    path: 'src/orchestrator/policy/apply-record.ts',
    mustInclude: ['applyOutboundPolicy', 'guardChannelExecution', 'enforce_readiness'],
  },
  {
    path: 'src/orchestrator/policy/lifecycle.ts',
    mustInclude: ['canTransitionLifecycle', 'completeActionAndCreateSuccessor', 'checkStateIntegrity'],
  },
  {
    path: 'src/schemas/config.ts',
    mustInclude: ['enforce_readiness', 'PolicySchema', 'policy: PolicySchema'],
  },
];

function loadTvRaw() {
  assert.ok(existsSync(TV_YAML), `TV outbound.yaml missing at ${TV_YAML}`);
  return yaml.load(readFileSync(TV_YAML, 'utf8'));
}

function collectSteps(steps, acc = []) {
  for (const s of steps || []) {
    acc.push(s);
    if (Array.isArray(s.steps)) collectSteps(s.steps, acc);
  }
  return acc;
}

function allConfigSteps(cfg) {
  const all = collectSteps(cfg.pipeline);
  for (const seq of Object.values(cfg.sequences || {})) {
    collectSteps(seq.steps, all);
  }
  return all;
}

// ---------------------------------------------------------------------------
// TV yaml: forbidden channels / steps
// ---------------------------------------------------------------------------

test('TV yaml: findForbiddenSteps finds no field_visit/send_sms (or other forbidden) steps', () => {
  const cfg = loadTvRaw();
  const all = allConfigSteps(cfg);
  const forbidden = findForbiddenSteps(all);
  assert.deepEqual(
    forbidden,
    [],
    `Forbidden steps in TV config: ${JSON.stringify(forbidden, null, 2)}`,
  );

  // Explicit kind / id / task_type bans (belt + suspenders beyond walk)
  for (const step of all) {
    const kind = String(step.kind || '').toLowerCase();
    const id = String(step.id || '').toLowerCase();
    const taskType = String(step.config?.task_type || step.config?.taskType || '').toLowerCase();
    assert.notEqual(kind, 'send_sms');
    assert.notEqual(kind, 'field_visit');
    assert.notEqual(id, 'field_visit');
    assert.notEqual(id, 'send_sms');
    assert.equal(
      /^(visit|field_visit|door_to_door|office_visit|walk_in|sms|send_sms|automated_voice|prerecorded_voice)$/i.test(
        taskType,
      ),
      false,
      `forbidden task_type on step ${step.id}: ${taskType}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Config policy.enforce_readiness + treatment_assignment = policy_apply
// ---------------------------------------------------------------------------

test('TV config: policy.enforce_readiness true; treatment_assignment is policy_apply', () => {
  const raw = loadTvRaw();
  assert.equal(raw.policy?.enforce_readiness, true);
  assert.ok(Array.isArray(raw.policy?.forbidden_channels));
  assert.ok(raw.policy.forbidden_channels.includes('send_sms'));
  assert.ok(raw.policy.forbidden_channels.includes('field_visit'));

  const treatment = (raw.pipeline || []).find((s) => s.id === 'treatment_assignment');
  assert.ok(treatment, 'treatment_assignment step missing');
  assert.equal(treatment.kind, 'enrich');
  assert.equal(treatment.action, 'policy_apply');
});

test('TV config validates via normalizeConfig and preserves enforce_readiness', () => {
  const raw = loadTvRaw();
  const normalized = normalizeConfig(raw, { listDir: TV_ROOT });
  const errors = Array.isArray(normalized.errors)
    ? normalized.errors
    : normalized.error
      ? [normalized.error]
      : [];
  assert.deepEqual(errors, [], `normalizeConfig errors: ${JSON.stringify(errors)}`);

  // PolicySchema preserves readiness + rule versions + review gates (no strip).
  assert.equal(normalized.config.policy?.enforce_readiness, true);
  assert.ok(
    (normalized.config.policy?.forbidden_channels || []).includes('send_sms'),
    'forbidden_channels must survive normalize',
  );
  assert.equal(normalized.config.policy?.fit_rule_version, raw.policy?.fit_rule_version);
  assert.equal(
    normalized.config.policy?.treatment_rule_version,
    raw.policy?.treatment_rule_version,
  );
  assert.equal(normalized.config.policy?.deterministic_treatment, true);
  assert.ok(
    Array.isArray(normalized.config.policy?.review_required_for) &&
      normalized.config.policy.review_required_for.includes('send_email'),
    'review_required_for must survive normalize',
  );

  const treatment = (normalized.config.pipeline || []).find((s) => s.id === 'treatment_assignment');
  assert.ok(treatment);
  assert.equal(treatment.action, 'policy_apply');

  // readConfig path (production config loader)
  const loaded = readConfig(TV_ROOT);
  assert.deepEqual(loaded.errors || [], [], `readConfig errors: ${JSON.stringify(loaded.errors)}`);
  assert.equal(loaded.config.policy?.enforce_readiness, true);
  assert.equal(loaded.config.policy?.fit_rule_version, raw.policy?.fit_rule_version);
  assert.equal(
    loaded.config.policy?.treatment_rule_version,
    raw.policy?.treatment_rule_version,
  );
});

// ---------------------------------------------------------------------------
// Yaml-related invariants (phone/sms/visit posture)
// ---------------------------------------------------------------------------

test('TV yaml invariants: no SMS/auto-voice, email draft approval, no visit pipelines', () => {
  const raw = loadTvRaw();
  assert.equal(raw.channels?.phone?.sms, false);
  assert.equal(raw.channels?.phone?.automated_voice, false);
  assert.ok(
    raw.channels?.phone?.mode === 'human_only' || raw.channels?.phone?.mode === 'human',
    `phone.mode should be human-only, got ${raw.channels?.phone?.mode}`,
  );
  assert.equal(raw.channels?.email?.draft_approval_required, true);

  const all = allConfigSteps(raw);
  const kinds = new Set(all.map((s) => String(s.kind || '')));
  assert.equal(kinds.has('send_sms'), false);
  assert.equal(kinds.has('field_visit'), false);

  // Score criteria exclude visit-era penalties
  const critIds = (raw.score?.criteria || []).map((c) => c.id);
  assert.equal(critIds.includes('hipaa_exposure'), false);
  assert.equal(critIds.includes('walk_in_decision_maker_access'), false);
});

// ---------------------------------------------------------------------------
// Production importers exist (read source files)
// ---------------------------------------------------------------------------

test('production importers exist and wire policy modules (source contract)', () => {
  for (const spec of PRODUCTION_IMPORTERS) {
    const abs = join(AO_ROOT, spec.path);
    assert.ok(existsSync(abs), `missing production file: ${spec.path}`);
    const src = readFileSync(abs, 'utf8');
    for (const needle of spec.mustInclude) {
      assert.ok(
        src.includes(needle),
        `${spec.path} must include ${JSON.stringify(needle)}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Yarn-related harness invariants
// ---------------------------------------------------------------------------

test('yarn harness invariants: yarn.lock + package.json test builds before node --test', () => {
  assert.ok(existsSync(join(AO_ROOT, 'yarn.lock')), 'yarn.lock required (yarn is package manager)');
  const pkg = JSON.parse(readFileSync(join(AO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.scripts?.test, 'package.json scripts.test missing');
  // Test script must build first so dist/ matches src for integration imports
  assert.match(String(pkg.scripts.test), /yarn build|tsc/);
  assert.match(String(pkg.scripts.test), /node --test/);
  assert.match(String(pkg.scripts.test), /test\/\*\.test\.mjs|test\/.*\.test\.mjs/);
  // Dist policy modules exist after build (this suite is run post-build by yarn test)
  assert.ok(existsSync(join(AO_ROOT, 'dist/orchestrator/policy/forbidden-channels.js')));
  assert.ok(existsSync(join(AO_ROOT, 'dist/orchestrator/policy/apply-record.js')));
  assert.ok(existsSync(join(AO_ROOT, 'dist/orchestrator/policy/lifecycle.js')));
  assert.ok(existsSync(join(AO_ROOT, 'dist/schemas/config.js')));
});

// ---------------------------------------------------------------------------
// State machine: permitted + prohibited lifecycle transitions
// ---------------------------------------------------------------------------

test('state machine: permitted and prohibited lifecycle transitions', () => {
  // Permitted
  assert.equal(canTransitionLifecycle('cold', 'contacted'), true);
  assert.equal(canTransitionLifecycle('contacted', 'replied'), true);
  assert.equal(canTransitionLifecycle('replied', 'engaged'), true);
  assert.equal(canTransitionLifecycle('engaged', 'meeting_booked'), true);
  assert.equal(canTransitionLifecycle('meeting_booked', 'won'), true);
  assert.equal(canTransitionLifecycle('cold', 'disqualified'), true);
  assert.equal(canTransitionLifecycle('lost', 'recycled'), true);
  // Same-stage is allowed (no-op)
  assert.equal(canTransitionLifecycle('cold', 'cold'), true);

  // Prohibited
  assert.equal(canTransitionLifecycle('cold', 'won'), false);
  assert.equal(canTransitionLifecycle('cold', 'meeting_booked'), false);
  assert.equal(canTransitionLifecycle('disqualified', 'cold'), false);
  assert.equal(canTransitionLifecycle('won', 'contacted'), false);

  assert.throws(() => assertLifecycleTransition('cold', 'won', { reason: 'skip' }));
  assert.throws(() =>
    assertLifecycleTransition('cold', 'contacted', { reason: '' }),
  );
  // Evidence required even for legal edges
  assert.doesNotThrow(() =>
    assertLifecycleTransition('cold', 'contacted', {
      reason: 'first email accepted',
      evidence_ids: ['evt_1'],
    }),
  );

  // Every stage is known
  assert.ok(LIFECYCLE_STAGES.includes('cold'));
  assert.ok(LIFECYCLE_STAGES.includes('disqualified'));
});

test('state machine: integrity + successor atomicity on cold account', () => {
  let state = createInitialColdState('phase10_acct');
  assert.equal(
    checkStateIntegrity(state).filter((i) => i.severity === 'error').length,
    0,
  );
  assert.ok(state.next_action?.action_id);

  // Wrong completed_action_id must not silently advance
  assert.throws(() =>
    completeActionAndCreateSuccessor({
      state,
      completed_action_id: 'not_the_current_action',
      outcome: 'success',
      evidence: { reason: 'mismatch' },
      successor: {
        action_id: 'na_bad',
        action_type: 'send_email',
        account_id: 'phase10_acct',
        lifecycle_stage: 'contacted',
        sequence_state: 'active',
        work_state: 'executing_external_action',
        reason: 'should fail',
        on_success: 'x',
      },
    }),
  );

  state = completeActionAndCreateSuccessor({
    state,
    completed_action_id: state.next_action.action_id,
    outcome: 'success',
    evidence: { reason: 'foundational complete', evidence_ids: ['obs_p10'] },
    sequence_to: 'active',
    work_to: 'executing_external_action',
    successor: {
      action_id: 'na_email_p10',
      action_type: 'send_email',
      account_id: 'phase10_acct',
      contact_id: 'c1',
      lifecycle_stage: 'cold',
      sequence_state: 'active',
      work_state: 'executing_external_action',
      reason: 'prepare first email',
      on_success: 'wait',
    },
  });
  assert.equal(state.next_action.action_id, 'na_email_p10');
  assert.equal(
    checkStateIntegrity(state).filter((i) => i.severity === 'error').length,
    0,
  );

  // Actionable without next_action is integrity error
  const broken = checkStateIntegrity({
    lifecycle_stage: 'contacted',
    sequence_state: 'active',
    work_state: 'executing_external_action',
    next_action: null,
  });
  assert.ok(broken.some((i) => i.code === 'missing_next_action'));
});

// ---------------------------------------------------------------------------
// Idempotency: re-apply policy is stable (treatment/priority)
// ---------------------------------------------------------------------------

test('idempotency: re-applyOutboundPolicy yields stable treatment for same inputs', () => {
  const breakdown = [
    { id: 'operational_coordination_burden', grade: 8 },
    { id: 'repetition_and_volume', grade: 8 },
    { id: 'economic_impact_potential', grade: 7 },
    { id: 'operating_scale_surface_area', grade: 7 },
    { id: 'mission_delivery_compatibility', grade: 8 },
    { id: 'local_buying_autonomy', grade: 9 },
  ];
  const fit = calculateFitScore(breakdown);
  const record = {
    _row_id: 'phase10_idem',
    business_name: 'Phase10 HVAC',
    fit_score: fit.fit_score,
    score_breakdown: JSON.stringify(breakdown),
    identity_confidence: 90,
    buyer_confidence: 75,
    address_rdi: 'Commercial',
    contact_email: 'owner@phase10-hvac.test',
    company_resolution: 'resolved',
  };
  const contacts = [
    {
      contact_id: 'c_owner',
      name: 'Alex',
      email: 'alex@phase10-hvac.test',
      outbound_disposition: 'eligible_target',
      outreach_rank: 1,
    },
  ];

  const a = applyOutboundPolicy({
    record,
    recomputeFitFromBreakdown: true,
    contacts,
    campaignId: 'camp_phase10_idem',
  });
  const b = applyOutboundPolicy({
    record: { ...record, ...a.patch },
    recomputeFitFromBreakdown: true,
    contacts,
    campaignId: 'camp_phase10_idem',
  });

  assert.equal(a.treatment_tier, b.treatment_tier);
  assert.equal(a.mail_treatment, b.mail_treatment);
  assert.equal(a.priority_lane, b.priority_lane);
  assert.equal(a.priority_rank, b.priority_rank);
  // Priority must not collapse to fit
  assert.notEqual(Number(a.priority_rank), Number(fit.fit_score));
  assert.ok(a.patch.next_action_json);
  assert.ok(b.patch.next_action_json);
});

// ---------------------------------------------------------------------------
// Failure injection (controlled): forbidden work + provider network
// ---------------------------------------------------------------------------

test('failure injection: forbidden work hard-blocked; unipile network fails closed', async () => {
  const { assertWorkAllowed } = await import('../dist/orchestrator/policy/forbidden-channels.js');
  assert.throws(() => assertWorkAllowed({ kind: 'send_sms' }));
  assert.throws(() => assertWorkAllowed({ kind: 'field_visit' }));
  assert.throws(() => assertWorkAllowed({ kind: 'door_to_door' }));
  assert.throws(() => assertWorkAllowed({ taskType: 'automated_voice' }));
  assert.throws(() => assertWorkAllowed({ taskType: 'sms' }));

  const { executeUnipileLinkedinConnect } = await import(
    '../dist/orchestrator/channels/unipile.js'
  );
  const networkFail = await executeUnipileLinkedinConnect({
    record: { _row_id: 'p10_fail', linkedin_url: 'https://www.linkedin.com/in/p10' },
    step: { id: 'li_p10' },
    env: { UNIPILE_API_KEY: 'k', UNIPILE_DSN: 'https://api.example' },
    fetchImpl: async () => {
      throw new Error('ECONNRESET');
    },
  });
  assert.equal(networkFail.status, 'failed');
  assert.match(String(networkFail.reason || ''), /unipile_user_lookup_network_error/);

  // Auth-style HTTP failure also fails closed (no silent success)
  const authFail = await executeUnipileLinkedinConnect({
    record: { _row_id: 'p10_auth', linkedin_url: 'https://www.linkedin.com/in/p10a' },
    step: { id: 'li_p10a' },
    env: { UNIPILE_API_KEY: 'k', UNIPILE_DSN: 'https://api.example' },
    fetchImpl: async () => ({
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: 'unauthorized' }),
    }),
  });
  assert.notEqual(authFail.status, 'sent');
});
