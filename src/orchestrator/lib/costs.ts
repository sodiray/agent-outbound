import { randomUUID } from 'node:crypto';
import { insertCostEvent, logCostEventFile } from '../runtime/db.js';
import { readConfig } from './config.js';
import { AgentOutboundError } from '../runtime/contract.js';

const windowStartAndReset = (window: 'daily' | 'weekly' | 'monthly') => {
  const now = new Date();
  const start = new Date(now);
  const reset = new Date(now);
  if (window === 'daily') {
    start.setUTCHours(0, 0, 0, 0);
    reset.setUTCDate(reset.getUTCDate() + 1);
    reset.setUTCHours(0, 0, 0, 0);
    return { start: start.toISOString(), reset: reset.toISOString() };
  }
  if (window === 'weekly') {
    const day = start.getUTCDay();
    const diff = day === 0 ? 6 : day - 1;
    start.setUTCDate(start.getUTCDate() - diff);
    start.setUTCHours(0, 0, 0, 0);
    reset.setTime(start.getTime());
    reset.setUTCDate(start.getUTCDate() + 7);
    return { start: start.toISOString(), reset: reset.toISOString() };
  }
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  reset.setUTCMonth(start.getUTCMonth() + 1, 1);
  reset.setUTCHours(0, 0, 0, 0);
  return { start: start.toISOString(), reset: reset.toISOString() };
};

const sumUsdSince = ({ db, since, stepMatcher = '' }: { db: any; since: string; stepMatcher?: string }) => {
  if (!stepMatcher) {
    const row = db.prepare(`
      SELECT SUM(usd_cost) AS usd
      FROM cost_events
      WHERE occurred_at >= ?
        AND usd_cost IS NOT NULL
    `).get(since);
    return Number(row?.usd || 0);
  }
  const row = db.prepare(`
    SELECT SUM(usd_cost) AS usd
    FROM cost_events
    WHERE occurred_at >= ?
      AND (step_id = ? OR step_id LIKE ?)
      AND usd_cost IS NOT NULL
  `).get(since, stepMatcher, `%${stepMatcher}%`);
  return Number(row?.usd || 0);
};

const sumTokensSince = ({ db, since, stepMatcher = '' }: { db: any; since: string; stepMatcher?: string }) => {
  if (!stepMatcher) {
    const row = db.prepare(`
      SELECT SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) AS tokens
      FROM cost_events
      WHERE occurred_at >= ?
    `).get(since);
    return Number(row?.tokens || 0);
  }
  const row = db.prepare(`
    SELECT SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) AS tokens
    FROM cost_events
    WHERE occurred_at >= ?
      AND (step_id = ? OR step_id LIKE ?)
  `).get(since, stepMatcher, `%${stepMatcher}%`);
  return Number(row?.tokens || 0);
};

