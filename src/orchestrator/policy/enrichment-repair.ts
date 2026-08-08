/**
 * Autonomous targeted enrichment repair for pipeline-declared holding tiers.
 * Order is always: foundational → candidate_tier → targeted (never skip depth).
 * planEnrichmentRepair is pure — policy apply persists the plan + hold reasons.
 */

import {
  DEFAULT_SCORE_ENRICHMENT_REPAIR,
  type EnrichmentRepairConfigInput,
  type TreatmentStrategyConfigInput,
} from '../../schemas/config.js';
import { resolveBuyerEvidenceFromRecord } from './evidence.js';
import { isAffirmativeFlag } from './booleanish.js';

export type EnrichmentDepth = 'foundational' | 'candidate_tier' | 'targeted';

export type EnrichmentRepairStep = {
  /** Evidence / record field that is missing or weak. */
  field: string;
  reason: string;
  depth: EnrichmentDepth;
  /** Lower runs first within a depth. */
  priority: number;
};

export type EnrichmentRepairPlan = {
  account_id: string;
  treatment_tier: string;
  candidate_tier: string;
  hold_reasons: string[];
  steps: EnrichmentRepairStep[];
  /** First incomplete depth in foundational → candidate_tier → targeted. */
  next_depth: EnrichmentDepth;
  generated_at: string;
};

export type BuyerAffiliationResolution = {
  /** confirmed | likely | unresolved | null (missing — never invent confirmed). */
  status: string | null;
  /** Buying-center role (owner, gm, office_manager, …) or null. */
  role: string | null;
};

const text = (v: unknown) => String(v ?? '').trim();
const lower = (v: unknown) => text(v).toLowerCase();

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const AFFILIATION_OK = new Set(['confirmed', 'likely']);
const AFFILIATION_UNRESOLVED = new Set(['unresolved', 'unknown', 'not_found', 'ambiguous']);

/**
 * Named-person current-affiliation + buying-center role.
 * Never invents confirmed affiliation from blank fields.
 */
export const resolveBuyerAffiliationFromRecord = (
  record: Record<string, unknown>,
): BuyerAffiliationResolution => {
  const buyer = resolveBuyerEvidenceFromRecord(record);
  return { status: buyer.affiliationStatus, role: buyer.role };
};

/**
 * Buyer-resolution hold reasons (fail closed).
 * - unresolved affiliation always holds when the status field is present
 * - pipeline-declared high-confidence tiers fail closed when affiliation or role is missing
 */
export function collectBuyerResolutionHoldReasons(input: {
  treatmentTier: string;
  namedBuyerStatus: string | null;
  namedBuyerName: string | null;
  affiliation: BuyerAffiliationResolution;
  /** Pipeline-declared tier requires the high-confidence buyer gates. */
  highTier?: boolean;
}): string[] {
  const reasons: string[] = [];
  const highTier = input.highTier === true;
  const aff = input.affiliation;

  if (aff.status && AFFILIATION_UNRESOLVED.has(aff.status)) {
    reasons.push('buyer_affiliation_unresolved');
  }

  if (highTier) {
    if (!input.namedBuyerStatus) reasons.push('named_buyer_status_missing');
    else if (!['confirmed', 'likely'].includes(lower(input.namedBuyerStatus))) {
      reasons.push('named_buyer_not_confirmed');
    }
    if (!input.namedBuyerName) reasons.push('named_buyer_name_missing');

    // Fail closed inventing affiliation on high tiers.
    if (!aff.status) reasons.push('buyer_affiliation_status_missing');
    else if (!AFFILIATION_OK.has(aff.status) && !AFFILIATION_UNRESOLVED.has(aff.status)) {
      reasons.push('buyer_affiliation_not_confirmed');
    }

    if (!aff.role) reasons.push('buying_center_role_missing');
  }

  return reasons;
}

function blank(v: unknown): boolean {
  return v === null || v === undefined || text(v) === '';
}

/**
 * Ordered repair plan: foundational first, then candidate tier, then targeted gaps.
 * Driven by treatment / candidate tier so depth does not jump ahead of readiness.
 */
