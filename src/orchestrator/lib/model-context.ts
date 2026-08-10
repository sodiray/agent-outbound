import { resolveStageInputs, type StageInputTruncation } from './stage-inputs.js';

export type ModelContextBudget = {
  max_chars: number;
  max_tokens: number;
};

export type ModelContextContributor = {
  field: string;
  chars: number;
};

export type ModelContextTruncation = {
  name: string;
  originalChars: number;
  keptChars: number;
};

export type ModelContextTelemetry = {
  chars: number;
  estimated_tokens: number;
  top_contributors: ModelContextContributor[];
  /** Declared inputs clamped by max_chars before assembly (visible clamp record). */
  truncated_inputs?: ModelContextTruncation[];
};

export type ModelContext = {
  data: Record<string, unknown>;
  serialized: string;
  telemetry: ModelContextTelemetry;
};

export class ModelContextBudgetError extends Error {
  telemetry: ModelContextTelemetry;
  budget: ModelContextBudget;

  constructor({ telemetry, budget }: { telemetry: ModelContextTelemetry; budget: ModelContextBudget }) {
    const contributors = telemetry.top_contributors
      .map((contributor) => `${contributor.field} (${contributor.chars} chars)`)
      .join(', ');
    super(
      `Model context budget exceeded: ${telemetry.chars} chars (~${telemetry.estimated_tokens} tokens) `
      + `exceeds ${budget.max_chars} chars / ${budget.max_tokens} tokens. `
      + `Top contributors: ${contributors || '(none)'}.`,
    );
    this.name = 'ModelContextBudgetError';
    this.telemetry = telemetry;
    this.budget = budget;
  }
}

const DEFAULT_IDENTITY_FIELDS = [
  '_row_id',
  'id',
  'business_name',
  'name',
  'address',
  'city',
  'state',
  'zip',
  'postal_code',
  'country',
  'website',
  'domain',
  'place_id',
  'google_place_id',
  'primary_type',
  'latitude',
  'longitude',
] as const;

const BUSINESS_EVIDENCE_CONTEXT_FIELDS = [
  'business_name',
  'name',
  'address',
  'city',
  'state',
  'zip',
  'postal_code',
  'country',
  'website',
  'domain',
  'vertical',
  'sub_vertical',
  'services',
  'service_offerings',
  'business_description',
  'description',
  'site_text',
  'phone',
  'email_primary',
  'contact_name',
  'contact_title',
  'contact_email',
  'contact_name_primary',
  'contact_title_primary',
  'linkedin_name',
  'linkedin_headline',
  'linkedin_company_url',
] as const;

const INTERNAL_EVALUATION_PREDICATE = /(?:^|_)(?:fit|score|confidence|tier|readiness|blocker|next_action|work_state|sequence|taxonomy|scrape|failure|error|status)(?:_|$)/;

const BUSINESS_EVIDENCE_FIELDS = new Set([
  'site_text',
  'services',
  'service_offerings',
  'business_description',
  'description',
]);

export const DEFAULT_MODEL_CONTEXT_BUDGET: ModelContextBudget = {
  max_chars: 100_000,
  max_tokens: 25_000,
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const jsonValue = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const normalizeFieldNames = (fields: unknown): string[] => (
  Array.isArray(fields)
    ? [...new Set(fields.map((field) => String(field || '').trim()).filter(Boolean))]
    : []
);

const inputEntries = (inputs: unknown): Array<{ name: string; from?: string; value?: unknown }> => {
  if (Array.isArray(inputs)) return normalizeFieldNames(inputs).map((field) => ({ name: field, from: field }));
  if (!isRecord(inputs)) return [];
  return Object.entries(inputs).reduce<Array<{ name: string; from?: string; value?: unknown }>>((entries, [name, definition]) => {
    const entry = isRecord(definition) ? definition : {};
    const from = String(entry.from || '').trim();
    if (from) return [...entries, { name, from }];
    if (Object.prototype.hasOwnProperty.call(entry, 'value')) return [...entries, { name, value: entry.value }];
    return entries;
  }, []);
};

const valueAtPath = (source: Record<string, unknown>, path: string): unknown => (
  path.split('.').filter(Boolean).reduce<unknown>((current, segment) => (
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)[segment]
      : undefined
  ), source)
);

const observationsFrom = (value: unknown): Array<Record<string, unknown>> => {
  const parsed = jsonValue(value);
  const observations = Array.isArray(parsed)
    ? parsed
    : (isRecord(parsed) && Array.isArray(parsed.observations) ? parsed.observations : []);
  return observations.flatMap((observation) => {
    if (!isRecord(observation)) return [];
    return [{
      predicate: observation.predicate,
      value: observation.value,
      evidence_id: observation.evidence_id,
      support_status: observation.support_status,
    }];
  });
};

const businessEvidenceObservationsFrom = (value: unknown): Array<Record<string, unknown>> => (
  observationsFrom(value).filter((observation) => {
    const predicate = String(observation.predicate || '').trim().toLowerCase();
    return predicate !== '' && !INTERNAL_EVALUATION_PREDICATE.test(predicate);
  })
);

const hasBusinessEvidenceScalar = (source: Record<string, unknown>) => (
  [...BUSINESS_EVIDENCE_FIELDS].some((field) => String(source[field] || '').trim() !== '')
);

