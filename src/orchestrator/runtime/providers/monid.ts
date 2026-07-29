import { AgentOutboundError } from '../contract.js';
import { formatErrorMessage } from '../../lib/error-format.js';
import { executeJsonCommand } from './command.js';
import type {
  ProviderParameterLocation,
  ProviderToolSchema,
  ToolProvider,
} from './types.js';
import { recordProviderToolCost } from './usage.js';

type MonidProviderOptions = {
  command?: string;
  commandTimeoutMs?: number;
  pollIntervalMs?: number;
  pollDeadlineMs?: number;
};

type MonidToolRef = {
  slug: string;
  provider: string;
  endpoint: string;
  name: string;
  description: string;
};

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'TIME_OUT', 'STOPPED', 'BLOCKED']);

const positiveNumber = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const asArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (Array.isArray(record.results)) return record.results;
  if (Array.isArray(record.items)) return record.items;
  if (Array.isArray(record.data)) return record.data;
  return [];
};

const syntheticPart = (value: unknown) => String(value || '')
  .trim()
  .toUpperCase()
  .replace(/[^A-Z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

export const monidSyntheticSlug = (provider: string, endpoint: string) => (
  `MONID__${syntheticPart(provider)}__${syntheticPart(endpoint)}`
);

const schemaType = (value: string) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].includes(normalized)) {
    return normalized;
  }
  return 'string';
};

const normalizePropertySchema = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') return { type: schemaType(value) };
  if (Array.isArray(value)) {
    const item = value[0];
    return { type: 'array', items: normalizePropertySchema(item || 'string') };
  }
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return {};
  return record;
};

const SCHEMA_METADATA_KEYS = new Set([
  '$defs',
  '$anchor',
  '$comment',
  '$dynamicAnchor',
  '$dynamicRef',
  '$id',
  '$ref',
  '$schema',
  '$vocabulary',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'contains',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
  'default',
  'definitions',
  'dependentRequired',
  'dependentSchemas',
  'deprecated',
  'description',
  'discriminator',
  'else',
  'enum',
  'example',
  'examples',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'externalDocs',
  'format',
  'if',
  'items',
  'maxItems',
  'maxContains',
  'maxLength',
  'maxProperties',
  'maximum',
  'minItems',
  'minContains',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'not',
  'nullable',
  'oneOf',
  'pattern',
  'patternProperties',
  'prefixItems',
  'properties',
  'propertyNames',
  'readOnly',
  'required',
  'schemaVersion',
  'then',
  'title',
  'type',
  'unevaluatedItems',
  'unevaluatedProperties',
  'uniqueItems',
  'writeOnly',
  'xml',
]);

const looksLikePropertySchema = (value: unknown) => (
  typeof value === 'string'
  || Array.isArray(value)
  || (value !== null && typeof value === 'object')
);

const normalizeSchemaBucket = (value: unknown) => {
  const record = asRecord(value);
  const rawProperties = asRecord(record.properties);
  const bareEntries = Object.entries(record)
    .filter(([key]) => !SCHEMA_METADATA_KEYS.has(key));
  const useBarePropertyMap = !Object.prototype.hasOwnProperty.call(record, 'properties')
    && bareEntries.length > 0
    && bareEntries.every(([, spec]) => looksLikePropertySchema(spec));
  const properties = Object.prototype.hasOwnProperty.call(record, 'properties')
    ? Object.fromEntries(Object.entries(rawProperties).map(([key, spec]) => [key, normalizePropertySchema(spec)]))
    : useBarePropertyMap
      ? Object.fromEntries(bareEntries
        .map(([key, spec]) => [key, normalizePropertySchema(spec)]))
      : {};
  return {
    properties,
    required: Array.isArray(record.required)
      ? record.required.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
  };
};

const withCollisionNote = (
  schema: Record<string, unknown>,
  name: string,
  locations: ProviderParameterLocation[],
  chosen: ProviderParameterLocation,
) => {
  const existing = String(schema.description || '').trim();
  const note = `Monid also declares "${name}" in ${locations.filter((location) => location !== chosen).join(' and ')}; the flat argument is routed to ${chosen}.`;
  return { ...schema, description: [existing, note].filter(Boolean).join(' ') };
};

