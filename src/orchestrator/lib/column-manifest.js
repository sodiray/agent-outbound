/**
 * Builds a compact column manifest from the outbound config.
 * Used to give the author-config action minimal context about
 * what columns exist without sending the full 1000+ line config.
 */

const SOURCING_BASELINE_COLUMNS = [
  { name: '_row_id', description: 'unique row identifier (auto-generated)' },
  { name: 'source', description: 'which search produced this row' },
  { name: 'source_query', description: 'the search query or description' },
  { name: 'sourced_at', description: 'timestamp when row was sourced' },
  { name: 'source_filter_result', description: 'passed or failed (aggregate of all filters)' },
  { name: 'source_filter_failures', description: 'comma-separated list of failed filter IDs' },
];

const describeBinding = (args) => {
  if (!args || typeof args !== 'object') return [];
  return Object.entries(args)
    .filter(([, v]) => v && typeof v === 'object' && 'from_column' in v)
    .map(([argName, binding]) => `${argName} ← ${binding.from_column}`);
};

export const buildColumnManifest = (outboundConfig) => {
  const columns = [...SOURCING_BASELINE_COLUMNS];
  const searchIds = [];
  const filterIds = [];
  const enrichmentIds = [];
  const enrichmentSteps = [];

  // Sourcing searches — output_fields become columns
  const searches = Array.isArray(outboundConfig?.source?.searches)
    ? outboundConfig.source.searches
    : [];
  for (const search of searches) {
    const id = String(search.id || search.description || '').trim();
    if (id) searchIds.push(id);
    const outputFields = Array.isArray(search.output_fields) ? search.output_fields : [];
    for (const field of outputFields) {
      const name = String(field || '').trim();
      if (name && !columns.some((c) => c.name === name)) {
        columns.push({ name, source: id || 'sourcing', description: 'from search results' });
      }
    }
    // Also check columns mapping
    const colMap = search.columns && typeof search.columns === 'object' ? search.columns : {};
    for (const csvCol of Object.values(colMap)) {
      const name = String(csvCol || '').trim();
      if (name && !columns.some((c) => c.name === name)) {
        columns.push({ name, source: id || 'sourcing', description: 'from search results' });
      }
    }
  }

  // Sourcing filters — writes passed_column + output columns
  const filters = Array.isArray(outboundConfig?.source?.filters)
    ? outboundConfig.source.filters
    : [];
  for (const filter of filters) {
    const config = filter.config && typeof filter.config === 'object' ? filter.config : {};
    const id = String(config.id || filter.description || '').trim();
    if (id) filterIds.push(id);
    const passedCol = String(config.writes?.passed_column || '').trim();
    if (passedCol && !columns.some((c) => c.name === passedCol)) {
      columns.push({ name: passedCol, source: id || 'filter', description: 'filter pass/fail result' });
    }
    const colMap = config.columns && typeof config.columns === 'object' ? config.columns : {};
    for (const [outputKey, csvCol] of Object.entries(colMap)) {
      const name = String(csvCol || '').trim();
      if (name && !columns.some((c) => c.name === name)) {
        columns.push({ name, source: id || 'filter', description: `filter output (${outputKey})` });
      }
    }
  }

  // Enrichment steps — output columns + step metadata
  const enrichSteps = Array.isArray(outboundConfig?.enrich)
    ? outboundConfig.enrich
    : [];
  for (const step of enrichSteps) {
    const config = step.config && typeof step.config === 'object' ? step.config : {};
    const id = String(config.id || step.description || '').trim();
    if (id) enrichmentIds.push(id);
    const dependsOn = Array.isArray(config.depends_on) ? config.depends_on : [];
    const bindings = describeBinding(config.args);
    const colMap = config.columns && typeof config.columns === 'object' ? config.columns : {};
    const outputCols = [];
    for (const [outputKey, csvCol] of Object.entries(colMap)) {
      const name = String(csvCol || '').trim();
      outputCols.push(name);
      if (name && !columns.some((c) => c.name === name)) {
        columns.push({ name, source: id, description: `enrichment output (${outputKey})` });
      }
    }
    enrichmentSteps.push({
      id,
      description: String(step.description || '').trim(),
      depends_on: dependsOn,
      inputs: bindings,
      outputs: outputCols,
    });
  }

  // Rubric — result columns
  const rubricEntries = Array.isArray(outboundConfig?.rubric)
    ? outboundConfig.rubric
    : [];
  for (const criterion of rubricEntries) {
    const config = criterion.config && typeof criterion.config === 'object' ? criterion.config : {};
    const resultCol = String(config.result_column || '').trim();
    if (resultCol && !columns.some((c) => c.name === resultCol)) {
      columns.push({ name: resultCol, source: 'rubric', description: `rubric: ${String(criterion.description || '').slice(0, 60)}` });
    }
  }
  const scoreCol = String(outboundConfig?.rubric_config?.score_column || 'lead_score').trim();
  if (!columns.some((c) => c.name === scoreCol)) {
    columns.push({ name: scoreCol, source: 'rubric', description: 'lead score (0-100)' });
  }
  const breakdownCol = String(outboundConfig?.rubric_config?.breakdown_column || 'lead_score_breakdown').trim();
  if (!columns.some((c) => c.name === breakdownCol)) {
    columns.push({ name: breakdownCol, source: 'rubric', description: 'rubric score breakdown' });
  }

  return {
    columns,
    search_ids: searchIds,
    filter_ids: filterIds,
    enrichment_ids: enrichmentIds,
    enrichment_steps: enrichmentSteps,
    rubric_criteria_count: rubricEntries.length,
    sequence_step_count: Array.isArray(outboundConfig?.sequence?.steps)
      ? outboundConfig.sequence.steps.length
      : 0,
  };
};

/**
 * Format the manifest as a compact string for prompts.
 */
export const formatManifestForPrompt = (manifest) => {
  const lines = [];

  lines.push('Available columns:');
  for (const col of manifest.columns) {
    const src = col.source ? ` (${col.source})` : '';
    lines.push(`  - ${col.name}${src}: ${col.description || ''}`);
  }

  if (manifest.enrichment_steps.length > 0) {
    lines.push('');
    lines.push('Enrichment steps (in order):');
    for (const step of manifest.enrichment_steps) {
      const deps = step.depends_on.length > 0 ? ` [depends on: ${step.depends_on.join(', ')}]` : '';
      const outs = step.outputs.length > 0 ? ` → produces: ${step.outputs.join(', ')}` : '';
      lines.push(`  - ${step.id}: ${step.description}${deps}${outs}`);
    }
  }

  lines.push('');
  lines.push(`Searches: ${manifest.search_ids.length > 0 ? manifest.search_ids.join(', ') : '(none)'}`);
  lines.push(`Filters: ${manifest.filter_ids.length > 0 ? manifest.filter_ids.join(', ') : '(none)'}`);
  lines.push(`Rubric criteria: ${manifest.rubric_criteria_count}`);
  lines.push(`Sequence steps: ${manifest.sequence_step_count}`);

  return lines.join('\n');
};
