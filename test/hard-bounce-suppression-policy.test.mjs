/**
 * Declarative hard-bounce suppression policy (policy.on_hard_bounce.suppress).
 *
 * AO supplies the mechanism; the pipeline author supplies the policy.
 * Default / omission = today's behaviour: structural bounce only, no suppression row.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { normalizeConfig } from '../dist/schemas/config.js';
import {
  ensureRecordColumns,
  hasSuppression,
  openListDb,
  upsertContact,
} from '../dist/orchestrator/runtime/db.js';
import { processBounceEvent } from '../dist/orchestrator/runtime/bounce-process.js';
import { buildContactPlan } from '../dist/orchestrator/policy/contact-campaign.js';

const projectYaml = `
list:
  name: Hard Bounce Policy
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
  version: hard-bounce-policy-v1
  enforce_readiness: false
`;

const createList = (recordOverrides = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-hard-bounce-policy-'));
  mkdirSync(join(listDir, '.outbound'), { recursive: true });
  writeFileSync(join(listDir, 'outbound.yaml'), projectYaml);
  writeFileSync(join(listDir, 'operator.md'), 'hard bounce policy');
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  const base = {
    _row_id: 'hb_1',
    business_name: 'Hard Bounce Co',
    contact_email: 'owner@acme.example',
    contact_name: 'Pat Owner',
    lifecycle_stage: 'contacted',
    account_sequence_state: 'active',
    sequence_status: 'active',
    sequence_name: 'default',
    active_contact_id: 'c_owner',
    contact_id: 'c_owner',
    _created_at: now,
    _updated_at: now,
    created_at: now,
    updated_at: now,
    ...recordOverrides,
  };
  ensureRecordColumns({ db, columns: Object.keys(base) });
  const cols = Object.keys(base);
  db.prepare(
    `INSERT INTO records (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
  ).run(...cols.map((k) => base[k]));
  return { listDir, db, now };
};

const seedContact = ({ db, rowId, contactId, email, primary = false }) => {
  upsertContact({
    db,
    contact: {
      row_id: rowId,
      contact_id: contactId,
      name: contactId,
      title: contactId,
      email,
      is_primary: primary ? 1 : 0,
      email_verification_status: 'valid',
      email_verification_confidence: 100,
    },
  });
};

const listSuppressions = (db) => db.prepare('SELECT * FROM suppression ORDER BY identifier_type, identifier_value').all();

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

test('policy.on_hard_bounce.suppress accepts email, domain, both, and empty (default)', () => {
  for (const suppress of [[], ['email'], ['domain'], ['email', 'domain']]) {
    const result = normalizeConfig({
      policy: { on_hard_bounce: { suppress } },
    });
    assert.deepEqual(result.errors, [], `suppress ${JSON.stringify(suppress)} must validate: ${JSON.stringify(result.errors)}`);
    assert.deepEqual(result.config.policy.on_hard_bounce.suppress, suppress);
  }

  const omitted = normalizeConfig({ policy: {} });
  assert.deepEqual(omitted.errors, []);
  assert.deepEqual(omitted.config.policy.on_hard_bounce?.suppress || [], []);
});

test('policy.on_hard_bounce rejects invalid suppress identifiers with a clear message', () => {
  const result = normalizeConfig({
    policy: { on_hard_bounce: { suppress: ['phone'] } },
  });
  assert.ok(result.errors.length > 0, 'expected validation error');
  const joined = result.errors.join('\n');
  assert.ok(
    /on_hard_bounce|suppress|email|domain/i.test(joined),
    `message must name the policy key / allowed values: ${joined}`,
  );
});

test('policy.on_hard_bounce rejects a non-object shape', () => {
  const result = normalizeConfig({
    policy: { on_hard_bounce: 'suppress_email' },
  });
  assert.ok(result.errors.length > 0, 'expected validation error for string shape');
});

test('sequences.*.on_bounce remains rejected and points at policy.on_hard_bounce', () => {
  const result = normalizeConfig({
    sequences: { default: { on_bounce: 'stop' } },
  });
  assert.ok(result.errors.length > 0);
  const joined = result.errors.join('\n');
  assert.ok(joined.includes('on_bounce'), joined);
  assert.ok(joined.includes('policy.on_hard_bounce'), joined);
});

// ---------------------------------------------------------------------------
// Runtime: default / declared / soft / contact / domain
// ---------------------------------------------------------------------------

test('hard bounce with no policy declaration writes NO suppression row (today\'s default)', () => {
  const { db } = createList({ _row_id: 'hb_none', contact_email: 'none@acme.example' });
  seedContact({ db, rowId: 'hb_none', contactId: 'c_owner', email: 'none@acme.example', primary: true });

  const applied = processBounceEvent({
    db,
    recordId: 'hb_none',
    messageId: 'hb_none_1',
    bounceType: 'hard',
    snippet: '550 5.1.1 user unknown',
    email: 'none@acme.example',
    contactId: 'c_owner',
    // no config
  });

  assert.equal(applied.bounce_type, 'hard');
  assert.equal(String(applied.record.email_bounced_address || '').toLowerCase(), 'none@acme.example');
  assert.equal(listSuppressions(db).length, 0, 'default must write zero suppression rows');
  db.close();
});

test('hard bounce with empty suppress array writes NO suppression row', () => {
  const { db } = createList({ _row_id: 'hb_empty', contact_email: 'empty@acme.example' });
  seedContact({ db, rowId: 'hb_empty', contactId: 'c_owner', email: 'empty@acme.example', primary: true });

  processBounceEvent({
    db,
    recordId: 'hb_empty',
    messageId: 'hb_empty_1',
    bounceType: 'hard',
    snippet: '550 5.1.1 user unknown',
    email: 'empty@acme.example',
    contactId: 'c_owner',
    config: { policy: { on_hard_bounce: { suppress: [] } } },
  });

  assert.equal(listSuppressions(db).length, 0);
  db.close();
});

test('hard bounce with suppress: [email] writes exactly one email suppression via addSuppression path', () => {
  const { db } = createList({ _row_id: 'hb_email', contact_email: 'bounced@acme.example' });
  seedContact({ db, rowId: 'hb_email', contactId: 'c_owner', email: 'bounced@acme.example', primary: true });

  const applied = processBounceEvent({
    db,
    recordId: 'hb_email',
    messageId: 'hb_email_1',
    bounceType: 'hard',
    snippet: '550 5.1.1 user unknown',
    email: 'bounced@acme.example',
    contactId: 'c_owner',
    config: { policy: { on_hard_bounce: { suppress: ['email'] } } },
  });

  assert.equal(applied.bounce_type, 'hard');
  const rows = listSuppressions(db);
  assert.equal(rows.length, 1, `expected exactly one suppression row, got ${JSON.stringify(rows)}`);
  assert.equal(String(rows[0].identifier_type || rows[0].value_type), 'email');
  assert.equal(String(rows[0].identifier_value || rows[0].value).toLowerCase(), 'bounced@acme.example');
  assert.equal(String(rows[0].reason), 'bounce');
  assert.equal(
    hasSuppression({ db, value: 'bounced@acme.example', valueType: 'email' }),
    true,
  );
  // Sibling mailbox at same domain is not covered by address-only entry.
  assert.equal(
    hasSuppression({ db, value: 'other@acme.example', valueType: 'email' }),
    false,
  );
  db.close();
});

test('soft bounce triggers no suppression under any declaration', () => {
  const { db } = createList({ _row_id: 'hb_soft', contact_email: 'soft@acme.example' });
  seedContact({ db, rowId: 'hb_soft', contactId: 'c_owner', email: 'soft@acme.example', primary: true });

  const applied = processBounceEvent({
    db,
    recordId: 'hb_soft',
    messageId: 'hb_soft_1',
    bounceType: 'soft',
    snippet: 'mailbox full temporary failure 4.2.2',
    email: 'soft@acme.example',
    contactId: 'c_owner',
    config: { policy: { on_hard_bounce: { suppress: ['email', 'domain'] } } },
  });

  assert.equal(applied.bounce_type, 'soft');
  assert.equal(applied.hardened_from_soft, false);
  assert.equal(listSuppressions(db).length, 0, 'soft must never write suppression even when hard policy is declared');
  db.close();
});

test('contact-scoped hard bounce suppresses only the bounced contact address, not a sibling', () => {
  const plan = buildContactPlan({
    account_id: 'hb_contact',
    campaign_id: 'hb_contact_campaign',
    treatment_tier: 'A',
    contacts: [
      { contact_id: 'c_owner', outbound_disposition: 'eligible_target', outreach_rank: 1 },
      { contact_id: 'c_mgr', outbound_disposition: 'eligible_target', outreach_rank: 2 },
    ],
  });
  const { db } = createList({
    _row_id: 'hb_contact',
    active_contact_id: 'c_owner',
    contact_id: 'c_owner',
    email_primary: 'primary-projection@other.example',
    contact_email: 'owner-bounced@acme.example',
    account_contact_plan_json: JSON.stringify(plan),
  });
  seedContact({
    db, rowId: 'hb_contact', contactId: 'c_owner',
    email: 'owner-bounced@acme.example', primary: true,
  });
  seedContact({
    db, rowId: 'hb_contact', contactId: 'c_mgr',
    email: 'manager-ok@acme.example',
  });

  processBounceEvent({
    db,
    recordId: 'hb_contact',
    messageId: 'hb_contact_1',
    bounceType: 'hard',
    snippet: '550 5.1.1 user unknown',
    email: 'owner-bounced@acme.example',
    contactId: 'c_owner',
    config: { policy: { on_hard_bounce: { suppress: ['email'] } } },
  });

  const rows = listSuppressions(db);
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].identifier_value || rows[0].value).toLowerCase(), 'owner-bounced@acme.example');
  assert.equal(hasSuppression({ db, value: 'owner-bounced@acme.example', valueType: 'email' }), true);
  assert.equal(hasSuppression({ db, value: 'manager-ok@acme.example', valueType: 'email' }), false);
  assert.equal(hasSuppression({ db, value: 'primary-projection@other.example', valueType: 'email' }), false);
  db.close();
});

test('hard bounce with suppress: [domain] writes a domain entry honoured by hasSuppression', () => {
  const { db } = createList({ _row_id: 'hb_domain', contact_email: 'owner@deadbiz.example' });
  seedContact({ db, rowId: 'hb_domain', contactId: 'c_owner', email: 'owner@deadbiz.example', primary: true });

  processBounceEvent({
    db,
    recordId: 'hb_domain',
    messageId: 'hb_domain_1',
    bounceType: 'hard',
    snippet: '550 relay denied: no MX record for recipient domain',
    email: 'owner@deadbiz.example',
    config: { policy: { on_hard_bounce: { suppress: ['domain'] } } },
  });

  const rows = listSuppressions(db);
  assert.equal(rows.length, 1, `expected one domain row: ${JSON.stringify(rows)}`);
  assert.equal(String(rows[0].identifier_type || rows[0].value_type), 'domain');
  assert.equal(String(rows[0].identifier_value || rows[0].value).toLowerCase(), 'deadbiz.example');
  // Existing domain matching: any email at that domain is suppressed.
  assert.equal(hasSuppression({ db, value: 'owner@deadbiz.example', valueType: 'email' }), true);
  assert.equal(hasSuppression({ db, value: 'sales@deadbiz.example', valueType: 'email' }), true);
  assert.equal(hasSuppression({ db, value: 'someone@other.example', valueType: 'email' }), false);
  db.close();
});

test('hard bounce with suppress: [email, domain] writes both entries', () => {
  const { db } = createList({ _row_id: 'hb_both', contact_email: 'both@both.example' });
  seedContact({ db, rowId: 'hb_both', contactId: 'c_owner', email: 'both@both.example', primary: true });

  processBounceEvent({
    db,
    recordId: 'hb_both',
    messageId: 'hb_both_1',
    bounceType: 'hard',
    snippet: '550 5.1.1 user unknown',
    email: 'both@both.example',
    contactId: 'c_owner',
    config: { policy: { on_hard_bounce: { suppress: ['email', 'domain'] } } },
  });

  const rows = listSuppressions(db);
  assert.equal(rows.length, 2, `expected email + domain: ${JSON.stringify(rows)}`);
  const types = new Set(rows.map((r) => String(r.identifier_type || r.value_type)));
  assert.ok(types.has('email'));
  assert.ok(types.has('domain'));
  db.close();
});