const flattenInputSchema = (payload: Record<string, unknown>) => {
  const input = asRecord(payload.input);
  const buckets: Array<{ location: ProviderParameterLocation; schema: ReturnType<typeof normalizeSchemaBucket> }> = [
    { location: 'path', schema: normalizeSchemaBucket(input.pathParams) },
    { location: 'query', schema: normalizeSchemaBucket(input.queryParams) },
    { location: 'body', schema: normalizeSchemaBucket(input.body) },
  ];
  const hasStructuredInput = buckets.some((bucket) => Object.keys(bucket.schema.properties).length > 0);
  if (!hasStructuredInput) {
    const legacy = normalizeSchemaBucket(payload.inputSchema);
    return {
      inputSchema: {
        type: 'object',
        properties: legacy.properties,
        required: [...new Set(legacy.required)],
        additionalProperties: false,
      },
      parameterLocations: Object.fromEntries(
        Object.keys(legacy.properties).map((name) => [name, 'body' as ProviderParameterLocation]),
      ),
      parameterCollisions: {},
    };
  }

  const occurrences = buckets.reduce<Record<string, ProviderParameterLocation[]>>((all, bucket) => {
    Object.keys(bucket.schema.properties).forEach((name) => {
      all[name] = [...(all[name] || []), bucket.location];
    });
    return all;
  }, {});
  const parameterLocations = Object.fromEntries(
    Object.entries(occurrences).map(([name, locations]) => [name, locations.at(-1) as ProviderParameterLocation]),
  );
  const parameterCollisions = Object.fromEntries(
    Object.entries(occurrences).filter(([, locations]) => locations.length > 1),
  );
  const properties = buckets.reduce<Record<string, unknown>>((all, bucket) => ({
    ...all,
    ...Object.fromEntries(Object.entries(bucket.schema.properties).map(([name, schema]) => {
      const locations = occurrences[name] || [];
      const chosen = parameterLocations[name];
      return [
        name,
        locations.length > 1 && chosen === bucket.location
          ? withCollisionNote(schema, name, locations, chosen)
          : schema,
      ];
    })),
  }), {});
  const required = [...new Set(buckets.flatMap((bucket) => bucket.schema.required))];
  return {
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    parameterLocations,
    parameterCollisions,
  };
};

const toolRefFrom = (value: unknown): MonidToolRef | null => {
  const item = asRecord(value);
  const provider = String(item.provider || '').trim();
  const endpoint = String(item.endpoint || '').trim();
  if (!provider || !endpoint) return null;
  return {
    slug: monidSyntheticSlug(provider, endpoint),
    provider,
    endpoint,
    name: String(item.name || item.providerName || endpoint).trim(),
    description: String(item.description || item.summary || '').trim(),
  };
};

const toSearchSchema = (ref: MonidToolRef): ProviderToolSchema => ({
  slug: ref.slug,
  server: 'monid',
  toolkit: ref.provider.toUpperCase(),
  provider: ref.provider,
  endpoint: ref.endpoint,
  name: ref.name,
  description: ref.description,
  input_schema: { type: 'object', properties: {} },
});

const errorDetail = (run: Record<string, unknown>) => {
  const error = run.error || asRecord(run.providerResponse).error;
  return formatErrorMessage(error, 'No error detail provided.');
};

const blockedControlNames = (run: Record<string, unknown>) => {
  const controls = Array.isArray(run.controls) ? run.controls : [];
  return controls.map((value) => {
    const control = asRecord(value);
    const snapshot = asRecord(control.snapshot);
    const type = String(snapshot.type || 'UNKNOWN_WORKSPACE_CONTROL');
    const id = String(control.controlId || '').trim();
    return id ? `${type} (${id})` : type;
  });
};

const parseJsonPayload = (value: unknown) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const outputPayload = (run: Record<string, unknown>) => {
  const providerResponse = asRecord(run.providerResponse);
  if (providerResponse.data !== undefined) return parseJsonPayload(providerResponse.data);
  if (run.output !== undefined) return parseJsonPayload(run.output);
  if (providerResponse.error !== undefined) return parseJsonPayload(providerResponse.error);
  return null;
};

