import { z } from 'zod';
import {
  NON_WORKING_DAY_POLICY_VALUES,
  isValidIanaTimeZone,
  normalizeWorkingDayToken,
  SEQUENCE_WORKING_DAY_VALUES,
} from '../orchestrator/lib/working-days.js';
import { validatePipelineGraph, validateRouterConfig } from '../orchestrator/lib/pipeline-graph.js';
import { LEGACY_MODEL_HINTS } from '../orchestrator/runtime/models.js';

export const DEFAULT_SCORE_MIN_COVERAGE = 0.5;
export const DEFAULT_SCORE_TREATMENT_BANDS = {
  fit: [0, 50, 65, 80, 100],
  fit_evidence_confidence: [0, 40, 60, 80, 100],
} as const;

export const DEFAULT_SCORE_GOLDEN_TICKET = {
  minimums: {
    fit_score: 85,
    fit_evidence_confidence: 80,
    identity_confidence: 90,
    classification_confidence: 90,
    buyer_confidence: 80,
    mail_confidence: 90,
    timing_score: 70,
    strong_signal_strength: 60,
    strong_signal_count: 2,
    enrichment_budget_usd: 8,
  },
} as const;

export const DEFAULT_SCORE_ACTION_CONFIDENCE = {
  minimums: {
    identity: 80,
    email: 60,
    phone: 70,
    linkedin: 60,
    mail: 80,
    fit_evidence: 40,
  },
} as const;

export const DEFAULT_SCORE_REACHABILITY = {
  minimums: {
    email_verification: 70,
    phone_ready: 60,
    phone_named_validated: 70,
    linkedin_invite_ready: 60,
    mail_ready: 60,
  },
} as const;

export const DEFAULT_SCORE_CANDIDATE_TIER = {
  bands: [0, 50, 65, 80, 100],
} as const;

export const DEFAULT_SCORE_POSTCARD = {
  minimums: {
    identity_confidence: 80,
    strong_fit: 80,
    fit_evidence: 40,
    fit_evidence_exclusive_maximum: 60,
  },
} as const;

export const DEFAULT_SCORE_ENRICHMENT_REPAIR = {
  minimums: {
    identity_confidence: 80,
    fit_evidence_confidence: 40,
    classification_confidence: 40,
    buyer_confidence: 60,
    strong_fit: 65,
    strong_fit_evidence: 60,
  },
  channel_evidence_candidate_tiers: ['A', 'B', 'hold'],
} as const;

export const DEFAULT_SCORE_ENRICHMENT_BUDGET = {
  ceilings: {
    foundational: 0.15,
    A: 3,
    B: 1,
    C: 0.3,
    D: 0.15,
    enrichment_hold: 0.3,
    golden_ticket_total: 8,
  },
} as const;

export const DEFAULT_CONTACT_POLICY = {
  per_contact_allowances: {
    A: 3,
    B: 2,
    C: 1,
    D: 0,
    enrichment_hold: 0,
  },
  campaign: {
    max_age_business_days: {
      A: 40,
      B: 30,
      C: 20,
      D: 0,
      enrichment_hold: 14,
    },
    max_age_business_days_unknown_tier: 30,
    quiet_period_business_days: 3,
    annual_campaign_limit: 2,
    recycle_wait_days: {
      A: 90,
      B: 60,
      C: 45,
      D: 30,
      enrichment_hold: 14,
    },
    recycle_wait_days_unknown_tier: 60,
  },
  phone: {
    attempt_window: {
      start_hour: 9,
      end_hour: 17,
      weekdays_only: true,
    },
    max_attempts: {
      default: 3,
      A: 4,
      B: 3,
      C: 0,
      D: 0,
      enrichment_hold: 0,
    },
    callback_delay_hours: 24,
  },
  linkedin: {
    invite_cooldown_hours: 24,
  },
  fallback_wait_days: 2,
} as const;

type ContactPolicyTier = 'A' | 'B' | 'C' | 'D' | 'enrichment_hold';

export type ContactPolicyConfig = {
  per_contact_allowances: Record<ContactPolicyTier, number>;
  campaign: {
    max_age_business_days: Record<ContactPolicyTier, number>;
    max_age_business_days_unknown_tier: number;
    quiet_period_business_days: number;
    annual_campaign_limit: number;
    recycle_wait_days: Record<ContactPolicyTier, number>;
    recycle_wait_days_unknown_tier: number;
  };
  phone: {
    attempt_window: {
      start_hour: number;
      end_hour: number;
      weekdays_only: boolean;
    };
    max_attempts: Record<'default' | ContactPolicyTier, number>;
    callback_delay_hours: number;
  };
  linkedin: {
    invite_cooldown_hours: number;
  };
  fallback_wait_days: number;
};

export type ContactPolicyConfigInput = {
  per_contact_allowances?: Partial<ContactPolicyConfig['per_contact_allowances']>;
  campaign?: {
    max_age_business_days?: Partial<ContactPolicyConfig['campaign']['max_age_business_days']>;
    max_age_business_days_unknown_tier?: number;
    quiet_period_business_days?: number;
    annual_campaign_limit?: number;
    recycle_wait_days?: Partial<ContactPolicyConfig['campaign']['recycle_wait_days']>;
    recycle_wait_days_unknown_tier?: number;
  };
  phone?: {
    attempt_window?: Partial<ContactPolicyConfig['phone']['attempt_window']>;
    max_attempts?: Partial<ContactPolicyConfig['phone']['max_attempts']>;
    callback_delay_hours?: number;
  };
  linkedin?: Partial<ContactPolicyConfig['linkedin']>;
  fallback_wait_days?: number;
};

export const resolveContactPolicy = (
  input: ContactPolicyConfigInput | undefined = undefined,
): ContactPolicyConfig => ({
  per_contact_allowances: {
    ...DEFAULT_CONTACT_POLICY.per_contact_allowances,
    ...(input?.per_contact_allowances || {}),
  },
  campaign: {
    max_age_business_days: {
      ...DEFAULT_CONTACT_POLICY.campaign.max_age_business_days,
      ...(input?.campaign?.max_age_business_days || {}),
    },
    max_age_business_days_unknown_tier:
      input?.campaign?.max_age_business_days_unknown_tier
      ?? DEFAULT_CONTACT_POLICY.campaign.max_age_business_days_unknown_tier,
    quiet_period_business_days:
      input?.campaign?.quiet_period_business_days
      ?? DEFAULT_CONTACT_POLICY.campaign.quiet_period_business_days,
    annual_campaign_limit:
      input?.campaign?.annual_campaign_limit
      ?? DEFAULT_CONTACT_POLICY.campaign.annual_campaign_limit,
    recycle_wait_days: {
      ...DEFAULT_CONTACT_POLICY.campaign.recycle_wait_days,
      ...(input?.campaign?.recycle_wait_days || {}),
    },
    recycle_wait_days_unknown_tier:
      input?.campaign?.recycle_wait_days_unknown_tier
      ?? DEFAULT_CONTACT_POLICY.campaign.recycle_wait_days_unknown_tier,
  },
  phone: {
    attempt_window: {
      ...DEFAULT_CONTACT_POLICY.phone.attempt_window,
      ...(input?.phone?.attempt_window || {}),
    },
    max_attempts: {
      ...DEFAULT_CONTACT_POLICY.phone.max_attempts,
      ...(input?.phone?.max_attempts || {}),
    },
    callback_delay_hours:
      input?.phone?.callback_delay_hours
      ?? DEFAULT_CONTACT_POLICY.phone.callback_delay_hours,
  },
  linkedin: {
    ...DEFAULT_CONTACT_POLICY.linkedin,
    ...(input?.linkedin || {}),
  },
  fallback_wait_days: input?.fallback_wait_days ?? DEFAULT_CONTACT_POLICY.fallback_wait_days,
});

