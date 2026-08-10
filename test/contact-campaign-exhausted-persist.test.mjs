/**
 * contact_campaign_status = 'exhausted' is a terminal marker written when
 * contact rotation finds nobody left. upsertRecord drops unknown fields when
 * their columns do not exist; the sequencer path must ensure the column first
 * (matching pipeline/manual.ts). Park close / rotation stays best-effort —
 * disposition still records, and failures surface on last_error.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  ensureRecordColumns,
  openListDb,
  upsertRecord,
} from '../dist/orchestrator/runtime/db.js';
import { logOutcome } from '../dist/orchestrator/sequencer/runner.js';

const seedList = ({
  suffix,
  withCampaignColumn = false,
  openPark = true,
  campaignPlan = null,
} = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), `ao-campaign-exhausted-${suffix}-`));
  const globalRoot = join(listDir, 'global-root');
  mkdirSync(globalRoot, { recursive: true });
  writeFileSync(join(globalRoot, 'models.json'), JSON.stringify({
    schema_version: '1.0.0',
    providers: { openai: { provider: 'openai', models: ['gpt-4.1-mini'], updated_at: '' } },
  }));
  writeFileSync(join(listDir, 'outbound.yaml'), `
list: { name: Campaign Exhausted Persist }
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
  const columns = [
    'outcome',
    'outcome_notes',
    'outcome_at',
    'disposition_latest',
    'disposition_follow_up_at',
    'active_contact_id',
    'contact_id',
    'next_action_json',
    'account_contact_plan_json',
    'last_error',
  ];
  if (withCampaignColumn) columns.push('contact_campaign_status');
  ensureRecordColumns({ db, columns });

  const plan = campaignPlan === null
    ? {
      active_contact_id: 'c_only',
      held_contact_ids: [],
      ordered_target_contact_ids: ['c_only'],
    }
    : campaignPlan;

  upsertRecord({
    db,
    row: {
      _row_id: 'rec_exh_1',
      business_name: 'Exhausted Probe Co',
      email_primary: 'owner@exhausted.test',
      sequence_status: 'active',
      sequence_name: 'default',
      active_contact_id: 'c_only',
      contact_id: 'c_only',
      account_contact_plan_json: plan ? JSON.stringify(plan) : '',
    },
  });

  if (openPark) {
    try { db.exec("ALTER TABLE pipeline_events ADD COLUMN contact_id TEXT DEFAULT ''"); } catch { /* exists */ }
    db.prepare(`
      INSERT INTO pipeline_events (
        event_id, record_id, step_id, kind, passed, reason, contact_id, occurred_at
      ) VALUES (?, ?, ?, 'manual_task', 0, 'awaiting_manual', ?, ?)
    `).run(randomUUID(), 'rec_exh_1', 'manual_tail_phone', 'c_only', new Date().toISOString());
  }

  // Confirm the campaign column is absent when requested (the bug condition).
  if (!withCampaignColumn) {
    const names = db.prepare('PRAGMA table_info(records)').all().map((c) => c.name);
    assert.ok(
      !names.includes('contact_campaign_status'),
      'precondition: contact_campaign_status must not exist yet',
    );
  }

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

const readRecord = (listDir, id = 'rec_exh_1') => {
  const db = openListDb({ listDir, readonly: true });
  try {
    return db.prepare('SELECT * FROM records WHERE _row_id = ?').get(id);
  } finally {
    db.close();
  }
};

const tableHasColumn = (listDir, column) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    return db.prepare('PRAGMA table_info(records)').all().some((c) => c.name === column);
  } finally {
    db.close();
  }
};

test('contact rotation with nobody left persists contact_campaign_status=exhausted when column was missing', () => {
  const { listDir, restore } = seedList({ suffix: 'no-col' });
  try {
    assert.equal(tableHasColumn(listDir, 'contact_campaign_status'), false);

    const result = logOutcome({
      listDir,
      prospect: 'Exhausted Probe Co',
      action: 'left_voicemail',
    });
    assert.equal(result.status, 'updated');

    assert.equal(tableHasColumn(listDir, 'contact_campaign_status'), true);
    const row = readRecord(listDir);
    assert.equal(row.contact_campaign_status, 'exhausted');
    // Existing truthy sequence_status is preserved by `status || 'completed'`.
    assert.equal(row.sequence_status, 'active');
    // Disposition still records.
    assert.equal(row.disposition_latest, 'left_voicemail');
    assert.equal(row.outcome, 'left_voicemail');
    assert.ok(String(row.outcome_at || '').length > 0);
  } finally {
    restore();
  }
});