const wait = (delayMs: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, delayMs);
});

const monidProviderError = (message: string) => {
  const error = new Error(message);
  error.name = 'MonidProviderError';
  return error;
};

const numericCost = (value: unknown) => (
  value === null || value === undefined || value === ''
    ? Number.NaN
    : Number(value)
);

const resolvedRunCost = (run: Record<string, unknown>) => {
  const cost = asRecord(run.cost);
  const amount = asRecord(cost.amount);
  const directCost = numericCost(cost.value);
  if (Number.isFinite(directCost)) {
    return {
      usdCost: directCost,
      currency: String(cost.currency || amount.currency || 'USD').toUpperCase(),
    };
  }

  const nestedCost = numericCost(amount.value);
  if (Number.isFinite(nestedCost)) {
    return {
      usdCost: nestedCost,
      currency: String(amount.currency || cost.currency || 'USD').toUpperCase(),
    };
  }

  const billing = asRecord(run.billing);
  const reportedCost = asRecord(billing.reportedCost);
  const reportedValue = numericCost(reportedCost.value);
  if (Number.isFinite(reportedValue)) {
    const unit = String(reportedCost.unit || 'USD').trim().toUpperCase();
    if (unit !== 'MICRO_DOLLAR' && unit !== 'USD') {
      throw monidProviderError(`Monid run "${String(run.runId || '')}" returned unsupported reported cost unit "${unit}".`);
    }
    return {
      usdCost: unit === 'MICRO_DOLLAR' ? reportedValue / 1_000_000 : reportedValue,
      currency: String(reportedCost.currency || billing.currency || 'USD').toUpperCase(),
    };
  }

  const price = asRecord(run.price);
  const priceAmount = asRecord(price.amount);
  const catalogRate = numericCost(priceAmount.value);
  const billedUnits = run.billedUnits === null
    || run.billedUnits === undefined
    || run.billedUnits === ''
    ? 1
    : numericCost(run.billedUnits);
  const estimatedCost = catalogRate * billedUnits;
  if (!Number.isFinite(estimatedCost)) return null;

  // This is the catalog rate, not a reported charge, so it is only a last-resort estimate.
  return {
    usdCost: estimatedCost,
    currency: String(priceAmount.currency || price.currency || 'USD').toUpperCase(),
  };
};

export class MonidProvider implements ToolProvider {
  id = 'monid';
  private command: string;
  private commandTimeoutMs: number;
  private pollIntervalMs: number;
  private pollDeadlineMs: number;
  private refsBySlug = new Map<string, MonidToolRef>();
  private schemasBySlug = new Map<string, ProviderToolSchema>();

  constructor(options: MonidProviderOptions = {}) {
    this.command = String(options.command || process.env.AO_MONID_COMMAND || 'monid');
    this.commandTimeoutMs = positiveNumber(
      options.commandTimeoutMs ?? process.env.AO_MONID_COMMAND_TIMEOUT_MS,
      60_000,
    );
    this.pollIntervalMs = positiveNumber(
      options.pollIntervalMs ?? process.env.AO_MONID_POLL_INTERVAL_MS,
      1_500,
    );
    this.pollDeadlineMs = positiveNumber(
      options.pollDeadlineMs ?? process.env.AO_MONID_POLL_DEADLINE_MS,
      180_000,
    );
  }

  private async json(argv: string[], label: string) {
    try {
      return asRecord(await executeJsonCommand({
        command: this.command,
        argv,
        env: { NO_COLOR: '1' },
        timeoutMs: this.commandTimeoutMs,
        label,
      }));
    } catch (error) {
      throw monidProviderError(`${label} failed: ${formatErrorMessage(error)}`);
    }
  }

