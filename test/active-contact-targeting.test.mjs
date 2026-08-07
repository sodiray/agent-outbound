/**
 * Phase A2 — active-contact hydration + targeting for channel execution.
 *
 * Bug classes:
 * - Send uses seniority-primary denormalized contact_email after rotation
 *   instead of the campaign active contact email.
 * - channel_events omit contact_id when active contact is known (audit/CRM leak).
 * - assertActionTarget allows held contacts to receive named-channel outreach.
 *
 * Pure hydrate/assert unit tests + executeChannelStep fixture path for events.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  hydrateActiveContactOntoRecord,
  resolveActiveContactId,
  denormalizedFieldsFromContact,
  dispositionFromContactRow,
  mapContactRowsToCampaignContacts,
  resolveActiveContactEmailForSend,
} from '../dist/orchestrator/policy/load-contacts.js';
import {
  buildContactPlan,
  assertActionTarget,
  parseAccountCampaignFromRecord,
} from '../dist/orchestrator/policy/contact-campaign.js';
import { openListDb, ensureRecordColumns, projectContactOntoRecord } from '../dist/orchestrator/runtime/db.js';
import { executeChannelStep } from '../dist/orchestrator/channels/execute.js';
import { NEXT_ACTION_POLICY_VERSION } from '../dist/orchestrator/policy/lifecycle.js';

// --- Pure: hydrateActiveContactOntoRecord ----------------------------------

test('hydrateActiveContactOntoRecord: active contact email overlays seniority-primary denorm', () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-hydrate-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
list:
  name: Hydrate Active Contact
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
  version: tv-pipeline-v1
`);
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));

  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const rowId = 'acct_hydrate_1';
  const plan = buildContactPlan({
    account_id: rowId,
    campaign_id: 'camp_h1',
    treatment_tier: 'B',
    contacts: [
      { contact_id: 'c_seniority', outbound_disposition: 'eligible_target', outreach_rank: 2 },
      { contact_id: 'c_active', outbound_disposition: 'eligible_target', outreach_rank: 1 },
    ],
  });
  // Active is outreach_rank 1 → c_active; held → c_seniority.
  assert.equal(plan.active_contact_id, 'c_active');
  assert.ok(plan.held_contact_ids.includes('c_seniority'));

  ensureRecordColumns({
    db,
    columns: [
      'active_contact_id',
      'contact_id',
      'account_contact_plan_json',
      'lifecycle_stage',
      'account_sequence_state',
      'work_state',
      'next_action_json',
      'treatment_tier',
      'suppressed',
    ],
  });

  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      contact_email, contact_name, active_contact_id, account_contact_plan_json,
      lifecycle_stage, account_sequence_state, work_state, next_action_json,
      treatment_tier, suppressed,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      ?, 'Hydrate HVAC', 'default', 'active', 0,
      ?, 'Seniority Primary', ?, ?,
      'contacted', 'active', 'executing_external_action', ?,
      'B', 0,
      ?, ?, ?, ?
    )
  `).run(
    rowId,
    // Stale seniority-primary denorm (wrong recipient after rotation / mis-project).
    'seniority@example-hydrate.test',
    plan.active_contact_id,
    JSON.stringify(plan),
    JSON.stringify({
      action_id: 'na_h1',
      action_type: 'send_email',
      account_id: rowId,
      contact_id: plan.active_contact_id,
      lifecycle_stage: 'contacted',
      sequence_state: 'active',
      work_state: 'executing_external_action',
      reason: 'hydrate test',
      on_success: 'continue',
      policy_version: NEXT_ACTION_POLICY_VERSION,
    }),
    now,
    now,
    now,
    now,
  );

  db.prepare(`
    INSERT INTO contacts (
      contact_id, id, row_id, name, full_name, title, email, phone, linkedin_url,
      role, is_primary, created_at, updated_at
    ) VALUES
      ('c_seniority', 'c_seniority', ?, 'Seniority Primary', 'Seniority Primary', 'Owner',
       'seniority@example-hydrate.test', '', '', 'primary', 1, ?, ?),
      ('c_active', 'c_active', ?, 'Active Ops', 'Active Ops', 'Ops Manager',
       'active@example-hydrate.test', '555-0100', 'https://linkedin.com/in/active-ops',
       'secondary', 0, ?, ?)
  `).run(rowId, now, now, rowId, now, now);

  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  assert.equal(record.contact_email, 'seniority@example-hydrate.test');
  assert.equal(resolveActiveContactId(record), 'c_active');

  const hydrated = hydrateActiveContactOntoRecord({ db, record });
  assert.equal(hydrated.active_contact_id, 'c_active');
  assert.equal(hydrated.record.contact_id, 'c_active');
  assert.equal(hydrated.record.active_contact_id, 'c_active');
  // Critical: send path must target active email, not seniority primary denorm.
  assert.equal(hydrated.record.contact_email, 'active@example-hydrate.test');
  assert.equal(hydrated.record.contact_name, 'Active Ops');
  assert.equal(hydrated.record.contact_first_name, 'Active');
  assert.equal(hydrated.record.contact_linkedin_url, 'https://linkedin.com/in/active-ops');
  assert.equal(hydrated.projected.contact_email, 'active@example-hydrate.test');
  // Input record not mutated.
  assert.equal(record.contact_email, 'seniority@example-hydrate.test');

  projectContactOntoRecord({ db, recordId: rowId, contactId: 'c_active' });
  const persisted = db.prepare('SELECT contact_name, contact_first_name FROM records WHERE _row_id = ?').get(rowId);
  assert.deepEqual(persisted, { contact_name: 'Active Ops', contact_first_name: 'Active' });

  db.close();
});

test('hydrateActiveContactOntoRecord: stamps contact_id when contact row missing', () => {
  const record = {
    _row_id: 'acct_no_row',
    active_contact_id: 'c_ghost',
    contact_email: 'stale@example.test',
  };
  const hydrated = hydrateActiveContactOntoRecord({ db: null, record });
  assert.equal(hydrated.active_contact_id, 'c_ghost');
  assert.equal(hydrated.contact, null);
  assert.equal(hydrated.record.contact_id, 'c_ghost');
  assert.equal(hydrated.record.active_contact_id, 'c_ghost');
  // No contact row → denorm fields stay as on record.
  assert.equal(hydrated.record.contact_email, 'stale@example.test');
  assert.deepEqual(hydrated.projected, {});
});

test('denormalizedFieldsFromContact: email is authoritative (blank clears stale)', () => {
  assert.deepEqual(denormalizedFieldsFromContact(null), {});
  assert.deepEqual(
    denormalizedFieldsFromContact({ email: 'a@b.test', name: '  ', phone: '' }),
    { contact_email: 'a@b.test', contact_first_name: '' },
  );
  // Blank email must project '' so hydrate cannot leave seniority-primary denorm.
  assert.deepEqual(
    denormalizedFieldsFromContact({ email: '', name: 'Ops', phone: '' }),
    {
      contact_name: 'Ops',
      contact_name_primary: 'Ops',
      owner_name: 'Ops',
      contact_first_name: 'Ops',
      contact_email: '',
    },
  );
});

test('denormalizedFieldsFromContact: derives safe first names from contact identity', () => {
  assert.equal(denormalizedFieldsFromContact({ name: 'Alex Costa' }).contact_first_name, 'Alex');
  assert.equal(denormalizedFieldsFromContact({ name: 'Dr. Shawn Stadlbauer, DC' }).contact_first_name, 'Shawn');
  assert.equal(denormalizedFieldsFromContact({ name: 'Ms. Alex Costa Jr., PhD' }).contact_first_name, 'Alex');
  assert.equal(denormalizedFieldsFromContact({ name: 'Cher' }).contact_first_name, 'Cher');
});

test('denormalizedFieldsFromContact: leaves ambiguous or absent names blank', () => {
  assert.equal(denormalizedFieldsFromContact({ name: 'Acme Plumbing LLC' }).contact_first_name, '');
  assert.equal(denormalizedFieldsFromContact({ name: 'Sales Team' }).contact_first_name, '');
  assert.equal(denormalizedFieldsFromContact({ name: 'Costa, Alex' }).contact_first_name, '');
  assert.equal(denormalizedFieldsFromContact({ email: 'contact@example.test' }).contact_first_name, '');
});

// --- Pure: assertActionTarget held contact ---------------------------------

test('assertActionTarget: held contact cannot receive named-channel outreach', () => {
  const plan = buildContactPlan({
    account_id: 'a_held',
    campaign_id: 'camp_held',
    treatment_tier: 'A',
    contacts: [
      { contact_id: 'c_active', outbound_disposition: 'eligible_target', outreach_rank: 1 },
      { contact_id: 'c_held', outbound_disposition: 'eligible_target', outreach_rank: 2 },
    ],
  });
  assert.equal(plan.active_contact_id, 'c_active');
  assert.deepEqual(plan.held_contact_ids, ['c_held']);

  assertActionTarget({ campaign: plan, contact_id: 'c_active', channel: 'email' });
  assertActionTarget({ campaign: plan, contact_id: 'c_active', channel: 'linkedin' });

  assert.throws(
    () => assertActionTarget({ campaign: plan, contact_id: 'c_held', channel: 'email' }),
    /not the active contact|Held contact cannot receive/i,
  );
  assert.throws(
    () => assertActionTarget({ campaign: plan, contact_id: 'c_held', channel: 'linkedin' }),
    /not the active contact|Held contact cannot receive/i,
  );
  assert.throws(
    () => assertActionTarget({ campaign: plan, contact_id: 'c_other', channel: 'email' }),
    /not the active contact/i,
  );
});

// --- executeChannelStep: channel_events.contact_id -------------------------

const projectYaml = `
list:
  name: Active Contact Targeting
business:
  name: Mission
  description: Test
  icp: Test
  offer: Test
pipeline: []
sequences:
  default:
    steps:
      - kind: linkedin_connect
        id: linkedin_1
        day: 0
policy:
  version: tv-pipeline-v1
  forbidden_channels: [send_sms, visit, field_visit]
  enforce_readiness: false
  review_required_for: []
channels:
  email:
    draft_approval_required: false
`;

test('executeChannelStep: channel_events.contact_id set when active contact known', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-active-evt-'));
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml);
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const rowId = 'acct_evt_1';
  const activeId = 'c_ops_active';

  ensureRecordColumns({
    db,
    columns: [
      'lifecycle_stage',
      'account_sequence_state',
      'work_state',
      'next_action_json',
      'active_contact_id',
      'contact_id',
      'treatment_tier',
      'suppressed',
      'account_contact_plan_json',
      'contact_linkedin_url',
    ],
  });

  const plan = buildContactPlan({
    account_id: rowId,
    campaign_id: 'camp_evt',
    treatment_tier: 'B',
    contacts: [
      { contact_id: activeId, outbound_disposition: 'eligible_target', outreach_rank: 1 },
      { contact_id: 'c_held', outbound_disposition: 'eligible_target', outreach_rank: 2 },
    ],
  });

  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      contact_email, contact_linkedin_url, lifecycle_stage, account_sequence_state,
      work_state, next_action_json, active_contact_id, account_contact_plan_json,
      treatment_tier, suppressed,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      ?, 'Event HVAC', 'default', 'active', 0,
      'seniority@example-evt.test', 'https://linkedin.com/in/seniority',
      'contacted', 'active', 'executing_external_action', ?,
      ?, ?, 'B', 0,
      ?, ?, ?, ?
    )
  `).run(
    rowId,
    JSON.stringify({
      action_id: 'na_li',
      action_type: 'linkedin_connect',
      account_id: rowId,
      contact_id: activeId,
      lifecycle_stage: 'contacted',
      sequence_state: 'active',
      work_state: 'executing_external_action',
      reason: 'linkedin send',
      on_success: 'continue',
      policy_version: NEXT_ACTION_POLICY_VERSION,
    }),
    activeId,
    JSON.stringify(plan),
    now,
    now,
    now,
    now,
  );

  db.prepare(`
    INSERT INTO contacts (
      contact_id, id, row_id, name, full_name, email, linkedin_url,
      role, is_primary, created_at, updated_at
    ) VALUES
      (?, ?, ?, 'Ops Active', 'Ops Active', 'active@example-evt.test',
       'https://linkedin.com/in/ops-active', 'secondary', 0, ?, ?),
      ('c_held', 'c_held', ?, 'Held', 'Held', 'held@example-evt.test',
       'https://linkedin.com/in/held', 'primary', 1, ?, ?)
  `).run(activeId, activeId, rowId, now, now, rowId, now, now);

  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  assert.equal(parseAccountCampaignFromRecord(record)?.active_contact_id, activeId);

  const step = {
    kind: 'linkedin_connect',
    id: 'linkedin_1',
    config: {
      channel: 'linkedin',
      daily_cap: 999,
      idempotency: {
        key_source: ['_row_id', 'step_id', 'active_contact_id'],
        scope: 'list',
      },
    },
  };

  const prevFixture = process.env.AO_UNIPILE_FIXTURE;
  process.env.AO_UNIPILE_FIXTURE = '1';
  try {
    const out = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Active Contact Targeting',
      toolCatalog: null,
      db,
      record,
      sequenceName: 'default',
      stepNumber: 1,
      step,
      sequence: { steps: [step] },
      channelHint: 'linkedin',
      intent: 'send',
      dryRun: false,
    });
    assert.equal(out.status, 'sent', JSON.stringify(out));

    const events = db.prepare(`
      SELECT contact_id, channel, action, payload_json
      FROM channel_events
      WHERE row_id = ?
      ORDER BY occurred_at DESC
    `).all(rowId);
    assert.ok(events.length >= 1, 'expected channel_event');
    const evt = events[0];
    assert.equal(evt.contact_id, activeId, `contact_id missing/wrong: ${JSON.stringify(evt)}`);
    assert.equal(evt.channel, 'linkedin');
    const payload = JSON.parse(evt.payload_json || '{}');
    assert.equal(payload.contact_id, activeId);
  } finally {
    if (prevFixture === undefined) delete process.env.AO_UNIPILE_FIXTURE;
    else process.env.AO_UNIPILE_FIXTURE = prevFixture;
  }

  db.close();
});

// --- Eligibility from contacts table (not blanket eligible_target) ----------

test('dispositionFromContactRow: reads contacts table fields, not blanket eligible', () => {
  assert.equal(
    dispositionFromContactRow({
      contact_id: 'c1',
      name: 'Owner',
      email: 'o@x.test',
      is_primary: 1,
    }),
    'eligible_target',
  );
  assert.equal(
    dispositionFromContactRow({
      contact_id: 'c_router',
      name: 'Front Desk',
      email: 'info@x.test',
      role: 'routing_only',
    }),
    'routing_only',
  );
  assert.equal(
    dispositionFromContactRow({
      contact_id: 'c_dne',
      name: 'No Channel',
      email: 'x@y.test',
      dne_email: 1,
      dnc_phone: 1,
    }),
    'excluded',
  );
  assert.equal(
    dispositionFromContactRow({
      contact_id: 'c_empty',
      name: '',
      email: '',
      phone: '',
      linkedin_url: '',
    }),
    'excluded',
  );
  assert.equal(
    dispositionFromContactRow({
      contact_id: 'c_explicit',
      name: 'X',
      email: 'a@b.test',
      outbound_disposition: 'routing_only',
    }),
    'routing_only',
  );
  assert.equal(dispositionFromContactRow(null), 'unresolved');
});

test('mapContactRowsToCampaignContacts: disposition from table, not always eligible_target', () => {
  const mapped = mapContactRowsToCampaignContacts([
    { contact_id: 'c_ok', name: 'Ok', email: 'ok@x.test', is_primary: 1 },
    { contact_id: 'c_route', name: 'Route', email: 'r@x.test', role: 'router', is_primary: 0 },
    { contact_id: 'c_block', name: 'Block', email: 'b@x.test', dne_email: 1, dnc_phone: 1 },
  ]);
  assert.equal(mapped[0].outbound_disposition, 'eligible_target');
  assert.equal(mapped[0].outreach_rank, 1);
  assert.equal(mapped[1].outbound_disposition, 'routing_only');
  assert.equal(mapped[2].outbound_disposition, 'excluded');

  const plan = buildContactPlan({
    account_id: 'a1',
    campaign_id: 'camp1',
    treatment_tier: 'B',
    contacts: mapped,
  });
  // Only eligible_target enters the ordered queue.
  assert.equal(plan.active_contact_id, 'c_ok');
  assert.deepEqual(plan.held_contact_ids, []);
  assert.deepEqual(plan.routing_contact_ids, ['c_route']);
  assert.deepEqual(plan.excluded_contact_ids, ['c_block']);
});

test('resolveActiveContactEmailForSend: contacts table blank does not soft-pass email_primary', () => {
  const blankContact = { contact_id: 'c_blank', email: '' };
  const record = {
    contact_email: 'stale-seniority@example.test',
    email_primary: 'primary@example.test',
  };
  const resolved = resolveActiveContactEmailForSend({ contact: blankContact, record });
  assert.equal(resolved.email, '');
  assert.equal(resolved.source, 'contacts_table');

  const withEmail = resolveActiveContactEmailForSend({
    contact: { contact_id: 'c1', email: 'active@example.test' },
    record,
  });
  assert.equal(withEmail.email, 'active@example.test');
  assert.equal(withEmail.source, 'contacts_table');

  // No contact row: may use record.contact_email only (never email_primary alone).
  const noRow = resolveActiveContactEmailForSend({
    contact: null,
    record: { contact_email: '', email_primary: 'primary@example.test' },
  });
  assert.equal(noRow.email, '');
  assert.equal(noRow.source, 'none');
});

test('hydrateActiveContactOntoRecord: blank contact email clears stale denorm', () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-blank-email-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
list:
  name: Blank Email Hydrate
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
  version: tv-pipeline-v1
`);
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const rowId = 'acct_blank_email';
  const activeId = 'c_no_email';

  ensureRecordColumns({
    db,
    columns: ['active_contact_id', 'contact_id', 'account_contact_plan_json', 'email_primary'],
  });

  const plan = buildContactPlan({
    account_id: rowId,
    campaign_id: 'camp_blank',
    treatment_tier: 'B',
    contacts: [
      { contact_id: activeId, outbound_disposition: 'eligible_target', outreach_rank: 1 },
    ],
  });

  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      contact_email, email_primary, active_contact_id, account_contact_plan_json,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      ?, 'Blank Email Co', 'default', 'active', 0,
      'stale-seniority@example-blank.test', 'primary@example-blank.test', ?, ?,
      ?, ?, ?, ?
    )
  `).run(rowId, activeId, JSON.stringify(plan), now, now, now, now);

  db.prepare(`
    INSERT INTO contacts (
      contact_id, id, row_id, name, full_name, email, phone, linkedin_url,
      role, is_primary, created_at, updated_at
    ) VALUES (?, ?, ?, 'No Email Ops', 'No Email Ops', '', '555-0199',
      'https://linkedin.com/in/no-email-ops', 'secondary', 0, ?, ?)
  `).run(activeId, activeId, rowId, now, now);

  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const hydrated = hydrateActiveContactOntoRecord({ db, record });
  assert.equal(hydrated.active_contact_id, activeId);
  assert.equal(hydrated.contact?.email, '');
  // Critical: must not leave seniority/primary denorm as send target.
  assert.equal(hydrated.record.contact_email, '');
  assert.equal(
    resolveActiveContactEmailForSend({ contact: hydrated.contact, record: hydrated.record }).email,
    '',
  );

  db.close();
});

// --- executeChannelStep: blank email fail-closed ---------------------------

test('executeChannelStep: blank active-contact email fails closed (no email_primary soft-pass)', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-blank-send-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
list:
  name: Blank Email Send
business:
  name: Mission
  description: Test
  icp: Test
  offer: Test
pipeline: []
sequences:
  default:
    steps:
      - kind: send_email
        id: email_1
        day: 0
policy:
  version: tv-pipeline-v1
  forbidden_channels: [send_sms, visit, field_visit]
  enforce_readiness: false
channels:
  email:
    draft_approval_required: false
`);
  writeFileSync(join(listDir, 'operator.md'), 'test');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const rowId = 'acct_blank_send';
  const activeId = 'c_blank_send';

  ensureRecordColumns({
    db,
    columns: [
      'lifecycle_stage',
      'account_sequence_state',
      'work_state',
      'next_action_json',
      'active_contact_id',
      'contact_id',
      'treatment_tier',
      'suppressed',
      'account_contact_plan_json',
      'email_primary',
    ],
  });

  const plan = buildContactPlan({
    account_id: rowId,
    campaign_id: 'camp_blank_send',
    treatment_tier: 'B',
    contacts: [
      { contact_id: activeId, outbound_disposition: 'eligible_target', outreach_rank: 1 },
    ],
  });

  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status, sequence_step,
      contact_email, email_primary, lifecycle_stage, account_sequence_state,
      work_state, next_action_json, active_contact_id, account_contact_plan_json,
      treatment_tier, suppressed,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (
      ?, 'Blank Send HVAC', 'default', 'active', 0,
      'stale@example-blank-send.test', 'primary@example-blank-send.test',
      'contacted', 'active', 'executing_external_action', ?,
      ?, ?, 'B', 0,
      ?, ?, ?, ?
    )
  `).run(
    rowId,
    JSON.stringify({
      action_id: 'na_email',
      action_type: 'send_email',
      account_id: rowId,
      contact_id: activeId,
      lifecycle_stage: 'contacted',
      sequence_state: 'active',
      work_state: 'executing_external_action',
      reason: 'email send',
      on_success: 'continue',
      policy_version: NEXT_ACTION_POLICY_VERSION,
    }),
    activeId,
    JSON.stringify(plan),
    now,
    now,
    now,
    now,
  );

  db.prepare(`
    INSERT INTO contacts (
      contact_id, id, row_id, name, full_name, email, phone, linkedin_url,
      role, is_primary, created_at, updated_at
    ) VALUES (?, ?, ?, 'Blank Ops', 'Blank Ops', '', '555-0200',
      'https://linkedin.com/in/blank-ops', 'secondary', 0, ?, ?)
  `).run(activeId, activeId, rowId, now, now);

  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  const step = {
    kind: 'send_email',
    id: 'email_1',
    config: {
      action: 'tool_call',
      tool: { server: 'noop', tools: ['NOOP'] },
      daily_cap: 999,
      args: { subject: 'Should not send', body: 'body' },
      args_map: { to: 'contact_email' },
      idempotency: {
        key_source: ['_row_id', 'step_id', 'active_contact_id'],
        scope: 'list',
      },
    },
  };

  const prev = process.env.AO_PIPELINE_FIXTURE;
  process.env.AO_PIPELINE_FIXTURE = '1';
  try {
    const out = await executeChannelStep({
      mcp: null,
      listDir,
      listName: 'Blank Email Send',
      toolCatalog: null,
      db,
      record,
      sequenceName: 'default',
      stepNumber: 1,
      step,
      sequence: { steps: [step] },
      channelHint: 'email',
      intent: 'send',
      dryRun: false,
    });
    assert.equal(out.status, 'skipped', JSON.stringify(out));
    assert.match(String(out.reason), /blank email|no email/i);
    // Must not have claimed/completed a send under the stale address.
    const events = db.prepare(`
      SELECT * FROM channel_events WHERE row_id = ? AND channel = 'email'
    `).all(rowId);
    assert.equal(events.length, 0, 'no email channel_events on blank-email refuse');
    const idem = db.prepare('SELECT * FROM idempotency').all();
    assert.equal(idem.length, 0, 'blank-email refuse must not poison idempotency');
  } finally {
    if (prev === undefined) delete process.env.AO_PIPELINE_FIXTURE;
    else process.env.AO_PIPELINE_FIXTURE = prev;
  }

  db.close();
});
