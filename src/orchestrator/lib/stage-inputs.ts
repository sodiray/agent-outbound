import { flattenPipelineSteps } from './subpipelines.js';
import { emailHeaderTemplateFields } from './email-headers.js';
import { collectTemplateKeys } from './templates.js';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export type StageInputReference = {
  field: string;
  source: string;
};

export type StageInputDiagnostic = {
  stage: string;
  kind: string;
  missing: StageInputReference[];
  unread: string[];
  requiresInputs: boolean;
  retiredProjection: boolean;
};

type StageLike = Record<string, unknown>;

type StageInputDiagnosticOptions = {
  listDir?: string;
  /** The config's `templates` catalog, so a referenced template's placeholders count as reads. */
  templates?: unknown;
};

const asRecord = (value: unknown): StageLike => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as StageLike
    : {}
);

const text = (value: unknown): string => String(value || '').trim();

const fieldRoot = (value: unknown): string => text(value).split('.')[0] || '';

const strings = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map(fieldRoot).filter(Boolean)
    : []
);

const effectiveConfig = (step: StageLike): StageLike => ({ ...step, ...asRecord(step.config) });

const conditionReferences = (value: unknown, source: string): StageInputReference[] => {
  const conditions: unknown[] = Array.isArray(asRecord(value).conditions) ? asRecord(value).conditions as unknown[] : [];
  return conditions.flatMap((condition) => {
    const field = fieldRoot(asRecord(condition).field);
    return field ? [{ field, source }] : [];
  });
};

const tokens = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return Array.from(value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_.]*)\}|\{([A-Za-z_][A-Za-z0-9_.]*)\}/g))
      .map((match) => fieldRoot(match[1] || match[2]))
      .filter(Boolean);
  }
  if (Array.isArray(value)) return value.flatMap(tokens);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value as StageLike).flatMap(tokens);
};

