/**
 * Production entry: apply deterministic outbound policy fields onto a record.
 * Called from scoring, pipeline enrich action `policy_apply`, and reconciliation.
 */

import {
  calculateFitScore,
  calculatePriority,
  assignCandidateTier,
  FIT_COMPONENT_WEIGHTS,
  type FitComponentId,
  type FitComponentGrade,
  type EvidenceConfidenceProfile,
} from './scoring.js';
import {
  assignTreatmentAndMail,
  countStrongTimingSignals,
  type TreatmentBandLadders,
  type TreatmentTier,
} from './treatment.js';
import {
  createInitialColdState,
  checkStateIntegrity,
  type AccountStateBundle,
  type LifecycleStage,
  type SequenceState,
  type WorkState,
  NEXT_ACTION_POLICY_VERSION,
} from './lifecycle.js';
import {
  buildContactPlan,
  mergeContactPlan,
  parseAccountCampaignFromRecord,
  PER_CONTACT_ALLOWANCES,
  CAMPAIGN_MAX_AGE_DAYS,
  type CampaignContact,
  type AccountCampaign,
} from './contact-campaign.js';
import { classifyEligibility, evaluateOutboundReadiness } from './readiness.js';
import { assertWorkAllowed } from './forbidden-channels.js';
import {
  buildIdentityResolution,
  buildObservationStore,
  deriveBuyerConfidence,
  deriveMailAddressReady,
  deriveMailConfidence,
  derivePhoneConfidence,
  detectContradictions,
  resolveFieldPreferringEvidence,
} from './evidence.js';
import { validateTaxonomyLabels } from './taxonomy.js';
import {
  calculateTimingScore,
  evaluateReachability,
  reachabilityToChannelFlags,
} from './timing-reachability.js';
import {
  parseCostLedger,
  withinEnrichmentCeiling,
  enrichmentSpendUsd,
  type CostLedger,
} from './cost-ledger.js';
import {
  createTransitionAudit,
  appendTransitionAudit,
  detectCollision,
  parseStageReviewJson,
} from './transition-audit.js';
import {
  evaluateCampaignProcess,
  evaluateCampaignExhaustion,
  evaluateReentry,
} from './campaign-process.js';
import {
  planEnrichmentRepair,
  collectEnrichmentHoldReasons,
  collectBuyerResolutionHoldReasons,
  resolveBuyerAffiliationFromRecord,
  type EnrichmentRepairPlan,
} from './enrichment-repair.js';
import {
  DEFAULT_SCORE_MIN_COVERAGE,
  type ActionConfidenceConfigInput,
  type BuyerConfidenceConfigInput,
  type CandidateTierConfigInput,
  type EnrichmentBudgetConfigInput,
  type EnrichmentRepairConfigInput,
  type GoldenTicketConfigInput,
  type IdentityConfidenceConfigInput,
  type MailConfidenceConfigInput,
  type PostcardConfigInput,
  type PhoneConfidenceConfigInput,
  type ReachabilityConfigInput,
} from '../../schemas/config.js';

export type PolicyApplyInput = {
  record: Record<string, unknown>;
  /** When true, recompute fit from score_breakdown grades using FIT_COMPONENT_WEIGHTS. */
  recomputeFitFromBreakdown?: boolean;
  /**
   * When true, collapse observations to durable-preferring singletons (explicit
   * rebuild). Default is append history — prior observations_json is preserved.
   */
  rebuildObservations?: boolean;
  contacts?: CampaignContact[];
  campaignId?: string;
  /** List directory for registry resolution (vertical taxonomy, etc.). */
  listDir?: string;
  /**
   * When production cost_events are summed for this account, pass the total
   * enrichment spend here so ceilings use real spend (ledger may be empty).
   */
  enrichmentSpendUsd?: number;
  /** Optional fully rebuilt ledger from cost_events (preferred over stale JSON). */
  costLedger?: CostLedger;
  /** Minimum assessable criterion-weight share required to trust a fit score. */
  minFitCoverage?: number;
  /** Configured fit and evidence-confidence ladders for treatment assignment. */
  treatmentBands?: TreatmentBandLadders;
  /** Configured literal-support identity weights and deductions. */
  identityConfidence?: IdentityConfidenceConfigInput;
  /** Configured phone evidence weights and unstructured-source maximum. */
  phoneConfidence?: PhoneConfidenceConfigInput;
  /** Configured buyer evidence weights and contradiction deductions. */
  buyerConfidence?: BuyerConfidenceConfigInput;
  /** Configured mail evidence weights and contradiction deductions. */
  mailConfidence?: MailConfidenceConfigInput;
  goldenTicket?: GoldenTicketConfigInput;
  actionConfidence?: ActionConfidenceConfigInput;
  reachability?: ReachabilityConfigInput;
  candidateTier?: CandidateTierConfigInput;
  postcard?: PostcardConfigInput;
  enrichmentRepair?: EnrichmentRepairConfigInput;
  enrichmentBudget?: EnrichmentBudgetConfigInput;
};

export type PolicyApplyResult = {
  patch: Record<string, unknown>;
  treatment_tier: string;
  mail_treatment: string;
  priority_lane: string;
  priority_rank: number;
  next_action: AccountStateBundle['next_action'];
  integrity_errors: string[];
  eligibility_outcome?: string;
  campaign?: AccountCampaign | null;
  readiness?: ReturnType<typeof evaluateOutboundReadiness>;
  enrichment_repair_plan?: EnrichmentRepairPlan | null;
  enrichment_hold_reasons?: string[];
};

const num = (v: unknown, fallback: number | null = null): number | null => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Named-buyer fields for Golden Ticket — never invent confirmed status. */
export function resolveNamedBuyerFromRecord(record: Record<string, unknown>): {
  status: string | null;
  name: string | null;
} {
  const statusRaw =
    record.named_buyer_status
    ?? record.buyer_named_status
    ?? record.primary_buyer_status
    ?? null;
  const status = statusRaw != null && String(statusRaw).trim() !== ''
    ? String(statusRaw).trim().toLowerCase()
    : null;
  const nameRaw =
    record.observed_buyer_name
    ?? record.buyer_name
    ?? record.primary_buyer_name
    ?? record.named_buyer_name
    ?? null;
  // Do not fall back to generic contact_name alone — that invents a primary buyer.
  const name = nameRaw != null && String(nameRaw).trim() !== ''
    ? String(nameRaw).trim()
    : null;
  return { status, name };
}

/**
 * Cohort capacity for Golden Ticket — must be explicitly true.
 * Accepts boolean/1/"true" flags or remaining count > 0.
 */
export function resolveCohortCapacityOk(record: Record<string, unknown>): boolean | null {
  const flag =
    record.golden_ticket_cohort_ok
    ?? record.cohort_capacity_ok
    ?? record.gt_cohort_ok
    ?? null;
  if (flag === true || flag === 1 || flag === '1' || String(flag || '').toLowerCase() === 'true') {
    return true;
  }
  if (flag === false || flag === 0 || flag === '0' || String(flag || '').toLowerCase() === 'false') {
    return false;
  }
  const remaining = num(
    record.golden_ticket_cohort_remaining ?? record.cohort_capacity_remaining,
    null,
  );
  if (remaining != null) return remaining > 0;
  return null;
}

type BreakdownItem = {
  id: string;
  grade: number;
  reasoning?: string;
  evidence_ids?: string[];
  /** Legacy viz fit_breakdown used points (0–100 contribution) instead of grade. */
  points?: number | null;
  weight?: number | null;
  /** Runner marks unsupported components; must not be discarded by parse. */
  missing?: boolean;
  unknown?: boolean;
  assessable?: boolean;
};

const FIT_IDS = new Set(Object.keys(FIT_COMPONENT_WEIGHTS));

const parseBreakdown = (raw: unknown): BreakdownItem[] => {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => {
      const gradeRaw = item?.grade;
      const points = item?.points != null && Number.isFinite(Number(item.points))
        ? Number(item.points)
        : null;
      const sub = item?.sub_score != null && Number.isFinite(Number(item.sub_score))
        ? Number(item.sub_score)
        : null;
      // Prefer explicit grade; else map sub_score 0–1 → 0–10; else leave NaN for points-only rows.
      let grade = Number(gradeRaw);
      if (!Number.isFinite(grade) && sub != null) grade = sub * 10;
      const evidence_ids = Array.isArray(item?.evidence_ids)
        ? item.evidence_ids.map((e: unknown) => String(e || '').trim()).filter(Boolean)
        : [];
      // Preserve runner missing/unknown markers; also treat empty evidence as unknown.
      const missing = Boolean(
        item?.missing === true
        || item?.unknown === true
        || (Number.isFinite(grade) && grade === 0 && evidence_ids.length === 0
          && String(item?.reasoning || '').includes('no_admissible_evidence')),
      );
      return {
        id: String(item?.id || '').trim(),
        grade: missing ? 0 : grade,
        reasoning: String(item?.reasoning || ''),
        evidence_ids,
        points: missing ? 0 : points,
        weight: item?.weight != null && Number.isFinite(Number(item.weight))
          ? Number(item.weight)
          : null,
        missing,
        unknown: missing || Boolean(item?.unknown),
        assessable: item?.assessable === false ? false : undefined,
      };
    }).filter((item) => item.id && (Number.isFinite(item.grade) || item.points != null || item.missing));
  } catch {
    return [];
  }
};

