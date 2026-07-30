export const PIPELINE_ROUTE_TARGET = 'pipeline_name';
export const SUBPIPELINE_KIND = 'pipeline';
export const SUBPIPELINE_SCOPE_FIELD = '__subpipeline';
export const SUBPIPELINE_STEP_INDEX_FIELD = '__subpipeline_step_index';
export const SUBPIPELINE_LOCAL_ID_FIELD = '__subpipeline_local_id';

type PipelineConfigStep = Record<string, unknown>;

const isConfigStep = (value: unknown): value is PipelineConfigStep => (
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
);

const asPipeline = (config: unknown): PipelineConfigStep[] => (
  Array.isArray((config as { pipeline?: unknown })?.pipeline)
    ? (config as { pipeline: unknown[] }).pipeline.filter(isConfigStep)
    : []
);

const text = (value: unknown) => String(value || '').trim();

export const subpipelineName = (step: unknown) => text((step as Record<string, unknown>)?.id);

export const subpipelineDefinitions = (config: unknown) => asPipeline(config)
  .filter((step) => text(step?.kind) === SUBPIPELINE_KIND);

export const namespaceSubpipelineStepId = (pipelineName: unknown, stepId: unknown) => (
  `${text(pipelineName)}.${text(stepId)}`
);

const namespaceDependency = ({
  dependency,
  pipelineName,
  localIds,
}: {
  dependency: unknown;
  pipelineName: string;
  localIds: Set<string>;
}) => {
  const id = text(dependency);
  if (!id) return id;
  if (localIds.has(id)) return namespaceSubpipelineStepId(pipelineName, id);
  return id;
};

const namespacedChildSteps = (subpipeline: PipelineConfigStep) => {
  const pipelineName = subpipelineName(subpipeline);
  const children = Array.isArray(subpipeline?.steps) ? subpipeline.steps.filter(isConfigStep) : [];
  const localIds = new Set(children.map((step) => text(step?.id)).filter(Boolean));
  return children.map((step, index) => {
    const localId = text(step?.id);
    const namespaceReferences = (value: unknown) => (
      Array.isArray(value)
        ? value.map((dependency) => namespaceDependency({ dependency, pipelineName, localIds }))
        : []
    );
    return {
      ...step,
      id: namespaceSubpipelineStepId(pipelineName, localId),
      depends_on: namespaceReferences(step?.depends_on),
      runs_after: namespaceReferences(step?.runs_after),
      [SUBPIPELINE_SCOPE_FIELD]: pipelineName,
      [SUBPIPELINE_STEP_INDEX_FIELD]: index,
      [SUBPIPELINE_LOCAL_ID_FIELD]: localId,
    };
  });
};

export const flattenPipelineSteps = (config: unknown): PipelineConfigStep[] => asPipeline(config)
  .flatMap((step) => (
    text(step?.kind) === SUBPIPELINE_KIND
      ? namespacedChildSteps(step)
      : [step]
  ));

export const stepSubpipelineName = (step: unknown) => (
  text((step as Record<string, unknown>)?.[SUBPIPELINE_SCOPE_FIELD])
);

export const holdingSubpipelineNames = (config: unknown) => new Set(
  flattenPipelineSteps(config)
    .filter((step) => (
      text(step?.kind) === 'assign'
      && text(step?.target) === PIPELINE_ROUTE_TARGET
    ))
    .map((step) => text(step?.fallback))
    .filter(Boolean),
);

export const stepStatusColumn = (stepId: unknown) => {
  const id = text(stepId);
  const legacy = `${id}__status`;
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(legacy)) return legacy;
  const encoded = Array.from(new TextEncoder().encode(id))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `pipeline_step_${encoded}__status`;
};
