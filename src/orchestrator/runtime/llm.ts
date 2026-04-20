import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { pickModel } from './models.js';
import { getEnv } from './env.js';
import { loadTools, type ToolCatalog, type ToolSpec } from './tools.js';
import { emitLive } from './activity.js';

let aiSdk: any = null;
let anthropicProvider: any = null;

const ensureAiDeps = async () => {
  if (aiSdk && anthropicProvider) return;
  try {
    aiSdk = await import('ai');
    anthropicProvider = await import('@ai-sdk/anthropic');
  } catch {
    throw new Error('Missing dependencies for AI SDK (`ai`, `@ai-sdk/anthropic`).');
  }
};

const getAnthropic = () => {
  const apiKey = String(getEnv('ANTHROPIC_API_KEY') || '').trim();
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is missing. Set it in ~/.agent-outbound/env or process env.');
  }
  return anthropicProvider.createAnthropic({ apiKey });
};

const normalizeUsage = (usage: any) => ({
  input_tokens: Number(usage?.inputTokens || usage?.promptTokens || 0),
  output_tokens: Number(usage?.outputTokens || usage?.completionTokens || 0),
  cache_creation_tokens: Number(usage?.cachedInputTokens || 0),
  cache_read_tokens: Number(usage?.cacheReadInputTokens || 0),
  usd_cost: Number(usage?.totalCost || 0),
});

const buildStopWhen = (maxSteps: number) => {
  if (typeof aiSdk?.stepCountIs === 'function') {
    return aiSdk.stepCountIs(Number(maxSteps || 8));
  }
  return undefined;
};

const buildStepCallback = ({ task }: { task: string }) => {
  return (event: any) => {
    const toolCalls = Array.isArray(event?.toolCalls) ? event.toolCalls.map((call: any) => call?.toolName || '') : [];
    emitLive({
      event: 'llm_step_finish',
      phase: String(task || ''),
      model: String(event?.modelId || ''),
      tool_calls: toolCalls,
      usage: {
        ...normalizeUsage(event?.usage || {}),
        tool_calls: toolCalls,
      },
    });
  };
};

const hasPinnedTools = (spec?: ToolSpec) =>
  (Array.isArray(spec?.tools) && spec!.tools!.length > 0)
  || (Array.isArray(spec?.toolkits) && spec!.toolkits!.length > 0);

const resolveTools = async (
  mcp: Client | undefined,
  toolSpec: ToolSpec | undefined,
  toolCatalog?: ToolCatalog,
) => {
  if (!hasPinnedTools(toolSpec)) return {};
  if (!mcp) {
    throw new Error('Tool spec pinned tools but no MCP client was provided to the LLM call.');
  }
  return loadTools(mcp, toolSpec, toolCatalog);
};

export type GenerateObjectWithToolsInput = {
  mcp?: Client;
  task: string;
  model: string;
  schema: any;
  prompt: string;
  systemPrompt?: string;
  userPrompt?: string;
  toolSpec?: ToolSpec;
  toolCatalog?: ToolCatalog;
  maxSteps?: number;
};

const tryParseJsonText = (text: string): unknown => {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  // Try fenced code block first
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }

  // Try the whole text as JSON
  try { return JSON.parse(trimmed); } catch {}

  // Find the first { ... } block (greedy from first { to last })
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch {}
  }

  return null;
};

