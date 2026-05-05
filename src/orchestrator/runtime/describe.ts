export type CommandDefinition = {
  name: string;
  description: string;
  mutating: boolean;
  flags: Array<{
    name: string;
    type: string;
    required?: boolean;
    default?: string | number | boolean;
    description: string;
  }>;
  input_schema: Record<string, any>;
  output_schema: Record<string, any>;
  examples: string[];
};

const COMMON_OUTPUT = {
  ok: 'boolean',
  command: 'string',
  schema_version: 'string',
  warnings: 'array',
  usage: 'object',
};

const CATALOG: CommandDefinition[] = [
  {
    name: 'describe',
    description: 'List command contracts for agent consumers.',
    mutating: false,
    flags: [
      { name: '--command', type: 'string', required: false, description: 'Filter to a single command.' },
    ],
    input_schema: { command: 'optional string' },
    output_schema: { ...COMMON_OUTPUT, result: { commands: 'CommandDefinition[]', count: 'number' } },
    examples: ['agent-outbound describe', 'agent-outbound describe --command query'],
  },
  {
    name: 'query',
    description: 'Run read-only SQL against one list database.',
    mutating: false,
    flags: [
      { name: '--sql', type: 'string', required: true, description: 'Read query SQL.' },
      { name: '--limit', type: 'number', default: 500, description: 'Page size (capped).' },
      { name: '--cursor', type: 'string', required: false, description: 'Opaque pagination cursor.' },
      { name: '--timeout-ms', type: 'number', default: 4000, description: 'Requested timeout budget.' },
    ],
    input_schema: { list: 'string', sql: 'string', limit: 'optional number', cursor: 'optional string' },
    output_schema: {
      ...COMMON_OUTPUT,
      result: { rows: 'object[]', row_count: 'number', next_cursor: 'string|null', truncated: 'boolean' },
    },
    examples: ['agent-outbound query my-list --sql "SELECT * FROM records_enriched LIMIT 20"'],
  },
  {
    name: 'models',
    description: 'List locally supported provider/model identifiers from ~/.agent-outbound/models.json.',
    mutating: false,
    flags: [
      { name: '--provider', type: 'string', required: false, description: 'Filter provider id.' },
      { name: '--search', type: 'string', required: false, description: 'Substring search.' },
    ],
    input_schema: { provider: 'optional string', search: 'optional string' },
    output_schema: { ...COMMON_OUTPUT, result: { count: 'number', by_provider: 'object', models: 'array' } },
    examples: ['agent-outbound models --provider deepinfra', 'agent-outbound models --search llama'],
  },
  {
    name: 'models add',
    description: 'Validate and add a DeepInfra model to the supported model list.',
    mutating: true,
    flags: [
      { name: '<model>', type: 'string', required: true, description: 'deepinfra/<model-id>' },
    ],
    input_schema: { model: 'string' },
    output_schema: { ...COMMON_OUTPUT, result: { status: 'string', model: 'string', models_path: 'string' } },
    examples: ['agent-outbound models add deepinfra/meta-llama/Meta-Llama-3.1-70B-Instruct'],
  },
  {
    name: 'models remove',
    description: 'Remove a model from the local supported model list.',
    mutating: true,
    flags: [
      { name: '<model>', type: 'string', required: true, description: 'provider/model-id' },
    ],
    input_schema: { model: 'string' },
    output_schema: { ...COMMON_OUTPUT, result: { status: 'string', model: 'string', models_path: 'string' } },
    examples: ['agent-outbound models remove deepinfra/meta-llama/Meta-Llama-3.1-70B-Instruct'],
  },
  {
    name: 'models refresh',
    description: 'Re-fetch Anthropic and DeepInfra model lists and persist selected models.',
    mutating: true,
    flags: [],
    input_schema: {},
    output_schema: { ...COMMON_OUTPUT, result: { status: 'string', models_path: 'string', providers: 'object' } },
    examples: ['agent-outbound models refresh'],
  },
  {
    name: 'schema',
    description: 'Describe tables, views, columns, and relations for one list.',
    mutating: false,
    flags: [
      { name: '--table', type: 'string', required: false, description: 'Filter to one table/view.' },
      { name: '--format', type: 'string', default: 'json', description: 'json or markdown.' },
    ],
    input_schema: { list: 'string', table: 'optional string', format: 'optional string' },
    output_schema: { ...COMMON_OUTPUT, result: { tables: 'array', views: 'array', relationships: 'array', markdown: 'optional string' } },
    examples: ['agent-outbound schema my-list', 'agent-outbound schema my-list --table records_enriched --format markdown'],
  },
  {
    name: 'export',
    description: 'Export a projection to csv/jsonl/parquet.',
    mutating: false,
    flags: [
      { name: '--to', type: 'string', required: true, description: 'Destination file path.' },
      { name: '--select', type: 'string', required: true, description: 'Projection columns.' },
      { name: '--where', type: 'string', required: false, description: 'Read-only SQL predicate.' },
      { name: '--format', type: 'string', default: 'csv', description: 'csv | jsonl | parquet' },
    ],
    input_schema: { list: 'string', to: 'string', select: 'string', where: 'optional string', format: 'optional string' },
    output_schema: { ...COMMON_OUTPUT, result: { file: 'string', format: 'string', rows_written: 'number' } },
    examples: ['agent-outbound export my-list --to ./out.csv --select "business_name,fit_score" --where "fit_score >= 60" --format csv'],
  },
  {
    name: 'views save',
    description: 'Persist a named projection for reuse.',
    mutating: true,
    flags: [
      { name: '--name', type: 'string', required: true, description: 'View name.' },
      { name: '--select', type: 'string', required: true, description: 'Projection expression.' },
      { name: '--where', type: 'string', required: false, description: 'Default filter.' },
    ],
    input_schema: { list: 'string', name: 'string', select: 'string', where: 'optional string' },
    output_schema: { ...COMMON_OUTPUT, result: { status: 'string', name: 'string' } },
    examples: ['agent-outbound views save my-list --name route-brief --select "business_name,contacts_primary_email"'],
  },
  {
    name: 'record show',
    description: 'Read one record with optional includes.',
    mutating: false,
    flags: [
      { name: '--include', type: 'csv string', required: false, description: 'enrichment,scores,events,contacts,sequence,drafts,ai-usage' },
    ],
    input_schema: { list: 'string', row_id: 'string', include: 'optional csv string' },
    output_schema: { ...COMMON_OUTPUT, result: { record: 'object', sections: 'object' } },
    examples: ['agent-outbound record show my-list rec_123 --include enrichment,events,contacts'],
  },
  {
    name: 'pipeline show',
    description: 'Show funnel stage counts and age.',
    mutating: false,
    flags: [
      { name: '--format', type: 'string', default: 'json', description: 'json | summary' },
    ],
    input_schema: { list: 'string', format: 'optional string' },
    output_schema: { ...COMMON_OUTPUT, result: { stages: 'array', total: 'number' }, summary: 'optional string' },
    examples: ['agent-outbound pipeline show my-list', 'agent-outbound pipeline show my-list --format summary'],
  },
  {
    name: 'route show',
    description: 'Show route payload for one date.',
    mutating: false,
    flags: [
      { name: '--date', type: 'string', required: true, description: 'YYYY-MM-DD' },
      { name: '--include', type: 'csv string', required: false, description: 'enrichment,contacts,prior-touches' },
      { name: '--cursor', type: 'string', required: false, description: 'Pagination cursor.' },
      { name: '--limit', type: 'number', default: 100, description: 'Page size.' },
    ],
    input_schema: { list: 'string', date: 'string', include: 'optional csv string', cursor: 'optional string', limit: 'optional number' },
    output_schema: { ...COMMON_OUTPUT, result: { route_date: 'string', rows: 'array', next_cursor: 'string|null' } },
    examples: ['agent-outbound route show my-list --date 2026-04-21 --include enrichment,contacts,prior-touches'],
  },
  {
    name: 'replies show',
    description: 'Show full reply thread payloads.',
    mutating: false,
    flags: [
      { name: '--record', type: 'string', required: false, description: 'Row id.' },
      { name: '--since', type: 'string', required: false, description: 'Lower date bound.' },
      { name: '--until', type: 'string', required: false, description: 'Upper date bound.' },
      { name: '--classification', type: 'string', required: false, description: 'Reply classification filter.' },
    ],
    input_schema: { list: 'string', record: 'optional string', since: 'optional string', until: 'optional string' },
    output_schema: { ...COMMON_OUTPUT, result: { rows: 'array', count: 'number' } },
    examples: ['agent-outbound replies show my-list --since 2026-04-01 --classification booking_intent'],
  },
  {
    name: 'ai-usage',
    description: 'LLM token and dollar usage by scope.',
    mutating: false,
    flags: [
      { name: '--step', type: 'string', required: false, description: 'Filter by step.' },
      { name: '--record', type: 'string', required: false, description: 'Filter by record.' },
      { name: '--period', type: 'string', required: false, description: '7d, 30d, etc.' },
      { name: '--group-by', type: 'string', required: false, description: 'step | record | run | period' },
      { name: '--format', type: 'string', default: 'json', description: 'json | summary' },
    ],
    input_schema: { list: 'string', step: 'optional string', record: 'optional string', period: 'optional string', group_by: 'optional string' },
    output_schema: { ...COMMON_OUTPUT, result: { rows: 'array', totals: 'object' }, summary: 'optional string' },
    examples: ['agent-outbound ai-usage my-list --period 7d --group-by step'],
  },
  {
    name: 'usage',
    description: 'Third-party tool invocation counts.',
    mutating: false,
    flags: [
      { name: '--toolkit', type: 'string', required: false, description: 'Filter toolkit slug.' },
      { name: '--tool', type: 'string', required: false, description: 'Filter tool slug.' },
      { name: '--step', type: 'string', required: false, description: 'Filter step.' },
      { name: '--record', type: 'string', required: false, description: 'Filter record.' },
      { name: '--period', type: 'string', required: false, description: '7d, 30d, etc.' },
      { name: '--group-by', type: 'string', required: false, description: 'toolkit | tool | step | record | period' },
    ],
    input_schema: { list: 'string', toolkit: 'optional string', tool: 'optional string', step: 'optional string', record: 'optional string' },
    output_schema: { ...COMMON_OUTPUT, result: { rows: 'array', total_calls: 'number' } },
    examples: ['agent-outbound usage my-list --period 7d --group-by toolkit'],
  },
  {
    name: 'config validate',
    description: 'Validate config schema and integration readiness without writes.',
    mutating: false,
    flags: [
      { name: '--file', type: 'string', required: false, description: 'Validate this file instead of current config.' },
    ],
    input_schema: { list: 'string', file: 'optional string' },
    output_schema: { ...COMMON_OUTPUT, result: { ok: 'boolean', errors: 'string[]', warnings: 'string[]' } },
    examples: ['agent-outbound config validate my-list', 'agent-outbound config validate my-list --file ./proposed.yaml'],
  },
  {
    name: 'config diff',
    description: 'Structured config diff vs file or snapshot.',
    mutating: false,
    flags: [
      { name: '--file', type: 'string', required: false, description: 'Compare against file.' },
      { name: '--from-snapshot', type: 'string', required: false, description: 'Compare against snapshot config.' },
    ],
    input_schema: { list: 'string', file: 'optional string', from_snapshot: 'optional string' },
    output_schema: { ...COMMON_OUTPUT, result: { source: 'string', change_count: 'number', changes: 'array' } },
    examples: ['agent-outbound config diff my-list --file ./proposed.yaml'],
  },
  {
    name: 'snapshot create',
    description: 'Create point-in-time list snapshot.',
    mutating: true,
    flags: [{ name: '--label', type: 'string', required: false, description: 'Human label.' }],
    input_schema: { list: 'string', label: 'optional string' },
    output_schema: { ...COMMON_OUTPUT, result: { status: 'string', snapshot: 'object' } },
    examples: ['agent-outbound snapshot create my-list --label "before launch"'],
  },
  {
    name: 'snapshot list',
    description: 'List snapshots for a list.',
    mutating: false,
    flags: [],
    input_schema: { list: 'string' },
    output_schema: { ...COMMON_OUTPUT, result: { count: 'number', snapshots: 'array' } },
    examples: ['agent-outbound snapshot list my-list'],
  },
  {
    name: 'snapshot restore',
    description: 'Restore list DB/config from snapshot.',
    mutating: true,
    flags: [{ name: '--id', type: 'string', required: true, description: 'Snapshot id.' }],
    input_schema: { list: 'string', id: 'string' },
    output_schema: { ...COMMON_OUTPUT, result: { status: 'string', snapshot: 'object' } },
    examples: ['agent-outbound snapshot restore my-list --id snap_20260421_ab12cd34'],
  },
  {
    name: 'snapshot delete',
    description: 'Delete snapshot artifacts.',
    mutating: true,
    flags: [{ name: '--id', type: 'string', required: true, description: 'Snapshot id.' }],
    input_schema: { list: 'string', id: 'string' },
    output_schema: { ...COMMON_OUTPUT, result: { status: 'string', snapshot_id: 'string' } },
    examples: ['agent-outbound snapshot delete my-list --id snap_20260421_ab12cd34'],
  },
  {
    name: 'drafts list',
    description: 'List queued/generated drafts.',
    mutating: false,
    flags: [
      { name: '--status', type: 'string', required: false, description: 'Filter draft status.' },
      { name: '--step', type: 'number', required: false, description: 'Filter step number.' },
      { name: '--cursor', type: 'string', required: false, description: 'Pagination cursor.' },
    ],
    input_schema: { list: 'string', status: 'optional string', step: 'optional number' },
    output_schema: { ...COMMON_OUTPUT, result: { rows: 'array', count: 'number', next_cursor: 'string|null' } },
    examples: ['agent-outbound drafts list my-list --status pending_approval'],
  },
  {
    name: 'drafts show',
    description: 'Show a single draft.',
    mutating: false,
    flags: [{ name: '--id', type: 'string', required: true, description: 'Draft id.' }],
    input_schema: { list: 'string', id: 'string' },
    output_schema: { ...COMMON_OUTPUT, result: { draft: 'object' } },
    examples: ['agent-outbound drafts show my-list --id draft_123'],
  },
  {
    name: 'drafts approve',
    description: 'Approve one or many drafts.',
    mutating: true,
    flags: [
      { name: '--id', type: 'string', required: false, description: 'Single draft id.' },
      { name: '--all', type: 'boolean', required: false, description: 'Approve matching drafts.' },
      { name: '--where', type: 'string', required: false, description: 'Filter when using --all.' },
    ],
    input_schema: { list: 'string', id: 'optional string', all: 'optional boolean', where: 'optional string' },
    output_schema: { ...COMMON_OUTPUT, result: { approved: 'number', requested: 'number' } },
    examples: ['agent-outbound drafts approve my-list --all --where "priority_rank >= 70"'],
  },
  {
    name: 'drafts reject',
    description: 'Reject a draft without advancing sequence cursor.',
    mutating: true,
    flags: [
      { name: '--id', type: 'string', required: true, description: 'Draft id.' },
      { name: '--reason', type: 'string', required: false, description: 'Rejection reason.' },
    ],
    input_schema: { list: 'string', id: 'string', reason: 'optional string' },
    output_schema: { ...COMMON_OUTPUT, result: { status: 'string', draft_id: 'string' } },
    examples: ['agent-outbound drafts reject my-list --id draft_123 --reason "wrong persona"'],
  },
  {
    name: 'drafts edit',
    description: 'Edit queued draft body/subject.',
    mutating: true,
    flags: [
      { name: '--id', type: 'string', required: true, description: 'Draft id.' },
      { name: '--subject', type: 'string', required: false, description: 'Updated subject.' },
      { name: '--body', type: 'string', required: false, description: 'Updated body.' },
    ],
    input_schema: { list: 'string', id: 'string', subject: 'optional string', body: 'optional string' },
    output_schema: { ...COMMON_OUTPUT, result: { status: 'string', draft_id: 'string' } },
    examples: ['agent-outbound drafts edit my-list --id draft_123 --subject "Re: quick note"'],
  },
  {
    name: 'templates list',
    description: 'List named templates and latest versions.',
    mutating: false,
    flags: [],
    input_schema: { list: 'string' },
    output_schema: { ...COMMON_OUTPUT, result: { count: 'number', templates: 'array' } },
    examples: ['agent-outbound templates list my-list'],
  },
  {
    name: 'templates show',
    description: 'Show all versions for one template.',
    mutating: false,
    flags: [{ name: '--id', type: 'string', required: true, description: 'Template id.' }],
    input_schema: { list: 'string', id: 'string' },
    output_schema: { ...COMMON_OUTPUT, result: { id: 'string', versions: 'array' } },
    examples: ['agent-outbound templates show my-list --id intro_email_v1'],
  },
  {
    name: 'templates create',
    description: 'Create a named template with initial version.',
    mutating: true,
    flags: [
      { name: '--id', type: 'string', required: true, description: 'Template id.' },
      { name: '--channel', type: 'string', required: false, description: 'Channel hint.' },
      { name: '--subject', type: 'string', required: false, description: 'Subject text.' },
      { name: '--body', type: 'string', required: false, description: 'Body text.' },
      { name: '--variables', type: 'json string', required: false, description: 'Template variables map.' },
    ],
    input_schema: { list: 'string', id: 'string' },
    output_schema: { ...COMMON_OUTPUT, result: { status: 'string', id: 'string', version: 'number' } },
    examples: ['agent-outbound templates create my-list --id intro_email_v1 --channel email'],
  },
  {
    name: 'templates update',
    description: 'Append a new template version.',
    mutating: true,
    flags: [
      { name: '--id', type: 'string', required: true, description: 'Template id.' },
      { name: '--subject', type: 'string', required: false, description: 'Subject update.' },
      { name: '--body', type: 'string', required: false, description: 'Body update.' },
      { name: '--variables', type: 'json string', required: false, description: 'Variables map override.' },
      { name: '--note', type: 'string', required: false, description: 'Version note.' },
    ],
    input_schema: { list: 'string', id: 'string' },
    output_schema: { ...COMMON_OUTPUT, result: { status: 'string', id: 'string', version: 'number' } },
    examples: ['agent-outbound templates update my-list --id intro_email_v1 --note "softer opener"'],
  },
  {
    name: 'record revert',
    description: 'Clear one enrichment step for one record.',
    mutating: true,
    flags: [{ name: '--step', type: 'string', required: true, description: 'Enrichment step id.' }],
    input_schema: { list: 'string', row_id: 'string', step: 'string' },
    output_schema: { ...COMMON_OUTPUT, result: { status: 'string', row_id: 'string', step_id: 'string' } },
    examples: ['agent-outbound record revert my-list rec_123 --step hiring-check'],
  },
  {
    name: 'record revert-score',
    description: 'Clear score state for one record.',
    mutating: true,
    flags: [],
    input_schema: { list: 'string', row_id: 'string' },
    output_schema: { ...COMMON_OUTPUT, result: { status: 'string', row_id: 'string', type: 'string' } },
    examples: ['agent-outbound record revert-score my-list rec_123'],
  },
  {
    name: 'record revert-sequence',
    description: 'Reset sequence cursor for one record.',
    mutating: true,
    flags: [{ name: '--to-step', type: 'number', required: true, description: 'Target step number.' }],
    input_schema: { list: 'string', row_id: 'string', to_step: 'number' },
    output_schema: { ...COMMON_OUTPUT, result: { status: 'string', row_id: 'string', to_step: 'number' } },
    examples: ['agent-outbound record revert-sequence my-list rec_123 --to-step 1'],
  },
];

export const listCommandDefinitions = ({ command = '' }: { command?: string } = {}) => {
  const normalized = String(command || '').trim().toLowerCase();
  if (!normalized) return CATALOG;
  return CATALOG.filter((item) => item.name.toLowerCase() === normalized);
};
