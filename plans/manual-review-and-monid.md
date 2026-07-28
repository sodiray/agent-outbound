# Plan: Manual Review Phase + Monid Tool Provider

## Problem

Two problems that turn out to be one.

**We can't afford to enrich everything.** The `treasure-valley` list holds 2078 records. Enrichment
is per-record paid work — `site_profile` has already run 777 times, `decision_makers` 372. Every new
data source we add multiplies that. There is no point in the pipeline where a human can look at a
batch of leads and kill the obvious junk before we spend money on it. The gates we have are either
free-and-dumb (`field_check`) or paid-and-smart (semantic, enrich); there is no free-and-smart, and a
human giving a lead a 10-second look *is* free-and-smart.

**Our tool surface is a hand-maintained list of seven.** `CommandProvider.searchTools` lowercases the
query and runs `haystack.includes(query)` over the tools written by hand into `mcp.json`. The
config-author step — an LLM whose whole job is to compose pipeline steps by searching for tools in
natural language — is searching a seven-item array by substring. It cannot author a step for a
capability we did not pre-wire. Monid is a single CLI over hundreds of data endpoints with semantic
discovery, and it maps one-to-one onto the `ToolProvider` interface we already have.

These are one problem because Monid makes enrichment cheaper to *add* and therefore easier to
overspend on. The review phase is what makes the Monid work safe. **Review lands first.**

## Design principle

**A review verdict is an override.** We already have a durable, auditable, replay-surviving store for
human intent about a record (`overrides`, per `decision-overrides.md`) and a reconciler that honors it
on every run. A review decision is exactly that directive, authored from a queue instead of one lead
at a time. Do not add a `review_decisions` table.

**"Awaiting review" is derived, not a stored lifecycle state.** Consistent with `runtime/status.ts`,
where the whole lead lifecycle is computed and never persisted.

**A review step is a drop gate that costs nothing and never resolves itself.** That framing gets us
the existing cost-ordering scheduler for free: `economicallyReady` already refuses to run an expensive
step on a record while a cheaper drop gate is pending.

---

## The load-bearing problem: review is not a data dependency

`pipeline-graph.ts` infers `depends_on` from **dataflow**. `producedFieldsByStep` only inspects
`enrich` steps' `outputs` / `columns` / target columns. A review step produces no fields, so nothing
would depend on it, so `dataReady` would let every downstream step sail past it into paid enrichment.
The gate would be decorative — and the failure is **silent**, visible only as a bill.

Decision: **positional barrier.** In `buildSteps`, every step whose index is greater than a review
step's index gets an implicit dependency on that review step. This matches how a human reads an
ordered YAML pipeline and requires no authoring discipline. The rejected alternative — explicit
`runs_after: [review_x]` on each downstream step — is brittle exactly where brittleness is invisible:
the config-author LLM forgets it and we overspend without an error.

The barrier means step **tier only orders what is listed before the review step**. Anything after it
waits regardless of cost.

---

## Phase 1 — `kind: review` as a blocking pipeline step

### Config schema (`src/schemas/config.ts`)

`PipelineReviewStepSchema` into the `PipelineStepSchema` discriminated union:

```yaml
- kind: review
  id: sourced_review
  label: Sourced leads          # review-page tab name
  description: >-
    Eyeball the sourced record before we spend anything enriching it.
  fields: [name, address, category, phone, website, place_types, rating, review_count]
  when:                          # optional: route only a subset into review
    match: all
    conditions: [...]
```

No `on_timeout`, deliberately. A review waits forever until a human acts — that is the feature.

### Dataflow (`src/orchestrator/pipeline/dataflow.ts`)

- `stepTier` → review = **1**. Free `field_check` gates (tier 0) still run first and shrink the queue
  for free; review lands ahead of every paid semantic filter and enrich step.
- `buildSteps` → `executable: true`, `dropGate: true`, `cost: 0`, plus the implicit downstream edges.
- `onStepOutcome` → a **new branch**. Not `writeFilterFailure` — that sets `disqualified_at` /
  `needs_review` / `pipeline_flags` and would drop or flag the record. Wrong semantics: a parked
  record is neither dropped nor flagged. The review branch writes a `pipeline_events` row
  (`passed=0, reason='awaiting_review'`) and returns `{ resolved: false }` **without** `errored: true`.
