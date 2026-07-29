import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { jsonSchema, tool, type Tool } from 'ai';
import { ComposioProvider, type ComposioToolSchema } from './providers/composio.js';
import { getDefaultProvider, getProvider } from './providers/registry.js';
import type { ProviderToolSchema, ToolProvider } from './providers/types.js';
import { isCommandServerProvider } from '../lib/provider-registry.js';
import { formatErrorMessage } from '../lib/error-format.js';
import { isBudgetExceededError } from './contract.js';

export type ToolSpec = {
  server?: string;
  toolkits?: string[];
  tools?: string[];
};

export type ToolCatalogEntry = {
  description?: string;
  parameters?: Record<string, unknown>;
  provider?: string;
  endpoint?: string;
  parameter_locations?: ProviderToolSchema['parameter_locations'];
  parameter_collisions?: ProviderToolSchema['parameter_collisions'];
};

export type ToolCatalog = Record<string, ToolCatalogEntry>;

export type { ComposioToolSchema };

const normalizeSlug = (value: unknown) => String(value || '').trim();
const normalizeServer = (value: unknown) => String(value || '').trim().toLowerCase();
const hasPinnedTools = (spec?: ToolSpec) => (
  (Array.isArray(spec?.tools) && spec.tools.length > 0)
  || (Array.isArray(spec?.toolkits) && spec.toolkits.length > 0)
);
export const getToolCatalogKey = (server: string | undefined, slug: string) => {
  const normalizedServer = normalizeServer(server);
  const normalizedSlug = normalizeSlug(slug).toUpperCase();
  return !normalizedServer || normalizedServer === 'composio'
    ? normalizedSlug
    : `${normalizedServer}:${normalizedSlug}`;
};
export const getToolObjectKey = (server: string | undefined, slug: string) => {
  const normalizedServer = normalizeServer(server);
  return !normalizedServer || normalizedServer === 'composio'
    ? normalizeSlug(slug)
    : `${normalizedServer}__${normalizeSlug(slug)}`;
};

const composioProviderFor = (mcp?: Client) => mcp
  ? new ComposioProvider(mcp)
  : getDefaultProvider();

export const resolveToolkitToolSlugs = async (mcp: Client, toolkits: string[]): Promise<string[]> => {
  return (composioProviderFor(mcp).resolveToolkitToolSlugs?.(toolkits)) || [];
};

export const searchToolSchemas = async (
  mcp: Client,
  queries: Array<string | Record<string, unknown>>,
  limit = 20,
): Promise<ComposioToolSchema[]> => {
  return composioProviderFor(mcp).searchTools(queries, limit);
};

export const fetchToolSchemas = async (mcp: Client, slugs: string[]): Promise<ComposioToolSchema[]> => {
  return composioProviderFor(mcp).getSchemas(slugs);
};

export const executeComposioTool = async (
  mcp: Client,
  slug: string,
  args: Record<string, unknown>,
) => {
  return composioProviderFor(mcp).executeTool(slug, args);
};

const schemaFromCatalog = (server: string, slug: string, entry: ToolCatalogEntry): ProviderToolSchema => ({
  slug,
  server: normalizeServer(server) || 'composio',
  name: slug,
  description: String(entry?.description || ''),
  input_schema: (entry?.parameters && typeof entry.parameters === 'object')
    ? entry.parameters
    : { type: 'object', properties: {} },
  provider: String(entry?.provider || ''),
  endpoint: String(entry?.endpoint || ''),
  parameter_locations: entry?.parameter_locations,
  parameter_collisions: entry?.parameter_collisions,
});

const loadToolsWithProvider = async (
  provider: ToolProvider,
  spec: ToolSpec = {},
  catalog?: ToolCatalog,
): Promise<Record<string, Tool>> => {
  const explicitSlugs = (spec?.tools || []).map(normalizeSlug).filter(Boolean);
  let slugs = [...new Set(explicitSlugs)];

  if (slugs.length === 0 && Array.isArray(spec?.toolkits) && spec.toolkits.length > 0) {
    const toolkitSlugs = await provider.resolveToolkitToolSlugs?.(spec.toolkits) || [];
    slugs = [...new Set(toolkitSlugs)];
  }

  if (slugs.length === 0) return {};

  let schemas: ProviderToolSchema[] = [];
  if (catalog && typeof catalog === 'object') {
    const missing: string[] = [];
    for (const slug of slugs) {
      const entry = catalog[getToolCatalogKey(provider.id, slug)];
      if (entry) {
        schemas.push(schemaFromCatalog(provider.id, slug, entry));
      } else {
        missing.push(slug);
      }
    }
    if (missing.length > 0) {
      const fetched = await provider.getSchemas(missing);
      schemas = [...schemas, ...fetched];
    }
  } else {
    schemas = await provider.getSchemas(slugs);
  }
  provider.registerSchemas?.(schemas);

  const tools: Record<string, Tool> = {};

  for (const schema of schemas) {
    const rawInputSchema = schema.input_schema && typeof schema.input_schema === 'object'
      ? (schema.input_schema as any)
      : { type: 'object', properties: {} };

    tools[getToolObjectKey(schema.server, schema.slug)] = tool({
      description: schema.description || `Tool action: ${schema.slug}`,
      inputSchema: jsonSchema(rawInputSchema),
      execute: async (args: unknown) => {
        try {
          return await provider.executeTool(schema.slug, (args || {}) as Record<string, unknown>);
        } catch (error) {
          if (isBudgetExceededError(error)) throw error;
          if (error instanceof Error && error.name === 'MonidProviderError') throw error;
          throw new Error(`${provider.id}:${schema.slug}: ${formatErrorMessage(error)}`);
        }
      },
    });
  }

  return tools;
};

export const loadTools = async (
  mcp: Client | undefined,
  spec: ToolSpec = {},
  catalog?: ToolCatalog,
  options: { listDir?: string } = {},
): Promise<Record<string, Tool>> => {
  const server = normalizeServer(spec?.server);
  const listDir = String(options.listDir || '').trim();
  const isLocalCommand = server && isCommandServerProvider(listDir, server);
  const provider = isLocalCommand || (server && server !== 'composio')
    ? getProvider(server, { listDir: options.listDir })
    : composioProviderFor(mcp);
  return loadToolsWithProvider(provider, spec, catalog);
};

export const toolSpecUsesLocalCommandServer = (
  spec: ToolSpec | undefined,
  options: { listDir?: string } = {},
) => isCommandServerProvider(String(options.listDir || '').trim(), spec?.server);

export const toolSpecNeedsMcp = (
  spec: ToolSpec | undefined,
  options: { listDir?: string } = {},
) => {
  const server = normalizeServer(spec?.server);
  return hasPinnedTools(spec)
    && server !== 'monid'
    && !toolSpecUsesLocalCommandServer(spec, options);
};

export const loadToolsForProvider = async (
  provider: ToolProvider,
  spec: ToolSpec = {},
  catalog?: ToolCatalog,
): Promise<Record<string, Tool>> => {
  return loadToolsWithProvider(provider, spec, catalog);
};
