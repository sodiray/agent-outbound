import { z } from 'zod';
import { AGENT_CONSTRAINTS } from './constraints.js';
import { runClaude } from '../lib/claude.js';
import { parseModelJsonObject, zBooleanish, zStringish } from '../lib/model-json.js';

const ConditionResultSchema = z.object({
  passed: zBooleanish,
  rationale: zStringish.default(''),
});

const normalize = (value) =>
  String(value || '')
    .toLowerCase()
    .trim();

const toNumber = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const detectColumnToken = (conditionText, keys) => {
  const normalized = normalize(conditionText);
  for (const key of keys) {
    if (normalized.includes(normalize(key))) return key;
  }
  return null;
};

const hasAnyNonEmptyValue = (values) =>
  Object.values(values || {}).some((value) => String(value ?? '').trim().length > 0);

const isEmailLike = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

const hasAnyEmailValue = (values) =>
  Object.entries(values || {}).some(([key, value]) => {
    const valueText = String(value ?? '').trim();
    if (!valueText) return false;
    if (isEmailLike(valueText)) return true;
    return false;
  });

const evaluateDeterministic = ({ conditionText, data }) => {
  const condition = normalize(conditionText);
  const keys = Object.keys(data || {});
  if (keys.length === 0) return null;
  const mentions = {
    email: condition.includes('email'),
    website: condition.includes('website'),
    phone: condition.includes('phone'),
  };

  // "has no X" / "no X found" / "missing X" — check if all data values are empty
  const negationPattern = /\bno\b.*\b(email|phone|website|address|contact)\b/;
  if (condition.includes('has no ') || negationPattern.test(condition)
    || condition.includes('missing') || (condition.includes('without') && !condition.includes('without a'))) {
    return !hasAnyNonEmptyValue(data);
  }

  // "has X" / "has a X" / "has an X" — check if any data value is non-empty
  if (/^has (a |an )?/.test(condition) && !negationPattern.test(condition) && !condition.includes('at least')) {
    return hasAnyNonEmptyValue(data);
  }

  // "X was written" / "X was completed" / "X was produced" / "X was generated"
  if (condition.includes('was written') || condition.includes('was completed')
    || condition.includes('was produced') || condition.includes('was generated')
    || condition.includes('was successfully')) {
    return hasAnyNonEmptyValue(data);
  }

  if (condition.includes('at least one') && mentions.email) {
    return hasAnyEmailValue(data);
  }
  if (mentions.email && (condition.includes('found') || condition.includes('present') || condition.includes('exists'))) {
    return hasAnyEmailValue(data);
  }
  if (condition.includes('email') && condition.includes('not empty')) {
    return hasAnyEmailValue(data);
  }
  if (condition.includes('at least one') && condition.includes('found')) {
    return hasAnyNonEmptyValue(data);
  }

  if (condition.includes('not empty') || condition.includes('non empty')) {
    const key = detectColumnToken(conditionText, keys);
    if (!key) {
      if (mentions.email) return hasAnyEmailValue(data);
      if (mentions.website) return Object.entries(data).some(([k, v]) =>
        normalize(k).includes('website') && String(v ?? '').trim().length > 0
      );
      if (mentions.phone) return Object.entries(data).some(([k, v]) =>
        normalize(k).includes('phone') && String(v ?? '').trim().length > 0
      );
      return false;
    }
    return String(data[key] ?? '').trim().length > 0;
  }
  if (condition.includes('is empty')) {
    const key = detectColumnToken(conditionText, keys);
    if (!key) return true;
    return String(data[key] ?? '').trim().length === 0;
  }

  const numericMatch = condition.match(/(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)/);
  if (!numericMatch) return null;

  const key = detectColumnToken(conditionText, keys);
  if (!key) return null;
  const value = toNumber(data[key]);
  const target = Number(numericMatch[2]);
  if (!Number.isFinite(value)) return null;

  const op = numericMatch[1];
  if (op === '>=') return value >= target;
  if (op === '<=') return value <= target;
  if (op === '>') return value > target;
  if (op === '<') return value < target;
  return value === target;
};

/**
 * LLM boundary action: evaluate pass/fail conditions.
 */
export const evaluateCondition = async ({
  conditionText,
  row,
  stepOutput,
  model = 'haiku',
  timeout,
}) => {
  const rowData = row && typeof row === 'object' ? row : {};
  const stepData = stepOutput && typeof stepOutput === 'object' ? stepOutput : {};
  const data = {
    ...rowData,
    ...stepData,
  };

  const deterministic = evaluateDeterministic({ conditionText, data });
  if (typeof deterministic === 'boolean') {
    return {
      passed: deterministic,
      mode: 'deterministic',
      rationale: 'deterministic rule match',
    };
  }

  const prompt = [
    'You are the outbound evaluate-condition action.',
    'Evaluate whether the condition passes for the provided data.',
    'Use strict gating semantics: if the condition says something was found/present, pass only when the relevant value is actually non-empty.',
    'A successful step execution does NOT imply the condition passed. Evaluate using values, not status.',
    'If the condition requires a value to be found/present/non-empty and the relevant column in the data is empty or missing, return passed=false regardless of any reason or explanation text in other fields.',
    'The condition is a FACTUAL QUESTION about the data, not a label or description. Evaluate whether the condition is TRUE for the given data values. For example: "has no email address" means "is the email field empty?" — if the data shows an email value, return passed=false.',
    '',
    `Condition: ${String(conditionText || '')}`,
    '',
    'Row Data JSON:',
    JSON.stringify(rowData, null, 2),
    '',
    'Step Output JSON:',
    JSON.stringify(stepData, null, 2),
    '',
    'Merged Data JSON:',
    JSON.stringify(data, null, 2),
    AGENT_CONSTRAINTS,
    '',
    'Return ONLY JSON:',
    '{',
    '  "passed": true|false,',
    '  "rationale": "short reason"',
    '}',
  ].join('\n');

  const { output, exitCode, stderr } = await runClaude(prompt, { model, timeout });
  if (exitCode !== 0) {
    throw new Error(`evaluate-condition failed: exit ${exitCode}. ${String(stderr || '').slice(0, 300)}`);
  }

  const parsed = parseModelJsonObject({
    output,
    schema: ConditionResultSchema,
    label: 'evaluate-condition result',
  });

  return {
    passed: Boolean(parsed.passed),
    mode: 'llm',
    rationale: String(parsed.rationale || ''),
  };
};
