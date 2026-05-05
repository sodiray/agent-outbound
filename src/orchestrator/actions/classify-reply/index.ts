import { readFileSync } from 'node:fs';
import { ClassifyReplyResultSchema } from './schema.js';
import { generateObjectWithTools } from '../../runtime/llm.js';
import { renderPromptTemplate } from '../shared.js';

const promptTemplate = readFileSync(new URL('prompt.md', import.meta.url), 'utf8');

const keywordFallback = (text) => {
  const normalized = String(text || '').toLowerCase();
  if (!normalized.trim()) return { classification: 'question', reason: 'Empty reply.' };
  if (normalized.includes('mailer-daemon') || normalized.includes('delivery status notification') || normalized.includes('550 ') || normalized.includes('undeliverable')) {
    return { classification: 'bounce', reason: 'Contains delivery-failure signals.' };
  }
  if (normalized.includes('unsubscribe') || normalized.includes('remove me') || normalized.includes('do not contact') || normalized.includes(' stop ')) {
    return { classification: 'unsubscribe', reason: 'Contains explicit unsubscribe intent.' };
  }
  if (normalized.includes('not interested') || normalized.includes('no thanks') || normalized.includes('never')) {
    return { classification: 'hard_no', reason: 'Contains negative intent.' };
  }
  if (normalized.includes('out of office') || normalized.includes('ooo')) {
    return { classification: 'out_of_office', reason: 'Contains OOO language.' };
  }
  if (normalized.includes('auto-reply') || normalized.includes('automatic reply') || normalized.includes('automated message')) {
    return { classification: 'out_of_office', reason: 'Contains autoresponder language.' };
  }
  if (normalized.includes('?')) {
    return { classification: 'question', reason: 'Contains explicit question.' };
  }
  if (normalized.includes('too expensive') || normalized.includes('already use') || normalized.includes('not now')) {
    return { classification: 'objection', reason: 'Contains objection language.' };
  }
  if (normalized.includes('interested') || normalized.includes('call me') || normalized.includes('let\'s talk') || normalized.includes('book')) {
    return { classification: 'booking_intent', reason: 'Contains booking intent.' };
  }
  return { classification: 'positive_signal', reason: 'No strong intent cues found.' };
};

export const classifyReplyAction = async ({ replyText, model = '', aiConfig = {} }) => {
  const prompt = renderPromptTemplate({ template: promptTemplate, vars: { reply_text: String(replyText || '') } });

  try {
    const result = await generateObjectWithTools({
      task: 'classify-reply',
      model,
      role: 'evaluation',
      aiConfig,
      schema: ClassifyReplyResultSchema,
      prompt,
      toolSpec: {},
      maxSteps: 2,
    });

    return {
      ...ClassifyReplyResultSchema.parse(result.object),
      usage: result.usage,
      model: result.model,
      provider: result.provider,
    };
  } catch {
    return {
      ...keywordFallback(replyText),
      usage: null,
    };
  }
};
