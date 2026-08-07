import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentOutboundError } from '../dist/orchestrator/runtime/contract.js';
import {
  assertProviderCredentials,
  parseProviderModel,
  resolveRuntimeModel,
} from '../dist/orchestrator/runtime/models.js';
import { getProviderById, getRegisteredProviders } from '../dist/orchestrator/runtime/providers.js';

test('OpenRouter is a registered runtime provider', () => {
  const provider = getRegisteredProviders().find((candidate) => candidate.id === 'openrouter');
  assert.ok(provider);
  assert.equal(provider.envKey, 'OPENROUTER_API_KEY');
  assert.equal(provider.supportsCacheControl, false);
});

test('OpenRouter model refs preserve slashes in the model id', () => {
  assert.deepEqual(parseProviderModel('openrouter/z-ai/glm-4.7-flash'), {
    providerId: 'openrouter',
    modelId: 'z-ai/glm-4.7-flash',
    modelRef: 'openrouter/z-ai/glm-4.7-flash',
  });
});

test('OpenRouter missing credentials name both supported credential paths', () => {
  const provider = getProviderById('openrouter');
  assert.ok(provider);
  assert.throws(
    () => assertProviderCredentials({
      provider,
      modelRef: 'openrouter/z-ai/glm-4.7-flash',
      apiKey: '',
    }),
    (error) => error instanceof AgentOutboundError
      && /OPENROUTER_API_KEY/.test(error.message)
      && /OPENAI_COMPATIBLE_API_KEY \+ OPENAI_COMPATIBLE_BASE_URL/.test(error.message),
  );
});

test('OpenRouter sends high reasoning by default without temperature', async () => {
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  const originalReasoningEffort = process.env.AO_OPENROUTER_REASONING_EFFORT;
  const originalFetch = globalThis.fetch;
  const bodies = [];
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  delete process.env.AO_OPENROUTER_REASONING_EFFORT;
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body || '{}')));
    return new Response(JSON.stringify({
      id: 'test-response',
      created: 0,
      model: 'z-ai/glm-5.2',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { headers: { 'content-type': 'application/json' } });
  };

  try {
    const { generateText } = await import('ai');
    const resolved = await resolveRuntimeModel({
      model: 'openrouter/z-ai/glm-5.2',
      enforceSupported: false,
    });
    assert.deepEqual(resolved.providerOptions, { openrouter: { reasoning: { effort: 'high' } } });
    await generateText({
      model: resolved.built,
      prompt: 'Reply with ok.',
      providerOptions: resolved.providerOptions,
    });
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0].reasoning, { effort: 'high' });
    assert.equal('temperature' in bodies[0], false);

    process.env.AO_OPENROUTER_REASONING_EFFORT = 'medium';
    assert.deepEqual(resolved.provider.getProviderOptions?.('z-ai/glm-5.2'), {
      openrouter: { reasoning: { effort: 'medium' } },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalApiKey;
    if (originalReasoningEffort === undefined) delete process.env.AO_OPENROUTER_REASONING_EFFORT;
    else process.env.AO_OPENROUTER_REASONING_EFFORT = originalReasoningEffort;
  }
});
