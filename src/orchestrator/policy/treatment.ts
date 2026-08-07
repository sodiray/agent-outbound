/**
 * Deterministic treatment tier and mail-treatment assignment.
 * Implements the provisional matrix in treatment-thresholds-and-physical-mail-programs.md.
 */

import {
  DEFAULT_SCORE_ENRICHMENT_BUDGET,
  DEFAULT_SCORE_GOLDEN_TICKET,
  DEFAULT_SCORE_POSTCARD,
  DEFAULT_SCORE_TREATMENT_BANDS,
  type EnrichmentBudgetConfigInput,
  type GoldenTicketConfigInput,
  type PostcardConfigInput,
} from '../../schemas/config.js';

export const CALCULATION_RULE_VERSION = 'tv-treatment-v1';

export type TreatmentTier = 'A' | 'B' | 'C' | 'D' | 'enrichment_hold';
export type MailTreatment = 'none' | 'standard_postcard' | 'golden_ticket';
/** @deprecated Use score.enrichment_budget; retained for compatibility with policy consumers. */
export const ENRICHMENT_COST_CEILINGS = DEFAULT_SCORE_ENRICHMENT_BUDGET.ceilings;
/** @deprecated Use score.golden_ticket.minimums; retained for compatibility with policy consumers. */
export const GOLDEN_TICKET_MIN = {
  fitScore: DEFAULT_SCORE_GOLDEN_TICKET.minimums.fit_score,
  fitEvidenceConfidence: DEFAULT_SCORE_GOLDEN_TICKET.minimums.fit_evidence_confidence,
  identityConfidence: DEFAULT_SCORE_GOLDEN_TICKET.minimums.identity_confidence,
  classificationConfidence: DEFAULT_SCORE_GOLDEN_TICKET.minimums.classification_confidence,
  buyerConfidence: DEFAULT_SCORE_GOLDEN_TICKET.minimums.buyer_confidence,
  mailConfidence: DEFAULT_SCORE_GOLDEN_TICKET.minimums.mail_confidence,
  timingScore: DEFAULT_SCORE_GOLDEN_TICKET.minimums.timing_score,
  strongSignalStrength: DEFAULT_SCORE_GOLDEN_TICKET.minimums.strong_signal_strength,
  strongSignalCount: DEFAULT_SCORE_GOLDEN_TICKET.minimums.strong_signal_count,
  enrichmentBudgetUsd: DEFAULT_SCORE_GOLDEN_TICKET.minimums.enrichment_budget_usd,
} as const;
export type TreatmentBandLadders = {
  fit?: readonly number[];
  fit_evidence_confidence?: readonly number[];
};

export type TreatmentInput = {
  fitScore: number | null;
  fitEvidenceConfidence: number | null;
  /** Optional overall evidence summary — never overrides action-specific gates. */
  identityConfidence?: number | null;
  classificationConfidence?: number | null;
  buyerConfidence?: number | null;
  mailConfidence?: number | null;
  timingScore?: number | null;
  /** Count of independent strong timing signals (excludes stale_no_signal). */
  strongTimingSignalCount?: number | null;
  mailAddressReady?: boolean | null;
  /** When true, Golden Ticket is withheld. Missing/false does not invent suppression. */
  suppressed?: boolean | null;
  materialContradiction?: boolean | null;
  /**
   * Local buying authority — required for Golden Ticket (fail closed when missing).
   * Accepted: confirmed | likely | yes (legacy).
   */
  localBuyingAuthority?: string | null;
  /** named_buyer_status: confirmed | likely required for GT. */
  namedBuyerStatus?: string | null;
  /** Observed/primary buyer name — required non-empty for GT named-buyer gate. */
  namedBuyerName?: string | null;
  /**
   * Named-person current affiliation: confirmed | likely required for GT.
   * unresolved / missing → fail closed (never invent affiliation).
   */
  buyerAffiliationStatus?: string | null;
  /** Buying-center role (owner, gm, …) — required non-empty for GT. */
  buyingCenterRole?: string | null;
  /** Cohort / capacity flag — must be explicitly true for GT (fail closed). */
  cohortCapacityOk?: boolean | null;
  goldenTicketGates?: GoldenTicketGates;
  cumulativeEnrichmentCostUsd?: number;
  goldenTicketBudgetCeilingUsd?: number;
  treatmentBands?: TreatmentBandLadders;
  goldenTicket?: GoldenTicketConfigInput;
  postcard?: PostcardConfigInput;
  enrichmentBudget?: EnrichmentBudgetConfigInput;
};

