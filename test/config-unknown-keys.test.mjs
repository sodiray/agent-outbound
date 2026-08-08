import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readConfig } from '../dist/orchestrator/lib/config.js';
import { normalizeConfig } from '../dist/schemas/config.js';

test('a misspelled policy safeguard is refused with its complete path and a correction', () => {
  const result = normalizeConfig({
    policy: {
      forbidden_channels: ['sms'],
    },
  });

  assert.ok(result.errors.some((error) => error.includes('policy.forbidden_channels')));
  assert.ok(result.errors.some((error) => error.includes('policy.prohibited_channels')));
  assert.equal(result.config.policy.forbidden_channels, undefined);
});

test('readConfig carries policy unknown-key errors to config validation callers', () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-config-unknown-key-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `policy:\n  forbidden_channels:\n    - sms\n`);

  const loaded = readConfig(listDir);

  assert.ok(loaded.errors.some((error) => error.includes('policy.forbidden_channels')));
});

test('correct policy configuration validates cleanly', () => {
  const result = normalizeConfig({
    policy: {
      prohibited_channels: ['sms'],
      enforce_readiness: true,
    },
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('a misspelled contact-policy restriction is also refused', () => {
  const result = normalizeConfig({
    contact_policy: {
      per_contact_allowence: { A: 1 },
    },
  });

  assert.ok(result.errors.some((error) => error.includes('contact_policy.per_contact_allowence')));
  assert.ok(result.errors.some((error) => error.includes('contact_policy.per_contact_allowances')));
});

test('explicit extension surfaces preserve extra provider and channel fields', () => {
  const result = normalizeConfig({
    channels: {
      provider_extension: { delivery_mode: 'future' },
    },
    source: {
      searches: [{
        tool: { provider_extension: 'supported' },
      }],
    },
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.config.channels.provider_extension.delivery_mode, 'future');
  assert.equal(result.config.source.searches[0].tool.provider_extension, 'supported');
});
