import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';
import { readConfig } from '../dist/orchestrator/lib/config.js';
import { ensureRecordColumns, openListDb } from '../dist/orchestrator/runtime/db.js';

const createList = ({ inviteDailyCap } = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-linkedin-invite-cap-'));
  const cap = inviteDailyCap === undefined ? '' : `\n    invite_daily_cap: ${inviteDailyCap}`;
  writeFileSync(join(listDir, 'outbound.yaml'), `
list:
  name: LinkedIn invite cap
business:
  name: Mission
  description: Test
  icp: Test
  offer: Test
pipeline: []
sequences:
  default:
    steps: []
policy:
  version: test
  enforce_readiness: false
channels:
  linkedin:${cap}
`);
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  return { listDir, db: openListDb({ listDir, readonly: false }) };
};

const insertRecord = ({ db, id }) => {
  const now = '2026-08-09T10:00:00.000Z';
  ensureRecordColumns({
    db,
    columns: [
      'linkedin_url', 'lifecycle_stage', 'treatment_tier', 'eligibility_outcome', 'linkedin_confidence',
      'active_contact_id', 'account_contact_plan_json',
    ],
  });
  const contactId = `contact-${id}`;
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, contact_name, linkedin_url, lifecycle_stage, sequence_name, sequence_status,
      treatment_tier, eligibility_outcome, linkedin_confidence,
      active_contact_id, account_contact_plan_json,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'contacted', 'default', 'active', 'B', 'eligible', 70, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `Business ${id}`,
    'Pat Owner',
    `https://www.linkedin.com/in/${id}`,
    contactId,
    JSON.stringify({
      active_contact_id: contactId,
      held_contact_ids: [],
      ordered_target_contact_ids: [contactId],
    }),
    now,
    now,
    now,
    now,
  );
  db.prepare(`
    INSERT INTO contacts (
      contact_id, id, row_id, name, full_name, linkedin_url, created_at, updated_at
    ) VALUES (?, ?, ?, 'Pat Owner', 'Pat Owner', ?, ?, ?)
  `).run(contactId, contactId, id, `https://www.linkedin.com/in/${id}`, now, now);
  return db.prepare('SELECT * FROM records WHERE _row_id = ?').get(id);
};

const linkedinStep = {
  kind: 'linkedin_connect',
  id: 'linkedin_1',
  config: {
    channel: 'linkedin',
    invite_message: 'Hello — I would be glad to connect.',
    idempotency: {
      key_source: ['_row_id', 'step_id'],
      scope: 'list',
    },
  },
};

const sendInvite = ({ listDir, db, record, now }) => executeChannelStep({
  mcp: null,
  listDir,
  listName: 'LinkedIn invite cap',
  toolCatalog: null,
  db,
  record,
  sequenceName: 'default',
  stepNumber: 1,
  step: linkedinStep,
  sequence: { steps: [linkedinStep] },
  channelHint: 'linkedin',
  intent: 'send',
  dryRun: false,
  now,
});

const withFixture = async (run) => {
  const previous = process.env.AO_UNIPILE_FIXTURE;
  process.env.AO_UNIPILE_FIXTURE = '1';
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.AO_UNIPILE_FIXTURE;
    else process.env.AO_UNIPILE_FIXTURE = previous;
  }
};

test('LinkedIn invite daily cap stops provider-accepted invitations, resets at UTC day boundary, and is absent when undeclared', async () => {
  await withFixture(async () => {
    const capped = createList({ inviteDailyCap: 1 });
    try {
      const first = await sendInvite({
        listDir: capped.listDir,
        db: capped.db,
        record: insertRecord({ db: capped.db, id: 'cap-first' }),
        now: '2026-08-09T10:00:00.000Z',
      });
      const reached = await sendInvite({
        listDir: capped.listDir,
        db: capped.db,
        record: insertRecord({ db: capped.db, id: 'cap-reached' }),
        now: '2026-08-09T12:00:00.000Z',
      });
      const reset = await sendInvite({
        listDir: capped.listDir,
        db: capped.db,
        record: insertRecord({ db: capped.db, id: 'cap-reset' }),
        now: '2026-08-10T00:00:00.000Z',
      });

      assert.equal(first.status, 'sent', JSON.stringify(first));
      assert.equal(reached.status, 'skipped', JSON.stringify(reached));
      assert.equal(reached.reason, 'Daily LinkedIn invite cap reached (1).');
      assert.equal(reset.status, 'sent', JSON.stringify(reset));
    } finally {
      capped.db.close();
    }

    const uncapped = createList();
    try {
      const sent = await sendInvite({
        listDir: uncapped.listDir,
        db: uncapped.db,
        record: insertRecord({ db: uncapped.db, id: 'uncapped' }),
        now: '2026-08-09T12:00:00.000Z',
      });
      assert.equal(sent.status, 'sent', JSON.stringify(sent));
    } finally {
      uncapped.db.close();
    }
  });
});

test('unenforceable channel caps and the ambiguous LinkedIn daily_cap declaration fail validation', () => {
  const deprecatedDir = mkdtempSync(join(tmpdir(), 'ao-linkedin-cap-invalid-'));
  const unsupportedDir = mkdtempSync(join(tmpdir(), 'ao-channel-cap-invalid-'));
  writeFileSync(join(deprecatedDir, 'outbound.yaml'), 'channels:\n  linkedin:\n    daily_cap: 5\n');
  writeFileSync(join(unsupportedDir, 'outbound.yaml'), 'channels:\n  mail:\n    daily_cap: 5\n');

  assert.ok(readConfig(deprecatedDir).errors.some((error) => error.includes('channels.linkedin.daily_cap')));
  assert.ok(readConfig(deprecatedDir).errors.some((error) => error.includes('invite_daily_cap')));
  assert.ok(readConfig(unsupportedDir).errors.some((error) => error.includes('channels.mail.daily_cap')));
});
