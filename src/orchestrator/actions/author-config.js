import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { AGENT_CONSTRAINTS } from './constraints.js';
import { runClaude } from '../lib/claude.js';
import { parseModelJsonObject, zStringish } from '../lib/model-json.js';
import { buildColumnManifest, formatManifestForPrompt } from '../lib/column-manifest.js';

// ── Schemas ──────────────────────────────────────────────────────────────────

const FocusedItemSchema = z.object({
  item: z.any(),
  summary: zStringish.default(''),
  warnings: z.array(zStringish).default([]),
  depends_on: z.array(zStringish).default([]),
});

const FullConfigResultSchema = z.object({
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
  CONFIG_SCHEMA_REFERENCE = 'Config schema reference unavailable. Infer structure from current config.';
}

// ── Request classification ───────────────────────────────────────────────────

const classifyRequest = (request) => {
  const lower = String(request || '').toLowerCase();

  if (lower.includes('remove') || lower.includes('delete')) {
    if (lower.includes('search') || lower.includes('source')) return 'remove_search';
    if (lower.includes('filter')) return 'remove_filter';
    if (lower.includes('enrich') || lower.includes('step')) return 'remove_enrichment';
    if (lower.includes('rubric') || lower.includes('score') || lower.includes('criteria')) return 'remove_rubric';
    return 'full_config';
  }

  if (lower.includes('add') || lower.includes('create') || lower.includes('new')) {
    if (lower.includes('search') || lower.includes('source') || lower.includes('find businesses') || lower.includes('google maps') || lower.includes('apollo')) return 'add_search';
    if (lower.includes('filter') || lower.includes('only keep') || lower.includes('check that') || lower.includes('check if')) return 'add_filter';
    if (lower.includes('rubric') || lower.includes('score') || lower.includes('criteria')) return 'add_rubric';
    if (lower.includes('enrich') || lower.includes('step') || lower.includes('column') || lower.includes('find email') || lower.includes('research') || lower.includes('scrape') || lower.includes('write')) return 'add_enrichment';
    // Default add to enrichment — most common
    return 'add_enrichment';
  }

  if (lower.includes('modify') || lower.includes('update') || lower.includes('change') || lower.includes('swap') || lower.includes('replace')) {
    return 'modify_step';
  }

  // Can't classify — use full config approach
  return 'full_config';
};

// ── Focused prompts ──────────────────────────────────────────────────────────

const buildFocusedPrompt = ({ operation, request, manifest, currentStep }) => {
  const manifestText = formatManifestForPrompt(manifest);

  const sharedRules = [
    '- Return ONLY the JSON object described below. No markdown, no prose.',
    '- Use from_column / literal bindings for args.',
    '- Include a nested "config" object with: id, args, columns, depends_on, prompt, model, cache, concurrency.',
    '- The "id" should be a short snake_case identifier.',
    '- Only reference columns that exist in the manifest or that this step itself produces.',
    '- Before referencing any external tool, search available MCP tools to confirm it exists. Use ONLY tools that are available.',
    AGENT_CONSTRAINTS,
  ].join('\n');

  if (operation === 'add_search') {
    return [
      'You are the outbound config author. Produce a SINGLE search config entry.',
      '',
      `User Request: ${request}`,
      '',
      manifestText,
      '',
      'Return ONLY JSON:',
      '{',
      '  "item": { <single source.searches[] entry with id, description, args, output_fields, dedup_keys, columns, prompt, cache, model, timeout> },',
      '  "summary": "what this search does",',
      '  "warnings": ["optional"]',
      '}',
      '',
      'Rules:',
      '- Include output_fields listing the columns this search will produce.',
      '- Include dedup_keys for stable identity (e.g., place_id).',
      '- Include a prompt field with specific tool instructions.',
      sharedRules,
    ].join('\n');
  }

  if (operation === 'add_filter') {
    return [
      'You are the outbound config author. Produce a SINGLE filter config entry.',
      '',
      `User Request: ${request}`,
      '',
      manifestText,
      '',
      'Return ONLY JSON:',
      '{',
      '  "item": { "description": "...", "condition": "...", "config": { <stepConfig> } },',
      '  "summary": "what this filter does",',
      '  "warnings": ["optional"],',
      '  "depends_on": ["filter_id_this_depends_on"]',
      '}',
      '',
      'Rules:',
      '- The condition field is a natural-language pass/fail text.',
      '- config.writes.passed_column must be a unique column name (e.g., filter_has_website_passed). NEVER use source_filter_result or source_filter_failures.',
      '- depends_on lists filter IDs this filter should run after (if it needs columns from another filter).',
      sharedRules,
    ].join('\n');
  }

  if (operation === 'add_enrichment') {
    return [
      'You are the outbound config author. Produce a SINGLE enrichment step config entry.',
      '',
      `User Request: ${request}`,
      '',
      manifestText,
      '',
      'Return ONLY JSON:',
      '{',
      '  "item": { "description": "...", "config": { <stepConfig with id, args, columns, depends_on, prompt, model, cache, concurrency> } },',
      '  "summary": "what this step does",',
      '  "warnings": ["optional"],',
      '  "depends_on": ["step_id_this_depends_on"]',
      '}',
      '',
      'Rules:',
      '- config.depends_on should reference enrichment step IDs that produce columns this step needs.',
      '- config.columns maps output keys to CSV column names.',
      '- config.args uses from_column bindings to reference existing columns.',
      '- config.prompt contains the specific instructions for this step, including which tools to call.',
      sharedRules,
    ].join('\n');
  }

  if (operation === 'add_rubric') {
    return [
      'You are the outbound config author. Produce rubric criteria entries.',
      '',
      `User Request: ${request}`,
      '',
      manifestText,
      '',
      'Return ONLY JSON:',
      '{',
      '  "item": [ { "description": "...", "score": <number>, "config": { "columns": ["col"], "result_column": "rubric_..." } } ],',
      '  "summary": "what criteria were added",',
      '  "warnings": ["optional"]',
      '}',
      '',
      'Rules:',
      '- item is an ARRAY of rubric criteria.',
      '- Each criterion has description, score (positive or negative integer), and config with columns (input columns to evaluate) and result_column.',
      '- result_column must be unique per criterion (e.g., rubric_has_email, rubric_no_phone).',
      '- Only reference columns that exist in the manifest.',
      sharedRules,
    ].join('\n');
  }

  if (operation === 'modify_step' && currentStep) {
    return [
      'You are the outbound config author. Modify an existing step.',
      '',
      `User Request: ${request}`,
      '',
      'Current step:',
      JSON.stringify(currentStep, null, 2),
      '',
      manifestText,
      '',
      'Return ONLY JSON:',
      '{',
      '  "item": { <the modified step, same structure as current> },',
      '  "summary": "what changed",',
      '  "warnings": ["optional"]',
      '}',
      '',
      'Rules:',
      '- Preserve all fields not mentioned in the user request.',
      '- Only modify what the user explicitly asked to change.',
      sharedRules,
    ].join('\n');
  }

  // full_config fallback — should rarely be needed
  return null;
};

// ── Deterministic insertion ──────────────────────────────────────────────────

const insertSearch = (config, item) => {
  if (!config.source) config.source = {};
  if (!Array.isArray(config.source.searches)) config.source.searches = [];
  config.source.searches.push(item);
};

const insertFilter = (config, item, dependsOn) => {
  if (!config.source) config.source = {};
  if (!Array.isArray(config.source.filters)) config.source.filters = [];
  // Insert after the last filter it depends on
  if (dependsOn && dependsOn.length > 0) {
    let insertIndex = config.source.filters.length;
    for (let i = config.source.filters.length - 1; i >= 0; i -= 1) {
      const filterId = String(config.source.filters[i]?.config?.id || '');
      if (dependsOn.includes(filterId)) {
        insertIndex = i + 1;
        break;
      }
    }
    config.source.filters.splice(insertIndex, 0, item);
  } else {
    config.source.filters.push(item);
  }
};

const insertEnrichment = (config, item, dependsOn) => {
  if (!Array.isArray(config.enrich)) config.enrich = [];
  // Insert after the last step it depends on
  if (dependsOn && dependsOn.length > 0) {
    let insertIndex = config.enrich.length;
    for (let i = config.enrich.length - 1; i >= 0; i -= 1) {
      const stepId = String(config.enrich[i]?.config?.id || '');
      if (dependsOn.includes(stepId)) {
        insertIndex = i + 1;
        break;
      }
    }
    config.enrich.splice(insertIndex, 0, item);
  } else {
    config.enrich.push(item);
  }
};

const insertRubric = (config, items) => {
  if (!Array.isArray(config.rubric)) config.rubric = [];
  config.rubric.push(...items);
};

// ── Remove operations ────────────────────────────────────────────────────────

const findAndRemove = (request, config) => {
  const lower = String(request || '').toLowerCase();
  let removed = null;

  // Try to find what to remove by matching description or ID in the request
  const matchesRequest = (entry) => {
    const desc = String(entry?.description || entry?.config?.id || '').toLowerCase();
    // Check if any significant words from the entry appear in the request
    const words = desc.split(/\s+/).filter((w) => w.length > 3);
    return words.some((w) => lower.includes(w));
  };

  if (lower.includes('search') || lower.includes('source')) {
    const searches = config.source?.searches || [];
    const idx = searches.findIndex(matchesRequest);
    if (idx >= 0) { removed = searches.splice(idx, 1)[0]; }
  } else if (lower.includes('filter')) {
    const filters = config.source?.filters || [];
    const idx = filters.findIndex(matchesRequest);
    if (idx >= 0) { removed = filters.splice(idx, 1)[0]; }
  } else if (lower.includes('enrich') || lower.includes('step')) {
    const steps = config.enrich || [];
    const idx = steps.findIndex(matchesRequest);
    if (idx >= 0) { removed = steps.splice(idx, 1)[0]; }
  } else if (lower.includes('rubric') || lower.includes('criteria')) {
    const criteria = config.rubric || [];
    const idx = criteria.findIndex(matchesRequest);
    if (idx >= 0) { removed = criteria.splice(idx, 1)[0]; }
  }

  return removed;
};

// ── Full config fallback (existing approach, for complex requests) ───────────

const runFullConfigAuthoring = async ({ request, currentConfig, csvState, manifest, model, timeout }) => {
  const manifestText = formatManifestForPrompt(manifest);

  const prompt = [
    'You are the outbound author-config action.',
    'Your job is to update outbound config based on the user request.',
    'You may use connected MCP tools to discover capabilities before writing config.',
    'Return config that is structurally valid for the orchestrator schema.',
    '',
    'Rules:',
    '- Produce a complete outbound config object in updated_config.',
    '- Preserve existing config sections unless the request explicitly changes them.',
    '- Before referencing any external tool in config, search all available tools in this environment.',
    '- Only reference tools that are available and connected.',
    '- If no suitable tool exists, do not invent one. Add a warning.',
    '- Every step MUST declare its output columns in config.columns.',
    '- Do not include resolve_dependency_order, resolve_manual_fields, resolve_warnings, or resolve_column_errors in updated_config.',
    '- If you cannot fulfill part of the request, include a warning explaining why.',
    AGENT_CONSTRAINTS,
    '',
    `User Request: ${request}`,
    '',
    'Column Manifest:',
    manifestText,
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
    throw new Error(`author-config (full) failed: exit ${exitCode}. ${String(stderr || '').slice(0, 300)}`);
  }

  return parseModelJsonObject({
    output,
    schema: FullConfigResultSchema,
    label: 'author-config (full) result',
  });
};

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * LLM boundary action: author or modify outbound config based on operator intent.
 *
 * Routes requests to focused handlers that return just the new/modified item,
 * or falls back to full-config authoring for complex requests.
 */
export const authorConfig = async ({
  request,
  currentConfig,
  csvState,
  model = 'sonnet',
  timeout,
}) => {
  const manifest = buildColumnManifest(currentConfig);
  const operation = classifyRequest(request);

  // ── Remove operations: pure orchestrator, no LLM ──
  if (operation.startsWith('remove_')) {
    const config = structuredClone(currentConfig);
    const removed = findAndRemove(request, config);
    if (!removed) {
      return {
        updatedConfig: currentConfig,
        summary: '',
        warnings: ['Could not identify which item to remove. Try being more specific.'],
      };
    }
    return {
      updatedConfig: config,
      summary: `Removed: ${JSON.stringify(removed.description || removed.config?.id || '').slice(0, 100)}`,
      warnings: [],
    };
  }

  // ── Full config fallback ──
  if (operation === 'full_config' || operation === 'modify_step') {
    // For modify_step we'd need to identify which step — for now use full config
    const result = await runFullConfigAuthoring({ request, currentConfig, csvState, manifest, model, timeout });
    return {
      updatedConfig: result.updated_config,
      summary: String(result.summary || ''),
      warnings: Array.isArray(result.warnings) ? result.warnings.map(String) : [],
    };
  }

  // ── Focused add operations ──
  const prompt = buildFocusedPrompt({ operation, request, manifest });
  if (!prompt) {
    // Fallback if prompt builder returns null
    const result = await runFullConfigAuthoring({ request, currentConfig, csvState, manifest, model, timeout });
    return {
      updatedConfig: result.updated_config,
      summary: String(result.summary || ''),
      warnings: Array.isArray(result.warnings) ? result.warnings.map(String) : [],
    };
  }

  const { output, exitCode, stderr } = await runClaude(prompt, { model, timeout });
  if (exitCode !== 0) {
    throw new Error(`author-config (${operation}) failed: exit ${exitCode}. ${String(stderr || '').slice(0, 300)}`);
  }

  const parsed = parseModelJsonObject({
    output,
    schema: FocusedItemSchema,
    label: `author-config (${operation})`,
  });

  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [];
  const dependsOn = Array.isArray(parsed.depends_on) ? parsed.depends_on.map(String) : [];

  if (!parsed.item) {
    warnings.push('LLM returned no item. The request may not have been understood.');
    return { updatedConfig: currentConfig, summary: '', warnings };
  }

  // ── Deterministic insertion ──
  const config = structuredClone(currentConfig);

  if (operation === 'add_search') {
    insertSearch(config, parsed.item);
  } else if (operation === 'add_filter') {
    insertFilter(config, parsed.item, dependsOn);
  } else if (operation === 'add_enrichment') {
    insertEnrichment(config, parsed.item, dependsOn);
  } else if (operation === 'add_rubric') {
    const items = Array.isArray(parsed.item) ? parsed.item : [parsed.item];
    insertRubric(config, items);
  }

  return {
    updatedConfig: config,
    summary: String(parsed.summary || ''),
    warnings,
  };
};
