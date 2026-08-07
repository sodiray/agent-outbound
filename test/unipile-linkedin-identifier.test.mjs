import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeUnipileLinkedinConnect,
  parseLinkedinPublicIdentifier,
} from '../dist/orchestrator/channels/unipile.js';

test('Unipile LinkedIn profile URL forms resolve to the public identifier', () => {
  const references = [
    'https://www.linkedin.com/in/starlineluxury',
    'http://www.linkedin.com/in/starlineluxury',
    'https://linkedin.com/in/starlineluxury',
    'https://uk.linkedin.com/in/starlineluxury',
    'https://www.linkedin.com/in/starlineluxury/',
    'https://www.linkedin.com/in/starlineluxury?trk=public_profile',
  ];

  for (const reference of references) {
    assert.equal(parseLinkedinPublicIdentifier(reference), 'starlineluxury');
  }
});

test('Unipile preserves a bare LinkedIn public identifier', () => {
  assert.equal(parseLinkedinPublicIdentifier('starlineluxury'), 'starlineluxury');
});

test('Unipile refuses an unrecognised LinkedIn reference before sending an invite', async () => {
  const fetchCalls = [];
  const result = await executeUnipileLinkedinConnect({
    record: { contact_linkedin_url: 'https://www.linkedin.com/company/starline-luxury' },
    env: { UNIPILE_API_KEY: 'test-key', UNIPILE_DSN: 'https://api.unipile.test' },
    fetchImpl: async (...args) => {
      fetchCalls.push(args);
      throw new Error('fetch must not be called for an invalid LinkedIn reference');
    },
  });

  assert.equal(result.status, 'failed');
  assert.match(result.reason, /field contact_linkedin_url/);
  assert.match(result.reason, /LinkedIn non-profile URL/);
  assert.equal(fetchCalls.length, 0);
});

test('Unipile includes provider error detail in the invitation failure reason', async () => {
  const capturedBodies = [];
  const result = await executeUnipileLinkedinConnect({
    record: { contact_linkedin_url: 'https://www.linkedin.com/in/starlineluxury?trk=public_profile' },
    env: { UNIPILE_API_KEY: 'test-key', UNIPILE_DSN: 'https://api.unipile.test' },
    fetchImpl: async (_url, init) => {
      capturedBodies.push(JSON.parse(String(init?.body)));
      return {
        status: 422,
        statusText: 'Unprocessable Content',
        json: async () => ({ detail: 'provider_public_id must be a public identifier' }),
      };
    },
  });

  assert.equal(capturedBodies.length, 1);
  assert.equal(capturedBodies[0].provider_public_id, 'starlineluxury');
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /^unipile_live_http_422:/);
  assert.match(result.reason, /provider_public_id must be a public identifier/);
});