export type GoldenTicketGates = {
  fitScoreMin?: number;
  fitEvidenceMin?: number;
  identityConfidenceMin?: number;
  buyerConfidenceMin?: number;
  timingScoreMin?: number;
  mailReady: boolean;
  assetReady?: boolean;
  budgetOk?: boolean;
  cohortCapacityOk?: boolean;
};

const GT_LOCAL_AUTHORITY_OK = new Set(['confirmed', 'likely', 'yes']);
const GT_NAMED_BUYER_OK = new Set(['confirmed', 'likely']);
const GT_AFFILIATION_OK = new Set(['confirmed', 'likely']);
const GT_AFFILIATION_UNRESOLVED = new Set(['unresolved', 'unknown', 'not_found', 'ambiguous']);

function isMissingScore(v: number | null | undefined): boolean {
  return v == null || Number.isNaN(Number(v));
}

export type TreatmentResult = {
  treatment_tier: TreatmentTier;
  mail_treatment: MailTreatment;
  golden_ticket_eligible: boolean;
  mail_eligibility_reasons: string[];
  mail_withheld_reasons: string[];
  reasons: string[];
  calculation_rule_version: string;
};

type ScoredBand = { index: number; label: string };

const formatBoundary = (value: number) => String(value);

const labelForBand = (boundaries: readonly number[], index: number) => {
  const lower = boundaries[index];
  const upper = boundaries[index + 1];
  if (index === 0) return `below${formatBoundary(upper)}`;
  if (index === boundaries.length - 2) return `${formatBoundary(lower)}-100`;
  if (Number.isInteger(lower) && Number.isInteger(upper)) return `${formatBoundary(lower)}-${formatBoundary(upper - 1)}`;
  return `${formatBoundary(lower)}-<${formatBoundary(upper)}`;
};

const band = (score: number | null, boundaries: readonly number[]): 'unscored' | ScoredBand => {
  if (score == null || Number.isNaN(score)) return 'unscored';
  const index = boundaries.slice(1).findIndex((boundary) => score < boundary);
  const resolvedIndex = index < 0 ? boundaries.length - 2 : index;
  return { index: resolvedIndex, label: labelForBand(boundaries, resolvedIndex) };
};

/**
 * Assign treatment_tier from fit × fit_evidence_confidence matrix.
 */
