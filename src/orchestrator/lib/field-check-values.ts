import { readFileSync } from 'node:fs';
import { resolveListPath } from '../runtime/paths.js';
import { flattenPipelineSteps } from './subpipelines.js';

type FieldCheckCondition = Record<string, unknown>;

export type FieldCheckValueFile = {
  config_path: string;
  value_file: string;
  resolved_path: string;
  entry_count: number | null;
  error: string;
};

const resolvedConditionCache = new WeakMap<object, Map<string, FieldCheckCondition>>();

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

const parseValueFile = (path: string) => readFileSync(path, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

const valueFileError = ({ path, error }: { path: string; error: unknown }) => (
  `field_check value_file is missing or unreadable: ${path}: ${String((error as Error)?.message || error)}`
);

export const loadFieldCheckValueFile = ({
  listDir,
  valueFile,
}: {
  listDir: string;
  valueFile: string;
}) => {
  const path = resolveListPath({ listDir, filePath: valueFile, allowRelative: true });
  try {
    return {
      path,
      values: parseValueFile(path),
    };
  } catch (error) {
    throw new Error(valueFileError({ path, error }));
  }
};

const resolveCondition = ({
  condition,
  listDir,
}: {
  condition: FieldCheckCondition;
  listDir: string;
}) => {
  const valueFile = String(condition.value_file || '').trim();
  if (!valueFile) return condition;
  if (hasOwn(condition, 'value') && condition.value !== undefined) {
    throw new Error('field_check condition cannot specify both value and value_file.');
  }

  const operator = String(condition.operator || '').trim();
  if (operator !== 'in' && operator !== 'not_in') {
    throw new Error(`field_check value_file requires operator "in" or "not_in", received "${operator || 'missing'}".`);
  }

  const cachedByList = resolvedConditionCache.get(condition);
  const cached = cachedByList?.get(listDir);
  if (cached) return cached;

  const loaded = loadFieldCheckValueFile({ listDir, valueFile });
  const { value_file: _valueFile, ...conditionWithoutValueFile } = condition;
  const resolved = { ...conditionWithoutValueFile, value: loaded.values };
  const nextCache = cachedByList || new Map<string, FieldCheckCondition>();
  nextCache.set(listDir, resolved);
  if (!cachedByList) resolvedConditionCache.set(condition, nextCache);
  return resolved;
};

export const resolveFieldCheckConditions = ({
  conditions,
  listDir,
}: {
  conditions: unknown[];
  listDir: string;
}) => conditions.map((condition) => (
  condition && typeof condition === 'object'
    ? resolveCondition({ condition: condition as FieldCheckCondition, listDir })
    : condition
));

const conditionReferences = (config: Record<string, unknown>) => {
  const source = config.source && typeof config.source === 'object'
    ? config.source as Record<string, unknown>
    : {};
  const excludeRules = Array.isArray(source.exclude) ? source.exclude : [];
  const sourceRefs = excludeRules.flatMap((rule, ruleIndex) => {
    const record = rule && typeof rule === 'object' ? rule as Record<string, unknown> : {};
    const conditions = Array.isArray(record.conditions) ? record.conditions : [];
    return conditions.map((condition, conditionIndex) => ({
      condition,
      configPath: `source.exclude[${ruleIndex}].conditions[${conditionIndex}]`,
    }));
  });

  const pipeline = flattenPipelineSteps(config);
  const pipelineRefs = pipeline.flatMap((step, stepIndex) => {
    const record = step && typeof step === 'object' ? step as Record<string, unknown> : {};
    const stepId = String(record.id || '').trim() || String(stepIndex);
    const directConditions = Array.isArray(record.conditions) ? record.conditions : [];
    const when = record.when && typeof record.when === 'object'
      ? record.when as Record<string, unknown>
      : {};
    const whenConditions = Array.isArray(when.conditions) ? when.conditions : [];
    const rules = Array.isArray(record.rules) ? record.rules : [];
    const ruleConditions = rules.flatMap((rule, ruleIndex) => {
      const ruleRecord = rule && typeof rule === 'object' ? rule as Record<string, unknown> : {};
      const conditions = Array.isArray(ruleRecord.conditions) ? ruleRecord.conditions : [];
      return conditions.map((condition, conditionIndex) => ({
        condition,
        configPath: `pipeline.${stepId}.rules[${ruleIndex}].conditions[${conditionIndex}]`,
      }));
    });
    return [
      ...directConditions.map((condition, conditionIndex) => ({
        condition,
        configPath: `pipeline.${stepId}.conditions[${conditionIndex}]`,
      })),
      ...whenConditions.map((condition, conditionIndex) => ({
        condition,
        configPath: `pipeline.${stepId}.when.conditions[${conditionIndex}]`,
      })),
      ...ruleConditions,
    ];
  });

  return [...sourceRefs, ...pipelineRefs];
};

export const inspectFieldCheckValueFiles = ({
  config,
  listDir,
}: {
  config: Record<string, unknown>;
  listDir: string;
}): FieldCheckValueFile[] => conditionReferences(config).flatMap(({ condition, configPath }) => {
  const record = condition && typeof condition === 'object'
    ? condition as FieldCheckCondition
    : {};
  const valueFile = String(record.value_file || '').trim();
  if (!valueFile) return [];
  const resolvedPath = resolveListPath({ listDir, filePath: valueFile, allowRelative: true });
  try {
    const resolved = resolveCondition({ condition: record, listDir });
    const values = Array.isArray(resolved.value) ? resolved.value : [];
    return [{
      config_path: configPath,
      value_file: valueFile,
      resolved_path: resolvedPath,
      entry_count: values.length,
      error: '',
    }];
  } catch (error) {
    return [{
      config_path: configPath,
      value_file: valueFile,
      resolved_path: resolvedPath,
      entry_count: null,
      error: String((error as Error)?.message || error),
    }];
  }
});

export const prepareFieldCheckValueFiles = ({
  config,
  listDir,
}: {
  config: Record<string, unknown>;
  listDir: string;
}) => {
  const files = inspectFieldCheckValueFiles({ config, listDir });
  const errors = files.map((file) => file.error).filter(Boolean);
  if (errors.length > 0) throw new Error(errors.join('; '));
  return files;
};
