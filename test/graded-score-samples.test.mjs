import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { normalizeConfig } from '../dist/schemas/config.js';
import { openListDb } from '../dist/orchestrator/runtime/db.js';
import { scoreAxisCriteriaGraded } from '../dist/orchestrator/scoring/runner.js';

const criteria = [{ id: 'commercial_fit', description: 'Commercial fit', weight: 1 }];

const sample = ({ grade, reasoning, evidenceId, summary = 'Sample summary' }) => ({
  criteria: [{ id: 'commercial_fit', grade, reasoning, evidence_ids: [evidenceId] }],
  summary_reasoning: summary,
});

const createContext = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-graded-score-samples-'));
  return {
    db: openListDb({ listDir, readonly: false }),
    listDir,
    record: {
      _row_id: 'graded_sample_record',
      business_name: 'Median Mechanical',
      observations_json: JSON.stringify({
        observations: ['obs_3', 'obs_6', 'obs_7', 'obs_8'].map((evidence_id) => ({ evidence_id })),
      }),
    },
  };
};

const modelResult = (object) => ({
  object,
  model: 'test-model',
  provider: 'test-provider',
  usage: { input_tokens: 10, output_tokens: 4, usd_cost: 0.001 },
});

test('score.samples defaults to one and rejects non-positive or fractional values', () => {
  assert.equal(normalizeConfig({ score: {} }).config.score.samples, 1);
  assert.equal(normalizeConfig({ score: { samples: 0 } }).errors.length, 1);
  assert.equal(normalizeConfig({ score: { samples: 1.5 } }).errors.length, 1);
});

test('graded scoring uses the lower median, matching rationale/evidence, concurrent samples, and one cost event per sample', async () => {
  const { db, listDir, record } = createContext();
  const responses = [
    sample({ grade: 8, reasoning: 'reason for eight', evidenceId: 'obs_8' }),
    sample({ grade: 3, reasoning: 'reason for three', evidenceId: 'obs_3' }),
    sample({ grade: 6, reasoning: 'reason for six', evidenceId: 'obs_6' }),
    sample({ grade: 7, reasoning: 'reason for seven', evidenceId: 'obs_7' }),
  ];
  const state = { next: 0, active: 0, maxActive: 0 };
  const generateObject = async () => {
    const response = responses[state.next];
    state.next += 1;
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    state.active -= 1;
    return modelResult(response);
  };

  try {
    const result = await scoreAxisCriteriaGraded({
      db,
      listDir,
      record,
      axis: 'score',
      description: 'Evaluate commercial fit.',
      criteria,
      aiConfig: {},
      samples: 4,
      generateObject,
    });

    assert.equal(state.maxActive, 4);
    assert.equal(result.score, 60);
    assert.deepEqual(result.breakdown[0], {
      id: 'commercial_fit',
      description: 'Commercial fit',
      grade: 6,
      verdict: 'partial',
      sub_score: 0.6,
      reasoning: 'reason for six',
      evidence_ids: ['obs_6'],
      weight: 1,
      points: 60,
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM cost_events').get().count, 4);
  } finally {
    db.close();
  }
});

test('graded scoring reduces successful samples when one sample fails', async () => {
  const { db, listDir, record } = createContext();
  const responses = [
    modelResult(sample({ grade: 7, reasoning: 'reason for seven', evidenceId: 'obs_7' })),
    new Error('temporary provider failure'),
    modelResult(sample({ grade: 6, reasoning: 'reason for six', evidenceId: 'obs_6' })),
  ];
  const state = { next: 0 };
  const generateObject = async () => {
    const response = responses[state.next];
    state.next += 1;
    if (response instanceof Error) throw response;
    return response;
  };

  try {
    const result = await scoreAxisCriteriaGraded({
      db,
      listDir,
      record,
      axis: 'score',
      description: 'Evaluate commercial fit.',
      criteria,
      aiConfig: {},
      samples: 3,
      generateObject,
    });

    assert.equal(result.score, 60);
    assert.equal(result.breakdown[0].reasoning, 'reason for six');
    assert.deepEqual(result.breakdown[0].evidence_ids, ['obs_6']);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM cost_events').get().count, 2);
  } finally {
    db.close();
  }
});

test('graded scoring with samples one matches the default behavior', async () => {
  const { db, listDir, record } = createContext();
  const response = sample({ grade: 7, reasoning: 'reason for seven', evidenceId: 'obs_7' });
  const generateObject = async () => modelResult(response);

  try {
    const defaultResult = await scoreAxisCriteriaGraded({
      db,
      listDir,
      record,
      axis: 'score',
      description: 'Evaluate commercial fit.',
      criteria,
      aiConfig: {},
      generateObject,
    });
    const explicitResult = await scoreAxisCriteriaGraded({
      db,
      listDir,
      record,
      axis: 'score',
      description: 'Evaluate commercial fit.',
      criteria,
      aiConfig: {},
      samples: 1,
      generateObject,
    });

    assert.deepEqual(explicitResult, defaultResult);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM cost_events').get().count, 2);
  } finally {
    db.close();
  }
});
