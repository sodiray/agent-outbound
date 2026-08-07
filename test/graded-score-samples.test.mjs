import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { normalizeConfig } from '../dist/schemas/config.js';
import { openListDb } from '../dist/orchestrator/runtime/db.js';
import { applyOutboundPolicy } from '../dist/orchestrator/policy/index.js';
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

test('graded scoring marks cited evidence gaps unassessable instead of low-grade', async () => {
  const { db, listDir, record } = createContext();
  const response = {
    criteria: [{
      id: 'commercial_fit',
      assessable: false,
      reasoning: 'The cited site profile contains no service or workflow detail.',
      evidence_ids: ['obs_3'],
    }],
    summary_reasoning: 'Insufficient operational evidence.',
  };
  const generateObject = async () => modelResult(response);

  try {
    const result = await scoreAxisCriteriaGraded({
      db,
      listDir,
      record,
      axis: 'score',
      description: 'Evaluate commercial fit.',
      criteria,
      aiConfig: {},
      generateObject,
    });

    assert.equal(result.score, null);
    assert.equal(result.score_status, 'needs_discovery');
    assert.equal(result.fit_coverage, 0);
    assert.equal(result.breakdown[0].assessable, false);
    assert.equal(result.breakdown[0].grade, 0);
    assert.deepEqual(result.breakdown[0].evidence_ids, ['obs_3']);
    assert.match(result.reasoning, /Fit coverage: 0%; unassessable: commercial_fit/);
  } finally {
    db.close();
  }
});

test('graded scoring renormalizes over assessable weights', async () => {
  const { db, listDir, record } = createContext();
  const weightedCriteria = [
    { id: 'operational_coordination_burden', description: 'Coordination burden', weight: 0.75 },
    { id: 'repetition_and_volume', description: 'Repetition and volume', weight: 0.25 },
  ];
  const response = {
    criteria: [
      {
        id: 'operational_coordination_burden',
        assessable: true,
        grade: 8,
        reasoning: 'The service evidence shows multi-party scheduling work.',
        evidence_ids: ['obs_8'],
      },
      {
        id: 'repetition_and_volume',
        assessable: false,
        reasoning: 'The cited site profile gives no recurring-job or volume evidence.',
        evidence_ids: ['obs_3'],
      },
    ],
    summary_reasoning: 'Only coordination is assessable.',
  };
  const generateObject = async () => modelResult(response);

  try {
    const result = await scoreAxisCriteriaGraded({
      db,
      listDir,
      record,
      axis: 'score',
      description: 'Evaluate commercial fit.',
      criteria: weightedCriteria,
      aiConfig: {},
      generateObject,
    });

    assert.equal(result.fit_coverage, 0.75);
    assert.equal(result.score, 80);
    assert.equal(result.breakdown[1].assessable, false);
  } finally {
    db.close();
  }
});

test('graded scoring coverage guard sends thin fit evidence to enrichment_hold', async () => {
  const { db, listDir, record } = createContext();
  const thinCriteria = [
    { id: 'operational_coordination_burden', description: 'Coordination burden', weight: 0.4 },
    { id: 'repetition_and_volume', description: 'Repetition and volume', weight: 0.6 },
  ];
  const response = {
    criteria: [
      {
        id: 'operational_coordination_burden',
        assessable: true,
        grade: 10,
        reasoning: 'The cited services show substantial scheduling coordination.',
        evidence_ids: ['obs_8'],
      },
      {
        id: 'repetition_and_volume',
        assessable: false,
        reasoning: 'The cited profile does not disclose repeat work or job volume.',
        evidence_ids: ['obs_3'],
      },
    ],
    summary_reasoning: 'Too little fit evidence for a confident score.',
  };
  const generateObject = async () => modelResult(response);

  try {
    const result = await scoreAxisCriteriaGraded({
      db,
      listDir,
      record,
      axis: 'score',
      description: 'Evaluate commercial fit.',
      criteria: thinCriteria,
      aiConfig: {},
      generateObject,
    });
    const policy = applyOutboundPolicy({
      recomputeFitFromBreakdown: true,
      record: {
        ...record,
        is_a_business: true,
        company_resolution: 'resolved',
        identity_confidence: 90,
        fit_score: result.score,
        fit_coverage: result.fit_coverage,
        score_breakdown: JSON.stringify(result.breakdown),
      },
    });

    assert.equal(result.score, null);
    assert.equal(result.score_status, 'needs_discovery');
    assert.equal(policy.treatment_tier, 'enrichment_hold');
    assert.equal(policy.patch.fit_score, null);
    assert.equal(policy.patch.candidate_tier, 'hold');
    assert.equal(JSON.parse(policy.patch.next_action_json).action_type, 'enrichment_repair');
  } finally {
    db.close();
  }
});

test('graded scoring keeps fully evidenced scores unchanged', async () => {
  const { db, listDir, record } = createContext();
  const fullyEvidencedCriteria = [
    { id: 'operational_coordination_burden', description: 'Coordination burden', weight: 0.75 },
    { id: 'repetition_and_volume', description: 'Repetition and volume', weight: 0.25 },
  ];
  const response = {
    criteria: [
      {
        id: 'operational_coordination_burden',
        assessable: true,
        grade: 8,
        reasoning: 'The cited services show high coordination burden.',
        evidence_ids: ['obs_8'],
      },
      {
        id: 'repetition_and_volume',
        assessable: true,
        grade: 6,
        reasoning: 'The cited services show a moderate repeat-work signal.',
        evidence_ids: ['obs_6'],
      },
    ],
    summary_reasoning: 'Fully evidenced fit.',
  };
  const generateObject = async () => modelResult(response);

  try {
    const result = await scoreAxisCriteriaGraded({
      db,
      listDir,
      record,
      axis: 'score',
      description: 'Evaluate commercial fit.',
      criteria: fullyEvidencedCriteria,
      aiConfig: {},
      generateObject,
    });

    assert.equal(result.fit_coverage, 1);
    assert.equal(result.score, 75);
    assert.equal(result.score_status, 'fresh');
  } finally {
    db.close();
  }
});
