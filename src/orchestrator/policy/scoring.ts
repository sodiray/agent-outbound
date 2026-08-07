/**
 * Deterministic fit calculation, priority lanes, and evidence-confidence rollups.
 * Models supply component grades; this module owns final numbers.
 */

import {
  DEFAULT_SCORE_ACTION_CONFIDENCE,
  DEFAULT_SCORE_CANDIDATE_TIER,
  type ActionConfidenceConfigInput,
  type CandidateTierConfigInput,
} from '../../schemas/config.js';

export const FIT_RULE_VERSION = 'tv-fit-v1';
export const PRIORITY_RULE_VERSION = 'tv-priority-v1';

/** Fit components — commercial value only (no walk-in, HIPAA, contact availability). */
export const FIT_COMPONENT_WEIGHTS = {
  operational_coordination_burden: 0.22,
  repetition_and_volume: 0.18,
  economic_impact_potential: 0.2,
  operating_scale_surface_area: 0.15,
  mission_delivery_compatibility: 0.15,
  local_buying_autonomy: 0.1,
} as const;

export type FitComponentId = keyof typeof FIT_COMPONENT_WEIGHTS;

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
  fit_score: number;
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
  calculation_rule_version: string;
};

/**
 * Weighted fit from 0–10 component grades → 0–100 score.
 * Missing components contribute 0 and are listed in missing_inputs (do not invent).
 */
export function calculateFitScore(components: FitComponentGrade[]): FitScoreResult {
  const byId = new Map(components.map((c) => [c.id, c]));
  const hasUnassessableComponent = components.some((component) => component.unassessable === true);
  const assessable_weight = Object.entries(FIT_COMPONENT_WEIGHTS)
    .filter(([id]) => byId.get(id as FitComponentId)?.unassessable !== true)
    .reduce((sum, [, weight]) => sum + weight, 0);
  const normalization = hasUnassessableComponent && assessable_weight > 0
    ? assessable_weight
    : 1;
  const missing_inputs: string[] = [];
  const detail: FitScoreResult['components'] = [];
  let sum = 0;

  for (const [id, weight] of Object.entries(FIT_COMPONENT_WEIGHTS) as Array<[FitComponentId, number]>) {
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
    calculation_rule_version: FIT_RULE_VERSION,
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
  } else if (input.needsEnrichment || input.treatmentTier === 'enrichment_hold') {
    lane = 'enrichment';
    reasons.push('enrichment_needed');
  } else if (input.isRecycleOrMonitor || input.treatmentTier === 'D') {
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
  candidate_tier: 'A' | 'B' | 'C' | 'D' | 'hold';
  reasons: string[];
} {
  const bands = config?.bands || DEFAULT_SCORE_CANDIDATE_TIER.bands;
  if (preliminaryFit == null || Number.isNaN(preliminaryFit)) {
    return { candidate_tier: 'hold', reasons: ['unscored'] };
  }
  if (preliminaryFit >= bands[3]) return { candidate_tier: 'A', reasons: [`prelim_fit_${bands[3]}_100`] };
  if (preliminaryFit >= bands[2]) return { candidate_tier: 'B', reasons: [`prelim_fit_${bands[2]}_${bands[3] - 1}`] };
  if (preliminaryFit >= bands[1]) return { candidate_tier: 'C', reasons: [`prelim_fit_${bands[1]}_${bands[2] - 1}`] };
  return { candidate_tier: 'D', reasons: [`prelim_fit_below_${bands[1]}`] };
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}
function round1(n: number) {
  return Math.round(n * 10) / 10;
}
