/**
 * Deterministic fit calculation, priority lanes, and evidence-confidence rollups.
 * Models supply component grades; this module owns final numbers.
 */

import {
  DEFAULT_SCORE_ACTION_CONFIDENCE,
  type ActionConfidenceConfigInput,
  type CandidateTierConfigInput,
  type PriorityConfigInput,
} from '../../schemas/config.js';

export const FIT_ARITHMETIC_RULE_VERSION = 'fit-arithmetic-v1';
export const PRIORITY_RULE_VERSION = 'priority-arithmetic-v1';

export type FitComponentId = string;

export type FitComponentConfigInput = {
  id?: string;
  weight?: number;
};

/** Pipeline-owned fit model, declared by score.criteria and policy.fit_rule_version. */
export type FitModelConfigInput = {
  criteria?: FitComponentConfigInput[];
  modelVersion?: string;
};

export type FitComponentGrade = {
  id: FitComponentId;
  /** 0–10 grade from evidence-bound evaluation */
  grade: number;
  evidence_ids?: string[];
  reasoning?: string;
  missing?: boolean;
  /** Explicitly unavailable evidence is excluded from a covered-score mean. */
  unassessable?: boolean;
};

export type FitScoreResult = {
  fit_score: number | null;
  components: Array<{
    id: string;
    grade: number;
    weight: number;
    contribution: number;
    evidence_ids: string[];
    reasoning: string;
  }>;
  missing_inputs: string[];
  /** Canonical-weight share represented by assessable fit components. */
  assessable_weight: number;
  /** Pipeline-owned model identifier, when the pipeline declares one. */
  fit_model_version: string | null;
  calculation_rule_version: string;
  reason?: 'fit_components_not_configured' | 'fit_not_graded';
};

const configuredFitComponents = (config: FitModelConfigInput | undefined): Array<{ id: string; weight: number }> => {
  const criteria = config?.criteria || [];
  const configured = criteria.flatMap((criterion) => {
    const id = String(criterion.id || '').trim();
    const weight = Number(criterion.weight);
    if (!id || !Number.isFinite(weight) || weight <= 0) return [];
    return [{ id, weight }];
  });
  const totalWeight = configured.reduce((sum, criterion) => sum + criterion.weight, 0);
  if (totalWeight <= 0) return [];
  return configured.map((criterion) => ({
    ...criterion,
    weight: criterion.weight / totalWeight,
  }));
};

export const fitModelComponentIds = (config: FitModelConfigInput | undefined): string[] => (
  configuredFitComponents(config).map(({ id }) => id)
);

/**
 * Weighted fit from 0–10 component grades → 0–100 score.
 * Missing components contribute 0 and are listed in missing_inputs (do not invent).
 */
