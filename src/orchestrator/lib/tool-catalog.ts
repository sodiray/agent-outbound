import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  fetchToolSchemas,
  resolveToolkitToolSlugs,
  type ToolCatalog,
} from '../runtime/tools.js';

const getToolCatalogPath = (listDir: string) => join(listDir, '.outbound', 'tool-catalog.json');

export const readToolCatalog = (listDir: string): ToolCatalog => {
  const path = getToolCatalogPath(listDir);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch {
    return {};
  }
};

export const writeToolCatalog = (listDir: string, catalog: ToolCatalog) => {
  const dir = join(listDir, '.outbound');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getToolCatalogPath(listDir), JSON.stringify(catalog, null, 2));
};

type ToolRef = {
  path: string;
  spec: any;
};

const asStringArray = (value: unknown, { upper = false } = {}) => {
  const input = Array.isArray(value) ? value : [];
  const items = input
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const normalized = upper ? items.map((item) => item.toUpperCase()) : items;
  return [...new Set(normalized)];
};

const ensureObject = (value: unknown) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  return {};
};

const addToolRef = (refs: ToolRef[], path: string, owner: any) => {
  if (!owner || typeof owner !== 'object') return;
  const existing = ensureObject(owner.tool);
  owner.tool = existing;
  refs.push({ path, spec: existing });
};

export const collectConfigToolRefs = (config: any): ToolRef[] => {
  const refs: ToolRef[] = [];
  if (!config || typeof config !== 'object') return refs;

  const searches = Array.isArray(config?.source?.searches) ? config.source.searches : [];
  for (let i = 0; i < searches.length; i += 1) {
    addToolRef(refs, `source.searches[${i}].tool`, searches[i]);
  }

  const filters = Array.isArray(config?.source?.filters) ? config.source.filters : [];
  for (let i = 0; i < filters.length; i += 1) {
    const filter = ensureObject(filters[i]);
    filter.config = ensureObject(filter.config);
    addToolRef(refs, `source.filters[${i}].config.tool`, filter.config);
  }

  const enrich = Array.isArray(config?.enrich) ? config.enrich : [];
  for (let i = 0; i < enrich.length; i += 1) {
    const step = ensureObject(enrich[i]);
    step.config = ensureObject(step.config);
    addToolRef(refs, `enrich[${i}].config.tool`, step.config);
  }

  const sequences = ensureObject(config?.sequences);
  for (const [name, sequenceRaw] of Object.entries(sequences)) {
    const sequence = ensureObject(sequenceRaw);
    sequence.reply_check = ensureObject(sequence.reply_check);
    addToolRef(refs, `sequences.${name}.reply_check.tool`, sequence.reply_check);

    const steps = Array.isArray(sequence.steps) ? sequence.steps : [];
    for (let i = 0; i < steps.length; i += 1) {
      const step = ensureObject(steps[i]);
      step.config = ensureObject(step.config);
      addToolRef(refs, `sequences.${name}.steps[${i}].config.tool`, step.config);
    }
  }

  const channels = ensureObject(config?.channels);
  for (const [channelName, channelRaw] of Object.entries(channels)) {
    const channel = ensureObject(channelRaw);
    addToolRef(refs, `channels.${channelName}.tool`, channel);
  }

  if (config.crm && typeof config.crm === 'object') {
    addToolRef(refs, 'crm.tool', config.crm);
  }

  return refs;
};

export const resolveConfigToolCatalog = async ({
  mcp,
  config,
  listDir,
}: {
  mcp: Client;
  config: any;
  listDir: string;
}) => {
  const nextConfig = structuredClone(config || {});
  const refs = collectConfigToolRefs(nextConfig);
  const catalog: ToolCatalog = {
    ...readToolCatalog(listDir),
  };

  const allSlugs = new Set<string>();
  let resolvedSpecs = 0;

  for (const ref of refs) {
    const toolkits = asStringArray(ref.spec?.toolkits, { upper: true });
    const explicitTools = asStringArray(ref.spec?.tools, { upper: true });
    const resolvedByToolkit = toolkits.length > 0
      ? await resolveToolkitToolSlugs(mcp, toolkits)
      : [];
    const tools = [...new Set([...explicitTools, ...asStringArray(resolvedByToolkit, { upper: true })])];

    ref.spec.toolkits = toolkits;
    ref.spec.tools = tools;
    if (tools.length > 0) resolvedSpecs += 1;
    for (const slug of tools) allSlugs.add(slug);
  }

  if (allSlugs.size > 0) {
    const schemas = await fetchToolSchemas(mcp, [...allSlugs]);
    for (const schema of schemas) {
      const slug = String(schema?.slug || '').trim().toUpperCase();
      if (!slug) continue;
      catalog[slug] = {
        description: String(schema?.description || ''),
        parameters: (schema?.input_schema && typeof schema.input_schema === 'object')
          ? schema.input_schema
          : (schema?.parameters && typeof schema.parameters === 'object')
            ? schema.parameters
            : { type: 'object', properties: {} },
      };
    }
  }

  writeToolCatalog(listDir, catalog);

  return {
    config: nextConfig,
    stats: {
      tool_specs_scanned: refs.length,
      tool_specs_resolved: resolvedSpecs,
      tool_count: allSlugs.size,
      catalog_size: Object.keys(catalog).length,
    },
  };
};