const countToolSince = ({ db, since, key }: { db: any; since: string; key: string }) => {
  const upperKey = String(key || '').toUpperCase();
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM cost_events ce
    JOIN json_each(CASE WHEN json_valid(ce.tool_calls) THEN ce.tool_calls ELSE '[]' END) j
    WHERE ce.occurred_at >= ?
      AND (
        UPPER(CAST(j.value AS TEXT)) = ?
        OR UPPER(CAST(j.value AS TEXT)) LIKE ?
      )
  `).get(since, upperKey, `${upperKey}.%`);
  return Number(row?.n || 0);
};

const enforceLlmBudgets = ({
  db,
  listDir,
  stepId,
  tokenCost,
  usdCost,
}: {
  db: any;
  listDir: string;
  stepId: string;
  tokenCost: number;
  usdCost: number | null;
}) => {
  const { config } = readConfig(listDir);
  const llm = config?.budgets?.llm || {};
  const tokenChecks: Array<{ budget: string; cap: number; window: 'daily' | 'weekly' | 'monthly'; scope: 'list' | 'step'; step?: string }> = [];
  const checks: Array<{ budget: string; cap: number; window: 'daily' | 'weekly' | 'monthly'; scope: 'list' | 'step'; step?: string }> = [];
  if (Number.isFinite(Number(llm?.list_daily_tokens))) tokenChecks.push({ budget: 'llm.list_daily_tokens', cap: Number(llm.list_daily_tokens), window: 'daily', scope: 'list' });
  if (Number.isFinite(Number(llm?.list_weekly_tokens))) tokenChecks.push({ budget: 'llm.list_weekly_tokens', cap: Number(llm.list_weekly_tokens), window: 'weekly', scope: 'list' });
  if (Number.isFinite(Number(llm?.list_monthly_tokens))) tokenChecks.push({ budget: 'llm.list_monthly_tokens', cap: Number(llm.list_monthly_tokens), window: 'monthly', scope: 'list' });
  if (Number.isFinite(Number(llm?.list_daily_usd))) checks.push({ budget: 'llm.list_daily_usd', cap: Number(llm.list_daily_usd), window: 'daily', scope: 'list' });
  if (Number.isFinite(Number(llm?.list_weekly_usd))) checks.push({ budget: 'llm.list_weekly_usd', cap: Number(llm.list_weekly_usd), window: 'weekly', scope: 'list' });
  if (Number.isFinite(Number(llm?.list_monthly_usd))) checks.push({ budget: 'llm.list_monthly_usd', cap: Number(llm.list_monthly_usd), window: 'monthly', scope: 'list' });

  const stepDailyTokens = llm?.step_daily_tokens && typeof llm.step_daily_tokens === 'object' ? llm.step_daily_tokens : {};
  const stepWeeklyTokens = llm?.step_weekly_tokens && typeof llm.step_weekly_tokens === 'object' ? llm.step_weekly_tokens : {};
  const stepMonthlyTokens = llm?.step_monthly_tokens && typeof llm.step_monthly_tokens === 'object' ? llm.step_monthly_tokens : {};
  const stepDaily = llm?.step_daily_usd && typeof llm.step_daily_usd === 'object' ? llm.step_daily_usd : {};
  const stepWeekly = llm?.step_weekly_usd && typeof llm.step_weekly_usd === 'object' ? llm.step_weekly_usd : {};
  const stepMonthly = llm?.step_monthly_usd && typeof llm.step_monthly_usd === 'object' ? llm.step_monthly_usd : {};
  for (const [step, cap] of Object.entries(stepDailyTokens)) tokenChecks.push({ budget: `llm.step_daily_tokens.${step}`, cap: Number(cap || 0), window: 'daily', scope: 'step', step });
  for (const [step, cap] of Object.entries(stepWeeklyTokens)) tokenChecks.push({ budget: `llm.step_weekly_tokens.${step}`, cap: Number(cap || 0), window: 'weekly', scope: 'step', step });
  for (const [step, cap] of Object.entries(stepMonthlyTokens)) tokenChecks.push({ budget: `llm.step_monthly_tokens.${step}`, cap: Number(cap || 0), window: 'monthly', scope: 'step', step });
  for (const [step, cap] of Object.entries(stepDaily)) checks.push({ budget: `llm.step_daily_usd.${step}`, cap: Number(cap || 0), window: 'daily', scope: 'step', step });
  for (const [step, cap] of Object.entries(stepWeekly)) checks.push({ budget: `llm.step_weekly_usd.${step}`, cap: Number(cap || 0), window: 'weekly', scope: 'step', step });
  for (const [step, cap] of Object.entries(stepMonthly)) checks.push({ budget: `llm.step_monthly_usd.${step}`, cap: Number(cap || 0), window: 'monthly', scope: 'step', step });

  for (const check of tokenChecks) {
    const { start, reset } = windowStartAndReset(check.window);
    const used = sumTokensSince({
      db,
      since: start,
      stepMatcher: check.scope === 'step' ? String(check.step || '') : '',
    });
    const projected = used + Number(tokenCost || 0);
    if (projected > Number(check.cap || 0)) {
      throw new AgentOutboundError({
        code: 'BUDGET_EXCEEDED',
        message: `LLM token budget exceeded for ${check.budget}: ${projected} > ${Number(check.cap || 0)} (${check.window}).`,
        retryable: false,
        hint: 'Raise token cap in config budgets or wait for window reset.',
        fields: {
          budget: check.budget,
          used_tokens: used,
          projected_tokens: projected,
          cap_tokens: Number(check.cap || 0),
          window: check.window,
          resets_at: reset,
          step_id: stepId,
        },
      });
    }
  }

  for (const check of checks) {
    const { start, reset } = windowStartAndReset(check.window);
    const used = sumUsdSince({
      db,
      since: start,
      stepMatcher: check.scope === 'step' ? String(check.step || '') : '',
    });
    const projected = used + (usdCost == null ? 0 : Number(usdCost || 0));
    if (projected > Number(check.cap || 0)) {
      throw new AgentOutboundError({
        code: 'BUDGET_EXCEEDED',
        message: `LLM budget exceeded for ${check.budget}: $${projected.toFixed(2)} > $${Number(check.cap || 0).toFixed(2)} (${check.window}).`,
        retryable: false,
        hint: 'Raise the cap in config budgets or wait for window reset.',
        fields: {
          budget: check.budget,
          used_usd: Number(used.toFixed(6)),
          projected_usd: Number(projected.toFixed(6)),
          cap_usd: Number(check.cap || 0),
          window: check.window,
          resets_at: reset,
          step_id: stepId,
        },
      });
    }
  }
};

const enforceToolBudgets = ({ db, listDir, toolCalls }: { db: any; listDir: string; toolCalls: string[] }) => {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return;
  const { config } = readConfig(listDir);
  const toolsBudget = config?.budgets?.tools && typeof config.budgets.tools === 'object' ? config.budgets.tools : {};
  const currentCounts = new Map<string, number>();
  for (const call of toolCalls.map((item) => String(item || '').toUpperCase())) {
    currentCounts.set(call, Number(currentCounts.get(call) || 0) + 1);
  }
  for (const [key, ruleAny] of Object.entries(toolsBudget)) {
    const rule = ruleAny && typeof ruleAny === 'object' ? ruleAny as any : {};
    const requested = [...currentCounts.entries()]
      .filter(([slug]) => slug === String(key || '').toUpperCase() || slug.startsWith(`${String(key || '').toUpperCase()}.`))
      .reduce((sum, [, count]) => sum + Number(count || 0), 0);
    if (requested <= 0) continue;
    for (const [window, capRaw] of Object.entries({ daily: rule.daily, weekly: rule.weekly, monthly: rule.monthly })) {
      const cap = Number(capRaw || 0);
      if (!Number.isFinite(cap) || cap <= 0) continue;
      const normalizedWindow = window as 'daily' | 'weekly' | 'monthly';
      const { start, reset } = windowStartAndReset(normalizedWindow);
      const used = countToolSince({ db, since: start, key });
      const projected = used + requested;
      if (projected > cap) {
        throw new AgentOutboundError({
          code: 'BUDGET_EXCEEDED',
          message: `Tool budget exceeded for ${key} (${window}): ${projected} > ${cap}.`,
          retryable: false,
          hint: 'Raise tool invocation caps or wait for window reset.',
          fields: {
            budget: `tools.${key}.${window}`,
            used_calls: used,
            projected_calls: projected,
            cap_calls: cap,
            window,
            resets_at: reset,
            tool: key,
          },
        });
      }
    }
  }
};

export const recordCostEvent = ({ db, listDir, recordId = '', stepId, model = '', usage = null, provider = 'anthropic' }) => {
  if (!usage) return;
  const inputTokens = Number(usage?.input_tokens || 0);
  const outputTokens = Number(usage?.output_tokens || 0);
  const cacheCreationTokens = Number(usage?.cache_creation_tokens || 0);
  const cacheReadTokens = Number(usage?.cache_read_tokens || 0);
  const tokenCost = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
  const usdRaw = usage?.usd_cost;
  const usdCost = usdRaw === null || usdRaw === undefined
    ? null
    : (Number.isFinite(Number(usdRaw)) ? Number(usdRaw) : null);
  const toolCalls = Array.isArray(usage?.tool_calls) ? usage.tool_calls : [];
  enforceLlmBudgets({
    db,
    listDir,
    stepId: String(stepId || 'unknown_step'),
    tokenCost,
    usdCost,
  });
  enforceToolBudgets({
    db,
    listDir,
    toolCalls: toolCalls.map((item: any) => String(item || '')),
  });

  const event = {
    id: randomUUID(),
    record_id: recordId,
    step_id: String(stepId || 'unknown_step'),
    model: String(model || ''),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_tokens: cacheCreationTokens,
    cache_read_tokens: cacheReadTokens,
    tool_calls: Array.isArray(usage?.tool_calls) ? usage.tool_calls : [],
    usd_cost: usdCost,
    provider: String((usage as any)?.provider || provider || ''),
    payload: usage,
    occurred_at: new Date().toISOString(),
  };

  insertCostEvent({ db, event });
  logCostEventFile({ listDir, payload: event });
};
