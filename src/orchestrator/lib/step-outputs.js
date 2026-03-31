import { ensureColumns } from './csv.js';

export const applyStepOutputs = ({ row, stepConfig, stepOutputs, headers }) => {
  const columns = stepConfig?.columns && typeof stepConfig.columns === 'object'
    ? stepConfig.columns
    : {};

  let nextHeaders = headers;

  // If step declares output columns, ONLY write those — drop anything extra
  if (Object.keys(columns).length > 0) {
    nextHeaders = ensureColumns(nextHeaders, Object.values(columns).map((column) => String(column)));
    for (const [outputKey, columnName] of Object.entries(columns)) {
      row[String(columnName)] = String(stepOutputs?.[outputKey] ?? '');
    }
    return nextHeaders;
  }

  // Fallback for steps without declared columns (e.g. sourcing search):
  // Write all output keys, but this path should be rare
  const outputKeys = Object.keys(stepOutputs || {});
  nextHeaders = ensureColumns(nextHeaders, outputKeys);
  for (const key of outputKeys) {
    row[key] = String(stepOutputs[key] ?? '');
  }
  return nextHeaders;
};
