import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateText, Output } from 'ai';
import { z } from 'zod';

import { AgentOutboundError } from '../dist/orchestrator/runtime/contract.js';
import {
  assertProviderCredentials,
  parseProviderModel,
  resolveRuntimeModel,
} from '../dist/orchestrator/runtime/models.js';
import { getProviderById, getRegisteredProviders } from '../dist/orchestrator/runtime/providers.js';
import { generateObjectWithTools } from '../dist/orchestrator/runtime/llm.js';
import { writeModelsState } from '../dist/orchestrator/runtime/model-store.js';
import { assertConfigModelReferences } from '../dist/orchestrator/lib/model-validation.js';

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

test('OpenRouter sends strict structured output with the provider model id and high reasoning', async () => {
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  const originalReasoningEffort = process.env.AO_OPENROUTER_REASONING_EFFORT;
  const originalFetch = globalThis.fetch;
  const bodies = [];
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  delete process.env.AO_OPENROUTER_REASONING_EFFORT;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    bodies.push(body);
    const structured = body.response_format?.json_schema;
    return new Response(JSON.stringify({
      id: 'test-response',
      created: 0,
      model: 'z-ai/glm-5.2',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: structured ? JSON.stringify({
            outputs: { email_subject: 'Subject', email_body: 'Body' },
            used_inputs: ['account'],
            grounding: [
              { output: 'email_subject', text: 'Subject', inputs: ['account'] },
              { output: 'email_body', text: 'Body', inputs: ['account'] },
            ],
          }) : 'ok',
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { headers: { 'content-type': 'application/json' } });
  };

  try {
    const resolved = await resolveRuntimeModel({
      model: 'openrouter/z-ai/glm-5.2',
      enforceSupported: false,
      reasoning: true,
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

    const schema = z.object({
      outputs: z.object({
        email_subject: z.string().min(1),
        email_body: z.string().min(1),
      }).strict(),
      used_inputs: z.array(z.string().min(1)).min(1),
      grounding: z.array(z.object({
        output: z.string().min(1),
        text: z.string().min(1),
        inputs: z.array(z.string().min(1)).min(1),
      }).strict()).min(1),
    }).strict();
    const structured = await generateText({
      model: resolved.built,
      prompt: 'Return the requested compose result.',
      output: Output.object({ schema }),
      providerOptions: resolved.providerOptions,
    });
    assert.deepEqual(structured.output, {
      outputs: { email_subject: 'Subject', email_body: 'Body' },
      used_inputs: ['account'],
      grounding: [
        { output: 'email_subject', text: 'Subject', inputs: ['account'] },
        { output: 'email_body', text: 'Body', inputs: ['account'] },
      ],
    });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1].model, 'z-ai/glm-5.2');
    assert.equal(bodies[1].response_format.json_schema.strict, true);
    assert.deepEqual(bodies[1].response_format.json_schema.schema.required, [
      'outputs',
      'used_inputs',
      'grounding',
    ]);
    assert.deepEqual(bodies[1].response_format.json_schema.schema.properties.outputs.required, [
      'email_subject',
      'email_body',
    ]);
    assert.equal(bodies[1].response_format.json_schema.schema.properties.outputs.additionalProperties, false);

    process.env.AO_OPENROUTER_REASONING_EFFORT = 'medium';
    assert.deepEqual(resolved.provider.getProviderOptions?.('z-ai/glm-5.2', { reasoning: true }), {
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

test('OpenRouter sampling follows cached model capabilities and validates known rejections', async () => {
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  const originalGlobalRoot = process.env.AO_GLOBAL_ROOT;
  const originalFetch = globalThis.fetch;
  const globalRoot = mkdtempSync(join(tmpdir(), 'ao-openrouter-sampling-'));
  const bodies = [];
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  process.env.AO_GLOBAL_ROOT = globalRoot;
  writeModelsState({
    schema_version: '1.0.0',
    updated_at: '',
    providers: {
      openrouter: {
        provider: 'openrouter',
        models: ['openai/gpt-4.1-mini', 'deepseek/deepseek-r1'],
        capabilities: {
          'openai/gpt-4.1-mini': ['temperature'],
          'deepseek/deepseek-r1': ['reasoning'],
        },
        updated_at: '',
      },
    },
  });
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    bodies.push(body);
    return new Response(JSON.stringify({
      id: 'test-response', created: 0, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { headers: { 'content-type': 'application/json' } });
  };

  const call = ({ model, temperature } = {}) => generateObjectWithTools({
    task: 'sampling-test',
    model,
    role: 'research',
    schema: z.object({ ok: z.boolean() }),
    prompt: 'Return JSON.',
    toolSpec: {},
    maxSteps: 1,
    ...(temperature === undefined ? {} : { temperature }),
  });

  try {
    await call({ model: 'openrouter/openai/gpt-4.1-mini' });
    assert.equal(bodies.at(-1).temperature, 0);

    await call({ model: 'openrouter/deepseek/deepseek-r1' });
    assert.equal('temperature' in bodies.at(-1), false);

    await call({ model: 'openrouter/openai/gpt-4.1-mini', temperature: 0 });
    assert.equal(bodies.at(-1).temperature, 0);

    assert.throws(() => assertConfigModelReferences({
      ai: { default_model: 'openrouter/deepseek/deepseek-r1' },
      pipeline: [{ kind: 'enrich', id: 'reasoning_step', temperature: 0 }],
    }), /temperature is not supported by openrouter\/deepseek\/deepseek-r1/);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(globalRoot, { recursive: true, force: true });
    if (originalApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalApiKey;
    if (originalGlobalRoot === undefined) delete process.env.AO_GLOBAL_ROOT;
    else process.env.AO_GLOBAL_ROOT = originalGlobalRoot;
  }
});
