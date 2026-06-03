import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ActionRole } from './models.js';
import { resolveRuntimeModel } from './models.js';
import { loadTools, type ToolCatalog, type ToolSpec } from './tools.js';
import { emitLive } from './activity.js';

let aiSdk: any = null;

const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

const ensureAiDeps = async () => {
  if (aiSdk) return;
  try {
    aiSdk = await import('ai');
  } catch {
    throw new Error('Missing dependency `ai` required for LLM runtime.');
  }
};

const normalizeUsage = (usage: any) => ({
  input_tokens: Number(usage?.inputTokens || usage?.promptTokens || 0),
  output_tokens: Number(usage?.outputTokens || usage?.completionTokens || 0),
  cache_creation_tokens: Number(usage?.cachedInputTokens || 0),
  cache_read_tokens: Number(usage?.cacheReadInputTokens || 0),
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
  listDir = '',
) => {
  if (!hasPinnedTools(toolSpec)) return {};
  if (!mcp) {
    throw new Error('Tool spec pinned tools but no MCP client was provided to the LLM call.');
  }
  return loadTools(mcp, toolSpec, toolCatalog, { listDir });
};

export type GenerateObjectWithToolsInput = {
  mcp?: Client;
  task: string;
  model?: string;
  role?: ActionRole;
  aiConfig?: any;
  schema: any;
  prompt: string;
  systemPrompt?: string;
  userPrompt?: string;
  toolSpec?: ToolSpec;
  toolCatalog?: ToolCatalog;
  listDir?: string;
  maxSteps?: number;
};

const tryParseJsonSlice = (text: string): unknown => {
  try { return JSON.parse(text); } catch {}
  return null;
};

const findJsonObjectSlices = (text: string): string[] => {
  const slices: string[] = [];
  const source = String(text || '');
  const state = source.split('').reduce((acc, char, index) => {
    if (acc.done) return acc;
    if (acc.escape) return { ...acc, escape: false };
    if (char === '\\' && acc.inString) return { ...acc, escape: true };
    if (char === '"') return { ...acc, inString: !acc.inString };
    if (acc.inString) return acc;
    if (char === '{') {
      return {
        ...acc,
        start: acc.depth === 0 ? index : acc.start,
        depth: acc.depth + 1,
      };
    }
    if (char === '}' && acc.depth > 0) {
      const depth = acc.depth - 1;
      if (depth === 0 && acc.start >= 0) {
        slices.push(source.slice(acc.start, index + 1));
      }
      return { ...acc, depth, start: depth === 0 ? -1 : acc.start };
    }
    return acc;
  }, {
    depth: 0,
    start: -1,
    inString: false,
    escape: false,
    done: false,
  });
  void state;
  return slices;
};

const parseJsonTextCandidates = (text: string): unknown[] => {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];

  const fenced = Array.from(trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g))
    .map((match) => tryParseJsonSlice(match[1].trim()))
    .filter((candidate) => candidate !== null);

  const whole = tryParseJsonSlice(trimmed);
  const slices = findJsonObjectSlices(trimmed)
    .map((slice) => tryParseJsonSlice(slice))
    .filter((candidate) => candidate !== null);

  return [
    ...(whole === null ? [] : [whole]),
    ...fenced,
    ...slices,
  ];
};

const tryParseJsonText = (text: string): unknown => {
  return parseJsonTextCandidates(text)[0] ?? null;
};

const extractTextFromPart = (part: any): string => {
  if (part?.type === 'text') return String(part?.text || '');
  if (part?.type === 'output_text') return String(part?.text || part?.content || '');
  if (typeof part === 'string') return part;
  return '';
};

const extractTextFromContent = (content: any): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(extractTextFromPart).filter(Boolean).join('');
  }
  return extractTextFromPart(content);
};

const extractTextFromResponseBody = (body: any): string => {
  if (!body) return '';
  if (typeof body === 'string') {
    try { return extractTextFromResponseBody(JSON.parse(body)); } catch {}
    return body;
  }
  if (Array.isArray(body?.choices)) {
    return body.choices
      .map((choice: any) => (
        extractTextFromContent(choice?.message?.content)
        || extractTextFromContent(choice?.delta?.content)
        || extractTextFromContent(choice?.content)
        || extractTextFromContent(choice?.text)
      ))
      .filter(Boolean)
      .join('');
  }
  return extractTextFromContent(body?.message?.content)
    || extractTextFromContent(body?.content)
    || extractTextFromContent(body?.text);
};

