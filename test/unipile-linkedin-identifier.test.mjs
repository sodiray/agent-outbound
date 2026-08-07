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

test('Unipile resolves a LinkedIn public identifier and invites with its provider id', async () => {
  const capturedBodies = [];
  const requests = [];
  const result = await executeUnipileLinkedinConnect({
    record: { contact_linkedin_url: 'https://www.linkedin.com/in/starlineluxury?trk=public_profile' },
    env: {
      UNIPILE_API_KEY: 'test-key',
      UNIPILE_DSN: 'https://api.unipile.test',
      UNIPILE_ACCOUNT_ID: 'account-test',
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), method: init?.method });
      if (init?.method === 'GET') {
        return {
          status: 200,
          statusText: 'OK',
          json: async () => ({ provider_id: 'ACoAAAYbBGYBLbhN6JA2KC' }),
        };
      }
      capturedBodies.push(JSON.parse(String(init?.body)));
      return {
        status: 201,
        statusText: 'Created',
        json: async () => ({ id: 'invite-1' }),
      };
    },
  });

  assert.equal(capturedBodies.length, 1);
  assert.deepEqual(requests, [
    {
      url: 'https://api.unipile.test/api/v1/users/starlineluxury?account_id=account-test',
      method: 'GET',
    },
    {
      url: 'https://api.unipile.test/api/v1/users/invite?account_id=account-test',
      method: 'POST',
    },
  ]);
  assert.equal(capturedBodies[0].provider_id, 'ACoAAAYbBGYBLbhN6JA2KC');
  assert.equal(capturedBodies[0].provider_public_id, undefined);
  assert.equal(result.status, 'sent');
  assert.equal(result.target_provider_id, 'ACoAAAYbBGYBLbhN6JA2KC');
});

test('Unipile fails closed when the resolved user has no provider id', async () => {
  const fetchCalls = [];
  const result = await executeUnipileLinkedinConnect({
    record: { contact_linkedin_url: 'https://www.linkedin.com/in/starlineluxury' },
    env: { UNIPILE_API_KEY: 'test-key', UNIPILE_DSN: 'https://api.unipile.test' },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url: String(url), method: init?.method });
      return {
        status: 200,
        statusText: 'OK',
        json: async () => ({ public_identifier: 'starlineluxury' }),
      };
    },
  });

  assert.equal(result.status, 'failed');
  assert.match(result.reason, /^unipile_user_lookup_missing_provider_id:/);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].method, 'GET');
});

test('Unipile fails closed when the user lookup returns an HTTP error', async () => {
  const fetchCalls = [];
  const result = await executeUnipileLinkedinConnect({
    record: { contact_linkedin_url: 'https://www.linkedin.com/in/starlineluxury' },
    env: { UNIPILE_API_KEY: 'test-key', UNIPILE_DSN: 'https://api.unipile.test' },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url: String(url), method: init?.method });
      return {
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ detail: 'user unavailable' }),
      };
    },
  });

  assert.equal(result.status, 'failed');
  assert.match(result.reason, /^unipile_user_lookup_http_404:/);
  assert.match(result.reason, /user unavailable/);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].method, 'GET');
});

test('Unipile reuses a provider id cached for the same public identifier', async () => {
  const fetchCalls = [];
  const result = await executeUnipileLinkedinConnect({
    record: {
      contact_linkedin_url: 'https://www.linkedin.com/in/starlineluxury',
      linkedin_provider_id: 'ACoAAAYbBGYBLbhN6JA2KC',
      linkedin_provider_public_id: 'starlineluxury',
    },
    env: { UNIPILE_API_KEY: 'test-key', UNIPILE_DSN: 'https://api.unipile.test' },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url: String(url), method: init?.method, body: init?.body });
      return {
        status: 201,
        statusText: 'Created',
        json: async () => ({ id: 'invite-2' }),
      };
    },
  });

  assert.equal(result.status, 'sent');
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].method, 'POST');
  assert.equal(JSON.parse(String(fetchCalls[0].body)).provider_id, 'ACoAAAYbBGYBLbhN6JA2KC');
});

test('Unipile includes provider error detail in the invitation failure reason', async () => {
  const result = await executeUnipileLinkedinConnect({
    record: {
      contact_linkedin_url: 'https://www.linkedin.com/in/starlineluxury',
      linkedin_provider_id: 'ACoAAAYbBGYBLbhN6JA2KC',
      linkedin_provider_public_id: 'starlineluxury',
    },
    env: { UNIPILE_API_KEY: 'test-key', UNIPILE_DSN: 'https://api.unipile.test' },
    fetchImpl: async () => ({
      status: 422,
      statusText: 'Unprocessable Content',
      json: async () => ({ detail: 'provider_id is invalid' }),
    }),
  });

  assert.equal(result.status, 'failed');
  assert.match(result.reason, /^unipile_live_http_422:/);
  assert.match(result.reason, /provider_id is invalid/);
});