export const generateObjectWithTools = async ({
  mcp,
  task,
  model,
  schema,
  prompt,
  systemPrompt = '',
  userPrompt = '',
  toolSpec,
  toolCatalog,
  maxSteps = 8,
}: GenerateObjectWithToolsInput) => {
  await ensureAiDeps();
  const anthropic = getAnthropic();
  const selectedModel = anthropic(pickModel(model || 'sonnet'));

  const tools = await resolveTools(mcp, toolSpec, toolCatalog);
  const hasTools = Object.keys(tools).length > 0;
  const onStepFinish = buildStepCallback({ task });
  const stopWhen = buildStopWhen(maxSteps);
  const system = String(systemPrompt || '').trim();
  const basePrompt = String(userPrompt || prompt || '').trim();
  const schemaInstruction = `After completing all work, return ONLY a JSON object matching this schema:\n${JSON.stringify(schema, null, 2)}\nNo extra text.`;
  const toolSystem = [system, schemaInstruction].filter(Boolean).join('\n\n');
  const providerOptions = {
    anthropic: {
      cacheControl: {
        type: 'ephemeral',
        ttl: '5m',
      },
    },
  };

  let result: any;
  try {
    if (hasTools) {
      result = await aiSdk.generateText({
        model: selectedModel,
        ...(toolSystem ? { system: toolSystem } : {}),
        prompt: basePrompt,
        tools,
        ...(stopWhen ? { stopWhen } : {}),
        onStepFinish,
        providerOptions,
      });
    } else {
      try {
        result = await aiSdk.generateText({
          model: selectedModel,
          ...(system ? { system } : {}),
          prompt: basePrompt,
          output: aiSdk.Output.object({ schema }),
          onStepFinish,
          providerOptions,
        });
      } catch (structuredError) {
        // Structured output can fail on complex schemas (e.g., large discriminated unions).
        // Fall back to free-form text generation with manual JSON parsing.
        const fallbackPrompt = basePrompt;
        result = await aiSdk.generateText({
          model: selectedModel,
          ...(toolSystem ? { system: toolSystem } : {}),
          prompt: fallbackPrompt,
          onStepFinish,
          providerOptions,
        });
        // Mark as fallback so the object extraction path below uses text parsing
        result._fallbackTextMode = true;
      }
    }
  } catch (error) {
    emitLive({
      event: 'llm_step_error',
      phase: String(task || ''),
      model: String(pickModel(model || 'sonnet')),
      error: String((error as any)?.message || error),
    });
    throw error;
  }

  let object: any;
  if (hasTools) {
    object = tryParseJsonText(result?.text || '');

    // If the tool loop exhausted steps without producing JSON, collect
    // tool results and do a final structured extraction call.
    if (!object && result?.steps?.length > 0) {
      const toolResults = result.steps
        .flatMap((s: any) => {
          const results = s.toolResults || [];
          return Array.isArray(results) ? results.map((r: any) => ({
            tool: r.toolName || '',
            data: r.output ?? r.result ?? null,
          })) : [];
        })
        .filter((r: any) => r.data != null);

      if (toolResults.length > 0) {
        const resultsJson = JSON.stringify(toolResults.map(r => ({ tool: r.tool, data: r.data })), null, 2).slice(0, 30000);
        const extractionPrompt = `You previously called tools and received these results:\n\n${resultsJson}\n\nOriginal task: ${basePrompt.slice(0, 2000)}\n\nNow respond with a JSON object matching this schema:\n${JSON.stringify(schema, null, 2)}\n\nReturn ONLY the JSON object, no other text.`;
        const extraction = await aiSdk.generateText({
          model: selectedModel,
          ...(system ? { system } : {}),
          prompt: extractionPrompt,
          output: aiSdk.Output.object({ schema }),
          providerOptions,
        });
        object = extraction?.output || extraction?.object || tryParseJsonText(extraction?.text || '');
      }
    }
  } else if (result?._fallbackTextMode) {
    // Fallback text mode — parse JSON from free-form text
    object = tryParseJsonText(result?.text || '');
  } else {
    object = result?.output || result?.object || null;
  }

  if (!object) {
    throw new Error('No object generated: response did not match schema.');
  }

  const payload = {
    id: randomUUID(),
    object,
    text: String(result?.text || ''),
    usage: normalizeUsage(result?.usage || {}),
    raw: result,
  };
  emitLive({
    event: 'llm_step_complete',
    phase: String(task || ''),
    model: String(pickModel(model || 'sonnet')),
    usage: payload.usage,
  });
  return payload;
};
