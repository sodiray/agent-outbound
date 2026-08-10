/**
 * Domain-scoped suppression: hasSuppression({ valueType: 'email' }) must
 * honour domain entries (exact domain match after the last @), while leaving
 * exact-address and non-email valueTypes untouched.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  addSuppression,
  hasSuppression,
  openListDb,
} from '../dist/orchestrator/runtime/db.js';

const openTempListDb = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-domain-suppression-'));
  const db = openListDb({ listDir, readonly: false });
  return { listDir, db };
};

const suppress = ({ db, value, valueType, id = `sup_${valueType}_${value}` }) => {
  addSuppression({
    db,
    entry: {
      id,
      value,
      value_type: valueType,
      scope: 'global',
      reason: 'test',
      source: 'domain-suppression.test',
      created_at: new Date().toISOString(),
    },
  });
};

test('hasSuppression: email is suppressed when a domain entry for its domain exists', () => {
  const { db } = openTempListDb();
  try {
    suppress({ db, value: 'acme.example', valueType: 'domain' });
    assert.equal(
      hasSuppression({ db, value: 'owner@acme.example', valueType: 'email' }),
      true,
    );
    assert.equal(
      hasSuppression({ db, value: 'sales@acme.example', valueType: 'email' }),
      true,
    );
  } finally {
    db.close();
  }
});

test('hasSuppression: email is not suppressed when only an unrelated domain is suppressed', () => {
  const { db } = openTempListDb();
  try {
    suppress({ db, value: 'other.example', valueType: 'domain' });
    assert.equal(
      hasSuppression({ db, value: 'owner@acme.example', valueType: 'email' }),
      false,
    );
  } finally {
    db.close();
  }
});

test('hasSuppression: exact-address email suppression still works', () => {
  const { db } = openTempListDb();
  try {
    suppress({ db, value: 'owner@acme.example', valueType: 'email' });
    assert.equal(
      hasSuppression({ db, value: 'owner@acme.example', valueType: 'email' }),
      true,
    );
    // Sibling mailbox at the same domain is not covered by address-only entry.
    assert.equal(
      hasSuppression({ db, value: 'sales@acme.example', valueType: 'email' }),
      false,
    );
  } finally {
    db.close();
  }
});

test('hasSuppression: non-email valueType is unaffected by domain entries', () => {
  const { db } = openTempListDb();
  try {
    suppress({ db, value: 'acme.example', valueType: 'domain' });
    // Phone that happens to contain the domain string must not match.
    assert.equal(
      hasSuppression({ db, value: 'acme.example', valueType: 'phone' }),
      false,
    );
    assert.equal(
      hasSuppression({ db, value: '+12085551212', valueType: 'phone' }),
      false,
    );
    // Domain lookup itself still works via exact domain type.
    assert.equal(
      hasSuppression({ db, value: 'acme.example', valueType: 'domain' }),
      true,
    );
  } finally {
    db.close();
  }
});

test('addSuppression / suppress path accepts identifier_type domain', () => {
  const { db } = openTempListDb();
  try {
    addSuppression({
      db,
      entry: {
        id: 'domain_via_identifier_type',
        identifier_value: 'corp.example',
        identifier_type: 'domain',
        scope: 'global',
        reason: 'test',
        source: 'domain-suppression.test',
        created_at: new Date().toISOString(),
      },
    });
    assert.equal(
      hasSuppression({ db, value: 'anyone@corp.example', valueType: 'email' }),
      true,
    );
    // Legacy value/value_type twin columns are also populated by addSuppression.
    const row = db.prepare(
      `SELECT identifier_type, identifier_value, value_type, value FROM suppression WHERE entry_id = ?`,
    ).get('domain_via_identifier_type');
    assert.equal(row.identifier_type, 'domain');
    assert.equal(row.identifier_value, 'corp.example');
    assert.equal(row.value_type, 'domain');
    assert.equal(row.value, 'corp.example');
  } finally {
    db.close();
  }
});
