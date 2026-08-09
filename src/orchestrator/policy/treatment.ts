/** Deterministic, pipeline-declared treatment and physical-mail assignment. */

import {
  type EnrichmentBudgetConfigInput,
  type MailProgramConfigInput,
  type TreatmentStrategyConfigInput,
} from '../../schemas/config.js';

export const CALCULATION_RULE_VERSION = 'treatment-calculation-v1';

export type TreatmentTier = string;
export type MailTreatment = string;
export type TreatmentBandLadders = {
  fit?: readonly number[];
  fit_evidence_confidence?: readonly number[];
};

export type MailProgramReadiness = {
  asset_ready?: boolean | null;
  cohort_capacity_ok?: boolean | null;
};

export type GoldenTicketGates = {
  mailReady: boolean;
  assetReady?: boolean;
  budgetOk?: boolean;
  cohortCapacityOk?: boolean;
};

export type TreatmentInput = {
  fitScore: number | null;
  fitEvidenceConfidence: number | null;
  identityConfidence?: number | null;
  classificationConfidence?: number | null;
  buyerConfidence?: number | null;
  mailConfidence?: number | null;
  timingScore?: number | null;
  strongTimingSignalCount?: number | null;
  mailAddressReady?: boolean | null;
  suppressed?: boolean | null;
  materialContradiction?: boolean | null;
  localBuyingAuthority?: string | null;
  namedBuyerStatus?: string | null;
  namedBuyerName?: string | null;
  buyerAffiliationStatus?: string | null;
  buyingCenterRole?: string | null;
  cohortCapacityOk?: boolean | null;
  mailProgramReadiness?: Record<string, MailProgramReadiness>;
  /** Compatibility input for callers that have not yet supplied per-program readiness. */
  goldenTicketGates?: GoldenTicketGates;
  cumulativeEnrichmentCostUsd?: number;
  treatmentBands?: TreatmentBandLadders;
  treatmentStrategy?: TreatmentStrategyConfigInput;
  enrichmentBudget?: EnrichmentBudgetConfigInput;
  /** Production policy assembly supplied every input the declared programs inspect. */
  policyInputAssembly?: 'complete';
};

export type TreatmentResult = {
  treatment_tier: TreatmentTier;
  mail_treatment: MailTreatment;
  mail_program_eligible: boolean;
  high_confidence_mail_program_eligible: boolean;
  mail_eligibility_reasons: string[];
  mail_withheld_reasons: string[];
  reasons: string[];
  calculation_rule_version: string;
};

type ScoredBand = { index: number; label: string };
type MailProgramEvaluation = {
  program: string;
  eligible: boolean;
  reasons: string[];
  withheld: string[];
};

const confirmedValues = new Set(['confirmed', 'likely', 'yes']);
const affiliationUnresolvedValues = new Set(['unresolved', 'unknown', 'not_found', 'ambiguous']);

const text = (value: unknown) => String(value ?? '').trim();
const lower = (value: unknown) => text(value).toLowerCase();
const isMissingScore = (value: number | null | undefined) => value == null || Number.isNaN(Number(value));
const formatBoundary = (value: number) => String(value);

const labelForBand = (boundaries: readonly number[], index: number) => {
  const lowerBoundary = boundaries[index];
  const upperBoundary = boundaries[index + 1];
  if (index === 0) return `below${formatBoundary(upperBoundary)}`;
  if (index === boundaries.length - 2) return `${formatBoundary(lowerBoundary)}-100`;
  if (Number.isInteger(lowerBoundary) && Number.isInteger(upperBoundary)) {
    return `${formatBoundary(lowerBoundary)}-${formatBoundary(upperBoundary - 1)}`;
  }
  return `${formatBoundary(lowerBoundary)}-<${formatBoundary(upperBoundary)}`;
};

const band = (score: number | null, boundaries: readonly number[]): 'unscored' | ScoredBand => {
  if (score == null || Number.isNaN(score)) return 'unscored';
  const index = boundaries.slice(1).findIndex((boundary) => score < boundary);
  const resolvedIndex = index < 0 ? boundaries.length - 2 : index;
  return { index: resolvedIndex, label: labelForBand(boundaries, resolvedIndex) };
};

