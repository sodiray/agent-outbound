import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { normalizeConfig } from '../dist/schemas/config.js';
import { runPipelineDataflow } from '../dist/orchestrator/pipeline/dataflow.js';
import {
  persistScoreStageResult,
  runScoreStage,
} from '../dist/orchestrator/scoring/stage-runner.js';
import { openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';

const scoreStep = {
  kind: 'score',
  id: 'score_fit_initial',
  key: 'fit',
  inputs: {
    account: { from: 'business_name', required: true },
    evidence: { from: 'site_text', required: true },
  },
  model: 'openrouter/anthropic/claude-haiku-4.5',
  criteria: [{ id: 'coordination', weight: 1, description: 'Recurring administrative burden.' }],
  outputs: {
    fit_score: { type: 'number' },
    fit_breakdown: { type: 'json' },
    fit_reasoning: { type: 'string' },
  },
};

const listDir = () => mkdtempSync(join(tmpdir(), 'agent-outbound-score-stage-'));

const withDb = async (callback) => {
  const root = listDir();
  const db = openListDb({ listDir: root, readonly: false });
  const record = {
    _row_id: 'score-stage-1',
    business_name: 'Acme HVAC',
    site_text: 'No self-service booking; dispatch is coordinated by phone.',
    unrelated_secret: 'not visible to score stage',
  };
  upsertRecord({ db, row: record });
  try {
    return await callback({ db, root, record });
  } finally {
    db.close();
  }
};

test('score-stage config declares its key, criteria, model, inputs, and outputs', () => {
  assert.deepEqual(normalizeConfig({ pipeline: [scoreStep] }).errors, []);
  const invalid = normalizeConfig({
    pipeline: [{ ...scoreStep, outputs: { fit_score: { type: 'number' } } }],
  });
  assert.ok(invalid.errors.includes('pipeline.score_fit_initial (score) must declare output "fit_breakdown".'));
  assert.ok(invalid.errors.includes('pipeline.score_fit_initial (score) must declare output "fit_reasoning".'));
});

test('score stage persists a genuine all-zero grade with its populated breakdown', async () => {
  await withDb(async ({ db, root, record }) => {
    let prompt = '';
    const outcomes = await runScoreStage({
      db,
      listDir: root,
      config: {},
      step: scoreStep,
      rows: [record],
      generateObject: async (request) => {
        prompt = request.userPrompt;
        return {
          object: {
            criteria: [{ id: 'coordination', grade: 0, assessable: true, reasoning: 'Booking and dispatch evidence show no recurring coordination burden.' }],
            summary_reasoning: 'The declared criterion was graded at zero.',
          },
          usage: {},
        };
      },
    });
    assert.equal(outcomes.get(record._row_id).passed, true);
    assert.match(prompt, /Acme HVAC/);
    assert.match(prompt, /No self-service booking/);
    assert.doesNotMatch(prompt, /unrelated_secret/);
    const stored = db.prepare('SELECT fit_score, fit_breakdown, fit_reasoning FROM records WHERE _row_id = ?').get(record._row_id);
    assert.equal(stored.fit_score, 0);
    assert.equal(stored.fit_reasoning, 'The declared criterion was graded at zero.');
    const breakdown = JSON.parse(stored.fit_breakdown);
    assert.equal(breakdown.criteria[0].grade, 0);
    assert.equal(breakdown.criteria[0].contribution, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM score_events WHERE row_id = ?').get(record._row_id).count, 1);
  });
});

test('score-stage persistence rejects a numeric score without a declared graded criterion', async () => {
  await withDb(async ({ db, record }) => {
    assert.throws(() => persistScoreStageResult({
      db,
      record,
      step: scoreStep,
      calculation: {
        score: 37,
        reasoning: 'This must never be stored.',
        breakdown: { criteria: [], missing_inputs: [] },
        gradedCriterionIds: [],
      },
    }), /refused to persist a non-null score without a graded declared criterion/);
  });
});

test('not graded is persisted as null with an explicit reason, never fabricated as zero', async () => {
  await withDb(async ({ db, root, record }) => {
    const outcomes = await runScoreStage({
      db,
      listDir: root,
      config: {},
      step: scoreStep,
      rows: [record],
      generateObject: async () => ({ object: { criteria: [], summary_reasoning: 'No usable basis.' }, usage: {} }),
    });
    assert.equal(outcomes.get(record._row_id).errored, true);
    assert.equal(outcomes.get(record._row_id).reason, 'not_graded');
    const stored = db.prepare('SELECT fit_score, fit_breakdown FROM records WHERE _row_id = ?').get(record._row_id);
    assert.equal(stored.fit_score, null);
    assert.equal(JSON.parse(stored.fit_breakdown).reason, 'not_graded');
  });
});

test('dataflow records score skips and reruns only when a declared input changes', async () => {
  const root = listDir();
  writeFileSync(join(root, 'outbound.yaml'), `
pipeline:
  - kind: score
    id: score_unconfigured
    key: fit
    inputs:
      business_name: { from: business_name, required: true }
    model: openrouter/anthropic/claude-haiku-4.5
    criteria: []
    outputs:
      fit_score: { type: number }
      fit_breakdown: { type: json }
      fit_reasoning: { type: string }
`);
  const db = openListDb({ listDir: root, readonly: false });
  upsertRecord({ db, row: { _row_id: 'score-dataflow-1', business_name: 'First name', unrelated_secret: 'one' } });
  db.close();

  await runPipelineDataflow({ listDir: root });
  await runPipelineDataflow({ listDir: root });
  const update = openListDb({ listDir: root, readonly: false });
  const stored = update.prepare('SELECT * FROM records WHERE _row_id = ?').get('score-dataflow-1');
  upsertRecord({ db: update, row: { ...stored, unrelated_secret: 'two' } });
  update.close();
  await runPipelineDataflow({ listDir: root });
  const inputChange = openListDb({ listDir: root, readonly: false });
  const current = inputChange.prepare('SELECT * FROM records WHERE _row_id = ?').get('score-dataflow-1');
  upsertRecord({ db: inputChange, row: { ...current, business_name: 'Changed name' } });
  inputChange.close();
  await runPipelineDataflow({ listDir: root });

  const check = openListDb({ listDir: root, readonly: true });
  const events = check.prepare(`
    SELECT reason FROM pipeline_events
    WHERE record_id = ? AND step_id = ?
    ORDER BY occurred_at ASC
  `).all('score-dataflow-1', 'score_unconfigured').map((row) => row.reason);
  check.close();
  assert.deepEqual(events, [
    'criteria_not_configured',
    'skipped_unchanged_inputs',
    'skipped_unchanged_inputs',
    'criteria_not_configured',
  ]);
});
