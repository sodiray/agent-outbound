import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  fetchToolSchemas,
  getToolCatalogKey,
  resolveToolkitToolSlugs,
  searchToolSchemas,
  type ToolCatalog,
  type ComposioToolSchema,
} from '../runtime/tools.js';
import { listConnectedToolkits } from '../runtime/mcp.js';
import { getProvider } from '../runtime/providers/registry.js';
import type { ProviderToolSchema, ToolProvider } from '../runtime/providers/types.js';

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
  owner: any;
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
  refs.push({ path, spec: existing, owner });
};

const normalizeToolSlug = (value: unknown) => String(value || '').trim().toUpperCase();
const normalizeServer = (value: unknown) => String(value || '').trim().toLowerCase();
const isComposioServer = (server: string) => !server || server === 'composio';
const serializeServer = (server: string) => isComposioServer(server) ? '' : server;

const getSchemaSlug = (schema: ProviderToolSchema | ComposioToolSchema) => normalizeToolSlug(schema?.slug);

const getSchemaParameters = (schema: ProviderToolSchema | ComposioToolSchema) => {
  const candidate = schema as any;
  const raw = (schema?.input_schema && typeof schema.input_schema === 'object')
    ? schema.input_schema
    : (candidate?.parameters && typeof candidate.parameters === 'object')
      ? candidate.parameters
      : {};
  const properties = (raw as any)?.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? Object.keys(properties)
    : [];
};

const pruneInvalidArgs = (ref: ToolRef, schemas: Array<ProviderToolSchema | ComposioToolSchema>) => {
  const args = ensureObject(ref.owner?.args);
  if (Object.keys(args).length === 0) return 0;

  const allowed = new Set(
    schemas.flatMap((schema) => getSchemaParameters(schema))
      .map((key) => String(key || '').trim())
      .filter(Boolean)
  );
  if (allowed.size === 0) return 0;

  let removed = 0;
  for (const key of Object.keys(args)) {
    if (allowed.has(key)) continue;
    delete args[key];
    removed += 1;
  }
  ref.owner.args = args;
  return removed;
};

const candidateQueriesForRef = (ref: ToolRef, invalidTools: string[]) => {
  const queries = [
    String(ref.spec?.search || '').trim(),
    invalidTools.join(' '),
    [
      ref.path,
      asStringArray(ref.spec?.toolkits, { upper: true }).join(' '),
      invalidTools.join(' '),
    ].join(' ').trim(),
  ].filter(Boolean);
  return [...new Set(queries)];
};

const filterSchemasByToolkit = (schemas: Array<ProviderToolSchema | ComposioToolSchema>, toolkits: string[], connectedToolkits = new Set<string>()) => {
  const allowed = new Set(toolkits.map((toolkit) => toolkit.toUpperCase()));
  return schemas.filter((schema) => {
    const toolkit = String(schema?.toolkit || '').trim().toUpperCase();
    if (toolkit && connectedToolkits.size > 0 && !connectedToolkits.has(toolkit)) return false;
    return toolkits.length === 0 || !toolkit || allowed.has(toolkit);
  });
};

const getProviderForRef = (server: string, listDir: string): ToolProvider | null => {
  if (isComposioServer(server)) return null;
  return getProvider(server, { listDir });
};

const fetchSchemasForRef = async ({
  provider,
  mcp,
  slugs,
}: {
  provider: ToolProvider | null;
  mcp: Client;
  slugs: string[];
}) => provider ? provider.getSchemas(slugs) : fetchToolSchemas(mcp, slugs);

const searchSchemasForRef = async ({
  provider,
  mcp,
  queries,
  limit,
}: {
  provider: ToolProvider | null;
  mcp: Client;
  queries: Array<string | Record<string, unknown>>;
  limit: number;
}) => provider ? provider.searchTools(queries, limit) : searchToolSchemas(mcp, queries, limit);

const resolveToolkitSlugsForRef = async ({
  provider,
  mcp,
  toolkits,
}: {
  provider: ToolProvider | null;
  mcp: Client;
  toolkits: string[];
}) => provider ? (provider.resolveToolkitToolSlugs?.(toolkits) || []) : resolveToolkitToolSlugs(mcp, toolkits);