const configuredMailPrograms = (strategy?: TreatmentStrategyConfigInput) => (
  Object.entries(strategy?.mail_programs || {})
    .sort(([leftId, left], [rightId, right]) => (
      Number(right.priority || 0) - Number(left.priority || 0)
      || leftId.localeCompare(rightId)
    ))
);

const programReadiness = (input: TreatmentInput, program: string, rank: number): MailProgramReadiness => {
  const declared = input.mailProgramReadiness?.[program];
  if (declared) return declared;
  if (rank !== 0 || !input.goldenTicketGates) return {};
  return {
    asset_ready: input.goldenTicketGates.assetReady,
    cohort_capacity_ok: input.goldenTicketGates.cohortCapacityOk,
  };
};

const hasTierProgram = (
  strategy: TreatmentStrategyConfigInput | undefined,
  tier: string,
  program: string,
  key: 'mail_programs' | 'mail_program_exceptions',
) => strategy?.tiers?.[tier]?.[key]?.includes(program) === true;

const scoreForMinimum = (input: TreatmentInput, minimum: string): number | null | undefined => {
  const scores: Record<string, number | null | undefined> = {
    fit_score: input.fitScore,
    strong_fit: input.fitScore,
    fit_evidence_confidence: input.fitEvidenceConfidence,
    fit_evidence: input.fitEvidenceConfidence,
    identity_confidence: input.identityConfidence,
    classification_confidence: input.classificationConfidence,
    buyer_confidence: input.buyerConfidence,
    mail_confidence: input.mailConfidence,
    timing_score: input.timingScore,
    strong_signal_count: input.strongTimingSignalCount,
    enrichment_budget_usd: input.cumulativeEnrichmentCostUsd,
  };
  return scores[minimum];
};

const policyInputForMinimum = (minimum: string): keyof TreatmentInput | null => {
  const inputs: Partial<Record<string, keyof TreatmentInput>> = {
    fit_score: 'fitScore',
    strong_fit: 'fitScore',
    fit_evidence_confidence: 'fitEvidenceConfidence',
    fit_evidence: 'fitEvidenceConfidence',
    identity_confidence: 'identityConfidence',
    classification_confidence: 'classificationConfidence',
    buyer_confidence: 'buyerConfidence',
    mail_confidence: 'mailConfidence',
    timing_score: 'timingScore',
    strong_signal_count: 'strongTimingSignalCount',
    enrichment_budget_usd: 'cumulativeEnrichmentCostUsd',
  };
  return inputs[minimum] || null;
};

const requiredPolicyInputsForProgram = (definition: MailProgramConfigInput): Array<keyof TreatmentInput> => {
  const minimumInputs = Object.keys(definition.minimums || {})
    .map(policyInputForMinimum)
    .filter((input): input is keyof TreatmentInput => input !== null);
  const requirements = definition.requirements || {};
  return [...new Set([
    ...minimumInputs,
    ...(requirements.mail_address_ready ? ['mailAddressReady'] : []),
    ...(requirements.asset_ready || requirements.cohort_capacity ? ['mailProgramReadiness'] : []),
    ...(requirements.named_buyer ? ['namedBuyerStatus', 'namedBuyerName'] : []),
    ...(requirements.buyer_affiliation ? ['buyerAffiliationStatus'] : []),
    ...(requirements.buying_center_role ? ['buyingCenterRole'] : []),
    ...(requirements.local_buying_authority ? ['localBuyingAuthority'] : []),
    ...(requirements.unsuppressed ? ['suppressed'] : []),
    ...(requirements.no_material_contradiction ? ['materialContradiction'] : []),
    ...(requirements.timing_or_strong_signals ? ['timingScore', 'strongTimingSignalCount'] : []),
  ])] as Array<keyof TreatmentInput>;
};

