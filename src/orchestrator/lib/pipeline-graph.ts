import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { getTargetColumnsForStepConfig } from './step-columns.js';
import {
  flattenPipelineSteps,
  namespaceSubpipelineStepId,
  PIPELINE_ROUTE_TARGET,
  stepStatusColumn,
  stepSubpipelineName,
  SUBPIPELINE_KIND,
  subpipelineDefinitions,
  subpipelineName,
} from './subpipelines.js';

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
  action: string;
  subpipeline: string;
};

type DeclaredColumnProducer = {
  column: string;
  stepId: string;
  subpipeline: string;
};

const LINKEDIN_RESOLUTION_ACTION = 'linkedin_company_resolution';
const LINKEDIN_RESOLUTION_FIELDS = [
  'business_name',
  'place_id',
  'google_place_id',
  'primary_type',
  'website',
  'address',
  'user_rating_count',
  'company_resolution',
  'resolution_source',
  'resolution_reason',
  'resolution_candidate_name',
  'resolution_head_token',
];

const pipelineSteps = (config: any) => flattenPipelineSteps(config);

const stepId = (step: any) => String(step?.id || '').trim();

const configSteps = (value: unknown): Array<Record<string, unknown>> => (
  Array.isArray(value)
    ? value.filter((step): step is Record<string, unknown> => (
      Boolean(step && typeof step === 'object' && !Array.isArray(step))
    ))
    : []
);

const configRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

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
    if (!['enrich', 'extract', 'generate'].includes(String(step?.kind || ''))) return [];
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
    const actionOutputs = String(stepConfig?.action || '').trim().toLowerCase() === LINKEDIN_RESOLUTION_ACTION
      ? LINKEDIN_RESOLUTION_FIELDS
      : [];
    return [...new Set([...outputs, ...columns, ...targetColumns, ...actionOutputs, stepStatusColumn(id)])]
      .map((field) => String(field || '').trim())
      .filter(Boolean)
      .map((field) => ({
        field,
        stepId: id,
        index,
        action: String(stepConfig?.action || '').trim().toLowerCase(),
        subpipeline: stepSubpipelineName(step),
      }));
  });
  return entries;
};

const declaredColumnProducers = (config: any): DeclaredColumnProducer[] => (
  pipelineSteps(config).flatMap((step: any) => {
    const id = stepId(step);
    if (!id || !['enrich', 'extract', 'generate'].includes(String(step?.kind || ''))) return [];
    const stepConfig = step?.config && typeof step.config === 'object' ? step.config : step;
    return getTargetColumnsForStepConfig(stepConfig)
      .map(({ name }) => String(name || '').trim())
      .filter(Boolean)
      .map((column) => ({
        column,
        stepId: id,
        subpipeline: stepSubpipelineName(step),
      }));
  })
);

const canRunForSameRecord = (left: DeclaredColumnProducer, right: DeclaredColumnProducer): boolean => (
  left.subpipeline === right.subpipeline || !left.subpipeline || !right.subpipeline
);

const declaredColumnCollisionErrors = (config: any): string[] => {
  const producers = declaredColumnProducers(config);
  const columns = [...new Set(producers.map((producer) => producer.column))];
  return columns.flatMap((column) => {
    const columnProducers = producers.filter((producer) => producer.column === column);
    const competing = columnProducers.filter((producer, index) => (
      columnProducers.some((candidate, candidateIndex) => (
        candidateIndex > index && canRunForSameRecord(producer, candidate)
      ))
    ));
    if (competing.length === 0) return [];
    const producerIds = [...new Set(columnProducers
      .filter((producer) => competing.some((candidate) => canRunForSameRecord(producer, candidate)))
      .map((producer) => producer.stepId))];
    return [`record column "${column}" has competing declared producers: ${producerIds.map((id) => `"${id}"`).join(', ')}.`];
  });
};

