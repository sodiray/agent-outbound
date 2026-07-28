import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { getTargetColumnsForStepConfig } from './step-columns.js';

type PipelineGraphOptions = {
  listDir?: string;
};

type ProseHit = {
  stepId: string;
  field: string;
  source: string;
  tokenized: boolean;
};

type Producer = {
  field: string;
  stepId: string;
  index: number;
};

const pipelineSteps = (config: any) => Array.isArray(config?.pipeline) ? config.pipeline : [];

const stepId = (step: any) => String(step?.id || '').trim();

const stringArray = (value: unknown) => Array.isArray(value)
  ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
  : [];

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const tokenPatterns = (field: string) => [
  new RegExp(`\\{${escapeRegExp(field)}\\}`, 'g'),
  new RegExp(`\\$\\{${escapeRegExp(field)}\\}`, 'g'),
];

const fieldPattern = (field: string) => new RegExp(`(^|[^A-Za-z0-9_])(${escapeRegExp(field)})(?=$|[^A-Za-z0-9_])`, 'g');

const hasField = (text: string, field: string) => fieldPattern(field).test(text);

const hasToken = (text: string, field: string) => tokenPatterns(field).some((pattern) => pattern.test(text));

const collectTokens = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return Array.from(value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{([A-Za-z_][A-Za-z0-9_]*)\}/g))
      .map((match) => String(match[1] || match[2] || '').trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) return value.flatMap((entry) => collectTokens(entry));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((entry) => collectTokens(entry));
  }
  return [];
};

const conditionFields = (predicate: any): string[] => {
  const conditions = Array.isArray(predicate?.conditions) ? predicate.conditions : [];
  return conditions.map((condition: any) => String(condition?.field || '').trim()).filter(Boolean);
};

const promptPathCandidates = (promptFile: string, options: PipelineGraphOptions) => {
  if (!promptFile) return [];
  if (isAbsolute(promptFile)) return [promptFile];
  const listDir = String(options?.listDir || '').trim();
  return [
    listDir ? join(listDir, promptFile) : '',
    join(process.cwd(), promptFile),
  ].filter(Boolean);
};

const readPromptBody = (promptFile: string, options: PipelineGraphOptions) => {
  const path = promptPathCandidates(promptFile, options).find((candidate) => existsSync(candidate));
  if (!path) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

const proseTextsForStep = (step: any, options: PipelineGraphOptions) => {
  if (String(step?.kind || '') === 'filter' && String(step?.type || '') === 'semantic') {
    return [{ source: 'condition', text: String(step?.condition || '') }];
  }
  if (String(step?.kind || '') !== 'enrich') return [];
  const promptFile = String(step?.prompt_file || '').trim();
  const promptText = readPromptBody(promptFile, options);
  return [
    { source: 'description', text: String(step?.description || '') },
    promptFile ? { source: `prompt_file:${promptFile}`, text: promptText } : null,
  ].filter((entry): entry is { source: string; text: string } => Boolean(entry && entry.text));
};

const producedFieldsByStep = (config: any): Producer[] => {
  const entries = pipelineSteps(config).flatMap((step: any, index: number) => {
    if (String(step?.kind || '') !== 'enrich') return [];
    const id = stepId(step);
    if (!id) return [];
    const stepConfig = step?.config && typeof step.config === 'object' ? step.config : step;
    const outputs = stepConfig?.outputs && typeof stepConfig.outputs === 'object' && !Array.isArray(stepConfig.outputs)
      ? Object.keys(stepConfig.outputs)
      : [];
    const columns = stepConfig?.columns && typeof stepConfig.columns === 'object' && !Array.isArray(stepConfig.columns)
      ? Object.keys(stepConfig.columns)
      : [];
    const targetColumns = getTargetColumnsForStepConfig(stepConfig).map((column) => column.name);
    return [...new Set([...outputs, ...columns, ...targetColumns, `${id}__status`])]
      .map((field) => String(field || '').trim())
      .filter(Boolean)
      .map((field) => ({ field, stepId: id, index }));
  });
  return entries;
};

const addDependencyForField = ({
  deps,
  producers,
  consumerIndex,
  field,
}: {
  deps: Set<string>;
  producers: ReturnType<typeof producedFieldsByStep>;
  consumerIndex: number;
  field: string;
}) => {
  producers
    .filter((producer) => producer.field === field && producer.index < consumerIndex)
    .forEach((producer) => deps.add(producer.stepId));
};

const collectProseHits = (config: any, options: PipelineGraphOptions): ProseHit[] => {
  const producers = producedFieldsByStep(config);
  const fields = [...new Set(producers.map((producer) => producer.field))];
  return pipelineSteps(config).flatMap((step: any) => {
    const id = stepId(step);
    if (!id) return [];
    return proseTextsForStep(step, options).flatMap(({ source, text }) => {
      if (!text) return [];
      return fields
        .filter((field) => hasField(text, field))
        .map((field) => ({
          stepId: id,
          field,
          source,
          tokenized: hasToken(text, field),
        }));
    });
  });
};

const hasEarlierProducer = (config: any, stepIdValue: string, field: string) => {
  const steps = pipelineSteps(config);
  const index = steps.findIndex((step: any) => stepId(step) === stepIdValue);
  if (index < 0) return false;
  return producedFieldsByStep(config).some((producer) => producer.field === field && producer.index < index);
};

const positionalReviewDependencies = (config: any) => {
  const steps = pipelineSteps(config);
  const entries: Array<[string, Set<string>]> = steps.map((step: any, index: number) => {
    const id = stepId(step);
    const deps = steps
      .slice(0, index)
      .filter((candidate: any) => String(candidate?.kind || '') === 'review')
      .map((candidate: any) => stepId(candidate))
      .filter(Boolean);
    return [id, new Set(deps)];
  }).filter(([id]) => Boolean(id));
  return new Map(entries);
};

export const inferPipelineEdges = (config: any, options: PipelineGraphOptions = {}): Map<string, Set<string>> => {
  const producers = producedFieldsByStep(config);
  const proseHits = collectProseHits(config, options);
  const reviewDependencies = positionalReviewDependencies(config);
  const entries: Array<[string, Set<string>]> = pipelineSteps(config).map((step: any, index: number) => {
    const id = stepId(step);
    const deps = new Set<string>(reviewDependencies.get(id) || []);
    if (!id) return [id, deps] as [string, Set<string>];

    const structuralFields = [
      ...(String(step?.kind || '') === 'enrich' ? conditionFields(step?.when) : []),
      ...(String(step?.kind || '') === 'review' ? conditionFields(step?.when) : []),
      ...(String(step?.kind || '') === 'filter' ? conditionFields(step) : []),
      ...collectTokens(step?.prompt_args),
      ...collectTokens(step?.args),
    ];
    structuralFields.forEach((field) => addDependencyForField({ deps, producers, consumerIndex: index, field }));
    proseHits
      .filter((hit) => hit.stepId === id)
      .forEach((hit) => addDependencyForField({ deps, producers, consumerIndex: index, field: hit.field }));
    deps.delete(id);
    return [id, deps] as [string, Set<string>];
  }).filter(([id]) => Boolean(id));
  return new Map(entries);
};

const findCycle = (edges: Map<string, Set<string>>) => {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, path: string[]): string[] => {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      return [...path.slice(start >= 0 ? start : 0), id];
    }
    if (visited.has(id)) return [];
    visiting.add(id);
    const found = Array.from(edges.get(id) || [])
      .map((dep) => visit(dep, [...path, id]))
      .find((cycle) => cycle.length > 0);
    visiting.delete(id);
    visited.add(id);
    return found || [];
  };
  return Array.from(edges.keys()).map((id) => visit(id, [])).find((cycle) => cycle.length > 0) || [];
};