export function assignTreatmentTier(input: {
  fitScore: number | null;
  fitEvidenceConfidence: number | null;
  treatmentBands?: TreatmentBandLadders;
}): { tier: TreatmentTier; reasons: string[] } {
  const fitBoundaries = input.treatmentBands?.fit || DEFAULT_SCORE_TREATMENT_BANDS.fit;
  const confidenceBoundaries = input.treatmentBands?.fit_evidence_confidence
    || DEFAULT_SCORE_TREATMENT_BANDS.fit_evidence_confidence;
  const fit = band(input.fitScore, fitBoundaries);
  const conf = band(input.fitEvidenceConfidence, confidenceBoundaries);
  const reasons: string[] = [
    `fit_band=${fit === 'unscored' ? fit : fit.label}`,
    `fit_evidence_band=${conf === 'unscored' ? conf : conf.label}`,
  ];

  if (fit === 'unscored') {
    return { tier: 'enrichment_hold', reasons: [...reasons, 'unscored_fit'] };
  }
  if (fit.index === 0) {
    return { tier: 'D', reasons: [...reasons, 'weak_fit'] };
  }
  if (fit.index === 3) {
    if (conf !== 'unscored' && conf.index === 3) return { tier: 'A', reasons: [...reasons, 'strong_fit_strong_evidence'] };
    if (conf !== 'unscored' && conf.index === 2) return { tier: 'B', reasons: [...reasons, 'strong_fit_usable_evidence'] };
    if (conf !== 'unscored' && conf.index === 1) return { tier: 'B', reasons: [...reasons, 'high_fit_thin_evidence_postcard_exception_path'] };
    return { tier: 'enrichment_hold', reasons: [...reasons, 'strong_fit_insufficient_evidence'] };
  }
  if (fit.index === 2) {
    if (conf !== 'unscored' && (conf.index === 2 || conf.index === 3)) return { tier: 'B', reasons: [...reasons, 'good_fit_usable_evidence'] };
    if (conf !== 'unscored' && conf.index === 1) return { tier: 'C', reasons: [...reasons, 'good_fit_low_evidence'] };
    return { tier: 'enrichment_hold', reasons: [...reasons, 'good_fit_insufficient_evidence'] };
  }
  // Second fit band.
  if (conf !== 'unscored' && (conf.index === 2 || conf.index === 3)) return { tier: 'C', reasons: [...reasons, 'plausible_fit_usable_evidence'] };
  return { tier: 'D', reasons: [...reasons, 'plausible_fit_weak_evidence'] };
}

/**
 * Standard postcard eligibility: Tier A/B, or strong-fit exception with thin evidence.
 */
export function evaluateStandardPostcard(input: {
  treatmentTier: TreatmentTier;
  fitScore: number | null;
  fitEvidenceConfidence: number | null;
  mailAddressReady: boolean;
  identityConfidence?: number | null;
  postcard?: PostcardConfigInput;
}): { eligible: boolean; reasons: string[]; withheld: string[] } {
  const reasons: string[] = [];
  const withheld: string[] = [];
  const mins = { ...DEFAULT_SCORE_POSTCARD.minimums, ...input.postcard?.minimums };
  if (!input.mailAddressReady) {
    withheld.push('mail_address_not_ready');
  }
  if (input.identityConfidence != null && input.identityConfidence < mins.identity_confidence) {
    withheld.push(`identity_confidence_below_${mins.identity_confidence}`);
  }
  const fit = input.fitScore ?? 0;
  const conf = input.fitEvidenceConfidence ?? 0;
  const tierOk = input.treatmentTier === 'A' || input.treatmentTier === 'B';
  const strongFitException = fit >= mins.strong_fit
    && conf >= mins.fit_evidence
    && conf < mins.fit_evidence_exclusive_maximum;
  if (!tierOk && !strongFitException) {
    withheld.push('treatment_or_exception_not_met');
  }
  if (input.treatmentTier === 'C' || input.treatmentTier === 'D' || input.treatmentTier === 'enrichment_hold') {
    if (!strongFitException) withheld.push(`tier_${input.treatmentTier}_no_default_mail`);
  }
  const eligible = withheld.length === 0 && (tierOk || strongFitException);
  if (eligible) reasons.push(tierOk ? 'tier_allows_standard_postcard' : 'strong_fit_postcard_exception');
  return { eligible, reasons, withheld };
}

/**
 * Count independent strong timing signals for the GT multi-signal path.
 * Excludes `stale_no_signal` (invented baseline) — never counts as evidence.
 */
export function countStrongTimingSignals(
  signals: Array<{ id?: string; decayed_strength?: number; strength?: number }> | null | undefined,
  minStrength: number = DEFAULT_SCORE_GOLDEN_TICKET.minimums.strong_signal_strength,
): number {
  if (!Array.isArray(signals) || !signals.length) return 0;
  let n = 0;
  for (const s of signals) {
    const id = String(s?.id || '');
    if (id === 'stale_no_signal') continue;
    const str = Number(s?.decayed_strength ?? s?.strength ?? 0);
    if (Number.isFinite(str) && str >= minStrength) n += 1;
  }
  return n;
}

