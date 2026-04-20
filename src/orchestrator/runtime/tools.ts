import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { jsonSchema, tool, type Tool } from 'ai';
import { callMetaTool } from './mcp.js';

export type ToolSpec = {
  toolkits?: string[];
  tools?: string[];
};

export type ToolCatalogEntry = {
  description?: string;
  parameters?: Record<string, unknown>;
};

export type ToolCatalog = Record<string, ToolCatalogEntry>;

export type ComposioToolSchema = {
  slug: string;
  toolkit?: string;
  name?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
};

const schemaCache = new Map<string, ComposioToolSchema>();
const toolkitToolsCache = new Map<string, string[]>();

const normalizeSlug = (value: unknown) => String(value || '').trim();

const extractSchemaRecord = (slug: string, item: any): ComposioToolSchema | null => {
  const finalSlug = normalizeSlug(item?.tool_slug || item?.slug || slug);
  if (!finalSlug) return null;
  return {
    slug: finalSlug,
    toolkit: String(item?.toolkit || item?.toolkit_slug || item?.toolkitSlug || item?.app || '').trim().toUpperCase(),
    name: String(item?.name || finalSlug),
    description: String(item?.description || ''),
    input_schema: item?.input_schema || item?.inputSchema || item?.parameters || { type: 'object', properties: {} },
  };
};

const asArray = (value: any): any[] => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.results)) return value.results;
  if (Array.isArray(value?.tools)) return value.tools;
  return [];
};

const extractSlug = (item: any) => normalizeSlug(item?.slug || item?.tool_slug || item?.name || item?.id);
const extractToolkit = (item: any) =>
  String(item?.toolkit || item?.toolkit_slug || item?.toolkitSlug || item?.app || '').trim().toUpperCase();

export const resolveToolkitToolSlugs = async (mcp: Client, toolkits: string[]): Promise<string[]> => {
  const targets = [...new Set((toolkits || []).map((value) => String(value || '').trim().toUpperCase()).filter(Boolean))];
  if (targets.length === 0) return [];

  const unresolved = targets.filter((toolkit) => !toolkitToolsCache.has(toolkit));
  if (unresolved.length > 0) {
    try {
      const { parsed } = await callMetaTool(mcp, 'COMPOSIO_SEARCH_TOOLS', {
        queries: unresolved.map((toolkit) => ({ use_case: toolkit })),
        limit: 200,
      });
      const payload = (parsed as any)?.data ?? parsed;

      // Extract slugs from results[].primary_tool_slugs and related_tool_slugs,
      // grouped by the toolkit each result belongs to.
      const results = Array.isArray(payload?.results) ? payload.results : [];
      const grouped = new Map<string, Set<string>>();

      for (const result of results) {
        const resultToolkits = (Array.isArray(result?.toolkits) ? result.toolkits : [])
          .map((t: unknown) => String(t || '').trim().toUpperCase())
          .filter(Boolean);
        const slugsFromResult = [
          ...(Array.isArray(result?.primary_tool_slugs) ? result.primary_tool_slugs : []),
          ...(Array.isArray(result?.related_tool_slugs) ? result.related_tool_slugs : []),
        ].map(normalizeSlug).filter(Boolean);

        for (const toolkit of resultToolkits) {
          if (!grouped.has(toolkit)) grouped.set(toolkit, new Set<string>());
          for (const slug of slugsFromResult) grouped.get(toolkit)!.add(slug);
        }
      }

      // Pre-populate schema cache from tool_schemas included in the response.
      const toolSchemas = payload?.tool_schemas;
      if (toolSchemas && typeof toolSchemas === 'object' && !Array.isArray(toolSchemas)) {
        for (const [slug, raw] of Object.entries(toolSchemas)) {
          const record = extractSchemaRecord(slug, raw);
          if (record && !schemaCache.has(record.slug)) schemaCache.set(record.slug, record);
        }
      }

      for (const toolkit of unresolved) {
        toolkitToolsCache.set(toolkit, [...(grouped.get(toolkit) || new Set<string>())]);
      }
    } catch {
      for (const toolkit of unresolved) {
        toolkitToolsCache.set(toolkit, []);
      }
    }
  }

  const slugs = new Set<string>();
  for (const toolkit of targets) {
    for (const slug of toolkitToolsCache.get(toolkit) || []) {
      slugs.add(slug);
    }
  }
  return [...slugs];
};

