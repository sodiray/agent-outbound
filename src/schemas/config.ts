import { z } from 'zod';
import {
  NON_WORKING_DAY_POLICY_VALUES,
  normalizeWorkingDayToken,
  SEQUENCE_WORKING_DAY_VALUES,
} from '../orchestrator/lib/working-days.js';
import { validatePipelineGraph, validateRouterConfig } from '../orchestrator/lib/pipeline-graph.js';
import { LEGACY_MODEL_HINTS } from '../orchestrator/runtime/models.js';

export const ProviderModelSchema = z.string().trim().superRefine((value, ctx) => {
  const raw = String(value || '').trim();
  if (!raw) return;
  const legacy = LEGACY_MODEL_HINTS[raw.toLowerCase()];
  if (legacy) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Model shorthand "${raw}" is no longer supported. Use "${legacy}" instead of "${raw}".`,
    });
    return;
  }
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Model "${raw}" must be provider/model-id.`,
    });
    return;
  }
  const provider = raw.slice(0, slash).trim();
  const modelId = raw.slice(slash + 1).trim();
  if (!provider || !modelId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Model "${raw}" must be provider/model-id.`,
    });
  }
});

export const ToolSpecSchema = z.object({
  server: z.string().default(''),
  toolkits: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  search: z.string().default(''),
  limit: z.coerce.number().int().positive().max(200).default(25),
}).partial().default({});

export const IdempotencySchema = z.object({
  key_source: z.array(z.string()).default([]),
  scope: z.enum(['list', 'global']).default('list'),
}).partial().default({});

const EnrichmentOutputDefSchema = z.object({
  type: z.enum(['string', 'number', 'integer', 'boolean']),
  description: z.string(),
  enum: z.array(z.string()).optional(),
});

const ToolCatalogEntrySchema = z.object({
  description: z.string().default(''),
  parameters: z.any().default({}),
}).partial().default({});

export const StepConfigSchema = z.object({
  description: z.string().default(''),
  id: z.string().default(''),
  model: ProviderModelSchema.optional(),
  step_budget: z.coerce.number().int().min(1).max(40).default(8),
  concurrency: z.coerce.number().int().min(1).max(200).default(10),
  cache: z.string().default(''),
  tool: ToolSpecSchema.optional(),
  args: z.record(z.any()).default({}),
  // Deterministic tool_call path for send_email / enrich-like steps:
  // action=tool_call + args_map (tool arg <- record field) + output_map
  // (output field <- result path). Without these, Zod would strip them and
  // channel execution would fall through to the LLM agent path.
  action: z.string().default(''),
  args_map: z.record(z.string()).default({}),
  output_map: z.record(z.string()).default({}),
  daily_cap: z.coerce.number().int().min(0).optional(),
  draft_approval_required: z.boolean().optional(),
  outputs: z.record(EnrichmentOutputDefSchema).default({}),
  columns: z.record(z.string()).optional(), // Deprecated alias; prefer config.outputs.
  depends_on: z.array(z.string()).default([]),
  prompt_file: z.string().default(''),
  prompt_args: z.record(z.any()).default({}),
  condition: z.string().default(''),
  idempotency: IdempotencySchema.optional(),
}).partial().default({});

const SourceMaxResultsSchema = z.coerce.number().int().min(1).max(5000).default(100);

export const SourceSearchSchema = z.object({
  id: z.string().default(''),
  description: z.string().default(''),
  query: z.string().default(''),
  model: ProviderModelSchema.optional(),
  max_results: SourceMaxResultsSchema,
  tool: ToolSpecSchema.optional(),
  args: z.record(z.any()).default({}),
  output_map: z.record(z.string()).default({}),
  pagination: z.record(z.any()).optional(),
  manual_results: z.array(z.record(z.any())).default([]),
}).partial().default({});

const SourceStrategyBaseSchema = z.object({
  id: z.string().default(''),
  description: z.string().default(''),
  tool: ToolSpecSchema,
  max_results: SourceMaxResultsSchema,
  output_map: z.record(z.string()).default({}),
}).partial();

const exactlyOneOf = (left: string, right: string, label: string) => (value: any, ctx: z.RefinementCtx) => {
  const hasLeft = value?.[left] !== undefined;
  const hasRight = value?.[right] !== undefined;
  if (hasLeft === hasRight) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${label} must include exactly one of ${left} or ${right}.`,
      path: [left],
    });
  }
};

const KeywordGeoStrategySchema = SourceStrategyBaseSchema.extend({
  kind: z.literal('keyword_geo'),
  keywords: z.array(z.string()).optional(),
  keywords_from: z.string().optional(),
  geos: z.array(z.string()).optional(),
  geos_from: z.string().optional(),
  excluded_types: z.array(z.string()).default([]),
  max_pages: z.coerce.number().int().min(1).max(3).default(1),
});