const addDependencyForField = ({
  deps,
  producers,
  consumerIndex,
  consumerSubpipeline,
  field,
}: {
  deps: Set<string>;
  producers: ReturnType<typeof producedFieldsByStep>;
  consumerIndex: number;
  consumerSubpipeline: string;
  field: string;
}) => {
  producers
    .filter((producer) => (
      producer.field === field
      && (
        producer.subpipeline === consumerSubpipeline
        || (!producer.subpipeline && Boolean(consumerSubpipeline))
      )
      && (
        producer.index < consumerIndex
        || (
          field === 'company_resolution'
          && producer.action === LINKEDIN_RESOLUTION_ACTION
        )
      )
    ))
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
    const scope = stepSubpipelineName(step);
    const deps = steps
      .slice(0, index)
      .filter((candidate: any) => (
        String(candidate?.kind || '') === 'review'
        && (
          !stepSubpipelineName(candidate)
          || stepSubpipelineName(candidate) === scope
        )
      ))
      .map((candidate: any) => stepId(candidate))
      .filter(Boolean);
    return [id, new Set(deps)] as [string, Set<string>];
  }).filter(([id]) => Boolean(id));
  return new Map(entries);
};

export const inferPipelineEdges = (config: any, options: PipelineGraphOptions = {}): Map<string, Set<string>> => {
  const producers = producedFieldsByStep(config);
  const proseHits = collectProseHits(config, options);
  const reviewDependencies = positionalReviewDependencies(config);
  const entries: Array<[string, Set<string>]> = pipelineSteps(config).map((step: any, index: number) => {
    const id = stepId(step);
    const consumerSubpipeline = stepSubpipelineName(step);
    const deps = new Set<string>(reviewDependencies.get(id) || []);
    if (!id) return [id, deps] as [string, Set<string>];

    const structuralFields = [
      ...conditionFields(step?.when),
      ...(String(step?.kind || '') === 'filter' ? conditionFields(step) : []),
      ...(String(step?.kind || '') === 'assign'
        ? (Array.isArray(step?.rules) ? step.rules.flatMap((rule: any) => conditionFields(rule)) : [])
        : []),
      ...(String(step?.kind || '') === 'extract' ? stringArray(step?.from) : []),
      ...collectTokens(step?.prompt_args),
      ...collectTokens(step?.args),
    ];
    structuralFields.forEach((field) => addDependencyForField({
      deps,
      producers,
      consumerIndex: index,
      consumerSubpipeline,
      field,
    }));
    proseHits
      .filter((hit) => hit.stepId === id)
      .forEach((hit) => addDependencyForField({
        deps,
        producers,
        consumerIndex: index,
        consumerSubpipeline,
        field: hit.field,
      }));
    deps.delete(id);
    return [id, deps] as [string, Set<string>];
  }).filter(([id]) => Boolean(id));
  return new Map(entries);
};

const BASE_RECORD_FIELDS = new Set([
  '_row_id', 'id', '_created_at', '_updated_at', 'business_name', 'address', 'city', 'state', 'zip',
  'postal_code', 'country', 'website', 'domain', 'place_id', 'google_place_id', 'primary_type',
  'user_rating_count', 'parent_row_id', 'latitude',
  'longitude', 'source', 'source_query', 'sourced_at', 'duplicate_of', 'duplicate_status',
  'source_filter_result', 'source_filter_failures', 'disqualified_at', 'disqualified_gate',
  'disqualify_reason', 'phone', 'email_primary', 'contact_name_primary', 'contact_title_primary',
  'contact_name', 'contact_email', 'contact_title', 'email_verification_status',
  'email_verification_confidence', 'email_verified_at', 'fit_score', 'trigger_score',
  'trigger_score_peak', 'fit_reasoning', 'trigger_reasoning', 'fit_updated_at', 'trigger_updated_at',
  'fit_score_updated_at', 'trigger_score_updated_at', 'priority_rank', 'sequence_name', 'pipeline_name',
  'sequence_status', 'sequence_step', 'sequence_step_attempts', 'next_action_date', 'launched_at',
  'last_outreach_at', 'email_last_message_id', 'email_last_thread_id', 'email_last_draft_id',
  'email_last_reply_at', 'email_reply_classification', 'reply_classification_latest',
  'email_thread_id', 'disposition_latest', 'disposition_follow_up_at', 'mail_last_piece_id',
  'mail_last_cost_cents', 'mail_last_expected_delivery', 'mail_last_delivered_at',
  'mail_last_returned_at', 'visit_scheduled_date', 'visit_route_id', 'visit_route_position',
  'sms_last_message_id', 'call_last_disposition', 'suppressed', 'suppressed_reason', 'suppressed_at',
  'do_not_sms', 'dne_email', 'dnc_phone', 'dnk_visit', 'crm_company_id', 'crm_person_id',
  'crm_deal_id', 'crm_last_synced_at', 'crm_sync_hash', 'workflow_signals', 'company_resolution',
  'resolution_source', 'resolution_reason', 'resolution_candidate_name', 'resolution_head_token',
  'linkedin_name', 'linkedin_headline', 'linkedin_location', 'linkedin_urn',
  'vertical', 'sub_vertical', 'size_tier', 'is_franchise', 'persona', 'outcome',
  'outcome_notes', 'outcome_at', 'outcome_value', 'extra_json', 'retry_count', 'last_error',
  'needs_review', 'review_reason', 'review_flagged_at', 'routed_by', 'created_at', 'updated_at',
]);