export type GoldenTicketConfigInput = {
  minimums?: Partial<Record<keyof typeof DEFAULT_SCORE_GOLDEN_TICKET.minimums, number>>;
};

export type ActionConfidenceConfigInput = {
  minimums?: Partial<Record<keyof typeof DEFAULT_SCORE_ACTION_CONFIDENCE.minimums, number>>;
};

export type ReachabilityConfigInput = {
  minimums?: Partial<Record<keyof typeof DEFAULT_SCORE_REACHABILITY.minimums, number>>;
};

export type CandidateTierConfigInput = {
  bands?: number[];
};

export type PostcardConfigInput = {
  minimums?: Partial<Record<keyof typeof DEFAULT_SCORE_POSTCARD.minimums, number>>;
};

export type EnrichmentRepairConfigInput = {
  minimums?: Partial<Record<keyof typeof DEFAULT_SCORE_ENRICHMENT_REPAIR.minimums, number>>;
  channel_evidence_candidate_tiers?: Array<'A' | 'B' | 'C' | 'D' | 'hold'>;
};

export type EnrichmentBudgetConfigInput = {
  ceilings?: Partial<Record<keyof typeof DEFAULT_SCORE_ENRICHMENT_BUDGET.ceilings, number>>;
};

export type IdentityConfidenceConfig = {
  weights: {
    business_name: number;
    address: number;
    website: number;
    place_id: number;
  };
  penalties: {
    unresolved_alternative: number;
    open_contradiction: number;
    maximum_total: number;
  };
};

export type IdentityConfidenceConfigInput = {
  weights?: Partial<IdentityConfidenceConfig['weights']>;
  penalties?: Partial<IdentityConfidenceConfig['penalties']>;
};

export type PhoneConfidenceConfig = {
  weights: {
    present: number;
    well_formed: number;
    structured_source: number;
  };
  penalties: {
    unstructured_maximum: number;
  };
};

export type PhoneConfidenceConfigInput = {
  weights?: Partial<PhoneConfidenceConfig['weights']>;
  penalties?: Partial<PhoneConfidenceConfig['penalties']>;
};

export type BuyerConfidenceConfig = {
  weights: {
    named: number;
    named_literal_support: number;
    decision_authority: number;
    role_literal_support: number;
    affiliation: number;
    affiliation_literal_support: number;
  };
  penalties: {
    open_contradiction: number;
    maximum_total: number;
  };
};

export type BuyerConfidenceConfigInput = {
  weights?: Partial<BuyerConfidenceConfig['weights']>;
  penalties?: Partial<BuyerConfidenceConfig['penalties']>;
};

export type MailConfidenceConfig = {
  weights: {
    address_present: number;
    address_complete: number;
    commercial_delivery_indicator: number;
    validation_evidence: number;
  };
  penalties: {
    open_contradiction: number;
    maximum_total: number;
  };
};

export type MailConfidenceConfigInput = {
  weights?: Partial<MailConfidenceConfig['weights']>;
  penalties?: Partial<MailConfidenceConfig['penalties']>;
};

export const DEFAULT_SCORE_IDENTITY_CONFIDENCE: IdentityConfidenceConfig = {
  weights: {
    business_name: 30,
    address: 30,
    website: 20,
    place_id: 20,
  },
  penalties: {
    unresolved_alternative: 10,
    open_contradiction: 25,
    maximum_total: 40,
  },
};

export const DEFAULT_SCORE_PHONE_CONFIDENCE: PhoneConfidenceConfig = {
  weights: {
    present: 15,
    well_formed: 35,
    structured_source: 35,
  },
  penalties: {
    unstructured_maximum: 50,
  },
};

export const DEFAULT_SCORE_BUYER_CONFIDENCE: BuyerConfidenceConfig = {
  weights: {
    named: 25,
    named_literal_support: 25,
    decision_authority: 20,
    role_literal_support: 10,
    affiliation: 10,
    affiliation_literal_support: 10,
  },
  penalties: {
    open_contradiction: 30,
    maximum_total: 60,
  },
};

export const DEFAULT_SCORE_MAIL_CONFIDENCE: MailConfidenceConfig = {
  weights: {
    address_present: 15,
    address_complete: 25,
    commercial_delivery_indicator: 30,
    validation_evidence: 30,
  },
  penalties: {
    open_contradiction: 0,
    maximum_total: 0,
  },
};

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

const ModelContextProjectionSchema = z.enum(['business_evidence']);

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
  // tool_call provider waterfall: try primary tool, then each entry in order on
  // retryable failure. Alias: fallback_tools. Fail closed after all fail.
  waterfall: z.array(ToolSpecSchema).optional(),
  fallback_tools: z.array(ToolSpecSchema).optional(),
  args: z.record(z.any()).default({}),
  // Deterministic tool_call path for send_email / enrich-like steps:
  // action=tool_call + args_map (tool arg <- record field) + output_map
  // (output field <- result path). Without these, Zod would strip them and
  // channel execution would fall through to the LLM agent path.
  action: z.string().default(''),
  args_map: z.record(z.string()).default({}),
  output_map: z.record(z.string()).default({}),
  daily_cap: z.coerce.number().int().min(0).optional(),
  mailbox: z.string().trim().min(1).optional(),
  mailbox_from: z.string().trim().min(1).optional(),
  draft_approval_required: z.boolean().optional(),
  outputs: z.record(EnrichmentOutputDefSchema).default({}),
  columns: z.record(z.string()).optional(), // Deprecated alias; prefer config.outputs.
  // The only non-identity record scalars visible to a model for this step.
  // New database columns stay invisible until listed here.
  inputs: z.array(z.string()).default([]),
  // Optional named projection for model steps that need a curated record view.
  context_projection: ModelContextProjectionSchema.optional(),
  // Refuse model generation when the required evidence class is absent.
  requires_evidence: z.boolean().optional(),
  depends_on: z.array(z.string()).default([]),
  prompt_file: z.string().default(''),
  prompt_args: z.record(z.any()).default({}),
  condition: z.string().default(''),
  idempotency: IdempotencySchema.optional(),
  // Honest generate opt-in: keep non-critical generate on the production dataflow
  // without AO_PIPELINE_FIXTURE / AO_RUN_GENERATE (see includeStepInDataflow).
  run_in_pipeline: z.boolean().optional(),
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

const NearDuplicateSignalSchema = z.enum([
  'name_and_address',
  'name_and_domain',
  'shared_phone',
  'shared_domain',
  'person_at_shared_address_or_domain',
]);

const NearDuplicateSchema = z.object({
  enabled: z.boolean().default(false),
  signals: z.array(NearDuplicateSignalSchema).default([]),
  name_similarity_threshold: z.coerce.number().min(0).max(1).default(1),
}).default({});

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

