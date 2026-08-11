import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeStepBatch } from '../dist/orchestrator/pipeline/step-executor.js';
import { runPipelineDataflow } from '../dist/orchestrator/pipeline/dataflow.js';
import { evaluateSequenceReachability } from '../dist/orchestrator/policy/sequence-reachability.js';
import { denormalizedFieldsFromContact } from '../dist/orchestrator/policy/load-contacts.js';
import { ensureRecordColumns, openListDb, upsertContact, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { normalizeConfig } from '../dist/schemas/config.js';
import { resolveStepTemplate } from '../dist/orchestrator/lib/templates.js';

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

test('contact source projects declared name and title fields into template-ready contact fields', async () => {
  const step = contactSourceStep({ name_field: 'published_name', title_field: 'published_title' });
  assert.deepEqual(normalizeConfig({ pipeline: [step] }).errors, []);
  await withDb({
    published_email: 'admin@acme.example',
    published_name: 'Avery Example',
    published_title: 'Editor',
  }, async ({ db, root, record }) => {
    const outcome = await execute({ db, root, record, step });
    const contact = db.prepare('SELECT * FROM contacts WHERE row_id = ?').get('contact_source_record');
    const persisted = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('contact_source_record');
    const projected = denormalizedFieldsFromContact(contact);
    const rendered = resolveStepTemplate({
      config: {
        templates: {
          greeting: {
            versions: [{ version: 1, subject: 'Hello {{contact_first_name}}', body: '{{contact_title}}' }],
          },
        },
      },
      step: { template: 'greeting' },
      record: { ...persisted, ...projected },
    });

    assert.equal(outcome.passed, true);
    assert.equal(contact.email, 'admin@acme.example');
    assert.equal(contact.full_name, 'Avery Example');
    assert.equal(contact.title, 'Editor');
    assert.equal(contact.role, 'primary');
    assert.equal(contact.source, 'pipeline');
    assert.equal(contact.email_verification_status, 'pipeline_supplied');
    assert.equal(Number(contact.email_verification_confidence), 0);
    assert.equal(persisted.contact_email, 'admin@acme.example');
    assert.equal(projected.contact_first_name, 'Avery');
    assert.equal(rendered.subject, 'Hello Avery');
    assert.equal(rendered.body, 'Editor');
    assert.equal(evaluateSequenceReachability({ record: persisted, contacts: [contact] }).reachable, true);
  });
});

test('a blank declared name or title does not erase an existing pipeline contact value', async () => {
  const step = contactSourceStep({ name_field: 'published_name', title_field: 'published_title' });
  await withDb({
    published_email: 'admin@acme.example',
    published_name: 'Avery Example',
    published_title: 'Editor',
  }, async ({ db, root, record }) => {
    await execute({ db, root, record, step });
    const populated = db.prepare('SELECT * FROM contacts WHERE row_id = ?').get('contact_source_record');

    await execute({
      db,
      root,
      step,
      record: { ...record, published_name: ' ', published_title: '' },
    });
    const retained = db.prepare('SELECT * FROM contacts WHERE row_id = ?').get('contact_source_record');

    assert.equal(populated.full_name, 'Avery Example');
    assert.equal(populated.title, 'Editor');
    assert.equal(retained.full_name, 'Avery Example');
    assert.equal(retained.title, 'Editor');
  });
});

test('a contact source does not modify an existing non-pipeline contact', async () => {
  const step = contactSourceStep({ name_field: 'published_name', title_field: 'published_title' });
  await withDb({
    published_email: 'office@acme.example',
    published_name: 'Pipeline Name',
    published_title: 'Pipeline Title',
  }, async ({ db, root, record }) => {
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

    const outcome = await execute({ db, root, record, step });
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
      step,
      record: {
        ...persisted,
        published_email: 'pat@acme.example',
        published_name: 'Changed Name',
        published_title: 'Changed Title',
      },
    });
    const unchanged = db.prepare('SELECT * FROM contacts WHERE email = ?').get('pat@acme.example');
    assert.equal(overwriteAttempt.reason, 'contact_source_existing_contact');
    assert.equal(unchanged.source, 'apollo');
    assert.equal(unchanged.email_verification_status, 'verified');
    assert.equal(unchanged.full_name, 'Pat Owner');
    assert.equal(unchanged.title, 'Owner');
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

test('pipeline admission lets an unreachable record reach a contact source and re-enter', async () => {
  const root = listDir();
  writeFileSync(join(root, 'outbound.yaml'), `
list:
  name: Contact Source Recovery
pipeline:
  - kind: contact_source
    id: published_email_contact
    field: published_email
    role: secondary
sequences:
  default:
    steps: []
`);
  writeFileSync(join(root, 'operator.md'), 'test');
  const db = openListDb({ listDir: root });
  const now = new Date().toISOString();
  ensureRecordColumns({ db, columns: ['published_email', 'account_sequence_state', 'readiness_json'] });
  upsertRecord({
    db,
    row: {
      _row_id: 'unreachable_contact_source_record',
      business_name: 'Acme',
      published_email: 'admin@acme.example',
      sequence_status: 'unreachable',
      account_sequence_state: 'unreachable',
      readiness_json: JSON.stringify({ permitted_channels: ['email'] }),
      last_error: 'No reachable contact on a permitted channel.',
      created_at: now,
      updated_at: now,
    },
  });
  db.close();

  const summary = await runPipelineDataflow({ listDir: root });
  const checked = openListDb({ listDir: root, readonly: true });
  const record = checked.prepare('SELECT * FROM records WHERE _row_id = ?').get('unreachable_contact_source_record');
  const contact = checked.prepare('SELECT * FROM contacts WHERE row_id = ?').get('unreachable_contact_source_record');
  const event = checked.prepare(`
    SELECT * FROM pipeline_events
    WHERE record_id = ? AND step_id = ? AND passed = 1
  `).get('unreachable_contact_source_record', 'published_email_contact');

  assert.equal(summary.records_in, 1);
  assert.equal(contact.email, 'admin@acme.example');
  assert.equal(event.kind, 'contact_source');
  assert.equal(record.sequence_status, 'active');
  assert.equal(record.account_sequence_state, 'active');
  assert.equal(record.last_error, '');
  checked.close();
});
