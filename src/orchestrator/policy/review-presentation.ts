export type ReviewPresentationSpec = {
  purpose: string;
  present: Array<{
    field: string;
    label: string;
  }>;
  require_non_empty: string[];
};

export type ResolvedReviewPresentation = {
  purpose: string;
  present: Array<{
    field: string;
    label: string;
    value: unknown;
  }>;
  require_non_empty: string[];
};

const text = (value: unknown) => String(value ?? '').trim();

const record = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const strings = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map((entry) => text(entry)).filter(Boolean)
    : []
);

export const reviewPresentationForStep = (step: unknown): ReviewPresentationSpec | null => {
  const configured = record(record(step).review);
  if (Object.keys(configured).length === 0) return null;
  const present = Array.isArray(configured.present)
    ? configured.present.flatMap((entry) => {
      const field = text(record(entry).field);
      if (!field) return [];
      return [{ field, label: text(record(entry).label) || field }];
    })
    : [];
  return {
    purpose: text(configured.purpose),
    present,
    require_non_empty: strings(configured.require_non_empty),
  };
};

/** Pipeline outputs are materialized on the record, as they are for args_map. */
export const resolveReviewPresentation = ({
  step,
  record: source,
}: {
  step: unknown;
  record: Record<string, unknown>;
}): ResolvedReviewPresentation | null => {
  const configured = reviewPresentationForStep(step);
  if (!configured) return null;
  return {
    ...configured,
    present: configured.present.map((entry) => ({
      ...entry,
      value: source[entry.field],
    })),
  };
};

export const isEmptyReviewValue = (value: unknown): boolean => (
  value === undefined
  || value === null
  || (typeof value === 'string' && value.trim() === '')
  || (Array.isArray(value) && value.length === 0)
);

export const missingRequiredReviewFields = (
  presentation: ResolvedReviewPresentation | null | undefined,
): string[] => {
  if (!presentation) return [];
  return presentation.require_non_empty.filter((field) => {
    const entry = presentation.present.find((candidate) => candidate.field === field);
    return isEmptyReviewValue(entry?.value);
  });
};