const fetchToolSchemas = async (mcp: Client, slugs: string[]): Promise<ComposioToolSchema[]> => {
  const deduped = [...new Set(slugs.map(normalizeSlug).filter(Boolean))];
  const missing = deduped.filter((slug) => !schemaCache.has(slug));

  if (missing.length > 0) {
    const { parsed } = await callMetaTool(mcp, 'COMPOSIO_GET_TOOL_SCHEMAS', {
      tool_slugs: missing,
    });
    // Response: { data: { tool_schemas: { SLUG: { toolkit, tool_slug, description, input_schema } } } }
    const data = (parsed as any)?.data ?? parsed;
    const schemasByslug = data?.tool_schemas;
    if (schemasByslug && typeof schemasByslug === 'object' && !Array.isArray(schemasByslug)) {
      for (const [slug, raw] of Object.entries(schemasByslug)) {
        const record = extractSchemaRecord(slug, raw);
        if (record) schemaCache.set(record.slug, record);
      }
    }
  }

  return deduped
    .map((slug) => schemaCache.get(slug))
    .filter((schema): schema is ComposioToolSchema => Boolean(schema));
};
export { fetchToolSchemas };

const unwrapExecuteResult = (result: any) => {
  const parsed = result?.parsed;
  if (parsed == null) return result?.text ?? '';

  // Composio MULTI_EXECUTE_TOOL response shape:
  //   { successful: true/false,
  //     data: {
  //       results: [
  //         (success) { response: { successful, data: <real tool output> }, tool_slug, index }
  //         (failure) { error: "...", tool_slug, index }
  //       ],
  //       total_count, success_count, error_count
  //     } }
  // Single-tool callers get the first entry's real payload; errors throw so
  // the AI SDK's tool loop can retry or surface them.
  const data = (parsed as any)?.data ?? parsed;
  const results = Array.isArray(data?.results) ? data.results : null;
  if (!results || results.length === 0) return data;

  const first = results[0];
  if (first?.error && !first?.response) {
    throw new Error(String(first.error));
  }
  const response = first?.response;
  if (response?.successful === false) {
    throw new Error(String(response?.error || 'tool execution failed'));
  }
  return response?.data ?? response ?? first;
};

export const executeComposioTool = async (
  mcp: Client,
  slug: string,
  args: Record<string, unknown>,
) => {
  const result = await callMetaTool(mcp, 'COMPOSIO_MULTI_EXECUTE_TOOL', {
    tools: [{ tool_slug: slug, arguments: args || {} }],
  });
  return unwrapExecuteResult(result);
};

const schemaFromCatalog = (slug: string, entry: ToolCatalogEntry): ComposioToolSchema => ({
  slug,
  name: slug,
  description: String(entry?.description || ''),
  input_schema: (entry?.parameters && typeof entry.parameters === 'object')
    ? entry.parameters
    : { type: 'object', properties: {} },
});

export const loadTools = async (
  mcp: Client,
  spec: ToolSpec = {},
  catalog?: ToolCatalog,
): Promise<Record<string, Tool>> => {
  const explicitSlugs = (spec?.tools || []).map(normalizeSlug).filter(Boolean);
  let slugs = [...new Set(explicitSlugs)];

  if (slugs.length === 0 && Array.isArray(spec?.toolkits) && spec.toolkits.length > 0) {
    // Defensive fallback for configs that haven't been resolved yet.
    const toolkitSlugs = await resolveToolkitToolSlugs(mcp, spec.toolkits);
    slugs = [...new Set(toolkitSlugs)];
  }

  if (slugs.length === 0) return {};

  let schemas: ComposioToolSchema[] = [];
  if (catalog && typeof catalog === 'object') {
    const missing: string[] = [];
    for (const slug of slugs) {
      const entry = catalog[slug];
      if (entry) {
        schemas.push(schemaFromCatalog(slug, entry));
      } else {
        missing.push(slug);
      }
    }
    if (missing.length > 0) {
      const fetched = await fetchToolSchemas(mcp, missing);
      schemas = [...schemas, ...fetched];
    }
  } else {
    schemas = await fetchToolSchemas(mcp, slugs);
  }

  const tools: Record<string, Tool> = {};

  for (const schema of schemas) {
    const rawInputSchema = schema.input_schema && typeof schema.input_schema === 'object'
      ? (schema.input_schema as any)
      : { type: 'object', properties: {} };

    tools[schema.slug] = tool({
      description: schema.description || `Composio action: ${schema.slug}`,
      inputSchema: jsonSchema(rawInputSchema),
      execute: async (args: unknown) => {
        return executeComposioTool(mcp, schema.slug, (args || {}) as Record<string, unknown>);
      },
    });
  }

  return tools;
};
