import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadTools } from '../../runtime/tools.js';
import { collectProviderToolUsage } from '../../runtime/providers/usage.js';

type ToolCallActionInput = {
  mcp?: Client | null;
  listDir: string;
  stepId: string;
  stepConfig: Record<string, unknown>;
  record: Record<string, unknown>;
  toolCatalog?: unknown;
};

type ToolCallActionResult = {
  outputs: Record<string, unknown>;
  usage?: Record<string, unknown>;
  model?: string;
  provider?: string;
};

const isBlankValue = (value: unknown) => (
  value === null || value === undefined || String(value).trim() === ''
);

const valueAtPath = (payload: any, path: string) => {
  const parts = String(path || '').split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.reduce((current, part) => (
    current === null || current === undefined ? undefined : current?.[part]
  ), payload);
};

// Tool results arrive in provider envelopes that vary by server — look for the
// mapped path at the top level first, then inside the common wrappers.
const resultValueAtPath = (result: any, path: string) => {
  const payload = typeof result === 'string'
    ? (() => { try { return JSON.parse(result); } catch { return result; } })()
    : result;
  const direct = valueAtPath(payload, path);
  if (direct !== undefined) return direct;
  for (const wrapper of ['data', 'result', 'output', 'raw']) {
    const nested = valueAtPath(payload?.[wrapper], path);
    if (nested !== undefined) return nested;
    const doubleNested = valueAtPath(payload?.[wrapper]?.data, path);
    if (doubleNested !== undefined) return doubleNested;
  }
  return undefined;
};

// action: tool_call — a deterministic enrich step. Calls the configured tool
// once with args built from the record (args_map: tool arg <- record field,
// merged over static args) and maps the result into outputs (output_map:
// output field <- dot-path into the tool result). No model is involved.
export const executeToolCallAction = async ({
  mcp,
  listDir,
  stepId,
  stepConfig,
  record,
  toolCatalog,
}: ToolCallActionInput): Promise<ToolCallActionResult> => {
  const toolSpec = (stepConfig?.tool && typeof stepConfig.tool === 'object' ? stepConfig.tool : {}) as Record<string, unknown>;
  const resolvedTools = await loadTools(mcp || undefined, toolSpec, toolCatalog as any, { listDir });
  const toolEntries = Object.entries(resolvedTools);
  if (toolEntries.length === 0) {
    throw new Error(`tool_call:${stepId}: no tool resolved — check the step's tool spec against connected servers/toolkits.`);
  }
  const [, toolDef] = toolEntries[0] as [string, any];

  const staticArgs = (stepConfig?.args && typeof stepConfig.args === 'object' ? stepConfig.args : {}) as Record<string, unknown>;
  const argsMap = (stepConfig?.args_map && typeof stepConfig.args_map === 'object' ? stepConfig.args_map : {}) as Record<string, string>;
  const args: Record<string, unknown> = { ...staticArgs };
  for (const [argName, fieldName] of Object.entries(argsMap)) {
    const value = record?.[String(fieldName || '').trim()];
    if (!isBlankValue(value)) args[argName] = value;
  }

  const execution = await collectProviderToolUsage(() => toolDef.execute(args));
  const result = execution.result;

  const outputMap = (stepConfig?.output_map && typeof stepConfig.output_map === 'object' ? stepConfig.output_map : {}) as Record<string, string>;
  const outputs: Record<string, unknown> = {};
  for (const [outputName, path] of Object.entries(outputMap)) {
    const value = resultValueAtPath(result, String(path || ''));
    if (value !== undefined) outputs[outputName] = value;
  }

  return {
    outputs,
    usage: execution.usage || undefined,
    provider: execution.usage?.provider || '',
  };
};
