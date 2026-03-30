import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { zStringish } from '../lib/model-json.js';
import { readCSV } from '../lib/csv.js';
import { readYaml } from '../lib/yaml.js';
import { resolveVirtualPath, getCanonicalCsvPath, ensureCanonicalCsvExists } from '../lib/runtime.js';

const zNonEmptyStringish = zStringish.refine((value) => value.length > 0, {
  message: 'Expected non-empty string',
});

const ArgFromColumnBindingSchema = z.object({
  from_column: zNonEmptyStringish,
});

const ArgLiteralBindingSchema = z.object({
  literal: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

export const ArgBindingSchema = z.union([ArgFromColumnBindingSchema, ArgLiteralBindingSchema]);

const SequenceBodyTemplateSchema = z.object({
  template: zStringish,
});

const SequenceBodyTemplateFileSchema = z.object({
  template_file: zNonEmptyStringish,
});

export const SequenceBodyBindingSchema = z.union([
  ArgBindingSchema,
  SequenceBodyTemplateSchema,
  SequenceBodyTemplateFileSchema,
]);

export const ResolvedConditionSchema = z.object({
  mode: z.enum(['only_when', 'skip_when']),
  column: zNonEmptyStringish,
  check: zStringish.default('equals'),
  value: zStringish.default(''),
});

const GenericStepConfigSchema = z.object({
  id: zStringish.optional(),
  args: z.record(z.any()).default({}),
  columns: z.record(zStringish).default({}),
  depends_on: z.array(zStringish).default([]),
  condition: z.union([zStringish, ResolvedConditionSchema, z.record(z.any())]).optional(),
  concurrency: z.coerce.number().int().positive().default(10),
  cache: zStringish.default('30d'),
  prompt: z.union([zStringish, z.object({ file: zNonEmptyStringish })]).optional(),
  files: z.record(zStringish).default({}),
  writes: z.object({
    passed_column: zStringish,
  }).optional(),
}).passthrough();

export const ResolvedSequenceStepSchema = z.object({
  action: zStringish.default('manual'),
  day: z.coerce.number().int().nonnegative().default(0),
  description: zStringish.optional(),
  template_args: z.record(ArgBindingSchema).default({}),
  condition: ResolvedConditionSchema.optional(),
  config: GenericStepConfigSchema.optional(),
}).passthrough();

export const ResolvedSequenceSchema = z.object({
  steps: z.array(ResolvedSequenceStepSchema).default([]),
  on_reply: z.enum(['pause', 'continue']).default('pause'),
  on_bounce: z.enum(['pause', 'continue']).default('pause'),
}).passthrough();

export const ResolvedRubricCriterionSchema = z.object({
  description: zNonEmptyStringish,
  score: z.coerce.number(),
  config: z.object({
    columns: z.array(zStringish).default([]),
    result_column: zStringish.optional(),
  }).passthrough().default({ columns: [] }),
}).passthrough();

export const ResolvedRubricSchema = z.object({
  score_column: zNonEmptyStringish.default('lead_score'),
  breakdown_column: zNonEmptyStringish.default('lead_score_breakdown'),
  max_possible: z.coerce.number().nonnegative().default(0),
  cache: zStringish.default('30d'),
  criteria: z.array(ResolvedRubricCriterionSchema).default([]),
}).passthrough();

export const ResolvedSourceSchema = GenericStepConfigSchema;

export const ResolvedConfigSchema = z.object({
  sources: z.record(ResolvedSourceSchema).default({}),
  filters: z.record(ResolvedSourceSchema).default({}),
  rubric: ResolvedRubricSchema.optional(),
  sequence: ResolvedSequenceSchema.default({
    steps: [],
    on_reply: 'pause',
    on_bounce: 'pause',
  }),
  dependency_order: z.array(z.array(zStringish)).default([]),
  manual_fields: z.array(zStringish).default([]),
  warnings: z.array(zStringish).default([]),
  column_errors: z.array(zStringish).default([]),
});

const slugify = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);

const defaultStepId = (prefix, index, description) => {
  const fromDescription = slugify(description);
  if (fromDescription) return `${prefix}_${fromDescription}`;
  return `${prefix}_${index + 1}`;
};

const stableUniqueIds = (entries, prefix) => {
  const used = new Set();
  return entries.map((entry, index) => {
    const raw = String(entry?.config?.id || entry?.id || defaultStepId(prefix, index, entry?.description));
    const base = slugify(raw) || `${prefix}_${index + 1}`;
    let candidate = base;
    let counter = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${counter}`;
      counter += 1;
    }
    used.add(candidate);
    return candidate;
  });
};

const toStepConfig = (entry) => {
  const config = entry?.config && typeof entry.config === 'object'
    ? { ...entry.config }
    : {};
  return GenericStepConfigSchema.parse(config);
};

const toConditionText = (value) => {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';

  const column = String(value.column || '').trim();
  const check = String(value.check || '').trim();
  const raw = value.value == null ? '' : String(value.value).trim();
  if (column && check) {
    return [column, check, raw].filter(Boolean).join(' ');
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const RESERVED_FILTER_AGGREGATE_COLUMNS = new Set([
  'source_filter_result',
  'source_filter_failures',
]);

const describeStepForError = ({ entry, index, section }) => {
  const description = String(entry?.description || '').trim();
  if (description) return `${section}[${index}] (${description})`;
  return `${section}[${index}]`;
};

const assertNestedConfigBlock = ({ entry, index, section }) => {
  if (entry?.config && typeof entry.config === 'object') return;

  const location = describeStepForError({ entry, index, section });
  throw new Error(
    `${location} is missing a nested config block. `
    + 'Add config: { ... } under this step, or use outbound_config_author to generate valid structure.'
  );
};

const normalizeSequenceStep = (step) => {
  const base = step && typeof step === 'object' ? { ...step } : {};
  if (base.config && typeof base.config === 'object') {
    return {
      ...base,
      config: GenericStepConfigSchema.parse(base.config),
    };
  }
  return ResolvedSequenceStepSchema.parse(base);
};

const buildDependencyOrder = (sources) => {
  const ids = Object.keys(sources || {});
  if (ids.length === 0) return [];

  const inDegree = new Map(ids.map((id) => [id, 0]));
  const graph = new Map(ids.map((id) => [id, []]));

  for (const id of ids) {
    const deps = Array.isArray(sources[id]?.depends_on) ? sources[id].depends_on : [];
    for (const dep of deps) {
      if (!graph.has(dep)) continue;
      graph.get(dep).push(id);
      inDegree.set(id, Number(inDegree.get(id) || 0) + 1);
    }
  }

  const queue = ids.filter((id) => Number(inDegree.get(id) || 0) === 0);
  const ordered = [];

  while (queue.length > 0) {
    const level = [...queue];
    queue.length = 0;
    ordered.push(level);

    for (const id of level) {
      const next = graph.get(id) || [];
      for (const target of next) {
        const remaining = Number(inDegree.get(target) || 0) - 1;
        inDegree.set(target, remaining);
        if (remaining === 0) queue.push(target);
      }
    }
  }

  const seen = new Set(ordered.flat());
  const remainder = ids.filter((id) => !seen.has(id));
  if (remainder.length > 0) ordered.push(remainder);
  return ordered;
};

const SOURCING_BASELINE_COLUMNS = new Set([
  '_row_id', 'source', 'source_query', 'sourced_at',
  'source_filter_result', 'source_filter_failures',
]);

const collectFromColumnRefs = (stepConfig) => {
  const refs = [];
  for (const binding of Object.values(stepConfig.args || {})) {
    if (binding && typeof binding === 'object' && 'from_column' in binding) {
      refs.push(String(binding.from_column));
    }
  }
  for (const binding of Object.values(stepConfig.template_args || {})) {
    if (binding && typeof binding === 'object' && 'from_column' in binding) {
      refs.push(String(binding.from_column));
    }
  }
  return refs;
};

const collectOutputColumns = (stepConfig) =>
  Object.values(stepConfig.columns || {}).map((col) => String(col));

const validateColumnContracts = ({
  searches,
  filters,
  sources,
  dependencyOrder,
  rubric,
  sequence,
  csvHeaders,
}) => {
  const available = new Set(csvHeaders);
  for (const col of SOURCING_BASELINE_COLUMNS) available.add(col);

  const errors = [];

  const checkRefs = (stepId, stepConfig, section) => {
    for (const ref of collectFromColumnRefs(stepConfig)) {
      if (!available.has(ref)) {
        errors.push(`${section} "${stepId}" references from_column "${ref}" but no upstream step declares it as an output.`);
      }
    }
  };

  // Searches: add declared output_fields
  for (const search of searches) {
    const outputFields = Array.isArray(search.output_fields) ? search.output_fields : [];
    for (const field of outputFields) available.add(String(field));
  }

  // Filters: check refs then add outputs (in config order)
  const filterIds = Object.keys(filters);
  for (const filterId of filterIds) {
    const filterConfig = filters[filterId];
    checkRefs(filterId, filterConfig, 'filter');
    for (const col of collectOutputColumns(filterConfig)) available.add(col);
    const passedCol = filterConfig.writes?.passed_column;
    if (passedCol) available.add(String(passedCol));
  }

  // Enrichment sources: check refs then add outputs (in dependency order)
  const orderedSourceIds = dependencyOrder.flat();
  const remainingSources = Object.keys(sources).filter((id) => !orderedSourceIds.includes(id));
  for (const sourceId of [...orderedSourceIds, ...remainingSources]) {
    const sourceConfig = sources[sourceId];
    if (!sourceConfig) continue;
    checkRefs(sourceId, sourceConfig, 'enrich');
    for (const col of collectOutputColumns(sourceConfig)) available.add(col);
  }

  // Rubric: check that criterion columns exist
  if (rubric?.criteria) {
    for (const criterion of rubric.criteria) {
      const cols = Array.isArray(criterion.config?.columns) ? criterion.config.columns : [];
      for (const col of cols) {
        if (!available.has(String(col))) {
          errors.push(`rubric criterion "${criterion.description}" references column "${col}" but no upstream step declares it as an output.`);
        }
      }
    }
  }

  // Sequence: check refs
  const steps = Array.isArray(sequence?.steps) ? sequence.steps : [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const stepConfig = step.config && typeof step.config === 'object' ? step.config : {};
    const label = step.description || `step ${i + 1}`;
    checkRefs(label, stepConfig, 'sequence');
    for (const binding of Object.values(step.template_args || {})) {
      if (binding && typeof binding === 'object' && 'from_column' in binding) {
        const ref = String(binding.from_column);
        if (!available.has(ref)) {
          errors.push(`sequence "${label}" references from_column "${ref}" but no upstream step declares it as an output.`);
        }
      }
    }
  }

  return errors;
};

export const getDependsOnColumns = (sourceConfig) => {
  if (Array.isArray(sourceConfig.depends_on) && sourceConfig.depends_on.length > 0) {
    return sourceConfig.depends_on.map((item) => String(item));
  }

  return Object.values(sourceConfig.args || {})
    .filter((binding) => binding && typeof binding === 'object' && 'from_column' in binding)
    .map((binding) => String(binding.from_column));
};

export const getOutputColumns = (sourceConfig) => {
  const mapped = Object.values(sourceConfig.columns || {}).map((column) => String(column));
  if (mapped.length > 0) return mapped;

  return Object.keys(sourceConfig.outputs || {}).map((column) => String(column));
};

export const resolveBindingValue = (binding, row) => {
  if (!binding || typeof binding !== 'object') return '';

  if ('from_column' in binding) {
    return String(row[binding.from_column] ?? '');
  }

  if ('literal' in binding) {
    return binding.literal == null ? '' : String(binding.literal);
  }

  return '';
};

export const resolveTemplateArgs = (templateArgs, row) =>
  Object.fromEntries(
    Object.entries(templateArgs || {}).map(([key, binding]) => [key, resolveBindingValue(binding, row)])
  );

export const renderTemplate = (template, values) => {
  let rendered = String(template || '');
  for (const [key, value] of Object.entries(values || {})) {
    rendered = rendered.replaceAll(`{{${key}}}`, String(value ?? ''));
  }
  return rendered;
};

export const evaluateResolvedCondition = (condition, row) => {
  if (!condition) return true;

  const actual = String(row[condition.column] ?? '');
  const expected = String(condition.value ?? '');
  const actualLower = actual.trim().toLowerCase();
  const expectedLower = expected.trim().toLowerCase();
  const check = String(condition.check || 'equals').toLowerCase();

  let matched = false;
  if (check === 'not_equals') matched = actualLower !== expectedLower;
  else if (check === 'contains') matched = actualLower.includes(expectedLower);
  else if (check === 'not_contains') matched = !actualLower.includes(expectedLower);
  else if (check === 'is_empty') matched = actualLower.length === 0;
  else if (check === 'not_empty') matched = actualLower.length > 0;
  else matched = actualLower === expectedLower;

  return condition.mode === 'skip_when' ? !matched : matched;
};

export const resolvePrompt = (prompt, listDir) => {
  if (!prompt) return { content: '', filePath: null };

  if (typeof prompt === 'object' && prompt.file) {
    const filePath = resolveVirtualPath({
      listDir,
      filePath: prompt.file,
      allowRelative: false,
    });
    if (!existsSync(filePath)) {
      throw new Error(`Prompt file not found: ${prompt.file}`);
    }
    return { content: readFileSync(filePath, 'utf-8'), filePath };
  }

  return { content: String(prompt), filePath: null };
};

export const buildAdapterArgs = (sourceConfig, row) => {
  const args = {};
  for (const [argName, binding] of Object.entries(sourceConfig.args || {})) {
    if (binding && typeof binding === 'object' && 'from_column' in binding) {
      args[argName] = String(row[binding.from_column] ?? '');
      continue;
    }

    if (binding && typeof binding === 'object' && 'literal' in binding) {
      args[argName] = binding.literal == null ? '' : String(binding.literal);
      continue;
    }

    args[argName] = String(binding ?? '');
  }

  return args;
};

export const loadResolvedConfigFromOutbound = (listDir) => {
  const outbound = readYaml(resolveVirtualPath({
    listDir,
    filePath: '@list/outbound.yaml',
    allowRelative: false,
  }));
  if (outbound._raw) {
    throw new Error('Could not parse outbound.yaml.');
  }

  const enrichEntries = Array.isArray(outbound.enrich) ? outbound.enrich : [];
  const filterEntries = Array.isArray(outbound.source?.filters) ? outbound.source.filters : [];
  const sequenceEntries = Array.isArray(outbound.sequence?.steps) ? outbound.sequence.steps : [];
  const rubricRaw = outbound.rubric;
  const rubricEntries = Array.isArray(rubricRaw)
    ? rubricRaw
    : Array.isArray(rubricRaw?.criteria)
      ? rubricRaw.criteria
      : [];

  const enrichIds = stableUniqueIds(enrichEntries, 'enrich');
  const filterIds = stableUniqueIds(filterEntries, 'filter');

  const sources = {};
  for (let i = 0; i < enrichEntries.length; i += 1) {
    assertNestedConfigBlock({ entry: enrichEntries[i], index: i, section: 'enrich' });
    sources[enrichIds[i]] = {
      ...toStepConfig(enrichEntries[i]),
      id: enrichIds[i],
    };
  }

  const filters = {};
  for (let i = 0; i < filterEntries.length; i += 1) {
    const entry = filterEntries[i] || {};
    assertNestedConfigBlock({ entry, index: i, section: 'source.filters' });
    filters[filterIds[i]] = {
      ...toStepConfig(entry),
      id: filterIds[i],
      condition: toConditionText(entry.condition || entry?.config?.condition),
      writes: {
        passed_column: String(
          RESERVED_FILTER_AGGREGATE_COLUMNS.has(String(entry?.config?.writes?.passed_column || '').trim())
            ? `filter_${slugify(filterIds[i]).replace(/^filter_/, '')}_passed`
            : (entry?.config?.writes?.passed_column
              || `filter_${slugify(filterIds[i]).replace(/^filter_/, '')}_passed`)
        ),
      },
    };
  }

  const rubricCriteria = rubricEntries
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') return null;
      const description = String(entry.description || '').trim();
      if (!description) return null;
      const score = Number(entry.score ?? 0);
      const config = entry.config && typeof entry.config === 'object' ? entry.config : {};
      const resultColumn = String(
        config.result_column || `rubric_${slugify(description) || index + 1}`
      );
      return {
        description,
        score,
        config: {
          columns: Array.isArray(config.columns) ? config.columns.map((col) => String(col)) : [],
          result_column: resultColumn,
        },
      };
    })
    .filter(Boolean);

  const positiveMax = rubricCriteria
    .filter((criterion) => Number(criterion.score || 0) > 0)
    .reduce((sum, criterion) => sum + Number(criterion.score || 0), 0);

  const rubricConfig = outbound.rubric_config && typeof outbound.rubric_config === 'object'
    ? outbound.rubric_config
    : {};

  const sequence = {
    steps: sequenceEntries.map((step) => normalizeSequenceStep(step)),
    on_reply: String(outbound.sequence?.on_reply || 'pause'),
    on_bounce: String(outbound.sequence?.on_bounce || 'pause'),
  };

  const dependencyOrder = buildDependencyOrder(sources);

  const searches = Array.isArray(outbound.source?.searches) ? outbound.source.searches : [];
  ensureCanonicalCsvExists(listDir);
  const csvPath = getCanonicalCsvPath(listDir);
  const csvHeaders = existsSync(csvPath) ? readCSV(csvPath).headers : [];

  const rubric = rubricCriteria.length > 0
    ? {
      score_column: String(rubricConfig.score_column || 'lead_score'),
      breakdown_column: String(rubricConfig.breakdown_column || 'lead_score_breakdown'),
      max_possible: Number(rubricConfig.max_possible || positiveMax),
      cache: String(rubricConfig.cache || '30d'),
      criteria: rubricCriteria,
    }
    : undefined;

  const columnErrors = validateColumnContracts({
    searches,
    filters,
    sources,
    dependencyOrder,
    rubric,
    sequence,
    csvHeaders,
  });

  return ResolvedConfigSchema.parse({
    sources,
    filters,
    rubric,
    sequence,
    dependency_order: dependencyOrder,
    manual_fields: Array.isArray(outbound.resolve_manual_fields)
      ? outbound.resolve_manual_fields.map((item) => String(item))
      : [],
    warnings: Array.isArray(outbound.resolve_warnings)
      ? outbound.resolve_warnings.map((item) => String(item))
      : [],
    column_errors: columnErrors,
  });
};