/**
 * Prefer commercial TV fit-component breakdowns over legacy score criteria.
 * Order: fit_breakdown (if any commercial ids) → score_breakdown (if any commercial) → empty.
 */
export function selectFitBreakdownSource(record: Record<string, unknown>): {
  breakdown: BreakdownItem[];
  source: 'fit_breakdown' | 'score_breakdown' | 'none';
  hasCommercialComponents: boolean;
} {
  const fromFit = parseBreakdown(record.fit_breakdown);
  const fromScore = parseBreakdown(record.score_breakdown);
  const fitHasCommercial = fromFit.some((b) => FIT_IDS.has(b.id));
  const scoreHasCommercial = fromScore.some((b) => FIT_IDS.has(b.id));
  if (fitHasCommercial) {
    return { breakdown: fromFit, source: 'fit_breakdown', hasCommercialComponents: true };
  }
  if (scoreHasCommercial) {
    return { breakdown: fromScore, source: 'score_breakdown', hasCommercialComponents: true };
  }
  return { breakdown: [], source: 'none', hasCommercialComponents: false };
}

/**
 * Recover a 0–100 fit score from legacy breakdowns when commercial fit components
 * are absent (pre-tv-fit-v1 rows). Prefer fit_breakdown points sum, else weighted grades.
 */
export function recoverLegacyFitScore(record: Record<string, unknown>): number | null {
  const fromFit = parseBreakdown(record.fit_breakdown);
  if (fromFit.length) {
    const points = fromFit
      .map((b) => (b.points != null ? Number(b.points) : Number.isFinite(b.grade) ? b.grade * 10 * (b.weight ?? 0) : 0))
      .filter((n) => Number.isFinite(n));
    if (points.length) {
      const sum = points.reduce((a, b) => a + b, 0);
      if (sum > 0) return Math.max(0, Math.min(100, Math.round(sum * 10) / 10));
    }
  }
  const fromScore = parseBreakdown(record.score_breakdown);
  if (fromScore.length) {
    let weighted = 0;
    let weightSum = 0;
    for (const b of fromScore) {
      if (!Number.isFinite(b.grade)) continue;
      const w = b.weight != null && b.weight > 0 ? b.weight : 1 / fromScore.length;
      weighted += Math.max(0, Math.min(10, b.grade)) * 10 * w;
      weightSum += w;
    }
    if (weightSum > 0 && weighted > 0) {
      // Grades already *10*weight; if weights sum ~1 this is 0–100.
      return Math.max(0, Math.min(100, Math.round(weighted * 10) / 10));
    }
  }
  return null;
}

/**
 * Derive fit_evidence_confidence from graded components that cite real
 * evidence_ids (0–100). Coverage + reasoning alone must never yield 100 with
 * zero evidence IDs — that path previously invented confident commercial grades.
 */
export function deriveFitEvidenceConfidence(breakdown: BreakdownItem[]): number {
  const fitIds = Object.keys(FIT_COMPONENT_WEIGHTS) as FitComponentId[];
  if (!fitIds.length) return 0;
  let covered = 0;
  let reasoned = 0;
  let evidenced = 0;
  let unknown = 0;
  for (const id of fitIds) {
    const hit = breakdown.find((b) => b.id === id);
    if (!hit || hit.missing || hit.unknown) {
      unknown += 1;
      continue;
    }
    const ids = Array.isArray(hit.evidence_ids) ? hit.evidence_ids.filter(Boolean) : [];
    if (ids.length === 0) {
      unknown += 1;
      continue;
    }
    covered += 1;
    if (String(hit.reasoning || '').trim().length > 0) reasoned += 1;
    evidenced += 1;
  }
  if (evidenced === 0) {
    // No source evidence IDs → confidence is unknown (0), not invent-high from coverage.
    return 0;
  }
  // Any unknown/missing component caps confidence below Tier A (80).
  if (unknown > 0) {
    const partial = evidenced / fitIds.length;
    return Math.min(79, Math.round(100 * partial * 0.9));
  }
  const coverage = covered / fitIds.length;
  const reasonRate = covered > 0 ? reasoned / covered : 0;
  const evidenceRate = covered > 0 ? evidenced / covered : 0;
  return Math.round(100 * (0.4 * coverage + 0.2 * reasonRate + 0.4 * evidenceRate));
}

export function fitComponentsFromBreakdown(
  breakdown: BreakdownItem[],
): FitComponentGrade[] {
  const fitIds = Object.keys(FIT_COMPONENT_WEIGHTS) as FitComponentId[];
  return fitIds.map((id) => {
    const hit = breakdown.find((b) => b.id === id);
    if (!hit) return { id, grade: 0, missing: true };
    const eids = Array.isArray(hit.evidence_ids) ? hit.evidence_ids.filter(Boolean) : [];
    // Empty evidence or explicit missing/unknown → unknown component, not scored 0 as weak fit.
    if (hit.missing || hit.unknown || eids.length === 0) {
      return {
        id,
        grade: 0,
        missing: true,
        unassessable: hit.assessable === false,
        reasoning: hit.reasoning,
        evidence_ids: eids,
      };
    }
    return {
      id,
      grade: Math.max(0, Math.min(10, Math.round(hit.grade))),
      reasoning: hit.reasoning,
      evidence_ids: eids,
    };
  });
}

/** Minimal persisted evidence/resolution envelope exchanged between pipeline stages. */
export type EvidenceResolutionEnvelope = {
  account_id: string;
  fit_score: number | null;
  fit_evidence_confidence: number | null;
  treatment_tier: string;
  eligibility_outcome: string;
  missing_inputs: string[];
  contradictions: unknown[];
  policy_versions: Record<string, string>;
  generated_at: string;
  source_observation_refs?: string[];
};

/**
 * Build a minimal evidence/resolution contract for policy_apply persistence.
 * Stages exchange this JSON without requiring new universal AO domain tables.
 */
export function buildEvidenceResolutionEnvelope(input: {
  account_id: string;
  fit_score: number | null;
  fit_evidence_confidence: number | null;
  treatment_tier: string;
  eligibility_outcome: string;
  missing_inputs?: string[];
  contradictions?: unknown[];
  policy_versions: Record<string, string>;
  generated_at?: string;
  source_observation_refs?: string[];
}): EvidenceResolutionEnvelope {
  const envelope: EvidenceResolutionEnvelope = {
    account_id: input.account_id,
    fit_score: input.fit_score,
    fit_evidence_confidence: input.fit_evidence_confidence,
    treatment_tier: input.treatment_tier,
    eligibility_outcome: input.eligibility_outcome,
    missing_inputs: Array.isArray(input.missing_inputs) ? input.missing_inputs : [],
    contradictions: Array.isArray(input.contradictions) ? input.contradictions : [],
    policy_versions: input.policy_versions || {},
    generated_at: input.generated_at || new Date().toISOString(),
  };
  if (input.source_observation_refs?.length) {
    envelope.source_observation_refs = input.source_observation_refs;
  }
  return envelope;
}

/**
 * Apply full deterministic policy projection to one record.
 */
