import { stableHash } from '../lib/record.js';
import { resolveFieldCheckConditions } from '../lib/field-check-values.js';

type AssignmentRule = Record<string, unknown>;

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const stringArray = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
    : []
);

const assignmentRules = (step: Record<string, unknown>): AssignmentRule[] => (
  Array.isArray(step.rules) ? step.rules.map(asRecord) : []
);

const ruleInputFields = (rule: AssignmentRule): string[] => {
  const conditions = Array.isArray(rule.conditions) ? rule.conditions.map(asRecord) : [];
  return [
    ...stringArray(rule.inputs),
    ...conditions.map((condition) => String(condition.field || '').trim()).filter(Boolean),
  ];
};

export const assignmentInputFields = (step: Record<string, unknown>): string[] => (
  [...new Set(assignmentRules(step).flatMap(ruleInputFields))]
);

const materialRule = ({ rule, listDir }: { rule: AssignmentRule; listDir: string }): Record<string, unknown> => {
  const conditions = Array.isArray(rule.conditions)
    ? resolveFieldCheckConditions({ conditions: rule.conditions, listDir })
    : [];
  return {
    id: String(rule.id || ''),
    sequence: String(rule.sequence || ''),
    pipeline: String(rule.pipeline || ''),
    type: String(rule.type || 'field_check'),
    match: String(rule.match || 'all'),
    conditions,
    description: String(rule.description || ''),
    condition: String(rule.condition || ''),
    model: rule.model,
    inputs: stringArray(rule.inputs),
    reasoning: Boolean(rule.reasoning),
  };
};

const materialAssignmentConfig = ({ step, listDir }: { step: Record<string, unknown>; listDir: string }) => ({
  target: String(step.target || 'sequence_name'),
  fallback: String(step.fallback || ''),
  depends_on: stringArray(step.depends_on),
  runs_after: stringArray(step.runs_after),
  rules: assignmentRules(step).map((rule) => materialRule({ rule, listDir })),
});

export const assignmentDepHash = ({
  step,
  record,
  listDir = '',
}: {
  step: Record<string, unknown>;
  record: Record<string, unknown>;
  listDir?: string;
}): string => {
  const inputs = Object.fromEntries(assignmentInputFields(step).map((field) => [field, record[field]]));
  return stableHash({ config: materialAssignmentConfig({ step, listDir }), inputs });
};

export const assignmentStalenessStepId = (stepId: string): string => `assign:${stepId}`;

export const isAssignmentFresh = ({
  cached,
  step,
  record,
  listDir = '',
  force = false,
}: {
  cached: { dep_hash?: unknown } | undefined;
  step: Record<string, unknown>;
  record: Record<string, unknown>;
  listDir?: string;
  force?: boolean;
}): boolean => (
  !force
  && Boolean(cached)
  && String(cached?.dep_hash || '') === assignmentDepHash({ step, record, listDir })
);
