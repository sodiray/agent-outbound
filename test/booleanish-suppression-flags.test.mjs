import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { isAffirmativeFlag } from '../dist/orchestrator/policy/booleanish.js';
import { evaluateReachability } from '../dist/orchestrator/policy/timing-reachability.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';

const SUPPRESSION_FIELDS = [
  'suppressed',
  'phone_suppressed',
  'dne_phone',
  'dne_email',
  'dnc_phone',
  'dnk_visit',
  'do_not_sms',
  'email_suppressed',
  'mail_suppressed',
];

const CONTACT_PROTECTING_FIELDS = [
  ...SUPPRESSION_FIELDS,
  'email_opted_out',
  'opted_out_email',
  'email_bounced',
];

const READINESS_FIELDS = [
  'mail_address_ready',
  'golden_ticket_asset_ready',
  'address_validated',
  'linkedin_connected',
];

const readyPhone = {
  phone: '+12085551212',
  phone_confidence: 85,
};

const readyEmail = {
  contact_email: 'owner@example.test',
  email_verification_status: 'verified',
  email_verification_confidence: 90,
};

const readyMail = {
  mailing_address: '100 Main Street, Boise, ID 83702',
  mail_address_ready: 1,
};

const channelState = (record, channel) => evaluateReachability(record)
  .channels.find((candidate) => candidate.channel === channel);

test('booleanish suppression coercion accepts explicit clears and fails closed on ambiguity', () => {
  const negativeValues = ['0', '0.0', 'false', '', 0, false, null, undefined];
  const affirmativeValues = [1, '1', '1.0', true, 'true'];

  for (const field of [...CONTACT_PROTECTING_FIELDS, ...READINESS_FIELDS]) {
    for (const value of negativeValues) {
      assert.equal(isAffirmativeFlag(value, { failClosed: CONTACT_PROTECTING_FIELDS.includes(field) }), false, `${field} ${String(value)}`);
    }
    for (const value of affirmativeValues) {
      assert.equal(isAffirmativeFlag(value, { failClosed: CONTACT_PROTECTING_FIELDS.includes(field) }), true, `${field} ${String(value)}`);
    }
  }

  for (const field of CONTACT_PROTECTING_FIELDS) {
    assert.equal(isAffirmativeFlag('maybe', { failClosed: true }), true, `${field} must fail closed`);
  }
});

test('clearing phone suppression with zero restores reachability', () => {
  const suppressed = channelState({ ...readyPhone, phone_suppressed: 1 }, 'phone');
  const clearedText = channelState({ ...readyPhone, phone_suppressed: '0' }, 'phone');
  const clearedNumber = channelState({ ...readyPhone, phone_suppressed: 0 }, 'phone');

  assert.equal(suppressed?.state, 'suppressed');
  assert.equal(clearedText?.state, 'named_validated');
  assert.equal(clearedText?.ready, true);
  assert.equal(clearedNumber?.state, 'named_validated');
});

test('channel suppression flags observe clears, affirmative values, and ambiguity', () => {
  const cases = [
    { field: 'dne_phone', channel: 'phone', record: readyPhone },
    { field: 'dnc_phone', channel: 'phone', record: readyPhone },
    { field: 'dne_email', channel: 'email', record: readyEmail },
    { field: 'email_suppressed', channel: 'email', record: readyEmail },
    { field: 'mail_suppressed', channel: 'mail', record: readyMail },
  ];

  for (const { field, channel, record } of cases) {
    assert.notEqual(channelState({ ...record, [field]: '0' }, channel)?.state, 'suppressed', `${field} text zero clears`);
    assert.equal(channelState({ ...record, [field]: 'true' }, channel)?.state, 'suppressed', `${field} true suppresses`);
    assert.equal(channelState({ ...record, [field]: 'maybe' }, channel)?.state, 'suppressed', `${field} ambiguity suppresses`);
  }
});

test('record writes normalize text flags to numeric zero or one', () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-booleanish-flags-'));
  const db = openListDb({ listDir, readonly: false });
  try {
    ensureRecordColumns({ db, columns: [...CONTACT_PROTECTING_FIELDS, ...READINESS_FIELDS] });
    upsertRecord({
      db,
      row: {
        _row_id: 'flag-record',
        business_name: 'Flag Co',
        ...Object.fromEntries([...CONTACT_PROTECTING_FIELDS, ...READINESS_FIELDS].map((field) => [field, '0'])),
      },
    });
    const cleared = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('flag-record');
    for (const field of [...CONTACT_PROTECTING_FIELDS, ...READINESS_FIELDS]) {
      assert.equal(Number(cleared[field]), 0, `${field} stores a cleared zero`);
    }

    upsertRecord({
      db,
      row: {
        ...cleared,
        _row_id: 'flag-record',
        business_name: 'Flag Co',
        ...Object.fromEntries([...CONTACT_PROTECTING_FIELDS, ...READINESS_FIELDS].map((field) => [field, 'true'])),
      },
    });
    const set = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('flag-record');
    for (const field of [...CONTACT_PROTECTING_FIELDS, ...READINESS_FIELDS]) {
      assert.equal(Number(set[field]), 1, `${field} stores an affirmative one`);
    }
  } finally {
    db.close();
    rmSync(listDir, { recursive: true, force: true });
  }
});
