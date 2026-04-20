import { readFileSync } from 'node:fs';
import { ClassifyReplyResultSchema } from './schema.js';
import { generateObjectWithTools } from '../../runtime/llm.js';
import { renderPromptTemplate } from '../shared.js';

const promptTemplate = readFileSync(new URL('prompt.md', import.meta.url), 'utf8');

const keywordFallback = (text) => {
  const normalized = String(text || '').toLowerCase();
  if (!normalized.trim()) return { classification: 'negative', reason: 'Empty reply.' };
  if (normalized.includes('mailer-daemon') || normalized.includes('delivery status notification') || normalized.includes('550 ') || normalized.includes('undeliverable')) {
    return { classification: 'bounce', reason: 'Contains delivery-failure signals.' };
  }
  if (normalized.includes('not interested') || normalized.includes('no thanks')) {
    return { classification: 'negative', reason: 'Contains negative intent.' };
  }
  if (normalized.includes('out of office') || normalized.includes('ooo')) {
    return { classification: 'ooo', reason: 'Contains OOO language.' };
  }
  if (normalized.includes('auto-reply') || normalized.includes('automatic reply') || normalized.includes('automated message')) {
    return { classification: 'auto', reason: 'Contains autoresponder language.' };
  }
  if (normalized.includes('interested') || normalized.includes('call me') || normalized.includes('let\'s talk')) {
    return { classification: 'positive', reason: 'Contains positive intent.' };
  }
  return { classification: 'negative', reason: 'No strong intent cues found.' };
};

export const classifyReplyAction = async ({ replyText }) => {
  const prompt = renderPromptTemplate({ template: promptTemplate, vars: { reply_text: String(replyText || '') } });

  try {
    const result = await generateObjectWithTools({
      task: 'classify-reply',
      model: 'haiku',
      schema: ClassifyReplyResultSchema,
      prompt,
      toolSpec: {},
      maxSteps: 2,
    });

    return {
      ...ClassifyReplyResultSchema.parse(result.object),
      usage: result.usage,
    };
  } catch {
    return {
      ...keywordFallback(replyText),
      usage: null,
    };
  }
};