export const TimeZoneSchema = z.string().trim().min(1).superRefine((value, ctx) => {
  if (isValidIanaTimeZone(value)) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `timezone must be a valid IANA timezone, received "${value}".`,
  });
});

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
  inputs: z.array(z.string()).default([]),
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
  inputs: z.array(z.string()).default([]),
  reasoning: z.boolean().optional(),
}).partial({ id: true, type: true, match: true, conditions: true, description: true, condition: true, model: true, reasoning: true, inputs: true });

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
  // tool_call provider waterfall (primary tool first, then each entry in order).
  waterfall: z.array(ToolSpecSchema).optional(),
  fallback_tools: z.array(ToolSpecSchema).optional(),
  args: z.record(z.any()).default({}),
  // action: tool_call only — deterministic single tool execution, no LLM.
  // args_map: tool arg <- record field. output_map: output field <- result path.
  args_map: z.record(z.string()).default({}),
  output_map: z.record(z.string()).default({}),
  outputs: z.record(EnrichmentOutputDefSchema).default({}),
  columns: z.record(z.string()).optional(),
  inputs: z.array(z.string()).default([]),
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
  waterfall: true,
  fallback_tools: true,
  args: true,
  args_map: true,
  output_map: true,
  outputs: true,
  columns: true,
  inputs: true,
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
  // Test-only typed fixtures are pipeline-owned. The engine never infers
  // semantic output values from a field name.
  fixture_outputs: z.record(z.unknown()).default({}),
  inputs: PipelineEnrichmentStepSchema.shape.inputs,
  on_error: z.enum(['fail', 'empty']).default('empty'),
  when: PipelineEnrichmentStepSchema.shape.when,
  prompt_file: PipelineEnrichmentStepSchema.shape.prompt_file,
  prompt_args: PipelineEnrichmentStepSchema.shape.prompt_args,
  context_projection: ModelContextProjectionSchema.optional(),
  requires_evidence: z.boolean().optional(),
  // Keep this generate on the normal production dataflow without AO_PIPELINE_FIXTURE
  // or AO_RUN_GENERATE. Critical-path generates (depended on by non-generate steps)
  // are always included; use this for generated assets that must run for selected tiers
  // without being a hard dependency of treatment_assignment.
  run_in_pipeline: z.boolean().optional(),
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

const ScoreTreatmentBandLadderSchema = z.array(z.coerce.number().min(0).max(100)).length(5)
  .superRefine((boundaries, ctx) => {
    if (boundaries[0] !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Treatment band ladders must start at 0.',
        path: [0],
      });
    }
    if (boundaries[boundaries.length - 1] !== 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Treatment band ladders must end at 100.',
        path: [boundaries.length - 1],
      });
    }
    boundaries.slice(1).forEach((boundary, index) => {
      if (boundary > boundaries[index]) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Treatment band ladder boundaries must be strictly ascending.',
        path: [index + 1],
      });
    });
  });

const ScoreTreatmentBandsSchema = z.object({
  fit: ScoreTreatmentBandLadderSchema.default(() => [...DEFAULT_SCORE_TREATMENT_BANDS.fit]),
  fit_evidence_confidence: ScoreTreatmentBandLadderSchema.default(
    () => [...DEFAULT_SCORE_TREATMENT_BANDS.fit_evidence_confidence],
  ),
}).partial().default({
  fit: [...DEFAULT_SCORE_TREATMENT_BANDS.fit],
  fit_evidence_confidence: [...DEFAULT_SCORE_TREATMENT_BANDS.fit_evidence_confidence],
});

const ConfidenceMinimumSchema = z.coerce.number().min(0).max(100);
const NonNegativePolicyValueSchema = z.coerce.number().nonnegative();
const NonNegativeWholePolicyValueSchema = z.coerce.number().int().nonnegative();

const ContactPolicyTierValuesSchema = <T extends Record<ContactPolicyTier, number>>(defaults: T) => z.object({
  A: NonNegativeWholePolicyValueSchema.default(defaults.A),
  B: NonNegativeWholePolicyValueSchema.default(defaults.B),
  C: NonNegativeWholePolicyValueSchema.default(defaults.C),
  D: NonNegativeWholePolicyValueSchema.default(defaults.D),
  enrichment_hold: NonNegativeWholePolicyValueSchema.default(defaults.enrichment_hold),
}).default(() => ({ ...defaults }));

const ContactPolicyPhoneAttemptWindowSchema = z.object({
  start_hour: z.coerce.number().int().min(0).max(23)
    .default(DEFAULT_CONTACT_POLICY.phone.attempt_window.start_hour),
  end_hour: z.coerce.number().int().min(1).max(24)
    .default(DEFAULT_CONTACT_POLICY.phone.attempt_window.end_hour),
  weekdays_only: z.boolean().default(DEFAULT_CONTACT_POLICY.phone.attempt_window.weekdays_only),
}).superRefine((window, ctx) => {
  if (window.end_hour > window.start_hour) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'contact_policy.phone.attempt_window.end_hour must be after start_hour.',
    path: ['end_hour'],
  });
}).default(() => ({ ...DEFAULT_CONTACT_POLICY.phone.attempt_window }));

const ContactPolicyPhoneMaxAttemptsSchema = z.object({
  default: NonNegativeWholePolicyValueSchema.default(DEFAULT_CONTACT_POLICY.phone.max_attempts.default),
  A: NonNegativeWholePolicyValueSchema.default(DEFAULT_CONTACT_POLICY.phone.max_attempts.A),
  B: NonNegativeWholePolicyValueSchema.default(DEFAULT_CONTACT_POLICY.phone.max_attempts.B),
  C: NonNegativeWholePolicyValueSchema.default(DEFAULT_CONTACT_POLICY.phone.max_attempts.C),
  D: NonNegativeWholePolicyValueSchema.default(DEFAULT_CONTACT_POLICY.phone.max_attempts.D),
  enrichment_hold: NonNegativeWholePolicyValueSchema.default(
    DEFAULT_CONTACT_POLICY.phone.max_attempts.enrichment_hold,
  ),
}).default(() => ({ ...DEFAULT_CONTACT_POLICY.phone.max_attempts }));

const ContactPolicySchema = z.object({
  per_contact_allowances: ContactPolicyTierValuesSchema(DEFAULT_CONTACT_POLICY.per_contact_allowances),
  campaign: z.object({
    max_age_business_days: ContactPolicyTierValuesSchema(
      DEFAULT_CONTACT_POLICY.campaign.max_age_business_days,
    ),
    max_age_business_days_unknown_tier: NonNegativeWholePolicyValueSchema.default(
      DEFAULT_CONTACT_POLICY.campaign.max_age_business_days_unknown_tier,
    ),
    quiet_period_business_days: NonNegativeWholePolicyValueSchema.default(
      DEFAULT_CONTACT_POLICY.campaign.quiet_period_business_days,
    ),
    annual_campaign_limit: NonNegativeWholePolicyValueSchema.default(
      DEFAULT_CONTACT_POLICY.campaign.annual_campaign_limit,
    ),
    recycle_wait_days: ContactPolicyTierValuesSchema(DEFAULT_CONTACT_POLICY.campaign.recycle_wait_days),
    recycle_wait_days_unknown_tier: NonNegativeWholePolicyValueSchema.default(
      DEFAULT_CONTACT_POLICY.campaign.recycle_wait_days_unknown_tier,
    ),
  }).default(() => ({
    max_age_business_days: { ...DEFAULT_CONTACT_POLICY.campaign.max_age_business_days },
    max_age_business_days_unknown_tier: DEFAULT_CONTACT_POLICY.campaign.max_age_business_days_unknown_tier,
    quiet_period_business_days: DEFAULT_CONTACT_POLICY.campaign.quiet_period_business_days,
    annual_campaign_limit: DEFAULT_CONTACT_POLICY.campaign.annual_campaign_limit,
    recycle_wait_days: { ...DEFAULT_CONTACT_POLICY.campaign.recycle_wait_days },
    recycle_wait_days_unknown_tier: DEFAULT_CONTACT_POLICY.campaign.recycle_wait_days_unknown_tier,
  })),
  phone: z.object({
    attempt_window: ContactPolicyPhoneAttemptWindowSchema,
    max_attempts: ContactPolicyPhoneMaxAttemptsSchema,
    callback_delay_hours: NonNegativePolicyValueSchema.default(
      DEFAULT_CONTACT_POLICY.phone.callback_delay_hours,
    ),
  }).default(() => ({
    attempt_window: { ...DEFAULT_CONTACT_POLICY.phone.attempt_window },
    max_attempts: { ...DEFAULT_CONTACT_POLICY.phone.max_attempts },
    callback_delay_hours: DEFAULT_CONTACT_POLICY.phone.callback_delay_hours,
  })),
  linkedin: z.object({
    invite_cooldown_hours: NonNegativePolicyValueSchema.default(
      DEFAULT_CONTACT_POLICY.linkedin.invite_cooldown_hours,
    ),
  }).default(() => ({ ...DEFAULT_CONTACT_POLICY.linkedin })),
  fallback_wait_days: NonNegativeWholePolicyValueSchema.default(DEFAULT_CONTACT_POLICY.fallback_wait_days),
}).default(() => resolveContactPolicy());

