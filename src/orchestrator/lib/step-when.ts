import { evaluateFieldCheckGroup } from './conditions.js';

type StepLike = Record<string, unknown>;

type WhenOutcome = {
  passed: boolean;
  reason: string;
};

const asRecord = (value: unknown): StepLike => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as StepLike
    : {}
);

export const stepConfigForWhen = (step: unknown): StepLike => {
  const record = asRecord(step);
  return { ...record, ...asRecord(record.config) };
};

export const whenPredicateForStep = ({ step, stepConfig }: {
  step: unknown;
  stepConfig: unknown;
}): StepLike | null => {
  const configured = asRecord(stepConfig);
  if (Object.keys(asRecord(configured.when)).length > 0) return asRecord(configured.when);
  const direct = asRecord(step);
  return Object.keys(asRecord(direct.when)).length > 0 ? asRecord(direct.when) : null;
};

export const shouldRunForRecord = ({
  record,
  predicate,
  listDir = '',
}: {
  record: Record<string, unknown>;
  predicate: StepLike | null;
  listDir?: string;
}): WhenOutcome => {
  if (!predicate) return { passed: true, reason: '' };
  return evaluateFieldCheckGroup({
    row: record,
    conditions: Array.isArray(predicate.conditions) ? predicate.conditions : [],
    match: String(predicate.match || 'all'),
    listDir,
  });
};

export const skippedWhenOutcome = (outcome: WhenOutcome): WhenOutcome => ({
  passed: true,
  reason: `skipped:${String(outcome.reason || 'when_not_matched')}`,
});

export const isSkippedWhenOutcome = (outcome: { reason?: unknown }): boolean => (
  /^skipped:/i.test(String(outcome.reason || ''))
);
