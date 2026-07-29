import { AsyncLocalStorage } from 'node:async_hooks';

export type ProviderToolCost = {
  provider: string;
  slug: string;
  usd_cost: number;
  payload?: Record<string, unknown>;
};

export type ProviderToolUsage = {
  usd_cost: number;
  tool_calls: string[];
  tool_costs: ProviderToolCost[];
  provider: string;
};

const usageStorage = new AsyncLocalStorage<ProviderToolCost[]>();
const usageErrorKey = Symbol('providerToolUsage');

type ErrorWithProviderToolUsage = Error & {
  [usageErrorKey]?: ProviderToolUsage;
};

const usageFromEntries = (entries: ProviderToolCost[]): ProviderToolUsage | null => {
  if (entries.length === 0) return null;
  const providers = [...new Set(entries.map((entry) => entry.provider).filter(Boolean))];
  return {
    usd_cost: Number(entries.reduce((sum, entry) => sum + entry.usd_cost, 0).toFixed(8)),
    tool_calls: entries.map((entry) => entry.slug).filter(Boolean),
    tool_costs: entries,
    provider: providers.length === 1 ? providers[0] : 'multiple',
  };
};

export const recordProviderToolCost = (entry: ProviderToolCost) => {
  const active = usageStorage.getStore();
  if (!active) return;
  const usdCost = Number(entry.usd_cost);
  active.push({
    ...entry,
    provider: String(entry.provider || ''),
    slug: String(entry.slug || ''),
    usd_cost: Number.isFinite(usdCost) ? usdCost : 0,
  });
};

export const collectProviderToolUsage = async <Result>(task: () => Promise<Result>) => {
  const parent = usageStorage.getStore();
  const entries: ProviderToolCost[] = [];
  const outcome = await usageStorage.run(entries, async () => {
    try {
      return { ok: true as const, result: await task() };
    } catch (error) {
      return { ok: false as const, error };
    }
  });
  if (parent) parent.push(...entries);
  const usage = usageFromEntries(entries);
  if (outcome.ok) return { result: outcome.result, usage };
  const error = outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
  if (usage) (error as ErrorWithProviderToolUsage)[usageErrorKey] = usage;
  throw error;
};

export const providerToolUsageFromError = (error: unknown) => (
  error instanceof Error
    ? (error as ErrorWithProviderToolUsage)[usageErrorKey] || null
    : null
);

export const attachProviderToolUsage = (error: Error, usage: ProviderToolUsage | null) => {
  if (usage) (error as ErrorWithProviderToolUsage)[usageErrorKey] = usage;
  return error;
};