const promptTokens = (promptFile: unknown, options: StageInputDiagnosticOptions): string[] => {
  const file = text(promptFile);
  if (!file) return [];
  const candidates = isAbsolute(file)
    ? [file]
    : [
      options.listDir ? join(options.listDir, file) : '',
      join(process.cwd(), file),
    ].filter(Boolean);
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) return [];
  try {
    return tokens(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
};

const referencesForInputMap = (value: unknown, source: string): StageInputReference[] => (
  Object.entries(asRecord(value)).flatMap(([name, definition]) => {
    const field = fieldRoot(asRecord(definition).from);
    return field ? [{ field, source: `${source}.${name}` }] : [];
  })
);

const referencesForArgsMap = (value: unknown): StageInputReference[] => (
  Object.entries(asRecord(value)).flatMap(([name, fieldName]) => {
    const field = fieldRoot(fieldName);
    return field ? [{ field, source: `args_map.${name}` }] : [];
  })
);

const referencesForReview = (step: StageLike): StageInputReference[] => {
  const review = asRecord(step.review);
  const fields = strings(step.fields).map((field) => ({ field, source: 'fields' }));
  const present = (Array.isArray(review.present) ? review.present : []).flatMap((entry) => {
    const field = fieldRoot(asRecord(entry).field);
    return field ? [{ field, source: 'review.present' }] : [];
  });
  const required = strings(review.require_non_empty).map((field) => ({ field, source: 'review.require_non_empty' }));
  return [...fields, ...present, ...required];
};

const actionReferences = (step: StageLike, config: StageLike): StageInputReference[] => {
  const action = text(config.action).toLowerCase();
  if (action === 'tool_call') return referencesForArgsMap(config.args_map);
  if (action === 'decision_makers') {
    return ['domain', 'website', 'business_name'].map((field) => ({ field, source: `action:${action}` }));
  }
  if (action === 'linkedin_company_resolution') {
    return ['linkedin_name', 'linkedin_headline', 'linkedin_urn', 'business_name', 'city', 'address', 'source_query', 'sourced_at']
      .map((field) => ({ field, source: `action:${action}` }));
  }
  if (action === 'policy_apply') {
    return [
      'fit_score', 'fit_breakdown_json', 'fit_reasoning', 'fit_evidence_confidence',
      'identity_confidence', 'classification_confidence', 'phone_confidence',
      'buyer_confidence', 'mail_confidence', 'mail_address_ready',
      'timing_score', 'strong_signal_strength', 'strong_signal_count', 'enrichment_cost_usd',
      'treatment_tier', 'candidate_tier', 'suppressed', 'address', 'phone', 'email_primary',
      'contact_name', 'contact_email', 'contact_title', 'website', 'domain', 'vertical',
    ].map((field) => ({ field, source: `action:${action}` }));
  }
  return [];
};

const modelContextReadsInputs = (kind: string, config: StageLike): boolean => {
  if (kind === 'filter') return text(config.type || 'semantic') === 'semantic';
  if (kind === 'score') return true;
  if (kind === 'compose') return false;
  if (kind === 'enrich' || kind === 'generate') {
    const action = text(config.action).toLowerCase();
    return action === '' || !['tool_call', 'decision_makers', 'linkedin_company_resolution', 'policy_apply'].includes(action);
  }
  if (kind === 'assign') {
    return (Array.isArray(config.rules) ? config.rules : [])
      .some((rule) => text(asRecord(rule).type || 'field_check') === 'semantic');
  }
  return false;
};

export const declaredStageInputs = (stepValue: unknown): string[] => {
  const step = asRecord(stepValue);
  const config = effectiveConfig(step);
  const inputs = config.inputs;
  const explicit = Array.isArray(inputs)
    ? strings(inputs)
    : referencesForInputMap(inputs, 'inputs').map((reference) => reference.field);
  const contactSourceField = text(step.kind).toLowerCase() === 'contact_source'
    ? [fieldRoot(config.field)].filter(Boolean)
    : [];
  return [...new Set([...explicit, ...contactSourceField])];
};

export type ResolvedStageInputs = {
  values: Record<string, unknown>;
  missingRequired: string[];
};

const valueAtPath = (source: Record<string, unknown>, path: string): unknown => (
  path.split('.').filter(Boolean).reduce<unknown>((current, segment) => (
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)[segment]
      : undefined
  ), source)
);

const absentInputValue = (value: unknown): boolean => (
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
);

/** Resolve the declared capability map without exposing the rest of the record. */
export const resolveStageInputs = ({
  step: stepValue,
  record,
}: {
  step: unknown;
  record: Record<string, unknown>;
}): ResolvedStageInputs => {
  const step = asRecord(stepValue);
  const config = effectiveConfig(step);
  const inputs = config.inputs;
  if (Array.isArray(inputs)) {
    const values = Object.fromEntries(strings(inputs).map((field) => [field, record[field]]));
    return { values, missingRequired: [] };
  }
  const entries = Object.entries(asRecord(inputs)).map(([name, definition]) => {
    const input = asRecord(definition);
    const hasValue = Object.prototype.hasOwnProperty.call(input, 'value');
    const value = hasValue ? input.value : valueAtPath(record, text(input.from));
    return { name, value, required: input.required !== false };
  });
  return {
    values: Object.fromEntries(entries.map(({ name, value }) => [name, value])),
    missingRequired: entries
      .filter(({ value, required }) => required && absentInputValue(value))
      .map(({ name }) => name),
  };
};

/**
 * Fields a referenced template interpolates. The template body is authored config, so its
 * `{{placeholders}}` are reads exactly as an args_map entry is — without this, a step that
 * declares an input its template uses is reported as declaring an unread input. Every version
 * is scanned, since `template_version` may select any of them. The placeholder grammar is
 * `collectTemplateKeys`, deliberately reused rather than restated: a second copy of it would
 * drift from the renderer and warn about the wrong fields.
 */
