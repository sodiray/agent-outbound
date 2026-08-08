import assert from 'node:assert/strict';
import test from 'node:test';

import { executeToolCallAction } from '../dist/orchestrator/enrichment/actions/tool-call.js';
import { normalizeConfig } from '../dist/schemas/config.js';

const lookupTool = {
  server: 'test-provider',
  tools: ['ARBITRARY_LOOKUP'],
};

const execute = (effect) => executeToolCallAction({
  listDir: '/tmp',
  stepId: 'benign_label',
  stepConfig: {
    tool: { ...lookupTool, ...(effect ? { effect } : {}) },
    output_map: { value: 'value' },
    __tryTool: async () => ({ result: { value: 'retrieved' }, provider: 'test-provider' }),
  },
  record: {},
});

test('tool_call refuses a prohibited human-contact channel before invoking the tool', async () => {
  let invoked = false;
  await assert.rejects(
    () => executeToolCallAction({
      listDir: '/tmp',
      stepId: 'innocuous_enrichment',
      stepConfig: {
        tool: {
          ...lookupTool,
          effect: { class: 'human_contact', channel: 'sms' },
        },
        __tryTool: async () => {
          invoked = true;
          return { result: {}, provider: 'test-provider' };
        },
      },
      record: {},
    }),
    /forbidden channel|outbound tool/i,
  );
  assert.equal(invoked, false);
});

test('tool_call fails closed when the tool effect is undeclared or unrecognised', async () => {
  await assert.rejects(() => execute(), /effect.*required|undeclared/i);
  await assert.rejects(() => execute({ class: 'unclassified' }), /unrecognised|unrecognized/i);
});

test('tool_call continues to execute declared enrichment tools', async () => {
  const result = await execute({ class: 'data_lookup' });
  assert.equal(result.outputs.value, 'retrieved');
});

test('a configuration cannot opt into a prohibited channel through a human-contact effect', async () => {
  const normalized = normalizeConfig({
    pipeline: [{
      kind: 'enrich',
      id: 'configured_sms',
      action: 'tool_call',
      tool: {
        ...lookupTool,
        effect: { class: 'human_contact', channel: 'automated_voice' },
      },
    }],
  });
  assert.deepEqual(normalized.errors, []);
  await assert.rejects(
    () => executeToolCallAction({
      listDir: '/tmp',
      stepId: 'configured_sms',
      stepConfig: {
        ...normalized.config.pipeline[0],
        external_send: true,
        __tryTool: async () => ({ result: {}, provider: 'test-provider' }),
      },
      record: {},
    }),
    /forbidden channel/i,
  );
});

test('the declared-channel guard continues to reject SMS, voice, and visits', async () => {
  const { assertWorkAllowed } = await import('../dist/orchestrator/policy/forbidden-channels.js');
  for (const channel of ['sms', 'automated_voice', 'door_to_door']) {
    assert.throws(() => assertWorkAllowed({ channel }));
  }
});
