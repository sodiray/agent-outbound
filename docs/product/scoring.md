# Scoring

The tool scores every record on **two independent axes**:

1. **Fit score** — *How good a prospect is this, independent of timing?*
2. **Trigger score** — *How urgent is reaching out right now?*

Both are 0–100 with natural-language reasoning. The operator (or the sequencer) uses them together to prioritize.

## Why Two Scores

Local outbound breaks when fit and timing are collapsed into a single number. A lead that's a perfect fit but shows no trigger signal should wait for later — not get skipped today. A lead with a screaming timing trigger but mediocre fit is worth attempting anyway. One number hides both decisions.

## Agent-Driven Scoring

Scoring is agent-driven, not deterministic. The operator describes *what makes a good fit* and *what signals urgency* in natural language. The agent reads the full enriched record and uses judgment to produce a 0–100 score with written reasoning.

This is the same design principle as sourcing and enrichment: the config expresses **intent**, the agent interprets it against actual data. The agent can weigh nuance that deterministic field checks can't — "this is a franchise location, but it's independently owned and operated" or "they're hiring, but only for a front-desk role, not growth hiring."

## Fit Score

Stable over time. Represents ICP match. The operator describes what matters:

```yaml
score:
  fit:
    description: >-
      Evaluate how well this lead matches our ideal customer. Weight heavily:
      knowing the owner or decision-maker by name, small independent studio
      (not a franchise), having enough research to personalize outreach.
      Moderate weight: pricing visibility, social proof from reviews.
      Low weight: having a phone number on file.
```

The agent reads all enriched columns on the record — research notes, owner name, class types, pricing info, studio size, review summaries, social links — and scores holistically. It doesn't check individual fields against conditions; it reads the full picture and makes a judgment call.

Fit is re-evaluated only when the underlying enrichment data changes. It does not decay.

## Trigger Score

Time-sensitive. Represents urgency: the business is hiring right now, got recent press, the owner has been actively engaged online. The operator describes what counts:

```yaml
score:
  trigger:
    description: >-
      Evaluate timing signals that suggest this business is ready to buy now.
      Strong signal: actively hiring (growth mode, adding staff).
      Moderate signal: recent news coverage, business changes, new location.
      The agent should consider recency — a hiring post from yesterday is
      stronger than one from three weeks ago.
```

The agent reads the enriched data (hiring signals, news mentions, review activity, social freshness) and scores based on how urgent outreach feels *right now*. Recency weighting is part of the agent's judgment, not a hardcoded decay formula.

## Trigger Peak

Alongside the current trigger score, the tool tracks `trigger_score_peak` — the highest trigger score ever observed for the record. Useful for:

- Deciding whether to re-engage a lead whose triggers have cooled
- Reporting which leads were hot and when

Trigger peak only goes up. It's a permanent record of "this was worth chasing at some point."

## Prioritization

The tool produces a `priority_rank` for each record by combining both scores. The weighting between fit and trigger is configurable per list:

```yaml
score:
  priority:
    weight: { fit: 0.6, trigger: 0.4 }
```

- **Balanced (60/40)**: default
- **Timing-first (30/70)**: when trigger signals are strong predictors
- **Fit-first (80/20)**: when timing signals are noisy or absent

Priority is straightforward math on the agent's outputs — this is the one place where deterministic calculation is appropriate, because the judgment already happened in the scoring step.

Priority rank is the default ordering for launches and routes.

## Explainability

Every score comes with the agent's reasoning. The operator can ask:

```
/outbound why did Beacon Plumbing score 62 on fit?
/outbound show me the trigger reasoning for Northend Construction
```

Because the agent writes its reasoning as prose, explanations are rich and contextual:

> "Beacon Plumbing scored 62 on fit. They're in the target territory and have a strong web presence with detailed service pages. However, they're a larger operation with multiple locations and branded franchise signage, which lowers independent-studio fit. Owner name was not identified — the site lists a general manager but no clear owner-operator."

This is more useful than a checklist of pass/fail conditions. The operator understands *why* in terms of the business, not in terms of which database columns were non-null.

## Operator Overrides

The operator can pin a fit or trigger score on a specific record:

```
/outbound set fit score for Beacon Plumbing to 90 because I know the owner
```

Overrides are annotated with a reason. If the underlying enrichment data changes, the override is cleared and the record is flagged for re-review.

## Calibrating the Scoring Prompt

Scoring quality depends on how well the operator's fit/trigger descriptions capture what actually matters. The operator calibrates over time by looking at the agent's reasoning across many records at once:

> "Pull the fit reasoning for the top 20 and bottom 20 — I want to see what the agent is weighting."
> "Export everyone who scored above 80 with the scoring reasoning included."

The agent handles this by reading from the list:

```
agent-outbound query boise-plumbers --sql "
  SELECT business_name, fit_score, fit_reasoning
  FROM records_enriched
  ORDER BY fit_score DESC LIMIT 20
"

agent-outbound export boise-plumbers \
  --select "business_name, fit_score, fit_reasoning, trigger_score, trigger_reasoning" \
  --where "fit_score >= 80" \
  --to ./exports/top-fits-with-reasoning.csv
```

If the reasoning shows a pattern the operator disagrees with — the agent weighting something unintended, missing a factor the operator cares about — the operator updates the scoring description. The agent runs `score --sample 5` against the new description first, shows the reasoning on a few records, and re-scores the list once the operator is satisfied.

This is the feedback loop scoring depends on. The agent makes it quick and cheap.

## When Scoring Runs

- Fit recomputes when a record's enrichment data changes
- Trigger recomputes daily (recency matters) and whenever trigger-related enrichment changes
- Both recompute when the scoring description is modified
- The operator can trigger a full re-score: `/outbound re-score boise-plumbers`

## What Scoring Doesn't Do

- Does not change a record's sequence state
- Does not add or remove records from sequences
- Does not interact with the CRM directly — scores are synced as fields on the CRM Company record once the record enters a sequence