const templatePlaceholderFields = (templateRef: unknown, templates: unknown): string[] => {
  const ids = (Array.isArray(templateRef) ? templateRef : [templateRef]).map(text).filter(Boolean);
  if (ids.length === 0) return [];
  const catalog = asRecord(templates);
  return [...new Set(ids.flatMap((id) => {
    const versions = asRecord(catalog[id]).versions;
    return (Array.isArray(versions) ? versions : []).flatMap((version) => {
      const entry = asRecord(version);
      return collectTemplateKeys(`${text(entry.subject)}\n${text(entry.body)}`);
    });
  }).map(fieldRoot).filter(Boolean))];
};

export const stageInputReferences = (stepValue: unknown, options: StageInputDiagnosticOptions = {}): StageInputReference[] => {
  const step = asRecord(stepValue);
  const config = effectiveConfig(step);
  const kind = text(step.kind).toLowerCase();
  const direct = [
    ...conditionReferences(step, 'conditions'),
    ...conditionReferences(step.when, 'when'),
    ...referencesForReview(step),
    ...tokens(step.description).map((field) => ({ field, source: 'description template' })),
    ...tokens(config.prompt_args).map((field) => ({ field, source: 'prompt_args template' })),
    ...tokens(step.template).map((field) => ({ field, source: 'template' })),
    ...templatePlaceholderFields(step.template, options.templates).map((field) => ({ field, source: 'template body' })),
    ...tokens(step.variables).map((field) => ({ field, source: 'variables template' })),
    ...emailHeaderTemplateFields(config.headers).map((field) => ({ field, source: 'headers template' })),
    ...promptTokens(config.prompt_file, options).map((field) => ({ field, source: `prompt_file:${text(config.prompt_file)}` })),
    ...referencesForArgsMap(config.args_map),
    ...actionReferences(step, config),
  ];
  if (kind === 'extract') {
    const from = Array.isArray(config.from) ? config.from : [config.from];
    return [
      ...direct,
      ...from.map(fieldRoot).filter(Boolean).map((field) => ({ field, source: 'from' })),
      { field: 'domain', source: 'extract ranking' },
      { field: 'website', source: 'extract ranking' },
    ];
  }
  if (kind === 'contact_source') {
    return [
      ...direct,
      ...[fieldRoot(config.field)].filter(Boolean).map((field) => ({ field, source: 'contact source' })),
    ];
  }
  if (kind === 'compose') return [...direct, ...referencesForInputMap(config.inputs, 'inputs')];
  if (kind === 'assign') {
    const rules = Array.isArray(config.rules) ? config.rules : [];
    return [
      ...direct,
      { field: 'sequence_status', source: 'assignment state' },
      ...rules.flatMap((rule) => [
        ...conditionReferences(rule, 'rule.conditions'),
        ...tokens(asRecord(rule).condition).map((field) => ({ field, source: 'rule condition template' })),
      ]),
    ];
  }
  if (modelContextReadsInputs(kind, config)) {
    return [
      ...direct,
      ...declaredStageInputs(step).map((field) => ({ field, source: 'model context' })),
    ];
  }
  return direct;
};

const diagnosticFor = ({ stage, kind, step, options }: {
  stage: string;
  kind: string;
  step: StageLike;
  options: StageInputDiagnosticOptions;
}): StageInputDiagnostic | null => {
  const declared = new Set(declaredStageInputs(step));
  const reads = stageInputReferences(step, options)
    .filter((reference) => reference.field)
    .filter((reference, index, all) => all.findIndex((candidate) => (
      candidate.field === reference.field && candidate.source === reference.source
    )) === index);
  const missing = reads.filter((reference) => !declared.has(reference.field));
  const readFields = new Set(reads.map((reference) => reference.field));
  const unread = [...declared].filter((field) => !readFields.has(field)).sort();
  const requiresInputs = modelContextReadsInputs(kind, effectiveConfig(step)) && declared.size === 0;
  const retiredProjection = text(effectiveConfig(step).context_projection) !== '';
  if (missing.length === 0 && unread.length === 0 && !requiresInputs && !retiredProjection) return null;
  return { stage, kind, missing, unread, requiresInputs, retiredProjection };
};

