import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeToolCallAction } from '../dist/orchestrator/enrichment/actions/tool-call.js';
import { guardChannelExecution } from '../dist/orchestrator/policy/apply-record.js';
import { normalizeConfig } from '../dist/schemas/config.js';

const lookupTool = {
  server: 'fixture-provider',
  tools: ['CONTACT'],
};

const smsToolStep = {
  kind: 'enrich',
  id: 'contact_by_sms',
  action: 'tool_call',
  tool: {
    ...lookupTool,
    effect: { class: 'human_contact', channel: 'sms' },
  },
};

const configFor = (policy = {}) => ({
  policy,
  pipeline: [{
    kind: 'send_sms',
    id: 'sms_follow_up',
    side_effecting: true,
    config: {
      action: 'tool_call',
      tool: {
        ...lookupTool,
        effect: { class: 'human_contact', channel: 'sms' },
      },
      idempotency: { key_source: ['_row_id'], scope: 'list' },
    },
  }, smsToolStep],
});

const listWithConfig = (config) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-pipeline-prohibitions-'));
  writeFileSync(join(listDir, 'outbound.yaml'), JSON.stringify(config));
  return listDir;
};

test('a declared prohibited SMS channel fails configuration validation and runtime execution', async () => {
  const config = configFor({ prohibited_channels: ['sms'] });
  const normalized = normalizeConfig(config);
  assert.ok(normalized.errors.some((error) => /prohibited channel "sms"/i.test(error)));

  const guard = guardChannelExecution({
    config: normalized.config,
    record: {},
    stepKind: 'send_sms',
    channel: 'sms',
    intent: 'send',
  });
  assert.equal(guard.allowed, false);
  assert.match(String(guard.reason), /prohibits channel "sms"/i);

  let invoked = false;
  await assert.rejects(
    () => executeToolCallAction({
      listDir: listWithConfig(config),
      stepId: 'contact_by_sms',
      stepConfig: { ...smsToolStep, external_send: true },
      record: {},
      toolCatalog: null,
      mcp: null,
      env: {},
      __tryTool: async () => {
        invoked = true;
        return { result: { accepted: true }, provider: 'fixture-provider' };
      },
    }),
    /prohibits channel "sms"/i,
  );
  assert.equal(invoked, false);
});

test('a pipeline declaring nothing may configure and execute an SMS tool step', async () => {
  const config = configFor();
  const normalized = normalizeConfig(config);
  assert.deepEqual(normalized.errors, []);
  assert.equal(guardChannelExecution({
    config: normalized.config,
    record: {},
    stepKind: 'send_sms',
    channel: 'sms',
    intent: 'send',
  }).allowed, true);

  let invoked = false;
  const result = await executeToolCallAction({
    listDir: listWithConfig(config),
    stepId: 'contact_by_sms',
    stepConfig: {
      ...smsToolStep,
      external_send: true,
      __tryTool: async () => {
        invoked = true;
        return { result: { accepted: true }, provider: 'fixture-provider' };
      },
    },
    record: {},
  });
  assert.equal(invoked, true);
  assert.deepEqual(result.outputs, {});
});

test('a prohibited human-contact tool effect is rejected during config validation', () => {
  const normalized = normalizeConfig({
    policy: { prohibited_channels: ['sms'] },
    pipeline: [smsToolStep],
  });
  assert.ok(normalized.errors.some((error) => /contact_by_sms.*prohibited channel "sms"/i.test(error)));
});

test('a step cannot opt out of a pipeline prohibition', () => {
  const normalized = normalizeConfig({
    policy: { prohibited_channels: ['sms'] },
    pipeline: [{
      kind: 'send_sms',
      id: 'claimed_exception',
      side_effecting: true,
      policy: { prohibited_channels: [] },
      config: {
        action: 'tool_call',
        tool: {
          ...lookupTool,
          effect: { class: 'human_contact', channel: 'sms' },
        },
        idempotency: { key_source: ['_row_id'], scope: 'list' },
      },
    }],
  });
  assert.ok(normalized.errors.some((error) => /prohibited channel "sms"/i.test(error)));
});
