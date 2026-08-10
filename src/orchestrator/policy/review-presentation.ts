import {
  hasResolvableReviewFieldValue,
  resolveReviewField,
  type ReviewFieldValues,
} from '../lib/review-field-resolution.js';
import { flattenPipelineSteps } from '../lib/subpipelines.js';

export { isReviewFieldAvailable } from '../lib/review-field-resolution.js';

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

/** Read-time equivalence between the presentation bound at creation and current config/record. */
export type PresentationEquivalenceStatus = 'matches' | 'changed' | 'unavailable';

export type PresentationFieldChange = {
  field: string;
  change: 'added' | 'removed' | 'value_changed' | 'label_changed' | 'purpose_changed' | 'require_non_empty_changed';
  bound?: unknown;
  current?: unknown;
};

export type PresentationEquivalence = {
  status: PresentationEquivalenceStatus;
  reason: string;
  changed_fields: PresentationFieldChange[];
};

/**
 * Read-time view of a stage review presentation.
 * `presentation` is always resolved against current config + record when possible;
 * the creation-time snapshot remains inspectable as `bound_presentation`.
 */
export type StageReviewPresentationRead = {
  presentation: ResolvedReviewPresentation | null;
  bound_presentation: ResolvedReviewPresentation | null;
  bound_asset_version: string;
  presentation_equivalence: PresentationEquivalence;
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

const stableValue = (value: unknown): string => {
  if (value === undefined) return '__undefined__';
  if (value === null) return '__null__';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return `${typeof value}:${String(value)}`;
  }
  try {
    return `json:${JSON.stringify(value)}`;
  } catch {
    return `string:${String(value)}`;
  }
};

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

export const resolveReviewPresentation = ({
  step,
  record: source,
  producedValues = {},
}: {
  step: unknown;
  record: Record<string, unknown>;
  producedValues?: ReviewFieldValues;
}): ResolvedReviewPresentation | null => {
  const configured = reviewPresentationForStep(step);
  if (!configured) return null;
  const stepConfig = record(record(step).config);
  return {
    ...configured,
    present: configured.present.map((entry) => ({
      ...entry,
      value: resolveReviewField({
        field: entry.field,
        producedValues,
        recordValues: source,
        stepConfig,
      })?.value,
    })),
  };
};