/**
 * Golden Ticket is a Tier A overlay with mandatory multi-domain gates.
 *
 * Production thresholds (fail closed when null/undefined):
 * - fit ≥ 85, fit evidence ≥ 80
 * - identity ≥ 90, classification ≥ 90, buyer ≥ 80, mail ≥ 90
 * - named buyer (status confirmed|likely + non-empty name)
 * - local buying authority confirmed|likely
 * - mail address ready, approved GT asset
 * - timing ≥ 70 OR ≥ 2 independent strong signals
 * - enrichment budget + cohort capacity
 * - not suppressed / no material contradiction
 */
export function evaluateGoldenTicket(input: {
  treatmentTier: TreatmentTier;
  fitScore: number | null;
  fitEvidenceConfidence: number | null;
  identityConfidence?: number | null;
  classificationConfidence?: number | null;
  buyerConfidence?: number | null;
  mailConfidence?: number | null;
  timingScore?: number | null;
  strongTimingSignalCount?: number | null;
  mailAddressReady?: boolean | null;
  assetReady?: boolean | null;
  suppressed?: boolean | null;
  materialContradiction?: boolean | null;
  localBuyingAuthority?: string | null;
  namedBuyerStatus?: string | null;
  namedBuyerName?: string | null;
  buyerAffiliationStatus?: string | null;
  buyingCenterRole?: string | null;
  cohortCapacityOk?: boolean | null;
  cumulativeEnrichmentCostUsd?: number;
  goldenTicketBudgetCeilingUsd?: number;
  goldenTicket?: GoldenTicketConfigInput;
}): { eligible: boolean; reasons: string[]; withheld: string[] } {
  const reasons: string[] = [];
  const withheld: string[] = [];
  const mins = { ...DEFAULT_SCORE_GOLDEN_TICKET.minimums, ...input.goldenTicket?.minimums };

  if (input.treatmentTier !== 'A') withheld.push('not_tier_a');

  if (isMissingScore(input.fitScore)) withheld.push('fit_score_missing');
  else if ((input.fitScore as number) < mins.fit_score) {
    withheld.push(`fit_below_${mins.fit_score}`);
  }

  if (isMissingScore(input.fitEvidenceConfidence)) withheld.push('fit_evidence_missing');
  else if ((input.fitEvidenceConfidence as number) < mins.fit_evidence_confidence) {
    withheld.push(`fit_evidence_below_${mins.fit_evidence_confidence}`);
  }

  if (isMissingScore(input.identityConfidence)) withheld.push('identity_confidence_missing');
  else if ((input.identityConfidence as number) < mins.identity_confidence) {
    withheld.push(`identity_confidence_below_${mins.identity_confidence}`);
  }

  if (isMissingScore(input.classificationConfidence)) {
    withheld.push('classification_confidence_missing');
  } else if ((input.classificationConfidence as number) < mins.classification_confidence) {
    withheld.push(`classification_confidence_below_${mins.classification_confidence}`);
  }

  if (isMissingScore(input.buyerConfidence)) withheld.push('buyer_confidence_missing');
  else if ((input.buyerConfidence as number) < mins.buyer_confidence) {
    withheld.push(`buyer_confidence_below_${mins.buyer_confidence}`);
  }

  if (isMissingScore(input.mailConfidence)) withheld.push('mail_confidence_missing');
  else if ((input.mailConfidence as number) < mins.mail_confidence) {
    withheld.push(`mail_confidence_below_${mins.mail_confidence}`);
  }

  // mailAddressReady is required for GT: null/undefined/false all fail closed.
  if (input.mailAddressReady == null) withheld.push('mail_address_ready_missing');
  else if (!input.mailAddressReady) withheld.push('mail_address_not_ready');

  // Asset must be explicitly ready — missing is not invent-pass.
  if (input.assetReady !== true) withheld.push('golden_ticket_asset_not_ready');

  // Named buyer: status confirmed|likely + non-empty name (fail closed).
  const buyerStatusRaw = input.namedBuyerStatus != null
    ? String(input.namedBuyerStatus).trim().toLowerCase()
    : '';
  const buyerName = input.namedBuyerName != null
    ? String(input.namedBuyerName).trim()
    : '';
  if (!buyerStatusRaw) withheld.push('named_buyer_status_missing');
  else if (!GT_NAMED_BUYER_OK.has(buyerStatusRaw)) {
    withheld.push('named_buyer_not_confirmed');
  }
  if (!buyerName) withheld.push('named_buyer_name_missing');

  // Current affiliation + buying-center role — high tier fail closed (never invent).
  const affRaw = input.buyerAffiliationStatus != null
    ? String(input.buyerAffiliationStatus).trim().toLowerCase()
    : '';
  if (!affRaw) withheld.push('buyer_affiliation_status_missing');
  else if (GT_AFFILIATION_UNRESOLVED.has(affRaw)) {
    withheld.push('buyer_affiliation_unresolved');
  } else if (!GT_AFFILIATION_OK.has(affRaw)) {
    withheld.push('buyer_affiliation_not_confirmed');
  }
  const roleRaw = input.buyingCenterRole != null
    ? String(input.buyingCenterRole).trim()
    : '';
  if (!roleRaw) withheld.push('buying_center_role_missing');

  // Local buying authority required for GT (fail closed when missing).
  if (input.localBuyingAuthority == null || String(input.localBuyingAuthority).trim() === '') {
    withheld.push('local_buying_authority_missing');
  } else {
    const auth = String(input.localBuyingAuthority).trim().toLowerCase();
    if (!GT_LOCAL_AUTHORITY_OK.has(auth)) {
      withheld.push('local_buying_authority_not_confirmed');
    }
  }

  // Timing ≥ 70 OR ≥ 2 independent strong signals (multi-domain gate).
  const timingMissing = isMissingScore(input.timingScore);
  const signalCount = input.strongTimingSignalCount;
  const signalCountMissing = signalCount == null || Number.isNaN(Number(signalCount));
  const timingOk = !timingMissing && (input.timingScore as number) >= mins.timing_score;
  const multiSignalOk = !signalCountMissing && Number(signalCount) >= mins.strong_signal_count;
  if (!timingOk && !multiSignalOk) {
    if (timingMissing && signalCountMissing) {
      withheld.push('timing_or_signals_missing');
    } else {
      withheld.push('timing_or_correlated_signals_insufficient');
    }
  }

  // Cohort capacity must be explicitly true (fail closed).
  if (input.cohortCapacityOk !== true) {
    withheld.push(
      input.cohortCapacityOk === false
        ? 'cohort_capacity_unavailable'
        : 'cohort_capacity_missing',
    );
  }

  if (input.suppressed === true) withheld.push('suppressed');
  if (input.materialContradiction === true) withheld.push('material_contradiction');

  const ceiling = input.goldenTicketBudgetCeilingUsd ?? mins.enrichment_budget_usd;
  if ((input.cumulativeEnrichmentCostUsd ?? 0) > ceiling) {
    withheld.push('enrichment_budget_exceeded');
  }

  const eligible = withheld.length === 0;
  if (eligible) reasons.push('all_golden_ticket_gates_passed');
  return { eligible, reasons, withheld };
}

