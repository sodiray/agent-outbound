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

// A park for a step the current config no longer declares (historical row).
// Setup: one live declared phone step + one ghost park whose id would have
// substring-guessed as phone/manual — the accidental match this change kills.
const ghostSetup = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-manual-ghost-'));
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({ db, columns: ['business_name', 'address'] });

  upsertRecord({ db, row: { _row_id: 'rec-live', business_name: 'Live Biz', address: '1 Live St' } });
  db.prepare(`
    INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
    VALUES (?, ?, ?, 'manual_task', 0, 'awaiting_manual', ?)
  `).run('ev-live', 'rec-live', 'phone_1', '2026-08-09T18:00:00Z');

  // Gone from config; id still contains "phone" so the old fallback would label
  // it manual/phone and a --type phone filter would pull it in by accident.
  upsertRecord({ db, row: { _row_id: 'rec-ghost', business_name: 'Ghost Biz', address: '2 Ghost St' } });
  db.prepare(`
    INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
    VALUES (?, ?, ?, 'manual_task', 0, 'awaiting_manual', ?)
  `).run('ev-ghost', 'rec-ghost', 'tier_c.phone_1', '2026-08-09T18:01:00Z');

  const liveOnlyConfig = {
    pipeline: [
      {
        kind: 'manual_task',
        id: 'phone_1',
        config: { task_type: 'human_phone', channel: 'phone' },
      },
    ],
  };
  return { db, liveOnlyConfig };
};

test('a parked event for a step absent from config is undeclared with empty labels and still listed', () => {
  const { db, liveOnlyConfig } = ghostSetup();
  try {
    const listed = listAwaitingManualTasks({ db, config: liveOnlyConfig });
    assert.equal(listed.total, 2);
    assert.deepEqual(
      listed.tasks.map((task) => [task.step_id, task.declared, task.task_type, task.channel]),
      [
        ['phone_1', true, 'human_phone', 'phone'],
        ['tier_c.phone_1', false, '', ''],
      ],
    );
  } finally {
    db.close();
  }
});

test('an undeclared park never matches a type filter that its old inferred label would have hit', () => {
  const { db, liveOnlyConfig } = ghostSetup();
  try {
    // Step id contains "phone"; old path would substring-guess and match.
    const phone = listAwaitingManualTasks({ db, config: liveOnlyConfig, taskType: 'phone' });
    assert.deepEqual(phone.tasks.map((task) => task.step_id), ['phone_1']);
    assert.equal(phone.total, 1);
    assert.ok(!phone.tasks.some((task) => task.step_id === 'tier_c.phone_1'));

    // Same for the bare "manual" bucket the guess used when id had no mail/visit/linkedin token.
    const manual = listAwaitingManualTasks({ db, config: liveOnlyConfig, taskType: 'manual' });
    assert.ok(!manual.tasks.some((task) => task.step_id === 'tier_c.phone_1'));
  } finally {
    db.close();
  }
});

test('a declared step beside a ghost still reports real labels and still matches its filter', () => {
  const { db, liveOnlyConfig } = ghostSetup();
  try {
    const listed = listAwaitingManualTasks({ db, config: liveOnlyConfig });
    const live = listed.tasks.find((task) => task.step_id === 'phone_1');
    assert.ok(live);
    assert.equal(live.declared, true);
    assert.equal(live.task_type, 'human_phone');
    assert.equal(live.channel, 'phone');

    const filtered = listAwaitingManualTasks({ db, config: liveOnlyConfig, taskType: 'phone' });
    assert.deepEqual(
      filtered.tasks.map((task) => [task.step_id, task.declared, task.task_type, task.channel]),
      [['phone_1', true, 'human_phone', 'phone']],
    );
    assert.equal(filtered.total, 1);
  } finally {
    db.close();
  }
});

test('no-config path still substring-guesses and treats rows as declared', () => {
  const { db } = ghostSetup();
  try {
    // Without config: tier_c.phone_1 keeps the old guess (manual — "phone" is not a
    // substring token in the guess table; phone_1 likewise). Filter by mail must
    // still only hit ids containing mail/letter.
    const unfiltered = listAwaitingManualTasks({ db });
    assert.equal(unfiltered.total, 2);
    for (const task of unfiltered.tasks) {
      assert.equal(task.declared, true);
    }
    // phone_1 and tier_c.phone_1 both lack mail/visit/linkedin → task_type "manual"
    assert.deepEqual(
      unfiltered.tasks.map((task) => [task.step_id, task.task_type, task.channel]),
      [
        ['phone_1', 'manual', ''],
        ['tier_c.phone_1', 'manual', ''],
      ],
    );

    // Control: mail filter still uses substring guess, not empty labels.
    const withMailId = (() => {
      upsertRecord({ db, row: { _row_id: 'rec-mail', business_name: 'Mail Biz', address: '3 Mail St' } });
      db.prepare(`
        INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
        VALUES (?, ?, ?, 'manual_task', 0, 'awaiting_manual', ?)
      `).run('ev-mail', 'rec-mail', 'mail_golden_or_standard', '2026-08-09T18:02:00Z');
      return listAwaitingManualTasks({ db, taskType: 'mail' });
    })();
    assert.deepEqual(withMailId.tasks.map((task) => task.step_id), ['mail_golden_or_standard']);
    assert.equal(withMailId.tasks[0].declared, true);
    assert.equal(withMailId.tasks[0].task_type, 'mail');
  } finally {
    db.close();
  }
});
