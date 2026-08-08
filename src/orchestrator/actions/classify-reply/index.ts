import { z } from 'zod';
import { generateObjectWithTools } from '../../runtime/llm.js';
import { renderPromptTemplate } from '../shared.js';

type ReplyClassifier = {
  model?: unknown;
  prompt?: unknown;
  output?: {
    classifications?: unknown;
    opt_out_classifications?: unknown;
  };
};

const asClassifications = (classifier: ReplyClassifier): [string, ...string[]] => {
  const values = Array.isArray(classifier?.output?.classifications)
    ? classifier.output.classifications.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const [first, ...rest] = values;
  if (first) return [first, ...rest];
  throw new Error('reply_check.classifier.output.classifications must declare at least one classification.');
};

export const classifyReplyAction = async ({
  replyText,
  classifier,
  aiConfig = {},
  generate = generateObjectWithTools,
}: {
  replyText: unknown;
  classifier?: ReplyClassifier;
  aiConfig?: Record<string, unknown>;
  generate?: typeof generateObjectWithTools;
}) => {
  const configuredClassifier = classifier || {};
  const model = String(configuredClassifier.model || '').trim();
  const template = String(configuredClassifier.prompt || '').trim();
  if (!model) throw new Error('reply_check.classifier.model is required for inbound reply classification.');
  if (!template.includes('{{reply_text}}')) throw new Error('reply_check.classifier.prompt must include {{reply_text}}.');
  const schema = z.object({
    classification: z.enum(asClassifications(configuredClassifier)),
    reason: z.string().nullable().default(''),
  });
  const prompt = renderPromptTemplate({ template, vars: { reply_text: String(replyText || '') } });

  const result = await generate({
    task: 'classify-reply',
    model,
    role: 'evaluation',
    aiConfig,
    schema,
    prompt,
    toolSpec: {},
    maxSteps: 2,
  });

  return {
    ...schema.parse(result.object),
    usage: result.usage,
    model: result.model,
    provider: result.provider,
  };
};
