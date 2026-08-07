/**
 * Enrichment + execution cost ledger with configured ceilings.
 */

import {
  DEFAULT_SCORE_ENRICHMENT_BUDGET,
  type EnrichmentBudgetConfigInput,
} from '../../schemas/config.js';

export const COST_LEDGER_VERSION = 'tv-cost-ledger-v1';

export type CostEntry = {
  entry_id: string;
  kind: 'enrichment' | 'execution' | 'model' | 'tool' | 'mail' | 'other';
  amount_usd: number;
  step_id?: string;
  model?: string;
  tool?: string;
  occurred_at: string;
};

export type CostLedger = {
  account_id: string;
  entries: CostEntry[];
  total_usd: number;
  enrichment_usd: number;
  execution_usd: number;
  ledger_version: string;
  updated_at: string;
};

export function parseCostLedger(raw: unknown, accountId: string): CostLedger {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
      return {
        account_id: String(parsed.account_id || accountId),
        entries: parsed.entries,
        total_usd: Number(parsed.total_usd) || sum(parsed.entries),
        enrichment_usd: Number(parsed.enrichment_usd) || sumKind(parsed.entries, 'enrichment'),
        execution_usd: Number(parsed.execution_usd) || sumKind(parsed.entries, 'execution'),
        ledger_version: String(parsed.ledger_version || COST_LEDGER_VERSION),
        updated_at: String(parsed.updated_at || new Date().toISOString()),
      };
    }
  } catch {
    /* fall through */
  }
  return {
    account_id: accountId,
    entries: [],
    total_usd: 0,
    enrichment_usd: 0,
    execution_usd: 0,
    ledger_version: COST_LEDGER_VERSION,
    updated_at: new Date().toISOString(),
  };
}

function sum(entries: CostEntry[]): number {
  return entries.reduce((s, e) => s + (Number(e.amount_usd) || 0), 0);
}
function sumKind(entries: CostEntry[], kind: string): number {
  return entries.filter((e) => e.kind === kind).reduce((s, e) => s + (Number(e.amount_usd) || 0), 0);
}

export function appendCostEntry(ledger: CostLedger, entry: Omit<CostEntry, 'entry_id' | 'occurred_at'> & { entry_id?: string; occurred_at?: string }): CostLedger {
  const full: CostEntry = {
    entry_id: entry.entry_id || `cost_${Date.now()}`,
    kind: entry.kind,
    amount_usd: Number(entry.amount_usd) || 0,
    step_id: entry.step_id,
    model: entry.model,
    tool: entry.tool,
    occurred_at: entry.occurred_at || new Date().toISOString(),
  };
  const entries = [...ledger.entries, full];
  return {
    ...ledger,
    entries,
    total_usd: sum(entries),
    enrichment_usd: sumKind(entries, 'enrichment') + sumKind(entries, 'model') + sumKind(entries, 'tool'),
    execution_usd: sumKind(entries, 'execution') + sumKind(entries, 'mail'),
    updated_at: new Date().toISOString(),
  };
}

export function withinEnrichmentCeiling(input: {
  candidate_tier?: string;
  treatment_tier?: string;
  enrichment_usd: number;
  golden_ticket?: boolean;
  enrichmentBudget?: EnrichmentBudgetConfigInput;
}): { within_budget: boolean; ceiling: number; reason?: string } {
  const ceilings = { ...DEFAULT_SCORE_ENRICHMENT_BUDGET.ceilings, ...input.enrichmentBudget?.ceilings };
  const tier = String(input.candidate_tier || input.treatment_tier || 'foundational').toLowerCase();
  let ceiling: number = ceilings.foundational;
  if (tier === 'a' || tier === 'tier_a') ceiling = ceilings.A;
  else if (tier === 'b' || tier === 'tier_b') ceiling = ceilings.B;
  else if (tier === 'c' || tier === 'tier_c') ceiling = ceilings.C;
  else if (tier === 'd' || tier === 'tier_d') ceiling = ceilings.D;
  else if (tier === 'enrichment_hold') ceiling = ceilings.enrichment_hold;
  if (input.golden_ticket) ceiling = Math.max(ceiling, ceilings.golden_ticket_total);
  if (input.enrichment_usd > ceiling) {
    return { within_budget: false, ceiling, reason: `enrichment_cost_exceeded:${input.enrichment_usd}>${ceiling}` };
  }
  return { within_budget: true, ceiling };
}

/**
 * Map production cost_events step_id → ledger kind.
 * Enrichment ceiling counts model + tool + enrichment; execution/mail are separate.
 */