  private registerRef(ref: MonidToolRef) {
    const key = ref.slug.toUpperCase();
    const existing = this.refsBySlug.get(key);
    if (
      existing
      && (existing.provider !== ref.provider || existing.endpoint !== ref.endpoint)
    ) {
      throw new Error(`Monid synthetic slug collision for "${ref.slug}": ${existing.provider}${existing.endpoint} and ${ref.provider}${ref.endpoint}.`);
    }
    this.refsBySlug.set(key, ref);
  }

  registerSchemas(schemas: ProviderToolSchema[]) {
    schemas.forEach((schema) => {
      const provider = String(schema.provider || '').trim();
      const endpoint = String(schema.endpoint || '').trim();
      if (!provider || !endpoint) return;
      const ref: MonidToolRef = {
        slug: String(schema.slug || monidSyntheticSlug(provider, endpoint)).toUpperCase(),
        provider,
        endpoint,
        name: String(schema.name || endpoint),
        description: String(schema.description || ''),
      };
      this.registerRef(ref);
      this.schemasBySlug.set(ref.slug, schema);
    });
  }

  async searchTools(
    queries: Array<string | Record<string, unknown>>,
    limit = 20,
  ): Promise<ProviderToolSchema[]> {
    const normalizedQueries = queries
      .map((query) => typeof query === 'string' ? query : JSON.stringify(query || {}))
      .map((query) => query.trim())
      .filter(Boolean);
    if (normalizedQueries.length === 0) return [];
    const queryLimit = Math.max(1, Math.min(50, Math.floor(Number(limit || 20))));
    const responses = await Promise.all(normalizedQueries.map((query) => this.json(
      ['discover', '-q', query, '-l', String(queryLimit), '-j'],
      `Monid discover "${query}"`,
    )));
    const refs = responses
      .flatMap((response) => asArray(response.results))
      .map(toolRefFrom)
      .filter((ref): ref is MonidToolRef => Boolean(ref));
    const unique = refs.reduce<MonidToolRef[]>((all, ref) => (
      all.some((candidate) => candidate.slug === ref.slug) ? all : [...all, ref]
    ), []).slice(0, queryLimit);
    unique.forEach((ref) => this.registerRef(ref));
    return unique.map(toSearchSchema);
  }

  async getSchemas(slugs: string[]): Promise<ProviderToolSchema[]> {
    const wanted = [...new Set(slugs.map((slug) => String(slug || '').trim().toUpperCase()).filter(Boolean))];
    const missingRefs = wanted.filter((slug) => !this.schemasBySlug.has(slug))
      .map((slug) => this.refsBySlug.get(slug))
      .filter((ref): ref is MonidToolRef => Boolean(ref));
    const inspected = await Promise.all(missingRefs.map(async (ref) => {
      const payload = await this.json(
        ['inspect', '-p', ref.provider, '-e', ref.endpoint, '-j'],
        `Monid inspect ${ref.provider}${ref.endpoint}`,
      );
      const provider = String(payload.provider || ref.provider).trim();
      const endpoint = String(payload.endpoint || ref.endpoint).trim();
      const actualRef = {
        ...ref,
        provider,
        endpoint,
        name: String(payload.name || payload.providerName || ref.name),
        description: String(payload.description || payload.summary || ref.description),
      };
      const flattened = flattenInputSchema(payload);
      const schema: ProviderToolSchema = {
        slug: ref.slug,
        server: 'monid',
        toolkit: provider.toUpperCase(),
        provider,
        endpoint,
        name: actualRef.name,
        description: actualRef.description,
        input_schema: flattened.inputSchema,
        parameter_locations: flattened.parameterLocations,
        parameter_collisions: flattened.parameterCollisions,
      };
      this.registerRef(actualRef);
      this.schemasBySlug.set(ref.slug, schema);
      return schema;
    }));
    if (inspected.length > 0) this.registerSchemas(inspected);
    return wanted
      .map((slug) => this.schemasBySlug.get(slug))
      .filter((schema): schema is ProviderToolSchema => Boolean(schema));
  }

  private splitArgs(schema: ProviderToolSchema, args: Record<string, unknown>) {
    const locations = schema.parameter_locations || {};
    return Object.entries(args || {}).reduce((split, [name, value]) => {
      const location = locations[name] || 'body';
      return {
        ...split,
        [location]: { ...split[location], [name]: value },
      };
    }, {
      path: {} as Record<string, unknown>,
      query: {} as Record<string, unknown>,
      body: {} as Record<string, unknown>,
    });
  }

