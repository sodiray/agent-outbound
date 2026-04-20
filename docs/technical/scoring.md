# Scoring (Technical)

Two independent scoring dimensions: fit (stable) and trigger (time-sensitive). Both are agent-driven — the agent reads the enriched record and a natural-language description of scoring intent, then returns a 0–100 score with reasoning. Results write to columns on the record.

For the user-facing description, see `../product/scoring.md`.

## Design Principle

Scoring follows the same agent-driven pattern as sourcing and enrichment. The config expresses **intent** in natural language; the agent interprets it against the full enriched record. There are no deterministic field-check conditions or weighted rubrics — the agent uses judgment to score holistically.

This matters because:
- Enrichment data is messy and contextual. `studio_size = 'small'` misses "small but rapidly expanding." The agent reads the research notes and gets the nuance.
- Scoring criteria interact. A franchise with an independently-minded owner is different from a franchise with a corporate operator. The agent weighs these together.
- The config stays readable. `"Weight heavily: knowing the owner"` is clearer and more maintainable than `condition: "owner_name is not null", weight: 3`.

## Config Shape

```yaml
score:
  fit:
    description: >-
      Evaluate how well this lead matches our ideal customer. Weight heavily:
      knowing the owner or decision-maker by name, small independent studio
      (not a franchise), having enough research to personalize outreach.
      Moderate weight: pricing visibility, social proof from reviews.
      Low weight: having a phone number on file.

  trigger:
    description: >-
      Evaluate timing signals that suggest this business is ready to buy now.
      Strong signal: actively hiring (growth mode, adding staff).
      Moderate signal: recent news coverage, business changes, new location.
      Consider recency — a hiring post from yesterday is stronger than one
      from three weeks ago.

  priority:
    weight: { fit: 0.6, trigger: 0.4 }
```

Both `fit.description` and `trigger.description` are free-form text. The agent receives the full enriched record as context alongside the description.

## Computation

For each record:

1. **Fit**: Agent receives the enriched record + `fit.description`. Returns `{ score: 0-100, reasoning: string }`.
2. **Trigger**: Agent receives the enriched record + `trigger.description`. Returns `{ score: 0-100, reasoning: string }`.
3. **Priority**: `priority_rank = fit_score * fit_weight + trigger_score * trigger_weight`. This is the one deterministic step — math on agent outputs.

The agent call uses the `execute-step` action module with a scoring-specific prompt template that:
- Presents the full enriched record (all columns)
- Presents the scoring description
- Asks for a 0–100 integer score and a 2–4 sentence reasoning paragraph
- Uses Haiku for cost efficiency (scoring runs across every record)

### Output schema

```json
{
  "score": 78,
  "reasoning": "Strong fit — small independent studio with identified owner (Julia Hilleary). Detailed research available including class types, pricing, and studio philosophy. No franchise indicators. Moderate: has reviews but limited social presence."
}
```

## Trigger Peak

`trigger_score_peak` tracks the highest trigger score ever observed for this record. Monotonic increase only. Recomputed after every scoring run.

## Staleness

Scoring re-runs when:
- Any enrichment column on the record changes (detected via dependency hash)
- The scoring description in config changes
- The operator explicitly requests re-scoring
- For trigger: daily re-evaluation (recency is part of the agent's judgment, so the same data can produce a different trigger score tomorrow than today)

The staleness hash includes: all enrichment column values + the scoring description text + current date (for trigger only).

## Explainability

Every score stores the agent's `reasoning` field. This replaces the old per-criterion pass/fail breakdown. The reasoning is richer — it explains *why* in terms of the business, not which fields were non-null.

```json
{
  "fit": {
    "score": 72,
    "reasoning": "Good fit — independent studio, owner identified as Carrie Shanafelt. Strong web presence with detailed class offerings and pricing. Moderate size (not a solo practitioner, but not a large chain). Enough data to personalize outreach effectively."
  },
  "trigger": {
    "score": 29,
    "reasoning": "Limited timing urgency. No active hiring signals detected. Some recent review activity but no news mentions or business changes. Website appears stable — no recent updates suggesting expansion or repositioning."
  }
}
```

## Operator Overrides

`fit_score_override` and/or `trigger_score_override` columns. When set, the override wins and `*_reasoning` is annotated with the override reason. Overrides clear when enrichment data changes (the record is flagged for re-review).

## Model Routing

Scoring uses **Haiku** by default. The scoring prompt is straightforward (read data, apply description, return score + reasoning), and scoring runs across every record in the list — Haiku keeps costs proportional.

The operator can override to Sonnet per list if scoring quality needs to be higher (complex ICP definitions, subtle nuance in trigger signals).

## Inputs / Outputs

**Inputs:**
- `outbound.yaml` → `score.fit.description`, `score.trigger.description`, `score.priority.weight`
- Canonical store — all enriched columns on each record
- Current date (for trigger recency judgment)

**Outputs:**
- Canonical store — `fit_score`, `fit_reasoning`, `trigger_score`, `trigger_reasoning`, `priority_rank`, `trigger_score_peak`, `fit_updated_at`, `trigger_updated_at`
- `.outbound/.cache/hashes.json` — staleness hashes