const GeoTileSchema = z.object({
  lat: z.coerce.number(),
  lng: z.coerce.number(),
  radius_m: z.coerce.number().positive(),
});

const GeoTilesStrategySchema = SourceStrategyBaseSchema.extend({
  kind: z.literal('geo_tiles'),
  tiles: z.array(GeoTileSchema).optional(),
  tiles_from: z.string().optional(),
  floor_m: z.coerce.number().positive().default(60),
  rank: z.enum(['distance', 'popularity']).default('distance'),
  types: z.array(z.string()).default([]),
  excluded_types: z.array(z.string()).default([]),
});

const LinkedinProfileSearchStrategySchema = SourceStrategyBaseSchema.extend({
  kind: z.literal('linkedin_profile_search'),
  search: z.string().trim().min(1),
  locations: z.array(z.string().trim().min(1)).min(1),
  profile_scraper_mode: z.string().trim().min(1).default('Full'),
  start_page: z.coerce.number().int().min(1).default(1),
  take_pages: z.coerce.number().int().min(1).default(1),
  profileScraperMode: z.string().trim().min(1).optional(),
  startPage: z.coerce.number().int().min(1).optional(),
  takePages: z.coerce.number().int().min(1).optional(),
  maxItems: SourceMaxResultsSchema.optional(),
});

const SOURCE_STRATEGY_TOOL_ARGUMENTS = {
  keyword_geo: new Set(['query', 'max_results', 'max_pages']),
  geo_tiles: new Set(['lat', 'lng', 'radius_m', 'rank', 'types', 'max_results']),
  linkedin_profile_search: new Set([
    'search',
    'locations',
    'profileScraperMode',
    'startPage',
    'takePages',
    'maxItems',
  ]),
};

const SOURCE_TOOL_REQUIRED_ARGUMENTS = {
  MAPS_NEARBY_SEARCH: ['lat', 'lng', 'radius_m'],
};

export const StrategySchema = z.discriminatedUnion('kind', [
  KeywordGeoStrategySchema,
  GeoTilesStrategySchema,
  LinkedinProfileSearchStrategySchema,
]).superRefine((value, ctx) => {
  if (value.kind === 'keyword_geo') {
    exactlyOneOf('keywords', 'keywords_from', 'keyword_geo')(value, ctx);
    exactlyOneOf('geos', 'geos_from', 'keyword_geo')(value, ctx);
  }
  if (value.kind === 'geo_tiles') {
    exactlyOneOf('tiles', 'tiles_from', 'geo_tiles')(value, ctx);
  }
  const suppliedArguments = SOURCE_STRATEGY_TOOL_ARGUMENTS[value.kind];
  const tools = Array.isArray(value.tool?.tools) ? value.tool.tools : [];
  tools.forEach((tool, index) => {
    const toolSlug = String(tool || '').trim().toUpperCase();
    const requiredArguments = SOURCE_TOOL_REQUIRED_ARGUMENTS[
      toolSlug as keyof typeof SOURCE_TOOL_REQUIRED_ARGUMENTS
    ];
    if (!requiredArguments) return;
    const missingArguments = requiredArguments.filter((argument) => !suppliedArguments.has(argument));
    if (missingArguments.length === 0) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `source.strategy ${value.kind} cannot use tool "${toolSlug}": strategy does not supply required arguments ${missingArguments.join(', ')}.`,
      path: ['tool', 'tools', index],
    });
  });
});

const SourceBudgetSchema = z.object({
  max_calls: z.coerce.number().int().min(0).optional(),
  max_results: z.coerce.number().int().min(0).optional(),
}).partial().default({});

const FieldCheckConditionSchema = z.object({
  field: z.string(),
  operator: z.enum(['is_not_empty', 'is_empty', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'matches', 'not_matches', 'in', 'not_in']),
  value: z.any().optional(),
  value_file: z.string().min(1).optional(),
}).superRefine((condition, ctx) => {
  if (condition.value !== undefined && condition.value_file !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'field_check condition cannot specify both value and value_file.',
      path: ['value_file'],
    });
  }
  if (condition.value_file !== undefined && condition.operator !== 'in' && condition.operator !== 'not_in') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'field_check value_file requires operator "in" or "not_in".',
      path: ['value_file'],
    });
  }
});

const FieldCheckPredicateSchema = z.object({
  match: z.enum(['any', 'all']).default('all'),
  conditions: z.array(FieldCheckConditionSchema).default([]),
}).partial({ match: true, conditions: true });

