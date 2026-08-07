export type ModelContextBudget = {
  max_chars: number;
  max_tokens: number;
};

export type ModelContextContributor = {
  field: string;
  chars: number;
};

export type ModelContextTelemetry = {
  chars: number;
  estimated_tokens: number;
  top_contributors: ModelContextContributor[];
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

const DIAGNOSTIC_CONTENT_FIELDS = [
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

const DIAGNOSTIC_INTERNAL_PREDICATE = /(?:^|_)(?:fit|score|confidence|tier|readiness|blocker|next_action|work_state|sequence|taxonomy|scrape|failure|error|status)(?:_|$)/;

const DIAGNOSTIC_EVIDENCE_FIELDS = new Set([
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

const diagnosticObservationsFrom = (value: unknown): Array<Record<string, unknown>> => (
  observationsFrom(value).filter((observation) => {
    const predicate = String(observation.predicate || '').trim().toLowerCase();
    return predicate !== '' && !DIAGNOSTIC_INTERNAL_PREDICATE.test(predicate);
  })
);

const hasDiagnosticScalarEvidence = (source: Record<string, unknown>) => (
  [...DIAGNOSTIC_EVIDENCE_FIELDS].some((field) => String(source[field] || '').trim() !== '')
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
}: {
  data: Record<string, unknown>;
  budget?: unknown;
}): ModelContext => {
  const serialized = JSON.stringify(data, null, 2);
  const telemetry = {
    chars: serialized.length,
    estimated_tokens: Math.ceil(serialized.length / 4),
    top_contributors: Object.entries(data)
      .map(([field, value]) => contributorChars(field, value))
      .sort((left, right) => right.chars - left.chars)
      .slice(0, 5),
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
}: {
  record: unknown;
  inputs?: unknown;
  identityFields?: unknown;
  budget?: unknown;
}): ModelContext => {
  const source = isRecord(record) ? record : {};
  const allowedFields = normalizeFieldNames([
    ...DEFAULT_IDENTITY_FIELDS,
    ...normalizeFieldNames(identityFields),
    ...normalizeFieldNames(inputs),
  ]);
  const data = allowedFields.reduce<Record<string, unknown>>((context, field) => {
    if (source[field] === undefined) return context;
    return { ...context, [field]: source[field] };
  }, {});
  const observations = observationsFrom(source.observations_json);
  const withObservations = observations.length > 0
    ? { ...data, observations_json: observations }
    : data;
  return buildModelContextPayload({ data: withObservations, budget });
};

export const diagnosticContentHasBusinessEvidence = (record: unknown): boolean => {
  const source = isRecord(record) ? record : {};
  return hasDiagnosticScalarEvidence(source) || diagnosticObservationsFrom(source.observations_json).length > 0;
};

export const buildDiagnosticContentModelContext = ({
  record,
  budget,
}: {
  record: unknown;
  budget?: unknown;
}): ModelContext => {
  const source = isRecord(record) ? record : {};
  const data = DIAGNOSTIC_CONTENT_FIELDS.reduce<Record<string, unknown>>((context, field) => {
    if (source[field] === undefined) return context;
    return { ...context, [field]: source[field] };
  }, {});
  const observations = diagnosticObservationsFrom(source.observations_json);
  const withObservations = observations.length > 0
    ? { ...data, observations_json: observations }
    : data;
  return buildModelContextPayload({ data: withObservations, budget });
};

export const withModelContextTelemetry = (usage: unknown, telemetry: ModelContextTelemetry) => ({
  ...(isRecord(usage) ? usage : {}),
  model_context: telemetry,
});
