/**
 * Phase B / RES-CLASSIFICATION-NORMAL-PATH:
 * - critical-path generate (account_intelligence) runs without AO_PIPELINE_FIXTURE
 * - diagnostic packs: honest opt-in via run_in_pipeline (TV has this); never
 *   require AO_PIPELINE_FIXTURE; non-opt-in generate stays deferred unless
 *   AO_RUN_GENERATE=1
 * - Zod must preserve run_in_pipeline on generate steps (was stripped)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import {
  criticalPathGenerateIds,
  includeStepInDataflow,
  selectDataflowSteps,
} from '../dist/orchestrator/pipeline/dataflow.js';
import { normalizeConfig } from '../dist/schemas/config.js';

const TV_YAML = '/Users/rayepps/projects/mission/.outbound/treasure-valley/outbound.yaml';

const tvLikeSteps = [
  { id: 'site_profile', kind: 'enrich', deps: [], step: { id: 'site_profile', kind: 'enrich' } },
  {
    id: 'account_intelligence',
    kind: 'generate',
    deps: ['site_profile'],
    step: { id: 'account_intelligence', kind: 'generate' },
  },
  {
    id: 'treatment_assignment',
    kind: 'enrich',
    deps: ['account_intelligence'],
    step: { id: 'treatment_assignment', kind: 'enrich', action: 'policy_apply' },
  },
  {
    id: 'diagnostic_content_pack',
    kind: 'generate',
    deps: ['treatment_assignment', 'account_intelligence'],
    // Default synthetic shape WITHOUT run_in_pipeline → deferred on normal path.
    step: { id: 'diagnostic_content_pack', kind: 'generate' },
  },
  {
    id: 'asset_email_body',
    kind: 'generate',
    deps: [],
    step: { id: 'asset_email_body', kind: 'generate' },
  },
];

test('critical path includes account_intelligence via treatment_assignment depends_on', () => {
  const critical = criticalPathGenerateIds(tvLikeSteps);
  assert.equal(critical.has('account_intelligence'), true);
  assert.equal(critical.has('diagnostic_content_pack'), false);
  assert.equal(critical.has('asset_email_body'), false);
});

test('normal path keeps critical generate, defers non-opt-in generate', () => {
  const selected = selectDataflowSteps(tvLikeSteps).map((s) => s.id);
  assert.ok(selected.includes('account_intelligence'), 'account_intelligence must run without fixture');
  assert.ok(selected.includes('treatment_assignment'));
  assert.equal(selected.includes('diagnostic_content_pack'), false);
  assert.equal(selected.includes('asset_email_body'), false);
});

test('AO_RUN_GENERATE=1 includes all generate steps', () => {
  const critical = criticalPathGenerateIds(tvLikeSteps);
  for (const step of tvLikeSteps) {
    const keep = includeStepInDataflow({
      step,
      criticalGenerateIds: critical,
      pipelineFixture: false,
      runGenerate: true,
    });
    assert.equal(keep, true, step.id);
  }
});

test('run_in_pipeline opt-in keeps a non-critical generate without AO_RUN_GENERATE', () => {
  const critical = criticalPathGenerateIds(tvLikeSteps);
  const diag = {
    ...tvLikeSteps.find((s) => s.id === 'diagnostic_content_pack'),
    step: { id: 'diagnostic_content_pack', kind: 'generate', run_in_pipeline: true },
  };
  assert.equal(
    includeStepInDataflow({
      step: diag,
      criticalGenerateIds: critical,
      pipelineFixture: false,
      runGenerate: false,
    }),
    true,
  );
});

test('fixture mode keeps all generate', () => {
  const critical = criticalPathGenerateIds(tvLikeSteps);
  for (const step of tvLikeSteps.filter((s) => s.kind === 'generate')) {
    assert.equal(
      includeStepInDataflow({
        step,
        criticalGenerateIds: critical,
        pipelineFixture: true,
        runGenerate: false,
      }),
      true,
      step.id,
    );
  }
});

test('TV yaml: diagnostic_content_pack run_in_pipeline survives normalizeConfig', () => {
  assert.ok(existsSync(TV_YAML), 'TV outbound.yaml must exist');
  const raw = yaml.load(readFileSync(TV_YAML, 'utf8'));
  const rawDiag = (raw.pipeline || []).find((s) => s?.id === 'diagnostic_content_pack');
  assert.equal(rawDiag?.kind, 'generate');
  assert.equal(rawDiag?.run_in_pipeline, true, 'TV author intent: diagnostic on production path');

  const normalized = normalizeConfig(raw, {
    listDir: '/Users/rayepps/projects/mission/.outbound/treasure-valley',
  });
  assert.deepEqual(
    normalized.errors || [],
    [],
  );
  const diag = (normalized.config.pipeline || []).find((s) => s?.id === 'diagnostic_content_pack');
  assert.ok(diag, 'diagnostic_content_pack present after normalize');
  assert.equal(
    diag.run_in_pipeline,
    true,
    'Zod must not strip run_in_pipeline (was residual hole)',
  );

  // Dataflow selection with TV-shaped steps must keep diagnostic without fixture.
  const steps = (normalized.config.pipeline || []).map((s, index) => ({
    id: String(s.id || `step_${index}`),
    kind: String(s.kind || ''),
    deps: [...(s.depends_on || []), ...(s.runs_after || [])].map(String),
    step: s,
  }));
  const selected = selectDataflowSteps(steps).map((s) => s.id);
  assert.ok(selected.includes('account_intelligence'), 'critical generate on normal path');
  assert.ok(
    selected.includes('diagnostic_content_pack'),
    'TV diagnostic pack opt-in must run without AO_PIPELINE_FIXTURE / AO_RUN_GENERATE',
  );
});