export function applyOutboundPolicy(input: PolicyApplyInput): PolicyApplyResult {
  const record = input.record || {};
  const minFitCoverage = Number.isFinite(Number(input.minFitCoverage))
    ? Number(input.minFitCoverage)
    : DEFAULT_SCORE_MIN_COVERAGE;
  const rowId = String(record._row_id || record.id || 'unknown');
  // Prefer fit_breakdown commercial components; never invent zeros from legacy ticket_size score_breakdown alone.
  const selected = selectFitBreakdownSource(record);
  const breakdown = selected.breakdown;
  const fitComponents = selected.hasCommercialComponents
    ? fitComponentsFromBreakdown(breakdown)
    : [];
  const hasCommercialFit = fitComponents.some((c) => !c.missing);
  const fitCalc = hasCommercialFit ? calculateFitScore(fitComponents) : null;
  const derivedFitCoverage = fitCalc?.assessable_weight ?? null;
  const recordedFitCoverage = num(record.fit_coverage, null);
  const fitCoverage = derivedFitCoverage != null && recordedFitCoverage != null
    ? Math.min(derivedFitCoverage, recordedFitCoverage)
    : derivedFitCoverage ?? recordedFitCoverage;
  const insufficientFitCoverage = fitCoverage != null
    && fitCoverage < minFitCoverage;
  const missing_inputs = fitCalc?.missing_inputs || [];
  const source_observation_refs = (() => {
    const refs: string[] = [];
    for (const c of fitComponents) {
      for (const e of c.evidence_ids || []) {
        const id = String(e || '').trim();
        if (id && !refs.includes(id)) refs.push(id);
      }
    }
    return refs;
  })();

  let fitScore = insufficientFitCoverage ? null : num(record.fit_score, null);
  if (input.recomputeFitFromBreakdown && fitCalc && hasCommercialFit && !insufficientFitCoverage) {
    fitScore = fitCalc.fit_score;
  } else if (
    // Stored fit was wiped to 0 by the prior score_breakdown-only bug, or never set —
    // recover from legacy fit_breakdown points / score grades so treatment stays explainable.
    (fitScore == null || fitScore === 0)
    && !hasCommercialFit
  ) {
    const recovered = recoverLegacyFitScore(record);
    if (recovered != null && recovered > 0) {
      fitScore = recovered;
    }
  }

  // fit_evidence_confidence is DERIVED from the current breakdown, so a fresh
  // breakdown must be allowed to move it. Reading the stored value first and
  // deriving only when null latched it permanently: a lead scored while its
  // components cited no evidence stored 0, and 0 is a number, so re-scoring it
  // successfully could never lift it back out of enrichment_hold. The comment
  // below already promised "until re-scored" — this makes that true.
  let fitEvidence = hasCommercialFit && breakdown.length
    ? deriveFitEvidenceConfidence(breakdown)
    : num(record.fit_evidence_confidence, null);
  // Legacy scores without TV fit components: low evidence until re-scored.
  // 45 is an explicit "thin" band (not invent-high); null would hold treatment.
  if (fitEvidence == null && fitScore != null) {
    fitEvidence = 45;
  }

  // Never invent confidence defaults (70/40/50) — missing fails closed as 0.
  const identityConfidence = buildIdentityResolution(record, input.identityConfidence).identity_confidence ?? 0;
  const buyerConfidence = deriveBuyerConfidence(record, input.buyerConfidence);
  const classificationConfidence = num(record.classification_confidence, null) ?? 0;
  const timingCalc = calculateTimingScore(record);
  const timingScore = timingCalc.timing_score;
  const strongTimingSignalCount = countStrongTimingSignals(
    timingCalc.signals,
    input.goldenTicket?.minimums?.strong_signal_strength,
  );
  const storedPhoneConfidence = num(record.phone_confidence, null);
  const phoneConfidence = input.phoneConfidence
    ? derivePhoneConfidence(record, input.phoneConfidence)
    : storedPhoneConfidence ?? derivePhoneConfidence(record);
  const reachability = evaluateReachability(
    { ...record, phone_confidence: phoneConfidence },
    input.reachability,
  );
  const reachFlags = reachabilityToChannelFlags(reachability);
  // Prefer production cost_events rebuild (input.costLedger / override) over stale JSON.
  const costLedger = input.costLedger
    ?? parseCostLedger(record.cost_ledger_json, rowId);
  const enrichmentUsd = enrichmentSpendUsd({
    ledger: costLedger,
    record,
    overrideUsd: input.enrichmentSpendUsd,
  });
  const costCheck = withinEnrichmentCeiling({
    candidate_tier: String(record.candidate_tier || ''),
    treatment_tier: String(record.treatment_tier || ''),
    enrichment_usd: enrichmentUsd,
    golden_ticket: Boolean(record.golden_ticket_eligible),
    enrichmentBudget: input.enrichmentBudget,
  });
  const mailAddressReady = deriveMailAddressReady(record);
  const mailConfidence = deriveMailConfidence(record, input.mailConfidence);

  // Taxonomy validation when classification labels present — reject unsupported at write time.
  const listDir =
    input.listDir
    || (record._list_dir != null ? String(record._list_dir) : undefined)
    || (record.__list_dir != null ? String(record.__list_dir) : undefined);
  const taxonomy = validateTaxonomyLabels({
    vertical: record.vertical != null ? String(record.vertical) : null,
    sub_vertical: record.sub_vertical != null ? String(record.sub_vertical) : null,
    listDir,
  });

  const namedBuyer = resolveNamedBuyerFromRecord(record);
  const buyerAffiliation = resolveBuyerAffiliationFromRecord(record);
  const cohortCapacityOk = resolveCohortCapacityOk(record);
  const assetReadyExplicit =
    record.golden_ticket_asset_ready === true
    || record.golden_ticket_asset_ready === 1
    || record.golden_ticket_asset_ready === '1'
      ? true
      : record.golden_ticket_asset_ready === false
        || record.golden_ticket_asset_ready === 0
        || record.golden_ticket_asset_ready === '0'
        ? false
        : null;

  let treatment = assignTreatmentAndMail({
    fitScore,
    fitEvidenceConfidence: fitEvidence,
    identityConfidence,
    classificationConfidence,
    buyerConfidence,
    mailConfidence,
    timingScore,
    strongTimingSignalCount,
    mailAddressReady,
    suppressed: Boolean(record.suppressed),
    materialContradiction: Boolean(record.material_contradiction),
    localBuyingAuthority:
      record.local_buying_authority != null && String(record.local_buying_authority).trim() !== ''
        ? String(record.local_buying_authority)
        : null,
    namedBuyerStatus: namedBuyer.status,
    namedBuyerName: namedBuyer.name,
    buyerAffiliationStatus: buyerAffiliation.status,
    buyingCenterRole: buyerAffiliation.role,
    cohortCapacityOk,
    goldenTicketGates: {
      mailReady: mailAddressReady,
      assetReady: assetReadyExplicit === true,
      cohortCapacityOk: cohortCapacityOk === true,
    },
    cumulativeEnrichmentCostUsd: enrichmentUsd,
    treatmentBands: input.treatmentBands,
    goldenTicket: input.goldenTicket,
    postcard: input.postcard,
    enrichmentBudget: input.enrichmentBudget,
  });

  const taxonomyResolutionFailed = taxonomy.reasons.includes('taxonomy_not_loaded')
    || taxonomy.reasons.includes('taxonomy_version_missing')
    || taxonomy.reasons.includes('taxonomy_fallback_missing');
  const taxonomyValidationRequired = record.vertical != null || record.sub_vertical != null;
  if (taxonomyResolutionFailed && taxonomyValidationRequired) {
    const taxonomyReason = taxonomy.reasons.find((reason) => (
      reason === 'taxonomy_not_loaded'
        || reason === 'taxonomy_version_missing'
        || reason === 'taxonomy_fallback_missing'
    )) || 'taxonomy_unresolved';
    treatment = {
      ...treatment,
      treatment_tier: 'enrichment_hold',
      mail_treatment: 'none',
      golden_ticket_eligible: false,
      reasons: [...treatment.reasons, taxonomyReason, 'taxonomy_resolution_forced_hold'],
      mail_withheld_reasons: [
        ...treatment.mail_withheld_reasons,
        `taxonomy:${taxonomyReason}`,
      ],
    };
  }

  // RES-SCORING: thin / unknown evidence must not yield A/B/C or Tier D as weak fit.
  // All-unknown → enrichment_hold (not D). Any missing component → not Tier A.
  const thinEvidenceByConf = fitEvidence != null && Number(fitEvidence) < 40;
  const fitBreakdownItems = breakdown.filter((b) => FIT_IDS.has(String(b.id || '')));
  const thinEvidenceByIds =
    fitBreakdownItems.length > 0
    && fitBreakdownItems.every((b) => {
      const ids = Array.isArray(b.evidence_ids) ? b.evidence_ids.filter(Boolean) : [];
      return ids.length === 0 || b.missing || b.unknown;
    });
  // Also when commercial fit was graded but deriveFitEvidenceConfidence is 0 (no ids).
  const thinEvidenceDerivedZero =
    hasCommercialFit
    && breakdown.length > 0
    && deriveFitEvidenceConfidence(breakdown) === 0;
  const anyMissingComponent =
    hasCommercialFit
    && fitComponents.some((c) => c.missing || !(c.evidence_ids && c.evidence_ids.length));
  const allUnknownComponents =
    hasCommercialFit
    && fitComponents.length > 0
    && fitComponents.every((c) => c.missing || !(c.evidence_ids && c.evidence_ids.length));
  // Fully thin / all-unknown → enrichment_hold (never invent Tier D as weak scored fit).
  const thinEvidence = thinEvidenceByConf || thinEvidenceByIds || thinEvidenceDerivedZero || allUnknownComponents;
  if (
    thinEvidence
    && (treatment.treatment_tier === 'A'
      || treatment.treatment_tier === 'B'
      || treatment.treatment_tier === 'C'
      || treatment.treatment_tier === 'D')
  ) {
    const thinReasons = [
      ...(thinEvidenceByConf ? ['thin_evidence_confidence_below_40'] : []),
      ...(thinEvidenceByIds || thinEvidenceDerivedZero || allUnknownComponents
        ? ['thin_evidence_zero_evidence_ids']
        : []),
      'thin_evidence_forced_hold',
    ];
    treatment = {
      ...treatment,
      treatment_tier: 'enrichment_hold',
      mail_treatment: 'none',
      golden_ticket_eligible: false,
      reasons: [...treatment.reasons, ...thinReasons],
      mail_withheld_reasons: [
        ...treatment.mail_withheld_reasons,
        ...thinReasons.map((r) => `thin:${r}`),
      ],
    };
    if (fitEvidence == null || Number(fitEvidence) >= 40) {
      fitEvidence = thinEvidenceByConf ? Number(fitEvidence) : 0;
    }
  }
  if (insufficientFitCoverage) {
    const coverageReason = `fit_assessable_weight_below_${minFitCoverage}`;
    treatment = {
      ...treatment,
      treatment_tier: 'enrichment_hold',
      mail_treatment: 'none',
      golden_ticket_eligible: false,
      reasons: [...treatment.reasons, coverageReason],
      mail_withheld_reasons: [...treatment.mail_withheld_reasons, `coverage:${coverageReason}`],
    };
  }
  // Partial unknown: never Tier A / golden_ticket (confidence already capped <80 by derive).
  if (
    anyMissingComponent
    && !allUnknownComponents
    && (treatment.treatment_tier === 'A' || treatment.mail_treatment === 'golden_ticket')
  ) {
    treatment = {
      ...treatment,
      treatment_tier: treatment.treatment_tier === 'A' ? 'B' : treatment.treatment_tier,
      mail_treatment: treatment.mail_treatment === 'golden_ticket' ? 'none' : treatment.mail_treatment,
      golden_ticket_eligible: false,
      reasons: [...treatment.reasons, 'partial_unknown_blocks_tier_a'],
    };
  }

  // Buyer-resolution fail-closed: unresolved affiliation or high-tier missing
  // named-person fields force enrichment_hold (autonomous repair path).
  const buyerHoldReasons = collectBuyerResolutionHoldReasons({
    treatmentTier: treatment.treatment_tier,
    namedBuyerStatus: namedBuyer.status,
    namedBuyerName: namedBuyer.name,
    affiliation: buyerAffiliation,
    goldenTicketPath: treatment.golden_ticket_eligible || treatment.mail_treatment === 'golden_ticket',
  });
  // Unresolved affiliation holds any non-D tier; high-tier missing gates hold A.
  const forceHoldFromBuyer =
    buyerHoldReasons.includes('buyer_affiliation_unresolved')
    || (treatment.treatment_tier === 'A' && buyerHoldReasons.length > 0);
  if (forceHoldFromBuyer && treatment.treatment_tier !== 'D' && treatment.treatment_tier !== 'enrichment_hold') {
    treatment = {
      ...treatment,
      treatment_tier: 'enrichment_hold',
      mail_treatment: 'none',
      golden_ticket_eligible: false,
      reasons: [...treatment.reasons, ...buyerHoldReasons, 'buyer_resolution_forced_hold'],
      mail_withheld_reasons: [
        ...treatment.mail_withheld_reasons,
        ...buyerHoldReasons.map((r) => `buyer:${r}`),
      ],
    };
  }

  const candidate = assignCandidateTier(fitScore, input.candidateTier);

  const priority = calculatePriority({
    fitScore,
    timingScore,
    treatmentTier: treatment.treatment_tier,
    hasReplyOrInterest: Boolean(record.email_last_reply_at || record.has_reply),
    hasPromisedOrOverdueFollowup: Boolean(record.disposition_follow_up_at),
    hasBlockingRepair: Boolean(record.needs_repair),
    needsEnrichment: treatment.treatment_tier === 'enrichment_hold',
    isRecycleOrMonitor: treatment.treatment_tier === 'D',
  });

  // Prefer durable observations / retrieval snapshots over inventing from blank mutable fields.
  // Mutable scalar fallbacks arrive with provisional: true from resolveFieldPreferringEvidence.
  const companyResEv = resolveFieldPreferringEvidence({ field: 'company_resolution', record });
  const companyResolution = String(
    companyResEv.value != null && String(companyResEv.value).trim() !== ''
      ? companyResEv.value
      : (record.company_resolution || ''),
  );
  const businessStatusEv = resolveFieldPreferringEvidence({ field: 'business_status', record });
  const businessStatus = String(
    businessStatusEv.value != null && String(businessStatusEv.value).trim() !== ''
      ? businessStatusEv.value
      : (record.business_status || ''),
  );
  const isBizEv = resolveFieldPreferringEvidence({ field: 'is_a_business', record });
  const isBusinessResolved = (() => {
    if (isBizEv.value === false || isBizEv.value === 0 || isBizEv.value === '0' || isBizEv.value === 'false') {
      return false;
    }
    if (isBizEv.value === true || isBizEv.value === 1 || isBizEv.value === '1' || isBizEv.value === 'true') {
      return true;
    }
    // Fallback mutable scalar (provisional when no durable obs).
    return record.is_a_business !== false && record.is_a_business !== 0;
  })();

  const eligibility = classifyEligibility({
    isBusiness: isBusinessResolved,
    permanentlyClosed: businessStatus.toUpperCase() === 'CLOSED_PERMANENTLY',
    outOfTerritory: Boolean(record.out_of_territory),
    isDuplicate: Boolean(record.duplicate_of || record.duplicate_status === 'duplicate'),
    isNonSmbOrg: Boolean(record.non_smb_org),
    corporateNoLocalAuthority: String(record.local_buying_authority || '') === 'no'
      && String(record.ownership_type || '') === 'corporate',
    identityUnresolved: companyResolution === 'unresolvable',
    suppressed: Boolean(record.suppressed),
  });

  let lifecycle_stage = String(record.lifecycle_stage || 'cold') as LifecycleStage;
  if (!['cold', 'contacted', 'replied', 'engaged', 'meeting_booked', 'won', 'lost', 'recycled', 'disqualified'].includes(lifecycle_stage)) {
    lifecycle_stage = 'cold';
  }

  const sequence_state = (String(record.account_sequence_state || 'not_started') || 'not_started') as SequenceState;
  let work_state = (String(record.work_state || 'research_enrichment') || 'research_enrichment') as WorkState;

  let next_action = record.next_action_json
    ? (() => {
      try {
        return typeof record.next_action_json === 'string'
          ? JSON.parse(String(record.next_action_json))
          : record.next_action_json;
      } catch {
        return null;
      }
    })()
    : null;

  /** True when policy must install enrichment_repair (hold path). */
  const needsEnrichmentRepairAction = () =>
    treatment.treatment_tier === 'enrichment_hold'
    || eligibility.outcome === 'enrichment_hold';

  /**
   * A repair action the record has outgrown must be recomputed.
   *
   * next_action is carried forward from the stored column, and the only site
   * that emits `prepare_outbound` lives inside the guard below. So once a
   * record was written as `enrichment_repair` with a valid action_id, it could
   * never leave: an absorbing state. Both intended escapes are dead —
   * `reapply_policy_after_repair` is written twice and read nowhere, and no
   * code path ever produces an action_type containing `reprocess`.
   *
   * Observed on all six Treasure Valley accounts: one was tier B, fit 66,
   * `readiness.ready: true` with zero blockers, while its next_action still
   * read `treatment_enrichment_hold; fit_band=below50; weak_fit` — a state the
   * record had long left. The sequencer gates outbound on the action type, so
   * that stale field alone prevented every send.
   */
  /**
   * A holding action the record has outgrown must be recomputed.
   *
   * These action types all encode the premise "this account is not currently
   * worth outreach". When the premise stops holding — the tier improves, the
   * hold clears — the action must be recomputed, or the record is stuck in the
   * absorbing state described above.
   *
   * `enrichment_repair`/`enrichment_hold` were the first instance found. The
   * same trap then caught a record that improved from D to C: its next action
   * still read `reentry_evaluation` with reason `tier_d_no_campaign_age`, a
   * premise written when it was Tier D, so it could never be sequenced. Fixing
   * one action type and not the class left the pattern alive.
   *
   * Deliberately NOT included: `terminal_recordkeeping`, which encodes a real
   * terminal outcome (hard bounce, suppression, disqualification) and must
   * survive a tier change.
   */
  const OUTGROWABLE_HOLDING_ACTIONS = [
    'enrichment_repair',
    'enrichment_hold',
    'recycle_monitor',
    'reentry_evaluation',
    'pending_human_review',
  ];

  const tierPermitsOutreach = () => ['A', 'B', 'C'].includes(String(treatment.treatment_tier || ''));

  /**
   * `pending_human_review` is legitimate only while a review is actually
   * pending. Once the review is gone — rejected, withdrawn, or cleared — the
   * action describes a wait that will never end, and the sequencer refuses
   * every send with `non_outbound_action_pending_human_review`.
   */
  const awaitsLiveHumanReview = () => {
    const status = String(parseStageReviewJson(record.stage_review_json)?.status || '').toLowerCase();
    return status === 'pending' || status === 'edited';
  };

  const holdsStaleRepairAction = () => {
    const actionType = String(next_action?.action_type || '');
    if (!OUTGROWABLE_HOLDING_ACTIONS.includes(actionType)) return false;
    if (['enrichment_repair', 'enrichment_hold'].includes(actionType)) return !needsEnrichmentRepairAction();
    if (actionType === 'pending_human_review') return !awaitsLiveHumanReview();
    return tierPermitsOutreach();
  };

  if (!next_action || String(next_action.action_type || '').includes('reprocess') || !next_action.action_id
    || needsEnrichmentRepairAction() || holdsStaleRepairAction()) {
    if (eligibility.outcome === 'disqualified' || eligibility.outcome === 'suppressed') {
      next_action = {
        action_id: `na_terminal_${rowId}`,
        action_type: 'terminal_recordkeeping',
        account_id: rowId,
        lifecycle_stage: eligibility.outcome === 'disqualified' ? 'disqualified' : lifecycle_stage,
        sequence_state: 'cancelled',
        work_state: 'terminal_recordkeeping',
        reason: eligibility.reasons.join(','),
        on_success: 'none',
        policy_version: NEXT_ACTION_POLICY_VERSION,
      };
      lifecycle_stage = eligibility.outcome === 'disqualified' ? 'disqualified' : lifecycle_stage;
      work_state = 'terminal_recordkeeping';
    } else if (treatment.treatment_tier === 'D') {
      const cold = createInitialColdState(rowId);
      next_action = {
        ...cold.next_action,
        action_type: 'recycle_monitor',
        reason: treatment.reasons.join('; '),
        work_state: 'reentry_evaluation',
      };
      work_state = 'reentry_evaluation';
    } else if (needsEnrichmentRepairAction()) {
      // enrichment_hold → autonomous targeted repair (not generic foundational only).
      // Foundational → candidate_tier → targeted order lives in planEnrichmentRepair.
      const prelimPlan = planEnrichmentRepair({
        record: {
          ...record,
          buyer_confidence: buyerConfidence,
          mail_confidence: mailConfidence,
          mail_address_ready: mailAddressReady ? 1 : 0,
        },
        hold_reasons: [...treatment.reasons, ...buyerHoldReasons],
        treatment_tier: treatment.treatment_tier,
        candidate_tier: candidate.candidate_tier,
        named_buyer_status: namedBuyer.status,
        named_buyer_name: namedBuyer.name,
        missing_fit_inputs: missing_inputs,
      });
      next_action = {
        action_id: `na_enrichment_repair_${rowId}`,
        action_type: 'enrichment_repair',
        account_id: rowId,
        lifecycle_stage,
        sequence_state: sequence_state === 'not_started' ? 'not_started' : 'paused_repair',
        work_state: 'enrichment_repair',
        reason: prelimPlan.hold_reasons.length
          ? prelimPlan.hold_reasons.join('; ')
          : treatment.reasons.join('; ') || 'enrichment_hold',
        on_success: 'reapply_policy_after_repair',
        readiness_gates: prelimPlan.steps.slice(0, 8).map((s) => s.field),
        policy_version: NEXT_ACTION_POLICY_VERSION,
      };
      work_state = 'enrichment_repair';
    } else if (!next_action || String(next_action.action_type || '').includes('reprocess') || !next_action.action_id
      || holdsStaleRepairAction()) {
      // The stale-repair escape is repeated here deliberately. This branch is
      // the ONLY producer of `prepare_outbound`, and it was nested inside a
      // second copy of the same "only if there is no usable action" condition —
      // so entering the outer block was not enough to leave a repair action.
      next_action = {
        action_id: `na_route_${rowId}`,
        action_type: 'prepare_outbound',
        account_id: rowId,
        lifecycle_stage,
        // Holding sequence states encode the same outgrown premise as the
        // holding actions above and must clear with them. Preserving anything
        // that was not `not_started` kept `recycle_wait` on a record that had
        // improved from Tier D to Tier C: its action correctly recomputed to
        // prepare_outbound while the sequence state still gated every send with
        // `sequence_outbound_gated: sequence_state_recycle_wait`.
        //
        // Genuine in-flight states (active, waiting, paused_inbound,
        // paused_review, completed) are preserved — they describe live work or
        // a real interruption, not a stale hold.
        sequence_state: ['not_started', 'recycle_wait', 'recycle_monitor', 'paused_repair'].includes(String(sequence_state))
          ? 'active'
          : sequence_state,
        work_state: 'content_generation',
        reason: `treatment_${treatment.treatment_tier}_ready_for_campaign`,
        on_success: 'execute_or_review',
        policy_version: NEXT_ACTION_POLICY_VERSION,
      };
      work_state = 'content_generation';
    }
  }

  // Build / merge contact plan before integrity so active_contact_id is consistent.
  let campaign: AccountCampaign | null = null;
  /** True when this apply creates the first plan for the account (annual limit counter). */
  let campaignNewlyStarted = false;
  if (input.contacts?.length) {
    const fresh = buildContactPlan({
      account_id: rowId,
      campaign_id: input.campaignId || `camp_${rowId}`,
      contacts: input.contacts,
      treatment_tier: treatment.treatment_tier,
      mail_treatment: treatment.mail_treatment as AccountCampaign['mail_treatment'],
    });
    // Preserve rotation + mail-once across re-score / re-policy_apply.
    const existing = parseAccountCampaignFromRecord(record);
    campaignNewlyStarted = !existing;
    campaign = mergeContactPlan({ fresh, existing });
    // Age origin: keep existing started_at; only brand-new plans use fresh stamp.
    if (campaign && !campaign.started_at) {
      campaign = { ...campaign, started_at: fresh.started_at || new Date().toISOString() };
    }
  } else {
    // No contact rows provided: still preserve an existing plan if present.
    const existing = parseAccountCampaignFromRecord(record);
    if (existing) {
      campaign = {
        ...existing,
        mail_treatment: (treatment.mail_treatment as AccountCampaign['mail_treatment']) || existing.mail_treatment,
        per_contact_action_allowance:
          PER_CONTACT_ALLOWANCES[treatment.treatment_tier] ?? existing.per_contact_action_allowance,
        campaign_max_age_days:
          CAMPAIGN_MAX_AGE_DAYS[treatment.treatment_tier] ?? existing.campaign_max_age_days,
      };
    }
  }

  const activeFromPlan = campaign?.active_contact_id || String(record.active_contact_id || '') || null;

  // Campaign process + exhaustion BEFORE integrity so next_action is final.
  let campaignProcessBlockers: string[] = [];
  const campaignExhaustionPatch: Record<string, unknown> = {};
  if (campaign) {
    const proc = evaluateCampaignProcess({
      campaign,
      treatment_tier: treatment.treatment_tier,
      automated_actions_used: num(record.automated_actions_used, 0) ?? 0,
      last_rotation_at: record.last_contact_rotation_at != null ? String(record.last_contact_rotation_at) : null,
      campaigns_in_last_12_months: num(record.campaigns_in_last_12_months, 0) ?? 0,
    });
    campaignProcessBlockers = proc.blockers;

    const exhaustion = evaluateCampaignExhaustion({
      campaign,
      treatment_tier: treatment.treatment_tier,
      automated_actions_used: num(record.automated_actions_used, 0) ?? 0,
      channel_needs_repair: Boolean(record.needs_repair || record.channel_needs_repair),
    });
    if (exhaustion.exhausted || exhaustion.next_action_type === 'channel_repair') {
      const due = exhaustion.recycle_wait_days > 0
        ? new Date(Date.now() + exhaustion.recycle_wait_days * 86400000).toISOString()
        : null;
      next_action = {
        action_id: `na_${exhaustion.next_action_type}_${rowId}`,
        action_type: exhaustion.next_action_type,
        account_id: rowId,
        lifecycle_stage: exhaustion.exhausted ? 'recycled' : lifecycle_stage,
        sequence_state: exhaustion.sequence_state,
        work_state: exhaustion.next_action_type === 'channel_repair' ? 'channel_repair' : 'reentry_evaluation',
        reason: exhaustion.reason,
        on_success: exhaustion.exhausted ? 'reenter_or_remain' : 'resume_after_repair',
        due_at: due,
        policy_version: NEXT_ACTION_POLICY_VERSION,
      };
      if (exhaustion.exhausted) {
        lifecycle_stage = 'recycled';
        work_state = 'reentry_evaluation';
      } else {
        work_state = 'channel_repair';
      }
      const reentry = evaluateReentry({
        campaigns_in_last_12_months: num(record.campaigns_in_last_12_months, 0) ?? 0,
        suppressed: Boolean(record.suppressed),
        still_eligible: eligibility.outcome === 'eligible' || eligibility.outcome === 'active',
      });
      Object.assign(campaignExhaustionPatch, {
        campaign_exhausted: exhaustion.exhausted ? 1 : 0,
        campaign_exhaustion_reason: exhaustion.reason,
        recycle_wait_days: exhaustion.recycle_wait_days,
        reentry_allowed: reentry.allowed ? 1 : 0,
        reentry_blockers: reentry.reasons.join(';'),
      });
    }
  }

  const bundle: AccountStateBundle = {
    lifecycle_stage,
    sequence_state: next_action?.sequence_state || sequence_state,
    work_state,
    next_action,
    suppressed: Boolean(record.suppressed),
    treatment_tier: treatment.treatment_tier,
    active_contact_id: activeFromPlan,
  };
  const integrity = checkStateIntegrity(bundle);
  const integrity_errors = integrity.filter((i) => i.severity === 'error').map((i) => i.code);

  // Prefer previously persisted snapshots/observations (immutable enrich trail) over
  // thin reconstruction from mutable scalars alone. buildObservationStore appends
  // history by default (live-field rereads provisional) and never wholesale-replaces
  // prior observations unless rebuild_observations is set.
  const observationStore = buildObservationStore(record, {
    rebuildObservations:
      input.rebuildObservations === true
      || record.rebuild_observations === true
      || record.rebuild_observations === 1
      || record.rebuild_observations === '1',
    identityConfidenceConfig: input.identityConfidence,
  });
  const contradictions = detectContradictions({
    record,
    observations: observationStore.observations,
  });
  const confidenceProfile: EvidenceConfidenceProfile = {
    identity_confidence: identityConfidence,
    // Never invent classification/mail confidence defaults.
    classification_confidence: classificationConfidence,
    fit_evidence_confidence: fitEvidence ?? 0,
    buyer_confidence: buyerConfidence,
    timing_confidence: timingScore,
    email_confidence:
      reachFlags.email?.confidence
      ?? num(record.email_verification_confidence, 0)
      ?? 0,
    phone_confidence: reachFlags.phone?.confidence ?? phoneConfidence,
    linkedin_confidence: reachFlags.linkedin?.confidence ?? num(record.linkedin_confidence, 0) ?? 0,
    mail_confidence: mailConfidence,
  };

  const contentReady = Boolean(record.preliminary_snapshot);

  const collision = detectCollision({
    active_contact_id: campaign?.active_contact_id || String(record.active_contact_id || '') || null,
    proposed_contact_id: record.proposed_contact_id != null ? String(record.proposed_contact_id) : null,
    same_channel_in_flight: Boolean(record.same_channel_in_flight),
    suppressed_contact_ids: Array.isArray(record.suppressed_contact_ids)
      ? (record.suppressed_contact_ids as string[])
      : [],
  });

  // Never invent mail permission: mail_treatment none ⇒ mail ready must be false.
  const mailTreatmentAllows = treatment.mail_treatment !== 'none';
  const readiness = evaluateOutboundReadiness({
    eligible: eligibility.outcome === 'eligible' || eligibility.outcome === 'active',
    suppressed: Boolean(record.suppressed),
    identityConfidence,
    materialContradiction: Boolean(record.material_contradiction) || contradictions.length > 0,
    treatmentTier: treatment.treatment_tier,
    mailTreatment: treatment.mail_treatment,
    // Never invent channel readiness from raw contact fields — reachability owns validation.
    channels: {
      email: {
        ready: reachFlags.email?.ready === true,
        confidence: confidenceProfile.email_confidence,
      },
      phone: {
        ready: reachFlags.phone?.ready === true,
        confidence: confidenceProfile.phone_confidence,
      },
      linkedin: {
        ready: reachFlags.linkedin?.ready === true,
        confidence: confidenceProfile.linkedin_confidence,
      },
      mail: {
        // Reachability owns ready; never invent from address_rdi; mail_treatment none forces false.
        ready: mailTreatmentAllows && reachFlags.mail?.ready === true,
        confidence: confidenceProfile.mail_confidence,
      },
    },
    contentReady,
    withinBudget: costCheck.within_budget,
    collision: collision.collision || Boolean(record.channel_or_contact_collision),
    hasNextAction: Boolean(next_action),
    confidenceProfile,
    actionConfidence: input.actionConfidence,
    namedBuyerStatus: namedBuyer.status,
    namedBuyerName: namedBuyer.name,
    buyerAffiliationStatus: buyerAffiliation.status,
    buyingCenterRole: buyerAffiliation.role,
  });
  if (campaignProcessBlockers.length) {
    readiness.blockers.push(...campaignProcessBlockers);
    readiness.ready = readiness.blockers.length === 0;
  }

  // When readiness surfaces enrichment_hold (or buyer-resolution holds) while
  // treatment was already hold, ensure next_action / work_state are repair.
  const readinessForcesRepair =
    readiness.blockers.includes('enrichment_hold')
    || readiness.blockers.includes('buyer_affiliation_unresolved')
    || (treatment.treatment_tier === 'enrichment_hold');

  const enrichment_hold_reasons = collectEnrichmentHoldReasons({
    treatmentTier: treatment.treatment_tier,
    treatmentReasons: treatment.reasons,
    readinessBlockers: readiness.blockers,
    integrityErrors: integrity_errors,
    buyerHoldReasons: buyerHoldReasons,
    eligibilityOutcome: eligibility.outcome,
    eligibilityReasons: eligibility.reasons,
  });

  let enrichment_repair_plan: EnrichmentRepairPlan | null = null;
  if (readinessForcesRepair || enrichment_hold_reasons.length > 0 && treatment.treatment_tier === 'enrichment_hold') {
    enrichment_repair_plan = planEnrichmentRepair({
      record: {
        ...record,
        buyer_confidence: buyerConfidence,
        mail_confidence: mailConfidence,
        mail_address_ready: mailAddressReady ? 1 : 0,
      },
      hold_reasons: enrichment_hold_reasons,
      treatment_tier: treatment.treatment_tier,
      candidate_tier: candidate.candidate_tier,
      named_buyer_status: namedBuyer.status,
      named_buyer_name: namedBuyer.name,
      missing_fit_inputs: missing_inputs,
      config: input.enrichmentRepair,
    });
    // Install / refresh repair next_action (idempotent shape).
    if (
      eligibility.outcome !== 'disqualified'
      && eligibility.outcome !== 'suppressed'
      && treatment.treatment_tier !== 'D'
    ) {
      next_action = {
        action_id: `na_enrichment_repair_${rowId}`,
        action_type: 'enrichment_repair',
        account_id: rowId,
        lifecycle_stage,
        sequence_state:
          (next_action?.sequence_state === 'not_started' || sequence_state === 'not_started')
            ? 'not_started'
            : 'paused_repair',
        work_state: 'enrichment_repair',
        reason: enrichment_hold_reasons.join('; ') || 'enrichment_hold',
        on_success: 'reapply_policy_after_repair',
        readiness_gates: enrichment_repair_plan.steps.slice(0, 8).map((s) => s.field),
        policy_version: NEXT_ACTION_POLICY_VERSION,
      };
      work_state = 'enrichment_repair';
      bundle.work_state = work_state;
      bundle.next_action = next_action;
      bundle.sequence_state = next_action.sequence_state as SequenceState;
    }
  }

  // Per-field evidence envelope: confidence + source ids where observations exist.
  const FIELD_EVIDENCE_KEYS = [
    'business_name',
    'company_resolution',
    'is_a_business',
    'vertical',
    'sub_vertical',
    'website',
    'address',
    'observed_buyer_name',
    'named_buyer_status',
    'buyer_affiliation_status',
    'buying_center_role',
  ] as const;
  const field_evidence: Record<string, ReturnType<typeof resolveFieldPreferringEvidence>> = {};
  for (const field of FIELD_EVIDENCE_KEYS) {
    field_evidence[field] = resolveFieldPreferringEvidence({
      field,
      record,
      observations: observationStore.observations,
    });
  }

  const generatedAt = new Date().toISOString();
  const policy_versions = {
    treatment: treatment.calculation_rule_version,
    priority: priority.calculation_rule_version,
    next_action: NEXT_ACTION_POLICY_VERSION,
    timing: timingCalc.calculation_rule_version,
    reachability: reachability.calculation_rule_version,
    ...(fitCalc ? { fit: fitCalc.calculation_rule_version } : {}),
  };

  const evidenceResolution = buildEvidenceResolutionEnvelope({
    account_id: rowId,
    fit_score: fitScore ?? (typeof record.fit_score === 'number' ? Number(record.fit_score) : null),
    fit_evidence_confidence: fitEvidence,
    treatment_tier: treatment.treatment_tier,
    eligibility_outcome: eligibility.outcome,
    missing_inputs: [
      ...missing_inputs,
      ...timingCalc.missing_inputs,
    ],
    contradictions,
    policy_versions,
    generated_at: generatedAt,
    source_observation_refs: source_observation_refs.length
      ? source_observation_refs
      : observationStore.observations.map((o) => o.evidence_id).slice(0, 20),
  });

  const transitionEntry = createTransitionAudit({
    account_id: rowId,
    kind: 'next_action',
    from_state: String(record.lifecycle_stage || ''),
    to_state: lifecycle_stage,
    reason: `policy_apply treatment=${treatment.treatment_tier}`,
    evidence_ids: evidenceResolution.source_observation_refs || [],
    actor: 'system',
  });

  // Re-sync pipeline name after possible buyer-resolution hold override.
  const pipelineNameFinal =
    treatment.treatment_tier === 'A' ? 'tier_a'
      : treatment.treatment_tier === 'B' ? 'tier_b'
        : treatment.treatment_tier === 'C' ? 'tier_c'
          : treatment.treatment_tier === 'D' ? 'tier_d'
            : 'enrichment_hold';

  const patch: Record<string, unknown> = {
    identity_confidence: observationStore.identity_resolution?.identity_confidence ?? 0,
    fit_score: insufficientFitCoverage ? null : fitScore ?? record.fit_score ?? '',
    fit_coverage: fitCoverage ?? '',
    fit_evidence_confidence: fitEvidence ?? '',
    candidate_tier: candidate.candidate_tier,
    treatment_tier: treatment.treatment_tier,
    mail_treatment: treatment.mail_treatment,
    golden_ticket_eligible: treatment.golden_ticket_eligible ? 1 : 0,
    treatment_reasons: treatment.reasons.join('; '),
    treatment_json: JSON.stringify(treatment),
    priority_lane: priority.priority_lane,
    priority_rank: priority.priority_rank,
    priority_json: JSON.stringify(priority),
    lifecycle_stage,
    work_state,
    // A holding sequence state must not outlive the tier that justified it.
    // The action guard above only runs when the action itself is recomputed, so
    // a record whose action had already been corrected to `prepare_outbound`
    // kept `recycle_wait` forever and every send was refused with
    // `sequence_outbound_gated: sequence_state_recycle_wait`. Normalising here
    // catches it regardless of which branch produced the action.
    account_sequence_state: (() => {
      const resolved = String(next_action?.sequence_state || bundle.sequence_state || '');
      const holding = ['recycle_wait', 'recycle_monitor', 'paused_repair'].includes(resolved);
      const outboundAction = ['prepare_outbound', 'send_email', 'send_linkedin', 'send_mail', 'phone_attempt']
        .includes(String(next_action?.action_type || ''));
      return holding && outboundAction ? 'active' : resolved;
    })(),
    next_action_json: JSON.stringify(next_action),
    ...campaignExhaustionPatch,
    eligibility_outcome: eligibility.outcome,
    eligibility_reasons: eligibility.reasons.join('; '),
    pipeline_name: pipelineNameFinal,
    readiness_json: JSON.stringify(readiness),
    evidence_resolution_json: JSON.stringify(evidenceResolution),
    observations_json: JSON.stringify(observationStore),
    identity_resolution_json: JSON.stringify(observationStore.identity_resolution),
    source_snapshots_json: '',
    retrieval_snapshots_json: '',
    last_retrieval_snapshot_json: '',
    contradictions_json: JSON.stringify(contradictions),
    field_evidence_json: JSON.stringify(field_evidence),
    // Enrichment hold → autonomous repair queue signal.
    enrichment_hold_reasons_json: JSON.stringify(enrichment_hold_reasons),
    ...(enrichment_repair_plan
      ? {
        enrichment_repair_plan_json: JSON.stringify(enrichment_repair_plan),
        enrichment_next_depth: enrichment_repair_plan.next_depth,
      }
      : {}),
    // Named-person buyer resolution fields (never invent confirmed).
    named_buyer_status: namedBuyer.status ?? '',
    observed_buyer_name: namedBuyer.name ?? '',
    buyer_affiliation_status: buyerAffiliation.status ?? '',
    buying_center_role: buyerAffiliation.role ?? '',
    timing_json: JSON.stringify(timingCalc),
    timing_score: timingScore,
    buyer_confidence: buyerConfidence,
    mail_confidence: mailConfidence,
    mail_address_ready: mailAddressReady ? 1 : 0,
    phone_confidence: phoneConfidence,
    reachability_json: JSON.stringify(reachability),
    cost_ledger_json: JSON.stringify({
      ...costLedger,
      enrichment_usd: Math.max(costLedger.enrichment_usd || 0, enrichmentUsd),
      total_usd: Math.max(costLedger.total_usd || 0, enrichmentUsd),
    }),
    enrichment_cost_usd: enrichmentUsd,
    within_enrichment_budget: costCheck.within_budget ? 1 : 0,
    collision_json: JSON.stringify(collision),
    transition_audit_json: appendTransitionAudit(record.transition_audit_json, transitionEntry),
    policy_applied_at: generatedAt,
    policy_rule_versions: JSON.stringify(policy_versions),
  };

  if (record.vertical != null || record.sub_vertical != null) {
    patch.vertical = taxonomy.vertical || record.vertical;
    patch.sub_vertical = taxonomy.sub_vertical || record.sub_vertical;
    patch.taxonomy_version = taxonomy.taxonomy_version;
    patch.taxonomy_validation_json = JSON.stringify(taxonomy);
    if (taxonomy.fallback_applied) {
      patch.taxonomy_fallback_applied = 1;
    }
    if (taxonomy.candidate_sub_vertical) {
      patch.candidate_sub_vertical = taxonomy.candidate_sub_vertical;
    }
  }

  if (campaign) {
    patch.account_contact_plan_json = JSON.stringify(campaign);
    patch.active_contact_id = campaign.active_contact_id || '';
  }

  // Annual campaign limit counter: increment once when a brand-new outreach plan starts.
  if (
    campaignNewlyStarted
    && campaign
    && ['A', 'B', 'C'].includes(treatment.treatment_tier)
  ) {
    const prior = num(record.campaigns_in_last_12_months, 0) ?? 0;
    patch.campaigns_in_last_12_months = prior + 1;
  }

  // Only overwrite fit_score from deterministic calculator when commercial components exist.
  // Never write fit_score=0 from all-missing commercial calc while treatment used a high legacy fit.
  if (input.recomputeFitFromBreakdown && fitCalc && hasCommercialFit && !insufficientFitCoverage) {
    patch.fit_score = fitCalc.fit_score;
    patch.fit_calculation_json = JSON.stringify(fitCalc);
    patch.fit_breakdown_source = selected.source;
    patch.evidence_resolution_json = JSON.stringify({
      ...evidenceResolution,
      fit_score: fitCalc.fit_score,
    });
  } else if (!hasCommercialFit && fitScore != null && (num(record.fit_score, null) === 0 || num(record.fit_score, null) == null)) {
    // Persist recovered legacy fit so corpus no longer shows fit_score=0 with Tier B treatment.
    patch.fit_score = fitScore;
    patch.fit_breakdown_source = 'legacy_recovery';
    patch.fit_calculation_json = JSON.stringify({
      fit_score: fitScore,
      components: [],
      missing_inputs: Object.keys(FIT_COMPONENT_WEIGHTS),
      calculation_rule_version: 'tv-fit-legacy-recovery-v1',
      recovered_from: 'legacy_breakdown_points_or_grades',
      note: 'Commercial fit components not present; recovered pre-tv-fit-v1 score for treatment consistency',
    });
  }

  return {
    patch,
    treatment_tier: treatment.treatment_tier,
    mail_treatment: treatment.mail_treatment,
    priority_lane: priority.priority_lane,
    priority_rank: priority.priority_rank,
    next_action,
    integrity_errors,
    eligibility_outcome: eligibility.outcome,
    campaign,
    readiness,
    enrichment_repair_plan,
    enrichment_hold_reasons,
  };
}

