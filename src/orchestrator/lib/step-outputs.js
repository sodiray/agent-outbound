import { ensureColumns } from './csv.js';

export const applyStepOutputs = ({ row, stepConfig, stepOutputs, headers }) => {
  const columns = stepConfig?.columns && typeof stepConfig.columns === 'object'
    ? stepConfig.columns
    : {};

  let nextHeaders = headers;

  if (Object.keys(columns).length > 0) {
    nextHeaders = ensureColumns(nextHeaders, Object.values(columns).map((column) => String(column)));
    for (const [outputKey, columnName] of Object.entries(columns)) {
      row[String(columnName)] = String(stepOutputs?.[outputKey] ?? '');
    }
    return nextHeaders;
  }

  const outputKeys = Object.keys(stepOutputs || {});
  nextHeaders = ensureColumns(nextHeaders, outputKeys);
  for (const key of outputKeys) {
    row[key] = String(stepOutputs[key] ?? '');
  }
  return nextHeaders;
};
