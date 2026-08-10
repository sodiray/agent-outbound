/**
 * logOutcome transition handling: reject unknown values, write lifecycle_stage
 * for the shared vocabulary, keep sequence_status + suppression for the
 * sequence-axis transitions (opted_out / bounced).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ensureRecordColumns,
  openListDb,
  upsertRecord,
} from '../dist/orchestrator/runtime/db.js';
import { logOutcome } from '../dist/orchestrator/sequencer/runner.js';
import { LIFECYCLE_STAGES } from '../dist/orchestrator/policy/lifecycle.js';

const seedList = ({ suffix, email = 'owner@example.test', lifecycle_stage = 'contacted', sequence_status = 'active' }) => {
  const listDir = mkdtempSync(join(tmpdir(), `ao-log-outcome-${suffix}-`));
  const globalRoot = join(listDir, 'global-root');
  mkdirSync(globalRoot, { recursive: true });
  writeFileSync(join(globalRoot, 'models.json'), JSON.stringify({
    schema_version: '1.0.0',
    providers: { openai: { provider: 'openai', models: ['gpt-4.1-mini'], updated_at: '' } },
  }));
  writeFileSync(join(listDir, 'outbound.yaml'), `
list: { name: Log Outcome Transition }
business: { name: Test, description: Test, icp: Test, offer: Test }
pipeline: []
sequences: { default: { steps: [] } }
policy: { enforce_readiness: false }
ai: { default_model: openai/gpt-4.1-mini }
`);
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));

  const previousGlobalRoot = process.env.AO_GLOBAL_ROOT;
  process.env.AO_GLOBAL_ROOT = globalRoot;

  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({
    db,
    columns: [
      'lifecycle_stage',
      'outcome',
      'outcome_notes',
      'outcome_at',
      'disposition_latest',
      'disposition_follow_up_at',
      'suppressed',
      'suppressed_reason',
      'suppressed_at',
      'email_primary',
    ],
  });
  upsertRecord({
    db,
    row: {
      _row_id: 'rec_log_1',
      business_name: 'Acme Probe Co',
      email_primary: email,
      lifecycle_stage,
      sequence_status,
      sequence_name: 'default',
    },
  });
  db.close();

  return {
    listDir,
    restore: () => {
      if (previousGlobalRoot === undefined) delete process.env.AO_GLOBAL_ROOT;
      else process.env.AO_GLOBAL_ROOT = previousGlobalRoot;
      try { rmSync(listDir, { recursive: true, force: true }); } catch { /* tmp */ }
    },
  };
};

const readRecord = (listDir, id = 'rec_log_1') => {
  const db = openListDb({ listDir, readonly: true });
  try {
    return db.prepare('SELECT * FROM records WHERE _row_id = ?').get(id);
  } finally {
    db.close();
  }
};

const listSuppressions = (listDir) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    return db.prepare('SELECT * FROM suppression').all();
  } finally {
    db.close();
  }
};

test('logOutcome rejects an unknown transition with an error naming it', () => {
  const { listDir, restore } = seedList({ suffix: 'unknown' });
  try {
    const result = logOutcome({
      listDir,
      prospect: 'Acme Probe Co',
      action: 'note',
      transition: 'banana',
    });

    assert.notEqual(result.status, 'updated');
    assert.equal(result.ok, false, `unknown transition must not report ok:true — got ${JSON.stringify(result)}`);
    assert.match(String(result.error || ''), /banana/i);
    assert.match(String(result.error || ''), /accepted/i);

    const row = readRecord(listDir);
    assert.equal(row.lifecycle_stage, 'contacted', 'rejected transition must not mutate lifecycle_stage');
    assert.equal(row.sequence_status, 'active', 'rejected transition must not mutate sequence_status');
  } finally {
    restore();
  }
});

test('logOutcome --transition won sets lifecycle_stage to won', () => {
  const { listDir, restore } = seedList({ suffix: 'won' });
  try {
    const result = logOutcome({
      listDir,
      prospect: 'Acme Probe Co',
      action: 'closed_won',
      transition: 'won',
    });
    assert.equal(result.status, 'updated');
    assert.equal(result.lifecycle_stage, 'won');

    const row = readRecord(listDir);
    assert.equal(row.lifecycle_stage, 'won');
    // sequence_status is a separate axis — pure lifecycle transitions leave it alone
    assert.equal(row.sequence_status, 'active');
    assert.equal(row.outcome, 'closed_won');
    assert.equal(row.disposition_latest, 'closed_won');
    assert.ok(String(row.outcome_at || '').length > 0);
  } finally {
    restore();
  }
});

test('logOutcome --transition meeting_booked and replied set lifecycle_stage', () => {
  const { listDir: listDirMeeting, restore: restoreMeeting } = seedList({ suffix: 'meeting' });
  try {
    const result = logOutcome({
      listDir: listDirMeeting,
      prospect: 'Acme Probe Co',
      action: 'booked',
      transition: 'meeting_booked',
    });
    assert.equal(result.status, 'updated');
    assert.equal(readRecord(listDirMeeting).lifecycle_stage, 'meeting_booked');
  } finally {
    restoreMeeting();
  }

  const { listDir: listDirReplied, restore: restoreReplied } = seedList({ suffix: 'replied' });
  try {
    const result = logOutcome({
      listDir: listDirReplied,
      prospect: 'Acme Probe Co',
      action: 'got_reply',
      transition: 'replied',
    });
    assert.equal(result.status, 'updated');
    assert.equal(readRecord(listDirReplied).lifecycle_stage, 'replied');
  } finally {
    restoreReplied();
  }
});

