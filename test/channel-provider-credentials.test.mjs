import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  resolveChannelProviderCredentials,
} from '../dist/orchestrator/lib/channel-credentials.js';
import {
  executeUnipileLinkedinConnect,
} from '../dist/orchestrator/channels/unipile.js';

const requiredKeys = ['UNIPILE_API_KEY', 'UNIPILE_DSN'];

const createPipeline = ({ name, credentials }) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-channel-credentials-'));
  mkdirSync(join(listDir, 'credentials'));
  return {
    listDir,
    config: {
      list: { name },
      channels: {
        linkedin: {
          provider: 'unipile',
          credentials,
        },
      },
    },
  };
};

const resolve = ({ listDir, config }) => resolveChannelProviderCredentials({
  listDir,
  config,
  channel: 'linkedin',
  provider: 'unipile',
  requiredKeys,
});

test('pipeline channel credentials resolve relative to the pipeline and are used by Unipile', async () => {
  const pipeline = createPipeline({
    name: 'Relative Credentials',
    credentials: './credentials/unipile.env',
  });
  writeFileSync(
    join(pipeline.listDir, 'credentials', 'unipile.env'),
    'UNIPILE_API_KEY=pipeline-key\nUNIPILE_DSN=https://pipeline.unipile.test\n',
  );

  const resolved = resolve(pipeline);
  assert.equal(resolved.ready, true);
  assert.equal(resolved.source, 'path');
  assert.equal(resolved.path, join(pipeline.listDir, 'credentials', 'unipile.env'));
  const sent = await executeUnipileLinkedinConnect({
    record: { _row_id: 'relative-credentials', linkedin_url: 'https://www.linkedin.com/in/relative' },
    env: resolved.credentials,
    fetchImpl: async (_url, request) => {
      assert.equal(request.headers['X-API-KEY'], 'pipeline-key');
      if (request.method === 'GET') {
        return {
          status: 200,
          statusText: 'OK',
          json: async () => ({ provider_id: 'target-relative' }),
        };
      }
      return {
        status: 200,
        statusText: 'OK',
        json: async () => ({ id: 'invite-relative' }),
      };
    },
  });
  assert.equal(sent.status, 'sent');
});

test('each pipeline resolves only its own channel credentials', () => {
  const first = createPipeline({ name: 'First Pipeline', credentials: './credentials/provider.env' });
  const second = createPipeline({ name: 'Second Pipeline', credentials: './credentials/provider.env' });
  writeFileSync(join(first.listDir, 'credentials', 'provider.env'), 'UNIPILE_API_KEY=first-key\nUNIPILE_DSN=https://first.test\n');
  writeFileSync(join(second.listDir, 'credentials', 'provider.env'), 'UNIPILE_API_KEY=second-key\nUNIPILE_DSN=https://second.test\n');

  const firstResolved = resolve(first);
  const secondResolved = resolve(second);
  assert.equal(firstResolved.ready, true);
  assert.equal(secondResolved.ready, true);
  assert.equal(firstResolved.credentials.UNIPILE_API_KEY, 'first-key');
  assert.equal(secondResolved.credentials.UNIPILE_API_KEY, 'second-key');
  assert.notEqual(firstResolved.credentials.UNIPILE_DSN, secondResolved.credentials.UNIPILE_DSN);
});

test('unresolvable configured channel credentials fail before provider networking with named missing keys', () => {
  const pipeline = createPipeline({
    name: 'Missing Credentials Pipeline',
    credentials: './credentials/does-not-exist.env',
  });

  const resolved = resolve(pipeline);
  assert.equal(resolved.ready, false);
  assert.match(resolved.reason, /Missing Credentials Pipeline/);
  assert.match(resolved.reason, /provider "unipile"/);
  assert.match(resolved.reason, /UNIPILE_API_KEY.*UNIPILE_DSN/);
  assert.match(resolved.reason, /credentials file not found/);
  assert.doesNotMatch(resolved.reason, /network|fetch/i);
});

test('channel credential diagnostics never include secret values', () => {
  const secretValue = 'do-not-disclose-channel-secret';
  const pipeline = createPipeline({
    name: 'Redaction Pipeline',
    credentials: {
      UNIPILE_API_KEY: secretValue,
    },
  });

  const resolved = resolve(pipeline);
  assert.equal(resolved.ready, false);
  assert.match(resolved.reason, /UNIPILE_DSN/);
  assert.doesNotMatch(resolved.reason, new RegExp(secretValue));
  assert.doesNotMatch(JSON.stringify({ reason: resolved.reason, missingKeys: resolved.missingKeys }), new RegExp(secretValue));
});
