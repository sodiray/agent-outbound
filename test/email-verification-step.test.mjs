import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeStepBatch } from '../dist/orchestrator/pipeline/step-executor.js';
import { evaluateOutboundReadiness } from '../dist/orchestrator/policy/readiness.js';
import { evaluateReachability } from '../dist/orchestrator/policy/timing-reachability.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { normalizeConfig } from '../dist/schemas/config.js';
import { treasureValleyEnrichmentBudget } from './fixtures/treatment-strategy.mjs';

const listDir = () => mkdtempSync(join(tmpdir(), 'agent-outbound-email-verification-'));

const contactSourceStep = {
  kind: 'contact_source',
  id: 'published_email_contact',
  field: 'published_email',
  role: 'primary',
};

const verificationStep = (overrides = {}) => ({
  kind: 'enrich',
  id: 'verify_published_email',
  action: 'email_verification',
  provider: 'test-verifier',
  field: 'published_email',
  inputs: ['published_email'],
  unit_cost_usd: 0.05,
  ...overrides,
});

const fakeProvider = (verification) => {
  const calls = [];
  return {
    id: 'test-verifier',
    calls,
    verify: async ({ email }) => {
      calls.push(email);
      return verification;
    },
  };
};

const channelReadiness = (record) => Object.fromEntries(
  evaluateReachability(record).channels.map((channel) => [channel.channel, channel]),
);

const permittedChannels = (record) => evaluateOutboundReadiness({
  eligible: true,
  suppressed: false,
  identityConfidence: 100,
  materialContradiction: false,
  treatmentTier: 'A',
  channels: channelReadiness(record),
  contactPolicy: { tiers: { A: { permitted_channels: ['email'] } } },
  confidenceProfile: {
    identity_confidence: 100,
    classification_confidence: 100,
    fit_evidence_confidence: 100,
    buyer_confidence: 100,
    timing_confidence: 100,
    email_confidence: 100,
    phone_confidence: 0,
    linkedin_confidence: 0,
    mail_confidence: 0,
  },
}).permitted_channels;

const withDb = async (record, callback) => {
  const root = listDir();
  const db = openListDb({ listDir: root });
  ensureRecordColumns({ db, columns: Object.keys(record) });
  upsertRecord({
    db,
    row: {
      _row_id: 'email_verification_record',
      business_name: 'Acme',
      candidate_tier: 'A',
      ...record,
    },
  });
  try {
    return await callback({ db, root });
  } finally {
    db.close();
  }
};

const currentRecord = (db) => db.prepare('SELECT * FROM records WHERE _row_id = ?')
  .get('email_verification_record');

const execute = async ({ db, root, step, provider, config = {}, force = false }) => (
  await executeStepBatch(
    {
      db,
      listDir: root,
      config: { ai: {}, ...config },
      mcp: null,
      toolCatalog: null,
      emailVerificationProvider: provider,
      force,
    },
    step,
    step.id,
    [currentRecord(db)],
  )
).get('email_verification_record');

test('a declared generic verifier promotes a pipeline-supplied address into permitted email', async () => {
  const provider = fakeProvider({ status: 'valid', confidence: 96, reason: '' });
  const config = { pipeline: [contactSourceStep, verificationStep()] };

  assert.deepEqual(normalizeConfig(config).errors, []);
  await withDb({ published_email: 'owner@acme.example' }, async ({ db, root }) => {
    await execute({ db, root, step: contactSourceStep, provider });
    const supplied = db.prepare('SELECT * FROM contacts WHERE row_id = ?').get('email_verification_record');
    assert.equal(supplied.email_verification_status, 'pipeline_supplied');

    const outcome = await execute({ db, root, step: verificationStep(), provider });
    const contact = db.prepare('SELECT * FROM contacts WHERE row_id = ?').get('email_verification_record');
    const record = currentRecord(db);

    assert.equal(outcome.passed, true);
    assert.deepEqual(provider.calls, ['owner@acme.example']);
    assert.equal(contact.email_verification_status, 'valid');
    assert.equal(Number(contact.email_verification_confidence), 96);
    assert.equal(contact.email_verification_reason, '');
    assert.ok(contact.email_verified_at);
    assert.equal(record.email_verification_status, 'valid');
    assert.ok(permittedChannels(record).includes('email'));
  });
});