test('same exhaustion flow with pre-existing contact_campaign_status column behaves as today', () => {
  const { listDir, restore } = seedList({ suffix: 'has-col', withCampaignColumn: true });
  try {
    assert.equal(tableHasColumn(listDir, 'contact_campaign_status'), true);

    const result = logOutcome({
      listDir,
      prospect: 'Exhausted Probe Co',
      action: 'no_answer',
    });
    assert.equal(result.status, 'updated');

    const row = readRecord(listDir);
    assert.equal(row.contact_campaign_status, 'exhausted');
    assert.equal(row.sequence_status, 'active');
    assert.equal(row.disposition_latest, 'no_answer');
    assert.equal(row.outcome, 'no_answer');
  } finally {
    restore();
  }
});

test('park close / rotation bookkeeping failure still records disposition and surfaces last_error', () => {
  const { listDir, restore } = seedList({ suffix: 'bookkeep-fail' });
  try {
    const db = openListDb({ listDir, readonly: false });
    db.exec(`
      CREATE TRIGGER pipeline_events_block_close
      BEFORE INSERT ON pipeline_events
      BEGIN
        SELECT RAISE(ABORT, 'forced park close failure');
      END;
    `);
    db.close();

    const result = logOutcome({
      listDir,
      prospect: 'Exhausted Probe Co',
      action: 'left_voicemail',
    });
    assert.equal(result.status, 'updated', 'disposition path must still succeed');

    const row = readRecord(listDir);
    assert.equal(row.disposition_latest, 'left_voicemail');
    assert.equal(row.outcome, 'left_voicemail');
    // Exhaustion is inside the failed bookkeeping block — must not have landed.
    const status = row.contact_campaign_status;
    assert.ok(
      status == null || status === '',
      `bookkeeping failed before exhaustion write; status should be empty, got: ${status}`,
    );
    // Surfaced, not swallowed (stage_review_open_failed / compliance_log_write_failed pattern).
    assert.ok(
      String(row.last_error || '').includes('park_close_rotation_failed:'),
      `expected surfaced last_error, got: ${row.last_error}`,
    );
    assert.ok(
      String(row.last_error || '').includes('forced park close failure'),
      `expected failure detail in last_error, got: ${row.last_error}`,
    );
  } finally {
    restore();
  }
});

test('upsertRecord does not create surprise columns for unknown fields', () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-upsert-unknown-col-'));
  mkdirSync(listDir, { recursive: true });
  writeFileSync(join(listDir, 'outbound.yaml'), `
list: { name: Upsert Unknown }
business: { name: Test, description: Test, icp: Test, offer: Test }
pipeline: []
sequences: { default: { steps: [] } }
`);
  writeFileSync(join(listDir, 'operator.md'), 't');
  writeFileSync(join(listDir, 'mcp.json'), '{}');

  const db = openListDb({ listDir, readonly: false });
  try {
    upsertRecord({
      db,
      row: { _row_id: 'r_unk', business_name: 'Unknown Col Co', sequence_status: 'active' },
    });
    const before = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('r_unk');
    upsertRecord({
      db,
      row: {
        ...before,
        totally_unknown_field_xyz: 'should_not_create_column',
        contact_campaign_status: 'exhausted',
      },
    });

    const colNames = db.prepare('PRAGMA table_info(records)').all().map((c) => c.name);
    assert.ok(
      !colNames.includes('totally_unknown_field_xyz'),
      'unknown field must not auto-create a column',
    );
    assert.ok(
      !colNames.includes('contact_campaign_status'),
      'lazy field without ensure must not auto-create a column',
    );
    const after = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('r_unk');
    assert.equal(after.contact_campaign_status, undefined);
    assert.equal(after.totally_unknown_field_xyz, undefined);
    // Known field still updates.
    assert.equal(after.business_name, 'Unknown Col Co');
  } finally {
    db.close();
    try { rmSync(listDir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
});