// Deterministic pre-insert exclusion: a sourced row matching ANY rule is never
// persisted — no record, no embedding, no dedup spend. For things that are not
// businesses at all (ATMs, restrooms, parks). Real-but-off-ICP businesses belong
// in pipeline gates instead, where the drop stays visible and recoverable.
const SourceExcludeRuleSchema = z.object({
  description: z.string().default(''),
  match: z.enum(['any', 'all']).default('all'),
  conditions: z.array(FieldCheckConditionSchema).default([]),
}).partial({ description: true, match: true, conditions: true });

const WorkingDaySchema = z.preprocess((value) => normalizeWorkingDayToken(value), z.enum(SEQUENCE_WORKING_DAY_VALUES));

const WorkingDaysSchema = z.preprocess((value) => {
  if (value === undefined) return value;
  if (!Array.isArray(value)) return value;
  return value.map((entry) => normalizeWorkingDayToken(entry));
}, z.array(WorkingDaySchema)
  .min(1, 'working_days must include at least one day.')
  .transform((days) => Array.from(new Set(days))));

const PipelineSequenceStepBaseSchema = z.object({
  id: z.string().min(1),
  description: z.string().default(''),
  depends_on: z.array(z.string()).default([]),
  runs_after: z.array(z.string()).default([]),
});

const PipelineFilterStepSchema = z.object({
  kind: z.literal('filter'),
  id: z.string().default(''),
  description: z.string().default(''),
  depends_on: z.array(z.string()).default([]),
  runs_after: z.array(z.string()).default([]),
  type: z.enum(['field_check', 'semantic']).default('semantic'),
  match: FieldCheckPredicateSchema.shape.match,
  conditions: FieldCheckPredicateSchema.shape.conditions,
  on_fail: z.enum(['drop', 'flag']).default('drop'),
  model: ProviderModelSchema.optional(),
  condition: z.string().default(''),
  // Opt-in chain-of-thought for reasoning models (default off = fast/cheap).
  reasoning: z.boolean().optional(),
}).partial({ description: true, depends_on: true, runs_after: true, match: true, conditions: true, on_fail: true, model: true, condition: true, reasoning: true });

const PipelineAssignRuleSchema = z.object({
  id: z.string().default(''),
  sequence: z.string().min(1).optional(),
  pipeline: z.string().min(1).optional(),
  type: z.enum(['field_check', 'semantic']).default('field_check'),
  match: FieldCheckPredicateSchema.shape.match,
  conditions: FieldCheckPredicateSchema.shape.conditions,
  description: z.string().default(''),
  condition: z.string().default(''),
  model: ProviderModelSchema.optional(),
  reasoning: z.boolean().optional(),
}).partial({ id: true, type: true, match: true, conditions: true, description: true, condition: true, model: true, reasoning: true });

const PipelineAssignStepSchema = z.object({
  kind: z.literal('assign'),
  id: z.string().min(1),
  description: z.string().default(''),
  depends_on: z.array(z.string()).default([]),
  runs_after: z.array(z.string()).default([]),
  target: z.enum(['sequence_name', 'pipeline_name']),
  fallback: z.string().min(1),
  rules: z.array(PipelineAssignRuleSchema).default([]),
  batch_size: z.coerce.number().int().min(1).max(200).default(10),
}).partial({ description: true, depends_on: true, runs_after: true, rules: true, batch_size: true });

const PipelineReviewStepSchema = z.object({
  kind: z.literal('review'),
  id: z.string().min(1),
  description: PipelineFilterStepSchema.shape.description,
  depends_on: PipelineFilterStepSchema.shape.depends_on,
  runs_after: PipelineFilterStepSchema.shape.runs_after,
  label: z.string().default(''),
  fields: z.array(z.string()).default([]),
  when: FieldCheckPredicateSchema.optional(),
});