/**
 * Map step kind / channel hint to a readiness proposed-action channel.
 */
function proposedChannelForStep(input: {
  stepKind?: string;
  taskType?: string;
  channel?: string;
}): 'email' | 'phone' | 'linkedin' | 'mail' | undefined {
  const kind = String(input.stepKind || '').toLowerCase();
  const task = String(input.taskType || '').toLowerCase();
  const channel = String(input.channel || '').toLowerCase();
  if (kind === 'send_email' || channel === 'email') return 'email';
  if (kind === 'linkedin_connect' || channel === 'linkedin') return 'linkedin';
  if (channel === 'phone' || task === 'human_phone' || kind === 'human_phone') return 'phone';
  if (channel === 'mail' || task === 'standard_postcard' || task === 'golden_ticket') return 'mail';
  if (channel === 'sms') return undefined;
  return undefined;
}

/**
 * True when this step is an automated external send that hard readiness may block.
 * Manual parks (human_phone, mail tasks) are never hard-blocked by readiness —
 * awaiting_manual is the correct outcome. Drafts and dry-runs are exempt.
 */
function isHardReadinessExternalSend(input: {
  stepKind?: string;
  intent?: string;
  dryRun?: boolean;
}): boolean {
  if (input.dryRun) return false;
  if (String(input.intent || 'send').toLowerCase() === 'draft') return false;
  const kind = String(input.stepKind || '').toLowerCase();
  return kind === 'send_email' || kind === 'linkedin_connect';
}

