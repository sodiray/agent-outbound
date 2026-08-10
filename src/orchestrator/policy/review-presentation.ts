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
 *
 * Authorization integrity: `presentation` field **values** come from the
 * creation-time bound snapshot whenever that snapshot has the field. Structure
 * (which fields, labels, purpose) follows current config so config migrations
 * remain visible. Live record re-resolution alone must never be what a human
 * authorizes — that is the content that may already be frozen on a draft.
 */
export type StageReviewPresentationRead = {
  presentation: ResolvedReviewPresentation | null;
  bound_presentation: ResolvedReviewPresentation | null;
  bound_asset_version: string;
  presentation_equivalence: PresentationEquivalence;
  /**
   * True when every presented value is proven identical to the bound snapshot
   * (or there is nothing to present). False → must not authorize.
   */
  presentation_authorizable: boolean;
  presentation_authorization_reason: string;
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

/**
 * Project bound field values onto the current config structure.
 * Labels/purpose/require_non_empty and the field list come from `current`;
 * each field's value prefers the bound snapshot when that field was bound.
 */
export const projectBoundPresentationValues = ({
  current,
  bound,
}: {
  current: ResolvedReviewPresentation | null | undefined;
  bound: ResolvedReviewPresentation | null | undefined;
}): ResolvedReviewPresentation | null => {
  if (!current) return bound ?? null;
  if (!bound) return current;
  const boundByField = new Map(
    (bound.present || []).map((entry) => [text(entry.field), entry]),
  );
  return {
    purpose: current.purpose,
    require_non_empty: current.require_non_empty,
    present: (current.present || []).map((entry) => {
      const prior = boundByField.get(text(entry.field));
      if (!prior) return entry;
      return { ...entry, value: prior.value };
    }),
  };
};

/**
 * Fail-closed authorization gate for stage-review presentation.
 *
 * A review is authorizable only when every value shown to the human is proven
 * identical to the creation-time bound snapshot. Live-only fields (config added
 * a present field after pause) or any value drift between presented and bound
 * refuse authorization — the human must not approve content that cannot be
 * tied to the sendable asset.
 */
export const presentationAuthorizationGate = ({
  bound,
  presentation,
}: {
  bound: ResolvedReviewPresentation | null | undefined;
  presentation: ResolvedReviewPresentation | null | undefined;
}): { authorizable: boolean; reason: string } => {
  const shown = presentation?.present || [];
  const boundPresent = bound?.present || [];
  const boundEmpty = !bound || (boundPresent.length === 0 && !text(bound.purpose));
  const shownEmpty = !presentation || (shown.length === 0 && !text(presentation.purpose));

  if (shownEmpty && boundEmpty) {
    return { authorizable: true, reason: '' };
  }
  if (shownEmpty && !boundEmpty) {
    // Nothing to show; bound snapshot is historical only.
    return { authorizable: true, reason: '' };
  }
  if (!bound || boundEmpty) {
    return {
      authorizable: false,
      reason: 'presentation_unbound: review has no bound presentation snapshot for the values shown',
    };
  }

  const boundByField = new Map(
    boundPresent.map((entry) => [text(entry.field), entry]),
  );
  for (const entry of shown) {
    const field = text(entry.field);
    if (!field) continue;
    const prior = boundByField.get(field);
    if (!prior) {
      return {
        authorizable: false,
        reason: `presentation_field_unbound: "${field}" is shown from live/config but was not bound at creation`,
      };
    }
    if (stableValue(prior.value) !== stableValue(entry.value)) {
      return {
        authorizable: false,
        reason: `presentation_value_not_bound: "${field}" presented value differs from the bound snapshot`,
      };
    }
  }

  return { authorizable: true, reason: '' };
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
 * Resolve stage-review presentation at read time.
 *
 * - Live resolve establishes current config structure and a live value baseline.
 * - Shown values prefer the bound snapshot (what was fingerprint-bound with the
 *   sendable asset) so the human judges the same content that will go out.
 * - presentation_equivalence reports bound vs live (operator visibility).
 * - presentation_authorizable is the fail-closed gate for authorize paths.
 *
 * Does not mutate stored stage_review_json.
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
    const gate = presentationAuthorizationGate({
      bound: bound_presentation,
      presentation: bound_presentation,
    });
    return {
      presentation: bound_presentation,
      bound_presentation,
      bound_asset_version,
      presentation_equivalence: {
        status: 'unavailable',
        reason: 'Current config is unavailable; showing presentation bound at creation.',
        changed_fields: [],
      },
      presentation_authorizable: gate.authorizable,
      presentation_authorization_reason: gate.reason,
    };
  }

  const stageId = text(review.stage_id);
  const step = findConfiguredStepById(config, stageId);
  if (!step) {
    const gate = presentationAuthorizationGate({
      bound: bound_presentation,
      presentation: bound_presentation,
    });
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
      presentation_authorizable: gate.authorizable,
      presentation_authorization_reason: gate.reason,
    };
  }

  const live = resolveReviewPresentation({ step, record: source });
  const presentation = projectBoundPresentationValues({
    current: live,
    bound: bound_presentation,
  });
  const gate = presentationAuthorizationGate({
    bound: bound_presentation,
    presentation,
  });
  return {
    presentation,
    bound_presentation,
    bound_asset_version,
    presentation_equivalence: compareReviewPresentations(bound_presentation, live),
    presentation_authorizable: gate.authorizable,
    presentation_authorization_reason: gate.reason,
  };
};

/**
 * Enrich a stored stage-review packet for operator read surfaces.
 * Presentation values prefer the bound snapshot; bound_* fields preserve history.
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
    presentation_authorizable: read.presentation_authorizable,
    presentation_authorization_reason: read.presentation_authorization_reason,
  };
};
