import { readFileSync } from 'node:fs';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AuthorConfigOutputSchema } from './schema.js';
import { generateObjectWithTools } from '../../runtime/llm.js';
import { normalizeConfig } from '../../../schemas/config.js';
import { nowTimestamp } from '../../runtime/db.js';
import { renderPromptTemplate } from '../shared.js';
import { applyConfigChanges, validateStepRemoval } from '../../lib/config.js';
import { resolveConfigToolCatalog } from '../../lib/tool-catalog.js';
import { callMetaTool, listConnectedToolkits } from '../../runtime/mcp.js';

const promptTemplate = readFileSync(new URL('prompt.md', import.meta.url), 'utf8');

type DiscoveryAction = { slug: string; toolkit: string; description: string };

const asArray = (value: any): any[] => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.results)) return value.results;
  if (Array.isArray(value?.tools)) return value.tools;
  return [];
};

const discoverCandidateActions = async (mcp: Client, request: string): Promise<DiscoveryAction[]> => {
  const queries = [String(request || '').trim()].filter(Boolean);
  if (queries.length === 0) return [];
  try {
    const { parsed } = await callMetaTool(mcp, 'COMPOSIO_SEARCH_TOOLS', {
      queries,
      limit: 20,
    });
    // SEARCH_TOOLS returns intent-matched tools; field name varies by response shape.
    const items = asArray(parsed?.tools ?? parsed?.data ?? parsed);
    return items
      .map((item: any) => ({
        slug: String(item?.slug || item?.tool_slug || item?.name || item?.id || ''),
        toolkit: String(item?.toolkit || item?.toolkit_slug || item?.toolkitSlug || item?.app || '').toUpperCase(),
        description: String(item?.description || ''),
      }))
      .filter((item) => item.slug);
  } catch {
    return [];
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

  const [connectedToolkitSlugs, candidateActions] = await Promise.all([
    listConnectedToolkits().catch(() => [] as string[]),
    discoverCandidateActions(mcp, request),
  ]);

  const availableToolkits = connectedToolkitSlugs.map((slug) => ({ toolkit: slug, connected: true }));
  const catalogText = JSON.stringify({
    available_toolkits: availableToolkits,
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
      model: 'sonnet',
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
        };
      }
    }
    const nextConfig = applyConfigChanges(current, effectiveChanges);
    const resolved = await resolveConfigToolCatalog({ mcp, config: nextConfig, listDir });
    const normalized = normalizeConfig(resolved.config);
    if (normalized.error) {
      return {
        replace: null,
        changes: effectiveChanges,
        warnings: [...parsed.warnings, normalized.error],
        notes: parsed.notes,
        tool_resolution: resolved.stats,
        usage: result.usage,
      };
    }
    return {
      replace: normalized.config,
      changes: effectiveChanges,
      warnings: parsed.warnings,
      notes: parsed.notes,
      tool_resolution: resolved.stats,
      usage: result.usage,
    };
  } catch (error) {
    throw new Error(`author-config failed: ${String((error as any)?.message || error)}`);
  }
};