const GoldenTicketConfigSchema = z.object({
  minimums: z.object({
    fit_score: ConfidenceMinimumSchema.default(DEFAULT_SCORE_GOLDEN_TICKET.minimums.fit_score),
    fit_evidence_confidence: ConfidenceMinimumSchema.default(DEFAULT_SCORE_GOLDEN_TICKET.minimums.fit_evidence_confidence),
    identity_confidence: ConfidenceMinimumSchema.default(DEFAULT_SCORE_GOLDEN_TICKET.minimums.identity_confidence),
    classification_confidence: ConfidenceMinimumSchema.default(DEFAULT_SCORE_GOLDEN_TICKET.minimums.classification_confidence),
    buyer_confidence: ConfidenceMinimumSchema.default(DEFAULT_SCORE_GOLDEN_TICKET.minimums.buyer_confidence),
    mail_confidence: ConfidenceMinimumSchema.default(DEFAULT_SCORE_GOLDEN_TICKET.minimums.mail_confidence),
    timing_score: ConfidenceMinimumSchema.default(DEFAULT_SCORE_GOLDEN_TICKET.minimums.timing_score),
    strong_signal_strength: ConfidenceMinimumSchema.default(DEFAULT_SCORE_GOLDEN_TICKET.minimums.strong_signal_strength),
    strong_signal_count: NonNegativePolicyValueSchema.default(DEFAULT_SCORE_GOLDEN_TICKET.minimums.strong_signal_count),
    enrichment_budget_usd: NonNegativePolicyValueSchema.default(DEFAULT_SCORE_GOLDEN_TICKET.minimums.enrichment_budget_usd),
  }).partial().default(() => ({ ...DEFAULT_SCORE_GOLDEN_TICKET.minimums })),
}).default(() => ({ minimums: { ...DEFAULT_SCORE_GOLDEN_TICKET.minimums } }));

const ActionConfidenceConfigSchema = z.object({
  minimums: z.object({
    identity: ConfidenceMinimumSchema.default(DEFAULT_SCORE_ACTION_CONFIDENCE.minimums.identity),
    email: ConfidenceMinimumSchema.default(DEFAULT_SCORE_ACTION_CONFIDENCE.minimums.email),
    phone: ConfidenceMinimumSchema.default(DEFAULT_SCORE_ACTION_CONFIDENCE.minimums.phone),
    linkedin: ConfidenceMinimumSchema.default(DEFAULT_SCORE_ACTION_CONFIDENCE.minimums.linkedin),
    mail: ConfidenceMinimumSchema.default(DEFAULT_SCORE_ACTION_CONFIDENCE.minimums.mail),
    fit_evidence: ConfidenceMinimumSchema.default(DEFAULT_SCORE_ACTION_CONFIDENCE.minimums.fit_evidence),
  }).partial().default(() => ({ ...DEFAULT_SCORE_ACTION_CONFIDENCE.minimums })),
}).default(() => ({ minimums: { ...DEFAULT_SCORE_ACTION_CONFIDENCE.minimums } }));

const ReachabilityConfigSchema = z.object({
  minimums: z.object({
    email_verification: ConfidenceMinimumSchema.default(DEFAULT_SCORE_REACHABILITY.minimums.email_verification),
    phone_ready: ConfidenceMinimumSchema.default(DEFAULT_SCORE_REACHABILITY.minimums.phone_ready),
    phone_named_validated: ConfidenceMinimumSchema.default(DEFAULT_SCORE_REACHABILITY.minimums.phone_named_validated),
    linkedin_invite_ready: ConfidenceMinimumSchema.default(DEFAULT_SCORE_REACHABILITY.minimums.linkedin_invite_ready),
    mail_ready: ConfidenceMinimumSchema.default(DEFAULT_SCORE_REACHABILITY.minimums.mail_ready),
  }).partial().superRefine((minimums, ctx) => {
    if (minimums.phone_named_validated === undefined || minimums.phone_ready === undefined) return;
    if (minimums.phone_named_validated >= minimums.phone_ready) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'score.reachability.minimums.phone_named_validated must be at least phone_ready.',
      path: ['phone_named_validated'],
    });
  }).default(() => ({ ...DEFAULT_SCORE_REACHABILITY.minimums })),
}).default(() => ({ minimums: { ...DEFAULT_SCORE_REACHABILITY.minimums } }));

const CandidateTierConfigSchema = z.object({
  bands: ScoreTreatmentBandLadderSchema.default(() => [...DEFAULT_SCORE_CANDIDATE_TIER.bands]),
}).default(() => ({ bands: [...DEFAULT_SCORE_CANDIDATE_TIER.bands] }));

const PostcardConfigSchema = z.object({
  minimums: z.object({
    identity_confidence: ConfidenceMinimumSchema.default(DEFAULT_SCORE_POSTCARD.minimums.identity_confidence),
    strong_fit: ConfidenceMinimumSchema.default(DEFAULT_SCORE_POSTCARD.minimums.strong_fit),
    fit_evidence: ConfidenceMinimumSchema.default(DEFAULT_SCORE_POSTCARD.minimums.fit_evidence),
    fit_evidence_exclusive_maximum: ConfidenceMinimumSchema.default(
      DEFAULT_SCORE_POSTCARD.minimums.fit_evidence_exclusive_maximum,
    ),
  }).partial().superRefine((minimums, ctx) => {
    if (minimums.fit_evidence === undefined || minimums.fit_evidence_exclusive_maximum === undefined) return;
    if (minimums.fit_evidence_exclusive_maximum > minimums.fit_evidence) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'score.postcard.minimums.fit_evidence_exclusive_maximum must exceed fit_evidence.',
      path: ['fit_evidence_exclusive_maximum'],
    });
  }).default(() => ({ ...DEFAULT_SCORE_POSTCARD.minimums })),
}).default(() => ({ minimums: { ...DEFAULT_SCORE_POSTCARD.minimums } }));

const EnrichmentRepairConfigSchema = z.object({
  minimums: z.object({
    identity_confidence: ConfidenceMinimumSchema.default(DEFAULT_SCORE_ENRICHMENT_REPAIR.minimums.identity_confidence),
    fit_evidence_confidence: ConfidenceMinimumSchema.default(DEFAULT_SCORE_ENRICHMENT_REPAIR.minimums.fit_evidence_confidence),
    classification_confidence: ConfidenceMinimumSchema.default(DEFAULT_SCORE_ENRICHMENT_REPAIR.minimums.classification_confidence),
    buyer_confidence: ConfidenceMinimumSchema.default(DEFAULT_SCORE_ENRICHMENT_REPAIR.minimums.buyer_confidence),
    strong_fit: ConfidenceMinimumSchema.default(DEFAULT_SCORE_ENRICHMENT_REPAIR.minimums.strong_fit),
    strong_fit_evidence: ConfidenceMinimumSchema.default(DEFAULT_SCORE_ENRICHMENT_REPAIR.minimums.strong_fit_evidence),
  }).partial().default(() => ({ ...DEFAULT_SCORE_ENRICHMENT_REPAIR.minimums })),
  channel_evidence_candidate_tiers: z.array(z.enum(['A', 'B', 'C', 'D', 'hold']))
    .min(1)
    .refine((tiers) => new Set(tiers).size === tiers.length, 'Candidate tiers must be unique.')
    .default(() => [...DEFAULT_SCORE_ENRICHMENT_REPAIR.channel_evidence_candidate_tiers]),
}).default(() => ({
  minimums: { ...DEFAULT_SCORE_ENRICHMENT_REPAIR.minimums },
  channel_evidence_candidate_tiers: [...DEFAULT_SCORE_ENRICHMENT_REPAIR.channel_evidence_candidate_tiers],
}));

