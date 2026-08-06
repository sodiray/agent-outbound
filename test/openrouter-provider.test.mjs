import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentOutboundError } from '../dist/orchestrator/runtime/contract.js';
import {
  assertProviderCredentials,
  parseProviderModel,
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
