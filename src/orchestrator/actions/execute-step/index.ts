import { readFileSync } from 'node:fs';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { ExecuteStepResultSchema } from './schema.js';
import { generateObjectWithTools } from '../../runtime/llm.js';
import { readPromptFileIfAny, renderPromptTemplate } from '../shared.js';
import type { ToolCatalog } from '../../runtime/tools.js';
import type { ActionRole } from '../../runtime/models.js';

const promptTemplate = readFileSync(new URL('prompt.md', import.meta.url), 'utf8');

const buildExecuteStepResultSchema = (outputSchema?: z.ZodTypeAny) => {
  if (!outputSchema) return ExecuteStepResultSchema;
  return z.object({
    outputs: outputSchema.default({}),
    artifacts: z.record(z.any()).default({}),
    summary: z.string().default(''),
    defer: z.boolean().default(false),
    reason: z.string().default(''),
    pagination: z.record(z.any()).nullable().optional(),
  });
};

const normalizeResultObject = (raw: any, outputSchema?: z.ZodTypeAny) => {
  const resultSchema = buildExecuteStepResultSchema(outputSchema);
  const parsed = resultSchema.parse(raw || {});
  const source = (raw && typeof raw === 'object') ? raw : {};

  let outputs = parsed.outputs || {};
  if (Object.keys(outputs).length === 0) {
    if (source.outputs && typeof source.outputs === 'object' && !Array.isArray(source.outputs)) {
      outputs = source.outputs;
    } else {
      const reserved = new Set(['outputs', 'artifacts', 'summary', 'defer', 'reason', 'usage', 'pagination']);
      const lifted: Record<string, any> = {};
      for (const [key, value] of Object.entries(source)) {
        if (!reserved.has(key)) lifted[key] = value;
      }
      if (Object.keys(lifted).length > 0) outputs = lifted;
    }
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
      ? (source as any).pagination
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
  mcp: Client;
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
  const promptFileBody = readPromptFileIfAny({ listDir, promptFile: stepConfig?.prompt_file });
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
    'Record JSON:',
    JSON.stringify(record || {}, null, 2),
    '',
    'Context JSON:',
    JSON.stringify(context || {}, null, 2),
  ].join('\n');

  try {
    const result = await generateObjectWithTools({
      mcp,
      task: 'execute-step',
      model: stepConfig?.model,
      role,
      aiConfig,
      schema: buildExecuteStepResultSchema(outputSchema),
      prompt: userPrompt,
      systemPrompt,
      userPrompt,
      toolSpec: stepConfig?.tool || {},
      toolCatalog,
      maxSteps: Number(stepConfig?.step_budget || 8),
    });

    return {
      ...normalizeResultObject(result.object, outputSchema),
      usage: result.usage,
      model: result.model,
      provider: result.provider,
    };
  } catch (error) {
    const detail = String((error as any)?.message || error);
    throw new Error(`execute-step failed (${stepId || 'step'}): ${detail}`);
  }
};
