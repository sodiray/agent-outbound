# Scoring stages

Date: 2026-08-08. Aligned with the owner before any code was written.

This document describes the **end state**: what scoring is once this is complete, how it
behaves, and how each edge case is treated. The work list at the bottom is deliberately
short — the design is the point.

Two existing plans cover *what a good score measures* (`pipeline-economics-and-granular-scoring.md`,
`scoring-rework-decision-makers.md`). This one covers *how scoring executes*. They do not
conflict: criteria quality is a pipeline concern, execution is an engine concern.

---

## The shape of it

Scoring is a **stage kind**, like `enrich`, `generate`, `filter` and `review`. It is not a
command, not a phase, and not a privileged concept the engine knows the meaning of.

```yaml
- kind: score
  id: score_fit_initial
  key: fit
  depends_on:
    - site_profile
  inputs:
    business_name: { from: business_name, required: true }
    site_text:     { from: site_text,     required: true }
    vertical:      { from: vertical,      required: false }
  model: openrouter/anthropic/claude-haiku-4.5
  criteria:
    - id: operational_coordination_burden
      weight: 0.22
      description: >-
        Likely number and complexity of recurring admin steps, handoffs and exceptions.
        0-2 minimal; 5 moderate; 8-10 heavy multi-system ops.
    - id: repetition_and_volume
      weight: 0.18
      description: ...
  outputs:
    fit_score:      { type: number }
    fit_breakdown:  { type: json }
    fit_reasoning:  { type: string }
```

A score stage grades a lead against declared criteria and writes a named score plus its
supporting columns. Everything else follows from that.

### Keys

`key` names the score. `fit`, `confidence`, `urgency`, `expansion_potential` — whatever the
pipeline needs. Multiple distinct scores per lead are ordinary, not a special case.

`fit` has no privileged status in the engine. It is the first key most pipelines happen to
declare.

### Placement is pipeline policy

The author decides where score stages go and how many there are. One early stage and never
again is a legitimate configuration. So is a score stage every two or three steps. The engine
has no opinion about which is correct, exactly as it has no opinion about which channels a
pipeline may use or what a review stage should present.

A pipeline that scores once, early, on thin evidence and never rescores is not an engine
failure. It is a configuration choice with a predictable consequence.

---

## Inputs and outputs are the contract

Every stage declares what it reads and what it writes, and **declaration gates access**. A
stage's execution context exposes only its declared inputs. Reading an undeclared field is not
a validation warning — it is not possible.

This is the property everything else rests on:

- The dependency graph is not a description of the pipeline that might drift from reality.
  It is the only thing reality can be.
- Therefore "has anything this score depends on changed?" is answerable exactly, not
  approximately.
- Therefore recomputation can be driven by invalidation rather than by schedule, repetition,
  or guesswork.

Under-declaration is the failure this design would otherwise introduce — a stage that omits an
input silently fails to recompute, leaving a stale score that looks fresh. Gating access at
runtime removes that failure by construction: a stage that under-declares cannot read the field
at all, so it fails loudly at once rather than quietly forever.

**This is an engine-wide property, not something the score stage brings.** It applies to every
stage kind. Where it is not enforced today, enforcing it is part of this work and is likely the
larger half.

---

## Recomputation

A score stage recomputes when a declared input has changed since it last ran. Otherwise it is
skipped, and the skip is recorded.

This makes repetition safe and cheap. Placing a score stage after every enrichment step does not
mean scoring on every pass; it means scoring whenever new evidence actually arrived. A pipeline
that re-runs with no upstream change performs no model calls and costs nothing.

It also makes score movement deterministic. A score changes only when something it reads changed —
never spontaneously, never as a side effect of an unrelated stage.

---

## Repeated keys

Two score stages may share a key. The later stage in pipeline order overwrites the score.

The consequence is intentional and needs to be understood rather than smoothed over: **a stage
positioned between two score stages reads the earlier value.** That is correct — it saw the
world as it was at that point — and it is useful, because an early cheap gate can act on a
provisional score before expensive enrichment refines it.

It is also the single most likely source of a confusing bug in this design. Treatment:

- The resolved value of a keyed score at any point in the pipeline is a function of stage order
  and nothing else. No last-writer-wins race, no non-determinism.