const sourceSuppliedFields = (config: any) => {
  const source = config?.source || {};
  const searches = Array.isArray(source?.searches) ? source.searches : [];
  const strategies = Array.isArray(source?.strategies) ? source.strategies : [];
  const mapped = [...searches, ...strategies].flatMap((entry: any) => {
    const outputMap = entry?.output_map && typeof entry.output_map === 'object'
      ? entry.output_map
      : {};
    return [...Object.keys(outputMap), ...Object.values(outputMap).map((value) => String(value || '').trim())];
  });
  const manual = searches.flatMap((search: any) => (
    Array.isArray(search?.manual_results)
      ? search.manual_results.flatMap((row: any) => Object.keys(row || {}))
      : []
  ));
  return new Set([
    ...BASE_RECORD_FIELDS,
    ...stringArray(source?.identity),
    ...mapped,
    ...manual,
  ].map((field) => String(field || '').trim()).filter(Boolean));
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
};

const conditionKey = (condition: any) => JSON.stringify(stableValue({
  field: String(condition?.field || '').trim(),
  operator: String(condition?.operator || '').trim(),
  value: condition?.value,
  value_file: condition?.value_file,
}));

const ruleName = (rule: any, index: number) => (
  String(rule?.id || rule?.sequence || rule?.pipeline || '').trim() || `rule_${index + 1}`
);

const shadowWarningsForStep = (step: any) => {
  const rules = Array.isArray(step?.rules) ? step.rules : [];
  return rules.flatMap((earlier: any, earlierIndex: number) => {
    const earlierConditions = Array.isArray(earlier?.conditions) ? earlier.conditions : [];
    if (earlierConditions.length === 0) return [];
    const earlierKeys = new Set(earlierConditions.map((condition: any) => conditionKey(condition)));
    return rules.slice(earlierIndex + 1).flatMap((later: any, offset: number) => {
      const laterConditions = Array.isArray(later?.conditions) ? later.conditions : [];
      if (String(later?.match || 'all') !== 'all' || earlierKeys.size >= laterConditions.length) return [];
      const laterKeys = new Set(laterConditions.map((condition: any) => conditionKey(condition)));
      const isStrictSubset = Array.from(earlierKeys).every((key) => laterKeys.has(key));
      if (!isStrictSubset) return [];
      const laterIndex = earlierIndex + offset + 1;
      return [
        `pipeline.${stepId(step)} rule "${ruleName(earlier, earlierIndex)}" shadows later rule "${ruleName(later, laterIndex)}": its conditions are a strict subset of the later rule's conditions (first match wins).`,
      ];
    });
  });
};

