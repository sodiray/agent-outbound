import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { runClaude } from '../lib/claude.js';
import { parseModelJsonObject, zStringish } from '../lib/model-json.js';

const AuthorConfigResultSchema = z.object({
  updated_config: z.record(z.any()).default({}),
  summary: zStringish.default(''),
  warnings: z.array(zStringish).default([]),
});

let CONFIG_SCHEMA_REFERENCE = '';
try {
  CONFIG_SCHEMA_REFERENCE = readFileSync(
    new URL('./prompts/config-schema-reference.md', import.meta.url),
    'utf8'
  );
} catch {
  CONFIG_SCHEMA_REFERENCE = [
    'Config schema reference unavailable.',
    'Infer structure from current config and preserve existing shape.',
    'Top-level sections: source, enrich, rubric, sequence, data.',
  ].join('\n');
}

const STEP_CONFIG_KEYS = new Set([
  'id',
  'args',
  'columns',
  'depends_on',
  'condition',
  'concurrency',
  'cache',
  'prompt',
  'files',
  'writes',
  'model',
  'platform_model',
  'timeout',
]);

const RESERVED_ORCHESTRATOR_COLUMNS = new Set([
  '_row_id',
  'source',
  'source_query',
  'sourced_at',
  'source_filter_result',
  'source_filter_failures',
  'sequence_step',
  'sequence_status',
  'next_action_date',
  'draft_id',
  'draft_status',
  'draft_error',
  'draft_created_at',
  'sent_at',
  'send_status',
  'send_error',
  'last_outreach_date',
]);

const FILTER_AGGREGATE_COLUMNS = new Set([
  'source_filter_result',
  'source_filter_failures',
]);

const slugify = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);

const requestIncludesAny = (requestText, keywords) => {
  const lower = String(requestText || '').toLowerCase();
  return keywords.some((keyword) => lower.includes(String(keyword).toLowerCase()));
};

const ensureStepConfigBlocks = ({ updatedConfig, path, stepConfigKeys = STEP_CONFIG_KEYS }) => {
  let cursor = updatedConfig;
  for (const segment of path) {
    if (!cursor || typeof cursor !== 'object') return updatedConfig;
    cursor = cursor[segment];
  }

  if (!Array.isArray(cursor)) return updatedConfig;

  const nextItems = cursor.map((step) => {
    const base = step && typeof step === 'object' ? { ...step } : {};
    if (base.config && typeof base.config === 'object') return base;

    const config = {};
    for (const key of Object.keys(base)) {
      if (!stepConfigKeys.has(key)) continue;
      config[key] = base[key];
      delete base[key];
    }
    base.config = config;
    return base;
  });

  let target = updatedConfig;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i];
    if (!target[segment] || typeof target[segment] !== 'object') {
      target[segment] = {};
    }
    target = target[segment];
  }
  target[path[path.length - 1]] = nextItems;
  return updatedConfig;
};

const ensureCompiledConfigBlocks = (updatedConfig) => {
  const cfg = updatedConfig && typeof updatedConfig === 'object'
    ? structuredClone(updatedConfig)
    : {};

  ensureStepConfigBlocks({ updatedConfig: cfg, path: ['source', 'filters'] });
  ensureStepConfigBlocks({ updatedConfig: cfg, path: ['enrich'] });
  ensureStepConfigBlocks({ updatedConfig: cfg, path: ['sequence', 'steps'] });
  return cfg;
};

const normalizeFilterPassedColumns = (updatedConfig) => {
  const cfg = updatedConfig && typeof updatedConfig === 'object'
    ? structuredClone(updatedConfig)
    : {};
  const warnings = [];
  const filters = Array.isArray(cfg?.source?.filters) ? cfg.source.filters : [];

  for (let i = 0; i < filters.length; i += 1) {
    const filter = filters[i] && typeof filters[i] === 'object' ? filters[i] : {};
    if (!filter.config || typeof filter.config !== 'object') continue;
    if (!filter.config.writes || typeof filter.config.writes !== 'object') {
      filter.config.writes = {};
    }

    const baseId = slugify(
      filter.config.id
      || filter.id
      || filter.description
      || `filter_${i + 1}`
    ) || `filter_${i + 1}`;
    const defaultPassedColumn = `filter_${baseId.replace(/^filter_/, '')}_passed`;
    const currentPassedColumn = String(filter.config.writes.passed_column || '').trim();

    if (!currentPassedColumn) {
      filter.config.writes.passed_column = defaultPassedColumn;
      continue;
    }

    if (FILTER_AGGREGATE_COLUMNS.has(currentPassedColumn)) {
      filter.config.writes.passed_column = defaultPassedColumn;
      warnings.push(
        `Filter "${filter.description || filter.config.id || i + 1}" used reserved column "${currentPassedColumn}" for writes.passed_column. Replaced with "${defaultPassedColumn}".`
      );
    }
  }

  return { updatedConfig: cfg, warnings };
};

