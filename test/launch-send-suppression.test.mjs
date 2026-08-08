import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  addSuppression,
  ensureRecordColumns,
  insertDraft,
  openGlobalSuppressionDb,
  openListDb,
} from '../dist/orchestrator/runtime/db.js';
import { launchSend } from '../dist/orchestrator/sequencer/runner.js';
import { evaluateTransmitterSuppression } from '../dist/orchestrator/policy/transmitter-suppression.js';

test('launchSend excludes an address found in the global suppression registry', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-launch-suppression-'));
  const globalRoot = join(listDir, 'global-root');
  mkdirSync(globalRoot, { recursive: true });
  writeFileSync(join(globalRoot, 'models.json'), JSON.stringify({
    schema_version: '1.0.0',
    providers: {
      openai: { provider: 'openai', models: ['gpt-4.1-mini'], updated_at: '' },
    },
  }));
  writeFileSync(join(listDir, 'outbound.yaml'), `
list: { name: Launch Suppression }
business: { name: Test, description: Test, icp: Test, offer: Test }
pipeline: []
sequences:
  default:
    steps:
      - kind: send_email
        id: email_1
        config:
          channel: email
          action: tool_call
          args: { subject: Subject, body: Body }
policy: { enforce_readiness: false }
ai: { default_model: openai/gpt-4.1-mini }
`);
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const previousGlobalRoot = process.env.AO_GLOBAL_ROOT;
  process.env.AO_GLOBAL_ROOT = globalRoot;
  try {
    const db = openListDb({ listDir, readonly: false });
    const now = new Date().toISOString();
    ensureRecordColumns({
      db,
      columns: ['contact_email', 'active_contact_id', 'account_sequence_state', 'lifecycle_stage', 'work_state', 'next_action_json'],
    });
    db.prepare(`
      INSERT INTO records (
        _row_id, business_name, sequence_name, sequence_status, contact_email,
        active_contact_id, account_sequence_state, lifecycle_stage, work_state,
        next_action_json, _created_at, _updated_at, created_at, updated_at
      ) VALUES (?, 'Suppressed Co', 'default', 'idle', ?, 'c1', 'active', 'contacted',
        'executing_external_action', ?, ?, ?, ?, ?)
    `).run(
      'launch_suppressed_1',
      'globally-suppressed@example.test',
      JSON.stringify({
        action_id: 'launch_suppressed_1',
        action_type: 'send_email',
        account_id: 'launch_suppressed_1',
        contact_id: 'c1',
        lifecycle_stage: 'contacted',
        sequence_state: 'active',
        work_state: 'executing_external_action',
        reason: 'test',
        on_success: 'continue',
      }),
      now,
      now,
      now,
      now,
    );
    insertDraft({
      db,
      draft: {
        draft_id: 'launch_suppressed_draft',
        row_id: 'launch_suppressed_1',
        sequence_name: 'default',
        step_number: 1,
        step_id: 'email_1',
        channel: 'email',
        status: 'ready',
        subject: 'Subject',
        body: 'Body',
      },
    });
    const globalDb = openGlobalSuppressionDb({ readonly: false });
    addSuppression({
      db: globalDb,
      entry: {
        id: 'global_launch_suppression',
        value: 'globally-suppressed@example.test',
        value_type: 'email',
        scope: 'global',
        reason: 'test',
      },
    });
    globalDb.close();
    assert.deepEqual(
      evaluateTransmitterSuppression({
        db,
        record: db.prepare('SELECT * FROM records WHERE _row_id = ?').get('launch_suppressed_1'),
        channel: 'email',
      }),
      { blocked: true, reason: 'email_suppressed' },
    );
    db.close();

    const result = await launchSend({ listDir, limit: 1 });
    assert.equal(result.skipped, 1);
    assert.equal(result.failed, 0);
    const verify = openListDb({ listDir, readonly: true });
    assert.equal(
      verify.prepare('SELECT last_error FROM records WHERE _row_id = ?').get('launch_suppressed_1').last_error,
      'gate_blocked: email_suppressed',
    );
    verify.close();
  } finally {
    if (previousGlobalRoot === undefined) delete process.env.AO_GLOBAL_ROOT;
    else process.env.AO_GLOBAL_ROOT = previousGlobalRoot;
  }
});