  private async pollRun(runId: string, startedAt: number): Promise<Record<string, unknown>> {
    if (Date.now() - startedAt >= this.pollDeadlineMs) {
      throw monidProviderError(`Monid run "${runId}" exceeded its ${this.pollDeadlineMs}ms polling deadline.`);
    }
    await wait(this.pollIntervalMs);
    const run = await this.json(
      ['runs', 'get', '-r', runId, '-j'],
      `Monid runs get ${runId}`,
    );
    const status = String(run.status || '').toUpperCase();
    if (TERMINAL_STATUSES.has(status)) return run;
    return this.pollRun(runId, startedAt);
  }

  private completedResult(slug: string, run: Record<string, unknown>) {
    const resolvedCost = resolvedRunCost(run);
    if (!resolvedCost) {
      throw monidProviderError(`Monid run "${String(run.runId || '')}" completed without a finite numeric cost.`);
    }
    const { usdCost, currency } = resolvedCost;
    if (currency !== 'USD') {
      throw monidProviderError(`Monid run "${String(run.runId || '')}" returned unsupported cost currency "${currency}".`);
    }
    recordProviderToolCost({
      provider: 'monid',
      slug,
      usd_cost: usdCost,
      payload: {
        run_id: String(run.runId || ''),
        provider: String(run.provider || ''),
        endpoint: String(run.endpoint || ''),
        currency,
      },
    });
    return outputPayload(run);
  }

  private resolveTerminal(slug: string, run: Record<string, unknown>) {
    const status = String(run.status || '').toUpperCase();
    const runId = String(run.runId || '');
    if (status === 'COMPLETED') return this.completedResult(slug, run);
    if (status === 'BLOCKED') {
      const controls = blockedControlNames(run);
      throw new AgentOutboundError({
        code: 'BUDGET_EXCEEDED',
        message: `Monid run "${runId}" was blocked by workspace control: ${controls.join(', ') || 'UNKNOWN_WORKSPACE_CONTROL'}.`,
        retryable: false,
        hint: 'Review the named Monid workspace control before retrying.',
        fields: {
          provider: 'monid',
          run_id: runId,
          status,
          controls: Array.isArray(run.controls) ? run.controls : [],
        },
      });
    }
    throw monidProviderError(`Monid run "${runId}" ended with ${status || 'UNKNOWN'}: ${errorDetail(run)}`);
  }

  async executeTool(slug: string, args: Record<string, unknown>) {
    const key = String(slug || '').trim().toUpperCase();
    const schemas = await this.getSchemas([key]);
    const schema = schemas[0];
    if (!schema?.provider || !schema.endpoint) {
      throw monidProviderError(`Monid tool "${slug}" has no provider/endpoint mapping. Refresh the tool catalog before executing it.`);
    }
    const split = this.splitArgs(schema, args || {});
    const argv = [
      'run',
      '-p',
      schema.provider,
      '-e',
      schema.endpoint,
      ...(Object.keys(split.body).length > 0 ? ['-i', JSON.stringify(split.body)] : []),
      ...(Object.keys(split.query).length > 0 ? ['--query', JSON.stringify(split.query)] : []),
      ...(Object.keys(split.path).length > 0 ? ['--path', JSON.stringify(split.path)] : []),
      '-j',
    ];
    const startedAt = Date.now();
    const initial = await this.json(argv, `Monid run ${schema.provider}${schema.endpoint}`);
    const initialStatus = String(initial.status || '').toUpperCase();
    const runId = String(initial.runId || '').trim();
    if (!TERMINAL_STATUSES.has(initialStatus) && !runId) {
      throw monidProviderError(`Monid run ${schema.provider}${schema.endpoint} returned no runId.`);
    }
    const terminal = TERMINAL_STATUSES.has(initialStatus)
      ? initial
      : await this.pollRun(runId, startedAt);
    return this.resolveTerminal(key, terminal);
  }
}
