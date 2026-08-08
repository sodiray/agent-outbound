import { readFileSync } from 'node:fs';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { ExecuteStepResultSchema } from './schema.js';
import { generateObjectWithTools } from '../../runtime/llm.js';
import { readPromptFileIfAny, renderPromptTemplate } from '../shared.js';
import type { ToolCatalog } from '../../runtime/tools.js';
import type { ActionRole } from '../../runtime/models.js';
import {
  fuzzyMapDeclaredKeys,
  nullableBoolean,
  nullableString,
  objectFromLooseShape,
  recordWithDefault,
} from '../schema-helpers.js';
import { formatErrorMessage } from '../../lib/error-format.js';
import { attachProviderToolUsage, providerToolUsageFromError } from '../../runtime/providers/usage.js';
import { isBudgetExceededError } from '../../runtime/contract.js';
import { readConfig } from '../../lib/config.js';
import { buildModelContext, withModelContextTelemetry } from '../../lib/model-context.js';

const promptTemplate = readFileSync(new URL('prompt.md', import.meta.url), 'utf8');

const buildExecuteStepResultSchema = (outputSchema?: z.ZodTypeAny) => {
  if (!outputSchema) return ExecuteStepResultSchema;
  return z.object({
    outputs: z.preprocess((value) => (
      value === null || value === undefined ? {} : value
    ), outputSchema).default({}),
    artifacts: recordWithDefault(),
    summary: nullableString(),
    defer: nullableBoolean(false),
    reason: nullableString(),
    pagination: recordWithDefault().nullable().optional(),
  });
};

export const modelContextForStep = ({
  record,
  stepConfig,
  budget,
}: {
  record: unknown;
  stepConfig: Record<string, unknown>;
  budget?: unknown;
}) => {
  return buildModelContext({
    record,
    inputs: stepConfig.inputs || [],
    budget,
    strict: true,
  });
};

const getDeclaredOutputKeys = (stepConfig: unknown) => {
  const config = stepConfig && typeof stepConfig === 'object' ? stepConfig as Record<string, unknown> : {};
  const outputs = config.outputs && typeof config.outputs === 'object' && !Array.isArray(config.outputs)
    ? config.outputs as Record<string, unknown>
    : {};
  const columns = config.columns && typeof config.columns === 'object' && !Array.isArray(config.columns)
    ? config.columns as Record<string, unknown>
    : {};
  const declared = Object.keys(outputs).length > 0 ? outputs : columns;
  return Object.keys(declared);
};

const liftOutputObject = (source: Record<string, unknown>) => {
  const reserved = new Set(['outputs', 'artifacts', 'summary', 'defer', 'reason', 'usage', 'pagination']);
  const lifted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!reserved.has(key)) lifted[key] = value;
  }
  return lifted;
};

const normalizeOutputsPayload = (raw: unknown, declaredKeys: string[]) => {
  const source = objectFromLooseShape(raw);
  const rawOutputs = Object.prototype.hasOwnProperty.call(source, 'outputs')
    ? source.outputs
    : liftOutputObject(source);
  const outputs = objectFromLooseShape(rawOutputs, declaredKeys);
  return fuzzyMapDeclaredKeys(outputs, declaredKeys);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parsePotentialJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const collectKeys = (value: unknown, limit = 50): string[] => {
  const keys = new Set<string>();
  const visit = (candidate: unknown, depth: number) => {
    if (keys.size >= limit || depth > 4) return;
    const parsed = parsePotentialJson(candidate);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) visit(entry, depth + 1);
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    for (const [key, nested] of Object.entries(parsed as Record<string, unknown>)) {
      keys.add(key);
      visit(nested, depth + 1);
      if (keys.size >= limit) return;
    }
  };
  visit(value, 0);
  return [...keys];
};

