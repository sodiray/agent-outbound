import { readFileSync } from 'node:fs';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AuthorConfigOutputSchema } from './schema.js';
import { generateObjectWithTools } from '../../runtime/llm.js';
import { normalizeConfig } from '../../../schemas/config.js';
import { nowTimestamp } from '../../runtime/db.js';
import { renderPromptTemplate } from '../shared.js';
import { applyConfigChanges, validateStepRemoval } from '../../lib/config.js';
import { resolveConfigToolCatalog } from '../../lib/tool-catalog.js';
import { readProviderRegistry, type ServerDef } from '../../lib/provider-registry.js';
import { listConnectedToolkits } from '../../runtime/mcp.js';
import { ProviderRegistry } from '../../runtime/providers/registry.js';
import type { ProviderToolSchema } from '../../runtime/providers/types.js';
import { searchToolSchemas } from '../../runtime/tools.js';

const promptTemplate = readFileSync(new URL('prompt.md', import.meta.url), 'utf8');

type DiscoveryAction = {
  server: string;
  slug: string;
  toolkit?: string;
  description: string;
  input_parameters: string[];
};

type CustomServerCatalog = {
  name: string;
  type: ServerDef['type'];
  tools: string[];
};

const getInputParameterKeys = (schema: Pick<ProviderToolSchema, 'input_schema'>) => {
  const properties = schema?.input_schema?.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? Object.keys(properties)
    : [];
};

const discoverCandidateActions = async (mcp: Client, request: string): Promise<DiscoveryAction[]> => {
  const queries = [String(request || '').trim()].filter(Boolean);
  if (queries.length === 0) return [];
  try {
    const schemas = await searchToolSchemas(mcp, queries, 20);
    return schemas.map((schema) => {
      return {
        server: 'composio',
        slug: String(schema?.slug || '').toUpperCase(),
        toolkit: String(schema?.toolkit || '').toUpperCase(),
        description: String(schema?.description || ''),
        input_parameters: getInputParameterKeys(schema),
      };
    }).filter((item) => item.slug);
  } catch {
    return [];
  }
};

const customServerCatalog = (name: string, server: ServerDef): CustomServerCatalog => {
  const tools = 'tools' in server && Array.isArray(server.tools)
    ? server.tools.map((tool) => String(tool?.slug || '').trim()).filter(Boolean)
    : [];
  return { name, type: server.type, tools };
};

const discoverCustomProviderCatalog = async (
  listDir: string,
  request: string,
): Promise<{ candidateActions: DiscoveryAction[]; customServers: CustomServerCatalog[] }> => {
  const registryFile = readProviderRegistry(listDir);
  const servers = Object.entries(registryFile.mcpServers || {});
  if (servers.length === 0) {
    return { candidateActions: [], customServers: [] };
  }

  const providerRegistry = new ProviderRegistry();
  try {
    const queries = [String(request || '').trim()].filter(Boolean);
    const discovered = await Promise.all(servers.map(async ([name, server]) => {
      const customServer = customServerCatalog(name, server);
      if (server.type !== 'command') {
        return { customServer, candidateActions: [] };
      }

      const provider = providerRegistry.getProvider(name, { listDir });
      const matchedSchemas = await provider.searchTools(queries, 20);
      const schemas = matchedSchemas.length > 0
        ? matchedSchemas
        : await provider.searchTools([], 20);
      const candidateActions = schemas.map((schema) => ({
        server: name,
        slug: String(schema?.slug || '').trim(),
        description: String(schema?.description || ''),
        input_parameters: getInputParameterKeys(schema),
      })).filter((item) => item.slug);
      return { customServer, candidateActions };
    }));

    return {
      candidateActions: discovered.flatMap((item) => item.candidateActions),
      customServers: discovered.map((item) => item.customServer),
    };
  } finally {
    await providerRegistry.closeAll();
  }
};

