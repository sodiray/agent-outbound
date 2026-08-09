import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listAwaitingManualTasks } from '../dist/orchestrator/pipeline/manual.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';

// Three parked tasks whose step ids deliberately disagree with what they are:
// `postcard_production` is mail and does not say "mail"; `phone_1` is a phone
// call and the engine's substring guess calls it "manual".
const STEPS = [
  { id: 'postcard_production', task_type: 'standard_postcard', channel: 'mail' },
  { id: 'mail_golden_or_standard', task_type: 'golden_ticket', channel: 'mail' },
  { id: 'phone_1', task_type: 'human_phone', channel: 'phone' },
];

const config = {
  pipeline: STEPS.map((step) => ({
    kind: 'manual_task',
    id: step.id,
    config: { task_type: step.task_type, channel: step.channel },
  })),
};

const setup = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-manual-board-'));
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: ['business_name', 'address'] });
  STEPS.forEach((step, index) => {
    const recordId = `rec-${index}`;
    upsertRecord({ db, row: { _row_id: recordId, business_name: `Biz ${index}`, address: `${index} Main St` } });
    db.prepare(`
      INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
      VALUES (?, ?, ?, 'manual_task', 0, 'awaiting_manual', ?)
    `).run(`ev-${index}`, recordId, step.id, `2026-08-09T18:0${index}:00Z`);
  });
  return db;
};

test('a parked task is labelled with the words its author declared', () => {
  const db = setup();
  try {
    const listed = listAwaitingManualTasks({ db, config });
    assert.deepEqual(
      listed.tasks.map((task) => [task.step_id, task.task_type, task.channel]),
      [
        ['postcard_production', 'standard_postcard', 'mail'],
        ['mail_golden_or_standard', 'golden_ticket', 'mail'],
        ['phone_1', 'human_phone', 'phone'],
      ],
    );
  } finally {
    db.close();
  }
});

test('filtering finds work by its declared type or channel, not by how the step is spelled', () => {
  const db = setup();
  try {
    // Both mail pieces, including the one whose id never says "mail".
    const mail = listAwaitingManualTasks({ db, config, taskType: 'mail' });
    assert.deepEqual(mail.tasks.map((task) => task.step_id), ['postcard_production', 'mail_golden_or_standard']);

    // A phone task the substring guess used to bucket as "manual".
    assert.deepEqual(
      listAwaitingManualTasks({ db, config, taskType: 'phone' }).tasks.map((task) => task.step_id),
      ['phone_1'],
    );
    assert.deepEqual(
      listAwaitingManualTasks({ db, config, taskType: 'golden_ticket' }).tasks.map((task) => task.step_id),
      ['mail_golden_or_standard'],
    );
  } finally {
    db.close();
  }
});

test('the total describes the tasks returned rather than every parked task', () => {
  const db = setup();
  try {
    const mail = listAwaitingManualTasks({ db, config, taskType: 'mail' });
    assert.equal(mail.total, 2);
    assert.equal(mail.tasks.length, 2);

    // Control: the unfiltered total still counts everything, so the assertion
    // above is about the filter and not about the count being broken.
    assert.equal(listAwaitingManualTasks({ db, config }).total, 3);

    // And a page smaller than the match set reports the full match count.
    const paged = listAwaitingManualTasks({ db, config, taskType: 'mail', limit: 1 });
    assert.equal(paged.total, 2);
    assert.equal(paged.tasks.length, 1);
  } finally {
    db.close();
  }
});

test('a caller with no config still gets the old substring guess', () => {
  const db = setup();
  try {
    const listed = listAwaitingManualTasks({ db, taskType: 'mail' });
    assert.deepEqual(listed.tasks.map((task) => task.step_id), ['mail_golden_or_standard']);
  } finally {
    db.close();
  }
});
