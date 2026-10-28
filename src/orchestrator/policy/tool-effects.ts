import { assertWorkAllowed } from './pipeline-prohibitions.js';

export const TOOL_EFFECT_CLASSES = [
  'data_lookup',
  'data_enrichment',
  'human_contact',
  'external_mutation',
] as const;

export type ToolEffectClass = (typeof TOOL_EFFECT_CLASSES)[number];

export type ToolEffectDeclaration = {
  class?: string;
  channel?: string;
};

type ToolSpecLike = {
  effect?: ToolEffectDeclaration;
};

const TOOL_EFFECT_CLASS_SET = new Set<string>(TOOL_EFFECT_CLASSES);

const normalized = (value: unknown) => String(value || '').trim().toLowerCase();

export const assertToolCallEffectsAllowed = ({
  stepId,
  toolSpecs,
  externalSend = false,
  policy,
}: {
  stepId: string;
  toolSpecs: ToolSpecLike[];
  externalSend?: boolean;
  policy?: { prohibited_channels?: unknown; prohibited_task_types?: unknown };
}): void => {
  for (const toolSpec of toolSpecs) {
    const effect = toolSpec?.effect;
    const effectClass = normalized(effect?.class);
    const channel = normalized(effect?.channel);
    if (!effectClass) {
      throw new Error(`tool_call:${stepId}: tool effect declaration is required.`);
    }
    if (!TOOL_EFFECT_CLASS_SET.has(effectClass)) {
      throw new Error(`tool_call:${stepId}: tool effect class "${effectClass}" is unrecognised.`);
    }
    if (effectClass === 'external_mutation') {
      if (!externalSend) throw new Error(`tool_call:${stepId}: external mutations require an action boundary.`);
      continue;
    }
    if (effectClass === 'data_lookup' || effectClass === 'data_enrichment') {
      if (!channel) continue;
      throw new Error(`tool_call:${stepId}: data tool effects cannot declare a human-contact channel.`);
    }
    if (!externalSend) {
      throw new Error(`tool_call:${stepId}: outbound tool effects are only allowed at a named channel boundary.`);
    }
    if (!channel) {
      throw new Error(`tool_call:${stepId}: human-contact tool effects must declare a channel.`);
    }
    assertWorkAllowed({ policy, channel });
  }
};