const PipelineEnrichmentStepSchema = z.object({
  kind: z.literal('enrich'),
  id: z.string().default(''),
  description: z.string().default(''),
  depends_on: z.array(z.string()).default([]),
  runs_after: z.array(z.string()).default([]),
  model: ProviderModelSchema.optional(),
  // Opt-in chain-of-thought for reasoning models (default off = fast/cheap).
  reasoning: z.boolean().optional(),
  step_budget: z.coerce.number().int().min(1).max(40).default(8),
  concurrency: z.coerce.number().int().min(1).max(200).default(10),
  cache: z.string().default(''),
  // Explicit staleness override: bump this string to force a recompute; otherwise
  // the staleness hash is derived from the step's material fields only, so cosmetic
  // edits (description, concurrency, etc.) never re-run already-enriched records.
  cache_key: z.string().default(''),
  action: z.string().default(''),
  tool: ToolSpecSchema.optional(),
  args: z.record(z.any()).default({}),
  // action: tool_call only — deterministic single tool execution, no LLM.
  // args_map: tool arg <- record field. output_map: output field <- result path.
  args_map: z.record(z.string()).default({}),
  output_map: z.record(z.string()).default({}),
  outputs: z.record(EnrichmentOutputDefSchema).default({}),
  columns: z.record(z.string()).optional(),
  on_error: z.enum(['fail', 'empty']).default('fail'),
  when: FieldCheckPredicateSchema.optional(),
  prompt_file: z.string().default(''),
  prompt_args: z.record(z.any()).default({}),
  idempotency: IdempotencySchema.optional(),
}).partial({
  description: true,
  depends_on: true,
  runs_after: true,
  model: true,
  step_budget: true,
  concurrency: true,
  cache: true,
  cache_key: true,
  action: true,
  tool: true,
  args: true,
  args_map: true,
  output_map: true,
  outputs: true,
  columns: true,
  on_error: true,
  when: true,
  prompt_file: true,
  prompt_args: true,
  idempotency: true,
});

const PipelineGenerateStepSchema = z.object({
  kind: z.literal('generate'),
  id: z.string(),
  description: z.string().optional(),
  label: z.string().optional(),
  depends_on: PipelineEnrichmentStepSchema.shape.depends_on,
  model: PipelineEnrichmentStepSchema.shape.model,
  reasoning: PipelineEnrichmentStepSchema.shape.reasoning,
  step_budget: PipelineEnrichmentStepSchema.shape.step_budget,
  concurrency: PipelineEnrichmentStepSchema.shape.concurrency,
  cache_key: PipelineEnrichmentStepSchema.shape.cache_key,
  action: PipelineEnrichmentStepSchema.shape.action,
  tool: PipelineEnrichmentStepSchema.shape.tool,
  args: PipelineEnrichmentStepSchema.shape.args,
  outputs: PipelineEnrichmentStepSchema.shape.outputs,
  on_error: z.enum(['fail', 'empty']).default('empty'),
  when: PipelineEnrichmentStepSchema.shape.when,
  prompt_file: PipelineEnrichmentStepSchema.shape.prompt_file,
  prompt_args: PipelineEnrichmentStepSchema.shape.prompt_args,
});

const PipelineWaitStepSchema = PipelineSequenceStepBaseSchema.extend({
  kind: z.literal('wait'),
  after: z.string()
    .trim()
    .regex(/^(?:\d+(?:\.\d+)?|\.\d+)[dhw]$/i, 'wait.after must be a duration using d, h, or w (for example, 3d).')
    .refine((value) => Number(value.slice(0, -1)) > 0, 'wait.after must be greater than zero.'),
  working_days: WorkingDaysSchema.default([...SEQUENCE_WORKING_DAY_VALUES]),
  non_working_day_policy: z.enum(NON_WORKING_DAY_POLICY_VALUES).default('shift_forward'),
});

const PipelineExternalStepFields = {
  description: PipelineSequenceStepBaseSchema.shape.description,
  depends_on: PipelineSequenceStepBaseSchema.shape.depends_on,
  runs_after: PipelineSequenceStepBaseSchema.shape.runs_after,
  side_effecting: z.literal(true, {
    errorMap: () => ({ message: 'Externally emitting steps must declare side_effecting: true.' }),
  }),
  template: z.union([z.string(), z.array(z.string())]).optional(),
  template_version: z.coerce.number().int().min(1).optional(),
  variables: z.record(z.any()).default({}),
  uses_asset: z.string().optional(),
  draft_approval_required: z.boolean().optional(),
  config: StepConfigSchema.default({}),
};

const PipelineSendEmailStepSchema = z.object({
  kind: z.literal('send_email'),
  id: z.string().min(1),
  ...PipelineExternalStepFields,
});

const PipelineSendSmsStepSchema = z.object({
  kind: z.literal('send_sms'),
  id: z.string().min(1),
  ...PipelineExternalStepFields,
});

const PipelineLinkedinConnectStepSchema = z.object({
  kind: z.literal('linkedin_connect'),
  id: z.string().min(1),
  ...PipelineExternalStepFields,
});

const PipelineManualTaskStepSchema = PipelineSequenceStepBaseSchema.extend({
  kind: z.literal('manual_task'),
  side_effecting: z.boolean().default(false),
  config: StepConfigSchema.default({}),
});

const PipelineExitStepSchema = PipelineFilterStepSchema.omit({ kind: true }).extend({
  kind: z.literal('exit'),
});