const EnrichmentBudgetConfigSchema = z.object({
  ceilings: z.object({
    foundational: NonNegativePolicyValueSchema.default(DEFAULT_SCORE_ENRICHMENT_BUDGET.ceilings.foundational),
    A: NonNegativePolicyValueSchema.default(DEFAULT_SCORE_ENRICHMENT_BUDGET.ceilings.A),
    B: NonNegativePolicyValueSchema.default(DEFAULT_SCORE_ENRICHMENT_BUDGET.ceilings.B),
    C: NonNegativePolicyValueSchema.default(DEFAULT_SCORE_ENRICHMENT_BUDGET.ceilings.C),
    D: NonNegativePolicyValueSchema.default(DEFAULT_SCORE_ENRICHMENT_BUDGET.ceilings.D),
    enrichment_hold: NonNegativePolicyValueSchema.default(DEFAULT_SCORE_ENRICHMENT_BUDGET.ceilings.enrichment_hold),
    golden_ticket_total: NonNegativePolicyValueSchema.default(DEFAULT_SCORE_ENRICHMENT_BUDGET.ceilings.golden_ticket_total),
  }).partial().default(() => ({ ...DEFAULT_SCORE_ENRICHMENT_BUDGET.ceilings })),
}).default(() => ({ ceilings: { ...DEFAULT_SCORE_ENRICHMENT_BUDGET.ceilings } }));

