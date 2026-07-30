#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { readConfig } from '../dist/orchestrator/lib/config.js';
import {
  flattenPipelineSteps,
} from '../dist/orchestrator/lib/subpipelines.js';
import { clearStepState } from '../dist/orchestrator/lib/step-cleanup.js';
import { runPipelineDataflow } from '../dist/orchestrator/pipeline/dataflow.js';
import {
  insertPipelineEvent,
  openListDb,
  upsertRecord,
} from '../dist/orchestrator/runtime/db.js';

const directories = [];
const makeConfig = (yaml) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-subpipeline-'));
  directories.push(listDir);
  writeFileSync(join(listDir, 'outbound.yaml'), yaml);
  return listDir;
};

const readYaml = (yaml) => readConfig(makeConfig(yaml));

const runtimeYaml = `list:
  name: subpipeline-runtime
sequences:
  default:
    steps: []
ai:
  default_model: anthropic/claude-sonnet-4-6
  defaults:
    evaluation: anthropic/claude-haiku-4-5-20251001
    copywriting: anthropic/claude-opus-4-6
    research: anthropic/claude-sonnet-4-6
pipeline:
  - kind: assign
    id: assign_pipeline
    target: pipeline_name
    fallback: unrouted
    rules:
      - id: dental_rule
        pipeline: dental
        conditions:
          - {field: vertical, operator: eq, value: dental}
      - id: cre_rule
        pipeline: cre
        conditions:
          - {field: vertical, operator: eq, value: cre}
  - kind: pipeline
    id: dental
    steps:
      - kind: filter
        id: eligible
        type: field_check
        conditions:
          - {field: suppressed, operator: eq, value: 0}
      - kind: wait
        id: wait_3d
        depends_on: [eligible]
        after: 3d
  - kind: pipeline
    id: cre
    steps:
      - kind: filter
        id: eligible
        type: field_check
        conditions:
          - {field: suppressed, operator: eq, value: 0}
      - kind: wait
        id: wait_3d
        depends_on: [eligible]
        after: 3d
  - kind: pipeline
    id: unrouted
    manual: true
    steps:
      - kind: wait
        id: holding_wait
        after: 1d
`;