export function calculateFitScore(
  components: FitComponentGrade[],
  config?: FitModelConfigInput,
): FitScoreResult {
  const configured = configuredFitComponents(config);
  const modelVersion = String(config?.modelVersion || '').trim() || null;
  if (configured.length === 0) {
    return {
      fit_score: null,
      components: [],
      missing_inputs: [],
      assessable_weight: 0,
      fit_model_version: modelVersion,
      calculation_rule_version: FIT_ARITHMETIC_RULE_VERSION,
      reason: 'fit_components_not_configured',
    };
  }
  const gradedComponents = components.filter((component) => (
    configured.some(({ id }) => id === component.id)
    && component.missing !== true
    && component.unassessable !== true
    && Number.isFinite(Number(component.grade))
  ));
  if (gradedComponents.length === 0) {
    return {
      fit_score: null,
      components: [],
      missing_inputs: configured.map(({ id }) => id),
      assessable_weight: 0,
      fit_model_version: modelVersion,
      calculation_rule_version: FIT_ARITHMETIC_RULE_VERSION,
      reason: 'fit_not_graded',
    };
  }
  const byId = new Map(components.map((c) => [c.id, c]));
  const hasUnassessableComponent = components.some((component) => component.unassessable === true);
  const assessable_weight = configured
    .filter(({ id }) => byId.get(id)?.unassessable !== true)
    .reduce((sum, { weight }) => sum + weight, 0);
  const normalization = hasUnassessableComponent && assessable_weight > 0
    ? assessable_weight
    : 1;
  const missing_inputs: string[] = [];
  const detail: FitScoreResult['components'] = [];
  let sum = 0;

  for (const { id, weight } of configured) {
    const c = byId.get(id);
    const unavailable = c?.unassessable === true;
    const grade = c && !c.missing && !unavailable ? clamp(Number(c.grade) || 0, 0, 10) : 0;
    if (!c || c.missing || unavailable) missing_inputs.push(id);
    const normalizedWeight = unavailable ? 0 : weight / normalization;
    const contribution = grade * 10 * normalizedWeight;
    sum += contribution;
    detail.push({
      id,
      grade,
      weight: normalizedWeight,
      contribution: round1(contribution),
      evidence_ids: c?.evidence_ids || [],
      reasoning: c?.reasoning || '',
    });
  }

  return {
    fit_score: round1(clamp(sum, 0, 100)),
    components: detail,
    missing_inputs,
    assessable_weight: round1(assessable_weight),
    fit_model_version: modelVersion,
    calculation_rule_version: FIT_ARITHMETIC_RULE_VERSION,
  };
}

export type EvidenceConfidenceProfile = {
  identity_confidence: number;
  classification_confidence: number;
  fit_evidence_confidence: number;
  buyer_confidence: number;
  timing_confidence: number;
  email_confidence?: number;
  phone_confidence?: number;
  linkedin_confidence?: number;
  mail_confidence?: number;
};

/**
 * Action-specific confidence gate. Overall averages never authorize an action.
 */
export function actionConfidenceAllows(input: {
  action: 'email' | 'phone' | 'linkedin' | 'mail' | 'fit_treatment' | 'outbound_baseline';
  profile: EvidenceConfidenceProfile;
  minimums?: Partial<Record<string, number>>;
  config?: ActionConfidenceConfigInput;
}): { allowed: boolean; failing: string[]; used: Record<string, number> } {
  const mins = {
    ...DEFAULT_SCORE_ACTION_CONFIDENCE.minimums,
    ...input.config?.minimums,
    ...input.minimums,
  };
  const p = input.profile;
  const failing: string[] = [];
  const used: Record<string, number> = {};

  // Missing confidence fails closed (treated as 0) — never invent a passing default.
  const check = (name: string, value: number | undefined | null, min: number) => {
    const missing = value == null || (typeof value === 'number' && Number.isNaN(value));
    const v = missing ? 0 : Number(value);
    used[name] = v;
    if (missing || v < min) failing.push(`${name}<${min}`);
  };

  check('identity_confidence', p.identity_confidence, mins.identity);

  switch (input.action) {
    case 'email':
      check('email_confidence', p.email_confidence, mins.email);
      break;
    case 'phone':
      check('phone_confidence', p.phone_confidence, mins.phone);
      break;
    case 'linkedin':
      check('linkedin_confidence', p.linkedin_confidence, mins.linkedin);
      break;
    case 'mail':
      check('mail_confidence', p.mail_confidence, mins.mail);
      break;
    case 'fit_treatment':
      check('fit_evidence_confidence', p.fit_evidence_confidence, mins.fit_evidence);
      break;
    case 'outbound_baseline':
      // identity already checked
      break;
  }

  return { allowed: failing.length === 0, failing, used };
}

export type PriorityLane =
  | 'reply_interest'
  | 'promised_followup'
  | 'blocking_repair'
  | 'enrichment'
  | 'outbound'
  | 'recycle_monitoring';

const LANE_ORDER: PriorityLane[] = [
  'reply_interest',
  'promised_followup',
  'blocking_repair',
  'enrichment',
  'outbound',
  'recycle_monitoring',
];

