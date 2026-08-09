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

test('unknown keys in every safety-bearing block are errors with their complete paths', () => {
  const cases = [
    { path: 'policy.forbidden_channels', config: { policy: { forbidden_channels: ['sms'] } } },
    { path: 'contact_policy.per_contact_allowence', config: { contact_policy: { per_contact_allowence: { A: 1 } } } },
    { path: 'suppression.global_lsit', config: { suppression: { global_lsit: 'do-not-contact' } } },
    {
      path: 'live_interaction_budget.max_interacionz',
      config: {
        live_interaction_budget: {
          max_accounts: 1,
          max_interactions: 1,
          max_interacionz: 0,
        },
      },
    },
    { path: 'budgets.llm.dailyy', config: { budgets: { llm: { dailyy: 1 } } } },
    { path: 'score.treatmen', config: { score: { treatmen: {} } } },
    {
      path: 'sequences.default.reply_chek',
      config: { sequences: { default: { reply_chek: {} } } },
    },
  ];

  for (const entry of cases) {
    const result = normalizeConfig(entry.config);
    assert.ok(
      result.errors.some((error) => error.includes(entry.path)),
      `expected an error for ${entry.path}: ${JSON.stringify(result)}`,
    );
  }
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

test('a pipeline cannot declare an identity or threading email header', () => {
  const result = normalizeConfig({
    pipeline: [{
      kind: 'send_email',
      id: 'email_1',
      side_effecting: true,
      inputs: [],
      config: {
        headers: {
          From: 'forged@example.test',
        },
      },
    }],
  });

  assert.ok(result.errors.some((error) => error.includes('From cannot be declared')));
});

test('a pipeline email header must declare each interpolated record input', () => {
  const step = {
    kind: 'send_email',
    id: 'email_1',
    side_effecting: true,
    config: {
      headers: {
        'List-Unsubscribe': '<mailto:unsubscribe@example.test?subject=unsubscribe-{_row_id}>',
      },
    },
  };
  const declared = normalizeConfig({
    pipeline: [{ ...step, inputs: ['_row_id'] }],
  });
  const undeclared = normalizeConfig({
    pipeline: [{ ...step, inputs: [] }],
  });

  assert.deepEqual(declared.errors, []);
  assert.ok(undeclared.errors.some((error) => (
    error.includes('pipeline.email_1 (send_email) reads undeclared input fields: "_row_id" (headers template).')
  )));
});

test('a top-level enrichment budget block is an error instead of a discarded warning', () => {
  const result = normalizeConfig({
    enrichment_budget: {
      ceilings: { tiers: { A: 3 } },
    },
  });

  assert.ok(result.errors.some((error) => error.includes('enrichment_budget')));
  assert.equal(result.config.score.enrichment_budget, undefined);
});
