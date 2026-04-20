import { readFileSync } from 'node:fs';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { RoutePlanSchema } from './schema.js';
import { generateObjectWithTools } from '../../runtime/llm.js';
import { assertToolSpecAvailable } from '../../runtime/mcp.js';
import { renderPromptTemplate } from '../shared.js';
import type { ToolCatalog } from '../../runtime/tools.js';

const promptTemplate = readFileSync(new URL('prompt.md', import.meta.url), 'utf8');

export const planRouteAction = async ({
  mcp,
  routeDate,
  territory,
  stops,
  toolSpec = {},
  toolCatalog,
}: {
  mcp: Client;
  routeDate: string;
  territory: any;
  stops: any[];
  toolSpec?: any;
  toolCatalog?: ToolCatalog;
}) => {
  const hasToolkit = Array.isArray(toolSpec?.toolkits) && toolSpec.toolkits.length > 0;
  const hasTools = Array.isArray(toolSpec?.tools) && toolSpec.tools.length > 0;
  if (!hasToolkit && !hasTools) {
    throw new Error('Route planning requires a configured toolkit in channels.visit.tool.');
  }
  await assertToolSpecAvailable({
    toolSpec,
    capability: 'Route planning',
  });

  const prompt = renderPromptTemplate({
    template: promptTemplate,
    vars: {
      route_date: String(routeDate || ''),
      territory_json: JSON.stringify(territory || {}, null, 2),
      stops_json: JSON.stringify(stops || [], null, 2),
    },
  });

  const result = await generateObjectWithTools({
    mcp,
    task: 'plan-route',
    model: 'sonnet',
    schema: RoutePlanSchema,
    prompt,
    toolSpec,
    toolCatalog,
    maxSteps: 6,
  });
  return {
    ...RoutePlanSchema.parse(result.object),
    usage: result.usage,
  };
};