const validateConfidenceWeightTotal = (path: string) => (
  (weights: Record<string, number>, ctx: z.RefinementCtx) => {
    const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
    if (total <= 100 + Number.EPSILON) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${path}.weights must total no more than 100.`,
    });
  }
);

const IdentityConfidenceWeightsSchema = z.object({
  business_name: z.coerce.number().nonnegative().default(DEFAULT_SCORE_IDENTITY_CONFIDENCE.weights.business_name),
  address: z.coerce.number().nonnegative().default(DEFAULT_SCORE_IDENTITY_CONFIDENCE.weights.address),
  website: z.coerce.number().nonnegative().default(DEFAULT_SCORE_IDENTITY_CONFIDENCE.weights.website),
  place_id: z.coerce.number().nonnegative().default(DEFAULT_SCORE_IDENTITY_CONFIDENCE.weights.place_id),
}).superRefine(validateConfidenceWeightTotal('score.identity_confidence'));

const IdentityConfidencePenaltiesSchema = z.object({
  unresolved_alternative: z.coerce.number().nonnegative()
    .default(DEFAULT_SCORE_IDENTITY_CONFIDENCE.penalties.unresolved_alternative),
  open_contradiction: z.coerce.number().nonnegative()
    .default(DEFAULT_SCORE_IDENTITY_CONFIDENCE.penalties.open_contradiction),
  maximum_total: z.coerce.number().nonnegative()
    .default(DEFAULT_SCORE_IDENTITY_CONFIDENCE.penalties.maximum_total),
});

const IdentityConfidenceConfigSchema = z.object({
  weights: IdentityConfidenceWeightsSchema.default(() => ({ ...DEFAULT_SCORE_IDENTITY_CONFIDENCE.weights })),
  penalties: IdentityConfidencePenaltiesSchema.default(() => ({ ...DEFAULT_SCORE_IDENTITY_CONFIDENCE.penalties })),
}).default(() => ({
  weights: { ...DEFAULT_SCORE_IDENTITY_CONFIDENCE.weights },
  penalties: { ...DEFAULT_SCORE_IDENTITY_CONFIDENCE.penalties },
}));

const PhoneConfidenceWeightsSchema = z.object({
  present: z.coerce.number().nonnegative().default(DEFAULT_SCORE_PHONE_CONFIDENCE.weights.present),
  well_formed: z.coerce.number().nonnegative().default(DEFAULT_SCORE_PHONE_CONFIDENCE.weights.well_formed),
  structured_source: z.coerce.number().nonnegative().default(DEFAULT_SCORE_PHONE_CONFIDENCE.weights.structured_source),
}).superRefine(validateConfidenceWeightTotal('score.phone_confidence'));

const PhoneConfidencePenaltiesSchema = z.object({
  unstructured_maximum: z.coerce.number().nonnegative()
    .default(DEFAULT_SCORE_PHONE_CONFIDENCE.penalties.unstructured_maximum),
});

const PhoneConfidenceConfigSchema = z.object({
  weights: PhoneConfidenceWeightsSchema.default(() => ({ ...DEFAULT_SCORE_PHONE_CONFIDENCE.weights })),
  penalties: PhoneConfidencePenaltiesSchema.default(() => ({ ...DEFAULT_SCORE_PHONE_CONFIDENCE.penalties })),
}).default(() => ({
  weights: { ...DEFAULT_SCORE_PHONE_CONFIDENCE.weights },
  penalties: { ...DEFAULT_SCORE_PHONE_CONFIDENCE.penalties },
}));

const BuyerConfidenceWeightsSchema = z.object({
  named: z.coerce.number().nonnegative().default(DEFAULT_SCORE_BUYER_CONFIDENCE.weights.named),
  named_literal_support: z.coerce.number().nonnegative()
    .default(DEFAULT_SCORE_BUYER_CONFIDENCE.weights.named_literal_support),
  decision_authority: z.coerce.number().nonnegative()
    .default(DEFAULT_SCORE_BUYER_CONFIDENCE.weights.decision_authority),
  role_literal_support: z.coerce.number().nonnegative()
    .default(DEFAULT_SCORE_BUYER_CONFIDENCE.weights.role_literal_support),
  affiliation: z.coerce.number().nonnegative().default(DEFAULT_SCORE_BUYER_CONFIDENCE.weights.affiliation),
  affiliation_literal_support: z.coerce.number().nonnegative()
    .default(DEFAULT_SCORE_BUYER_CONFIDENCE.weights.affiliation_literal_support),
}).superRefine(validateConfidenceWeightTotal('score.buyer_confidence'));

const BuyerConfidencePenaltiesSchema = z.object({
  open_contradiction: z.coerce.number().nonnegative()
    .default(DEFAULT_SCORE_BUYER_CONFIDENCE.penalties.open_contradiction),
  maximum_total: z.coerce.number().nonnegative()
    .default(DEFAULT_SCORE_BUYER_CONFIDENCE.penalties.maximum_total),
});

const BuyerConfidenceConfigSchema = z.object({
  weights: BuyerConfidenceWeightsSchema.default(() => ({ ...DEFAULT_SCORE_BUYER_CONFIDENCE.weights })),
  penalties: BuyerConfidencePenaltiesSchema.default(() => ({ ...DEFAULT_SCORE_BUYER_CONFIDENCE.penalties })),
}).default(() => ({
  weights: { ...DEFAULT_SCORE_BUYER_CONFIDENCE.weights },
  penalties: { ...DEFAULT_SCORE_BUYER_CONFIDENCE.penalties },
}));

const MailConfidenceWeightsSchema = z.object({
  address_present: z.coerce.number().nonnegative().default(DEFAULT_SCORE_MAIL_CONFIDENCE.weights.address_present),
  address_complete: z.coerce.number().nonnegative().default(DEFAULT_SCORE_MAIL_CONFIDENCE.weights.address_complete),
  commercial_delivery_indicator: z.coerce.number().nonnegative()
    .default(DEFAULT_SCORE_MAIL_CONFIDENCE.weights.commercial_delivery_indicator),
  validation_evidence: z.coerce.number().nonnegative()
    .default(DEFAULT_SCORE_MAIL_CONFIDENCE.weights.validation_evidence),
}).superRefine(validateConfidenceWeightTotal('score.mail_confidence'));

const MailConfidencePenaltiesSchema = z.object({
  open_contradiction: z.coerce.number().nonnegative()
    .default(DEFAULT_SCORE_MAIL_CONFIDENCE.penalties.open_contradiction),
  maximum_total: z.coerce.number().nonnegative()
    .default(DEFAULT_SCORE_MAIL_CONFIDENCE.penalties.maximum_total),
});

const MailConfidenceConfigSchema = z.object({
  weights: MailConfidenceWeightsSchema.default(() => ({ ...DEFAULT_SCORE_MAIL_CONFIDENCE.weights })),
  penalties: MailConfidencePenaltiesSchema.default(() => ({ ...DEFAULT_SCORE_MAIL_CONFIDENCE.penalties })),
}).default(() => ({
  weights: { ...DEFAULT_SCORE_MAIL_CONFIDENCE.weights },
  penalties: { ...DEFAULT_SCORE_MAIL_CONFIDENCE.penalties },
}));

// A single lead score (0-100). One weighted criteria list, one LLM pass.
// Legacy fit/trigger/priority configs are normalized into this shape at load time.
const ScoreSchema = z.object({
  description: z.string().default(''),
  model: ProviderModelSchema.optional(),
  // ternary: criteria graded yes/partial/no (1 / 0.5 / 0) — coarse, saturates
  // easily. graded: integer 0-10 per criterion with anchored skeptical
  // calibration — granular, spreads the distribution.
  grading: z.enum(['ternary', 'graded']).default('ternary'),
  // Independent graded samples per criterion; even counts use the lower median.
  samples: z.coerce.number().int().positive().default(1),
  inputs: z.array(z.string()).default([]),
  criteria: z.array(ScoringCriterionSchema).default([]),
  // Leads scoring below this threshold are dropped at scoring time
  // (gate "score_minimum"). 0 / unset disables the floor.
  minimum: z.coerce.number().min(0).max(100).default(0),
  // Minimum assessable criterion-weight share required to trust a fit score.
  min_coverage: z.coerce.number().min(0).max(1).default(DEFAULT_SCORE_MIN_COVERAGE),
  // Inclusive lower boundaries for the four treatment matrix bands. The final
  // 100 boundary closes the ladder so every score is in exactly one band.
  treatment_bands: ScoreTreatmentBandsSchema,
  // Confidence evidence weights total no more than 100; penalties deduct from that evidence.
  identity_confidence: IdentityConfidenceConfigSchema,
  phone_confidence: PhoneConfidenceConfigSchema,
  buyer_confidence: BuyerConfidenceConfigSchema,
  mail_confidence: MailConfidenceConfigSchema,
  golden_ticket: GoldenTicketConfigSchema,
  action_confidence: ActionConfidenceConfigSchema,
  reachability: ReachabilityConfigSchema,
  candidate_tier: CandidateTierConfigSchema,
  postcard: PostcardConfigSchema,
  enrichment_repair: EnrichmentRepairConfigSchema,
  enrichment_budget: EnrichmentBudgetConfigSchema,
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
  inputs: z.array(z.string()).default([]),
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
  timezone: TimeZoneSchema.optional(),
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
  inputs: z.array(z.string()).default([]),
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
  inputs: z.array(z.string()).default([]),
}).partial().default({});

const MailboxesConfigSchema = z.object({
  dir: z.string().trim().min(1).optional(),
  file: z.string().trim().min(1).optional(),
  default: z.string().trim().min(1).optional(),
  allow_inline_secrets: z.boolean().optional(),
}).partial();

const PendingRuleSchema = z.object({
  id: z.string().trim().min(1).optional(),
  observation: z.string().trim().min(1).optional(),
  kind: z.string().trim().min(1),
  priority: z.enum(['urgent', 'high', 'normal', 'low']).default('normal'),
  after: z.string().trim().min(1).optional(),
}).superRefine((rule, ctx) => {
  if (rule.id || rule.observation) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'A pending rule requires id or observation.',
    path: ['id'],
  });
});

const ObservationRuleSchema = z.object({
  id: z.string().trim().min(1),
  source: z.string().trim().min(1),
  when: z.record(z.unknown()).default({}),
});

const NotificationSinkSchema = z.object({
  type: z.enum(['webhook', 'command', 'stdout', 'file']),
  url: z.string().trim().min(1).optional(),
  command: z.string().trim().min(1).optional(),
  args: z.array(z.string()).default([]),
  path: z.string().trim().min(1).optional(),
}).superRefine((sink, ctx) => {
  const requiredField = sink.type === 'webhook'
    ? 'url'
    : sink.type === 'command'
      ? 'command'
      : sink.type === 'file'
        ? 'path'
        : '';
  if (!requiredField || sink[requiredField]) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `${sink.type} notification sink requires ${requiredField}.`,
    path: [requiredField],
  });
});

const NotificationRouteSchema = z.object({
  events: z.array(z.string().trim().min(1)).min(1),
  sink: z.string().trim().min(1),
  coalesce_for: z.string().trim().min(1).optional(),
});

const OperationsSchema = z.object({
  instructions: z.string().trim().default(''),
  timezone: TimeZoneSchema.optional(),
  objectives: z.object({
    primary: z.string().trim().default(''),
    secondary: z.array(z.string()).default([]),
  }).partial().default({}),
  observations: z.array(ObservationRuleSchema).default([]),
  pending: z.object({
    rules: z.array(PendingRuleSchema).default([]),
  }).partial().default({}),
  notifications: z.object({
    coalesce_for: z.string().trim().min(1).optional(),
    notify_on: z.array(z.string()).default([]),
    sinks: z.record(NotificationSinkSchema).default({}),
    routes: z.array(NotificationRouteSchema).default([]),
  }).partial().default({}),
  monitor: z.object({
    interval_seconds: z.coerce.number().int().min(5).default(15),
  }).partial().default({}),
}).partial().default({}).superRefine((operations, ctx) => {
  const sinks = operations.notifications?.sinks || {};
  for (const [index, route] of (operations.notifications?.routes || []).entries()) {
    if (sinks[route.sink]) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Notification route references unknown sink "${route.sink}".`,
      path: ['notifications', 'routes', index, 'sink'],
    });
  }
});

const WatchSchema = z.object({
  poll_inbound_minutes: z.coerce.number().int().min(1).default(5),
  poll_replies_minutes: z.coerce.number().int().min(1).default(5),
  poll_delivery_minutes: z.coerce.number().int().min(1).default(15),
}).partial().default({});

/** Project-level outbound policy (forbidden channels, hard readiness, versions). */
const PolicySchema = z.object({
  version: z.string().trim().default(''),
  forbidden_channels: z.array(z.string()).default([]),
  /** When true, channel execute hard-blocks non-ready external sends (send_email, linkedin_connect). */
  enforce_readiness: z.boolean().default(false),
  fit_rule_version: z.string().trim().default(''),
  treatment_rule_version: z.string().trim().default(''),
  deterministic_treatment: z.boolean().default(true),
  review_required_for: z.array(z.string()).default([]),
}).partial().default({});