export const collectConfigToolRefs = (config: any): ToolRef[] => {
  const refs: ToolRef[] = [];
  if (!config || typeof config !== 'object') return refs;

  const searches = Array.isArray(config?.source?.searches) ? config.source.searches : [];
  for (let i = 0; i < searches.length; i += 1) {
    addToolRef(refs, `source.searches[${i}].tool`, searches[i]);
  }

  const pipeline = Array.isArray(config?.pipeline) ? config.pipeline : [];
  for (let i = 0; i < pipeline.length; i += 1) {
    const step = ensureObject(pipeline[i]);
    if (String(step?.kind || '') === 'enrich') {
      addToolRef(refs, `pipeline[${i}].tool`, step);
    }
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
  let invalidToolsRemoved = 0;
  let unresolvedSpecs = 0;
  let inputArgsRemoved = 0;
  const connectedToolkits = new Set((await listConnectedToolkits().catch(() => [] as string[])).map((slug) => String(slug || '').trim().toUpperCase()).filter(Boolean));

  for (const ref of refs) {
    const server = normalizeServer(ref.spec?.server);
    const provider = getProviderForRef(server, listDir);
    const toolkits = asStringArray(ref.spec?.toolkits, { upper: true });
    const explicitTools = asStringArray(ref.spec?.tools, { upper: true });
    const explicitSchemas = explicitTools.length > 0
      ? filterSchemasByToolkit(
        await fetchSchemasForRef({ provider, mcp, slugs: explicitTools }),
        isComposioServer(server) ? toolkits : [],
        connectedToolkits,
      )
      : [];
    const validExplicit = new Set(explicitSchemas.map(getSchemaSlug).filter(Boolean));
    const invalidTools = explicitTools.filter((slug) => !validExplicit.has(slug));
    invalidToolsRemoved += invalidTools.length;

    const candidateSchemas = invalidTools.length > 0 || String(ref.spec?.search || '').trim()
      ? filterSchemasByToolkit(
        await searchSchemasForRef({
          provider,
          mcp,
          queries: candidateQueriesForRef(ref, invalidTools),
          limit: Number(ref.spec?.limit || 25),
        }),
        isComposioServer(server) ? toolkits : [],
        connectedToolkits,
      )
      : [];
    const candidateTools = candidateSchemas.map(getSchemaSlug).filter(Boolean);

    const resolvedByToolkit = validExplicit.size === 0 && candidateTools.length === 0 && toolkits.length > 0
      ? await resolveToolkitSlugsForRef({ provider, mcp, toolkits })
      : [];
    const tools = [...new Set([
      ...[...validExplicit],
      ...candidateTools,
      ...asStringArray(resolvedByToolkit, { upper: true }),
    ])];

    ref.spec.toolkits = toolkits;
    ref.spec.server = serializeServer(server);
    ref.spec.tools = tools;
    if (tools.length > 0) {
      resolvedSpecs += 1;
    } else if (toolkits.length > 0 || explicitTools.length > 0 || String(ref.spec?.search || '').trim()) {
      unresolvedSpecs += 1;
    }
    for (const slug of tools) allSlugs.add(getToolCatalogKey(server, slug));
  }

  const schemasByKey = new Map<string, ProviderToolSchema | ComposioToolSchema>();
  const slugsByServer = new Map<string, string[]>();
  for (const key of allSlugs) {
    const separator = key.indexOf(':');
    const server = separator >= 0 ? key.slice(0, separator) : '';
    const slug = separator >= 0 ? key.slice(separator + 1) : key;
    slugsByServer.set(server, [...(slugsByServer.get(server) || []), slug]);
  }
  for (const [server, slugs] of slugsByServer) {
    const provider = getProviderForRef(server, listDir);
    const schemas = await fetchSchemasForRef({ provider, mcp, slugs });
    for (const schema of schemas) {
      const slug = String(schema?.slug || '').trim().toUpperCase();
      if (!slug) continue;
      const key = getToolCatalogKey(server, slug);
      const candidate = schema as any;
      schemasByKey.set(key, schema);
      catalog[key] = {
        description: String(schema?.description || ''),
        parameters: (schema?.input_schema && typeof schema.input_schema === 'object')
          ? schema.input_schema
          : (candidate?.parameters && typeof candidate.parameters === 'object')
            ? candidate.parameters
            : { type: 'object', properties: {} },
      };
    }
  }

  for (const ref of refs) {
    const server = normalizeServer(ref.spec?.server);
    const schemas = asStringArray(ref.spec?.tools, { upper: true })
      .map((slug) => schemasByKey.get(getToolCatalogKey(server, slug)))
      .filter((schema): schema is ProviderToolSchema | ComposioToolSchema => Boolean(schema));
    inputArgsRemoved += pruneInvalidArgs(ref, schemas);
  }

  writeToolCatalog(listDir, catalog);

  return {
    config: nextConfig,
    stats: {
      tool_specs_scanned: refs.length,
      tool_specs_resolved: resolvedSpecs,
      tool_specs_unresolved: unresolvedSpecs,
      invalid_tools_removed: invalidToolsRemoved,
      input_args_removed: inputArgsRemoved,
      tool_count: allSlugs.size,
      catalog_size: Object.keys(catalog).length,
    },
  };
};
