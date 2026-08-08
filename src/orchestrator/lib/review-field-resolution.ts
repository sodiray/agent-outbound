export type ReviewFieldValues = Record<string, unknown>;

export type ReviewFieldResolution = {
  source: 'produced' | 'record' | 'config';
  value: unknown;
} | null;

const hasOwn = (value: ReviewFieldValues, field: string): boolean => (
  Object.prototype.hasOwnProperty.call(value, field)
);

export const hasResolvableReviewFieldValue = (value: unknown): boolean => (
  value !== undefined
  && value !== null
  && (typeof value !== 'string' || value.trim() !== '')
  && (!Array.isArray(value) || value.length > 0)
);

const sourceValue = ({
  field,
  source,
  values,
}: {
  field: string;
  source: NonNullable<ReviewFieldResolution>['source'];
  values: ReviewFieldValues;
}): ReviewFieldResolution => {
  if (!hasOwn(values, field) || !hasResolvableReviewFieldValue(values[field])) return null;
  return { source, value: values[field] };
};

/**
 * One ordered source policy for both config validation and runtime review rendering.
 * A per-record produced value supersedes a record value, which supersedes a static fallback.
 */
export const resolveReviewField = ({
  field,
  producedValues = {},
  recordValues = {},
  stepConfig = {},
}: {
  field: string;
  producedValues?: ReviewFieldValues;
  recordValues?: ReviewFieldValues;
  stepConfig?: ReviewFieldValues;
}): ReviewFieldResolution => (
  sourceValue({ field, source: 'produced', values: producedValues })
  || sourceValue({ field, source: 'record', values: recordValues })
  || sourceValue({ field, source: 'config', values: stepConfig })
);

const markerValues = (fields: Iterable<string>, field: string): ReviewFieldValues => (
  new Set(fields).has(field) ? { [field]: true } : {}
);

export const isReviewFieldAvailable = ({
  field,
  producedFields = [],
  recordFields = [],
  stepConfig = {},
}: {
  field: string;
  producedFields?: Iterable<string>;
  recordFields?: Iterable<string>;
  stepConfig?: ReviewFieldValues;
}): boolean => Boolean(resolveReviewField({
  field,
  producedValues: markerValues(producedFields, field),
  recordValues: markerValues(recordFields, field),
  stepConfig,
}));