const collectOutputColumns = (value, out = new Set()) => {
  if (Array.isArray(value)) {
    for (const item of value) collectOutputColumns(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;

  if (value.columns && typeof value.columns === 'object' && !Array.isArray(value.columns)) {
    for (const mapped of Object.values(value.columns)) {
      const col = String(mapped || '').trim();
      if (col) out.add(col);
    }
  }

  for (const nested of Object.values(value)) {
    collectOutputColumns(nested, out);
  }
  return out;
};

const collectFromColumnRefs = (value, out = new Set()) => {
  if (Array.isArray(value)) {
    for (const item of value) collectFromColumnRefs(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;

  if (typeof value.from_column === 'string' && value.from_column.trim()) {
    out.add(value.from_column.trim());
  }

  for (const nested of Object.values(value)) {
    collectFromColumnRefs(nested, out);
  }
  return out;
};

const validateFromColumnReferences = ({ updatedConfig, csvState }) => {
  const knownColumns = new Set();
  const headers = Array.isArray(csvState?.headers) ? csvState.headers : [];
  for (const header of headers) {
    const col = String(header || '').trim();
    if (col) knownColumns.add(col);
  }
  for (const col of RESERVED_ORCHESTRATOR_COLUMNS) knownColumns.add(col);
  for (const col of collectOutputColumns(updatedConfig)) knownColumns.add(col);

  const refs = [...collectFromColumnRefs(updatedConfig)];
  const unresolved = refs
    .map((ref) => String(ref).trim())
    .filter((ref) => ref && !knownColumns.has(ref));

  return [...new Set(unresolved)].sort();
};

const validateRequestedSections = ({ request, updatedConfig }) => {
  const warnings = [];
  const rubric = Array.isArray(updatedConfig?.rubric) ? updatedConfig.rubric : [];
  const searches = Array.isArray(updatedConfig?.source?.searches) ? updatedConfig.source.searches : [];
  const filters = Array.isArray(updatedConfig?.source?.filters) ? updatedConfig.source.filters : [];

  if (requestIncludesAny(request, ['rubric', 'score'])) {
    const rubricCriteria = rubric.filter((item) => String(item?.description || '').trim());
    if (rubricCriteria.length === 0) {
      warnings.push('Rubric criteria were requested but none were generated.');
    }
  }

  if (requestIncludesAny(request, ['search', 'source', 'find businesses']) && searches.length === 0) {
    warnings.push('Sourcing/search was requested but source.searches is empty.');
  }

  if (requestIncludesAny(request, ['filter']) && filters.length === 0) {
    warnings.push('Filter logic was requested but source.filters is empty.');
  }

  return warnings;
};

/**
 * LLM boundary action: author or modify outbound config based on operator intent.
 */
export const authorConfig = async ({
  request,
  currentConfig,
  csvState,
  model = 'sonnet',
  timeout,
}) => {
  const prompt = [
    'You are the outbound author-config action.',
    'Your job is to update outbound config based on the user request.',
    'You may use any available MCP tools to discover capabilities before writing config. Search all available tools in this environment to find what is connected.',
    'The config you produce will be executed by an orchestrator that delegates each step to Claude via the execute-step action.',
    'For each step, Claude receives the step config, resolved args (from_column bindings evaluated from CSV row data), and row context.',
    'Claude then calls any available MCP tools as needed and returns structured output. Write step prompts and args with this execution model in mind.',
    'Return config that is structurally valid for the orchestrator schema.',
    '',
    'Rules:',
    '- Produce a complete outbound config object in updated_config.',
    '- Preserve existing config sections unless the request explicitly changes them.',
    '- Before referencing any external tool in config, search all available tools in this environment.',
    '- Search all available MCP tools before referencing them in config. Direct MCP tools are preferred when available.',
    '- If Composio is available, also search COMPOSIO_SEARCH_TOOLS for additional tools. Use COMPOSIO_GET_TOOL_SCHEMAS to inspect parameters before referencing.',
    '- Only reference tools that are available and connected in this environment.',
    '- If no suitable connected tool exists, do not invent one. Add a warning explaining what is missing and what the user needs to connect.',
    '- Prefer generic step config; do not hardcode vendor assumptions in orchestrator-facing fields.',
    '- For source.searches entries, include output_fields with the exact row keys that downstream steps should use.',
    '- Keep source.searches output_fields minimal and provider-relevant. Do not include empty placeholder fields for unrelated platforms.',
    '- For source.searches entries, include dedup_keys when a stable identity field is available.',
    '- When a search source may return incomplete results (missing detail fields like contact info, website, or reviews), add a follow-up filter or enrichment step to backfill those fields using a details/lookup tool before downstream steps depend on them.',
    '- Check what fields the search tool actually returns by inspecting its schema before assuming fields will be available.',
    '- Use from_column / literal bindings for args and template_args where appropriate.',
    '- Source filters, enrich steps, and sequence steps should always include a nested "config" object for execution details.',
    '- For source.filters[*].config.writes.passed_column, use a unique per-filter column (for example filter_has_website_passed). Never use source_filter_result or source_filter_failures because those are orchestrator-managed aggregate columns.',
    '- Do not include resolve_dependency_order, resolve_manual_fields, resolve_warnings, or resolve_column_errors in updated_config. These are orchestrator-computed metadata and will be overwritten.',
    '- Every step MUST declare its output columns in config.columns (mapping output key to CSV column name). The orchestrator uses these declarations to validate that downstream from_column references are satisfiable. If a step produces a column, it must appear in config.columns.',
    '- If you cannot fulfill part of the request (missing tool, unsupported capability, ambiguous intent), you MUST include a warning explaining what was not done and why. Never silently drop a requested change.',
    '- If you use a workaround or fallback tool instead of the tool the user likely expects (for example, web scraping instead of a native API), include a warning that clearly states: what the user asked for, what tool you used instead, why (the expected tool is not connected/available), and any limitations of the fallback approach. The user must be able to accept or reject this substitution.',
    '- If unsure, add a warning describing uncertainty.',
    '',
    `User Request: ${String(request || '')}`,
    '',
    'Current Config JSON:',
    JSON.stringify(currentConfig || {}, null, 2),
    '',
    'CSV State JSON:',
    JSON.stringify(csvState || {}, null, 2),
    '',
    'Config Schema Reference:',
    CONFIG_SCHEMA_REFERENCE,
    '',
    'Return ONLY JSON:',
    '{',
    '  "updated_config": { ...full outbound config... },',
    '  "summary": "what changed",',
    '  "warnings": ["optional warning"]',
    '}',
  ].join('\n');

  const { output, exitCode, stderr } = await runClaude(prompt, { model, timeout });
  if (exitCode !== 0) {
    throw new Error(`author-config failed: exit ${exitCode}. ${String(stderr || '').slice(0, 300)}`);
  }

  const parsed = parseModelJsonObject({
    output,
    schema: AuthorConfigResultSchema,
    label: 'author-config result',
  });

  const normalizedConfig = ensureCompiledConfigBlocks(parsed.updated_config || {});
  const passedColumnNormalized = normalizeFilterPassedColumns(normalizedConfig);
  const unresolvedRefs = validateFromColumnReferences({
    updatedConfig: passedColumnNormalized.updatedConfig,
    csvState,
  });
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map((item) => String(item)) : [];
  warnings.push(...passedColumnNormalized.warnings);
  warnings.push(...validateRequestedSections({
    request,
    updatedConfig: passedColumnNormalized.updatedConfig,
  }));
  if (unresolvedRefs.length > 0) {
    warnings.push(
      `Unresolved from_column references: ${unresolvedRefs.join(', ')}. Check CSV headers or upstream step outputs.`
    );
  }

  return {
    updatedConfig: passedColumnNormalized.updatedConfig,
    summary: String(parsed.summary || ''),
    warnings,
  };
};
