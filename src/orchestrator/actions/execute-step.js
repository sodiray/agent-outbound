import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { AGENT_CONSTRAINTS } from './constraints.js';
import { runClaude } from '../lib/claude.js';
import { parseModelJsonObject, zStringish } from '../lib/model-json.js';
import { resolveVirtualPath } from '../lib/runtime.js';

const ExecuteStepResultSchema = z.object({
  status: z.enum(['success', 'skipped', 'failed']).default('success'),
  outputs: z.record(zStringish).default({}),
  rows: z.array(z.record(zStringish)).default([]),
  artifacts: z.record(zStringish).default({}),
  error: zStringish.default(''),
});

const toStringRecord = (value) => {
  const record = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, String(item ?? '')])
  );
};

const toStringRowArray = (value) => {
  if (!Array.isArray(value)) return [];
  return value.map((item) => toStringRecord(item));
};

const renderTemplate = (template, values) => {
  let rendered = String(template || '');
  for (const [key, value] of Object.entries(values || {})) {
    rendered = rendered.replaceAll(`{{${key}}}`, String(value ?? ''));
  }
  return rendered;
};

const readStepFile = ({ listDir, fileRef }) => {
  if (!listDir || !fileRef) return '';
  const filePath = resolveVirtualPath({
    listDir,
    filePath: String(fileRef),
    allowRelative: true,
  });
  if (!existsSync(filePath)) return '';
  return readFileSync(filePath, 'utf8');
};

const resolveBinding = ({ value, row, listDir, templateValues }) => {
  if (Array.isArray(value)) {
    return value.map((item) => resolveBinding({ value: item, row, listDir, templateValues }));
  }

  if (!value || typeof value !== 'object') {
    return value == null ? '' : value;
  }

  if ('from_column' in value && typeof value.from_column === 'string') {
    return String(row?.[value.from_column] ?? '');
  }

  if ('literal' in value) {
    return value.literal;
  }

  if ('template' in value && typeof value.template === 'string') {
    return renderTemplate(value.template, templateValues);
  }

  if ('template_file' in value && typeof value.template_file === 'string') {
    const content = readStepFile({ listDir, fileRef: value.template_file });
    return renderTemplate(content, templateValues);
  }

  if (
    'file' in value
    && typeof value.file === 'string'
    && Object.keys(value).length === 1
  ) {
    const content = readStepFile({ listDir, fileRef: value.file });
    return renderTemplate(content, templateValues);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      resolveBinding({ value: item, row, listDir, templateValues }),
    ])
  );
};

const resolveTemplateValues = ({ stepConfig, row }) => {
  const templateArgs = stepConfig?.template_args && typeof stepConfig.template_args === 'object'
    ? stepConfig.template_args
    : {};
  return resolveBinding({
    value: templateArgs,
    row,
    listDir: '',
    templateValues: {},
  });
};

const resolveStepArgs = ({ stepConfig, row, listDir, templateValues }) => {
  const args = stepConfig?.args && typeof stepConfig.args === 'object' ? stepConfig.args : {};
  return resolveBinding({
    value: args,
    row,
    listDir,
    templateValues,
  });
};

const resolveStepConfigForPrompt = ({ stepConfig, row, listDir, templateValues }) => {
  const base = stepConfig && typeof stepConfig === 'object'
    ? structuredClone(stepConfig)
    : {};
  if (!base || typeof base !== 'object') return {};

  if (base.prompt && typeof base.prompt === 'object' && typeof base.prompt.file === 'string') {
    const content = readStepFile({ listDir, fileRef: base.prompt.file });
    base.prompt = content ? renderTemplate(content, templateValues) : '';
  }

  if (base.files && typeof base.files === 'object') {
    base.files = Object.fromEntries(
      Object.entries(base.files).map(([key, ref]) => {
        const content = readStepFile({ listDir, fileRef: ref });
        return [key, renderTemplate(content, templateValues)];
      })
    );
  }

  return resolveBinding({
    value: base,
    row,
    listDir,
    templateValues,
  });
};

const getExpectedSearchFields = ({ stepConfig, context }) => {
  const fromStep = Array.isArray(stepConfig?.output_fields) ? stepConfig.output_fields : [];
  const fromContext = Array.isArray(context?.expected_output_fields) ? context.expected_output_fields : [];
  const combined = [...fromStep, ...fromContext]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  return [...new Set(combined)];
};

const getExpectedOutputKeys = ({ stepConfig, phase }) => {
  if (phase === 'sourcing_search') return [];
  if (!stepConfig || typeof stepConfig !== 'object') return [];
  const columns = stepConfig.columns && typeof stepConfig.columns === 'object'
    ? stepConfig.columns
    : {};
  return [...new Set(Object.keys(columns).map((key) => String(key || '').trim()).filter(Boolean))];
};

/**
 * Build a scoped row containing only columns the step references via args.
 * Prevents unrelated enrichment/rubric/filter data from leaking into the prompt.
 */
const scopeRowToArgs = (stepConfig, row) => {
  if (!row || typeof row !== 'object') return {};
  if (!stepConfig?.args || typeof stepConfig.args !== 'object') return {};

  const neededColumns = new Set();
  for (const binding of Object.values(stepConfig.args)) {
    if (binding && typeof binding === 'object' && 'from_column' in binding) {
      neededColumns.add(String(binding.from_column));
    }
  }
  // Always include _row_id and business_name for context
  neededColumns.add('_row_id');
  if (row.business_name != null) neededColumns.add('business_name');

  const scoped = {};
  for (const col of neededColumns) {
    if (col in row) scoped[col] = row[col];
  }
  return scoped;
};