const assertCompletePolicyInput = (input: TreatmentInput) => {
  if (input.policyInputAssembly !== 'complete') return;
  for (const [program, definition] of configuredMailPrograms(input.treatmentStrategy)) {
    for (const field of requiredPolicyInputsForProgram(definition)) {
      if (!Object.hasOwn(input, field)) {
        throw new Error(`policy_treatment_input_not_supplied:${program}:${field}`);
      }
    }
  }
};

const evaluateMinimums = (input: TreatmentInput, minimums: Record<string, number> | undefined, skipTimingOrSignals: boolean) => (
  Object.entries(minimums || {}).flatMap(([minimum, threshold]) => {
    if (minimum === 'strong_signal_strength') return [];
    if (skipTimingOrSignals && (minimum === 'timing_score' || minimum === 'strong_signal_count')) return [];
    const value = scoreForMinimum(input, minimum);
    if (minimum === 'enrichment_budget_usd') {
      return Number(value || 0) > threshold ? [`${minimum}_exceeded`] : [];
    }
    if (minimum === 'fit_evidence_exclusive_maximum') {
      return value == null || Number(value) >= threshold ? [`${minimum}_not_met`] : [];
    }
    if (isMissingScore(value)) return [`${minimum}_missing`];
    return Number(value) < threshold ? [`${minimum}_below_${threshold}`] : [];
  })
);

const evaluateRequirements = (
  input: TreatmentInput,
  requirements: MailProgramConfigInput['requirements'],
  readiness: MailProgramReadiness,
  minimums: MailProgramConfigInput['minimums'],
) => {
  const withheld: string[] = [];
  if (requirements?.mail_address_ready === true && input.mailAddressReady !== true) {
    withheld.push(input.mailAddressReady == null ? 'mail_address_ready_missing' : 'mail_address_not_ready');
  }
  if (requirements?.asset_ready === true && readiness.asset_ready !== true) withheld.push('asset_not_ready');
  if (requirements?.cohort_capacity === true && readiness.cohort_capacity_ok !== true) {
    withheld.push(readiness.cohort_capacity_ok === false ? 'cohort_capacity_unavailable' : 'cohort_capacity_missing');
  }
  if (requirements?.named_buyer === true) {
    if (!lower(input.namedBuyerStatus)) withheld.push('named_buyer_status_missing');
    else if (!confirmedValues.has(lower(input.namedBuyerStatus))) withheld.push('named_buyer_not_confirmed');
    if (!text(input.namedBuyerName)) withheld.push('named_buyer_name_missing');
  }
  if (requirements?.buyer_affiliation === true) {
    if (!lower(input.buyerAffiliationStatus)) withheld.push('buyer_affiliation_status_missing');
    else if (affiliationUnresolvedValues.has(lower(input.buyerAffiliationStatus))) withheld.push('buyer_affiliation_unresolved');
    else if (!confirmedValues.has(lower(input.buyerAffiliationStatus))) withheld.push('buyer_affiliation_not_confirmed');
  }
  if (requirements?.buying_center_role === true && !text(input.buyingCenterRole)) {
    withheld.push('buying_center_role_missing');
  }
  if (requirements?.local_buying_authority === true) {
    if (!lower(input.localBuyingAuthority)) withheld.push('local_buying_authority_missing');
    else if (!confirmedValues.has(lower(input.localBuyingAuthority))) withheld.push('local_buying_authority_not_confirmed');
  }
  if (requirements?.unsuppressed === true && input.suppressed === true) withheld.push('suppressed');
  if (requirements?.no_material_contradiction === true && input.materialContradiction === true) {
    withheld.push('material_contradiction');
  }
  if (requirements?.timing_or_strong_signals === true) {
    const timingMinimum = minimums?.timing_score;
    const signalMinimum = minimums?.strong_signal_count;
    const timingPresent = !isMissingScore(input.timingScore);
    const signalsPresent = !isMissingScore(input.strongTimingSignalCount);
    const timingOk = timingMinimum !== undefined && timingPresent && Number(input.timingScore) >= timingMinimum;
    const signalsOk = signalMinimum !== undefined && signalsPresent
      && Number(input.strongTimingSignalCount) >= signalMinimum;
    if (!timingOk && !signalsOk) {
      withheld.push(!timingPresent && !signalsPresent
        ? 'timing_or_signals_missing'
        : 'timing_or_correlated_signals_insufficient');
    }
  }
  return withheld;
};

