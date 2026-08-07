import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadTools, type ToolSpec } from '../../runtime/tools.js';
import { collectProviderToolUsage } from '../../runtime/providers/usage.js';
import { isBudgetExceededError } from '../../runtime/contract.js';

type ToolCallActionInput = {
  mcp?: Client | null;
  listDir: string;
  stepId: string;
  stepConfig: Record<string, unknown>;
  record: Record<string, unknown>;
  toolCatalog?: unknown;
  env?: Record<string, string | undefined>;
};

type ToolCallActionResult = {
  outputs: Record<string, unknown>;
  usage?: Record<string, unknown>;
  model?: string;
  provider?: string;
  /** Tools attempted in waterfall order (slug/server labels). */
  waterfall_attempts?: string[];
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

const toolSpecLabel = (spec: ToolSpec): string => {
  const server = String(spec?.server || '').trim();
  const tools = Array.isArray(spec?.tools) ? spec.tools.map(String).filter(Boolean) : [];
  const toolkits = Array.isArray(spec?.toolkits) ? spec.toolkits.map(String).filter(Boolean) : [];
  const tip = tools[0] || toolkits[0] || 'tool';
  return server ? `${server}:${tip}` : tip;
};

const hasToolPin = (spec: unknown): spec is ToolSpec => {
  if (!spec || typeof spec !== 'object') return false;
  const s = spec as ToolSpec;
  return (Array.isArray(s.tools) && s.tools.length > 0)
    || (Array.isArray(s.toolkits) && s.toolkits.length > 0);
};

/**
 * Ordered tool specs for tool_call: primary `tool`, then `waterfall` or
 * `fallback_tools` (array of tool specs). Empty / invalid entries skipped.
 */
export const resolveToolWaterfall = (stepConfig: Record<string, unknown>): ToolSpec[] => {
  const chain: ToolSpec[] = [];
  const primary = stepConfig?.tool;
  if (hasToolPin(primary)) chain.push(primary as ToolSpec);

  const rawWaterfall = Array.isArray(stepConfig?.waterfall)
    ? stepConfig.waterfall
    : (Array.isArray(stepConfig?.fallback_tools) ? stepConfig.fallback_tools : []);

  for (const entry of rawWaterfall) {
    if (!hasToolPin(entry)) continue;
    // De-dupe exact same server+tools pin to avoid double-calling.
    const label = toolSpecLabel(entry as ToolSpec);
    if (chain.some((s) => toolSpecLabel(s) === label)) continue;
    chain.push(entry as ToolSpec);
  }
  return chain;
};

/**
 * Retryable provider failures advance the waterfall. Permanent / config / budget
 * failures fail closed immediately (no invented success, no silent skip).
 */
export const isRetryableToolError = (error: unknown): boolean => {
  if (isBudgetExceededError(error)) return false;
  if (error && typeof error === 'object') {
    const e = error as { retryable?: unknown; code?: unknown; status?: unknown; name?: unknown };
    if (e.retryable === false) return false;
    if (e.retryable === true) return true;
    const status = Number(e.status);
    if (Number.isFinite(status) && status >= 500) return true;
    if (status === 429) return true;
    if (String(e.code || '') === 'BUDGET_EXCEEDED') return false;
  }
  const msg = String((error as any)?.message || error || '').toLowerCase();
  if (!msg.trim()) return false;
  // Permanent / operator-actionable: do not waterfall past these.
  if (/\b(invalid[_\s-]?argument|not[_\s-]?found|unauthorized|forbidden|tool_not_connected|unsupported)\b/.test(msg)) {
    return false;
  }
  return (
    /\b(429|502|503|504|timeout|timed out|etimedout|econnreset|econnrefused|enotfound|socket hang up|rate.?limit|temporar(y|ily)|unavailable|overloaded|try again|retry)\b/.test(msg)
    || /\b5\d\d\b/.test(msg)
  );
};

type RecordScopedToolFailure = Error & {
  tool_failure_scope?: unknown;
};

const errorMessage = (error: unknown) => (
  error instanceof Error ? error.message : String(error || '')
);

const hasUrlArgument = (args: Record<string, unknown>): boolean => (
  Object.values(args).some((value) => /^https?:\/\//i.test(String(value || '').trim()))
);

const isRecordScopedProviderOutcome = ({
  error,
  args,
}: {
  error: unknown;
  args: Record<string, unknown>;
}): boolean => {
  if (isBudgetExceededError(error)) return false;
  const detail = errorMessage(error).toLowerCase();
  if (
    /\b(401|403|unauthorized|forbidden|auth(?:entication|orization)?|api[ _-]?key|credential|invalid[_\s-]?argument|misconfigur|no tool resolved|not connected|tool_not_connected|unsupported)\b/.test(detail)
  ) {
    return false;
  }
  if (/\b(?:http\s*)?(404|408|410)\b/.test(detail)) return true;
  if (!hasUrlArgument(args)) return false;
  return /\b(timeout|timed out|etimedout|econnreset|econnrefused|enotfound|socket hang up)\b/.test(detail);
};

const recordScopedToolFailure = (error: unknown): RecordScopedToolFailure => {
  const tagged = error instanceof Error ? error : new Error(errorMessage(error));
  Object.assign(tagged, { tool_failure_scope: 'record' });
  return tagged;
};

/** A tool failure tagged as a record-local provider outcome may honor on_error: empty. */
export const isRecordScopedProviderToolError = (error: unknown): boolean => (
  Boolean(
    error
    && typeof error === 'object'
    && (error as RecordScopedToolFailure).tool_failure_scope === 'record',
  )
);

const mapOutputsFromResult = (
  result: unknown,
  outputMap: Record<string, string>,
): Record<string, unknown> => {
  const outputs: Record<string, unknown> = {};
  for (const [outputName, path] of Object.entries(outputMap)) {
    const value = resultValueAtPath(result, String(path || ''));
    if (value !== undefined) outputs[outputName] = value;
  }

  // Always surface provider identity fields when the tool returns them (e.g. SMTP
  // sink message_id / thread_id), even if output_map omitted them.
  for (const key of [
    'message_id',
    'provider_id',
    'thread_id',
    'provider_message_id',
    'provider_thread_id',
  ] as const) {
    if (outputs[key] !== undefined) continue;
    const value = resultValueAtPath(result, key);
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      outputs[key] = value;
    }
  }
  return outputs;
};

const mergeUsage = (
  acc: Record<string, unknown> | null,
  next: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null => {
  if (!next) return acc;
  if (!acc) return { ...next };
  const aCalls = Array.isArray(acc.tool_calls) ? acc.tool_calls : [];
  const bCalls = Array.isArray(next.tool_calls) ? next.tool_calls : [];
  const aCosts = Array.isArray(acc.tool_costs) ? acc.tool_costs : [];
  const bCosts = Array.isArray(next.tool_costs) ? next.tool_costs : [];
  return {
    ...acc,
    ...next,
    usd_cost: Number(acc.usd_cost || 0) + Number(next.usd_cost || 0),
    tool_calls: [...aCalls, ...bCalls],
    tool_costs: [...aCosts, ...bCosts],
    provider: next.provider || acc.provider || '',
  };
};

// action: tool_call — a deterministic enrich step. Calls the configured tool
// once with args built from the record (args_map: tool arg <- record field,
// merged over static args) and maps the result into outputs (output_map:
// output field <- dot-path into the tool result). No model is involved.
//
// Provider waterfall: when `waterfall` / `fallback_tools` is configured, retryable
// failures on the primary tool advance to the next tool spec. Permanent errors
// and exhaustion fail closed — never invent success outputs.
export const executeToolCallAction = async ({
  mcp,
  listDir,
  stepId,
  stepConfig,
  record,
  toolCatalog,
  env,
}: ToolCallActionInput): Promise<ToolCallActionResult> => {
  const outputMap = (stepConfig?.output_map && typeof stepConfig.output_map === 'object' ? stepConfig.output_map : {}) as Record<string, string>;
  const declaredOutputs = (stepConfig?.outputs && typeof stepConfig.outputs === 'object' ? stepConfig.outputs : {}) as Record<string, unknown>;

  // Deterministic fixture: no live Monid/tool MCP. Preserve existing field values when present.
  if (String(process.env.AO_PIPELINE_FIXTURE || process.env.AO_STEP_FIXTURE || '').trim() === '1') {
    const outputs: Record<string, unknown> = {};
    const names = new Set<string>([
      ...Object.keys(outputMap),
      ...Object.keys(declaredOutputs),
    ]);
    for (const outputName of names) {
      const existing = record?.[outputName];
      if (!isBlankValue(existing)) {
        outputs[outputName] = existing;
        continue;
      }
      if (outputName === 'site_text' || outputName === 'markdown') {
        const name = String(record?.business_name || 'business').trim() || 'business';
        outputs[outputName] = `Fixture site text for ${name}. Local HVAC service company serving the Treasure Valley.`;
      } else {
        outputs[outputName] = `fixture_${outputName}`;
      }
    }
    return {
      outputs,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        usd_cost: 0,
        tool_calls: [{ tool: 'fixture_tool_call', step_id: stepId }],
        tool_costs: [],
      },
      provider: 'fixture',
      model: 'fixture',
    };
  }

  const chain = resolveToolWaterfall(stepConfig);
  if (chain.length === 0) {
    throw new Error(`tool_call:${stepId}: no tool resolved — check the step's tool / waterfall / fallback_tools against connected servers/toolkits.`);
  }

  const staticArgs = (stepConfig?.args && typeof stepConfig.args === 'object' ? stepConfig.args : {}) as Record<string, unknown>;
  const argsMap = (stepConfig?.args_map && typeof stepConfig.args_map === 'object' ? stepConfig.args_map : {}) as Record<string, string>;
  const args: Record<string, unknown> = { ...staticArgs };
  for (const [argName, fieldName] of Object.entries(argsMap)) {
    const value = record?.[String(fieldName || '').trim()];
    if (!isBlankValue(value)) args[argName] = value;
  }

  // Production try: loadTools + execute. Tests inject tryTool via stepConfig.__tryTool.
  const injectedTry = typeof (stepConfig as any).__tryTool === 'function'
    ? (stepConfig as any).__tryTool as (spec: ToolSpec, callArgs: Record<string, unknown>) => Promise<{
      result: unknown;
      usage?: Record<string, unknown> | null;
      provider?: string;
    }>
    : null;

  const tryTool = async (toolSpec: ToolSpec) => {
    if (injectedTry) return injectedTry(toolSpec, args);
    const resolvedTools = await loadTools(mcp || undefined, toolSpec, toolCatalog as any, { listDir, env });
    const toolEntries = Object.entries(resolvedTools);
    if (toolEntries.length === 0) {
      throw new Error(`tool_call:${stepId}: no tool resolved for ${toolSpecLabel(toolSpec)}`);
    }
    const [, toolDef] = toolEntries[0] as [string, any];
    const execution = await collectProviderToolUsage(() => toolDef.execute(args));
    return {
      result: execution.result,
      usage: execution.usage as Record<string, unknown> | null,
      provider: String(execution.usage?.provider || toolSpec.server || ''),
    };
  };

  const walked = await runProviderWaterfall({
    stepId,
    chain,
    tryTool,
  }).catch((error: unknown) => {
    if (!isRecordScopedProviderOutcome({ error, args })) throw error;
    throw recordScopedToolFailure(error);
  });

  return {
    outputs: mapOutputsFromResult(walked.result, outputMap),
    usage: walked.usage || undefined,
    provider: walked.provider || '',
    waterfall_attempts: walked.attempts,
  };
};

/**
 * Ordered provider waterfall: try each tool spec; advance only on retryable
 * failures (or resolve-style unavailability). Fail closed after exhaustion —
 * never invent success. Exported for unit tests with injected tryTool.
 */
export const runProviderWaterfall = async ({
  stepId,
  chain,
  tryTool,
}: {
  stepId: string;
  chain: ToolSpec[];
  tryTool: (spec: ToolSpec) => Promise<{
    result: unknown;
    usage?: Record<string, unknown> | null;
    provider?: string;
  }>;
}): Promise<{
  result: unknown;
  usage: Record<string, unknown> | null;
  provider: string;
  attempts: string[];
}> => {
  const attempts: string[] = [];
  const errors: string[] = [];
  let usageAcc: Record<string, unknown> | null = null;
  let lastError: unknown = null;

  for (let i = 0; i < chain.length; i += 1) {
    const toolSpec = chain[i];
    const label = toolSpecLabel(toolSpec);
    attempts.push(label);
    try {
      const outcome = await tryTool(toolSpec);
      usageAcc = mergeUsage(usageAcc, outcome.usage || null);
      return {
        result: outcome.result,
        usage: usageAcc,
        provider: String(outcome.provider || toolSpec.server || ''),
        attempts,
      };
    } catch (error) {
      lastError = error;
      if (isBudgetExceededError(error)) throw error;
      const detail = String((error as Error)?.message || error);
      errors.push(`${label}: ${detail}`);
      const more = i < chain.length - 1;
      if (!more) break;
      // Resolve / not-connected: advance so a configured fallback can try.
      if (/no tool resolved|not connected|tool_not_connected|temporarily|unavailable/i.test(detail)) {
        continue;
      }
      // Only retryable provider failures advance the waterfall.
      if (isRetryableToolError(error)) continue;
      // Permanent error → fail closed immediately (do not invent via another tool).
      break;
    }
  }

  const summary = errors.length > 0
    ? errors.join(' | ')
    : String((lastError as Error)?.message || lastError || 'all tools failed');
  throw new Error(
    `tool_call:${stepId}: provider waterfall exhausted after [${attempts.join(' → ')}]: ${summary}`,
  );
};