/**
 * Full treatment + mail_treatment assignment. Mail is independent of tier labels.
 * At most one mail program: golden_ticket beats standard_postcard when both pass.
 */
export function assignTreatmentAndMail(input: TreatmentInput): TreatmentResult {
  const { tier, reasons } = assignTreatmentTier({
    fitScore: input.fitScore,
    fitEvidenceConfidence: input.fitEvidenceConfidence,
    treatmentBands: input.treatmentBands,
  });

  const postcard = evaluateStandardPostcard({
    treatmentTier: tier,
    fitScore: input.fitScore,
    fitEvidenceConfidence: input.fitEvidenceConfidence,
    mailAddressReady: Boolean(input.mailAddressReady),
    identityConfidence: input.identityConfidence,
    postcard: input.postcard,
  });

  const assetReady = input.goldenTicketGates?.assetReady;
  const cohortFromGates = input.goldenTicketGates?.cohortCapacityOk;
  const cohortCapacityOk =
    input.cohortCapacityOk === true || cohortFromGates === true
      ? true
      : input.cohortCapacityOk === false || cohortFromGates === false
        ? false
        : input.cohortCapacityOk ?? cohortFromGates ?? null;

  const golden = evaluateGoldenTicket({
    treatmentTier: tier,
    fitScore: input.fitScore,
    fitEvidenceConfidence: input.fitEvidenceConfidence,
    identityConfidence: input.identityConfidence,
    classificationConfidence: input.classificationConfidence,
    buyerConfidence: input.buyerConfidence,
    mailConfidence: input.mailConfidence,
    timingScore: input.timingScore,
    strongTimingSignalCount: input.strongTimingSignalCount,
    // Preserve null/undefined for fail-closed GT; do not coerce to false here.
    mailAddressReady: input.mailAddressReady,
    assetReady: assetReady === true ? true : assetReady === false ? false : null,
    suppressed: input.suppressed,
    materialContradiction: input.materialContradiction,
    localBuyingAuthority: input.localBuyingAuthority,
    namedBuyerStatus: input.namedBuyerStatus,
    namedBuyerName: input.namedBuyerName,
    buyerAffiliationStatus: input.buyerAffiliationStatus,
    buyingCenterRole: input.buyingCenterRole,
    cohortCapacityOk,
    cumulativeEnrichmentCostUsd: input.cumulativeEnrichmentCostUsd,
    goldenTicketBudgetCeilingUsd:
      input.goldenTicketBudgetCeilingUsd ?? input.goldenTicket?.minimums?.enrichment_budget_usd,
    goldenTicket: input.goldenTicket,
  });

  let mail_treatment: MailTreatment = 'none';
  const mail_eligibility_reasons: string[] = [];
  const mail_withheld_reasons: string[] = [];

  if (golden.eligible) {
    mail_treatment = 'golden_ticket';
    mail_eligibility_reasons.push(...golden.reasons);
  } else if (postcard.eligible) {
    mail_treatment = 'standard_postcard';
    mail_eligibility_reasons.push(...postcard.reasons);
    mail_withheld_reasons.push(...golden.withheld.map((w) => `golden:${w}`));
  } else {
    mail_withheld_reasons.push(...postcard.withheld.map((w) => `postcard:${w}`));
    mail_withheld_reasons.push(...golden.withheld.map((w) => `golden:${w}`));
  }

  return {
    treatment_tier: tier,
    mail_treatment,
    golden_ticket_eligible: golden.eligible,
    mail_eligibility_reasons,
    mail_withheld_reasons,
    reasons,
    calculation_rule_version: CALCULATION_RULE_VERSION,
  };
}

/** Provisional cumulative enrichment ceilings (USD). */
export function enrichmentBudgetRemaining(input: {
  candidateOrTreatment: TreatmentTier | 'foundational';
  spentUsd: number;
  forGoldenTicket?: boolean;
  enrichmentBudget?: EnrichmentBudgetConfigInput;
}): { ceiling: number; remaining: number; withinBudget: boolean } {
  const ceilings = { ...DEFAULT_SCORE_ENRICHMENT_BUDGET.ceilings, ...input.enrichmentBudget?.ceilings };
  const ceiling = input.forGoldenTicket
    ? ceilings.golden_ticket_total
    : ceilings[input.candidateOrTreatment] ?? ceilings.foundational;
  const remaining = Math.max(0, ceiling - (input.spentUsd || 0));
  return { ceiling, remaining, withinBudget: remaining > 0 || (input.spentUsd || 0) <= ceiling };
}