const LiveInteractionBudgetSchema = z.object({
  max_accounts: z.coerce.number().int().min(0),
  max_interactions: z.coerce.number().int().min(0),
});

const ModelContextSchema = z.object({
  max_chars: z.coerce.number().int().positive().default(100_000),
  max_tokens: z.coerce.number().int().positive().default(25_000),
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
    near_duplicate: NearDuplicateSchema,
    budget: SourceBudgetSchema.default({}),
  }).partial().default({}),
  pipeline: z.array(PipelineStepSchema).default([]),
  score: ScoreSchema,
  /** Pipeline-owned limits that determine how often a person is contacted. */
  contact_policy: ContactPolicySchema,
  sequences: z.record(SequenceSchema).default({ default: { steps: [] } }),
  templates: z.record(TemplateSchema).default({}),
  ai: AiSchema.default({}),
  model_context: ModelContextSchema,
  budgets: BudgetsSchema.default({}),
  channels: z.record(z.any()).default({}).superRefine((channels, ctx) => {
    const phone = channels.phone;
    if (!phone || typeof phone !== 'object' || Array.isArray(phone)) return;
    const timezone = (phone as Record<string, unknown>).timezone;
    if (timezone === undefined) return;
    const parsed = TimeZoneSchema.safeParse(timezone);
    if (parsed.success) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: parsed.error.issues[0]?.message || 'phone timezone must be a valid IANA timezone.',
      path: ['phone', 'timezone'],
    });
  }),
  mailboxes: MailboxesConfigSchema.optional(),
  suppression: SuppressionSchema.default({}),
  crm: CrmSchema.optional(),
  /** Deterministic outbound policy gates (TV and similar projects). */
  policy: PolicySchema,
  live_interaction_budget: LiveInteractionBudgetSchema.optional(),
  operations: OperationsSchema,
  watch: WatchSchema,
}).partial().default({});

