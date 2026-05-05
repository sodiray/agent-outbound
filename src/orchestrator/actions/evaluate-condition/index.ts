import { readFileSync } from 'node:fs';
import { ConditionResultSchema } from './schema.js';
import { generateObjectWithTools } from '../../runtime/llm.js';

const promptTemplate = readFileSync(new URL('prompt.md', import.meta.url), 'utf8');

export const evaluateConditionAction = async ({ conditionText, row, stepOutput, model = '', aiConfig = {} }) => {
  const ctx = { ...(row || {}), ...(stepOutput || {}) };

  const prompt = promptTemplate
    .replace('{{condition_text}}', String(conditionText || ''))
    .replace('{{record_json}}', '[provided in user prompt]')
    .replace('{{step_outputs_json}}', '[provided in user prompt]');
  const userPrompt = [
    'Record JSON:',
    JSON.stringify(ctx, null, 2),
    '',
    'Step outputs JSON:',
    JSON.stringify(stepOutput || {}, null, 2),
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
      usage: result.usage,
      model: result.model,
      provider: result.provider,
    };
  } catch (error) {
    return {
      passed: false,
      defer: false,
      reason: `Condition evaluation failed: ${String(error?.message || error)}`,
      usage: null,
    };
  }
};