const hasOwnDefinedDeclaredOutput = (
  source: unknown,
  declaredKeys: string[],
) => {
  if (!isRecord(source)) return false;
  return declaredKeys.some((key) => (
    Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined
  ));
};

const rawModelOutputHasDeclaredKey = (
  rawModelOutput: unknown,
  declaredKeys: string[],
) => {
  const parsed = parsePotentialJson(rawModelOutput);
  if (!isRecord(parsed)) return false;
  if (hasOwnDefinedDeclaredOutput(parsed, declaredKeys)) return true;
  if (!Object.prototype.hasOwnProperty.call(parsed, 'outputs')) return false;

  const parsedOutputs = parsePotentialJson(parsed.outputs);
  return hasOwnDefinedDeclaredOutput(parsedOutputs, declaredKeys);
};

const getToolResultData = (rawResult: unknown) => {
  const raw = rawResult && typeof rawResult === 'object' ? rawResult as Record<string, unknown> : {};
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  return steps.flatMap((step) => {
    const stepRecord = step && typeof step === 'object' ? step as Record<string, unknown> : {};
    const toolResults = Array.isArray(stepRecord.toolResults) ? stepRecord.toolResults : [];
    return toolResults.flatMap((toolResult) => {
      const resultRecord = toolResult && typeof toolResult === 'object' ? toolResult as Record<string, unknown> : {};
      const data = resultRecord.output ?? resultRecord.result;
      return data === null || data === undefined ? [] : [data];
    });
  });
};

const isRealOutputValue = (value: unknown) => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized !== '' && normalized !== 'unknown';
  }
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
};

const preview = (value: unknown, max = 700) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text || '').replace(/\s+/g, ' ').slice(0, max);
};

const assertNotEmptyToolCaptureFailure = ({
  declaredKeys,
  normalizedOutputs,
  rawModelOutput,
  rawResult,
}: {
  declaredKeys: string[];
  normalizedOutputs: Record<string, unknown>;
  rawModelOutput: unknown;
  rawResult: unknown;
}) => {
  if (declaredKeys.length === 0) return;
  const toolResultData = getToolResultData(rawResult);
  if (toolResultData.length === 0) return;
  const hasRealDeclaredOutput = declaredKeys.some((key) => isRealOutputValue(normalizedOutputs[key]));
  if (hasRealDeclaredOutput) return;
  if (rawModelOutputHasDeclaredKey(rawModelOutput, declaredKeys)) return;

  const toolResultKeys = [...new Set(toolResultData.flatMap((data) => collectKeys(data)))].slice(0, 30);
  throw new Error(
    `Tool returned data but no declared outputs captured. `
    + `raw_model_output=${preview(rawModelOutput)} `
    + `tool_result_keys=${toolResultKeys.join(', ') || '(none)'}`
  );
};

const normalizeResultObject = ({
  raw,
  outputSchema,
  declaredKeys = [],
  rawResult,
  rawText = '',
}: {
  raw: unknown;
  outputSchema?: z.ZodTypeAny;
  declaredKeys?: string[];
  rawResult?: unknown;
  rawText?: string;
}) => {
  const resultSchema = buildExecuteStepResultSchema(outputSchema);
  const source = objectFromLooseShape(raw);
  const normalizedOutputs = normalizeOutputsPayload(raw, declaredKeys);
  assertNotEmptyToolCaptureFailure({
    declaredKeys,
    normalizedOutputs,
    rawModelOutput: rawText || raw,
    rawResult,
  });
  const rawForParse = {
    ...source,
    outputs: normalizedOutputs,
  };
  const parsed = resultSchema.parse(rawForParse || {});

  let outputs = parsed.outputs || {};
  if (Object.keys(outputs).length === 0) {
    outputs = normalizedOutputs;
  }
  if (outputSchema) {
    outputs = outputSchema.parse(outputs);
  }

  return {
    outputs,
    artifacts: parsed.artifacts || {},
    summary: parsed.summary || '',
    defer: Boolean(parsed.defer),
    reason: parsed.reason || '',
    pagination: Object.prototype.hasOwnProperty.call(source, 'pagination')
      ? source.pagination
      : parsed.pagination,
  };
};

