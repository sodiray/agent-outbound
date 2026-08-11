const hasDisplayValue = (value: unknown) => (
  value !== null
  && value !== undefined
  && (typeof value !== 'string' || value.trim() !== '')
);

const displayText = (value: unknown) => {
  if (!hasDisplayValue(value)) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value).trim();
};

export const reviewLabelFor = (key: string) => key
  .replace(/^_+/, '')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .split(/[_\s-]+/)
  .filter(Boolean)
  .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
  .join(' ') || key;

export const reviewRecordName = ({
  record,
  titleField,
}: {
  record: Record<string, unknown>;
  titleField?: string;
}) => {
  const title = titleField ? displayText(record[titleField]) : '';
  if (title) return title;
  const id = displayText(record._row_id);
  return id ? `Record ${id}` : 'Unnamed record';
};

export const reviewIdentityAddsInformation = ({
  record,
  titleField,
  visibleFields,
}: {
  record: Record<string, unknown>;
  titleField?: string;
  visibleFields: string[];
}) => (
  !titleField
  || !visibleFields.includes(titleField)
  || !hasDisplayValue(record[titleField])
);

export const shouldShowReviewIdentityColumn = ({
  isAllStages,
  records,
  titleFieldForRecord,
  visibleFields,
}: {
  isAllStages: boolean;
  records: Array<Record<string, unknown>>;
  titleFieldForRecord: (record: Record<string, unknown>) => string | undefined;
  visibleFields: string[];
}) => isAllStages && records.some((record) => reviewIdentityAddsInformation({
  record,
  titleField: titleFieldForRecord(record),
  visibleFields,
}));