export type PriorityInput = {
  hasReplyOrInterest?: boolean;
  hasPromisedOrOverdueFollowup?: boolean;
  hasBlockingRepair?: boolean;
  needsEnrichment?: boolean;
  treatmentTier?: string | null;
  fitScore?: number | null;
  timingScore?: number | null;
  isRecycleOrMonitor?: boolean;
  config?: PriorityConfigInput;
};

export type PriorityResult = {
  priority_lane: PriorityLane;
  /** 0–100 rank within lane (higher = sooner) */
  priority_rank: number;
  lane_index: number;
  calculation_rule_version: string;
  reasons: string[];
};

/**
 * Deterministic priority: lane first, then rank within lane.
 * Priority is never a copy of fit alone.
 */
export function calculatePriority(input: PriorityInput): PriorityResult {
  let lane: PriorityLane = 'outbound';
  const reasons: string[] = [];

  if (input.hasReplyOrInterest) {
    lane = 'reply_interest';
    reasons.push('reply_or_interest');
  } else if (input.hasPromisedOrOverdueFollowup) {
    lane = 'promised_followup';
    reasons.push('promised_or_overdue_followup');
  } else if (input.hasBlockingRepair) {
    lane = 'blocking_repair';
    reasons.push('blocking_repair');
  } else if (input.needsEnrichment || input.config?.tier_lanes?.[String(input.treatmentTier || '')] === 'enrichment') {
    lane = 'enrichment';
    reasons.push('enrichment_needed');
  } else if (input.isRecycleOrMonitor || input.config?.tier_lanes?.[String(input.treatmentTier || '')] === 'recycle_monitoring') {
    lane = 'recycle_monitoring';
    reasons.push('recycle_or_monitor');
  } else {
    lane = 'outbound';
    reasons.push('standard_outbound');
  }

  const fit = clamp(Number(input.fitScore) || 0, 0, 100);
  const timing = clamp(Number(input.timingScore) || 0, 0, 100);
  // Within lane: timing dominates dynamics; fit is secondary (never mirrored 1:1 as sole rank)
  const priority_rank = round1(clamp(timing * 0.55 + fit * 0.35 + 10, 0, 100));

  return {
    priority_lane: lane,
    priority_rank,
    lane_index: LANE_ORDER.indexOf(lane),
    calculation_rule_version: PRIORITY_RULE_VERSION,
    reasons,
  };
}

/** Candidate tier from preliminary fit (controls research depth, not outreach). */
export function assignCandidateTier(preliminaryFit: number | null, config?: CandidateTierConfigInput): {
  candidate_tier: string;
  reasons: string[];
} {
  const bands = config?.bands;
  const tiers = config?.tiers;
  if (preliminaryFit == null || Number.isNaN(preliminaryFit)) {
    return {
      candidate_tier: config?.unscored_tier || '',
      reasons: ['unscored', ...(config?.unscored_tier ? [] : ['candidate_tier_not_configured'])],
    };
  }
  if (!bands || bands.length !== 5 || !tiers || tiers.length !== 4) {
    return { candidate_tier: '', reasons: ['candidate_tier_not_configured'] };
  }
  if (preliminaryFit >= bands[3]) return { candidate_tier: tiers[3], reasons: [`prelim_fit_${bands[3]}_100`] };
  if (preliminaryFit >= bands[2]) return { candidate_tier: tiers[2], reasons: [`prelim_fit_${bands[2]}_${bands[3] - 1}`] };
  if (preliminaryFit >= bands[1]) return { candidate_tier: tiers[1], reasons: [`prelim_fit_${bands[1]}_${bands[2] - 1}`] };
  return { candidate_tier: tiers[0], reasons: [`prelim_fit_below_${bands[1]}`] };
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}
function round1(n: number) {
  return Math.round(n * 10) / 10;
}