export function costEntryKindFromStep(stepId: string): CostEntry['kind'] {
  const s = String(stepId || '').toLowerCase();
  if (
    s.includes('send_email')
    || s.includes('linkedin_connect')
    || s.includes('sequence')
    || s.includes('outbound')
    || s.startsWith('channel')
  ) {
    return 'execution';
  }
  if (s.includes('mail') || s.includes('postcard') || s.includes('lob')) return 'mail';
  if (s.includes('tool') || s.includes('hunter') || s.includes('apollo') || s.includes('composio')) {
    return 'tool';
  }
  if (
    s.includes('enrich')
    || s.includes('score')
    || s.includes('source')
    || s.includes('classify')
    || s.includes('policy')
    || s.includes('brief')
    || s.includes('linkedin')
    || s.includes('decision')
  ) {
    return 'enrichment';
  }
  // Default LLM spend toward enrichment ceiling (research / content gen).
  return 'model';
}

export type CostEventRow = {
  id?: string;
  record_id?: string;
  step_id?: string;
  model?: string;
  usd_cost?: number | null;
  provider?: string;
  occurred_at?: string;
  tool_calls?: unknown;
};

/** Rebuild a CostLedger from production cost_events rows for one account. */
export function ledgerFromCostEventRows(
  accountId: string,
  rows: CostEventRow[],
): CostLedger {
  let ledger = parseCostLedger(null, accountId);
  for (const row of rows || []) {
    const amount = row.usd_cost == null ? 0 : Number(row.usd_cost) || 0;
    if (amount <= 0 && !row.id) continue;
    const toolCalls = Array.isArray(row.tool_calls)
      ? row.tool_calls
      : (typeof row.tool_calls === 'string'
        ? (() => {
          try {
            const p = JSON.parse(row.tool_calls || '[]');
            return Array.isArray(p) ? p : [];
          } catch {
            return [];
          }
        })()
        : []);
    const kind = toolCalls.length > 0 && costEntryKindFromStep(String(row.step_id || '')) === 'model'
      ? 'tool'
      : costEntryKindFromStep(String(row.step_id || ''));
    ledger = appendCostEntry(ledger, {
      entry_id: String(row.id || `evt_${ledger.entries.length}`),
      kind,
      amount_usd: amount,
      step_id: row.step_id != null ? String(row.step_id) : undefined,
      model: row.model != null ? String(row.model) : undefined,
      tool: toolCalls.length ? String(toolCalls[0]) : undefined,
      occurred_at: row.occurred_at != null ? String(row.occurred_at) : undefined,
    });
  }
  return ledger;
}

/**
 * Resolve enrichment spend for ceilings: override (cost_events sum) >
 * ledger.enrichment_usd > record.enrichment_cost_usd.
 */
export function enrichmentSpendUsd(input: {
  ledger?: CostLedger | null;
  record?: Record<string, unknown> | null;
  overrideUsd?: number | null;
}): number {
  if (input.overrideUsd != null && Number.isFinite(Number(input.overrideUsd))) {
    return Math.max(0, Number(input.overrideUsd));
  }
  const fromLedger = Number(input.ledger?.enrichment_usd || 0);
  if (fromLedger > 0) return fromLedger;
  const scalar = input.record?.enrichment_cost_usd;
  if (scalar != null && scalar !== '' && Number.isFinite(Number(scalar))) {
    return Math.max(0, Number(scalar));
  }
  return Math.max(0, fromLedger);
}

/** Sum usd_cost for a record from the production cost_events table. */
export function sumRecordCostEventsUsd(db: any, recordId: string): {
  total_usd: number;
  enrichment_usd: number;
  rows: CostEventRow[];
} {
  const id = String(recordId || '').trim();
  if (!db || !id) {
    return { total_usd: 0, enrichment_usd: 0, rows: [] };
  }
  try {
    const rows = db.prepare(`
      SELECT id, record_id, step_id, model, usd_cost, provider, tool_calls, occurred_at
      FROM cost_events
      WHERE record_id = ?
      ORDER BY occurred_at ASC
    `).all(id) as CostEventRow[];
    const ledger = ledgerFromCostEventRows(id, rows || []);
    return {
      total_usd: ledger.total_usd,
      enrichment_usd: ledger.enrichment_usd,
      rows: rows || [],
    };
  } catch {
    return { total_usd: 0, enrichment_usd: 0, rows: [] };
  }
}

/**
 * Hydrate cost_ledger_json + enrichment_cost_usd on a record from cost_events.
 * Idempotent rebuild of the ledger from the production event log.
 */
