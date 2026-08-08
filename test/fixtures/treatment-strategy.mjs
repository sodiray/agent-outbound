export const treasureValleyTreatmentStrategy = {
  bands: {
    fit: [0, 50, 65, 80, 100],
    fit_evidence_confidence: [0, 40, 60, 80, 100],
  },
  matrix: [
    ['D', 'D', 'D', 'D'],
    ['D', 'D', 'C', 'C'],
    ['enrichment_hold', 'C', 'B', 'B'],
    ['enrichment_hold', 'B', 'B', 'A'],
  ],
  unscored_tier: 'enrichment_hold',
  tiers: {
    A: {
      route: 'outbound',
      pipeline: 'tier_a',
      mail_programs: ['standard_postcard', 'golden_ticket'],
      requires_high_confidence_buyer: true,
    },
    B: {
      route: 'outbound',
      pipeline: 'tier_b',
      mail_programs: ['standard_postcard'],
      mail_program_exceptions: ['standard_postcard'],
    },
    C: { route: 'outbound', pipeline: 'tier_c' },
    D: { route: 'recycle_monitoring', pipeline: 'tier_d' },
    enrichment_hold: { route: 'enrichment', pipeline: 'enrichment_hold', holding: true },
  },
  mail_programs: {
    standard_postcard: {
      priority: 1,
      minimums: { identity_confidence: 80 },
      requirements: { mail_address_ready: true },
      tier_exception: {
        minimums: {
          strong_fit: 80,
          fit_evidence: 40,
          fit_evidence_exclusive_maximum: 60,
        },
      },
    },
    golden_ticket: {
      priority: 2,
      requires_high_confidence_buyer: true,
      minimums: {
        fit_score: 85,
        fit_evidence_confidence: 80,
        identity_confidence: 90,
        classification_confidence: 90,
        buyer_confidence: 80,
        mail_confidence: 90,
        timing_score: 70,
        strong_signal_count: 2,
        enrichment_budget_usd: 8,
      },
      requirements: {
        mail_address_ready: true,
        asset_ready: true,
        named_buyer: true,
        buyer_affiliation: true,
        buying_center_role: true,
        local_buying_authority: true,
        cohort_capacity: true,
        unsuppressed: true,
        no_material_contradiction: true,
        timing_or_strong_signals: true,
      },
      readiness: {
        asset_ready_field: 'golden_ticket_asset_ready',
        cohort_capacity_field: 'golden_ticket_cohort_ok',
      },
    },
  },
};

export const treasureValleyGoldenTicket = {
  minimums: {
    fit_score: 85,
    fit_evidence_confidence: 80,
    identity_confidence: 90,
    classification_confidence: 90,
    buyer_confidence: 80,
    mail_confidence: 90,
    timing_score: 70,
    strong_signal_strength: 60,
    strong_signal_count: 2,
    enrichment_budget_usd: 8,
  },
};

export const treasureValleyPostcard = {
  minimums: {
    identity_confidence: 80,
    strong_fit: 80,
    fit_evidence: 40,
    fit_evidence_exclusive_maximum: 60,
  },
};

export const treasureValleyEnrichmentBudget = {
  ceilings: {
    foundational: 0.15,
    A: 3,
    B: 1,
    C: 0.3,
    D: 0.15,
    enrichment_hold: 0.3,
    golden_ticket_total: 8,
    tiers: {
      A: 3,
      B: 1,
      C: 0.3,
      D: 0.15,
      enrichment_hold: 0.3,
    },
    mail_programs: { golden_ticket: 8 },
  },
};

export const treasureValleyCandidateTier = {
  bands: [0, 50, 65, 80, 100],
  tiers: ['D', 'C', 'B', 'A'],
  unscored_tier: 'hold',
};