const ExecutablePipelineStepSchemas = [
  PipelineEnrichmentStepSchema,
  PipelineGenerateStepSchema,
  PipelineFilterStepSchema,
  PipelineAssignStepSchema,
  PipelineReviewStepSchema,
  PipelineWaitStepSchema,
  PipelineSendEmailStepSchema,
  PipelineSendSmsStepSchema,
  PipelineLinkedinConnectStepSchema,
  PipelineManualTaskStepSchema,
  PipelineExitStepSchema,
] as const;

export const ExecutablePipelineStepSchema = z.discriminatedUnion('kind', ExecutablePipelineStepSchemas);

const SubpipelineStepSchema = z.discriminatedUnion('kind', [
  PipelineEnrichmentStepSchema,
  PipelineFilterStepSchema,
  PipelineReviewStepSchema,
  PipelineWaitStepSchema,
  PipelineSendEmailStepSchema,
  PipelineSendSmsStepSchema,
  PipelineLinkedinConnectStepSchema,
  PipelineManualTaskStepSchema,
  PipelineExitStepSchema,
]);

const PipelineSubpipelineStepSchema = z.object({
  kind: z.literal('pipeline'),
  id: z.string()
    .trim()
    .min(1)
    .refine((value) => !value.includes('.'), 'Sub-pipeline ids cannot contain "." because event ids use "<subpipeline>.<step_id>".'),
  description: z.string().default(''),
  manual: z.boolean().default(false),
  steps: z.array(SubpipelineStepSchema).default([]),
}).partial({ description: true, manual: true, steps: true });

export const PipelineStepSchema = z.discriminatedUnion('kind', [
  ...ExecutablePipelineStepSchemas,
  PipelineSubpipelineStepSchema,
]);

export const SequenceStepSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object') return value;
  const step: any = { ...(value as any) };
  if (!step.defer && step.condition_on_defer && typeof step.condition_on_defer === 'object') {
    const wait = String(step.condition_on_defer.wait_up_to || '14d');
    const timeout = String(step.condition_on_defer.on_timeout || 'skip_step');
    step.defer = `Wait up to ${wait}. On timeout: ${timeout}.`;
  }
  if (step.delay_days !== undefined && step.day === undefined) {
    step.day = step.delay_days;
  }
  return step;
}, z.object({
  id: z.string().optional(),
  description: z.string().default(''),
  template: z.union([z.string(), z.array(z.string())]).optional(),
  template_version: z.coerce.number().int().min(1).optional(),
  variables: z.record(z.any()).default({}),
  uses_asset: z.string().optional(),
  draft_approval_required: z.boolean().optional(),
  day: z.coerce.number().int().min(0).max(365).default(0),
  condition: z.string().optional(),
  defer: z.string().optional(),
  config: z.object({
    tool: ToolSpecSchema.optional(),
    disposition_options: z.array(z.string()).optional(),
    model: ProviderModelSchema.optional(),
    step_budget: z.coerce.number().int().min(1).max(40).optional(),
    concurrency: z.coerce.number().int().min(1).max(200).optional(),
    cache: z.string().optional(),
    outputs: z.record(EnrichmentOutputDefSchema).optional(),
    columns: z.record(z.string()).optional(),
    idempotency: IdempotencySchema.optional(),
  }).partial().default({}),
}));

const TriggerDecaySchema = z.object({
  window_days: z.coerce.number().int().min(1).max(365).default(30),
  floor: z.coerce.number().min(0).max(1).default(0),
  mode: z.enum(['linear']).default('linear'),
}).partial().default({});

export const ScoringCriterionSchema = z.object({
  id: z.string().default(''),
  description: z.string().default(''),
  condition: z.string().default(''),
  weight: z.coerce.number().default(1),
  reward_only: z.boolean().default(false),
  anchor_column: z.string().default(''),
  decay: TriggerDecaySchema.optional(),
  config: StepConfigSchema.default({}),
}).partial().default({});

// A single lead score (0-100). One weighted criteria list, one LLM pass.
// Legacy fit/trigger/priority configs are normalized into this shape at load time.
const ScoreSchema = z.object({
  description: z.string().default(''),
  model: ProviderModelSchema.optional(),
  // ternary: criteria graded yes/partial/no (1 / 0.5 / 0) — coarse, saturates
  // easily. graded: integer 0-10 per criterion with anchored skeptical
  // calibration — granular, spreads the distribution.
  grading: z.enum(['ternary', 'graded']).default('ternary'),
  criteria: z.array(ScoringCriterionSchema).default([]),
  // Leads scoring below this threshold are dropped at scoring time
  // (gate "score_minimum"). 0 / unset disables the floor.
  minimum: z.coerce.number().min(0).max(100).default(0),
}).partial().default({});