export const validatePipelineGraph = (config: any, options: PipelineGraphOptions = {}) => {
  const steps = pipelineSteps(config);
  const ids = steps.map((step: any) => stepId(step)).filter(Boolean);
  const idSet = new Set(ids);
  const indexById = new Map(ids.map((id, index) => [id, index]));
  const errors: string[] = [];
  const warnings: string[] = [];
  const explicitEdges = new Map<string, Set<string>>();
  const reviewDependencies = positionalReviewDependencies(config);

  steps.forEach((step: any) => {
    const id = stepId(step);
    if (!id) return;
    const refs = [...stringArray(step?.depends_on), ...stringArray(step?.runs_after)];
    explicitEdges.set(id, new Set([...refs, ...Array.from(reviewDependencies.get(id) || [])]));
    refs.forEach((ref) => {
      if (!idSet.has(ref)) {
        errors.push(`pipeline.${id} references unknown dependency "${ref}".`);
        return;
      }
      const refIndex = indexById.get(ref) ?? -1;
      const currentIndex = indexById.get(id) ?? -1;
      if (refIndex > currentIndex) {
        warnings.push(`pipeline.${id} depends on later-listed step "${ref}".`);
      }
    });
  });

  const cycle = findCycle(explicitEdges);
  if (cycle.length > 0) {
    errors.push(`pipeline dependency cycle detected: ${cycle.join(' -> ')}.`);
  }

  const inferred = inferPipelineEdges(config, options);
  inferred.forEach((deps, id) => {
    const declared = new Set(stringArray(steps.find((step: any) => stepId(step) === id)?.depends_on));
    const acknowledged = new Set([
      ...declared,
      ...stringArray(steps.find((step: any) => stepId(step) === id)?.runs_after),
      ...Array.from(reviewDependencies.get(id) || []),
    ]);
    Array.from(deps).filter((dep) => !acknowledged.has(dep)).forEach((dep) => {
      errors.push(`pipeline.${id} consumes data from "${dep}" but is missing depends_on: "${dep}".`);
    });
  });

  collectProseHits(config, options)
    .filter((hit) => !hit.tokenized && hasEarlierProducer(config, hit.stepId, hit.field))
    .forEach((hit) => {
      warnings.push(`pipeline.${hit.stepId} references produced field "${hit.field}" in ${hit.source} prose; use {${hit.field}} token syntax.`);
    });

  return {
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
  };
};

export const mergeInferredPipelineDependencies = (config: any, options: PipelineGraphOptions = {}) => {
  const inferred = inferPipelineEdges(config, options);
  return {
    ...(config || {}),
    pipeline: pipelineSteps(config).map((step: any) => {
      const id = stepId(step);
      const computed = Array.from(inferred.get(id) || []);
      const runsAfter = stringArray(step?.runs_after);
      return {
        ...step,
        depends_on: [...new Set([...computed, ...runsAfter])],
      };
    }),
  };
};

export const pipelineDependencyDiff = (config: any, options: PipelineGraphOptions = {}) => {
  const inferred = inferPipelineEdges(config, options);
  return pipelineSteps(config).map((step: any) => {
    const id = stepId(step);
    const current = stringArray(step?.depends_on);
    const computed = Array.from(inferred.get(id) || []);
    return {
      id,
      current,
      computed,
      added: computed.filter((dep) => !current.includes(dep)),
      removed: current.filter((dep) => !computed.includes(dep)),
    };
  }).filter((entry) => entry.id);
};