test('a checked negative is durable and distinct from an unchecked pipeline-supplied address', async () => {
  const provider = fakeProvider({
    status: 'invalid',
    confidence: 100,
    reason: 'mailbox_does_not_exist',
  });

  await withDb({ published_email: 'missing@acme.example' }, async ({ db, root }) => {
    await execute({ db, root, step: contactSourceStep, provider });
    await execute({ db, root, step: verificationStep(), provider });
    const contact = db.prepare('SELECT * FROM contacts WHERE row_id = ?').get('email_verification_record');
    const record = currentRecord(db);

    assert.equal(contact.email_verification_status, 'invalid');
    assert.equal(contact.email_verification_reason, 'mailbox_does_not_exist');
    assert.ok(contact.email_verified_at);
    assert.equal(record.email_verification_status, 'invalid');
    assert.equal(evaluateReachability(record).channels.find((channel) => channel.channel === 'email').ready, false);
    assert.ok(!permittedChannels(record).includes('email'));
  });
});

test('email verification honors the enrichment ceiling and never re-verifies a settled address', async () => {
  const provider = fakeProvider({ status: 'verified', confidence: 100, reason: '' });

  await withDb({ published_email: 'owner@acme.example' }, async ({ db, root }) => {
    await execute({ db, root, step: contactSourceStep, provider });
    await execute({ db, root, step: verificationStep(), provider });
    const settled = db.prepare('SELECT * FROM contacts WHERE row_id = ?').get('email_verification_record');
    assert.equal(settled.email_verification_status, 'verified');

    await execute({ db, root, step: contactSourceStep, provider });
    const repromoted = db.prepare('SELECT * FROM contacts WHERE row_id = ?').get('email_verification_record');
    assert.equal(repromoted.email_verification_status, 'verified');

    const repeated = await execute({ db, root, step: verificationStep(), provider, force: true });
    assert.equal(repeated.passed, true);
    assert.deepEqual(provider.calls, ['owner@acme.example']);
    assert.equal(db.prepare(`
      SELECT COALESCE(SUM(usd_cost), 0) AS total
      FROM cost_events
      WHERE record_id = ? AND step_id = ?
    `).get('email_verification_record', 'pipeline_enrich:verify_published_email').total, 0.05);
  });

  const blockedProvider = fakeProvider({ status: 'valid', confidence: 100, reason: '' });
  await withDb({
    published_email: 'owner@acme.example',
    candidate_tier: 'A',
    enrichment_cost_usd: 3,
    cost_ledger_json: JSON.stringify({
      account_id: 'email_verification_record',
      entries: [{ kind: 'enrichment', amount_usd: 3 }],
      enrichment_usd: 3,
      total_usd: 3,
    }),
  }, async ({ db, root }) => {
    await execute({ db, root, step: contactSourceStep, provider: blockedProvider });
    const outcome = await execute({
      db,
      root,
      step: verificationStep(),
      provider: blockedProvider,
      config: { score: { enrichment_budget: treasureValleyEnrichmentBudget } },
    });
    const contact = db.prepare('SELECT * FROM contacts WHERE row_id = ?').get('email_verification_record');

    assert.equal(outcome.passed, true);
    assert.match(outcome.reason, /^skipped:enrichment_ceiling/);
    assert.deepEqual(blockedProvider.calls, []);
    assert.equal(contact.email_verification_status, 'pipeline_supplied');
  });
});

test('the verification declaration accepts a provider identifier with no vendor-specific contract', () => {
  const result = normalizeConfig({
    pipeline: [verificationStep({ provider: 'in_house_verifier' })],
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.config.pipeline[0].provider, 'in_house_verifier');
});