export const assignTreatmentTier = (input: {
  fitScore: number | null;
  fitEvidenceConfidence: number | null;
  treatmentBands?: TreatmentBandLadders;
  treatmentStrategy?: TreatmentStrategyConfigInput;
}): { tier: TreatmentTier; reasons: string[] } => {
  const strategy = input.treatmentStrategy;
  if (!strategy?.bands?.fit || !strategy.bands.fit_evidence_confidence || !strategy.matrix || !strategy.unscored_tier) {
    return { tier: '', reasons: ['treatment_not_configured'] };
  }
  const fit = band(input.fitScore, strategy.bands.fit);
  const confidence = band(input.fitEvidenceConfidence, strategy.bands.fit_evidence_confidence);
  const reasons = [
    `fit_band=${fit === 'unscored' ? fit : fit.label}`,
    `fit_evidence_band=${confidence === 'unscored' ? confidence : confidence.label}`,
  ];
  if (fit === 'unscored') return { tier: strategy.unscored_tier, reasons: [...reasons, 'unscored_fit'] };
  if (confidence === 'unscored') return { tier: strategy.unscored_tier, reasons: [...reasons, 'unscored_fit_evidence'] };
  const tier = strategy.matrix[fit.index]?.[confidence.index];
  return tier
    ? { tier, reasons: [...reasons, 'declared_treatment_matrix'] }
    : { tier: strategy.unscored_tier, reasons: [...reasons, 'treatment_matrix_incomplete'] };
};

export const evaluateMailProgram = (input: TreatmentInput & {
  treatmentTier: TreatmentTier;
  program: string;
  definition: MailProgramConfigInput;
  rank?: number;
}): MailProgramEvaluation => {
  const tierDirectlyAllows = hasTierProgram(input.treatmentStrategy, input.treatmentTier, input.program, 'mail_programs');
  const tierAllowsException = hasTierProgram(input.treatmentStrategy, input.treatmentTier, input.program, 'mail_program_exceptions');
  const exceptionWithheld = tierAllowsException
    ? evaluateMinimums(input, input.definition.tier_exception?.minimums, false)
    : ['tier_not_declared_for_mail_program'];
  const tierAllowsProgram = tierDirectlyAllows || (tierAllowsException && exceptionWithheld.length === 0);
  const requirementWithheld = evaluateRequirements(
    input,
    input.definition.requirements,
    programReadiness(input, input.program, input.rank || 0),
    input.definition.minimums,
  );
  const withheld = [
    ...(tierAllowsProgram ? [] : exceptionWithheld),
    ...evaluateMinimums(input, input.definition.minimums, input.definition.requirements?.timing_or_strong_signals === true),
    ...requirementWithheld,
  ];
  const eligible = withheld.length === 0;
  return {
    program: input.program,
    eligible,
    reasons: eligible ? [tierDirectlyAllows ? 'tier_allows_mail_program' : 'tier_exception_allows_mail_program'] : [],
    withheld,
  };
};

export const countStrongTimingSignals = (
  signals: Array<{ id?: string; decayed_strength?: number; strength?: number }> | null | undefined,
  minimumStrength: number = 0,
): number => (
  (signals || []).filter((signal) => {
    const id = text(signal?.id);
    const strength = Number(signal?.decayed_strength ?? signal?.strength ?? 0);
    return id !== 'stale_no_signal' && Number.isFinite(strength) && strength >= minimumStrength;
  }).length
);

