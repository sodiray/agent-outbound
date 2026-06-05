# Plan: Scoring Rework + Decision-Maker Sourcing

## Problem

The single-score criteria encode a narrow "tiny local retail SMB with foot traffic" ICP. They reward
a customer-facing storefront, a known *owner* name, and a short keep-list of appointment verticals.
A regional fiber ISP with a Boise HQ (Fatbeam) — which should be a ~100 — scores 18 because:
- `brick_mortar` tests customer-facing retail (Fatbeam has an HQ, not a shop).
- `owner_reachable` penalizes missing owner data we don't even source, and "owner" is the wrong lens.
- `vertical_admin_heavy` excludes telecom, which is in fact extremely admin-heavy.

## Decisions (from the user)

- **Keep industry targeting, but broaden it**: the score still favors target industries, but B2B /
  infrastructure / telecom count; the storefront requirement is dropped.
- **Decision-makers: source + AI-pick, reward never penalize**: a new enrichment sources
  leadership/management/ownership contacts and an AI chooses the best decision-maker; the score
  rewards having one but NEVER lowers a lead for missing/unsourced contact data.

## New rubric (single score, 0-100)

Base criteria (weighted average, weights sum to 1.0):
1. **industry_fit** (0.30) — broadened. In scope: any admin-heavy operation — trades & contractors,
   auto, home services, professional & B2B services, healthcare-adjacent ops, logistics,
   **telecom/ISP & infrastructure**, etc. NOT limited to consumer-facing/appointment verticals.
2. **admin_operational_load** (0.30) — the pain: meaningful back-office burden (billing, provisioning,
   scheduling, dispatch, contracts, support). Infrastructure/telecom scores high.
3. **real_location** (0.20) — a verifiable physical operating location (office/HQ/facility). Retail
   foot traffic NOT required; a corporate HQ fully counts. Do not penalize absence of walk-in retail.
4. **operating_and_established** (0.20) — currently operational + a real, active, established business.

Reward-only bonus (never penalizes):
5. **decision_maker_identified** — adds a capped bonus when a clear decision-maker was sourced;
   contributes 0 (neutral) when absent/unsourced. Never reduces the score.

Dropped: `brick_mortar` (retail), `owner_reachable` (owner-centric, penalizing), narrow
`vertical_admin_heavy`, retail-centric `manual_intake_no_selfserve` (folded into admin_operational_load).

Fatbeam against this: industry_fit ✅, admin_operational_load ✅ (ISP), real_location ✅ (Boise HQ,
Commercial RDI), operating_and_established ✅ → base ≈ 100; decision_maker neutral until sourced.

## Stage A — reward-only scoring mechanic + new criteria

**Codex (code):**
- Extend `ScoringCriterionSchema` (src/schemas/config.ts) with `reward_only?: boolean` (default false).
- In the scoring runner's `scoreAxisCriteria` (src/orchestrator/scoring/runner.ts):
  - Split criteria into base (reward_only=false) and reward-only (true).
  - `base = weightedAvg(base criteria verdicts)` normalized over the base weights → 0-100.
  - `bonus = Σ (reward_only.weight * verdictValue) * 100` over reward-only criteria with a positive
    verdict (yes/partial). Absent / "no" / not-evaluated reward-only criteria contribute 0.
  - `final = min(100, round(base + bonus))`.
  - Keep the per-criterion breakdown (mark reward-only entries so the UI can show them as a bonus).
- tsc green. Do not commit.

**Me (config + validation):** rewrite meridian `outbound.yaml` `score.criteria` to the rubric above
(4 base + 1 reward_only decision_maker referencing the Stage-B output). Re-score Fatbeam → expect
~100 (base all-yes, decision_maker neutral). Validate in Chrome.

## Stage B — decision-maker sourcing enrichment

**Codex (code + config step):** a new enrich step (e.g. `decision_makers`) that:
1. Sources candidate leadership/management/ownership contacts for the business. v1 data source:
   scrape the company's likely pages (about, team, leadership, our-team, contact, management) via the
   existing `firecrawl` FIRECRAWL_EXTRACT tool, and extract candidate {name, title, email?} entries.
   (Future: a dedicated people-data API; out of scope for v1.)
2. Sends the candidates to an AI that picks the single best **decision-maker** (most senior /
   most relevant authority) — or none if no real candidate. Returns
   `decision_maker_name`, `decision_maker_title`, `decision_maker_email` (if found),
   `decision_maker_confidence`, and the candidate list for audit.
3. Never fails the lead — empty results are a normal outcome (the reward-only criterion handles it).

Then wire the `decision_maker_identified` reward-only criterion to read these outputs. Validate on
Fatbeam (should find leadership on fatbeamfiber.com) and a lead with no team page (stays neutral).

## Validation (mine, Chrome + CLI)

- Stage A: re-score Fatbeam → ~100 with sensible reasoning (no storefront/owner penalties); spot-check
  a few existing leads didn't regress nonsensically. Chrome: detail shows the new criteria + bonus.
- Stage B: run the decision_maker step on Fatbeam → a real decision-maker surfaced; score gains the
  bonus; a lead with no leadership page stays neutral (no penalty).

## Notes

- Industry targeting primarily belongs in **sourcing** (who you pull); the score's `industry_fit`
  is a soft signal, not a hard gate. Deliberate single-lead intakes (Fatbeam) should not be punished
  by it.
- If a deliberately-pushed lead is still dropped by a gate or floor, `override keep` remains the
  escape hatch.
