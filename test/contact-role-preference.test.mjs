import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  openListDb,
  syncPrimaryContactProjection,
  upsertContact,
  upsertRecord,
} from '../dist/orchestrator/runtime/db.js';
import { normalizeConfig } from '../dist/schemas/config.js';

const primaryContactPolicy = {
  primary_contact: {
    title_patterns: ['operations', 'owner'],
    seniority: ['director', 'manager'],
    excluded_patterns: ['talent acquisition', 'recruiter'],
  },
};

const withDb = (contacts, callback) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-contact-role-preference-'));
  writeFileSync(join(listDir, 'outbound.yaml'), 'pipeline: []\n');
  const db = openListDb({ listDir, readonly: false });
  const recordId = 'contact_role_preference_record';
  upsertRecord({ db, row: { _row_id: recordId, business_name: 'Acme' } });
  contacts.forEach((contact) => {
    upsertContact({
      db,
      contact: {
        record_id: recordId,
        confidence: 90,
        ...contact,
      },
    });
  });
  try {
    return callback({ db, recordId });
  } finally {
    db.close();
  }
};

const primary = ({ db, recordId }) => db.prepare(`
  SELECT contact_id, title, email, is_primary
  FROM contacts
  WHERE row_id = ? AND is_primary = 1
`).get(recordId);

test('a pipeline role preference selects a matching primary contact', () => {
  const parsed = normalizeConfig({ contact_policy: primaryContactPolicy });
  assert.deepEqual(parsed.errors, []);

  withDb([
    { contact_id: 'owner', full_name: 'Owen Owner', title: 'Owner', email: 'owner@acme.test' },
    { contact_id: 'ops', full_name: 'Olivia Ops', title: 'Director of Operations', email: 'ops@acme.test' },
  ], ({ db, recordId }) => {
    syncPrimaryContactProjection({ db, recordId, contactPolicy: parsed.config.contact_policy });
    assert.deepEqual(primary({ db, recordId }), {
      contact_id: 'ops',
      title: 'Director of Operations',
      email: 'ops@acme.test',
      is_primary: 1,
    });
  });
});

test('a pipeline role preference falls back to the legacy projection when no contact matches', () => {
  const parsed = normalizeConfig({
    contact_policy: { primary_contact: { title_patterns: ['operations'] } },
  });
  assert.deepEqual(parsed.errors, []);

  withDb([
    { contact_id: 'owner', full_name: 'Owen Owner', title: 'Owner', email: 'owner@acme.test' },
    { contact_id: 'accountant', full_name: 'Brenda Guerrero', title: 'Staff Accountant', email: 'brenda@acme.test' },
  ], ({ db, recordId }) => {
    syncPrimaryContactProjection({ db, recordId, contactPolicy: parsed.config.contact_policy });
    assert.equal(primary({ db, recordId }).contact_id, 'owner');
  });
});

test('verified email outranks a role preference on an unverified contact', () => {
  const parsed = normalizeConfig({ contact_policy: primaryContactPolicy });
  assert.deepEqual(parsed.errors, []);

  withDb([
    { contact_id: 'ops', full_name: 'Olivia Ops', title: 'Director of Operations', email: 'ops@acme.test' },
    {
      contact_id: 'accountant',
      full_name: 'Brenda Guerrero',
      title: 'Staff Accountant',
      email: 'brenda@acme.test',
      email_verification_status: 'verified',
      email_verification_confidence: 100,
    },
  ], ({ db, recordId }) => {
    syncPrimaryContactProjection({ db, recordId, contactPolicy: parsed.config.contact_policy });
    assert.equal(primary({ db, recordId }).contact_id, 'accountant');
  });
});

test('suppression, DNC, and opt-out contacts cannot win a role preference', () => {
  const parsed = normalizeConfig({ contact_policy: primaryContactPolicy });
  assert.deepEqual(parsed.errors, []);

  withDb([
    { contact_id: 'opted_out', full_name: 'Olivia Opted Out', title: 'Director of Operations', email: 'opt-out@acme.test', dne_email: 1 },
    { contact_id: 'dnc', full_name: 'Owen Do Not Call', title: 'Operations Manager', email: 'dnc@acme.test', dnc_phone: 1 },
    { contact_id: 'suppressed', full_name: 'Olivia Suppressed', title: 'Operations Lead', email: 'suppressed@acme.test', linkedin_suppressed: 1 },
    { contact_id: 'owner', full_name: 'Owen Owner', title: 'Owner', email: 'owner@acme.test' },
  ], ({ db, recordId }) => {
    syncPrimaryContactProjection({ db, recordId, contactPolicy: parsed.config.contact_policy });
    assert.equal(primary({ db, recordId }).contact_id, 'owner');
  });
});

test('a pipeline without a primary-contact declaration keeps the legacy projection', () => {
  const parsed = normalizeConfig({});
  assert.deepEqual(parsed.errors, []);

  withDb([
    { contact_id: 'owner', full_name: 'Owen Owner', title: 'Owner', email: 'owner@acme.test' },
    { contact_id: 'ops', full_name: 'Olivia Ops', title: 'Director of Operations', email: 'ops@acme.test' },
  ], ({ db, recordId }) => {
    syncPrimaryContactProjection({ db, recordId, contactPolicy: parsed.config.contact_policy });
    assert.equal(primary({ db, recordId }).contact_id, 'owner');
  });
});
