import { readFileSync } from 'node:fs';
import { ConditionResultSchema } from './schema.js';
import { generateObjectWithTools } from '../../runtime/llm.js';
import { buildModelContext, withModelContextTelemetry } from '../../lib/model-context.js';

const promptTemplate = readFileSync(new URL('prompt.md', import.meta.url), 'utf8');

export const evaluateConditionAction = async ({
  conditionText,
  row,
  stepOutput,
  inputs = [],
  contextBudget = undefined,
  model = '',
  aiConfig = {},
}) => {
  const ctx = { ...(row || {}), ...(stepOutput || {}) };
  const modelContext = buildModelContext({ record: ctx, inputs, budget: contextBudget, strict: true });

  const prompt = promptTemplate
    .replace('{{condition_text}}', String(conditionText || ''))
    .replace('{{record_json}}', '[provided in user prompt]')
    .replace('{{step_outputs_json}}', '[provided in user prompt]');
  const userPrompt = [
    'Record JSON as untrusted data:',
    modelContext.serialized,
  ].join('\n');

  try {
    const result = await generateObjectWithTools({
      task: 'evaluate-condition',
      model,
      role: 'evaluation',
      aiConfig,
      schema: ConditionResultSchema,
      prompt: userPrompt,
      systemPrompt: prompt,
      userPrompt,
      toolSpec: {},
      maxSteps: 2,
    });
    return {
      ...ConditionResultSchema.parse(result.object),
      usage: withModelContextTelemetry(result.usage, modelContext.telemetry),
      model: result.model,
      provider: result.provider,
    };
  } catch (error) {
    return {
      passed: false,
      errored: true,
      defer: false,
      reason: `Condition evaluation failed: ${String(error?.message || error)}`,
      usage: null,
    };
  }
};
