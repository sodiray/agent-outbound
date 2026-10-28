import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyReviewDecisionsForViz,
  clearReviewDecisionForViz,
  getPipelineForViz,
  getPipelineStepRecordsForViz,
  getReviewQueueForViz,
  reviewQueuePageForViz,
} from '../dist/viz/data.js';
import { canDecide, reviewShortcut, undoTargetFor } from '../dist/viz/review-gate.js';
import { readConfig } from '../dist/orchestrator/lib/config.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { ensureEventTurns } from '../dist/orchestrator/pipeline/on-event-turns.js';

const PIPELINE_CONFIG = `
list:
  name: Neutral fixture
pipeline:
  - kind: enrich
    id: gather
    inputs: [business_name]
    outputs:
      score_value: { type: number, description: Gathered score. }
  - kind: filter
    id: branch
    depends_on: [gather]
    inputs: [score_value, note]
    type: field_check
    conditions:
      - { field: score_value, operator: gte, value: 1 }
    when:
      match: any
      conditions:
        - { field: score_value, operator: is_not_empty }
        - { field: note, operator: not_matches, value: '^skip' }
  - kind: enrich
    id: alternate
    depends_on: [gather]
    inputs: [business_name]
    outputs:
      alt_note: { type: string, description: Alternate note. }
  - kind: review
    id: review_gate
    depends_on: [branch, alternate]
    fields: [score_value]
    edit_fields: [note]
  - kind: await_event
    id: wait_step
    depends_on: [review_gate]
    inputs: [enrollment_ref]
    source: outreach
    event: message_sent
    reference_field: enrollment_ref
    output_map: { sent_at: occurred_at }
    outputs:
      sent_at: { type: string, description: Sent timestamp. }
  - kind: on_event
    id: reply_turn
    depends_on: [wait_step]
    source: outreach
    event: response_received
    reference_field: enrollment_ref
    steps:
      - kind: enrich
        id: follow_up
        inputs: [business_name]
        outputs:
          reply_note: { type: string, description: Reply note. }
      - kind: enrich
        id: summarize
        depends_on: [follow_up]
        inputs: [reply_note]
        outputs:
          reply_summary: { type: string, description: Reply summary. }
`;

const at = (minute) => `2026-10-24T00:${String(minute).padStart(2, '0')}:00.000Z`;

