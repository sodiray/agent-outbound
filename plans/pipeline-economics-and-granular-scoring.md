# Pipeline economics & granular scoring

Date: 2026-06-11. Driven by field feedback on the treasure-valley list: junk POIs
(ATMs, restrooms) visible in the data, low-ticket businesses surviving to scoring,
prompts/steps too heavy (cost + latency), and a score distribution clustered at 100
with no walk-in-access or revenue signal.

## Principles

- **Exit junk at the door.** A row that is not a business never becomes a record.
  Deterministic checks only at this layer — no LLM, no embedding, no dedup spend.
- **Cheapest gate that can make the call.** Deterministic field checks → small-model
  semantic gates with one tight question → enrichment → one big-model scoring pass.
  Big models are reserved for judgment (score, brief), never classification.
- **Drops are visible, exclusions are not.** Real businesses that fail ICP become
  `dropped_gate` (recoverable, auditable). Non-businesses are excluded/purged —
  never persisted, never seen.
- **Scores must discriminate.** Per-criterion 0–10 grades with anchored, skeptical
  calibration and per-criterion reasoning. All-100 cohorts are a rubric bug.

## AO changes (engine)

### 1. `source.exclude` — pre-insert exclusion rules
Config: a list of `{ description, match, conditions }` field-check rules under
`source.exclude`. A mapped row matching ANY rule is never persisted — skipped
*before* embedding/AI-dedup (saves that spend too). Counted per-rule in the
sourcing summary (`excluded` map + `filtered_out` total). Deterministic only —
this layer never calls a model.

NOTE: `primary_type = point_of_interest` is NOT junk (sampled: real painters,
cleaners, handymen). Exclude only specific non-business types + name patterns.

### 2. `purge` command — retroactive exclusion
`purge <list> [--dry-run]` applies the same `source.exclude` rules to existing
records and hard-deletes matches plus their child rows (any table with a
`record_id`/`row_id` column, discovered by introspection). Safety: timestamped DB
backup first; records with human data (interactions, field overrides, decision
overrides, score, sequence activity) are skipped and reported as `protected`.

### 3. `action: tool_call` — deterministic enrich (zero LLM)
For enrich steps that just relay a tool: `args_map` (tool arg ← record field,
merged over static `args`) and `output_map` (record field ← dot-path into the tool
result, with envelope fallback through `data`/`result`). No model call at all.
First use: `address_check` (USPS RDI via ADDRESS_CLASSIFY) — kills one LLM call
per record and the gate reads `address_rdi` directly.

### 4. Graded scoring — `score.grading: 'graded'`
Per-criterion integer grade 0–10 + required reasoning, returned by the model;
score computed in code: `100 × Σ(normalized_weight × grade/10)` over base
criteria, reward-only criteria add `round(100 × weight × grade/10)` (never
subtract), capped at 100. Anchored system prompt: skeptical reviewer, 5 = typical,
9–10 exceptional/rare, use the full scale. Breakdown rows carry `grade` (plus a
derived ternary verdict for back-compat); viz shows `n/10` chips + reasoning.
Default stays `ternary` so existing configs are untouched.

## Treasure-valley config changes

- **Source:** expand API-side `excluded_types` (medical, food/grocery/gas,
  lodging, worship, schools, government, transit, parks). Add `source.exclude`
  rules: non-business primary types (atm, public_bathroom, parks, parking,
  transit, worship, schools, government, cemetery, apartments) + name patterns
  (ATM, restroom, vending).
- **Gates (cheap-first):** vertical blocklist grows unambiguous low-ticket
  consumer categories (ice cream, nails, hair, coffee, candy, laundry). New
  `ticket_size_gate` (semantic, Llama-70B, one question): drop only when the
  average customer transaction clearly cannot be argued ≥ $1,000; unclear keeps.
  `is_a_business_gate` stays for type-less rows but shrinks to a one-liner on
  Llama-70B. `icp_semantic_gate` loses clauses other gates already enforce
  (franchise, medical) and moves to Llama-70B.
- **Models:** Kimi only where judgment concentrates — scoring + briefs. All
  gates/selection on Llama-3.3-70B; address gate has no model at all now.
- **Rubric (graded):** ticket_size 0.20, walk_in_decision_maker_access 0.25,
  revenue_scale 0.20, admin_load 0.20, operating_established 0.15; reward-only
  decision_maker_identified 0.08 + independent_local 0.07. Each criterion's
  description embeds its own 0/5/10 anchors. `minimum: 65` (recalibrated for a
  scale where a solid lead lands ~75, not 100).

## Risks / judgment calls

- Gyms, dance studios, salons-with-packages sit on the ticket-size line. The gate
  only drops clear NOs; the `ticket_size` criterion handles the gradient. Some
  currently-qualified leads (e.g. dance/fitness) may drop below the new floor on
  re-score — that is the rubric working; decision overrides exist for exceptions.
- Re-scoring under a changed rubric marks every scored record stale (dep-hash) —
  expected; briefs regenerate for the qualified set.
