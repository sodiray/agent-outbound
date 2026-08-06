import { readFileSync } from 'node:fs';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SyncCrmResultSchema } from './schema.js';
import { generateObjectWithTools } from '../../runtime/llm.js';
import { assertToolSpecAvailable } from '../../runtime/mcp.js';
import { renderPromptTemplate } from '../shared.js';
import type { ToolCatalog } from '../../runtime/tools.js';
import { buildModelContext, buildModelContextPayload, withModelContextTelemetry } from '../../lib/model-context.js';

const promptTemplate = readFileSync(new URL('prompt.md', import.meta.url), 'utf8');

export const syncCrmAction = async ({
  mcp,
  record,
  crmConfig = {} as any,
  toolCatalog,
  aiConfig = {},
  listDir = '',
  inputs = [],
  identityFields = [],
  contextBudget,
}: {
  mcp: Client;
  record: any;
  crmConfig?: any;
  toolCatalog?: ToolCatalog;
  aiConfig?: any;
  listDir?: string;
  inputs?: string[];
  identityFields?: string[];
  contextBudget?: unknown;
}) => {
  const contacts = Array.isArray(record?.contacts) ? record.contacts : [];
  const modelRecord = buildModelContext({ record, inputs, identityFields, budget: contextBudget });
  const modelContext = buildModelContextPayload({
    data: { ...modelRecord.data, contacts },
    budget: contextBudget,
  });
  const prompt = renderPromptTemplate({
    template: promptTemplate,
    vars: {
      record_json: modelContext.serialized,
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
      model: crmConfig?.model || '',
      role: 'research',
      aiConfig,
      schema: SyncCrmResultSchema,
      prompt,
      toolSpec,
      toolCatalog,
      listDir,
      maxSteps: 8,
    });

    return {
      ...SyncCrmResultSchema.parse(result.object),
      usage: withModelContextTelemetry(result.usage, modelContext.telemetry),
      model: result.model,
      provider: result.provider,
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