const insertEvent = (db, { record, step, kind = 'enrich', passed, reason = '', minute }) => db.prepare(`
  INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(`${record}:${step}:${minute}`, record, step, kind, passed ? 1 : 0, reason, at(minute));

const insertCost = (db, { id, step, usd }) => db.prepare(`
  INSERT INTO cost_events (id, record_id, step_id, usd_cost, occurred_at) VALUES (?, '', ?, ?, ?)
`).run(id, step, usd, at(0));

const insertRun = (db, { id, status, step, updatedAt }) => db.prepare(`
  INSERT INTO run_state (run_id, phase, active_step, status, started_at, updated_at)
  VALUES (?, 'pipeline', ?, ?, ?, ?)
`).run(id, step, status, updatedAt, updatedAt);

const RECORD_IDS = ['r_pass', 'r_when', 'r_dropped_elsewhere', 'r_unresolved', 'r_blocked', 'r_drop', 'r_wait', 'r_approve', 'r_reject'];

// Each record exercises one state:
// - r_pass has history at `gather`: a soft non-pass, then a pass, then a
//   not-attempted marker. Its latest outcome is the pass.
// - r_when is skipped at `branch` by its `when` predicate.
// - r_dropped_elsewhere and r_unresolved never reach `branch`/`alternate`.
// - r_blocked errors at `gather` and is blocked downstream.
// - r_drop is dropped by the `branch` gate.
// - r_wait, r_approve and r_reject park at `review_gate`.
const pipelineFixture = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-viz-pipeline-'));
  writeFileSync(join(listDir, 'outbound.yaml'), PIPELINE_CONFIG);
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: ['score_value', 'note'] });
  RECORD_IDS.forEach((id) => upsertRecord({ db, row: { _row_id: id, business_name: `Neutral ${id}`, score_value: '2' } }));

  insertEvent(db, { record: 'r_pass', step: 'gather', passed: false, reason: 'provider_returned_no_content', minute: 1 });
  insertEvent(db, { record: 'r_pass', step: 'gather', passed: true, minute: 2 });
  insertEvent(db, { record: 'r_pass', step: 'gather', passed: false, reason: 'skipped:already_resolved', minute: 3 });

  insertEvent(db, { record: 'r_when', step: 'gather', passed: true, minute: 1 });
  insertEvent(db, { record: 'r_when', step: 'branch', kind: 'filter', passed: true, reason: 'skipped:Score value is empty (a value is required)', minute: 2 });

  insertEvent(db, { record: 'r_dropped_elsewhere', step: 'gather', passed: true, minute: 1 });
  insertEvent(db, { record: 'r_dropped_elsewhere', step: 'branch', kind: 'filter', passed: false, reason: 'skipped:record_dropped', minute: 2 });
  insertEvent(db, { record: 'r_dropped_elsewhere', step: 'alternate', passed: false, reason: 'skipped:record_dropped', minute: 2 });

  insertEvent(db, { record: 'r_unresolved', step: 'branch', kind: 'filter', passed: false, reason: 'skipped:unresolved_dependencies:gather', minute: 2 });
  insertEvent(db, { record: 'r_unresolved', step: 'alternate', passed: false, reason: 'skipped:unresolved_dependencies:gather', minute: 2 });

  db.prepare(`
    INSERT INTO errored_events (run_id, record_id, step_id, kind, error, occurred_at)
    VALUES ('run-1', 'r_blocked', 'gather', 'enrich', 'tool failed', ?)
  `).run(at(1));
  insertEvent(db, { record: 'r_blocked', step: 'branch', kind: 'filter', passed: false, reason: 'skipped:upstream_errored:gather', minute: 2 });

  insertEvent(db, { record: 'r_drop', step: 'gather', passed: true, minute: 1 });
  insertEvent(db, { record: 'r_drop', step: 'branch', kind: 'filter', passed: false, reason: 'Score value is 0 — below the minimum of 1', minute: 2 });
  db.prepare("UPDATE records SET disqualified_at = ?, disqualified_gate = 'branch' WHERE _row_id = 'r_drop'").run(at(2));

  ['r_wait', 'r_approve', 'r_reject'].forEach((record, index) => {
    insertEvent(db, { record, step: 'gather', passed: true, minute: 1 });
    insertEvent(db, { record, step: 'branch', kind: 'filter', passed: true, minute: 2 });
    insertEvent(db, { record, step: 'alternate', passed: true, minute: 2 });
    insertEvent(db, { record, step: 'review_gate', kind: 'review', passed: false, reason: 'awaiting_review', minute: 3 + index });
  });

  insertCost(db, { id: 'cost-1', step: 'pipeline_enrich:gather', usd: 0.12 });
  insertCost(db, { id: 'cost-2', step: 'pipeline_enrich:gather', usd: 0.03 });
  insertCost(db, { id: 'cost-3', step: 'sourcing:dedup', usd: 0.01 });
  insertCost(db, { id: 'cost-4', step: 'pipeline_enrich:removed_step', usd: 0.4 });
  insertCost(db, { id: 'cost-5', step: 'branch', usd: null });
  insertCost(db, { id: 'cost-6', step: 'pipeline_enrich:reply_turn:1:follow_up', usd: 0.05 });

  ensureEventTurns(db);
  db.prepare(`
    INSERT INTO event_turns (turn_id, record_id, block_id, source, event_id, turn_index, status, opened_at)
    VALUES ('turn-1', 'r_wait', 'reply_turn', 'outreach', 'event-1', 1, 'open', ?)
  `).run(at(5));
  db.prepare(`
    INSERT INTO event_turn_steps (turn_id, step_id, kind, status, reason, occurred_at)
    VALUES ('turn-1', 'follow_up', 'enrich', 'passed', '', ?), ('turn-1', 'summarize', 'enrich', 'errored', 'failed', ?)
  `).run(at(5), at(6));
  db.close();
  return listDir;
};

const decide = (listDir) => {
  const result = applyReviewDecisionsForViz(listDir, 'review_gate', [
    { row_id: 'r_approve', verdict: 'approve' },
    { row_id: 'r_reject', verdict: 'reject', reason: 'reviewed: not a fit' },
  ]);
  assert.equal(result.applied, 2, JSON.stringify(result.results));
};

const nodeById = (graph, id) => {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  assert.ok(node, `missing node ${id}`);
  return node;
};

const approximately = (actual, expected) => assert.ok(Math.abs(Number(actual) - expected) < 1e-9, `${actual} ≉ ${expected}`);

test('a record with history counts once, in its latest outcome state', () => {
  const listDir = pipelineFixture();
  const gather = nodeById(getPipelineForViz(listDir), 'gather');
  assert.equal(gather.counts.passed, 7);
  assert.equal(gather.counts.failed, 0);
  assert.equal(gather.counts.errored, 1);
  assert.deepEqual(getPipelineStepRecordsForViz(listDir, 'gather', 'errored').records.map((row) => row._row_id), ['r_blocked']);
  assert.ok(getPipelineStepRecordsForViz(listDir, 'gather', 'passed').records.some((row) => row._row_id === 'r_pass'));
});

test('skips are classified by their producer: when, dropped elsewhere, unresolved, upstream errored', () => {
  const listDir = pipelineFixture();
  const graph = getPipelineForViz(listDir);
  const branch = nodeById(graph, 'branch');
  assert.equal(branch.counts.skipped_when, 1);
  assert.equal(branch.counts.blocked_by_error, 1);
  assert.equal(branch.counts.dropped, 1);
  assert.equal(branch.counts.failed, 0);
  assert.equal(branch.counts.passed, 3);
  assert.equal(branch.counts.waiting, 0);
  assert.deepEqual(getPipelineStepRecordsForViz(listDir, 'branch', 'skipped_when').records.map((row) => row._row_id), ['r_when']);
  assert.deepEqual(getPipelineStepRecordsForViz(listDir, 'branch', 'blocked_by_error').records.map((row) => row._row_id), ['r_blocked']);
  assert.deepEqual(getPipelineStepRecordsForViz(listDir, 'branch', 'dropped').records.map((row) => row._row_id), ['r_drop']);

  const alternate = nodeById(graph, 'alternate');
  assert.equal(alternate.when, undefined);
  assert.deepEqual(
    { passed: alternate.counts.passed, skipped_when: alternate.counts.skipped_when, skipped_other: alternate.counts.skipped_other, blocked: alternate.counts.blocked_by_error },
    { passed: 3, skipped_when: 0, skipped_other: 0, blocked: 0 },
  );
  graph.nodes.filter((node) => !node.when).forEach((node) => assert.equal(node.counts.skipped_when, 0, node.id));
});

test('awaiting review equals the review queue total, including records resolved by an override', () => {
  const listDir = pipelineFixture();
  assert.equal(nodeById(getPipelineForViz(listDir), 'review_gate').counts.awaiting_review, 3);
  decide(listDir);
  const review = nodeById(getPipelineForViz(listDir), 'review_gate');
  const queue = getReviewQueueForViz(listDir, 'review_gate', 100, 0);
  assert.equal(queue.total, 1);
  assert.equal(review.counts.awaiting_review, queue.total);
  assert.equal(review.counts.waiting, queue.total);
  assert.equal(review.counts.passed, 1);
  assert.equal(review.counts.dropped, 1);
  assert.deepEqual(review.review, { fields: ['score_value'], edit_fields: ['note'] });
  assert.deepEqual(getPipelineStepRecordsForViz(listDir, 'review_gate', 'waiting').records.map((row) => row._row_id), ['r_wait']);
  assert.deepEqual(getPipelineStepRecordsForViz(listDir, 'review_gate', 'dropped').records.map((row) => row._row_id), ['r_reject']);
  assert.equal(nodeById(getPipelineForViz(listDir), 'gather').counts.passed, 7);
});

test('declared depends_on edges are explicit and dependency-free steps hang off the source', () => {
  const graph = getPipelineForViz(pipelineFixture());
  const edge = (from, to) => graph.edges.find((candidate) => candidate.from === from && candidate.to === to);
  [['gather', 'branch'], ['gather', 'alternate'], ['branch', 'review_gate'], ['alternate', 'review_gate'], ['review_gate', 'wait_step']]
    .forEach(([from, to]) => assert.equal(edge(from, to)?.origin, 'explicit', `${from} -> ${to}`));
  assert.deepEqual(graph.edges.filter((candidate) => candidate.origin === 'source').map((candidate) => candidate.to), ['gather']);
  graph.nodes.filter((node) => node.id !== 'source').forEach((node) => (
    assert.ok(graph.edges.some((candidate) => candidate.to === node.id), `${node.id} has no inbound edge`)
  ));
  assert.equal(nodeById(graph, 'source').counts.passed, 9);
});

test('on_event steps are grouped per event beneath the step that opens the turn', () => {
  const graph = getPipelineForViz(pipelineFixture());
  const followUp = nodeById(graph, 'reply_turn.follow_up');
  assert.deepEqual(followUp.group, { id: 'reply_turn', label: 'per event', parent_id: 'wait_step' });
  assert.deepEqual(graph.groups, [{ id: 'reply_turn', label: 'per event', parent_id: 'wait_step' }]);
  assert.ok(!graph.nodes.some((node) => node.id === 'reply_turn'));
  assert.equal(graph.edges.find((candidate) => candidate.to === 'reply_turn.follow_up')?.from, 'wait_step');
  assert.equal(graph.edges.find((candidate) => candidate.to === 'reply_turn.summarize')?.from, 'reply_turn.follow_up');
  assert.equal(followUp.counts.passed, 1);
  assert.equal(nodeById(graph, 'reply_turn.summarize').counts.errored, 1);
});

test('spend strips writer prefixes, reports unknown step spend once, and leaves unpriced steps blank', () => {
  const graph = getPipelineForViz(pipelineFixture());
  approximately(nodeById(graph, 'gather').spend_usd, 0.15);
  approximately(nodeById(graph, 'source').spend_usd, 0.01);
  approximately(nodeById(graph, 'reply_turn.follow_up').spend_usd, 0.05);
  approximately(graph.unattributed_spend_usd, 0.4);
  assert.deepEqual(graph.unattributed_spend.map((item) => item.step_id), ['pipeline_enrich:removed_step']);
  const branch = nodeById(graph, 'branch');
  assert.equal(branch.spend_usd, null);
  assert.equal(branch.unpriced_calls, 1);
  assert.equal(nodeById(graph, 'alternate').spend_usd, null);
});

test('the active step ignores stale runs and ids that are not pipeline nodes', () => {
  const listDir = pipelineFixture();
  const write = (run) => {
    const db = openListDb({ listDir, readonly: false });
    insertRun(db, run);
    db.close();
  };
  write({ id: 'stale', status: 'running', step: 'gather', updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  assert.equal(getPipelineForViz(listDir).active_step, '');
  write({ id: 'sourcing', status: 'running', step: 'search_task_0001', updatedAt: new Date().toISOString() });
  assert.equal(getPipelineForViz(listDir).active_step, '');
  write({ id: 'live', status: 'running', step: 'alternate', updatedAt: new Date(Date.now() + 1000).toISOString() });
  assert.equal(getPipelineForViz(listDir).active_step, 'alternate');
});

test('when predicates render as readable clauses joined by their match mode', () => {
  const graph = getPipelineForViz(pipelineFixture());
  assert.equal(nodeById(graph, 'branch').when.summary, 'score_value is not empty or note not matches ^skip');
  assert.equal(nodeById(graph, 'gather').when, undefined);
});

test('step record lists validate their state and step', () => {
  const listDir = pipelineFixture();
  const passed = getPipelineStepRecordsForViz(listDir, 'gather', 'passed', 3, 0);
  assert.equal(passed.total, 7);
  assert.equal(passed.records.length, 3);
  assert.equal(passed.records[0].extra_json, undefined);
  assert.throws(() => getPipelineStepRecordsForViz(listDir, 'gather', 'bogus'), /Step record state/);
  assert.throws(() => getPipelineStepRecordsForViz(listDir, 'missing_step', 'passed'), /Unknown pipeline step/);
});

const SORT_CONFIG = `
list:
  name: Sort fixture
pipeline:
  - kind: enrich
    id: rank
    inputs: [business_name]
    outputs:
      rank_value: { type: number, description: Rank. }
  - kind: review
    id: review_gate
    depends_on: [rank]
    fields: [label_text]
    edit_fields: []
`;

// 520 awaiting records whose rank grows with park time, so the highest ranks
// sit past the first 500 rows of the queue's default order. Ranks are stored
// as TEXT, so a text sort would put "99" above "520".
const sortFixture = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-viz-review-sort-'));
  writeFileSync(join(listDir, 'outbound.yaml'), SORT_CONFIG);
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: ['rank_value', 'label_text'] });
  db.transaction(() => {
    Array.from({ length: 520 }, (_, index) => index + 1).forEach((rank) => {
      const id = `rec_${String(rank).padStart(3, '0')}`;
      upsertRecord({ db, row: { _row_id: id, business_name: `Neutral ${id}`, rank_value: String(rank), label_text: `Label ${rank}` } });
      db.prepare(`
        INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
        VALUES (?, ?, 'review_gate', 'review', 0, 'awaiting_review', ?)
      `).run(`park-${id}`, id, new Date(Date.UTC(2026, 9, 24, 0, 0, rank)).toISOString());
    });
    upsertRecord({ db, row: { _row_id: 'rec_blank', business_name: 'Neutral blank', rank_value: '', label_text: 'Blank' } });
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
      VALUES ('park-blank', 'rec_blank', 'review_gate', 'review', 0, 'awaiting_review', '2026-10-24T00:00:00.000Z')
    `).run();
  })();
  db.close();
  return listDir;
};

