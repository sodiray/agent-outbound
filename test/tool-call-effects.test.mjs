import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeToolCallAction } from '../dist/orchestrator/enrichment/actions/tool-call.js';
import { normalizeConfig } from '../dist/schemas/config.js';

const lookupTool = {
  server: 'test-provider',
  tools: ['ARBITRARY_LOOKUP'],
};

const listFor = (policy = {}) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-tool-effect-policy-'));
  writeFileSync(join(listDir, 'outbound.yaml'), JSON.stringify({ policy }));
  return listDir;
};

const execute = ({ listDir, effect, externalSend = false, onInvoke }) => executeToolCallAction({
  listDir,
  stepId: 'configured_contact',
  stepConfig: {
    tool: { ...lookupTool, ...(effect ? { effect } : {}) },
    external_send: externalSend,
    output_map: { value: 'value' },
    __tryTool: async () => {
      onInvoke?.();
      return { result: { value: 'retrieved' }, provider: 'test-provider' };
    },
  },
  record: {},
});

test('a pipeline-prohibited human-contact channel fails config validation and runtime before the tool runs', async () => {
  const config = {
    policy: { prohibited_channels: ['sms'] },
    pipeline: [{
      kind: 'enrich',
      id: 'configured_sms',
      action: 'tool_call',
      tool: { ...lookupTool, effect: { class: 'human_contact', channel: 'sms' } },
    }],
  };
  const normalized = normalizeConfig(config);
  assert.match(normalized.errors.join('\n'), /prohibited channel "sms"/i);

  let invoked = false;
  await assert.rejects(
    () => executeToolCallAction({
      listDir: listFor(config.policy),
      stepId: 'configured_sms',
      stepConfig: {
        tool: { ...lookupTool, effect: { class: 'human_contact', channel: 'sms' } },
        external_send: true,
        __tryTool: async () => {
          invoked = true;
          return { result: {}, provider: 'test-provider' };
        },
      },
      record: {},
    }),
    /prohibits channel "sms"/i,
  );
  assert.equal(invoked, false);
});

test('a pipeline declaring no prohibited channels may run an SMS human-contact tool', async () => {
  const configured = normalizeConfig({
    pipeline: [{
      kind: 'send_sms',
      id: 'sms_step',
      side_effecting: true,
      config: {
        action: 'tool_call',
        channel: 'sms',
        tool: { ...lookupTool, effect: { class: 'human_contact', channel: 'sms' } },
      },
    }],
  });
  assert.deepEqual(configured.errors, []);
  const result = await execute({
    listDir: listFor(),
    externalSend: true,
    effect: { class: 'human_contact', channel: 'sms' },
  });
  assert.equal(result.outputs.value, 'retrieved');
});

test('a pipeline cannot opt an individual step out of its prohibited channel', () => {
  const normalized = normalizeConfig({
    policy: { prohibited_channels: ['sms'] },
    pipeline: [{
      kind: 'send_sms',
      id: 'sms_step',
      side_effecting: true,
      config: {
        action: 'tool_call',
        channel: 'sms',
        opt_out_of_policy: true,
        tool: { ...lookupTool, effect: { class: 'human_contact', channel: 'sms' } },
      },
    }],
  });
  assert.ok(normalized.errors.length > 0);
  assert.match(normalized.errors.join('\n'), /opt_out_of_policy|unrecognized/i);
});

test('tool_call fails closed when its effect is undeclared or unrecognised', async () => {
  const listDir = listFor();
  const missingEffectInvocation = { called: false };
  await assert.rejects(
    () => execute({
      listDir,
      onInvoke: () => { missingEffectInvocation.called = true; },
    }),
    /effect.*required|undeclared/i,
  );
  assert.equal(missingEffectInvocation.called, false);
  const unrecognisedEffectInvocation = { called: false };
  await assert.rejects(
    () => execute({
      listDir,
      effect: { class: 'unclassified' },
      onInvoke: () => { unrecognisedEffectInvocation.called = true; },
    }),
    /unrecognised|unrecognized/i,
  );
  assert.equal(unrecognisedEffectInvocation.called, false);
});
