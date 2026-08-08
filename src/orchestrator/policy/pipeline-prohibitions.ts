type PipelinePolicy = {
  prohibited_channels?: unknown;
  prohibited_task_types?: unknown;
};

export type ConfigStepLike = Record<string, unknown> & {
  id?: unknown;
  kind?: unknown;
  config?: Record<string, unknown>;
  steps?: ConfigStepLike[];
};

const normalized = (value: unknown) => String(value || '').trim().toLowerCase();

const policyValues = (value: unknown) => new Set(
  (Array.isArray(value) ? value : []).map(normalized).filter(Boolean),
);

export const prohibitedChannels = (policy: PipelinePolicy | undefined) => (
  policyValues(policy?.prohibited_channels)
);

export const prohibitedTaskTypes = (policy: PipelinePolicy | undefined) => (
  policyValues(policy?.prohibited_task_types)
);

export const isProhibitedChannel = (channel: unknown, policy: PipelinePolicy | undefined) => (
  prohibitedChannels(policy).has(normalized(channel))
);

export const isProhibitedTaskType = (taskType: unknown, policy: PipelinePolicy | undefined) => (
  prohibitedTaskTypes(policy).has(normalized(taskType))
);

const declaredChannelForKind = (kind: unknown) => {
  const normalizedKind = normalized(kind);
  return normalizedKind.startsWith('send_') ? normalizedKind.slice('send_'.length) : '';
};

const toolEffects = (config: Record<string, unknown> | undefined) => {
  const primary = config?.tool;
  const fallbacks = Array.isArray(config?.waterfall)
    ? config.waterfall
    : (Array.isArray(config?.fallback_tools) ? config.fallback_tools : []);
  return [primary, ...fallbacks]
    .filter((tool): tool is { effect?: { class?: unknown; channel?: unknown } } => (
      Boolean(tool && typeof tool === 'object' && !Array.isArray(tool))
    ))
    .map((tool) => tool.effect)
    .filter((effect): effect is { class?: unknown; channel?: unknown } => Boolean(effect));
};

const prohibitedReason = ({ step, policy }: { step: ConfigStepLike; policy: PipelinePolicy | undefined }) => {
  const channels = prohibitedChannels(policy);
  const taskTypes = prohibitedTaskTypes(policy);
  const config = (
    step.config && typeof step.config === 'object' && !Array.isArray(step.config)
      ? step.config
      : step
  ) as Record<string, unknown>;
  const id = String(step.id || '').trim() || '(unnamed)';
  const kind = normalized(step.kind);
  const taskType = normalized(config.task_type || config.taskType);
  const channelCandidates = [
    normalized(config.channel),
    declaredChannelForKind(kind),
    ...toolEffects(config)
      .filter((effect) => normalized(effect.class) === 'human_contact')
      .map((effect) => normalized(effect.channel)),
  ].filter(Boolean);
  const prohibitedChannel = channelCandidates.find((channel) => channels.has(channel));
  if (prohibitedChannel) return `step "${id}" declares prohibited channel "${prohibitedChannel}"`;
  if (taskType && taskTypes.has(taskType)) return `step "${id}" declares prohibited task type "${taskType}"`;
  return '';
};

export const findProhibitedSteps = (
  steps: ConfigStepLike[] | undefined | null,
  policy: PipelinePolicy | undefined,
): Array<{ id: string; kind: string; reason: string }> => {
  const found: Array<{ id: string; kind: string; reason: string }> = [];
  const walk = (list: ConfigStepLike[] | undefined | null) => {
    if (!Array.isArray(list)) return;
    for (const step of list) {
      if (!step || typeof step !== 'object') continue;
      const reason = prohibitedReason({ step, policy });
      if (reason) {
        found.push({
          id: String(step.id || ''),
          kind: String(step.kind || ''),
          reason,
        });
      }
      walk(step.steps);
    }
  };
  walk(steps);
  return found;
};

export const assertWorkAllowed = ({
  policy,
  kind,
  taskType,
  channel,
}: {
  policy?: PipelinePolicy;
  kind?: unknown;
  taskType?: unknown;
  channel?: unknown;
}): void => {
  const channels = prohibitedChannels(policy);
  const taskTypes = prohibitedTaskTypes(policy);
  const channelCandidates = [normalized(channel), declaredChannelForKind(kind)].filter(Boolean);
  const prohibitedChannel = channelCandidates.find((candidate) => channels.has(candidate));
  if (prohibitedChannel) {
    throw new Error(`Pipeline policy prohibits channel "${prohibitedChannel}".`);
  }
  const normalizedTaskType = normalized(taskType);
  if (normalizedTaskType && taskTypes.has(normalizedTaskType)) {
    throw new Error(`Pipeline policy prohibits task type "${normalizedTaskType}".`);
  }
};