test('numeric review sorts run in SQL across the whole queue, beyond 500 rows', () => {
  const listDir = sortFixture();
  const descending = getReviewQueueForViz(listDir, 'review_gate', 3, 0, 'rank_value', 'desc');
  assert.equal(descending.total, 521);
  assert.ok(descending.numeric_sort_fields.includes('rank_value'));
  assert.deepEqual(descending.records.map((row) => row.rank_value), ['520', '519', '518']);
  assert.ok('label_text' in descending.records[0]);
  const ascending = getReviewQueueForViz(listDir, 'review_gate', 3, 0, 'rank_value', 'asc');
  assert.deepEqual(ascending.records.map((row) => row.rank_value), ['1', '2', '3']);
  const tail = getReviewQueueForViz(listDir, 'review_gate', 10, 518, 'rank_value', 'desc');
  assert.deepEqual(tail.records.map((row) => row._row_id), ['rec_002', 'rec_001', 'rec_blank']);
  assert.throws(() => getReviewQueueForViz(listDir, 'review_gate', 10, 0, 'rank_value', 'sideways'), /direction/);
  assert.throws(() => getReviewQueueForViz(listDir, 'review_gate', 10, 0, 'bogus', 'asc'), /Unknown review sort field/);
});

test('viz review decisions pass allowed edits and reject fields outside edit_fields', () => {
  const listDir = pipelineFixture();
  assert.equal(applyReviewDecisionsForViz(listDir, 'review_gate', [{ row_id: 'r_wait', verdict: 'approve', edits: { note: 'set' } }]).applied, 1);
  const verify = openListDb({ listDir, readonly: true });
  assert.equal(verify.prepare("SELECT note FROM records WHERE _row_id = 'r_wait'").get().note, 'set');
  verify.close();
  const forbidden = applyReviewDecisionsForViz(listDir, 'review_gate', [{ row_id: 'r_approve', verdict: 'approve', edits: { business_name: 'no' } }]);
  assert.equal(forbidden.failed, 1);
  assert.equal(forbidden.applied, 0);
  assert.equal(getReviewQueueForViz(listDir, 'review_gate', 100, 0).total, 2);
});