export function planEnrichmentRepair(input: {
  record: Record<string, unknown>;
  hold_reasons?: string[];
  treatment_tier?: string;
  candidate_tier?: string;
  named_buyer_status?: string | null;
  named_buyer_name?: string | null;
  missing_fit_inputs?: string[];
  config?: EnrichmentRepairConfigInput;
  treatmentStrategy?: TreatmentStrategyConfigInput;
}): EnrichmentRepairPlan {
  const record = input.record || {};
  const account_id = text(record._row_id || record.id || 'unknown');
  const treatment_tier = text(input.treatment_tier ?? record.treatment_tier);
  const candidate_tier = text(input.candidate_tier ?? record.candidate_tier);
  const hold_reasons = [...(input.hold_reasons || [])];
  const steps: EnrichmentRepairStep[] = [];
  const seen = new Set<string>();
  const config = input.config;
  const mins = { ...DEFAULT_SCORE_ENRICHMENT_REPAIR.minimums, ...config?.minimums };
  const channelEvidenceCandidateTiers = config?.channel_evidence_candidate_tiers || [];
  const holdingTier = input.treatmentStrategy?.tiers?.[treatment_tier]?.holding === true;

  const push = (step: EnrichmentRepairStep) => {
    if (seen.has(step.field)) return;
    seen.add(step.field);
    steps.push(step);
  };

  // ── Foundational (identity / company) ───────────────────────────────────
  const companyRes = text(record.company_resolution);
  if (!companyRes || companyRes === 'unresolvable' || companyRes === 'unresolved') {
    push({
      field: 'company_resolution',
      reason: companyRes === 'unresolvable' ? 'identity_unresolved' : 'company_resolution_missing',
      depth: 'foundational',
      priority: 10,
    });
  }
  if (blank(record.business_name) && blank(record.name)) {
    push({
      field: 'business_name',
      reason: 'business_name_missing',
      depth: 'foundational',
      priority: 20,
    });
  }
  if (blank(record.place_id) && blank(record.google_place_id)) {
    push({
      field: 'place_id',
      reason: 'place_id_missing',
      depth: 'foundational',
      priority: 30,
    });
  }
  if (blank(record.website) && blank(record.site_url)) {
    push({
      field: 'website',
      reason: 'website_missing',
      depth: 'foundational',
      priority: 40,
    });
  }
  if (blank(record.address) && blank(record.formatted_address)) {
    push({
      field: 'address',
      reason: 'address_missing',
      depth: 'foundational',
      priority: 50,
    });
  }
  const identityConf = num(record.identity_confidence);
  if (identityConf == null || identityConf < mins.identity_confidence) {
    push({
      field: 'identity_confidence',
      reason: identityConf == null ? 'identity_confidence_missing' : `identity_confidence_below_${mins.identity_confidence}`,
      depth: 'foundational',
      priority: 60,
    });
  }

  // ── Candidate tier (fit / classification for depth selection) ───────────
  const fitScore = num(record.fit_score);
  if (fitScore == null) {
    push({
      field: 'fit_score',
      reason: 'unscored_fit',
      depth: 'candidate_tier',
      priority: 10,
    });
  }
  if (!candidate_tier) {
    push({
      field: 'candidate_tier',
      reason: 'candidate_tier_unassigned',
      depth: 'candidate_tier',
      priority: 20,
    });
  }
  const fitEvidence = num(record.fit_evidence_confidence);
  if (fitEvidence == null || fitEvidence < mins.fit_evidence_confidence) {
    push({
      field: 'fit_evidence_confidence',
      reason: fitEvidence == null ? 'fit_evidence_missing' : 'fit_evidence_thin',
      depth: 'candidate_tier',
      priority: 30,
    });
  }
  for (const mid of input.missing_fit_inputs || []) {
    push({
      field: `fit_component:${mid}`,
      reason: 'fit_component_missing',
      depth: 'candidate_tier',
      priority: 40,
    });
  }
  if (blank(record.vertical)) {
    push({
      field: 'vertical',
      reason: 'vertical_missing',
      depth: 'candidate_tier',
      priority: 50,
    });
  }
  const classConf = num(record.classification_confidence);
  if (classConf == null || classConf < mins.classification_confidence) {
    push({
      field: 'classification_confidence',
      reason: classConf == null ? 'classification_confidence_missing' : 'classification_confidence_low',
      depth: 'candidate_tier',
      priority: 60,
    });
  }

  // ── Targeted (treatment / high-tier buyer + channel evidence) ───────────
  const buyer = resolveBuyerEvidenceFromRecord(record);
  const namedStatus = input.named_buyer_status ?? buyer.status;
  const namedName = input.named_buyer_name ?? buyer.name;
  if (!namedStatus || !['confirmed', 'likely'].includes(lower(namedStatus || ''))) {
    push({
      field: 'named_buyer_status',
      reason: !namedStatus ? 'named_buyer_status_missing' : 'named_buyer_not_confirmed',
      depth: 'targeted',
      priority: 10,
    });
  }
  if (!namedName) {
    push({
      field: 'observed_buyer_name',
      reason: 'named_buyer_name_missing',
      depth: 'targeted',
      priority: 20,
    });
  }

  const affiliation = { status: buyer.affiliationStatus, role: buyer.role };
  if (!affiliation.status || AFFILIATION_UNRESOLVED.has(affiliation.status)) {
    push({
      field: 'buyer_affiliation_status',
      reason: !affiliation.status
        ? 'buyer_affiliation_status_missing'
        : 'buyer_affiliation_unresolved',
      depth: 'targeted',
      priority: 30,
    });
  }
  if (!affiliation.role) {
    push({
      field: 'buying_center_role',
      reason: 'buying_center_role_missing',
      depth: 'targeted',
      priority: 40,
    });
  }
  const buyerConf = num(record.buyer_confidence);
  if (buyerConf == null || buyerConf < mins.buyer_confidence) {
    push({
      field: 'buyer_confidence',
      reason: buyerConf == null ? 'buyer_confidence_missing' : 'buyer_confidence_low',
      depth: 'targeted',
      priority: 50,
    });
  }

  // Strong-fit thin-evidence path: targeted evidence lifts for pipeline-declared candidacy.
  if (
    fitScore != null
    && fitScore >= mins.strong_fit
    && (fitEvidence == null || fitEvidence < mins.strong_fit_evidence)
  ) {
    push({
      field: 'fit_evidence_deepening',
      reason: 'strong_fit_insufficient_evidence',
      depth: 'targeted',
      priority: 5,
    });
  }

  // Channel evidence for pipeline-declared candidate depth (mail / email when tier allows).
  const depthAllowsChannels = channelEvidenceCandidateTiers.includes(candidate_tier)
    || holdingTier;
  if (depthAllowsChannels) {
    if (blank(record.contact_email) && blank(record.email)) {
      push({
        field: 'contact_email',
        reason: 'email_missing',
        depth: 'targeted',
        priority: 70,
      });
    }
    if (
      blank(record.mailing_address)
      && blank(record.address)
      && !isAffirmativeFlag(record.mail_address_ready)
    ) {
      push({
        field: 'mailing_address',
        reason: 'mail_address_not_ready',
        depth: 'targeted',
        priority: 80,
      });
    }
  }

  // Reasons from treatment matrix / integrity that aren't already fields.
  for (const r of hold_reasons) {
    if (!steps.some((s) => s.reason === r || s.field === r)) {
      push({
        field: `hold:${r}`,
        reason: r,
        depth: 'targeted',
        priority: 90,
      });
    }
  }

  steps.sort((a, b) => {
    const depthOrder: Record<EnrichmentDepth, number> = {
      foundational: 0,
      candidate_tier: 1,
      targeted: 2,
    };
    const d = depthOrder[a.depth] - depthOrder[b.depth];
    if (d !== 0) return d;
    return a.priority - b.priority;
  });

  const next_depth: EnrichmentDepth = steps.length
    ? steps[0].depth
    : 'targeted';

  return {
    account_id,
    treatment_tier,
    candidate_tier,
    hold_reasons,
    steps,
    next_depth,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Collect holding-state reason codes from treatment + readiness + integrity + buyer gates.
 */
export function collectEnrichmentHoldReasons(input: {
  treatmentTier: string;
  treatmentReasons?: string[];
  readinessBlockers?: string[];
  integrityErrors?: string[];
  buyerHoldReasons?: string[];
  eligibilityOutcome?: string;
  eligibilityReasons?: string[];
  treatmentStrategy?: TreatmentStrategyConfigInput;
}): string[] {
  const out: string[] = [];
  const add = (code: string) => {
    const c = text(code);
    if (c && !out.includes(c)) out.push(c);
  };

  const isHoldingTier = input.treatmentStrategy?.tiers?.[input.treatmentTier]?.holding === true;
  if (isHoldingTier) {
    add('treatment_holding_tier');
    for (const r of input.treatmentReasons || []) add(r);
  }
  for (const b of input.readinessBlockers || []) {
    if (b === 'holding_tier' || b.startsWith('named_buyer') || b.startsWith('buyer_')
      || b.startsWith('buying_center') || b.includes('affiliation')) {
      add(b);
    }
  }
  for (const e of input.integrityErrors || []) add(`integrity:${e}`);
  for (const r of input.buyerHoldReasons || []) add(r);
  if (input.eligibilityOutcome === input.treatmentTier && isHoldingTier) {
    add('eligibility_holding_tier');
    for (const r of input.eligibilityReasons || []) add(r);
  }
  return out;
}