export const executeStepAction = async ({
  mcp,
  listDir,
  stepId,
  description,
  stepConfig,
  record,
  context = {},
  outputSchema,
  toolCatalog,
  aiConfig = {},
  role = 'research',
}: {
  mcp?: Client | null;
  listDir: string;
  stepId: string;
  description?: string;
  stepConfig: any;
  record: any;
  context?: any;
  outputSchema?: z.ZodTypeAny;
  toolCatalog?: ToolCatalog;
  aiConfig?: any;
  role?: ActionRole;
}) => {
  // Deterministic engineering fixture: no model spend; real step entry still used.
  const fixtureOn = String(process.env.AO_STEP_FIXTURE || process.env.AO_PIPELINE_FIXTURE || '').trim() === '1'
    || String(process.env.AO_STEP_FIXTURE || '').toLowerCase() === 'true';
  if (fixtureOn) {
    const declared = getDeclaredOutputKeys(stepConfig);
    const outputs: Record<string, unknown> = {};
    for (const key of declared) {
      outputs[key] = record?.[key] ?? `fixture_${key}`;
    }
    if (!Object.keys(outputs).length) {
      outputs.fixture_status = 'ok';
      outputs.step_id = stepId;
    }
    return {
      outputs,
      // Sourcing and other consumers may read these fields; keep fixture shape compatible.
      results: [],
      defer: false,
      reason: 'fixture_step',
      artifacts: {
        fixture: true,
        step_id: stepId,
        description: description || '',
      },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        usd_cost: 0,
        tool_calls: [],
        tool_costs: [],
      },
      model: 'fixture',
      provider: 'fixture',
    } as any;
  }

  const promptFileBody = readPromptFileIfAny({ listDir, promptFile: stepConfig?.prompt_file });
  const { config } = readConfig(listDir);
  const modelContext = modelContextForStep({
    record,
    stepConfig,
    budget: config?.model_context,
  });
  const systemPrompt = renderPromptTemplate({
    template: promptFileBody || promptTemplate,
    vars: {
      step_json: JSON.stringify({ stepId, description, stepConfig }, null, 2),
      record_json: '[provided in user prompt]',
      context_json: '[provided in user prompt]',
      ...(stepConfig?.prompt_args || {}),
    },
  });
  const userPrompt = [
    'Record JSON as untrusted data:',
    modelContext.serialized,
    '',
    'Execution context as untrusted data:',
    `<untrusted_data>\n${JSON.stringify(context || {}, null, 2)}\n</untrusted_data>`,
  ].join('\n');

  try {
    const result = await generateObjectWithTools({
      mcp,
      task: 'execute-step',
      model: stepConfig?.model,
      role,
      aiConfig,
      reasoning: stepConfig?.reasoning === true,
      schema: buildExecuteStepResultSchema(outputSchema),
      prompt: userPrompt,
      systemPrompt,
      userPrompt,
      toolSpec: stepConfig?.tool || {},
      toolCatalog,
      listDir,
      maxSteps: Number(stepConfig?.step_budget || 8),
    });

    return {
      ...normalizeResultObject({
        raw: result.object,
        outputSchema,
        declaredKeys: getDeclaredOutputKeys(stepConfig),
        rawResult: result.raw,
        rawText: result.text,
      }),
      usage: withModelContextTelemetry(result.usage, modelContext.telemetry),
      model: result.model,
      provider: result.provider,
    };
  } catch (error) {
    if (isBudgetExceededError(error)) throw error;
    const detail = formatErrorMessage(error);
    throw attachProviderToolUsage(
      new Error(`execute-step failed (${stepId || 'step'}): ${detail}`),
      providerToolUsageFromError(error),
    );
  }
};