// --- Round 3: pins for the risky behaviour -------------------------------------

const insertEventWithId = (db, { id, record, step, kind = 'enrich', passed, reason = '', minute }) => db.prepare(`
  INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(id, record, step, kind, passed ? 1 : 0, reason, at(minute));

const CLASSIFY_CONFIG = `
list:
  name: Classification fixture
pipeline:
  - kind: enrich
    id: gather
    inputs: [business_name]
    outputs:
      score_value: { type: number, description: Score. }
  - kind: enrich
    id: task
    depends_on: [gather]
    inputs: [score_value]
    when:
      match: all
      conditions:
        - { field: score_value, operator: is_not_empty }
    outputs:
      task_note: { type: string, description: Task note. }
  - kind: review
    id: review_a
    depends_on: [task]
    fields: [score_value]
  - kind: review
    id: review_b
    depends_on: [review_a]
    fields: [score_value]
`;

const classifyFixture = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-viz-classify-'));
  writeFileSync(join(listDir, 'outbound.yaml'), CLASSIFY_CONFIG);
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: ['score_value'] });
  ['t_pass_last', 't_fail_last', 'c_when', 'c_closed', 'c_closed_plain', 'q_a1', 'q_a2', 'q_b1', 'q_both', 'q_kept']
    .forEach((id) => upsertRecord({ db, row: { _row_id: id, business_name: `Neutral ${id}`, score_value: '1' } }));
  // Two outcomes at the same instant: only rowid orders them.
  insertEventWithId(db, { id: 'tie-1', record: 't_pass_last', step: 'gather', passed: false, reason: 'provider_returned_no_content', minute: 1 });
  insertEventWithId(db, { id: 'tie-2', record: 't_pass_last', step: 'gather', passed: true, minute: 1 });
  insertEventWithId(db, { id: 'tie-3', record: 't_fail_last', step: 'gather', passed: true, minute: 1 });
  insertEventWithId(db, { id: 'tie-4', record: 't_fail_last', step: 'gather', passed: false, reason: 'provider_returned_no_content', minute: 1 });
  // Manual parks closed as no longer applicable: by the `when`, or otherwise.
  insertEventWithId(db, { id: 'close-1', record: 'c_when', step: 'task', passed: true, reason: 'skipped:not_applicable:when_not_matched:score_value', minute: 2 });
  insertEventWithId(db, { id: 'close-2', record: 'c_closed', step: 'task', passed: true, reason: 'skipped:not_applicable:record_changed', minute: 2 });
  insertEventWithId(db, { id: 'close-3', record: 'c_closed_plain', step: 'task', passed: true, reason: 'skipped:not_applicable', minute: 2 });
  // Review queues: two at review_a, one at review_b, one at both, one kept.
  [['q_a1', 'review_a'], ['q_a2', 'review_a'], ['q_b1', 'review_b'], ['q_both', 'review_a'], ['q_both', 'review_b'], ['q_kept', 'review_a']]
    .forEach(([record, step], index) => insertEventWithId(db, { id: `park-${index}`, record, step, kind: 'review', passed: false, reason: 'awaiting_review', minute: 3 + index }));
  db.prepare(`
    INSERT INTO overrides (id, record_id, kind, step_id, reason, created_by, created_at)
    VALUES ('keep-1', 'q_kept', 'keep', 'review_a', '', 'review:review_a', ?)
  `).run(at(9));
  db.close();
  return listDir;
};

// Kills: removing `event.rowid DESC` from the latest-outcome ROW_NUMBER order.
// Without it the two same-instant rows tie, and at least one of these records
// takes the wrong outcome whichever way SQLite breaks the tie.
test('same-instant outcomes resolve by insertion order (rowid)', () => {
  const listDir = classifyFixture();
  const gather = nodeById(getPipelineForViz(listDir), 'gather');
  assert.equal(gather.counts.passed, 1);
  assert.equal(gather.counts.failed, 1);
  assert.deepEqual(getPipelineStepRecordsForViz(listDir, 'gather', 'passed').records.map((row) => row._row_id), ['t_pass_last']);
  assert.deepEqual(getPipelineStepRecordsForViz(listDir, 'gather', 'failed').records.map((row) => row._row_id), ['t_fail_last']);
});

// Kills: classifying `skipped:not_applicable:when_not_matched:*` as
// skipped_other (or the other closes as skipped_when).
test('a park closed by its when predicate is skipped_when; other closes are skipped_other', () => {
  const listDir = classifyFixture();
  const task = nodeById(getPipelineForViz(listDir), 'task');
  assert.equal(task.counts.skipped_when, 1);
  assert.equal(task.counts.skipped_other, 2);
  assert.equal(task.counts.passed, 0);
  assert.deepEqual(getPipelineStepRecordsForViz(listDir, 'task', 'skipped_when').records.map((row) => row._row_id), ['c_when']);
  assert.deepEqual(
    getPipelineStepRecordsForViz(listDir, 'task', 'skipped_other').records.map((row) => row._row_id).sort(),
    ['c_closed', 'c_closed_plain'],
  );
});

// Kills: a grouped count that loses the per-stage GROUP BY, counts a record
// once across stages, or ignores keep overrides; each node must equal its queue.
test('every review stage count comes from one grouped query and equals its queue total', () => {
  const listDir = classifyFixture();
  const graph = getPipelineForViz(listDir);
  assert.equal(nodeById(graph, 'review_a').counts.awaiting_review, 3);
  assert.equal(nodeById(graph, 'review_b').counts.awaiting_review, 2);
  ['review_a', 'review_b'].forEach((stage) => {
    const node = nodeById(graph, stage);
    assert.equal(node.counts.awaiting_review, getReviewQueueForViz(listDir, stage, 100, 0).total, stage);
    assert.equal(node.counts.waiting, node.counts.awaiting_review, stage);
  });
});

const EDGE_CONFIG = `
list:
  name: Edge fixture
pipeline:
  - kind: enrich
    id: alpha
    inputs: [business_name]
    outputs:
      alpha_value: { type: number, description: Alpha. }
  - kind: enrich
    id: beta
    depends_on: [alpha]
    inputs: [business_name]
    outputs:
      beta_value: { type: string, description: Beta. }
  - kind: filter
    id: gamma
    depends_on: [beta]
    type: field_check
    conditions:
      - { field: alpha_value, operator: gte, value: 1 }
  - kind: filter
    id: delta
    type: field_check
    conditions:
      - { field: beta_value, operator: is_not_empty }
`;

// Kills: inferred edges reported as explicit (or vice versa), `implied` set on
// an inferred edge with no other path, or missing on one the explicit chain
// already guarantees; and a source edge added to a step with an inferred parent.
test('inferred edges carry their origin, and implied only when another path reaches the target', () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-viz-edges-'));
  writeFileSync(join(listDir, 'outbound.yaml'), EDGE_CONFIG);
  openListDb({ listDir, readonly: false }).close();
  const graph = getPipelineForViz(listDir);
  const edge = (from, to) => graph.edges.find((candidate) => candidate.from === from && candidate.to === to);
  assert.deepEqual(edge('alpha', 'beta'), { from: 'alpha', to: 'beta', origin: 'explicit' });
  assert.deepEqual(edge('beta', 'gamma'), { from: 'beta', to: 'gamma', origin: 'explicit' });
  assert.deepEqual(edge('alpha', 'gamma'), { from: 'alpha', to: 'gamma', origin: 'inferred', implied: true });
  assert.deepEqual(edge('beta', 'delta'), { from: 'beta', to: 'delta', origin: 'inferred' });
  assert.deepEqual(graph.edges.filter((candidate) => candidate.origin === 'source').map((candidate) => candidate.to), ['alpha']);
  assert.deepEqual(nodeById(graph, 'gamma').inferred_depends_on, ['alpha']);
  assert.deepEqual(nodeById(graph, 'delta').depends_on, []);
});

// Kills: dropping cost rows that map to no node when none of them is priced.
test('unpriced cost rows for unknown steps are listed, not silently dropped', () => {
  const listDir = pipelineFixture();
  const db = openListDb({ listDir, readonly: false });
  insertCost(db, { id: 'cost-gone-1', step: 'pipeline_enrich:gone_step', usd: null });
  insertCost(db, { id: 'cost-gone-2', step: 'pipeline_enrich:gone_step', usd: null });
  db.close();
  const graph = getPipelineForViz(listDir);
  const gone = graph.unattributed_spend.find((item) => item.step_id === 'pipeline_enrich:gone_step');
  assert.deepEqual(gone, { step_id: 'pipeline_enrich:gone_step', spend_usd: null, calls: 2, unpriced_calls: 2 });
  assert.equal(graph.unattributed_unpriced_calls, 2);
  approximately(graph.unattributed_spend_usd, 0.4);
});

// Kills: a gate that lets a decision through while the displayed record is not
// the target (the render after J / K or auto-advance), while the target's
// detail is still loading, while a decision is in flight, or for a record that
// is not in the queue.
test('the decision gate allows a decision only on the displayed, loaded, awaiting target', () => {
  const ready = { detailRowId: 'row_b', targetRowId: 'row_b', loading: false, busy: false, awaiting: true };
  assert.equal(canDecide(ready), true);
  assert.equal(canDecide({ ...ready, detailRowId: 'row_a' }), false, 'previous record still on screen');
  assert.equal(canDecide({ ...ready, detailRowId: '' }), false, 'target detail not loaded');
  assert.equal(canDecide({ ...ready, loading: true }), false, 'target detail loading');
  assert.equal(canDecide({ ...ready, busy: true }), false, 'decision in flight');
  assert.equal(canDecide({ ...ready, awaiting: false }), false, 'not in the queue');
  assert.equal(canDecide({ ...ready, targetRowId: '', detailRowId: '' }), false, 'no target');
});

// Kills: undo reading the current selection instead of the history entry.
test('undo targets the latest history entry stage and record', () => {
  const history = [
    { stage_id: 'review_a', row_id: 'row_1', verdict: 'approve', view: 'stage:review_a' },
    { stage_id: 'review_b', row_id: 'row_2', verdict: 'reject', view: 'all' },
  ];
  assert.equal(undoTargetFor(history), history[1], 'the entry itself, with its own stage, record and tab');
  assert.equal(undoTargetFor([]), null);
});

// Kills: honouring key auto-repeat for Space / Enter / X / U, acting while
// typing or with a modifier held, and Space / Enter on a focused button (a
// tabbed-to Reject, a tab) approving the selected row instead.
test('held decision keys do not repeat; moves still repeat; a focused control keeps Space and Enter', () => {
  const press = (key, extra = {}) => reviewShortcut({ key, repeat: false, modified: false, typing: false, onControl: false, ...extra });
  assert.equal(press(' '), 'approve');
  assert.equal(press('Enter'), 'approve');
  assert.equal(press('x'), 'reject');
  assert.equal(press('X'), 'reject');
  assert.equal(press('u'), 'undo');
  [' ', 'Enter', 'x', 'u'].forEach((key) => assert.equal(press(key, { repeat: true }), null, key));
  assert.equal(press('j', { repeat: true }), 'next');
  assert.equal(press('ArrowDown'), 'next');
  assert.equal(press('K'), 'previous');
  assert.equal(press('ArrowUp', { repeat: true }), 'previous');
  assert.equal(press('Enter', { onControl: true }), null);
  assert.equal(press(' ', { onControl: true }), null);
  assert.equal(press('x', { onControl: true }), 'reject', 'other shortcuts still work with a button focused');
  assert.equal(press('a'), null, 'A and R are not Review page keys');
  assert.equal(press('r'), null);
  assert.equal(press('x', { typing: true }), null);
  assert.equal(press('Enter', { modified: true }), null);
});

// Kills: a viewer decision that writes an override for a record not parked at
// the gate (a stale screen pre-approving it), and a reject that silently drops
// the operator's edits. Approvals still match the CLI: keep override by
// `review:<stage>` plus the edit audit entry.
test('viewer decisions run the CLI review command and refuse records not awaiting the stage', () => {
  const listDir = pipelineFixture();
  const notAwaiting = applyReviewDecisionsForViz(listDir, 'review_gate', [{ row_id: 'r_pass', verdict: 'approve' }]);
  assert.equal(notAwaiting.applied, 0);
  assert.match(notAwaiting.results[0].error, /not awaiting review at "review_gate"/);
  const rejectWithEdits = applyReviewDecisionsForViz(listDir, 'review_gate', [{ row_id: 'r_wait', verdict: 'reject', reason: 'no', edits: { note: 'x' } }]);
  assert.equal(rejectWithEdits.applied, 0);
  assert.match(rejectWithEdits.results[0].error, /Edits apply only to an approval/);
  const approved = applyReviewDecisionsForViz(listDir, 'review_gate', [{ row_id: 'r_wait', verdict: 'approve', edits: { note: 'checked' } }]);
  assert.equal(approved.applied, 1, JSON.stringify(approved.results));
  assert.equal(approved.results[0].row_id, 'r_wait');
  assert.equal(approved.results[0].verdict, 'pass');
  const db = openListDb({ listDir, readonly: true });
  const overrides = db.prepare('SELECT record_id, kind, step_id, created_by FROM overrides ORDER BY record_id').all();
  const record = db.prepare("SELECT note, transition_audit_json FROM records WHERE _row_id = 'r_wait'").get();
  db.close();
  assert.deepEqual(overrides.map((row) => ({ ...row })), [{ record_id: 'r_wait', kind: 'keep', step_id: 'review_gate', created_by: 'review:review_gate' }]);
  assert.equal(record.note, 'checked');
  assert.match(record.transition_audit_json, /review-edit-v1/);
  const undone = clearReviewDecisionForViz(listDir, 'r_wait', 'review_gate');
  assert.equal(undone.status, 'review_cleared');
  assert.equal(getReviewQueueForViz(listDir, 'review_gate', 100, 0).total, 3);
});

const EVENT_REVIEW_CONFIG = `
list:
  name: Event review fixture
pipeline:
  - kind: enrich
    id: gather
    inputs: [business_name]
    outputs:
      reply_draft: { type: string, description: Draft. }
  - kind: on_event
    id: reply_turn
    depends_on: [gather]
    source: outreach
    event: response_received
    reference_field: enrollment_ref
    steps:
      - kind: enrich
        id: draft_reply
        inputs: [business_name]
        outputs:
          reply_draft: { type: string, description: Draft. }
      - kind: review
        id: reply_review
        depends_on: [draft_reply]
        fields: [reply_draft]
        edit_fields: [reply_draft]
`;

// Kills: omitting on_event review steps from the graph, giving them a decidable
// `review` block, or letting the viewer decide/undo/list them through the
// override path (which would leave the turn open and write a meaningless keep
// override). The CLI decides them on event_turn_steps instead.
test('event-turn review steps are counted but refused by every viewer review endpoint', () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-viz-event-review-'));
  writeFileSync(join(listDir, 'outbound.yaml'), EVENT_REVIEW_CONFIG);
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: ['reply_draft'] });
  upsertRecord({ db, row: { _row_id: 'e_1', business_name: 'Neutral e_1', reply_draft: 'Hello' } });
  ensureEventTurns(db);
  db.prepare(`
    INSERT INTO event_turns (turn_id, record_id, block_id, source, event_id, turn_index, status, opened_at)
    VALUES ('turn-e1', 'e_1', 'reply_turn', 'outreach', 'event-e1', 1, 'open', ?)
  `).run(at(1));
  db.prepare(`
    INSERT INTO event_turn_steps (turn_id, step_id, kind, status, reason, occurred_at)
    VALUES ('turn-e1', 'draft_reply', 'enrich', 'passed', '', ?), ('turn-e1', 'reply_review', 'review', 'awaiting_review', 'awaiting_review', ?)
  `).run(at(1), at(2));
  db.close();

  const node = nodeById(getPipelineForViz(listDir), 'reply_turn.reply_review');
  assert.equal(node.kind, 'review');
  assert.equal(node.counts.awaiting_review, 1);
  assert.equal(node.counts.waiting, 1);
  assert.equal(node.review, undefined, 'event-turn reviews are not decidable in the panel');

  const refusal = /runs inside the on_event block "reply_turn"/;
  ['reply_turn.reply_review', 'reply_review'].forEach((stage) => {
    assert.throws(() => applyReviewDecisionsForViz(listDir, stage, [{ row_id: 'e_1', verdict: 'approve' }]), refusal, stage);
    assert.throws(() => applyReviewDecisionsForViz(listDir, stage, [{ row_id: 'e_1', verdict: 'reject', reason: 'no' }]), refusal, stage);
    assert.throws(() => clearReviewDecisionForViz(listDir, 'e_1', stage), refusal, stage);
    assert.throws(() => getReviewQueueForViz(listDir, stage, 100, 0), refusal, stage);
  });
  const verify = openListDb({ listDir, readonly: true });
  assert.equal(verify.prepare("SELECT status FROM event_turn_steps WHERE step_id = 'reply_review'").get().status, 'awaiting_review');
  assert.equal(verify.prepare("SELECT status FROM event_turns WHERE turn_id = 'turn-e1'").get().status, 'open');
  assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM overrides').get().n, 0);
  verify.close();
});

// 1,200 awaiting records with duplicate ranks and blanks.
const largeSortFixture = (count) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-viz-review-large-'));
  writeFileSync(join(listDir, 'outbound.yaml'), SORT_CONFIG);
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: ['rank_value', 'label_text'] });
  const expected = [];
  db.transaction(() => {
    Array.from({ length: count }, (_, index) => index).forEach((index) => {
      const id = `big_${String(index).padStart(4, '0')}`;
      const rank = index % 97 === 0 ? '' : String((index * 7919) % 1000);
      expected.push({ id, rank });
      upsertRecord({ db, row: { _row_id: id, business_name: `Neutral ${id}`, rank_value: rank, label_text: `Label ${index}` } });
      db.prepare(`
        INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
        VALUES (?, ?, 'review_gate', 'review', 0, 'awaiting_review', ?)
      `).run(`park-${id}`, id, new Date(Date.UTC(2026, 9, 24, 0, 0, 0, index)).toISOString());
    });
  })();
  db.close();
  const ranked = expected.filter((item) => item.rank !== '')
    .sort((left, right) => Number(right.rank) - Number(left.rank) || left.id.localeCompare(right.id));
  const blanks = expected.filter((item) => item.rank === '').sort((left, right) => left.id.localeCompare(right.id));
  return { listDir, order: [...ranked, ...blanks].map((item) => item.id) };
};

const countingDb = (db) => {
  const counter = { prepares: 0 };
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => {
          counter.prepares += 1;
          return target.prepare(sql);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, counter };
};

const queuePageStatements = (listDir, params) => {
  const { config } = readConfig(listDir);
  const raw = openListDb({ listDir, readonly: true });
  try {
    const { db, counter } = countingDb(raw);
    const page = reviewQueuePageForViz({ db, config, stageId: 'review_gate', ...params });
    return { page, prepares: counter.prepares };
  } finally {
    raw.close();
  }
};

// Kills: the numeric sort walking the queue (getReviewQueue page by page) to
// collect membership before sorting. The statement count must not grow with
// the queue or the offset, and every offset page must be the right slice.
test('numeric review sort pages 1,200 rows in one query per page, with stable ties and blanks last', () => {
  const { listDir, order } = largeSortFixture(1200);
  const small = sortFixture();
  const first = queuePageStatements(listDir, { limit: 100, offset: 0, sort: 'rank_value', dir: 'desc' });
  const late = queuePageStatements(listDir, { limit: 100, offset: 1100, sort: 'rank_value', dir: 'desc' });
  const tiny = queuePageStatements(small, { limit: 100, offset: 0, sort: 'rank_value', dir: 'desc' });
  assert.equal(first.prepares, late.prepares);
  assert.equal(first.prepares, tiny.prepares);
  assert.ok(first.prepares <= 4, `prepared ${first.prepares} statements`);

  const walked = [];
  for (let offset = 0; offset < 1200; offset += 100) {
    const page = getReviewQueueForViz(listDir, 'review_gate', 100, offset, 'rank_value', 'desc');
    assert.equal(page.total, 1200);
    assert.equal(page.offset, offset);
    walked.push(...page.records.map((row) => row._row_id));
  }
  assert.deepEqual(walked, order);
  assert.equal(getReviewQueueForViz(listDir, 'review_gate', 100, 1200, 'rank_value', 'desc').records.length, 0);
});

// Kills: ← / → losing its place at a page boundary, or "N of M" counting from
// the page instead of the queue.
test('a queue page can be fetched around a record anywhere in the queue', () => {
  const { listDir, order } = largeSortFixture(1200);
  const target = order[1150];
  const page = getReviewQueueForViz(listDir, 'review_gate', 100, 0, 'rank_value', 'desc', target);
  assert.equal(page.offset, 1100);
  assert.equal(page.around_position, 1150);
  assert.equal(page.records[1150 - page.offset]._row_id, target);
  assert.equal(page.total, 1200);
  const boundary = getReviewQueueForViz(listDir, 'review_gate', 100, 0, 'rank_value', 'desc', order[200]);
  assert.equal(boundary.offset, 200);
  assert.equal(boundary.records[0]._row_id, order[200]);
  const missing = getReviewQueueForViz(listDir, 'review_gate', 100, 300, 'rank_value', 'desc', 'not_in_queue');
  assert.equal(missing.around_position, null);
  assert.equal(missing.offset, 300);
  const byDefault = getReviewQueueForViz(listDir, 'review_gate', 100, 0, '', 'asc', 'big_0555');
  assert.equal(byDefault.around_position, 555);
});