const sequenceSteps = (config: StageLike): Array<{ stage: string; step: StageLike }> => (
  Object.entries(asRecord(config.sequences)).flatMap(([name, sequence]) => {
    const steps: unknown[] = Array.isArray(asRecord(sequence).steps) ? asRecord(sequence).steps as unknown[] : [];
    return steps.flatMap((step, index) => {
      const record = asRecord(step);
      const id = text(record.id) || `step_${index + 1}`;
      return [{ stage: `sequences.${name}.${id}`, step: record }];
    });
  })
);

export const stageInputDiagnostics = (configValue: unknown, options: StageInputDiagnosticOptions = {}): StageInputDiagnostic[] => {
  const config = asRecord(configValue);
  const pipeline = flattenPipelineSteps(config).flatMap((step) => {
    const record = asRecord(step);
    const id = text(record.id);
    return id ? [{ stage: `pipeline.${id}`, step: record }] : [];
  });
  const withTemplates = { ...options, templates: options.templates ?? config.templates };
  return [...pipeline, ...sequenceSteps(config)]
    .map(({ stage, step }) => diagnosticFor({ stage, kind: text(step.kind), step, options: withTemplates }))
    .filter((diagnostic): diagnostic is StageInputDiagnostic => Boolean(diagnostic));
};

export const stageInputDiagnosticMessages = (
  config: unknown,
  options: StageInputDiagnosticOptions = {},
): { errors: string[]; warnings: string[] } => {
  const diagnostics = stageInputDiagnostics(config, options);
  return {
    errors: diagnostics.flatMap((diagnostic) => {
      const fieldErrors = diagnostic.missing.length === 0
        ? []
        : (() => {
          const byField = new Map<string, string[]>();
          diagnostic.missing.forEach(({ field, source }) => {
            byField.set(field, [...(byField.get(field) || []), source]);
          });
          const detail = [...byField.entries()]
            .map(([field, sources]) => `"${field}" (${[...new Set(sources)].join(', ')})`)
            .join(', ');
          return [`${diagnostic.stage} (${diagnostic.kind}) reads undeclared input fields: ${detail}.`];
        })();
      const modelError = diagnostic.requiresInputs
        ? [`${diagnostic.stage} (${diagnostic.kind}) must declare at least one input for its model context.`]
        : [];
      const projectionError = diagnostic.retiredProjection
        ? [`${diagnostic.stage} (${diagnostic.kind}) context_projection is replaced by declared inputs.`]
        : [];
      return [...fieldErrors, ...modelError, ...projectionError];
    }),
    warnings: diagnostics.flatMap((diagnostic) => (
      diagnostic.unread.length > 0
        ? [`${diagnostic.stage} (${diagnostic.kind}) declares unread inputs: ${diagnostic.unread.map((field) => `"${field}"`).join(', ')}.`]
        : []
    )),
  };
};

export class UndeclaredStageInputError extends Error {
  constructor({ stageId, field }: { stageId: string; field: string }) {
    super(`Stage "${stageId}" attempted to read undeclared input "${field}".`);
    this.name = 'UndeclaredStageInputError';
  }
}

export const stageInputRecord = ({ step, record }: { step: unknown; record: Record<string, unknown> }): Record<string, unknown> => {
  const stage = asRecord(step);
  const stageId = text(stage.id) || text(stage.kind) || 'unknown';
  const allowed = new Set(declaredStageInputs(stage));
  return new Proxy(record, {
    get(target, property, receiver) {
      if (typeof property === 'symbol') return Reflect.get(target, property, receiver);
      const field = String(property);
      if (field === '_row_id' || field === 'id') return Reflect.get(target, property, receiver);
      if (!allowed.has(field)) throw new UndeclaredStageInputError({ stageId, field });
      return Reflect.get(target, property, receiver);
    },
    has(_target, property) {
      if (typeof property === 'symbol') return false;
      const field = String(property);
      if (field === '_row_id' || field === 'id' || allowed.has(field)) return true;
      throw new UndeclaredStageInputError({ stageId, field });
    },
  });
};