const SuppressionSchema = z.object({
  global_list: z.string().default(''),
}).partial().default({});

const TerritorySchema = z.object({
  home_base: z.string().default(''),
  max_visits_per_day: z.coerce.number().int().min(1).max(100).default(12),
  business_hours: z.record(z.string()).default({}),
  preferred_visit_days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).default([]),
  max_drive_radius_miles: z.coerce.number().min(1).max(500).default(35),
  exclude_zips: z.array(z.string()).default([]),
  visit_permit_required: z.boolean().default(false),
}).partial().default({});

const CrmSchema = z.object({
  tool: ToolSpecSchema,
  dnc_sync: z.boolean().default(true),
  deal_stage_mapping: z.record(z.string()).default({}),
  config: z.record(z.any()).default({}),
}).superRefine((value, ctx) => {
  const hasToolkits = Array.isArray(value?.tool?.toolkits) && value.tool.toolkits.length > 0;
  const hasTools = Array.isArray(value?.tool?.tools) && value.tool.tools.length > 0;
  if (!hasToolkits && !hasTools) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'crm.tool must include at least one toolkit or tool slug.',
      path: ['tool'],
    });
  }
});

const SequenceSchema = z.object({
  manual: z.boolean().default(false),
  start_when: z.string().default(''),
  reply_check: StepConfigSchema.default({}),
  on_reply: z.enum(['pause', 'continue', 'stop']).default('pause'),
  on_bounce: z.enum(['pause', 'continue', 'stop']).default('stop'),
  on_opt_out: z.enum(['pause', 'continue', 'stop']).default('stop'),
  working_days: WorkingDaysSchema,
  non_working_day_policy: z.enum(NON_WORKING_DAY_POLICY_VALUES).default('shift_forward'),
  steps: z.array(SequenceStepSchema).default([]),
}).partial();

const TemplateVersionSchema = z.object({
  version: z.coerce.number().int().min(1).default(1),
  subject: z.string().default(''),
  body: z.string().default(''),
  variables: z.record(z.any()).default({}),
  created_at: z.string().default(''),
  note: z.string().default(''),
}).partial().default({});

const TemplateSchema = z.object({
  id: z.string().default(''),
  channel_hint: z.string().default(''),
  versions: z.array(TemplateVersionSchema).default([]),
  created_at: z.string().default(''),
  updated_at: z.string().default(''),
}).partial().default({});

const LlmBudgetSchema = z.object({
  list_daily_tokens: z.coerce.number().int().min(0).optional(),
  list_weekly_tokens: z.coerce.number().int().min(0).optional(),
  list_monthly_tokens: z.coerce.number().int().min(0).optional(),
  list_daily_usd: z.coerce.number().min(0).optional(),
  list_weekly_usd: z.coerce.number().min(0).optional(),
  list_monthly_usd: z.coerce.number().min(0).optional(),
  step_daily_tokens: z.record(z.coerce.number().int().min(0)).default({}),
  step_weekly_tokens: z.record(z.coerce.number().int().min(0)).default({}),
  step_monthly_tokens: z.record(z.coerce.number().int().min(0)).default({}),
  step_daily_usd: z.record(z.coerce.number().min(0)).default({}),
  step_weekly_usd: z.record(z.coerce.number().min(0)).default({}),
  step_monthly_usd: z.record(z.coerce.number().min(0)).default({}),
}).partial().default({});

const ToolBudgetRuleSchema = z.object({
  daily: z.coerce.number().int().min(0).optional(),
  weekly: z.coerce.number().int().min(0).optional(),
  monthly: z.coerce.number().int().min(0).optional(),
}).partial().default({});

const BudgetsSchema = z.object({
  llm: LlmBudgetSchema.default({}),
  tools: z.record(ToolBudgetRuleSchema).default({}),
}).partial().default({});

const AiSchema = z.object({
  default_model: ProviderModelSchema.default('anthropic/claude-sonnet-4-6'),
  defaults: z.object({
    evaluation: ProviderModelSchema.default('anthropic/claude-haiku-4-5-20251001'),
    copywriting: ProviderModelSchema.default('anthropic/claude-opus-4-6'),
    research: ProviderModelSchema.default('anthropic/claude-sonnet-4-6'),
  }).partial().default({
    evaluation: 'anthropic/claude-haiku-4-5-20251001',
    copywriting: 'anthropic/claude-opus-4-6',
    research: 'anthropic/claude-sonnet-4-6',
  }),
}).partial().default({
  default_model: 'anthropic/claude-sonnet-4-6',
  defaults: {
    evaluation: 'anthropic/claude-haiku-4-5-20251001',
    copywriting: 'anthropic/claude-opus-4-6',
    research: 'anthropic/claude-sonnet-4-6',
  },
});