export const isEmptyReviewValue = (value: unknown): boolean => (
  !hasResolvableReviewFieldValue(value)
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

/**
 * Locate a configured step by id across flattened pipeline steps and all sequences.
 * Stage reviews bind to pipeline step ids (e.g. tier_b.email_1) or sequence step ids.
 */
export const findConfiguredStepById = (
  config: unknown,
  stepId: unknown,
): Record<string, unknown> | null => {
  const id = text(stepId);
  if (!id) return null;
  const pipelineStep = flattenPipelineSteps(config).find((candidate) => text(candidate.id) === id);
  if (pipelineStep) return pipelineStep;
  const sequences = record(record(config).sequences);
  for (const sequence of Object.values(sequences)) {
    const steps = Array.isArray(record(sequence).steps) ? record(sequence).steps as unknown[] : [];
    const found = steps.find((candidate) => text(record(candidate).id) === id);
    if (found) return record(found);
  }
  return null;
};

/** Diff bound-at-creation presentation against a freshly resolved one. */
export const compareReviewPresentations = (
  bound: ResolvedReviewPresentation | null | undefined,
  current: ResolvedReviewPresentation | null | undefined,
): PresentationEquivalence => {
  const boundPresent = bound?.present || [];
  const currentPresent = current?.present || [];
  const boundEmpty = !bound || (boundPresent.length === 0 && !text(bound.purpose));
  const currentEmpty = !current || (currentPresent.length === 0 && !text(current.purpose));
  if (boundEmpty && currentEmpty) {
    return { status: 'matches', reason: '', changed_fields: [] };
  }

  const changed_fields: PresentationFieldChange[] = [];
  if (text(bound?.purpose) !== text(current?.purpose)) {
    changed_fields.push({
      field: 'purpose',
      change: 'purpose_changed',
      bound: bound?.purpose ?? null,
      current: current?.purpose ?? null,
    });
  }

  const boundRequired = [...(bound?.require_non_empty || [])].map(text).filter(Boolean).sort();
  const currentRequired = [...(current?.require_non_empty || [])].map(text).filter(Boolean).sort();
  if (stableValue(boundRequired) !== stableValue(currentRequired)) {
    changed_fields.push({
      field: 'require_non_empty',
      change: 'require_non_empty_changed',
      bound: boundRequired,
      current: currentRequired,
    });
  }

  const boundByField = new Map(boundPresent.map((entry) => [text(entry.field), entry]));
  const currentByField = new Map(currentPresent.map((entry) => [text(entry.field), entry]));
  const fieldNames = new Set([...boundByField.keys(), ...currentByField.keys()]);
  for (const field of fieldNames) {
    if (!field) continue;
    const prior = boundByField.get(field);
    const next = currentByField.get(field);
    if (prior && !next) {
      changed_fields.push({
        field,
        change: 'removed',
        bound: prior.value,
        current: undefined,
      });
      continue;
    }
    if (!prior && next) {
      changed_fields.push({
        field,
        change: 'added',
        bound: undefined,
        current: next.value,
      });
      continue;
    }
    if (prior && next) {
      if (stableValue(prior.value) !== stableValue(next.value)) {
        changed_fields.push({
          field,
          change: 'value_changed',
          bound: prior.value,
          current: next.value,
        });
      }
      if (text(prior.label) !== text(next.label)) {
        changed_fields.push({
          field,
          change: 'label_changed',
          bound: prior.label,
          current: next.label,
        });
      }
    }
  }

  if (changed_fields.length === 0) {
    return { status: 'matches', reason: '', changed_fields: [] };
  }
  const fieldSummary = changed_fields
    .map((entry) => entry.field)
    .filter((name, index, all) => all.indexOf(name) === index)
    .join(', ');
  return {
    status: 'changed',
    reason: `Presentation differs from what was bound at creation (${fieldSummary}).`,
    changed_fields,
  };
};

/**
 * Resolve stage-review presentation at read time against current config + record.
 * Does not mutate stored stage_review_json; bound snapshot and asset_version remain available.
 */
export const resolveStageReviewPresentationForRead = ({
  review,
  record: source,
  config = null,
}: {
  review: {
    stage_id?: string | null;
    asset_version?: string | null;
    presentation?: ResolvedReviewPresentation | null;
  };
  record: Record<string, unknown>;
  config?: unknown | null;
}): StageReviewPresentationRead => {
  const bound_presentation = review.presentation ?? null;
  const bound_asset_version = text(review.asset_version);

  if (!config) {
    return {
      presentation: bound_presentation,
      bound_presentation,
      bound_asset_version,
      presentation_equivalence: {
        status: 'unavailable',
        reason: 'Current config is unavailable; showing presentation bound at creation.',
        changed_fields: [],
      },
    };
  }

  const stageId = text(review.stage_id);
  const step = findConfiguredStepById(config, stageId);
  if (!step) {
    return {
      presentation: bound_presentation,
      bound_presentation,
      bound_asset_version,
      presentation_equivalence: {
        status: 'unavailable',
        reason: stageId
          ? `Configured step "${stageId}" is unavailable; showing presentation bound at creation.`
          : 'Stage id is missing; showing presentation bound at creation.',
        changed_fields: [],
      },
    };
  }

  const presentation = resolveReviewPresentation({ step, record: source });
  return {
    presentation,
    bound_presentation,
    bound_asset_version,
    presentation_equivalence: compareReviewPresentations(bound_presentation, presentation),
  };
};

/**
 * Enrich a stored stage-review packet for operator read surfaces.
 * Presentation is current; bound fields preserve creation-time history.
 */
export const stageReviewForRead = ({
  review,
  record: source,
  config = null,
}: {
  review: Record<string, unknown> | null | undefined;
  record: Record<string, unknown>;
  config?: unknown | null;
}): Record<string, unknown> | null => {
  if (!review || typeof review !== 'object') return null;
  const read = resolveStageReviewPresentationForRead({
    review: {
      stage_id: review.stage_id != null ? String(review.stage_id) : null,
      asset_version: review.asset_version != null ? String(review.asset_version) : null,
      presentation: (review.presentation ?? null) as ResolvedReviewPresentation | null,
    },
    record: source,
    config,
  });
  return {
    ...review,
    presentation: read.presentation,
    bound_presentation: read.bound_presentation,
    bound_asset_version: read.bound_asset_version || String(review.asset_version || ''),
    presentation_equivalence: read.presentation_equivalence,
  };
};