- `summary.awaiting_review` counter, surfaced in the `endRun` message. Without it, a run that parks
  900 records reads as a run that silently did nothing.

### Step executor (`src/orchestrator/pipeline/step-executor.ts`)

`executeStepBatch` throws `unsupported_pipeline_step_kind` for anything but filter/enrich. Add the
review branch: read active verdicts from `overrides`, return pass / drop / awaiting per record. No
LLM, no tools, no network.

### Loop hazard

`advance()` recurses until `nextStep` returns null. Returning `{ resolved: false }` for a step that
remains *applicable* is an infinite loop. `makeApplicable` must treat "review step that already has an
`awaiting_review` event and no verdict" as **not applicable**, so `nextStep` skips it, finds nothing
else ready (the barrier), and the record parks cleanly as complete.

### Verdict persistence

Reuse `overrides` unchanged:

| Verdict | Override |
|---|---|
| pass | `kind='keep'`, `step_id=<review step id>`, `created_by='review:<stage>'` |
| drop | `kind='drop'`, `step_id=''`, `created_by='review:<stage>'` |

Drops stay **blanket** (`step_id=''`), per the existing override design. Stage provenance rides in
`created_by`, which keeps the audit trail intact without touching `reconcileOverrides`'s `coversGate`
logic — a step-scoped drop would have required changing semantics that four live records already
depend on.

This buys the whole replay story for free: `initializeResolved` already force-resolves gates a human
chose to keep, so **`--reapply` will not re-queue an already-reviewed record**, and dropped records
leave the in-play set entirely.

### Dry run (`src/orchestrator/pipeline/shared.ts`)

`simulatePipeline` must model the barrier, or `pipeline --dry-run` keeps projecting cost for work that
is actually parked behind a human.

### Graph validation

Three coordinated edits so the implicit edge does not fight the existing machinery:
`validatePipelineGraph` (do not raise the "missing `depends_on`" error for implicit review edges),
`mergeInferredPipelineDependencies`, and `pipelineDependencyDiff`.

### CLI (`src/commands/review.ts`)

`review list|pass|drop <list> --stage <id> [--record <id>] [--reason ...]`. Parity with the page, per
the existing `overrides.ts` pattern, and the way this gets tested without a browser.

### Test first

The barrier is the feature. Before anything is built on top: a test that a record with a review step
in its pipeline **does not** reach a downstream enrich step until a verdict exists. If this is wrong,
everything above it is decorative.

---

## Phase 2 — The review page

### API (`src/viz/server.ts`, `src/viz/data.ts`)

- `GET /api/meta` gains `review_stages[]`: `{ id, label, description, fields[], awaiting_count }`
- `GET /api/review/:stageId?limit&cursor` — the awaiting queue, projected to that stage's `fields`
- `POST /api/review/:stageId/decisions` — **batch** `[{ row_id, verdict, reason? }]` → `insertOverride`
- `DELETE /api/review/decisions/:id` — undo via `clearOverride` (soft-delete already exists)

`POST /api/territories/:id/notes` is the precedent; the viz server is already read-write.

### UI (`src/viz/ui/src/ReviewRoute.tsx`)

A third route beside `/` (list) and `/map`. Its own file — `App.tsx` is already 1378 lines and
`MapRoute.tsx` is the precedent for a route living apart.

Tabs come from `meta.review_stages`, one per configured review step, each showing its awaiting count.

For a 5–15-second-per-lead pass the interaction model matters more than the layout:

- Dense cards: name, address, category, phone, website, place types, rating / review count
- Keyboard-driven: `J`/`K` move, `X` drop, `Space`/`Enter` pass, `U` undo
- Decisions accumulate **client-side** and submit as one POST. Per-keystroke round-trips against a
  2000-record queue will feel broken.

Out of scope for v1: triggering a pipeline run from the page. The viz server does not spawn runs
today, and the operator re-running `pipeline` after a review pass is a fine seam.

---

## Phase 3 — `MonidProvider`

`src/orchestrator/runtime/providers/monid.ts`, implementing the existing `ToolProvider` interface —
which already is Monid's shape:

