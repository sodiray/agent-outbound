import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { extractFromRecord } from '../dist/orchestrator/extract/runner.js';
import { executeStepBatch } from '../dist/orchestrator/pipeline/step-executor.js';
import { normalizeConfig } from '../dist/schemas/config.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';

const listDir = () => mkdtempSync(join(tmpdir(), 'agent-outbound-extract-step-'));

const step = ({
  from = 'site_text',
  select = 'first',
  outputs = { site_published_email: { type: 'string', description: 'Published business email.' } },
  exclude = [],
} = {}) => ({
  kind: 'extract',
  id: 'site_email_extract',
  depends_on: ['site_scrape'],
  from,
  using: 'email',
  select,
  exclude,
  outputs,
});

const withDb = async (record, callback) => {
  const root = listDir();
  const db = openListDb({ listDir: root });
  ensureRecordColumns({ db, columns: Object.keys(record) });
  upsertRecord({ db, row: { _row_id: 'extract_record', business_name: 'Acme', ...record } });
  if (record.contact_email) {
    db.prepare('UPDATE records SET contact_email = ? WHERE _row_id = ?').run(record.contact_email, 'extract_record');
  }
  try {
    return await callback({ db, listDir: root, record: db.prepare('SELECT * FROM records WHERE _row_id = ?').get('extract_record') });
  } finally {
    db.close();
  }
};

const execute = async ({ db, root, configuredStep, record }) => (await executeStepBatch(
  { db, listDir: root, config: { ai: {} }, mcp: null, toolCatalog: null },
  configuredStep,
  configuredStep.id,
  [record],
)).get('extract_record');

test('extract accepts a typed, model-free email configuration', () => {
  const siteScrape = {
    kind: 'enrich',
    id: 'site_scrape',
    outputs: { site_text: { type: 'string', description: 'Scraped site text.' } },
  };
  const config = normalizeConfig({ pipeline: [siteScrape, step()] });
  assert.deepEqual(config.errors, []);
  assert.deepEqual(normalizeConfig({
    pipeline: [siteScrape, step({
      from: ['preferred_text', 'site_text'],
      select: 'all',
      outputs: { site_published_emails: { type: 'string[]', description: 'All published email addresses.' } },
    })],
  }).errors, []);
  const invalid = normalizeConfig({ pipeline: [siteScrape, step({ select: 'all' })] });
  assert.ok(invalid.errors.some((error) => error.includes('must have type "string[]"')));
});

test('extract finds direct and mailto email addresses in messy markdown and HTML', async () => {
  await withDb({
    domain: 'acme.com',
    site_text: '<a href="mailto:sales@acme.com?subject=hello">Email us</a> · **team@acme.com** (open daily).',
  }, async ({ db, listDir: root, record }) => {
    const outcome = await execute({ db, root, configuredStep: step(), record });
    const persisted = db.prepare('SELECT site_published_email FROM records WHERE _row_id = ?').get('extract_record');
    assert.equal(outcome.passed, true);
    assert.equal(outcome.reason, 'extracted:email:2:site_text');
    assert.equal(persisted.site_published_email, 'sales@acme.com');
  });
});

test('extract rejects asset filenames and default vendor or placeholder email domains', async () => {
  await withDb({
    site_text: 'logo@2x.png errors@sentry.io forms@wixpress.com site@squarespace.com support@godaddy.com hi@example.com hidden@custom.invalid contact@realbusiness.com',
  }, async ({ db, listDir: root, record }) => {
    const outcome = await execute({ db, root, configuredStep: step({ exclude: ['custom.invalid'] }), record });
    const persisted = db.prepare('SELECT site_published_email FROM records WHERE _row_id = ?').get('extract_record');
    assert.equal(outcome.reason, 'extracted:email:1:site_text');
    assert.equal(persisted.site_published_email, 'contact@realbusiness.com');
  });
});