/**
 * Build a minimal step config for the prompt — only what Claude needs to execute.
 * Strips dependency info, cache settings, and column mappings that are orchestrator concerns.
 */
const buildPromptStepConfig = (stepConfig) => {
  if (!stepConfig || typeof stepConfig !== 'object') return {};
  const minimal = {};
  if (stepConfig.prompt) minimal.prompt = stepConfig.prompt;
  if (stepConfig.model) minimal.model = stepConfig.model;
  // Include output_fields for search steps
  if (Array.isArray(stepConfig.output_fields)) minimal.output_fields = stepConfig.output_fields;
  return minimal;
};

/**
 * LLM boundary action: execute a single config step for a single row (or list-level context).
 */
export const executeStep = async ({
  listDir,
  phase,
  stepId,
  description,
  stepConfig,
  row,
  context,
  model = 'haiku',
  timeout,
}) => {
  const expectedSearchFields = phase === 'sourcing_search'
    ? getExpectedSearchFields({ stepConfig, context })
    : [];
  const expectedOutputKeys = getExpectedOutputKeys({ stepConfig, phase });
  const templateValues = resolveTemplateValues({ stepConfig, row });
  const resolvedArgs = resolveStepArgs({
    stepConfig,
    row,
    listDir,
    templateValues,
  });
  const resolvedStepConfig = resolveStepConfigForPrompt({
    stepConfig,
    row,
    listDir,
    templateValues,
  });

  // Scope the row to only columns referenced by this step's args
  const scopedRow = phase === 'sourcing_search' ? {} : scopeRowToArgs(stepConfig, row);

  // Build minimal step config — only what Claude needs
  const promptStepConfig = buildPromptStepConfig(resolvedStepConfig);

  const prompt = [
    'You are the outbound execute-step action.',
    'Execute the provided step EXACTLY as described below. Do not deviate.',
    'Follow the step instructions precisely. Use ONLY the tools named in the instructions. Do NOT search for tools, discover tools, or use tools that are not explicitly referenced.',
    'If the instructions name a specific tool (e.g. mcp__firecrawl__firecrawl_scrape), call that tool directly. Do NOT call ToolSearch, COMPOSIO_SEARCH_TOOLS, or any discovery tool unless explicitly instructed.',
    '',
    `Phase: ${String(phase || '')}`,
    `Step ID: ${String(stepId || '')}`,
    `Step Description: ${String(description || '')}`,
    '',
    'Step Instructions:',
    String(resolvedStepConfig?.prompt || stepConfig?.prompt || '(no instructions provided)'),
    '',
    'Resolved Args (use these values):',
    JSON.stringify(resolvedArgs || {}, null, 2),
    '',
    phase !== 'sourcing_search' ? `Row Data (only columns relevant to this step):\n${JSON.stringify(scopedRow, null, 2)}` : '',
    '',
    Object.keys(context || {}).length > 0 ? `Context:\n${JSON.stringify(context, null, 2)}` : '',
    '',
    'Return ONLY JSON with this exact shape:',
    '{',
    '  "status": "success|skipped|failed",',
    '  "outputs": { "key": "string value" },',
    '  "rows": [ { "column": "string value" } ],',
    '  "artifacts": { "key": "string value" },',
    '  "error": "string"',
    '}',
    '',
    'Rules:',
    '- Follow the Step Instructions above as your primary directive.',
    '- Use values from Resolved Args. Do NOT look up or reference data not provided here.',
    '- Put row-level outputs in "outputs".',
    expectedOutputKeys.length > 0
      ? `- "outputs" MUST include ONLY these keys: ${expectedOutputKeys.join(', ')}. Do not add extra keys.`
      : '',
    expectedOutputKeys.length > 0
      ? '- If an output key cannot be determined, include it with an empty string.'
      : '',
    '- For sourcing_search, return discovered rows in "rows".',
    expectedSearchFields.length > 0
      ? `- For sourcing_search, each row in "rows" must use EXACTLY these keys: ${expectedSearchFields.join(', ')}.`
      : '',
    '- Match expected output field keys exactly. Do not introduce alternate names or aliases.',
    '- Use "artifacts" for metadata (draft/thread/message IDs, notes, etc).',
    '- If no rows or outputs are produced, return empty objects/arrays.',
    '- Do not return markdown or prose.',
    '- Do NOT produce outputs for columns or steps other than this one. Your scope is strictly this step only.',
    AGENT_CONSTRAINTS,
  ].filter(Boolean).join('\n');

  const { output, exitCode, stderr } = await runClaude(prompt, {
    model,
    timeout,
  });

  if (exitCode !== 0) {
    throw new Error(`execute-step failed: exit ${exitCode}. ${String(stderr || '').slice(0, 300)}`);
  }

  const parsed = parseModelJsonObject({
    output,
    schema: ExecuteStepResultSchema,
    label: `execute-step (${String(stepId || 'unknown')})`,
  });

  const normalizedOutputs = toStringRecord(parsed.outputs);
  for (const key of expectedOutputKeys) {
    if (!(key in normalizedOutputs)) {
      normalizedOutputs[key] = '';
    }
  }

  return {
    status: parsed.status,
    outputs: normalizedOutputs,
    rows: toStringRowArray(parsed.rows),
    artifacts: toStringRecord(parsed.artifacts),
    error: String(parsed.error || ''),
  };
};