const extractAssistantText = (result: any): string => {
  const candidates = [
    String(result?.text || ''),
    extractTextFromContent(result?.content),
    ...(Array.isArray(result?.steps)
      ? result.steps.slice().reverse().flatMap((step: any) => [
        String(step?.text || ''),
        extractTextFromContent(step?.content),
        ...(Array.isArray(step?.response?.messages)
          ? step.response.messages.slice().reverse().map((message: any) => extractTextFromContent(message?.content))
          : []),
      ])
      : []),
    ...(Array.isArray(result?.response?.messages)
      ? result.response.messages.slice().reverse().map((message: any) => extractTextFromContent(message?.content))
      : []),
    extractTextFromResponseBody(result?.response?.body),
    extractTextFromResponseBody(result?.rawResponse?.body),
  ];
  return candidates.map((candidate) => String(candidate || '').trim()).find(Boolean) || '';
};

const providerOptionsRequestReasoning = (value: any): boolean => {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => (
    key.toLowerCase().includes('thinking')
    || key.toLowerCase().includes('reasoning')
    || providerOptionsRequestReasoning(child)
  ));
};

const describeZodType = (schema: any): string => {
  const typeName = String(schema?._def?.typeName || '');
  if (typeName === 'ZodBoolean') return 'boolean';
  if (typeName === 'ZodNumber') return 'number';
  if (typeName === 'ZodString') return 'string';
  if (typeName === 'ZodArray') return `array of ${describeZodType(schema?._def?.type)}`;
  if (typeName === 'ZodObject') return describeSchema(schema);
  if (typeName === 'ZodOptional') return `${describeZodType(schema?._def?.innerType)} (optional)`;
  if (typeName === 'ZodNullable') return `${describeZodType(schema?._def?.innerType)} or null`;
  return typeName ? typeName.replace(/^Zod/, '').toLowerCase() : 'value';
};

const describeSchema = (schema: any): string => {
  if (typeof schema?._def?.shape !== 'function') {
    return JSON.stringify(schema, null, 2);
  }
  const shape = schema._def.shape();
  const fields = Object.entries(shape || {}).map(([key, value]) => `${key}: ${describeZodType(value)}`);
  return `{ ${fields.join(', ')} }`;
};

const validateGeneratedObject = (schema: any, candidate: any): any => {
  if (candidate === null || candidate === undefined) return null;
  if (typeof schema?.safeParse !== 'function') return candidate;
  const parsed = schema.safeParse(candidate);
  return parsed?.success ? parsed.data : null;
};

const validateGeneratedText = (schema: any, text: string): any => {
  return parseJsonTextCandidates(text)
    .map((candidate) => validateGeneratedObject(schema, candidate))
    .find((candidate) => candidate) ?? null;
};

const extractValidatedObject = (schema: any, result: any): any => (
  validateGeneratedObject(schema, result?._validatedObject)
  ?? validateGeneratedObject(schema, result?.output)
  ?? validateGeneratedObject(schema, result?.object)
  ?? validateGeneratedText(schema, extractAssistantText(result))
);