test('extract ranks an own-domain address ahead of a free-mail address without penalizing role inboxes', async () => {
  await withDb({
    domain: 'acme.com',
    site_text: 'Founder: jane.acme@gmail.com. For service, email support@acme.com.',
  }, async ({ db, listDir: root, record }) => {
    await execute({ db, root, configuredStep: step(), record });
    const persisted = db.prepare('SELECT site_published_email FROM records WHERE _row_id = ?').get('extract_record');
    assert.equal(persisted.site_published_email, 'support@acme.com');
  });
});

test('extract reports no match and writes an empty value without fabricating an obfuscated address', async () => {
  await withDb({
    site_text: 'Reach us at name [at] acme [dot] com, or download logo@2x.png.',
  }, async ({ db, listDir: root, record }) => {
    const outcome = await execute({ db, root, configuredStep: step(), record });
    const persisted = db.prepare('SELECT site_published_email FROM records WHERE _row_id = ?').get('extract_record');
    assert.equal(outcome.passed, true);
    assert.equal(outcome.reason, 'extracted:email:0');
    assert.equal(persisted.site_published_email, '');
  });
});

test('extract select all stores a stable, case-insensitively deduplicated list', async () => {
  const configuredStep = step({
    select: 'all',
    outputs: { site_published_emails: { type: 'string[]', description: 'All published email addresses.' } },
  });
  await withDb({
    domain: 'acme.com',
    site_text: 'jane@gmail.com support@acme.com SALES@ACME.COM sales@acme.com billing@vendor.co',
  }, async ({ db, listDir: root, record }) => {
    const outcome = await execute({ db, root, configuredStep, record });
    const persisted = db.prepare('SELECT site_published_emails FROM records WHERE _row_id = ?').get('extract_record');
    assert.equal(outcome.reason, 'extracted:email:4:site_text');
    assert.deepEqual(JSON.parse(persisted.site_published_emails), [
      'support@acme.com',
      'SALES@ACME.COM',
      'billing@vendor.co',
      'jane@gmail.com',
    ]);
  });
});

test('extract cannot write a protected primary-contact projection column', async () => {
  await withDb({
    contact_email: 'verified.person@acme.com',
    site_text: 'Website mailbox: office@acme.com',
  }, async ({ db, listDir: root, record }) => {
    const protectedStep = step({
      outputs: { contact_email: { type: 'string', description: 'Attempted website email.' } },
    });
    const outcome = await execute({ db, root, configuredStep: protectedStep, record });
    const persisted = db.prepare('SELECT contact_email FROM records WHERE _row_id = ?').get('extract_record');
    assert.equal(persisted.contact_email, 'verified.person@acme.com');
    assert.equal(outcome.errored, true);
    assert.match(outcome.reason, /^declared_outputs_unwritten:contact_email$/);
  });
});

test('extract is deterministic for identical input', () => {
  const configuredStep = step({ select: 'all', outputs: { all: { type: 'string[]', description: 'All matches.' } } });
  const record = { domain: 'acme.com', site_text: 'a@gmail.com help@acme.com billing@vendor.co' };
  assert.deepEqual(
    extractFromRecord({ step: configuredStep, record }),
    extractFromRecord({ step: configuredStep, record }),
  );
});

test('extract supports ordered source fallback plus phone and URL built-ins', () => {
  const record = { site_text: 'Call (208) 555-0199 or visit https://acme.com/contact).' };
  assert.deepEqual(extractFromRecord({
    step: step({ from: ['missing_text', 'site_text'] }),
    record: { ...record, site_text: 'fallback@acme.com' },
  }), {
    value: 'fallback@acme.com',
    matches: ['fallback@acme.com'],
    sourceField: 'site_text',
  });
  assert.equal(extractFromRecord({
    step: { ...step(), using: 'phone' },
    record,
  }).value, '(208) 555-0199');
  assert.equal(extractFromRecord({
    step: { ...step(), using: 'url' },
    record,
  }).value, 'https://acme.com/contact');
});