// Fold a legacy fit/trigger/priority score block into the single-score shape so
// existing configs keep validating and scoring after the collapse to one score.
const coerceLegacyContactPolicy = (raw: unknown) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const config = raw as Record<string, unknown>;
  const contactPolicy = config.contact_policy && typeof config.contact_policy === 'object' && !Array.isArray(config.contact_policy)
    ? config.contact_policy as Record<string, unknown>
    : {};
  const channels = config.channels && typeof config.channels === 'object' && !Array.isArray(config.channels)
    ? config.channels as Record<string, unknown>
    : {};
  const legacyPhone = channels.phone && typeof channels.phone === 'object' && !Array.isArray(channels.phone)
    ? channels.phone as Record<string, unknown>
    : {};
  const legacyLinkedin = channels.linkedin && typeof channels.linkedin === 'object' && !Array.isArray(channels.linkedin)
    ? channels.linkedin as Record<string, unknown>
    : {};
  const phone = contactPolicy.phone && typeof contactPolicy.phone === 'object' && !Array.isArray(contactPolicy.phone)
    ? contactPolicy.phone as Record<string, unknown>
    : {};
  const attemptWindow = phone.attempt_window && typeof phone.attempt_window === 'object' && !Array.isArray(phone.attempt_window)
    ? phone.attempt_window as Record<string, unknown>
    : {};
  const linkedin = contactPolicy.linkedin && typeof contactPolicy.linkedin === 'object' && !Array.isArray(contactPolicy.linkedin)
    ? contactPolicy.linkedin as Record<string, unknown>
    : {};
  const legacyMaxAttempts = legacyPhone.max_attempts ?? legacyPhone.maxAttempts;
  const maxAttempts = phone.max_attempts && typeof phone.max_attempts === 'object' && !Array.isArray(phone.max_attempts)
    ? phone.max_attempts as Record<string, unknown>
    : legacyMaxAttempts === undefined
      ? undefined
      : {
        default: legacyMaxAttempts,
        A: legacyMaxAttempts,
        B: legacyMaxAttempts,
        C: legacyMaxAttempts,
        D: legacyMaxAttempts,
        enrichment_hold: legacyMaxAttempts,
      };

  return {
    ...config,
    contact_policy: {
      ...contactPolicy,
      phone: {
        ...phone,
        attempt_window: {
          ...attemptWindow,
          ...(attemptWindow.start_hour === undefined && attemptWindow.startHour === undefined
            && (legacyPhone.start_hour !== undefined || legacyPhone.startHour !== undefined)
            ? { start_hour: legacyPhone.start_hour ?? legacyPhone.startHour }
            : {}),
          ...(attemptWindow.end_hour === undefined && attemptWindow.endHour === undefined
            && (legacyPhone.end_hour !== undefined || legacyPhone.endHour !== undefined)
            ? { end_hour: legacyPhone.end_hour ?? legacyPhone.endHour }
            : {}),
          ...(attemptWindow.weekdays_only === undefined && attemptWindow.weekdaysOnly === undefined
            && (legacyPhone.weekdays_only !== undefined || legacyPhone.weekdaysOnly !== undefined)
            ? { weekdays_only: legacyPhone.weekdays_only ?? legacyPhone.weekdaysOnly }
            : {}),
        },
        ...(maxAttempts ? { max_attempts: maxAttempts } : {}),
        ...(phone.callback_delay_hours === undefined && phone.callbackDelayHours === undefined
          && (legacyPhone.callback_delay_hours !== undefined || legacyPhone.callbackDelayHours !== undefined)
          ? { callback_delay_hours: legacyPhone.callback_delay_hours ?? legacyPhone.callbackDelayHours }
          : {}),
      },
      linkedin: {
        ...linkedin,
        ...(linkedin.invite_cooldown_hours === undefined && linkedin.inviteCooldownHours === undefined
          && (legacyLinkedin.connect_cooldown_hours !== undefined || legacyLinkedin.cooldown_hours !== undefined)
          ? {
            invite_cooldown_hours:
              legacyLinkedin.connect_cooldown_hours ?? legacyLinkedin.cooldown_hours,
          }
          : {}),
      },
    },
  };
};

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
    ...(score.min_coverage !== undefined ? { min_coverage: score.min_coverage } : {}),
    ...(score.treatment_bands !== undefined ? { treatment_bands: score.treatment_bands } : {}),
    ...(score.identity_confidence !== undefined ? { identity_confidence: score.identity_confidence } : {}),
    ...(score.phone_confidence !== undefined ? { phone_confidence: score.phone_confidence } : {}),
    ...(score.buyer_confidence !== undefined ? { buyer_confidence: score.buyer_confidence } : {}),
    ...(score.mail_confidence !== undefined ? { mail_confidence: score.mail_confidence } : {}),
    ...(score.golden_ticket !== undefined ? { golden_ticket: score.golden_ticket } : {}),
    ...(score.action_confidence !== undefined ? { action_confidence: score.action_confidence } : {}),
    ...(score.reachability !== undefined ? { reachability: score.reachability } : {}),
    ...(score.candidate_tier !== undefined ? { candidate_tier: score.candidate_tier } : {}),
    ...(score.postcard !== undefined ? { postcard: score.postcard } : {}),
    ...(score.enrichment_repair !== undefined ? { enrichment_repair: score.enrichment_repair } : {}),
    ...(score.enrichment_budget !== undefined ? { enrichment_budget: score.enrichment_budget } : {}),
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
  const parsed = ConfigSchema.safeParse(coerceLegacyScore(coerceLegacyContactPolicy(value || {})));
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
      return [name, {
        ...sequence,
        working_days: workingDays,
        non_working_day_policy: nonWorkingDayPolicy,
        timezone: sequence?.timezone || parsed.data?.operations?.timezone || 'UTC',
      }];
    })
  );
  if (!withSequenceDefaults.default) {
    withSequenceDefaults.default = {
      steps: [],
      working_days: [...SEQUENCE_WORKING_DAY_VALUES],
      non_working_day_policy: 'shift_forward',
      timezone: parsed.data?.operations?.timezone || 'UTC',
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
      score: {
        ...(parsed.data?.score || {}),
        samples: parsed.data?.score?.samples ?? 1,
        min_coverage: parsed.data?.score?.min_coverage ?? DEFAULT_SCORE_MIN_COVERAGE,
        treatment_bands: {
          fit: parsed.data?.score?.treatment_bands?.fit ?? [...DEFAULT_SCORE_TREATMENT_BANDS.fit],
          fit_evidence_confidence: parsed.data?.score?.treatment_bands?.fit_evidence_confidence
            ?? [...DEFAULT_SCORE_TREATMENT_BANDS.fit_evidence_confidence],
        },
        identity_confidence: {
          weights: {
            business_name: parsed.data?.score?.identity_confidence?.weights?.business_name
              ?? DEFAULT_SCORE_IDENTITY_CONFIDENCE.weights.business_name,
            address: parsed.data?.score?.identity_confidence?.weights?.address
              ?? DEFAULT_SCORE_IDENTITY_CONFIDENCE.weights.address,
            website: parsed.data?.score?.identity_confidence?.weights?.website
              ?? DEFAULT_SCORE_IDENTITY_CONFIDENCE.weights.website,
            place_id: parsed.data?.score?.identity_confidence?.weights?.place_id
              ?? DEFAULT_SCORE_IDENTITY_CONFIDENCE.weights.place_id,
          },
          penalties: {
            unresolved_alternative: parsed.data?.score?.identity_confidence?.penalties?.unresolved_alternative
              ?? DEFAULT_SCORE_IDENTITY_CONFIDENCE.penalties.unresolved_alternative,
            open_contradiction: parsed.data?.score?.identity_confidence?.penalties?.open_contradiction
              ?? DEFAULT_SCORE_IDENTITY_CONFIDENCE.penalties.open_contradiction,
            maximum_total: parsed.data?.score?.identity_confidence?.penalties?.maximum_total
              ?? DEFAULT_SCORE_IDENTITY_CONFIDENCE.penalties.maximum_total,
          },
        },
        phone_confidence: {
          weights: {
            present: parsed.data?.score?.phone_confidence?.weights?.present
              ?? DEFAULT_SCORE_PHONE_CONFIDENCE.weights.present,
            well_formed: parsed.data?.score?.phone_confidence?.weights?.well_formed
              ?? DEFAULT_SCORE_PHONE_CONFIDENCE.weights.well_formed,
            structured_source: parsed.data?.score?.phone_confidence?.weights?.structured_source
              ?? DEFAULT_SCORE_PHONE_CONFIDENCE.weights.structured_source,
          },
          penalties: {
            unstructured_maximum: parsed.data?.score?.phone_confidence?.penalties?.unstructured_maximum
              ?? DEFAULT_SCORE_PHONE_CONFIDENCE.penalties.unstructured_maximum,
          },
        },
        buyer_confidence: {
          weights: {
            named: parsed.data?.score?.buyer_confidence?.weights?.named
              ?? DEFAULT_SCORE_BUYER_CONFIDENCE.weights.named,
            named_literal_support: parsed.data?.score?.buyer_confidence?.weights?.named_literal_support
              ?? DEFAULT_SCORE_BUYER_CONFIDENCE.weights.named_literal_support,
            decision_authority: parsed.data?.score?.buyer_confidence?.weights?.decision_authority
              ?? DEFAULT_SCORE_BUYER_CONFIDENCE.weights.decision_authority,
            role_literal_support: parsed.data?.score?.buyer_confidence?.weights?.role_literal_support
              ?? DEFAULT_SCORE_BUYER_CONFIDENCE.weights.role_literal_support,
            affiliation: parsed.data?.score?.buyer_confidence?.weights?.affiliation
              ?? DEFAULT_SCORE_BUYER_CONFIDENCE.weights.affiliation,
            affiliation_literal_support: parsed.data?.score?.buyer_confidence?.weights?.affiliation_literal_support
              ?? DEFAULT_SCORE_BUYER_CONFIDENCE.weights.affiliation_literal_support,
          },
          penalties: {
            open_contradiction: parsed.data?.score?.buyer_confidence?.penalties?.open_contradiction
              ?? DEFAULT_SCORE_BUYER_CONFIDENCE.penalties.open_contradiction,
            maximum_total: parsed.data?.score?.buyer_confidence?.penalties?.maximum_total
              ?? DEFAULT_SCORE_BUYER_CONFIDENCE.penalties.maximum_total,
          },
        },
        mail_confidence: {
          weights: {
            address_present: parsed.data?.score?.mail_confidence?.weights?.address_present
              ?? DEFAULT_SCORE_MAIL_CONFIDENCE.weights.address_present,
            address_complete: parsed.data?.score?.mail_confidence?.weights?.address_complete
              ?? DEFAULT_SCORE_MAIL_CONFIDENCE.weights.address_complete,
            commercial_delivery_indicator: parsed.data?.score?.mail_confidence?.weights?.commercial_delivery_indicator
              ?? DEFAULT_SCORE_MAIL_CONFIDENCE.weights.commercial_delivery_indicator,
            validation_evidence: parsed.data?.score?.mail_confidence?.weights?.validation_evidence
              ?? DEFAULT_SCORE_MAIL_CONFIDENCE.weights.validation_evidence,
          },
          penalties: {
            open_contradiction: parsed.data?.score?.mail_confidence?.penalties?.open_contradiction
              ?? DEFAULT_SCORE_MAIL_CONFIDENCE.penalties.open_contradiction,
            maximum_total: parsed.data?.score?.mail_confidence?.penalties?.maximum_total
              ?? DEFAULT_SCORE_MAIL_CONFIDENCE.penalties.maximum_total,
          },
        },
        golden_ticket: {
          minimums: {
            ...DEFAULT_SCORE_GOLDEN_TICKET.minimums,
            ...(parsed.data?.score?.golden_ticket?.minimums || {}),
          },
        },
        action_confidence: {
          minimums: {
            ...DEFAULT_SCORE_ACTION_CONFIDENCE.minimums,
            ...(parsed.data?.score?.action_confidence?.minimums || {}),
          },
        },
        reachability: {
          minimums: {
            ...DEFAULT_SCORE_REACHABILITY.minimums,
            ...(parsed.data?.score?.reachability?.minimums || {}),
          },
        },
        candidate_tier: {
          bands: parsed.data?.score?.candidate_tier?.bands ?? [...DEFAULT_SCORE_CANDIDATE_TIER.bands],
        },
        postcard: {
          minimums: {
            ...DEFAULT_SCORE_POSTCARD.minimums,
            ...(parsed.data?.score?.postcard?.minimums || {}),
          },
        },
        enrichment_repair: {
          minimums: {
            ...DEFAULT_SCORE_ENRICHMENT_REPAIR.minimums,
            ...(parsed.data?.score?.enrichment_repair?.minimums || {}),
          },
          channel_evidence_candidate_tiers:
            parsed.data?.score?.enrichment_repair?.channel_evidence_candidate_tiers
            ?? [...DEFAULT_SCORE_ENRICHMENT_REPAIR.channel_evidence_candidate_tiers],
        },
        enrichment_budget: {
          ceilings: {
            ...DEFAULT_SCORE_ENRICHMENT_BUDGET.ceilings,
            ...(parsed.data?.score?.enrichment_budget?.ceilings || {}),
          },
        },
      },
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