try {
  const silent = readYaml(`list:\n  name: silent\nsequences:\n  default:\n    steps: []\n`);
  assert.deepEqual(silent.errors, []);
  assert.deepEqual(silent.warnings, []);

  const defaultPipeline = readYaml(`list:
  name: default-pipeline
pipeline:
  - kind: pipeline
    id: default
    steps:
      - kind: wait
        id: initial_wait
        after: 1d
`);
  assert.deepEqual(defaultPipeline.errors, []);

  const unnamedRoute = readYaml(`list:
  name: unnamed-route
pipeline:
  - kind: pipeline
    id: dental
    steps: []
`);
  assert.match(unnamedRoute.errors.join(' '), /no kind: assign step targeting pipeline_name/i);

  const runtimeDir = makeConfig(runtimeYaml);
  const runtimeConfig = readConfig(runtimeDir);
  assert.deepEqual(runtimeConfig.errors, []);
  assert.deepEqual(runtimeConfig.warnings, []);
  const flattened = flattenPipelineSteps(runtimeConfig.config);
  assert.deepEqual(
    flattened.map((step) => step.id),
    [
      'assign_pipeline',
      'dental.eligible',
      'dental.wait_3d',
      'cre.eligible',
      'cre.wait_3d',
      'unrouted.holding_wait',
    ],
  );
  assert.deepEqual(
    flattened.find((step) => step.id === 'dental.wait_3d')?.depends_on,
    ['dental.eligible'],
  );

  const undefinedTarget = readYaml(`${runtimeYaml.replace('pipeline: dental', 'pipeline: missing')}`);
  assert.match(undefinedTarget.errors.join(' '), /undefined sub-pipeline "missing"/i);

  const collision = readYaml(`list:
  name: collision
pipeline:
  - kind: filter
    id: dental.wait_3d
    type: field_check
    conditions: []
  - kind: pipeline
    id: dental
    steps:
      - kind: wait
        id: wait_3d
        after: 3d
`);
  assert.match(collision.errors.join(' '), /collides with top-level/i);

  const nested = readYaml(`list:
  name: nested
pipeline:
  - kind: pipeline
    id: outer
    steps:
      - kind: pipeline
        id: inner
        steps: []
`);
  assert.ok(nested.errors.length > 0);

  const activeFallback = readYaml(`list:
  name: fallback
pipeline:
  - kind: assign
    id: assign_pipeline
    target: pipeline_name
    fallback: unrouted
    rules:
      - pipeline: dental
        conditions: []
  - kind: pipeline
    id: dental
    steps: []
  - kind: pipeline
    id: unrouted
    steps:
      - kind: wait
        id: accidental_work
        after: 1d
`);
  assert.match(activeFallback.errors.join(' '), /fallback.*manual/i);

  const db = openListDb({ listDir: runtimeDir, readonly: false });
  const createdAt = '2026-01-01T00:00:00.000Z';
  [
    { _row_id: 'dental-idle', business_name: 'Dental Idle', vertical: 'dental' },
    { _row_id: 'cre-idle', business_name: 'CRE Idle', vertical: 'cre' },
    { _row_id: 'unrouted-idle', business_name: 'Unrouted Idle', vertical: 'other' },
    {
      _row_id: 'dental-active',
      business_name: 'Dental Active',
      vertical: 'dental',
      sequence_name: 'legacy_dental',
      sequence_status: 'active',
    },
  ].forEach((record) => {
    upsertRecord({
      db,
      row: {
        ...record,
        created_at: createdAt,
        updated_at: createdAt,
      },
    });
  });
  db.close();

  await runPipelineDataflow({ listDir: runtimeDir, clock: createdAt });

  const afterFirstRun = openListDb({ listDir: runtimeDir, readonly: true });
  const dental = afterFirstRun.prepare('SELECT * FROM records WHERE _row_id = ?').get('dental-idle');
  const cre = afterFirstRun.prepare('SELECT * FROM records WHERE _row_id = ?').get('cre-idle');
  const unrouted = afterFirstRun.prepare('SELECT * FROM records WHERE _row_id = ?').get('unrouted-idle');
  const active = afterFirstRun.prepare('SELECT * FROM records WHERE _row_id = ?').get('dental-active');
  assert.equal(dental.pipeline_name, 'dental');
  assert.equal(dental.routed_by, 'dental_rule');
  assert.equal(cre.pipeline_name, 'cre');
  assert.equal(cre.routed_by, 'cre_rule');
  assert.equal(unrouted.pipeline_name, 'unrouted');
  assert.equal(unrouted.routed_by, 'fallback');
  assert.equal(active.pipeline_name, 'default');
  assert.equal(active.sequence_name, 'legacy_dental');
  assert.equal(active.sequence_status, 'active');
  const firstEvents = afterFirstRun.prepare(`
    SELECT record_id, step_id, passed, reason
    FROM pipeline_events
    ORDER BY record_id, step_id, occurred_at
  `).all();
  assert.ok(firstEvents.some((event) => (
    event.record_id === 'dental-idle'
    && event.step_id === 'dental.wait_3d'
    && event.passed === 0
    && event.reason === 'wake_at'
  )));
  assert.ok(firstEvents.some((event) => (
    event.record_id === 'cre-idle'
    && event.step_id === 'cre.wait_3d'
    && event.passed === 0
  )));
  assert.ok(!firstEvents.some((event) => (
    event.record_id === 'dental-idle'
    && event.step_id.startsWith('cre.')
  )));
  assert.ok(!firstEvents.some((event) => (
    event.record_id === 'dental-active'
    && event.step_id.includes('.')
  )));
  assert.ok(!firstEvents.some((event) => (
    event.record_id === 'unrouted-idle'
    && event.step_id.startsWith('unrouted.')
  )));
  afterFirstRun.close();

  await runPipelineDataflow({
    listDir: runtimeDir,
    clock: '2026-01-05T00:00:00.000Z',
  });

  const afterWake = openListDb({ listDir: runtimeDir, readonly: false });
  const completedWaits = afterWake.prepare(`
    SELECT record_id, step_id
    FROM pipeline_events
    WHERE passed = 1 AND kind = 'wait'
    ORDER BY record_id
  `).all();
  assert.deepEqual(completedWaits, [
    { record_id: 'cre-idle', step_id: 'cre.wait_3d' },
    { record_id: 'dental-idle', step_id: 'dental.wait_3d' },
  ]);

  insertPipelineEvent({
    db: afterWake,
    event: {
      event_id: randomUUID(),
      record_id: 'dental-idle',
      step_id: 'dental.touch',
      kind: 'send_email',
      passed: true,
      side_effecting: false,
      occurred_at: '2026-01-05T01:00:00.000Z',
    },
  });
  const sideEffectConfig = {
    pipeline: [{
      kind: 'pipeline',
      id: 'dental',
      steps: [{
        kind: 'send_email',
        id: 'touch',
        side_effecting: true,
      }],
    }],
  };
  assert.throws(
    () => clearStepState({
      db: afterWake,
      config: sideEffectConfig,
      stepId: 'dental.touch',
      recordId: 'dental-idle',
    }),
    /Refusing to clear completed side-effecting step "dental\.touch"/,
  );
  const cleared = clearStepState({
    db: afterWake,
    config: sideEffectConfig,
    stepId: 'dental.touch',
    recordId: 'dental-idle',
    allowSideEffectingClear: true,
  });
  assert.equal(cleared.sideEffectOverrideUsed, true);
  afterWake.close();

  console.log('sub-pipeline tests passed');
} finally {
  directories.forEach((directory) => rmSync(directory, { recursive: true, force: true }));
}
