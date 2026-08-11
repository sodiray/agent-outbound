import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applyReviewDecisionsForViz } from '../dist/viz/data.js';
import { getAllReviewQueue, getReviewQueue } from '../dist/orchestrator/pipeline/review.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';

const CONFIG = {
  pipeline: [
    { kind: 'review', id: 'review_alpha', label: 'Alpha review', fields: ['priority'], title_field: 'venue_title' },
    { kind: 'review', id: 'review_beta', label: 'Beta review', fields: ['category'], title_field: 'account_label' },
  ],
};

const createQueue = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-viz-review-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
list:
  name: Review fixture
pipeline:
  - kind: review
    id: review_alpha
    label: Alpha review
    fields: [priority]
    title_field: venue_title
  - kind: review
    id: review_beta
    label: Beta review
    fields: [category]
    title_field: account_label
`);
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: ['priority', 'category', 'venue_title', 'account_label'] });
  const records = [
    { id: 'alpha-1', priority: '2', category: 'one', stage: 'review_alpha' },
    { id: 'alpha-2', priority: '1', category: 'two', stage: 'review_alpha' },
    { id: 'alpha-3', priority: '2', category: 'three', stage: 'review_alpha' },
    { id: 'alpha-4', priority: '3', category: 'four', stage: 'review_alpha' },
    { id: 'shared', priority: '4', category: 'shared', stage: 'review_alpha' },
    { id: 'shared', priority: '4', category: 'shared', stage: 'review_beta' },
    { id: 'beta-1', priority: '9', category: 'beta', stage: 'review_beta' },
  ];
  [...new Map(records.map((record) => [record.id, record])).values()].forEach((record) => {
    upsertRecord({
      db,
      row: {
        _row_id: record.id,
        business_name: `Record ${record.id}`,
        priority: record.priority,
        category: record.category,
        venue_title: `Venue ${record.id}`,
        account_label: `Account ${record.id}`,
      },
    });
  });
  records.forEach((record, index) => {
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
      VALUES (?, ?, ?, 'review', 0, 'awaiting_review', ?)
    `).run(`event-${index}`, record.id, record.stage, `2026-08-11T12:${String(index).padStart(2, '0')}:00Z`);
  });
  return { db, listDir };
};

test('review queue sorting accepts declared fields in both directions and remains stable across pages', () => {
  const { db } = createQueue();
  try {
    const ascending = getReviewQueue({
      db,
      config: CONFIG,
      stageId: 'review_alpha',
      sort: 'priority',
      dir: 'asc',
      limit: 100,
    });
    const descending = getReviewQueue({
      db,
      config: CONFIG,
      stageId: 'review_alpha',
      sort: 'priority',
      dir: 'desc',
      limit: 100,
    });
    assert.deepEqual(ascending.records.map((record) => record.priority), ['1', '2', '2', '3', '4']);
    assert.deepEqual(descending.records.map((record) => record.priority), ['4', '3', '2', '2', '1']);

    const firstPage = getReviewQueue({
      db,
      config: CONFIG,
      stageId: 'review_alpha',
      sort: 'priority',
      dir: 'asc',
      limit: 2,
      offset: 0,
    });
    const secondPage = getReviewQueue({
      db,
      config: CONFIG,
      stageId: 'review_alpha',
      sort: 'priority',
      dir: 'asc',
      limit: 2,
      offset: 2,
    });
    const thirdPage = getReviewQueue({
      db,
      config: CONFIG,
      stageId: 'review_alpha',
      sort: 'priority',
      dir: 'asc',
      limit: 2,
      offset: 4,
    });
    const pagedIds = [...firstPage.records, ...secondPage.records, ...thirdPage.records].map((record) => record._row_id);
    assert.deepEqual(pagedIds, ascending.records.map((record) => record._row_id));
    assert.equal(new Set(pagedIds).size, ascending.total);
  } finally {
    db.close();
  }
});

test('review queues project declared title fields even when they are not table fields', () => {
  const { db } = createQueue();
  try {
    const singleStage = getReviewQueue({
      db,
      config: CONFIG,
      stageId: 'review_alpha',
      limit: 100,
    });
    assert.equal(singleStage.stage.title_field, 'venue_title');
    assert.equal(singleStage.records[0].venue_title, 'Venue alpha-1');
    assert.deepEqual(singleStage.stage.fields, ['priority']);

    const allStages = getAllReviewQueue({ db, config: CONFIG, limit: 100 });
    assert.deepEqual(allStages.stage.fields, ['priority', 'category']);
    assert.equal(allStages.records[0].venue_title, 'Venue alpha-1');
    assert.equal(allStages.records.at(-1).account_label, 'Account beta-1');
  } finally {
    db.close();
  }
});

test('review queue rejects unknown sort fields before SQL execution', () => {
  const { db } = createQueue();
  try {
    assert.throws(() => getReviewQueue({
      db,
      config: CONFIG,
      stageId: 'review_alpha',
      sort: 'priority; DROP TABLE records; --',
      dir: 'asc',
    }), /Unknown review sort field/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM records').get().count, 6);
  } finally {
    db.close();
  }
});

test('all review stages labels every pending decision and keeps a distinct-record count', () => {
  const { db } = createQueue();
  try {
    const queue = getAllReviewQueue({ db, config: CONFIG, limit: 100 });
    assert.equal(queue.total, 7);
    assert.equal(queue.unique_total, 6);
    assert.deepEqual(
      queue.records.map((record) => [record._row_id, record._review_stage_id, record._review_stage_label]),
      [
        ['alpha-1', 'review_alpha', 'Alpha review'],
        ['alpha-2', 'review_alpha', 'Alpha review'],
        ['alpha-3', 'review_alpha', 'Alpha review'],
        ['alpha-4', 'review_alpha', 'Alpha review'],
        ['shared', 'review_alpha', 'Alpha review'],
        ['shared', 'review_beta', 'Beta review'],
        ['beta-1', 'review_beta', 'Beta review'],
      ],
    );
  } finally {
    db.close();
  }
});

test('a combined-queue decision uses the row stage rather than another active stage', () => {
  const { db, listDir } = createQueue();
  try {
    const queue = getAllReviewQueue({ db, config: CONFIG, limit: 100 });
    const selected = queue.records.find((record) => (
      record._row_id === 'shared' && record._review_stage_id === 'review_beta'
    ));
    assert.ok(selected);
    db.close();

    const result = applyReviewDecisionsForViz(listDir, selected._review_stage_id, [{
      row_id: selected._row_id,
      verdict: 'approve',
    }]);
    assert.equal(result.applied, 1);

    const verifyDb = openListDb({ listDir, readonly: false });
    try {
      const after = getAllReviewQueue({ db: verifyDb, config: CONFIG, limit: 100 });
      assert.ok(after.records.some((record) => record._row_id === 'shared' && record._review_stage_id === 'review_alpha'));
      assert.ok(!after.records.some((record) => record._row_id === 'shared' && record._review_stage_id === 'review_beta'));
      assert.equal(
        verifyDb.prepare(`SELECT created_by FROM overrides WHERE record_id = ? AND kind = 'keep'`).get('shared').created_by,
        'review:review_beta',
      );
    } finally {
      verifyDb.close();
    }
  } finally {
    try { db.close(); } catch {}
  }
});
