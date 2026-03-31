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
  const prompt = [
    'You are the outbound execute-step action.',
    'Execute the provided step exactly as described in config.',
    'Use any available MCP tools to complete this step. Search all available tools and make all tool and interpretation decisions yourself.',
    'If stepConfig contains a "prompt" field, treat it as the primary instruction for this step. Follow those instructions as your main directive, using the args and row data as context.',
    '',
    `Phase: ${String(phase || '')}`,
    `Step ID: ${String(stepId || '')}`,
    `Step Description: ${String(description || '')}`,
    '',
    'Step Config JSON:',
    JSON.stringify(stepConfig || {}, null, 2),
    '',
    'Resolved Step Config JSON (file/template refs resolved by orchestrator):',
    JSON.stringify(resolvedStepConfig || {}, null, 2),
    '',
    'Resolved Args JSON (deterministically resolved from stepConfig.args + row):',
    JSON.stringify(resolvedArgs || {}, null, 2),
    '',
    'Row JSON:',
    JSON.stringify(row || {}, null, 2),
    '',
    'Extra Context JSON:',
    JSON.stringify(context || {}, null, 2),
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
    '- If stepConfig contains a "prompt" field, treat it as the primary instruction for this step. Follow it as your main directive, using args and row data as context.',
    '- When stepConfig.args contains bindings, prefer values from Resolved Args JSON.',
    '- Put row-level outputs in "outputs".',
    expectedOutputKeys.length > 0
      ? `- For this step, "outputs" MUST include ALL of these keys: ${expectedOutputKeys.join(', ')}.`
      : '- Include all expected output keys declared by step config.',
    '- If an output key cannot be determined, still include it with an empty string.',
    '- For sourcing/business discovery, return discovered rows in "rows".',
    expectedSearchFields.length > 0
      ? `- For sourcing_search, each row in "rows" must use EXACTLY these keys: ${expectedSearchFields.join(', ')}.`
      : '- For sourcing_search, if stepConfig.output_fields is provided, rows must only use those keys.',
    expectedSearchFields.length > 0
      ? '- If an expected field has no value after all lookup attempts, include it as an empty string.'
      : '- Preserve stable key names for discovered rows and avoid introducing duplicate aliases for the same field.',
    '- For sourcing_search: if expected output fields are missing from initial search results, attempt to backfill them using a details/lookup tool for the same source when one is available.',
    '- Match expected output field keys exactly. Do not introduce alternate names or aliases for the same field.',
    '- Use "artifacts" for metadata (draft/thread/message IDs, notes, etc).',
    '- If no rows or outputs are produced, return empty objects/arrays.',
    '- Do not return markdown or prose.',
    AGENT_CONSTRAINTS,
  ].join('\n');

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
