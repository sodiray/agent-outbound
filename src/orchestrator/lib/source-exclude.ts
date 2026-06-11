import { evaluateFieldCheckGroup } from './conditions.js';

export type SourceExcludeRule = {
  description?: string;
  match?: string;
  conditions?: any[];
};

export const normalizeExcludeRules = (rules: unknown): SourceExcludeRule[] => (
  Array.isArray(rules) ? rules : []
)
  .map((rule: any, index: number) => ({
    description: String(rule?.description || '').trim() || `exclude_rule_${index + 1}`,
    match: rule?.match === 'any' ? 'any' : 'all',
    conditions: Array.isArray(rule?.conditions) ? rule.conditions : [],
  }))
  .filter((rule) => rule.conditions.length > 0);

// First exclusion rule the row matches, or null. Deterministic only — this
// layer never calls a model, so it can run on every sourced row for free.
export const matchExcludeRule = ({ row, rules }: { row: any; rules: SourceExcludeRule[] }) => {
  for (const rule of rules) {
    const outcome = evaluateFieldCheckGroup({
      row,
      conditions: rule.conditions || [],
      match: rule.match || 'all',
    });
    if (outcome.passed) return rule;
  }
  return null;
};