export function hydrateRecordCostLedger(input: {
  db: any;
  recordId: string;
  record?: Record<string, unknown> | null;
}): { ledger: CostLedger; enrichment_usd: number; patch: Record<string, unknown> } {
  const recordId = String(input.recordId || '').trim();
  const summed = sumRecordCostEventsUsd(input.db, recordId);
  const existing = parseCostLedger(
    input.record?.cost_ledger_json,
    recordId || 'unknown',
  );
  // Prefer cost_events rebuild when any production events exist; else keep ledger.
  const ledger = summed.rows.length > 0
    ? ledgerFromCostEventRows(recordId || existing.account_id, summed.rows)
    : existing;
  const enrichment_usd = Math.max(
    ledger.enrichment_usd,
    summed.enrichment_usd,
    Number(input.record?.enrichment_cost_usd || 0) || 0,
  );
  const patch: Record<string, unknown> = {
    cost_ledger_json: JSON.stringify({
      ...ledger,
      enrichment_usd,
      total_usd: Math.max(ledger.total_usd, enrichment_usd),
    }),
    enrichment_cost_usd: enrichment_usd,
  };
  return { ledger: { ...ledger, enrichment_usd }, enrichment_usd, patch };
}

/** True when the record already carries a treatment or candidate tier for ceiling selection. */
export function recordHasEnrichmentTier(record?: Record<string, unknown> | null): boolean {
  const treatment = String(record?.treatment_tier || '').trim();
  const candidate = String(record?.candidate_tier || '').trim();
  return Boolean(treatment || candidate);
}

/**
 * Provider-bound enrich actions that must not run once the tier spend ceiling is hit.
 * Free local actions (policy_apply, linkedin places resolution) are excluded.
 */
export function isExpensiveEnrichProviderAction(stepConfig?: Record<string, unknown> | null): boolean {
  const action = String(stepConfig?.action || '').trim().toLowerCase();
  if (action === 'policy_apply' || action === 'linkedin_company_resolution') return false;
  // tool_call / decision_makers / default model-generate path
  return true;
}

export type EnrichmentCeilingGateResult = {
  /** Gate only applies to expensive provider actions on tiered records. */
  apply: boolean;
  within_budget: boolean;
  ceiling: number;
  enrichment_usd: number;
  /** Stable skip reason for activity / status: `enrichment_ceiling`. */
  reason?: string;
  /** Human/detail string for observations (includes spend vs ceiling). */
  detail?: string;
  /** Hydrated cost fields when cost_events were available. */
  recordPatch?: Record<string, unknown>;
};

/**
 * Pre-provider enrichment spend check.
 * Hydrates from cost_events when db is present, else ledger / enrichment_cost_usd.
 * Callers skip with reason `enrichment_ceiling` when apply && !within_budget.
 */
export function evaluateEnrichmentCeilingGate(input: {
  db?: any;
  record: Record<string, unknown>;
  stepConfig?: Record<string, unknown> | null;
  enrichmentBudget?: EnrichmentBudgetConfigInput;
}): EnrichmentCeilingGateResult {
  const record = input.record || {};
  if (!isExpensiveEnrichProviderAction(input.stepConfig)) {
    return { apply: false, within_budget: true, ceiling: Number.POSITIVE_INFINITY, enrichment_usd: 0 };
  }
  if (!recordHasEnrichmentTier(record)) {
    return { apply: false, within_budget: true, ceiling: Number.POSITIVE_INFINITY, enrichment_usd: 0 };
  }

  const rowId = String(record._row_id || record.id || '').trim();
  let working: Record<string, unknown> = record;
  let recordPatch: Record<string, unknown> | undefined;
  let enrichment_usd = enrichmentSpendUsd({ record });

  if (input.db && rowId) {
    try {
      const hydrated = hydrateRecordCostLedger({
        db: input.db,
        recordId: rowId,
        record,
      });
      enrichment_usd = hydrated.enrichment_usd;
      recordPatch = hydrated.patch;
      working = { ...record, ...hydrated.patch };
    } catch {
      enrichment_usd = enrichmentSpendUsd({ record });
    }
  } else {
    const ledger = parseCostLedger(record.cost_ledger_json, rowId || 'unknown');
    enrichment_usd = enrichmentSpendUsd({ ledger, record });
  }

  const check = withinEnrichmentCeiling({
    candidate_tier: String(working.candidate_tier || ''),
    treatment_tier: String(working.treatment_tier || ''),
    enrichment_usd,
    golden_ticket: Boolean(
      working.golden_ticket_eligible === true
      || working.golden_ticket_eligible === 1
      || String(working.golden_ticket_eligible || '').toLowerCase() === 'true',
    ),
    enrichmentBudget: input.enrichmentBudget,
  });

  if (check.within_budget) {
    return {
      apply: true,
      within_budget: true,
      ceiling: check.ceiling,
      enrichment_usd,
      recordPatch,
    };
  }

  const detail = check.reason
    || `enrichment_cost_exceeded:${enrichment_usd}>${check.ceiling}`;
  return {
    apply: true,
    within_budget: false,
    ceiling: check.ceiling,
    enrichment_usd,
    reason: 'enrichment_ceiling',
    detail: `enrichment_ceiling: ${detail}`,
    recordPatch,
  };
}
