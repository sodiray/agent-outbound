import { readFileSync } from 'node:fs';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SyncCrmResultSchema } from './schema.js';
import { generateObjectWithTools } from '../../runtime/llm.js';
import { assertToolSpecAvailable } from '../../runtime/mcp.js';
import { renderPromptTemplate } from '../shared.js';
import type { ToolCatalog } from '../../runtime/tools.js';

const promptTemplate = readFileSync(new URL('prompt.md', import.meta.url), 'utf8');

export const syncCrmAction = async ({
  mcp,
  record,
  crmConfig = {} as any,
  toolCatalog,
}: {
  mcp: Client;
  record: any;
  crmConfig?: any;
  toolCatalog?: ToolCatalog;
}) => {
  const prompt = renderPromptTemplate({
    template: promptTemplate,
    vars: {
      record_json: JSON.stringify(record || {}, null, 2),
      crm_config_json: JSON.stringify(crmConfig || {}, null, 2),
    },
  });

  const toolSpec = crmConfig?.tool || {};
  const hasToolkit = Array.isArray(toolSpec?.toolkits) && toolSpec.toolkits.length > 0;
  const hasTools = Array.isArray(toolSpec?.tools) && toolSpec.tools.length > 0;
  if (!hasToolkit && !hasTools) {
    throw new Error('CRM sync requires a configured toolkit. Run config author to set up CRM integration.');
  }
  await assertToolSpecAvailable({
    toolSpec,
    capability: 'CRM sync',
  });

  try {
    const result = await generateObjectWithTools({
      mcp,
      task: 'sync-crm',
      model: 'sonnet',
      schema: SyncCrmResultSchema,
      prompt,
      toolSpec,
      toolCatalog,
      maxSteps: 8,
    });

    return {
      ...SyncCrmResultSchema.parse(result.object),
      usage: result.usage,
    };
  } catch (error) {
    return {
      status: 'failed',
      company_id: '',
      person_id: '',
      deal_id: '',
      remote_dnc: false,
      reason: String((error as any)?.message || 'CRM sync failed.'),
      usage: null,
    };
  }
};
