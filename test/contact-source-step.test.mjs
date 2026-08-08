import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeStepBatch } from '../dist/orchestrator/pipeline/step-executor.js';
import { evaluateSequenceReachability } from '../dist/orchestrator/policy/sequence-reachability.js';
import { ensureRecordColumns, openListDb, upsertContact, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { normalizeConfig } from '../dist/schemas/config.js';

const listDir = () => mkdtempSync(join(tmpdir(), 'agent-outbound-contact-source-'));

const contactSourceStep = (overrides = {}) => ({
  kind: 'contact_source',
  id: 'published_email_contact',
  field: 'published_email',
  role: 'primary',
  ...overrides,
});

const withDb = async (record, callback) => {
  const root = listDir();
  const db = openListDb({ listDir: root });
  ensureRecordColumns({ db, columns: Object.keys(record) });
  upsertRecord({ db, row: { _row_id: 'contact_source_record', business_name: 'Acme', ...record } });
  try {
    return await callback({
      db,
      root,
      record: db.prepare('SELECT * FROM records WHERE _row_id = ?').get('contact_source_record'),
    });
  } finally {
    db.close();
  }
};

const execute = async ({ db, root, record, step = contactSourceStep() }) => (
  await executeStepBatch(
    { db, listDir: root, config: { ai: {} }, mcp: null, toolCatalog: null },
    step,
    step.id,
    [record],
  )
).get('contact_source_record');

test('contact source creates a reachable pipeline-supplied contact from its declared field', async () => {
  assert.deepEqual(normalizeConfig({ pipeline: [contactSourceStep()] }).errors, []);
  await withDb({ published_email: 'admin@acme.example' }, async ({ db, root, record }) => {
    const outcome = await execute({ db, root, record });
    const contact = db.prepare('SELECT * FROM contacts WHERE row_id = ?').get('contact_source_record');
    const persisted = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('contact_source_record');

    assert.equal(outcome.passed, true);
    assert.equal(contact.email, 'admin@acme.example');
    assert.equal(contact.role, 'primary');
    assert.equal(contact.source, 'pipeline');
    assert.equal(contact.email_verification_status, 'pipeline_supplied');
    assert.equal(Number(contact.email_verification_confidence), 0);
    assert.equal(persisted.contact_email, 'admin@acme.example');
    assert.equal(evaluateSequenceReachability({ record: persisted, contacts: [contact] }).reachable, true);
  });
});

test('a provider-verified contact stays primary when a contact source supplies another address', async () => {
  await withDb({ published_email: 'office@acme.example' }, async ({ db, root, record }) => {
    upsertContact({
      db,
      contact: {
        record_id: 'contact_source_record',
        full_name: 'Pat Owner',
        title: 'Owner',
        email: 'pat@acme.example',
        source: 'apollo',
        confidence: 90,
        email_verification_status: 'verified',
        email_verification_confidence: 100,
      },
    });

    const outcome = await execute({ db, root, record });
    const contacts = db.prepare('SELECT * FROM contacts WHERE row_id = ? ORDER BY email').all('contact_source_record');
    const persisted = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('contact_source_record');
    const supplied = contacts.find((contact) => contact.email === 'office@acme.example');
    const verified = contacts.find((contact) => contact.email === 'pat@acme.example');

    assert.equal(outcome.passed, true);
    assert.equal(contacts.length, 2);
    assert.equal(verified.is_primary, 1);
    assert.equal(supplied.is_primary, 0);
    assert.equal(supplied.source, 'pipeline');
    assert.equal(persisted.contact_email, 'pat@acme.example');
    assert.equal(persisted.email_verification_status, 'verified');

    const overwriteAttempt = await execute({
      db,
      root,
      record: { ...persisted, published_email: 'pat@acme.example' },
    });
    const unchanged = db.prepare('SELECT * FROM contacts WHERE email = ?').get('pat@acme.example');
    assert.equal(overwriteAttempt.reason, 'contact_source_existing_contact');
    assert.equal(unchanged.source, 'apollo');
    assert.equal(unchanged.email_verification_status, 'verified');
  });
});

test('contact sources remain subject to suppression, DNE, and permitted-channel gates', async () => {
  const reachabilityFor = async (record) => withDb(record, async ({ db, root, record: persisted }) => {
    await execute({ db, root, record: persisted });
    const contact = db.prepare('SELECT * FROM contacts WHERE row_id = ?').get('contact_source_record');
    const current = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('contact_source_record');
    return evaluateSequenceReachability({ record: current, contacts: [contact] });
  });

  assert.equal((await reachabilityFor({ published_email: 'admin@acme.example', suppressed: 1 })).reachable, false);
  assert.equal((await reachabilityFor({ published_email: 'admin@acme.example', dne_email: 1 })).reachable, false);
  assert.equal((await reachabilityFor({
    published_email: 'admin@acme.example',
    readiness_json: JSON.stringify({ permitted_channels: [] }),
  })).reachable, false);
});

test('pipelines without a contact source still create no contacts', async () => {
  await withDb({ published_email: 'admin@acme.example' }, async ({ db }) => {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contacts').get().count, 0);
  });
});
