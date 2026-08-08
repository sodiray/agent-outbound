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
    A: { route: 'outbound', pipeline: 'tier_a', standard_postcard: true, golden_ticket: true },
    B: { route: 'outbound', pipeline: 'tier_b', standard_postcard: true, postcard_exception: true },
    C: { route: 'outbound', pipeline: 'tier_c' },
    D: { route: 'recycle_monitoring', pipeline: 'tier_d' },
    enrichment_hold: { route: 'enrichment', pipeline: 'enrichment_hold' },
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
  },
};

export const treasureValleyCandidateTier = {
  bands: [0, 50, 65, 80, 100],
};
