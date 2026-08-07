import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  persistSupportedDecisionMakerCandidates,
} from '../dist/orchestrator/enrichment/actions/decision-makers.js';
import { verifyHunterEmail } from '../dist/orchestrator/runtime/providers/decision-makers/hunter.js';
import { openListDb } from '../dist/orchestrator/runtime/db.js';
import { denormalizedFieldsFromContact } from '../dist/orchestrator/policy/load-contacts.js';
import { evaluateReachability } from '../dist/orchestrator/policy/timing-reachability.js';

const createListDb = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-decision-email-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
list:
  name: Decision Email Safety
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
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, 'Safety HVAC', 'default', 'active', ?, ?, ?, ?)
  `).run('decision_email_1', now, now, now, now);
  return { db, now };
};

const candidate = (email, confidence = 98) => ({
  first_name: 'Tyeson',
  last_name: 'Anderson',
  name: 'Tyeson Anderson',
  title: 'Owner',
  email,
  phone: '',
  seniority: 'executive',
  department: 'executive',
  linkedin: '',
  confidence,
  source_domain: 'rightnowheatcool.com',
  source_organization: 'Right Now Heating',
  source: 'hunter',
  source_query: 'rightnowheatcool.com',
});

test('decision makers: persistence rejects a model-supplied email absent from the raw provider payload and keeps literal support', async () => {
  const { db, now } = createListDb();
  const literalEmail = 'tyeson.anderson@rightnowheatcool.com';
  const persisted = await persistSupportedDecisionMakerCandidates({
    db,
    recordId: 'decision_email_1',
    candidates: [candidate('customercare@rightnowheatcool.com'), candidate(literalEmail, 76)],
    providerPayloads: [{
      data: {
        emails: [{ value: literalEmail, first_name: 'Tyeson', last_name: 'Anderson' }],
      },
    }],
    sourcedAt: now,
    emailVerifier: async () => ({
      status: 'valid',
      confidence: 91,
      smtp_check: true,
      disposable: false,
    }),
  });

  assert.deepEqual(persisted.map((item) => item.email), [literalEmail]);
  const contacts = db.prepare('SELECT * FROM contacts WHERE row_id = ?').all('decision_email_1');
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].email, literalEmail);
  assert.equal(Number(contacts[0].confidence), 76);
  assert.equal(contacts[0].email_verification_status, 'valid');
  assert.equal(Number(contacts[0].email_verification_confidence), 91);

  const projected = denormalizedFieldsFromContact(contacts[0]);
  assert.equal(projected.email_verification_status, 'valid');
  assert.equal(projected.email_verification_confidence, '91');
  const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('decision_email_1');
  assert.equal(record.email_verification_status, 'valid');
  assert.equal(Number(record.email_verification_confidence), 91);
  const email = evaluateReachability(record).channels.find((channel) => channel.channel === 'email');
  assert.equal(email.ready, true);
  assert.equal(email.confidence, 91);
  db.close();
});

test('Hunter verifier persists provider status and score without exposing its API key', async () => {
  const requests = [];
  const verification = await verifyHunterEmail({
    email: 'owner@example.test',
    apiKey: 'test-key-not-a-secret',
    fetchImpl: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({
        data: {
          status: 'valid',
          score: 100,
          smtp_check: true,
          disposable: false,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.deepEqual(verification, {
    status: 'valid',
    confidence: 100,
    smtp_check: true,
    disposable: false,
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0], /^https:\/\/api\.hunter\.io\/v2\/email-verifier\?/);
  assert.match(requests[0], /email=owner%40example\.test/);
});

test('email reachability: discovery confidence cannot ready an unverified or invalid address', () => {
  const unverified = evaluateReachability({
    contact_email: 'owner@example.test',
    email_confidence: 98,
  }).channels.find((channel) => channel.channel === 'email');
  assert.equal(unverified.ready, false);
  assert.equal(unverified.reason, 'verification_missing');

  const invalid = evaluateReachability({
    contact_email: 'owner@example.test',
    email_verification_status: 'invalid',
    email_verification_confidence: 100,
  }).channels.find((channel) => channel.channel === 'email');
  assert.equal(invalid.ready, false);
  assert.equal(invalid.reason, 'invalid_verification');

  const acceptAll = evaluateReachability({
    contact_email: 'owner@example.test',
    email_validated: true,
    email_verification_status: 'accept_all',
    email_verification_confidence: 100,
  }).channels.find((channel) => channel.channel === 'email');
  assert.equal(acceptAll.ready, false);
  assert.equal(acceptAll.reason, 'verification_accept_all');
});