| `ToolProvider` | Monid |
|---|---|
| `searchTools(queries, limit)` | `monid discover -q -l -s -j` |
| `getSchemas(slugs)` | `monid inspect -p -e -j` |
| `executeTool(slug, args)` | `monid run … -j`, then poll `runs get` |

**Schema flattening.** `inspect` returns `input.{pathParams, queryParams, body}`. Our `args` /
`args_map` model is flat, so flatten into one JSON Schema **while retaining the param→location map**,
so `executeTool` can split values back into `--path` / `--query` / `-i`.

**Slug casing will bite.** `tool-catalog.ts` uppercases every slug (`normalizeToolSlug`) and uses it as
the catalog key. Monid endpoints are case-sensitive paths (`/damilo/google-maps-scraper`). The provider
needs a stable synthetic slug (`MONID__APIFY__DAMILO_GOOGLE_MAPS_SCRAPER`) with the real
provider/endpoint carried on the schema. We have already burned a day on exactly this shape of bug with
Composio's case-sensitive cache.

**Status mapping.** `BLOCKED` must throw a *distinct* error naming the workspace control that blocked
it — otherwise `on_error: empty` silently writes empty enrichments and we read a spend cap as "no data
found." `FAILED` / `TIME_OUT` / `STOPPED` throw; `COMPLETED` returns results.

**Registration.** A first-class `monid` id in `providers/registry.ts` alongside `composio` — it is
global, one API key, not per-list. Per-list spend limits belong in `outbound.yaml` `budgets.tools`,
which already exists (`ToolBudgetRuleSchema`: daily / weekly / monthly).

**Cost.** Every run returns `cost.value`. Write it to `cost_events` so `avgStepCostUsd` — which the
dataflow scheduler already uses to order steps by cost — learns real Monid prices and orders around
them. Monid's own workspace controls are the hard backstop beneath our soft one.

**Latency is the real risk.** Every current command provider returns sub-second; Monid runs take
1–120s. Dropping a p99=120s tool into a per-record `enrich` step changes the character of a pipeline
run. The `batch-loader` `windowMs` / `inFlight` interplay and `enrich.concurrency` both need a
deliberate decision, not a default. Poll through `runtime/polling.ts`.

---

## Phase 4 — Endpoint adoption

Now that spend is gated behind a human and metered per run:

1. **`decision_makers` → Apollo people search (`/mixed_people/api_search`, $0/call).** Replaces an LLM
   inferring people from a scraped homepage with real names and titles. Highest value, zero cost.
2. **New `contact_verify` step** before any outreach spend — email / phone validity. We have no
   verification anywhere today.
3. **New trigger signals:** building permits (`/v1/permits`, $0.033/call) — a genuine buying trigger
   for trades, and we have nothing like it; Google review velocity
   (`/compass/google-maps-reviews-scraper`, $0.000675/result) as a cheap is-this-business-alive signal.
   Then re-score.

**Keep** Google Maps, Firecrawl, Smarty, Adyntel, and Anchor on our own keys. They are cheaper, tuned
(type exclusions, territory geo-fencing), and Monid's own guidance is that dedicated tools win. Monid
is additive at the margin, not a replacement.

---

## Decisions

- **A review verdict is an override**, not a new table. The audit trail, `--reapply` survival, and
  reconciliation already exist.
- **Positional barrier**, not explicit `runs_after`. Silent overspend is the failure mode to design
  against.
- **Review drops stay blanket** (`step_id=''`); stage provenance rides in `created_by`. Avoids
  changing `coversGate` semantics that live records depend on.
- **Review is tier 1** — after free deterministic gates, before all paid work.
- **No `on_timeout`** on a review step. It blocks until a human acts.
- **Batch decisions client-side**, one POST. The queue is 2000 records deep.
- **Review before Monid.** The gate is what makes the spend affordable.
- **Monid registers globally** like `composio`; budgets stay per-list.
- **Voice / SMS is out of scope.** No channel work in this plan.

## Scope note

`site_profile` has already run on 777 records and `decision_makers` on 372. A review gate added now
governs the remaining flow and future sourcing — it does not apply retroactively. Making it retroactive
would need `--reapply`, which we do not want: that data is already paid for.
