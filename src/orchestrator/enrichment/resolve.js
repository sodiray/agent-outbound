/**
 * Config resolver (structure only).
 *
 * Previous resolver encoded semantic mapping and vendor/tool intelligence.
 * The new architecture keeps intelligence in the LLM layer, so this module only
 * validates and normalizes structural config requirements.
 */
import { readYaml, writeYaml } from '../lib/yaml.js';
import {
  ensureCanonicalCsvExists,
  ensureRuntimeDirs,
  resolveVirtualPath,
} from '../lib/runtime.js';
import { loadResolvedConfigFromOutbound } from './schema.js';

const toArray = (value) => (Array.isArray(value) ? value : []);

export const resolveConfig = async (listDir) => {
  ensureRuntimeDirs(listDir);
  ensureCanonicalCsvExists(listDir);

  const outboundPath = resolveVirtualPath({
    listDir,
    filePath: '@list/outbound.yaml',
    allowRelative: false,
  });

  const outboundConfig = readYaml(outboundPath);
  if (outboundConfig._raw) {
    throw new Error('Could not parse outbound.yaml.');
  }

  const resolved = loadResolvedConfigFromOutbound(listDir);

  // Persist deterministic helper metadata for runtime visibility.
  outboundConfig.resolve_dependency_order = resolved.dependency_order;
  outboundConfig.resolve_manual_fields = resolved.manual_fields;
  outboundConfig.resolve_warnings = resolved.warnings;
  outboundConfig.resolve_column_errors = resolved.column_errors;

  // Ensure expected top-level sections exist even when empty.
  outboundConfig.source = outboundConfig.source && typeof outboundConfig.source === 'object'
    ? outboundConfig.source
    : {};
  outboundConfig.source.searches = toArray(outboundConfig.source.searches);
  outboundConfig.source.filters = toArray(outboundConfig.source.filters);
  outboundConfig.enrich = toArray(outboundConfig.enrich);
  const rubricRaw = outboundConfig.rubric;
  outboundConfig.rubric = Array.isArray(rubricRaw)
    ? rubricRaw
    : Array.isArray(rubricRaw?.criteria)
      ? rubricRaw.criteria
      : [];
  outboundConfig.sequence = outboundConfig.sequence && typeof outboundConfig.sequence === 'object'
    ? outboundConfig.sequence
    : { steps: [] };
  outboundConfig.sequence.steps = toArray(outboundConfig.sequence.steps);
  outboundConfig.sequence.on_reply = String(outboundConfig.sequence.on_reply || 'pause');
  outboundConfig.sequence.on_bounce = String(outboundConfig.sequence.on_bounce || 'pause');

  writeYaml(outboundPath, outboundConfig);

  return {
    warnings: resolved.warnings || [],
    column_errors: resolved.column_errors || [],
    sources: Object.keys(resolved.sources || {}),
    filters: Object.keys(resolved.filters || {}),
    rubric_criteria: resolved.rubric?.criteria?.length || 0,
    sequence_steps: resolved.sequence?.steps?.length || 0,
  };
};