- Superseded values are retained in the audit trail with the stage that produced them, so
  "why did this lead get gated at 40 when its score is 78" is answerable.
- Config validation surfaces repeated keys explicitly, so an author sees that a key is written
  more than once and where.

---

## Aggregation is not a feature

A score stage that takes other score columns as inputs is an aggregate score:

```yaml
- kind: score
  id: score_priority
  key: priority
  depends_on: [score_fit_final, score_urgency]
  inputs:
    fit_score:     { from: fit_score,     required: true }
    urgency_score: { from: urgency_score, required: true }
  criteria: ...
  outputs:
    priority_score: { type: number }
```

Nothing new is required. Aggregation falls out of the input/output contract, and it invalidates
correctly for free: when `fit_score` changes, `priority_score` recomputes.

---

## What a score writes

| Situation | `<key>_score` | Breakdown | Notes |
|---|---|---|---|
| Graded normally | number | populated | The ordinary case |
| Graded, every criterion scored 0 | `0` | populated | A genuine zero is a real measurement and must remain expressible |
| No criteria declared | `null` | empty, reason `criteria_not_configured` | The engine invents no model |
| Criteria declared, no grades produced | `null` | empty, reason `not_graded` | Grading failed or returned nothing |
| Partially graded | number | populated, `missing_inputs` listed | Normalised over assessable weight |
| Required input missing | stage does not run | — | Ordinary dependency behaviour |

**A score is never fabricated.** The distinction between *graded low* and *not graded* is
load-bearing: a zero flows downstream into banding, tiering and gating as though it were
measured, and silently parks good leads. An absent score stops the record honestly and says why.

This is enforced at the persistence boundary, not merely in the arithmetic: **a non-null score
requires at least one graded declared criterion.** The invariant is asserted where the value is
written, so no future path can reintroduce the fabricated zero.

---

## Operating it

**Visibility.** Score stages appear in `pipeline_events` like any other stage — ran, skipped
(with the reason), or failed. "Scoring never happened for these records" is not a state that can
exist unnoticed, because a stage that did not run is visible as a stage that did not run.

**Cost.** Repeated scoring means repeated model calls when inputs genuinely change. The skip path
is recorded with its reason so that "why did this run cost $12" is answerable from the event log
rather than by inference. Score stages respect the same enrichment ceilings as other model steps.

**Failure.** A grading failure writes `null` with a reason and surfaces an error. It does not
retain a previous score as though it were current, and it does not write zero. A run that pays
for a hundred model calls and records a hundred unscored leads is loud.

---

## Why this design

Scoring being a separate command produced a measured failure on the Treasure Valley list on
2026-08-08: **92 records sat in the enrichment-hold bucket** not because they were unqualified
but because nothing had ever scored them, including trades businesses in the pipeline's
best-converting vertical. A further **103 records carried a fit score of 0 that nothing
produced**, and 32 were tiered on it.

Neither failure was a bug in scoring. Both were consequences of scoring living outside the
pipeline: invisible in the event log, absent from the dependency graph, and impossible to
forget only if someone remembered.

That is the same shape as every other defect found during this validation — a second execution
namespace, and something falling between the two. This design removes the namespace rather than
patching the gap.

---

## Work to get there

1. **Runtime capability boundary.** Stage execution contexts expose only declared inputs, for
   every stage kind. Reading an undeclared field fails loudly. This is the foundation and the
   largest item.
2. **`kind: score`.** Stage schema (`key`, `criteria`, `model`, declared outputs), execution, and
   persistence with the non-null-requires-a-grade invariant.
3. **Invalidation.** Recompute when a declared input changed; skip otherwise; record the skip and
   its reason.
4. **Repeated-key semantics.** Order-resolved value, superseded values retained in the audit
   trail, repeated keys surfaced by config validation.
5. **Migration.** `fit` becomes an ordinary keyed score; the global `score.criteria` block moves
   onto the stage; the standalone `score` command becomes a way to run score stages specifically;
   existing `fit_score` values are preserved, and existing fabricated zeros are re-scored or
   nulled rather than left in place.
6. **Treasure Valley config.** Declare score stages at the points that pipeline actually wants
   them, which is a separate decision from this engine work.