const contributorChars = (field: string, value: unknown): ModelContextContributor => ({
  field,
  chars: JSON.stringify({ [field]: value }).length,
});

export const modelContextBudget = (value: unknown): ModelContextBudget => {
  const source = isRecord(value) ? value : {};
  const maxChars = Number(source.max_chars);
  const maxTokens = Number(source.max_tokens);
  return {
    max_chars: Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MODEL_CONTEXT_BUDGET.max_chars,
    max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : DEFAULT_MODEL_CONTEXT_BUDGET.max_tokens,
  };
};

export const buildModelContextPayload = ({
  data,
  budget,
  truncatedInputs = [],
}: {
  data: Record<string, unknown>;
  budget?: unknown;
  /** Per-input max_chars clamps applied before assembly (for telemetry). */
  truncatedInputs?: StageInputTruncation[];
}): ModelContext => {
  const serialized = JSON.stringify(data, null, 2);
  const telemetry: ModelContextTelemetry = {
    chars: serialized.length,
    estimated_tokens: Math.ceil(serialized.length / 4),
    top_contributors: Object.entries(data)
      .map(([field, value]) => contributorChars(field, value))
      .sort((left, right) => right.chars - left.chars)
      .slice(0, 5),
    ...(truncatedInputs.length > 0
      ? {
        truncated_inputs: truncatedInputs.map((entry) => ({
          name: entry.name,
          originalChars: entry.originalChars,
          keptChars: entry.keptChars,
        })),
      }
      : {}),
  };
  const resolvedBudget = modelContextBudget(budget);
  if (telemetry.chars > resolvedBudget.max_chars || telemetry.estimated_tokens > resolvedBudget.max_tokens) {
    throw new ModelContextBudgetError({ telemetry, budget: resolvedBudget });
  }
  return {
    data,
    serialized: `<untrusted_data>\n${serialized}\n</untrusted_data>`,
    telemetry,
  };
};

export const buildModelContext = ({
  record,
  inputs = [],
  identityFields = [],
  budget,
  strict = false,
}: {
  record: unknown;
  inputs?: unknown;
  identityFields?: unknown;
  budget?: unknown;
  strict?: boolean;
}): ModelContext => {
  const source = isRecord(record) ? record : {};
  const implicitFields = strict
    ? []
    : normalizeFieldNames([...DEFAULT_IDENTITY_FIELDS, ...normalizeFieldNames(identityFields)]);
  const mapForm = isRecord(inputs) && !Array.isArray(inputs);
  // Map-form declared inputs go through resolveStageInputs so max_chars clamps
  // apply before assembly — the live failure mode for oversized page text on
  // semantic filters. Array form has no per-input options; values are raw.
  let truncatedInputs: StageInputTruncation[] = [];
  let declaredEntries: Array<{ name: string; from?: string; value?: unknown }>;
  if (mapForm) {
    const resolved = resolveStageInputs({ step: { inputs }, record: source });
    truncatedInputs = resolved.truncated;
    declaredEntries = Object.entries(resolved.values).map(([name, value]) => ({ name, value }));
  } else {
    declaredEntries = inputEntries(inputs);
  }
  const entries: Array<{ name: string; from?: string; value?: unknown }> = [
    ...implicitFields.map((field) => ({ name: field, from: field })),
    ...declaredEntries,
  ];
  const data = entries.reduce<Record<string, unknown>>((context, entry) => {
    // Map-form resolved entries carry `value` only (already max_chars-clamped).
    // Array-form / identity entries carry `from` and read the raw record.
    const value = entry.from ? valueAtPath(source, entry.from) : entry.value;
    if (value === undefined) return context;
    return { ...context, [entry.name]: value };
  }, {});
  const observations = strict
    ? (Object.prototype.hasOwnProperty.call(data, 'observations_json') ? observationsFrom(data.observations_json) : [])
    : observationsFrom(source.observations_json);
  const withObservations = observations.length > 0
    ? { ...data, observations_json: observations }
    : data;
  return buildModelContextPayload({ data: withObservations, budget, truncatedInputs });
};

export const businessEvidenceIsAvailable = (record: unknown): boolean => {
  const source = isRecord(record) ? record : {};
  return hasBusinessEvidenceScalar(source) || businessEvidenceObservationsFrom(source.observations_json).length > 0;
};

export const buildBusinessEvidenceModelContext = ({
  record,
  budget,
}: {
  record: unknown;
  budget?: unknown;
}): ModelContext => {
  const source = isRecord(record) ? record : {};
  const data = BUSINESS_EVIDENCE_CONTEXT_FIELDS.reduce<Record<string, unknown>>((context, field) => {
    if (source[field] === undefined) return context;
    return { ...context, [field]: source[field] };
  }, {});
  const observations = businessEvidenceObservationsFrom(source.observations_json);
  const withObservations = observations.length > 0
    ? { ...data, observations_json: observations }
    : data;
  return buildModelContextPayload({ data: withObservations, budget });
};

export const withModelContextTelemetry = (usage: unknown, telemetry: ModelContextTelemetry) => ({
  ...(isRecord(usage) ? usage : {}),
  model_context: telemetry,
});