/**
 * Build evaluateOutboundReadiness input from live record fields (same sources as policy apply).
 * Uses timing-reachability + cost-ledger so hard readiness does not invent permission
 * from scores alone or ignore spend ceilings.
 * Fail closed: missing content or next_action never readiness-pass.
 * Raw contact fields alone never mark a channel ready (validation confidence required).
 */
export function readinessInputFromRecord(input: {
  record: Record<string, unknown>;
  stepKind?: string;
  taskType?: string;
  channel?: string;
  stepId?: string;
  /** Optional production spend override (sum of cost_events). */
  enrichmentSpendUsd?: number;
  costLedger?: CostLedger;
  actionConfidence?: ActionConfidenceConfigInput;
  reachability?: ReachabilityConfigInput;
  enrichmentBudget?: EnrichmentBudgetConfigInput;
}): Parameters<typeof evaluateOutboundReadiness>[0] {
  const record = input.record || {};
  const rowId = String(record._row_id || record.id || 'unknown');
  // Never invent confidence defaults — missing → 0 (fail closed on gates).
  const identityConfidence = num(record.identity_confidence, null) ?? 0;
  const buyerConfidence = deriveBuyerConfidence(record);
  const classificationConfidence = num(record.classification_confidence, null) ?? 0;
  const timingCalc = calculateTimingScore(record);
  const timingScore = timingCalc.timing_score;
  const fitEvidence = num(record.fit_evidence_confidence, null) ?? 0;
  const reachability = evaluateReachability(record, input.reachability);
  const reachFlags = reachabilityToChannelFlags(reachability);

  // Prefer production cost_events rebuild when caller hydrates; else ledger JSON / scalar.
  const costLedger = input.costLedger
    ?? parseCostLedger(record.cost_ledger_json, rowId);
  const enrichmentUsd = enrichmentSpendUsd({
    ledger: costLedger,
    record,
    overrideUsd: input.enrichmentSpendUsd,
  });
  const costCheck = withinEnrichmentCeiling({
    candidate_tier: String(record.candidate_tier || ''),
    treatment_tier: String(record.treatment_tier || ''),
    enrichment_usd: enrichmentUsd,
    golden_ticket: Boolean(
      record.golden_ticket_eligible === true
      || record.golden_ticket_eligible === 1
      || record.golden_ticket_eligible === '1',
    ),
    enrichmentBudget: input.enrichmentBudget,
  });
  // Prefer live ledger check; honor explicit false flags from apply patch / operators.
  const withinBudgetFlag =
    record.within_enrichment_budget === false
    || record.within_enrichment_budget === 0
    || record.within_enrichment_budget === '0'
    || record.within_budget === false
    || record.within_budget === 0
    || record.within_budget === '0'
      ? false
      : costCheck.within_budget;

  const eligibilityOutcome = String(record.eligibility_outcome || '').toLowerCase();
  // Prefer durable observations over mutable company_resolution / is_a_business scalars.
  const companyResEv = resolveFieldPreferringEvidence({ field: 'company_resolution', record });
  const companyResolution = String(
    companyResEv.value != null && String(companyResEv.value).trim() !== ''
      ? companyResEv.value
      : (record.company_resolution || ''),
  );
  const isBizEv = resolveFieldPreferringEvidence({ field: 'is_a_business', record });
  const isBusiness = (() => {
    if (isBizEv.value === false || isBizEv.value === 0 || isBizEv.value === '0' || isBizEv.value === 'false') {
      return false;
    }
    if (isBizEv.value === true || isBizEv.value === 1 || isBizEv.value === '1' || isBizEv.value === 'true') {
      return true;
    }
    return record.is_a_business !== false && record.is_a_business !== 0;
  })();
  const eligible = eligibilityOutcome
    ? (eligibilityOutcome === 'eligible' || eligibilityOutcome === 'active')
    : (isBusiness
      && !record.suppressed
      && companyResolution !== 'unresolvable');

  const treatmentTier = String(record.treatment_tier || '');
  const mailTreatment = String(record.mail_treatment || 'none');
  const proposedChannel = proposedChannelForStep(input);

  const mailConfidence = deriveMailConfidence(record);

  const confidenceProfile: EvidenceConfidenceProfile = {
    identity_confidence: identityConfidence,
    classification_confidence: classificationConfidence,
    fit_evidence_confidence: fitEvidence,
    buyer_confidence: buyerConfidence,
    timing_confidence: timingScore,
    email_confidence:
      reachFlags.email?.confidence
      ?? num(record.email_verification_confidence, 0)
      ?? 0,
    phone_confidence: reachFlags.phone?.confidence ?? num(record.phone_confidence, 0) ?? 0,
    linkedin_confidence:
      reachFlags.linkedin?.confidence ?? num(record.linkedin_confidence, 0) ?? 0,
    // Never invent mail confidence from identity or address_rdi alone.
    mail_confidence: mailConfidence,
  };

  // Explicit booleans — undefined must not readiness-pass (fail closed).
  const hasContent = Boolean(record.preliminary_snapshot);
  const hasNext = Boolean(record.next_action_json);
  const namedBuyer = resolveNamedBuyerFromRecord(record);
  const buyerAffiliation = resolveBuyerAffiliationFromRecord(record);
  const mailTreatmentAllows = mailTreatment !== 'none' && mailTreatment !== '';

  return {
    eligible,
    suppressed: Boolean(record.suppressed),
    identityConfidence,
    materialContradiction: Boolean(record.material_contradiction),
    treatmentTier,
    mailTreatment,
    // Never invent ready from raw email/phone/linkedin/address presence.
    channels: {
      email: {
        ready: reachFlags.email?.ready === true,
        confidence: confidenceProfile.email_confidence,
      },
      phone: {
        ready: reachFlags.phone?.ready === true,
        confidence: confidenceProfile.phone_confidence,
      },
      linkedin: {
        ready: reachFlags.linkedin?.ready === true,
        confidence: confidenceProfile.linkedin_confidence,
      },
      mail: {
        // Never invent mail permission when mail_treatment is none.
        ready: mailTreatmentAllows && reachFlags.mail?.ready === true,
        confidence: confidenceProfile.mail_confidence,
      },
    },
    contentReady: hasContent,
    withinBudget: withinBudgetFlag,
    hasNextAction: hasNext,
    confidenceProfile,
    actionConfidence: input.actionConfidence,
    namedBuyerStatus: namedBuyer.status,
    namedBuyerName: namedBuyer.name,
    buyerAffiliationStatus: buyerAffiliation.status,
    buyingCenterRole: buyerAffiliation.role,
    proposedAction: proposedChannel
      ? {
        kind: input.stepKind,
        channel: proposedChannel,
        taskType: input.taskType,
        stepId: input.stepId,
      }
      : undefined,
  };
}