export const validateRouterConfig = (config: any) => {
  const steps = pipelineSteps(config);
  const assignSteps = steps.filter((step) => String(step?.kind || '') === 'assign');
  const sequenceAssignSteps = assignSteps
    .filter((step) => String(step?.target || 'sequence_name') === 'sequence_name');
  const pipelineAssignSteps = assignSteps
    .filter((step) => String(step?.target || '') === PIPELINE_ROUTE_TARGET);
  const sequences = config?.sequences && typeof config.sequences === 'object' ? config.sequences : {};
  const sequenceNames = Object.keys(sequences);
  const subpipelines = subpipelineDefinitions(config);
  const subpipelineNames = subpipelines.map((step) => subpipelineName(step)).filter(Boolean);
  const errors: string[] = [];
  const warnings: string[] = [];

  sequenceNames
    .filter((name) => subpipelineNames.includes(name))
    .forEach((name) => {
      errors.push(`Sequence name "${name}" is ambiguous because it is defined as both a sequencer and a sub-pipeline.`);
    });

  if (sequenceNames.length > 1 && sequenceAssignSteps.length === 0) {
    errors.push(`Router configuration is ambiguous: sequences ${sequenceNames.map((name) => `"${name}"`).join(', ')} are defined, but pipeline has no kind: assign step.`);
  }
  if (
    subpipelineNames.length > 0
    && pipelineAssignSteps.length === 0
    && !(subpipelineNames.length === 1 && subpipelineNames[0] === 'default')
  ) {
    errors.push(`Router configuration is ambiguous: sub-pipelines ${subpipelineNames.map((name) => `"${name}"`).join(', ')} are defined, but pipeline has no kind: assign step targeting pipeline_name.`);
  }

  if (assignSteps.length === 0) return { errors, warnings };

  const definedSequences = new Set(sequenceNames);
  const definedSubpipelines = new Set(subpipelineNames);
  const producers = producedFieldsByStep(config);
  const suppliedFields = sourceSuppliedFields(config);

  assignSteps.forEach((step: any) => {
    const id = stepId(step);
    const target = String(step?.target || 'sequence_name');
    const targetKey = target === PIPELINE_ROUTE_TARGET ? 'pipeline' : 'sequence';
    const targetLabel = target === PIPELINE_ROUTE_TARGET ? 'sub-pipeline' : 'sequence';
    const definitions = target === PIPELINE_ROUTE_TARGET ? definedSubpipelines : definedSequences;
    const configuredTargets = target === PIPELINE_ROUTE_TARGET
      ? new Map(subpipelines.map((subpipeline) => [subpipelineName(subpipeline), subpipeline]))
      : new Map(Object.entries(sequences));
    const dependencies = new Set(stringArray(step?.depends_on));
    const rules = Array.isArray(step?.rules) ? step.rules : [];
    const fallback = String(step?.fallback || '').trim();
    const fallbackTarget = configuredTargets.get(fallback) as Record<string, unknown> | undefined;
    if (
      fallbackTarget
      && Array.isArray(fallbackTarget?.steps)
      && fallbackTarget.steps.length > 0
      && fallbackTarget?.manual !== true
    ) {
      const configPath = target === PIPELINE_ROUTE_TARGET
        ? `pipeline.${fallback}`
        : `sequences.${fallback}`;
      errors.push(`pipeline.${id} fallback "${fallback}" has non-empty steps and must set ${configPath}.manual: true.`);
    }

    rules.forEach((rule: any, ruleIndex: number) => {
      const destination = String(rule?.[targetKey] || '').trim();
      const name = ruleName(rule, ruleIndex);
      const otherTargetKey = targetKey === 'pipeline' ? 'sequence' : 'pipeline';
      if (String(rule?.[otherTargetKey] || '').trim()) {
        errors.push(`pipeline.${id} rule "${name}" uses "${otherTargetKey}" but target is "${target}".`);
      }
      if (!destination) {
        errors.push(`pipeline.${id} rule "${name}" must name a ${targetLabel} with "${targetKey}".`);
      } else if (!definitions.has(destination)) {
        errors.push(`pipeline.${id} rule "${name}" targets undefined ${targetLabel} "${destination}".`);
      }

      conditionFields(rule).forEach((field) => {
        if (suppliedFields.has(field)) return;
        const fieldProducers = producers.filter((producer) => producer.field === field);
        const dependencyProducer = fieldProducers.find((producer) => dependencies.has(producer.stepId));
        if (dependencyProducer) return;
        const knownProducer = fieldProducers[0];
        if (knownProducer) {
          errors.push(`pipeline.${id} rule "${name}" reads field "${field}" produced by step "${knownProducer.stepId}", but depends_on does not include "${knownProducer.stepId}".`);
          return;
        }
        errors.push(`pipeline.${id} rule "${name}" reads field "${field}", but no depends_on step produces it and no source supplies it.`);
      });
    });

    warnings.push(...shadowWarningsForStep(step));
  });

  const sequenceReachable = new Set(sequenceAssignSteps.flatMap((step) => (
    Array.isArray(step?.rules)
      ? step.rules.map((rule: any) => String(rule?.sequence || '').trim()).filter(Boolean)
      : []
  )));
  const sequenceFallbacks = new Set(
    sequenceAssignSteps.map((step) => String(step?.fallback || '').trim()).filter(Boolean),
  );
  if (sequenceAssignSteps.length > 0) {
    sequenceNames.filter((name) => !sequenceReachable.has(name) && !sequenceFallbacks.has(name)).forEach((name) => {
      warnings.push(`Sequence "${name}" is unreachable: no kind: assign rule targets it.`);
    });
  }
  const pipelineReachable = new Set(pipelineAssignSteps.flatMap((step) => (
    Array.isArray(step?.rules)
      ? step.rules.map((rule: Record<string, unknown>) => String(rule?.pipeline || '').trim()).filter(Boolean)
      : []
  )));
  const pipelineFallbacks = new Set(
    pipelineAssignSteps.map((step) => String(step?.fallback || '').trim()).filter(Boolean),
  );
  if (pipelineAssignSteps.length > 0) {
    subpipelineNames
      .filter((name) => !pipelineReachable.has(name) && !pipelineFallbacks.has(name))
      .forEach((name) => {
        warnings.push(`Sub-pipeline "${name}" is unreachable: no kind: assign rule targets it.`);
      });
  }

  return {
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
  };
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

const reachableDependencies = (edges: Map<string, Set<string>>, id: string) => {
  const reachable = new Set<string>();
  const pending = Array.from(edges.get(id) || []);
  while (pending.length > 0) {
    const dependency = pending.pop();
    if (!dependency || reachable.has(dependency)) continue;
    reachable.add(dependency);
    pending.push(...Array.from(edges.get(dependency) || []));
  }
  return reachable;
};

export const validatePipelineGraph = (config: any, options: PipelineGraphOptions = {}) => {
  const steps = pipelineSteps(config);
  const rawSteps = configSteps(config?.pipeline);
  const nestedPipelines = subpipelineDefinitions(config);
  const topLevelIds = rawSteps.map((step) => stepId(step)).filter(Boolean);
  const ids = steps.map((step: any) => stepId(step)).filter(Boolean);
  const idSet = new Set(ids);
  const indexById = new Map(ids.map((id, index) => [id, index]));
  const errors: string[] = [];
  const warnings: string[] = [];
  const explicitEdges = new Map<string, Set<string>>();
  const reviewDependencies = positionalReviewDependencies(config);
  const hasLinkedinSource = (Array.isArray(config?.source?.strategies) ? config.source.strategies : [])
    .some((strategy) => String(strategy?.kind || '').trim() === 'linkedin_profile_search');
  const resolutionStepIds = steps
    .filter((step) => {
      const stepConfig = (
        step?.config && typeof step.config === 'object' ? step.config : step
      ) as Record<string, unknown>;
      return String(stepConfig?.action || '').trim().toLowerCase() === LINKEDIN_RESOLUTION_ACTION;
    })
    .map((step) => stepId(step))
    .filter(Boolean);
  const resolutionGates = steps.filter((step) => (
    String(step?.kind || '').trim() === 'filter'
    && String(step?.type || 'semantic').trim() === 'field_check'
    && (Array.isArray(step?.conditions) ? step.conditions : []).some((condition) => (
      String(condition?.field || '').trim() === 'company_resolution'
      && String(condition?.operator || '').trim() === 'eq'
      && String(condition?.value || '').trim() === 'resolved'
    ))
  ));

  const duplicateIds = (values: string[]) => [...new Set(
    values.filter((value, index) => values.indexOf(value) !== index),
  )];
  duplicateIds(topLevelIds).forEach((id) => {
    errors.push(`pipeline step id "${id}" is defined more than once.`);
  });
  nestedPipelines.forEach((subpipeline) => {
    const name = subpipelineName(subpipeline);
    const children = configSteps(subpipeline?.steps);
    const localIds = children.map((step) => stepId(step)).filter(Boolean);
    children.forEach((child, index) => {
      if (stepId(child)) return;
      errors.push(`sub-pipeline "${name}" step ${index + 1} must have a non-empty id.`);
    });
    duplicateIds(localIds).forEach((id) => {
      errors.push(`sub-pipeline "${name}" step id "${id}" is defined more than once.`);
    });
    children
      .filter((step) => String(step?.kind || '') === SUBPIPELINE_KIND)
      .forEach(() => {
        errors.push(`sub-pipeline "${name}" cannot contain another sub-pipeline.`);
      });
    localIds.forEach((localId) => {
      const namespacedId = namespaceSubpipelineStepId(name, localId);
      if (topLevelIds.includes(namespacedId)) {
        errors.push(`sub-pipeline step id "${namespacedId}" collides with top-level pipeline step id "${namespacedId}".`);
      }
    });
  });
  duplicateIds(ids).forEach((id) => {
    errors.push(`resolved pipeline step id "${id}" is ambiguous because more than one step uses it.`);
  });
  steps
    .filter((step: any) => String(step?.kind || '') === 'extract')
    .forEach((step: any) => {
      const id = stepId(step) || 'unknown';
      const select = String(step?.select || 'first').trim();
      const outputs = step?.outputs && typeof step.outputs === 'object' && !Array.isArray(step.outputs)
        ? step.outputs as Record<string, unknown>
        : {};
      if (Object.keys(outputs).length === 0) {
        errors.push(`pipeline.${id} kind: extract must declare at least one output.`);
      }
      Object.entries(outputs).forEach(([name, definition]) => {
        const type = String((definition as Record<string, unknown>)?.type || '').trim();
        const expected = select === 'all' ? 'string[]' : 'string';
        if (type !== expected) {
          errors.push(`pipeline.${id} extract output "${name}" must have type "${expected}" for select: ${select}.`);
        }
      });
    });
  errors.push(...declaredColumnCollisionErrors(config));

  if (hasLinkedinSource && resolutionStepIds.length === 0) {
    errors.push(`source.linkedin_profile_search requires a pipeline enrich step with action "${LINKEDIN_RESOLUTION_ACTION}".`);
  }
  if (hasLinkedinSource && config?.source?.budget?.max_results === undefined) {
    errors.push('source.linkedin_profile_search requires source.budget.max_results because harvestapi is priced per result.');
  }
  if (hasLinkedinSource && resolutionGates.length === 0) {
    errors.push('source.linkedin_profile_search requires a field_check gate asserting company_resolution eq resolved.');
  }

  const reviewRequiredTokens = new Set(stringArray(config?.policy?.review_required_for)
    .map((token) => token.toLowerCase()));
  const suppliedReviewFields = sourceSuppliedFields(config);
  const reviewFieldProducers = producedFieldsByStep(config);
  steps.forEach((step, index) => {
    const id = stepId(step);
    if (!id) return;
    const kind = String(step?.kind || '').trim().toLowerCase();
    const stepConfig = configRecord(step.config);
    const taskType = String(stepConfig?.task_type || stepConfig?.taskType || '').trim().toLowerCase();
    const reviewRequired = reviewRequiredTokens.has(kind)
      || (taskType !== '' && reviewRequiredTokens.has(taskType));
    if (!reviewRequired) return;

    const review = step?.review && typeof step.review === 'object' && !Array.isArray(step.review)
      ? step.review as Record<string, unknown>
      : {};
    const present = Array.isArray(review.present) ? review.present : [];
    if (present.length === 0) {
      warnings.push(`pipeline.${id} is review-gated but declares no review.present fields.`);
      return;
    }

    const scope = stepSubpipelineName(step);
    const fields = present
      .map((entry) => String(configRecord(entry).field || '').trim())
      .filter(Boolean);
    const required = stringArray(review.require_non_empty);
    required.filter((field) => !fields.includes(field)).forEach((field) => {
      errors.push(`pipeline.${id} review.require_non_empty field "${field}" must also appear in review.present.`);
    });
    fields.forEach((field) => {
      const hasUpstreamProducer = reviewFieldProducers.some((producer) => (
        producer.field === field
        && producer.index < index
        && (
          producer.subpipeline === scope
          || (!producer.subpipeline && Boolean(scope))
        )
      ));
      if (suppliedReviewFields.has(field) || hasUpstreamProducer) return;
      errors.push(`pipeline.${id} review.present field "${field}" is unavailable: no record field or upstream step produces it.`);
    });
  });
  const sequenceReviewSteps = Object.entries(configRecord(config?.sequences))
    .flatMap(([name, sequence]) => configSteps(configRecord(sequence).steps)
      .map((step, index) => ({ name, step, index })));
  sequenceReviewSteps.forEach(({ name, step, index }) => {
    const id = String(step?.id || `step_${index + 1}`).trim();
    const kind = String(step?.kind || '').trim().toLowerCase();
    const stepConfig = configRecord(step.config);
    const taskType = String(stepConfig?.task_type || stepConfig?.taskType || '').trim().toLowerCase();
    const reviewRequired = reviewRequiredTokens.has(kind)
      || (taskType !== '' && reviewRequiredTokens.has(taskType));
    if (!reviewRequired) return;

    const review = step?.review && typeof step.review === 'object' && !Array.isArray(step.review)
      ? step.review as Record<string, unknown>
      : {};
    const present = Array.isArray(review.present) ? review.present : [];
    const nameWithStep = `sequences.${name}.${id}`;
    if (present.length === 0) {
      warnings.push(`${nameWithStep} is review-gated but declares no review.present fields.`);
      return;
    }

    const fields = present
      .map((entry) => String(configRecord(entry).field || '').trim())
      .filter(Boolean);
    const required = stringArray(review.require_non_empty);
    required.filter((field) => !fields.includes(field)).forEach((field) => {
      errors.push(`${nameWithStep} review.require_non_empty field "${field}" must also appear in review.present.`);
    });
    fields.forEach((field) => {
      const hasPipelineProducer = reviewFieldProducers.some((producer) => producer.field === field);
      if (suppliedReviewFields.has(field) || hasPipelineProducer) return;
      errors.push(`${nameWithStep} review.present field "${field}" is unavailable: no record field or upstream step produces it.`);
    });
  });

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

  const reachableByStep = new Map<string, Set<string>>();
  const dependenciesReachableFrom = (id: string) => {
    const cached = reachableByStep.get(id);
    if (cached) return cached;
    const reachable = reachableDependencies(explicitEdges, id);
    reachableByStep.set(id, reachable);
    return reachable;
  };

  resolutionGates.forEach((gate) => {
    if (!hasLinkedinSource || resolutionStepIds.length === 0) return;
    if (resolutionStepIds.some((id) => dependenciesReachableFrom(stepId(gate)).has(id))) return;
    errors.push(`pipeline.${stepId(gate)} must declare depends_on: [${resolutionStepIds[0]}] so LinkedIn records resolve before the company gate runs.`);
  });

  const cycle = findCycle(explicitEdges);
  if (cycle.length > 0) {
    errors.push(`pipeline dependency cycle detected: ${cycle.join(' -> ')}.`);
  }

  const inferred = inferPipelineEdges(config, options);
  inferred.forEach((deps, id) => {
    const reachable = dependenciesReachableFrom(id);
    Array.from(deps).filter((dep) => !reachable.has(dep)).forEach((dep) => {
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
  const flattenedById = new Map(pipelineSteps(config).map((step) => [stepId(step), step]));
  const rawSteps = configSteps(config?.pipeline);
  return {
    ...(config || {}),
    pipeline: rawSteps.map((step) => {
      if (String(step?.kind || '') === SUBPIPELINE_KIND) {
        const name = subpipelineName(step);
        const children = configSteps(step?.steps);
        return {
          ...step,
          steps: children.map((child) => {
            const id = namespaceSubpipelineStepId(name, stepId(child));
            const flattened = flattenedById.get(id);
            const computed = Array.from(inferred.get(id) || []);
            const runsAfter = stringArray(flattened?.runs_after);
            return {
              ...child,
              depends_on: [...new Set([...computed, ...runsAfter])],
            };
          }),
        };
      }
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