export const generateObjectWithTools = async ({
  mcp,
  task,
  model = '',
  role = 'research',
  aiConfig = {},
  schema,
  prompt,
  systemPrompt = '',
  userPrompt = '',
  toolSpec,
  toolCatalog,
  listDir = '',
  maxSteps = 8,
}: GenerateObjectWithToolsInput) => {
  await ensureAiDeps();
  const resolved = await resolveRuntimeModel({
    model,
    role,
    aiConfig,
    enforceSupported: true,
  });
  const selectedModel = resolved.built;

  const tools = await resolveTools(mcp, toolSpec, toolCatalog, listDir);
  const hasTools = Object.keys(tools).length > 0;
  const onStepFinish = buildStepCallback({ task });
  const stopWhen = buildStopWhen(maxSteps);
  const system = String(systemPrompt || '').trim();
  const basePrompt = String(userPrompt || prompt || '').trim();
  const schemaDescription = describeSchema(schema);
  const schemaInstruction = `After completing all work, return ONLY a JSON object matching this schema:\n${schemaDescription}\nNo extra text.`;
  const toolSystem = [system, schemaInstruction].filter(Boolean).join('\n\n');
  const providerOptions = resolved.providerOptions || {};
  const withProviderOptions = Object.keys(providerOptions || {}).length > 0
    ? { providerOptions }
    : {};
  const preferPlainTextObject = !hasTools && (
    resolved.providerId === 'deepinfra'
    || providerOptionsRequestReasoning(providerOptions)
  );

  let result: any;
  try {
    if (hasTools) {
      result = await aiSdk.generateText({
        model: selectedModel,
        ...(toolSystem ? { system: toolSystem } : {}),
        prompt: basePrompt,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        tools,
        ...(stopWhen ? { stopWhen } : {}),
        onStepFinish,
        ...withProviderOptions,
      });
    } else {
      if (!preferPlainTextObject && resolved.providerId === 'deepinfra' && typeof aiSdk.generateObject === 'function') {
        try {
          const generated = await aiSdk.generateObject({
            model: selectedModel,
            ...(system ? { system } : {}),
            prompt: basePrompt,
            schema,
            maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
            ...withProviderOptions,
          });
          const object = extractValidatedObject(schema, generated);
          if (object) {
            generated._validatedObject = object;
            result = generated;
          }
        } catch {}
      }

      try {
        if (!result && !preferPlainTextObject) {
          const structured = await aiSdk.generateText({
            model: selectedModel,
            ...(system ? { system } : {}),
            prompt: basePrompt,
            maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
            output: aiSdk.Output.object({ schema }),
            onStepFinish,
            ...withProviderOptions,
          });
          const object = extractValidatedObject(schema, structured);
          if (!object) {
            throw new Error('Structured output did not match schema.');
          }
          structured._validatedObject = object;
          result = structured;
        }
      } catch (structuredError) {
        // Structured output can fail on complex schemas (e.g., large discriminated unions).
        // Fall back to free-form text generation with manual JSON parsing.
      }
      if (!result) {
        result = await aiSdk.generateText({
          model: selectedModel,
          ...(toolSystem ? { system: toolSystem } : {}),
          prompt: basePrompt,
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          onStepFinish,
          ...withProviderOptions,
        });
        result._fallbackTextMode = true;
      }
    }
  } catch (error) {
    emitLive({
      event: 'llm_step_error',
      phase: String(task || ''),
      model: resolved.modelRef,
      error: String((error as any)?.message || error),
    });
    throw error;
  }

  let object: any;
  if (hasTools) {
    object = validateGeneratedText(schema, extractAssistantText(result));

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
        const extractionPrompt = `You previously called tools and received these results:\n\n${resultsJson}\n\nOriginal task: ${basePrompt.slice(0, 2000)}\n\nNow respond with a JSON object matching this schema:\n${schemaDescription}\n\nReturn ONLY the JSON object, no other text.`;
        const extraction = await aiSdk.generateText({
          model: selectedModel,
          ...(system ? { system } : {}),
          prompt: extractionPrompt,
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          output: aiSdk.Output.object({ schema }),
          ...withProviderOptions,
        });
        object = extractValidatedObject(schema, extraction);
      }
    }
  } else if (result?._fallbackTextMode) {
    // Fallback text mode — parse JSON from free-form text
    object = validateGeneratedText(schema, extractAssistantText(result));
  } else {
    object = extractValidatedObject(schema, result);
  }

  if (!object) {
    throw new Error('No object generated: response did not match schema.');
  }

  const usage = {
    input_tokens: Number(result?.usage?.inputTokens || result?.usage?.promptTokens || 0),
    output_tokens: Number(result?.usage?.outputTokens || result?.usage?.completionTokens || 0),
    cache_creation_tokens: Number(result?.usage?.cachedInputTokens || 0),
    cache_read_tokens: Number(result?.usage?.cacheReadInputTokens || 0),
    usd_cost: resolved.provider.extractUsdCost(result),
    tool_calls: Array.isArray(result?.steps)
      ? result.steps.flatMap((step: any) => Array.isArray(step?.toolCalls)
        ? step.toolCalls.map((call: any) => String(call?.toolName || '').trim()).filter(Boolean)
        : [])
      : [],
  };

  const payload = {
    id: randomUUID(),
    object,
    text: String(result?.text || ''),
    usage,
    model: resolved.modelRef,
    provider: resolved.providerId,
    raw: result,
  };
  emitLive({
    event: 'llm_step_complete',
    phase: String(task || ''),
    model: resolved.modelRef,
    usage: payload.usage,
  });
  return payload;
};