export const authorConfigAction = async ({
  mcp,
  currentConfig,
  request,
  listDir,
  force = false,
}: {
  mcp: Client;
  currentConfig: any;
  request: string;
  listDir: string;
  force?: boolean;
}) => {
  const current = normalizeConfig(currentConfig || {}).config;

  const [connectedToolkitSlugs, composioCandidateActions, customCatalog] = await Promise.all([
    listConnectedToolkits().catch(() => [] as string[]),
    discoverCandidateActions(mcp, request),
    discoverCustomProviderCatalog(listDir, request),
  ]);

  const availableToolkits = connectedToolkitSlugs.map((slug) => ({ toolkit: slug, connected: true }));
  const candidateActions = [
    ...composioCandidateActions,
    ...customCatalog.candidateActions,
  ];
  const catalogText = JSON.stringify({
    available_toolkits: availableToolkits,
    custom_servers: customCatalog.customServers,
    candidate_actions: candidateActions,
    generated_at: nowTimestamp(),
  });

  const prompt = renderPromptTemplate({
    template: promptTemplate,
    vars: {
      current_config_json: JSON.stringify(current, null, 2),
      request: String(request || ''),
    },
  });
  const withCatalog = `${prompt}\n\nToolkit catalog:\n${catalogText}\n`;

  try {
    const result = await generateObjectWithTools({
      task: 'author-config',
      role: 'research',
      aiConfig: current?.ai || {},
      schema: AuthorConfigOutputSchema,
      prompt: withCatalog,
      toolSpec: {},
      maxSteps: 4,
    });

    const parsed = AuthorConfigOutputSchema.parse(result.object);
    const effectiveChanges = (parsed.changes || []).map((change: any) => {
      if (String(change?.op || '') !== 'remove_enrich') return change;
      if (!force) return change;
      return { ...change, force: true };
    });
    const removals = effectiveChanges.filter((change) => String((change as any)?.op || '') === 'remove_enrich');
    const removalIds = new Set(
      removals.map((change: any) => String(change?.id || '').trim()).filter(Boolean)
    );
    for (const removal of removals) {
      const id = String((removal as any)?.id || '').trim();
      if (!id) continue;
      const check = validateStepRemoval(current, id, Boolean((removal as any)?.force));
      if (!check.ok) {
        const blockingDependents = (check.dependents || []).filter((dep: any) => !removalIds.has(String(dep?.stepId || '').trim()));
        if (blockingDependents.length === 0) continue;
        const dependentSummary = blockingDependents
          .map((d: any) => `${d.stepId} (${d.dependencyRef})`)
          .join(', ');
        return {
          replace: null,
          changes: effectiveChanges,
          warnings: [
            ...parsed.warnings,
            `Cannot remove "${id}": ${blockingDependents.length} step(s) still depend on it.`,
            dependentSummary ? `Dependents: ${dependentSummary}` : '',
          ].filter(Boolean),
          notes: parsed.notes,
          usage: result.usage,
          model: result.model,
          provider: result.provider,
        };
      }
    }
    const nextConfig = applyConfigChanges(current, effectiveChanges);
    const resolved = await resolveConfigToolCatalog({ mcp, config: nextConfig, listDir });
    const resolutionWarnings = [
      Number((resolved.stats as any)?.invalid_tools_removed || 0) > 0
        ? `[tool_resolution] Removed ${(resolved.stats as any).invalid_tools_removed} invalid tool slug(s) and replaced them with live catalog matches where possible.`
        : '',
      Number((resolved.stats as any)?.input_args_removed || 0) > 0
        ? `[tool_resolution] Removed ${(resolved.stats as any).input_args_removed} invalid tool argument key(s) not present in live schemas.`
        : '',
    ].filter(Boolean);
    if (Number((resolved.stats as any)?.tool_specs_unresolved || 0) > 0) {
      return {
        replace: null,
        changes: effectiveChanges,
        warnings: [
          ...parsed.warnings,
          ...resolutionWarnings,
          `[tool_resolution] ${resolved.stats.tool_specs_unresolved} tool reference(s) could not be resolved against the configured provider catalog.`,
          candidateActions.length > 0
            ? `Candidate tools: ${candidateActions.map((item) => `${item.server}:${item.slug}`).join(', ')}`
            : 'No candidate tools were returned by Composio or custom providers for this request.',
        ],
        notes: parsed.notes,
        tool_resolution: resolved.stats,
        usage: result.usage,
        model: result.model,
        provider: result.provider,
      };
    }
    const normalized = normalizeConfig(resolved.config);
    if (normalized.error) {
      return {
        replace: null,
        changes: effectiveChanges,
        warnings: [...parsed.warnings, ...resolutionWarnings, normalized.error],
        notes: parsed.notes,
        tool_resolution: resolved.stats,
        usage: result.usage,
        model: result.model,
        provider: result.provider,
      };
    }
    return {
      replace: normalized.config,
      changes: effectiveChanges,
      warnings: [...parsed.warnings, ...resolutionWarnings],
      notes: parsed.notes,
      tool_resolution: resolved.stats,
      usage: result.usage,
      model: result.model,
      provider: result.provider,
    };
  } catch (error) {
    throw new Error(`author-config failed: ${String((error as any)?.message || error)}`);
  }
};