export const assignTreatmentAndMail = (input: TreatmentInput): TreatmentResult => {
  assertCompletePolicyInput(input);
  const assigned = assignTreatmentTier(input);
  const programs = configuredMailPrograms(input.treatmentStrategy);
  if (programs.length === 0) {
    return {
      treatment_tier: assigned.tier,
      mail_treatment: '',
      mail_program_eligible: false,
      high_confidence_mail_program_eligible: false,
      mail_eligibility_reasons: [],
      mail_withheld_reasons: ['mail_programs_not_configured'],
      reasons: assigned.reasons,
      calculation_rule_version: CALCULATION_RULE_VERSION,
    };
  }
  const evaluations = programs.map(([program, definition], rank) => evaluateMailProgram({
    ...input,
    treatmentTier: assigned.tier,
    program,
    definition,
    rank,
  }));
  const selected = evaluations.find((evaluation) => evaluation.eligible);
  const selectedDefinition = selected ? input.treatmentStrategy?.mail_programs?.[selected.program] : undefined;
  return {
    treatment_tier: assigned.tier,
    mail_treatment: selected?.program || 'none',
    mail_program_eligible: Boolean(selected),
    high_confidence_mail_program_eligible: selectedDefinition?.requires_high_confidence_buyer === true,
    mail_eligibility_reasons: selected?.reasons.map((reason) => `mail_program:${selected.program}:${reason}`) || [],
    mail_withheld_reasons: evaluations.flatMap((evaluation) => (
      evaluation.eligible ? [] : evaluation.withheld.map((reason) => `mail_program:${evaluation.program}:${reason}`)
    )),
    reasons: assigned.reasons,
    calculation_rule_version: CALCULATION_RULE_VERSION,
  };
};

/** @deprecated Use evaluateMailProgram with a declared program id. */
export const evaluateGoldenTicket = (input: TreatmentInput & {
  treatmentTier: TreatmentTier;
  assetReady?: boolean | null;
  cohortCapacityOk?: boolean | null;
}) => {
  const [selected] = configuredMailPrograms(input.treatmentStrategy);
  if (!selected) return { eligible: false, reasons: [], withheld: ['mail_programs_not_configured'] };
  const [program, definition] = selected;
  const result = evaluateMailProgram({
    ...input,
    mailProgramReadiness: {
      ...input.mailProgramReadiness,
      [program]: {
        asset_ready: input.assetReady ?? input.mailProgramReadiness?.[program]?.asset_ready,
        cohort_capacity_ok: input.cohortCapacityOk ?? input.mailProgramReadiness?.[program]?.cohort_capacity_ok,
      },
    },
    program,
    definition,
    rank: 0,
  });
  return { eligible: result.eligible, reasons: result.reasons, withheld: result.withheld };
};

/** @deprecated Use evaluateMailProgram with a declared program id. */
export const evaluateStandardPostcard = (input: TreatmentInput & { treatmentTier: TreatmentTier }) => {
  const selected = configuredMailPrograms(input.treatmentStrategy).at(-1);
  if (!selected) return { eligible: false, reasons: [], withheld: ['mail_programs_not_configured'] };
  const [program, definition] = selected;
  const result = evaluateMailProgram({ ...input, program, definition, rank: configuredMailPrograms(input.treatmentStrategy).length - 1 });
  return { eligible: result.eligible, reasons: result.reasons, withheld: result.withheld };
};

export const enrichmentBudgetRemaining = (input: {
  candidateOrTreatment: TreatmentTier | 'foundational';
  spentUsd: number;
  mailProgram?: string;
  enrichmentBudget?: EnrichmentBudgetConfigInput;
}): { ceiling: number; remaining: number; withinBudget: boolean } => {
  const ceilings = input.enrichmentBudget?.ceilings;
  const tierCeiling = ceilings?.tiers?.[input.candidateOrTreatment]
    ?? (input.candidateOrTreatment === 'foundational' ? ceilings?.foundational : undefined);
  const programCeiling = input.mailProgram ? ceilings?.mail_programs?.[input.mailProgram] : undefined;
  const ceiling = Math.max(tierCeiling ?? 0, programCeiling ?? 0);
  const remaining = Math.max(0, ceiling - (input.spentUsd || 0));
  return { ceiling, remaining, withinBudget: remaining > 0 || (input.spentUsd || 0) <= ceiling };
};