/**
 * Guard an outbound step using project policy.
 * Always hard-blocks forbidden work. When config.policy.enforce_readiness === true,
 * also hard-blocks automated external sends (send_email intent=send, linkedin_connect)
 * when evaluateOutboundReadiness is not ready — unless dryRun or intent=draft.
 * Does not hard-block human_phone / manual_task parks (awaiting_manual is correct).
 */
export function guardChannelExecution(input: {
  config?: any;
  record: Record<string, unknown>;
  stepKind?: string;
  taskType?: string;
  channel?: string;
  stepId?: string;
  intent?: string;
  dryRun?: boolean;
}): { allowed: boolean; reason?: string; blockers?: string[] } {
  try {
    assertWorkAllowed({
      kind: input.stepKind,
      taskType: input.taskType,
      channel: input.channel,
      stepId: input.stepId,
    });
  } catch (e) {
    return { allowed: false, reason: (e as Error).message };
  }

  const policy = input.config?.policy;
  if (!policy) return { allowed: true };

  const forbidden = new Set(
    (Array.isArray(policy.forbidden_channels) ? policy.forbidden_channels : []).map((x: string) => String(x).toLowerCase()),
  );
  const kind = String(input.stepKind || '').toLowerCase();
  const task = String(input.taskType || '').toLowerCase();
  if (forbidden.has(kind) || forbidden.has(task) || forbidden.has(String(input.channel || '').toLowerCase())) {
    return { allowed: false, reason: `project policy forbids ${kind || task || input.channel}` };
  }

  // Campaign process (age / allowance / quiet / annual) always gates automated external sends —
  // independent of soft readiness — so tier ceilings cannot be bypassed when enforce_readiness is off.
  if (isHardReadinessExternalSend({
    stepKind: input.stepKind,
    intent: input.intent,
    dryRun: input.dryRun,
  })) {
    const campaign = parseAccountCampaignFromRecord(input.record);
    if (campaign) {
      const proc = evaluateCampaignProcess({
        campaign,
        treatment_tier: String(input.record.treatment_tier || ''),
        automated_actions_used: num(input.record.automated_actions_used, 0) ?? 0,
        last_rotation_at:
          input.record.last_contact_rotation_at != null
            ? String(input.record.last_contact_rotation_at)
            : null,
        campaigns_in_last_12_months: num(input.record.campaigns_in_last_12_months, 0) ?? 0,
      });
      if (!proc.allowed) {
        return {
          allowed: false,
          reason: `campaign_process: ${proc.blockers.join(', ') || 'blocked'}`,
          blockers: proc.blockers,
        };
      }
    }
  }

  // Soft / off: never hard-block on readiness alone.
  if (policy.enforce_readiness !== true) return { allowed: true };

  // Manual parks and drafts/dry-runs are not hard-blocked by readiness.
  if (!isHardReadinessExternalSend({
    stepKind: input.stepKind,
    intent: input.intent,
    dryRun: input.dryRun,
  })) {
    return { allowed: true };
  }

  const readiness = evaluateOutboundReadiness(readinessInputFromRecord({
    record: input.record,
    stepKind: input.stepKind,
    taskType: input.taskType,
    channel: input.channel,
    stepId: input.stepId,
    actionConfidence: input.config?.score?.action_confidence,
    reachability: input.config?.score?.reachability,
    enrichmentBudget: input.config?.score?.enrichment_budget,
  }));

  if (!readiness.ready) {
    const blockers = readiness.blockers || [];
    return {
      allowed: false,
      reason: `readiness_not_ready: ${blockers.join(', ') || 'unknown'}`,
      blockers,
    };
  }

  return { allowed: true };
}

export type { TreatmentTier };