// Global business context: who WE are, what we sell, and what we always need
// to know about a lead. Optional everywhere — lists without it simply get
// less-grounded briefs. Exposed to brief generation (and any prompt that wants
// it) so Agent Outbound stays reusable across teams: the business specifics
// live here, not in code.
const BusinessSchema = z.object({
  name: z.string().default(''),
  description: z.string().default(''),
  icp: z.string().default(''),
  offer: z.string().default(''),
  capabilities: z.array(z.string()).default([]),
  // The questions the operator always needs answered before walking in the
  // door of a lead. The brief answers what it can and flags the rest to ask.
  field_questions: z.array(z.string()).default([]),
  context: z.string().default(''),
}).partial().default({});

const TerritoryPointSchema = z.object({
  lat: z.coerce.number(),
  lng: z.coerce.number(),
});

export const TerritoryAreaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  polygon: z.array(TerritoryPointSchema).min(3),
  color: z.string().default(''),
}).partial({ description: true, color: true });

// Lead briefs: an SDR-expert take generated for every kept (qualified) lead.
const BriefSchema = z.object({
  enabled: z.boolean().default(false),
  // Generate automatically after scoring (and lead add --run).
  auto: z.boolean().default(true),
  model: ProviderModelSchema.optional(),
  // Only brief leads at or above this score; defaults to score.minimum.
  min_score: z.coerce.number().min(0).max(100).optional(),
  // Optional path (relative to the list dir) to a prompt file that replaces
  // the built-in brief prompt. Receives the same record/business context.
  prompt_file: z.string().default(''),
  // Bump to force regeneration of every brief.
  cache_key: z.string().default(''),
}).partial().default({});

// Automation plans: an internal, post-brief asset. Reads the lead's brief (its
// busy-work especially) plus our `business.capabilities` and proposes the one or
// more concrete automations WE could build for that business. Not a pitch — a
// flat internal read so the operator knows exactly what we'd automate and how it
// would work. Persisted to the `assets` table under step_id `automation_plan`.
const AutomationsSchema = z.object({
  enabled: z.boolean().default(false),
  // Generate automatically after briefs (and lead add --run).
  auto: z.boolean().default(true),
  model: ProviderModelSchema.optional(),
  // Only plan leads at or above this score; defaults to brief.min_score / score.minimum.
  min_score: z.coerce.number().min(0).max(100).optional(),
  // Optional path (relative to the list dir) to a prompt file that replaces
  // the built-in automation-plan prompt. Receives the brief + record + business.
  prompt_file: z.string().default(''),
  // Bump to force regeneration of every plan.
  cache_key: z.string().default(''),
}).partial().default({});

export const ConfigSchema = z.object({
  list: z.object({
    name: z.string().default(''),
    territory: TerritorySchema.default({}),
  }).partial().default({}),
  business: BusinessSchema,
  territories: z.array(TerritoryAreaSchema).default([]),
  brief: BriefSchema,
  automations: AutomationsSchema,
  source: z.object({
    identity: z.array(z.string()).default([]),
    searches: z.array(SourceSearchSchema).default([]),
    strategies: z.array(StrategySchema).default([]),
    exclude: z.array(SourceExcludeRuleSchema).default([]),
    dedup_key: z.string().default('place_id'),
    budget: SourceBudgetSchema.default({}),
  }).partial().default({}),
  pipeline: z.array(PipelineStepSchema).default([]),
  score: ScoreSchema,
  sequences: z.record(SequenceSchema).default({ default: { steps: [] } }),
  templates: z.record(TemplateSchema).default({}),
  ai: AiSchema.default({}),
  budgets: BudgetsSchema.default({}),
  channels: z.record(z.any()).default({}),
  suppression: SuppressionSchema.default({}),
  crm: CrmSchema.optional(),
}).partial().default({});

// Fold a legacy fit/trigger/priority score block into the single-score shape so
// existing configs keep validating and scoring after the collapse to one score.
const coerceLegacyScore = (raw) => {
  if (!raw || typeof raw !== 'object') return raw;
  const score = (raw as any).score;
  if (!score || typeof score !== 'object') return raw;
  const hasLegacy = score.fit || score.trigger || score.priority;
  const hasSingle = Array.isArray(score.criteria) || typeof score.description === 'string';
  if (!hasLegacy || hasSingle) return raw;
  const fit = score.fit && typeof score.fit === 'object' ? score.fit : {};
  const trigger = score.trigger && typeof score.trigger === 'object' ? score.trigger : {};
  const single = {
    description: String(fit.description || trigger.description || '').trim(),
    ...(fit.model ? { model: fit.model } : {}),
    criteria: [
      ...(Array.isArray(fit.criteria) ? fit.criteria : []),
      ...(Array.isArray(trigger.criteria) ? trigger.criteria : []),
    ],
    minimum: Number(score.priority?.minimum ?? score.minimum ?? 0),
  };
  return { ...(raw as any), score: single };
};