test('logOutcome --transition opted_out sets sequence_status, suppresses, and writes suppression row', () => {
  const email = 'optout@example.test';
  const { listDir, restore } = seedList({ suffix: 'opted-out', email });
  try {
    const result = logOutcome({
      listDir,
      prospect: 'Acme Probe Co',
      action: 'left_voicemail',
      transition: 'opted_out',
    });
    assert.equal(result.status, 'updated');
    assert.equal(result.suppressed, true);
    assert.equal(result.sequence_status, 'opted_out');

    const row = readRecord(listDir);
    assert.equal(row.sequence_status, 'opted_out');
    assert.equal(Number(row.suppressed), 1);
    assert.equal(row.suppressed_reason, 'opt_out');
    assert.ok(String(row.suppressed_at || '').length > 0);

    const suppressions = listSuppressions(listDir);
    assert.ok(suppressions.length >= 1, 'expected at least one suppression row');
    const match = suppressions.find((entry) => {
      const value = String(entry.identifier_value || entry.value || '').toLowerCase();
      return value === email.toLowerCase();
    });
    assert.ok(match, `expected suppression row for ${email}, got ${JSON.stringify(suppressions)}`);
    assert.equal(String(match.identifier_type || match.value_type || ''), 'email');
    assert.match(String(match.reason || ''), /opt_out|opt-out/i);
    assert.equal(String(match.source || ''), 'log_outcome');
  } finally {
    restore();
  }
});

test('logOutcome --transition bounced sets sequence_status: bounced and suppresses', () => {
  const email = 'bounce@example.test';
  const { listDir, restore } = seedList({ suffix: 'bounced', email });
  try {
    const result = logOutcome({
      listDir,
      prospect: 'Acme Probe Co',
      action: 'hard_bounce',
      transition: 'bounced',
    });
    assert.equal(result.status, 'updated');
    assert.equal(result.sequence_status, 'bounced');
    assert.equal(result.suppressed, true);

    const row = readRecord(listDir);
    assert.equal(row.sequence_status, 'bounced');
    assert.equal(Number(row.suppressed), 1);
    assert.equal(row.suppressed_reason, 'hard_bounce');

    const suppressions = listSuppressions(listDir);
    const match = suppressions.find((entry) => {
      const value = String(entry.identifier_value || entry.value || '').toLowerCase();
      return value === email.toLowerCase();
    });
    assert.ok(match, `expected suppression row for ${email}`);
    assert.equal(String(match.source || ''), 'log_outcome');
  } finally {
    restore();
  }
});

test('logOutcome action-based inference still works without --transition', () => {
  const { listDir: listDirOptOut, restore: restoreOptOut } = seedList({
    suffix: 'infer-optout',
    email: 'infer-opt@example.test',
  });
  try {
    const result = logOutcome({
      listDir: listDirOptOut,
      prospect: 'Acme Probe Co',
      action: 'opt_out',
    });
    assert.equal(result.status, 'updated');
    assert.equal(result.sequence_status, 'opted_out');
    assert.equal(Number(readRecord(listDirOptOut).suppressed), 1);
  } finally {
    restoreOptOut();
  }

  const { listDir: listDirBooked, restore: restoreBooked } = seedList({ suffix: 'infer-booked' });
  try {
    const result = logOutcome({
      listDir: listDirBooked,
      prospect: 'Acme Probe Co',
      action: 'booked_meeting',
    });
    assert.equal(result.status, 'updated');
    assert.equal(result.sequence_status, 'engaged');
    // engaged is also a lifecycle stage — dual-axis write
    assert.equal(readRecord(listDirBooked).lifecycle_stage, 'engaged');
  } finally {
    restoreBooked();
  }

  const { listDir: listDirNotFit, restore: restoreNotFit } = seedList({
    suffix: 'infer-notfit',
    email: 'notfit@example.test',
  });
  try {
    const result = logOutcome({
      listDir: listDirNotFit,
      prospect: 'Acme Probe Co',
      action: 'not_a_fit',
    });
    assert.equal(result.status, 'updated');
    assert.equal(result.sequence_status, 'opted_out');
  } finally {
    restoreNotFit();
  }
});

test('logOutcome still writes outcome, disposition_latest, and outcome_at', () => {
  const { listDir, restore } = seedList({ suffix: 'outcome-fields' });
  try {
    const before = Date.now();
    const result = logOutcome({
      listDir,
      prospect: 'Acme Probe Co',
      action: 'left_voicemail',
      note: 'tried twice',
    });
    assert.equal(result.status, 'updated');

    const row = readRecord(listDir);
    assert.equal(row.outcome, 'left_voicemail');
    assert.equal(row.disposition_latest, 'left_voicemail');
    assert.ok(String(row.outcome_at || '').length > 0);
    assert.ok(Date.parse(row.outcome_at) >= before - 5000);
    assert.match(String(row.outcome_notes || ''), /left_voicemail.*tried twice/);
  } finally {
    restore();
  }
});

test('logOutcome accepts every LIFECYCLE_STAGES value for lifecycle_stage writes', () => {
  // Smoke: the shared vocabulary is the source of truth — each stage is accepted
  // and lands on the record (no sequence_status side effect for pure lifecycle names).
  for (const stage of LIFECYCLE_STAGES) {
    if (stage === 'engaged') continue; // dual-axis; covered by inference test
    const { listDir, restore } = seedList({ suffix: `lc-${stage}` });
    try {
      const result = logOutcome({
        listDir,
        prospect: 'Acme Probe Co',
        action: `mark_${stage}`,
        transition: stage,
      });
      assert.equal(result.status, 'updated', `stage ${stage} should be accepted`);
      assert.equal(readRecord(listDir).lifecycle_stage, stage);
      assert.equal(readRecord(listDir).sequence_status, 'active', `stage ${stage} must not change sequence_status`);
    } finally {
      restore();
    }
  }
});
