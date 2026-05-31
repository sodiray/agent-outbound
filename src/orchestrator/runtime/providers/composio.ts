import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  assertToolSpecAvailable,
  callMetaTool,
  closeMcpClient,
  enumerateConnectedToolkits,
  getMcpClient,
  listConnectedToolkits,
} from '../mcp.js';
import type { ProviderToolSchema, ToolProvider } from './types.js';

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

const toProviderSchema = (schema: ComposioToolSchema): ProviderToolSchema => ({
  slug: schema.slug,
  server: 'composio',
  toolkit: schema.toolkit,
  name: schema.name,
  description: schema.description,
  input_schema: schema.input_schema || schema.inputSchema || schema.parameters,
});

const unwrapExecuteResult = (result: any) => {
  const parsed = result?.parsed;
  if (parsed == null) return result?.text ?? '';

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

export class ComposioProvider implements ToolProvider {
  id = 'composio';

  constructor(private readonly mcp?: Client) {}

  private async client() {
    return this.mcp || getMcpClient();
  }

  async resolveToolkitToolSlugs(toolkits: string[]): Promise<string[]> {
    const targets = [...new Set((toolkits || []).map((value) => String(value || '').trim().toUpperCase()).filter(Boolean))];
    if (targets.length === 0) return [];

    const unresolved = targets.filter((toolkit) => !toolkitToolsCache.has(toolkit));
    if (unresolved.length > 0) {
      try {
        const mcp = await this.client();
        const { parsed } = await callMetaTool(mcp, 'COMPOSIO_SEARCH_TOOLS', {
          queries: unresolved.map((toolkit) => ({ use_case: toolkit })),
          limit: 200,
        });
        const payload = (parsed as any)?.data ?? parsed;

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
  }

  async searchTools(
    queries: Array<string | Record<string, unknown>>,
    limit = 20,
  ): Promise<ProviderToolSchema[]> {
    const normalizedQueries = (queries || [])
      .map((query) => typeof query === 'string' ? String(query || '').trim() : query)
      .filter((query) => typeof query === 'object' || String(query || '').trim());
    if (normalizedQueries.length === 0) return [];

    const mcp = await this.client();
    const { parsed } = await callMetaTool(mcp, 'COMPOSIO_SEARCH_TOOLS', {
      queries: normalizedQueries,
      limit,
    });
    const payload = (parsed as any)?.data ?? parsed;

    const toolSchemas = payload?.tool_schemas;
    if (toolSchemas && typeof toolSchemas === 'object' && !Array.isArray(toolSchemas)) {
      for (const [slug, raw] of Object.entries(toolSchemas)) {
        const record = extractSchemaRecord(slug, raw);
        if (record) schemaCache.set(record.slug, record);
      }
    }

    const slugs = new Set<string>();
    const addSlug = (value: unknown) => {
      const slug = normalizeSlug(value);
      if (slug) slugs.add(slug);
    };

    for (const item of asArray(payload)) {
      addSlug(extractSlug(item));
      for (const slug of Array.isArray(item?.primary_tool_slugs) ? item.primary_tool_slugs : []) addSlug(slug);
      for (const slug of Array.isArray(item?.related_tool_slugs) ? item.related_tool_slugs : []) addSlug(slug);
    }
    for (const result of Array.isArray(payload?.results) ? payload.results : []) {
      addSlug(extractSlug(result));
      for (const slug of Array.isArray(result?.primary_tool_slugs) ? result.primary_tool_slugs : []) addSlug(slug);
      for (const slug of Array.isArray(result?.related_tool_slugs) ? result.related_tool_slugs : []) addSlug(slug);
    }

    return this.getSchemas([...slugs]);
  }

  async getSchemas(slugs: string[]): Promise<ProviderToolSchema[]> {
    const deduped = [...new Set(slugs.map(normalizeSlug).filter(Boolean))];
    const missing = deduped.filter((slug) => !schemaCache.has(slug));

    if (missing.length > 0) {
      const mcp = await this.client();
      const { parsed } = await callMetaTool(mcp, 'COMPOSIO_GET_TOOL_SCHEMAS', {
        tool_slugs: missing,
      });
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
      .filter((schema): schema is ComposioToolSchema => Boolean(schema))
      .map(toProviderSchema);
  }

  async executeTool(slug: string, args: Record<string, unknown>) {
    const mcp = await this.client();
    const result = await callMetaTool(mcp, 'COMPOSIO_MULTI_EXECUTE_TOOL', {
      tools: [{ tool_slug: slug, arguments: args || {} }],
    });
    return unwrapExecuteResult(result);
  }

  async listToolkits(): Promise<string[]> {
    if (this.mcp) {
      return enumerateConnectedToolkits(this.mcp);
    }
    return listConnectedToolkits();
  }

  async checkAvailability(toolkits: string[]): Promise<Record<string, boolean>> {
    const required = [...new Set((toolkits || []).map((slug) => String(slug || '').trim().toUpperCase()).filter(Boolean))];
    if (required.length === 0) return {};

    const availability = Object.fromEntries(required.map((slug) => [slug, false]));
    const mcp = await this.client();
    const { parsed } = await callMetaTool(mcp, 'COMPOSIO_MANAGE_CONNECTIONS', {
      toolkits: required.map((slug) => slug.toLowerCase()),
      action: 'check',
    });
    const results = (parsed as any)?.data?.results || {};
    for (const slug of required) {
      const entry = results[slug] || results[slug.toLowerCase()];
      const accounts = Array.isArray(entry?.accounts) ? entry.accounts : [];
      availability[slug] = accounts.some((a: any) => String(a?.status || '').toLowerCase() === 'active');
    }
    return availability;
  }

  async assertToolSpecAvailable({
    toolSpec,
    capability,
  }: {
    toolSpec: { toolkits?: string[]; tools?: string[] } | null | undefined;
    capability?: string;
  }) {
    return assertToolSpecAvailable({ toolSpec, capability });
  }

  async close() {
    if (!this.mcp) await closeMcpClient();
  }
}