const sameTerritoryPoint = (a: any, b: any) => (
  Number(a?.lat) === Number(b?.lat) && Number(a?.lng) === Number(b?.lng)
);

const orientation = (a: any, b: any, c: any) => {
  const value = (Number(b.lng) - Number(a.lng)) * (Number(c.lat) - Number(b.lat))
    - (Number(b.lat) - Number(a.lat)) * (Number(c.lng) - Number(b.lng));
  if (Math.abs(value) < 1e-12) return 0;
  return value > 0 ? 1 : 2;
};

const onSegment = (a: any, b: any, c: any) => (
  Number(b.lng) <= Math.max(Number(a.lng), Number(c.lng))
  && Number(b.lng) >= Math.min(Number(a.lng), Number(c.lng))
  && Number(b.lat) <= Math.max(Number(a.lat), Number(c.lat))
  && Number(b.lat) >= Math.min(Number(a.lat), Number(c.lat))
);

const segmentsIntersect = (a: any, b: any, c: any, d: any) => {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, c, b)) return true;
  if (o2 === 0 && onSegment(a, d, b)) return true;
  if (o3 === 0 && onSegment(c, a, d)) return true;
  if (o4 === 0 && onSegment(c, b, d)) return true;
  return false;
};

const isSimpleRing = (ring: any[]) => {
  const segmentCount = Math.max(0, ring.length - 1);
  for (const i of Array.from({ length: segmentCount }, (_, index) => index)) {
    for (const j of Array.from({ length: segmentCount }, (_, index) => index)) {
      if (j <= i + 1) continue;
      if (i === 0 && j === segmentCount - 1) continue;
      if (segmentsIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])) return false;
    }
  }
  return true;
};

export const normalizeConfig = (value, options: { listDir?: string } = {}) => {
  const parsed = ConfigSchema.safeParse(coerceLegacyScore(value || {}));
  if (!parsed.success) {
    return {
      error: parsed.error.message,
      errors: [parsed.error.message],
      warnings: [],
      config: ConfigSchema.parse({}),
    };
  }

  const sequences = parsed.data?.sequences || {};
  const withSequenceDefaults = Object.fromEntries(
    Object.entries(sequences).map(([name, sequence]: [string, any]) => {
      const workingDays = Array.isArray(sequence?.working_days) && sequence.working_days.length > 0
        ? sequence.working_days
        : [...SEQUENCE_WORKING_DAY_VALUES];
      const nonWorkingDayPolicy = sequence?.non_working_day_policy === 'skip' ? 'skip' : 'shift_forward';
      return [name, { ...sequence, working_days: workingDays, non_working_day_policy: nonWorkingDayPolicy }];
    })
  );
  if (!withSequenceDefaults.default) {
    withSequenceDefaults.default = {
      steps: [],
      working_days: [...SEQUENCE_WORKING_DAY_VALUES],
      non_working_day_policy: 'shift_forward',
    };
  }

  const territories = (parsed.data?.territories || []).map((territory: any) => {
    const polygon = Array.isArray(territory?.polygon) ? territory.polygon : [];
    const first = polygon[0];
    const last = polygon[polygon.length - 1];
    const closed = first && last && !sameTerritoryPoint(first, last)
      ? [...polygon, { lat: Number(first.lat), lng: Number(first.lng) }]
      : polygon;
    return { ...territory, polygon: closed };
  });

  const territoryWarnings = territories.flatMap((territory: any) => (
    isSimpleRing(territory.polygon || [])
      ? []
      : [`Territory "${String(territory.id || territory.name || 'unknown')}" polygon appears to self-intersect.`]
  ));

  const config = {
      ...parsed.data,
      territories,
      ai: {
        ...(parsed.data?.ai || {}),
        defaults: {
          ...(parsed.data?.ai?.defaults || {}),
        },
      },
      sequences: withSequenceDefaults,
    };
  const graph = validatePipelineGraph(config, options);
  const router = validateRouterConfig(parsed.data);
  const errors = [...new Set([...graph.errors, ...router.errors])];

  return {
    error: errors.join('\n'),
    errors,
    warnings: [...new Set([...graph.warnings, ...router.warnings, ...territoryWarnings])],
    config,
  };
};
