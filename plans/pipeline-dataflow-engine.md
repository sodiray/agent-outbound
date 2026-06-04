# Plan: Per-Record Dataflow Pipeline Engine

Status: direction decided (see §0); ready to implement
Owner: (you)
Scope: `agent-outbound` — replace the stage-barrier pipeline runner with a per-record,
dependency-aware dataflow scheduler with transparent batch coalescing.

---

## 0. Guiding principle (decided)

Optimize for **most performant AND most data-correct** across both sides of the system:
(1) generating correct config data, and (2) processing to generate correct lead data.
Every design choice below follows one principle:

> **Make the correctness graph a derived, verified artifact — not authored data — and keep
> hard-correctness constraints separate from soft-economic ones.**

Hand-authoring a DAG is the most error-prone thing we could ask of the config layer, so the
error-prone part is *computed*, not written. Concretely, the decided answers are:

- **`depends_on` = data-dependency edges only**, and they are **derived + verified**, not
  hand-authored (§3). The author declares inputs/outputs honestly; the engine computes the
  graph.
- **Funnel/cost ordering is NOT in the config.** It is an emergent scheduler policy:
  *never start a more-expensive step on a record while a cheaper, still-applicable
  drop-gate is unresolved* (§4 / §6). Cost-optimal by construction; zero authoring.
- **The run refuses to start on an unsound graph.** Inference is a build-time, reviewable
  step — never a silent runtime fallback (§3.3, §7).
- **One execution engine.** Two engines that must agree is itself a data-consistency
  hazard; the old runner survives only as the transition baseline, then is deleted (§7).
- **One field-reference convention** makes data edges ~100% derivable: upstream fields are
  referenced via template tokens (`{field}`), never freehand prose (§3.4).

---

## 1. Why

Today `runPipeline` (`src/orchestrator/pipeline/runner.ts`) iterates **steps** in the outer
loop. For each step it reads *all* in-play rows, processes them (with per-step
`concurrency`), then **hard-barriers** before the next step. Consequences:

- **No record finishes early.** A record that would clear all steps in seconds is held
  until the whole cohort clears every step. The UI shows everything "in progress" until
  the run ends.
- **The slowest stage gates everyone.** `owner_name_gov` (browser, Idaho SOS, concurrency
  2) throttles the entire cohort even though most records don't even need it.
- **Order is the only dependency model.** There is no real DAG — steps run in list order.
  Independent steps that could run in parallel don't.

We want: **all records flow concurrently under a configurable max concurrency (default 10);
each record runs every step it is *eligible* for as soon as that step's dependencies are
satisfied; same-step work across records is transparently batched; records complete
independently.**

### Current-state findings (verified in code, 2026-06-03)

1. **`depends_on` is declared but unwired for the pipeline.** `StepConfigSchema.depends_on`
   exists (`src/schemas/config.ts:73`) and is used by scoring criteria's `config:
   StepConfigSchema`. But the pipeline step schemas — `PipelineEnrichmentStepSchema`
   (182-219) and `PipelineFilterStepSchema` (168-180) — have **no** `depends_on` and no
   nested `config`.
2. **Dependency analysis is a silent no-op.** `getDependentsOfStep`
   (`src/orchestrator/lib/config.ts:217`) reads `step.config.depends_on`. Pipeline steps
   have neither `config` nor `depends_on`, so it always returns `[]`. `validateStepRemoval`
   and `author-config`'s removal guard therefore never actually block anything for pipeline
   steps.
3. **The real config has zero `depends_on`.** `meridian-victory-eagle/outbound.yaml`
   encodes the entire funnel by *list order*. Producer/consumer signals that exist today:
   `enrich.outputs` (declares produced columns), `enrich.when` (FieldCheckPredicate over
   fields), `filter.conditions` (field_check over fields), `filter.condition` (semantic
   prompt — references fields **in prose**, not machine-readable).
4. **Persistence is already per-record per-step**, which is what makes resumability cheap:
   `pipeline_events(record_id, step_id, passed, ...)` for filters + enrich; enrich
   freshness via `countEnrichWorkForStep`/`hasPassedStep`. The scheduler can derive all
   progress from the DB.
5. **Batch executors already exist** and are the seam for coalescing:
   `evaluateSemanticFilterBatches({db, listDir, filter, rows, aiConfig, batchSize})` and
   `executeEnrichmentStepOnRecords({db, listDir, config, mcp, toolCatalog, step, rows,
   stepId, force})`. Both already take a *set of rows* — we keep them and feed them batches.

The infra is ~60% there. The missing pieces are: a real dependency model on pipeline steps,
a scheduler that consumes it, and a coalescing loader in front of the existing batch
executors.

---

## 2. Target architecture

Three components, clean seams:

```
                ┌─────────────────────────────────────────────┐
                │  Scheduler (per-record advance loops)        │
                │  - loads record state from DB                │
                │  - for each record: find ready step,         │
                │    request execution, persist, repeat        │
                │  - global concurrency semaphore (default 10) │
                └───────────────┬─────────────────────────────┘
                                │ load(stepId, record) -> Promise<outcome>
                ┌───────────────▼─────────────────────────────┐
                │  Batch Loader (coalescing, per step-type)    │
                │  - collects load() calls into a window       │
                │  - flush on size N or time T or quiescence   │
                │  - calls the step executor once per batch    │
                │  - scatters results back to each caller      │
                └───────────────┬─────────────────────────────┘
                                │ execute(step, rows[]) -> outcomes[]
                ┌───────────────▼─────────────────────────────┐
                │  Step Executors (EXISTING, unchanged-ish)    │
                │  - semantic filter -> evaluateSemanticFilter │
                │  - field_check     -> evaluateFieldCheckGroup│
                │  - enrich          -> executeEnrichmentStep… │
                └──────────────────────────────────────────────┘
```

The executors stay ignorant of each other and of scheduling — exactly the user's
"steps don't have to know about each other" requirement.

---

## 3. The dependency model (`depends_on` = derived data edges)

**Decision: `depends_on` carries *only* hard data-dependency edges, and it is derived +
verified, not hand-authored.** Cost/funnel ordering is removed from the config entirely and
becomes an emergent scheduler policy (§4 / §6). The two are different *kinds* of constraint
and must not be conflated:

- A **data edge** is a *hard correctness* constraint — violate it and a step judges a field
  that doesn't exist yet, producing wrong lead data. It is also machine-derivable, so the
  **engine owns it**.
- A **cost edge** ("don't pay for the SOS lookup until ICP passes") is a *soft economic*
  constraint — violate it and you waste money, never correctness. It does not belong in the
  config; the scheduler derives optimal ordering from step cost + drop-gates.

This makes both sides more correct at once: the config surface shrinks to "describe each
step's inputs and outputs honestly," and the most error-prone artifact (the DAG) is
computed, not written.

### 3.1 Semantics

`depends_on: [stepId, ...]` means **"do not run me on a record until every listed step is
*resolved* for that record."** Resolved = passed, or determined not-applicable (`when`
excluded it). It encodes **data dependencies only** — a step that reads a field another step
produces (`address_gate` ← `address_check`; `icp_semantic_gate` ← `site_profile`). **Steps
with no data dependency run immediately and in parallel** — the latency win
(`is_a_business_gate` and `vertical_gate` fire together on every fresh record). Funnel
ordering is *not* expressed here.

> Authors normally never write `depends_on` — it is computed (§3.4). A rarely-used explicit
> `runs_after: [stepId]` escape hatch exists only for ordering the cost heuristic cannot
> express; it is additive and validated like `depends_on`.

### 3.2 Schema changes (`src/schemas/config.ts`)

Add `depends_on: z.array(z.string()).default([])` (and optional `runs_after`) directly to
**both** `PipelineEnrichmentStepSchema` and `PipelineFilterStepSchema` (top-level on the
step — pipeline steps have no `config` object). Keep `StepConfigSchema.depends_on` for
scoring as-is.

### 3.3 Validation (deterministic, gates the run)

Add `validatePipelineGraph(config)` in `config.ts`, surfaced through `errors[]`. Because the
priority is data-correctness, **validation failures are hard errors and the new engine
refuses to run** (§7) — a config with missing data edges silently produces wrong leads,
the worst outcome:

- **Existence** — every `depends_on` / `runs_after` id references a real step. Unknown → error.
- **Acyclicity** — topological sort; a cycle is a hard error (names the cycle).
- **Forward-reference** — depending on a later-listed step is legal but usually a mistake → warn.
- **Data-edge coverage (hard gate)** — recompute `inferPipelineEdges` (§3.4). If a step
  consumes a field another step produces but does not depend on it, **error** unless the
  edge was explicitly acknowledged. This is the gate that prevents wrong lead data.

Also fix `getDependentsOfStep` to read `step.depends_on` (top-level), so
`validateStepRemoval` / `author-config` removal guards finally work for the pipeline.

### 3.4 Inference (the source of truth for data edges)

`inferPipelineEdges(config)` derives the data graph and aims for **complete** recall:
- **Producers**: each `enrich` step produces the keys in its `outputs` (and legacy
  `columns`). Filters produce nothing.
- **Consumers (structured)**: `enrich.when` conditions' `field`s; `filter.conditions[].field`;
  templated `prompt_args`/`args` referencing `${field}`.
- **Consumers (prose → made machine-detectable)**: semantic `filter.condition` and enrich
  prompt bodies reference fields in natural language. We close this gap two ways:
  (a) **vocabulary scan** — we know the *closed set* of all producible field names across
  the config, so we scan prompt/condition text for any of them and treat a hit as a data
  edge; (b) **convention (§3.5)** — upstream fields must be referenced via template tokens
  (`{field}`), which makes every reference unambiguous. Together these push data-edge
  derivation to ~100%, which is what lets §3.3 treat coverage as a hard gate.

### 3.5 Field-reference convention (the keystone)

**Steps reference upstream fields via template tokens (`{field}` / `prompt_args`), never
freehand prose.** This is enforced by lint: any closed-vocabulary field name appearing in
prose *not* as a token is flagged. The convention is what makes data-edge inference
deterministic and therefore safe to gate the run on. The authoring prompt teaches it; the
linter enforces it.

### 3.6 Authoring — correctness without trusting the model

Dependencies are computed, so the author LLM's job shrinks to honest input/output
declaration. Layers:

1. **Prompt** (`actions/author-config/prompt.md` + `AuthorConfigOutputSchema`): require
   honest `outputs`; require token-style field references (§3.5); the model does **not**
   hand-wire `depends_on` (it may, but it's overwritten by layer 2).
2. **Deterministic post-pass** (`author-config/index.ts`, after `applyConfigChanges`): run
   `inferPipelineEdges` and **write** each step's `depends_on` from the computed data graph
   (union with any author `runs_after`). The model cannot produce a wrong data graph because
   it doesn't author it. Record the computed edges in `warnings`/`notes`.
3. **Validation gate** (§3.3): cycles / unknown refs / uncovered edges block the write.

### 3.7 Backfill

`npx tsx src/cli.ts config infer-deps <listDir> [--write]` — runs `inferPipelineEdges`,
prints the computed `depends_on` per step, and with `--write` writes them into
`outbound.yaml`. Run once on `meridian-victory-eagle` to populate the 9 steps' data graph;
no cost edges to hand-add (they're emergent, §4 / §6).

---

## 4. The scheduler

### 4.1 State, derived from the DB (resumability for free)

At run start, load all in-play records and, for each, its resolved-step set from
`pipeline_events` + enrich freshness. Define pure helpers:

- `applicable(record, step)`: in-play AND not already resolved AND (for enrich) `when`
  passes AND (committed soft-drop rules respected).
- `resolved(record, step)`: passed, or not-applicable (`when` excluded it).
- `dataReady(record, step)`: `applicable` AND every `step.depends_on`/`runs_after` is
  `resolved(record, …)`.
- `economicallyReady(record, step)`: `dataReady` AND there is **no cheaper, still-applicable
  drop-gate** (`on_fail: drop`) unresolved for this record. This is the emergent funnel rule
  (§6) — it keeps culling ahead of spend *without any cost edges in the config*. "Cheaper"
  ranks by tier (field_check < semantic < enrich) with `avgStepCostUsd` as tiebreak.
- `nextStep(record)`: the cheapest `economicallyReady` step. Cheap parallel gates fire
  immediately; an expensive enrich never starts while a cheaper gate could still drop the
  record.

Because all of this is a pure function of persisted state, **crash/Ctrl-C recovery is
re-derivation** — restart the run and it picks up exactly where it stopped. No in-memory
queue to lose. This is the "most robust" property the user asked for.

### 4.2 Execution loop (continuous, no global barrier)

Per record, an async advance loop:

```
while (true) {
  const step = nextStep(record)        // from current in-memory state
  if (!step) break                      // record is done (or dropped)
  const outcome = await loader.load(step.id, record)   // coalesced; see §5
  persist(outcome)                      // pipeline_events / enrich columns / drop
  updateState(record, step, outcome)    // mark resolved or dropped
  if (dropped) break
}
```

Run all record loops concurrently under a **global semaphore = `pipeline.concurrency`
(default 10, configurable)**. A record loop holds a permit only while it is *not* parked in
the loader window (so parked records don't starve the permit pool — see §6 deadlock note).

### 4.3 Drops & short-circuit

A failing gate writes the drop/review-flag (reuse `writeFilterFailure` verbatim — it
already handles committed→review soft-drop) and the record loop breaks. No downstream steps
run. Dependents of a dropped step simply never become ready. This is automatic in the
`ready`/`applicable` model.

---

## 5. The batch loader (coalescing)

`createBatchLoader({ executor, window, maxBatch })` returns `load(stepId, record) =>
Promise<outcome>`.

- Maintains a pending map keyed by `stepId`: `{ records[], resolvers[] }`.
- On `load`: push record + its promise resolver; if the bucket reaches `maxBatch`, flush
  immediately; otherwise (re)arm a **time** flush.
- **Flush** = call the step's `execute(step, rows)` once, then scatter each outcome back to
  its resolver by `record id`. Missing rows in the result → per-record fallback (we already
  built `fallbackRows` in `conditions.ts`); errors → reject only that record's promise so
  its loop can retry/record-fail, never the whole batch.

### 5.1 Window policy — it is a size-OR-time window, NOT debounce

Critical: **do not debounce** (resetting the timer on each arrival starves under steady
arrival). Flush when **N items accumulate OR T ms since the bucket's first item**,
whichever comes first. Per step-type config:

- semantic / enrich-LLM: `maxBatch = batch_size` (default 10), `T ≈ 250–500ms`.
- field_check: `maxBatch = concurrency`, `T ≈ 0` (cheap, no real need to wait).
- browser (`owner_name_gov`): `maxBatch = 1` (can't batch), runs per-record under its own
  per-step concurrency cap.

### 5.2 Batch efficiency — why one engine is enough (no bulk mode)

Per-record flow spreads records across steps, so late-DAG batches are smaller than today's
"whole cohort slams one gate." But the funnel shape makes the penalty small: on a fresh run
**all** records are simultaneously ready for the tier-0 gates, so the loader fills **full**
batches on exactly the steps that process the most records. Batches only shrink deeper in
the DAG — by which point the funnel has culled most records, so the expensive late steps
have few records regardless. The windowed loader recovers nearly all of stage-batching's
efficiency on the volume that matters.

**Decision: no separate bulk engine.** Two engines that must produce identical lead data is
itself a data-consistency hazard (drift between paths = same config, different leads). One
engine is required for "robust consistency." Revisit only if a *measured* token regression
ever appears.

---

## 6. Concurrency & funnel-ordering model

- **Global**: `pipeline.concurrency` config default + `--concurrency` flag override (flag
  wins) — max records advancing at once. Default `max(10, largest batch_size)`.
- **Concurrency ↔ batch_size coupling (perf-critical)**: if global concurrency is below the
  largest `batch_size`, the loader can never fill a full batch → it always time-flushes
  small batches → token inefficiency. Validate and auto-raise global concurrency to at least
  the largest `batch_size`; warn when overridden below it.
- **Per-step**: keep existing `step.concurrency`. The loader/executor enforces it so e.g.
  the browser step never exceeds 2 even if 10 records are ready for it.
- **Emergent funnel ordering (no config)**: there are no cost edges in the config. The
  scheduler's `economicallyReady` rule (§4.1) — *don't start a more-expensive step while a
  cheaper applicable drop-gate is unresolved* — makes the funnel cost-optimal by
  construction. Authors never hand-encode "cull before spend."
- **Deadlock guard (real risk)**: if all in-flight records park in the same loader bucket
  waiting to reach `maxBatch`, and no more records can arrive (all permits held by parked
  loops), the size threshold never trips. Mitigate two ways: (a) the time window always
  flushes; (b) **flush-on-quiescence** — the loader flushes a partial bucket as soon as it
  detects no outstanding record loop can still add to it (in-flight count == parked count).
  (a) guarantees liveness; (b) removes the latency wart.

---

## 7. Rollout & validation (transition to a single engine)

End state is **one engine**. The old runner survives only long enough to be the
equivalence baseline, then is deleted.

- **Refuse-to-run gate**: the dataflow engine will not start unless `validatePipelineGraph`
  passes (no unknown refs, no cycles, no uncovered data edges — §3.3). Inference is
  build-time only; there is **no silent runtime infer-and-run** fallback. A config with
  missing data edges is a hard error, not a warning, because it silently yields wrong leads.
- **Flag-gated transition**: new engine behind `--engine=dataflow` (or
  `AO_PIPELINE_ENGINE=dataflow`) while we validate. Old `runPipeline` stays *only* for the
  diff below.
- **Equivalence check**: run both engines on a *copy* of `meridian-victory-eagle` and diff
  final record state (drops, survivors, enrich outputs, scores). Outcomes must match;
  wall-clock and per-record completion timing should improve.
- **Cut over and delete**: once outcomes match and timing improves, make dataflow the
  default and **remove the old stage runner** (one release of overlap max). Maintaining two
  engines long-term is the data-consistency hazard we're explicitly avoiding (§5.2).
- **Live UI**: the State sort / per-record buckets we just built become *genuinely*
  accurate under this engine (records complete independently), which is itself a validation
  surface — watch records settle into kept/dropped individually instead of all at once.
- **Keep the safety nets we built**: per-call timeout+retry (`callWithTimeoutRetry`),
  tolerant batch schema + `fallbackRows`, idempotency via `hasPassedStep`. They compose
  directly with the loader.

---

## 8. Work breakdown (phased, each independently shippable)

**Phase 0 — Dependency model (no behavior change to the runner)**
- Add `depends_on` (+ optional `runs_after`) to both pipeline step schemas (§3.2).
- Fix `getDependentsOfStep` to read `step.depends_on` (§3.3).
- `inferPipelineEdges` with structural + closed-vocabulary prompt scan (§3.4).
- `validatePipelineGraph` (existence, cycles, forward-ref warn, **data-edge coverage as
  hard error**) wired into config load (§3.3).
- Field-reference convention lint: closed-vocab field names must appear as tokens (§3.5).
- `config infer-deps [--write]` CLI; backfill `meridian` (§3.7).
- Authoring: prompt update (honest outputs + token refs) + deterministic post-pass that
  **writes** `depends_on` from the computed graph (§3.6).
- *Ships value alone*: removal guards start working; configs gain a verified, computed DAG.

**Phase 1 — Loader**
- `createBatchLoader` with size-or-time window + quiescence flush (§5).
- Wrap existing executors (`evaluateSemanticFilterBatches`, `evaluateFieldCheckGroup`,
  `executeEnrichmentStepOnRecords`) behind a uniform `execute(step, rows)` adapter.
- Unit tests: coalescing, partial-result fallback, per-record reject isolation,
  no-debounce-starvation, quiescence flush.

**Phase 2 — Scheduler**
- DB-derived state + `applicable`/`resolved`/`dataReady`/`economicallyReady`/`nextStep` (§4.1).
- Per-record advance loop + global semaphore + emergent funnel ordering (§4.2, §6).
- Reuse `writeFilterFailure`, pipeline_event writes, progress/heartbeat emission.
- `--engine=dataflow` flag + refuse-to-run on invalid graph (§7).

**Phase 3 — Validate, cut over, delete old runner**
- Equivalence diff on a meridian copy; tune windows/concurrency.
- Flip default to dataflow once outcomes match and timing improves, then **remove the old
  stage runner** (one release of overlap max) — single engine end state (§7).

---

## 9. Decisions (resolved 2026-06-03)

All four prior open questions are decided under the §0 principle:

1. **`depends_on` scope** — *data edges only*, derived + verified, not hand-authored (§3).
   Cost/funnel ordering is removed from config and becomes the emergent `economicallyReady`
   scheduler policy (§4.1, §6). Rare non-cost ordering uses an explicit `runs_after` hatch.
   *Why:* hard-correctness and soft-economic constraints have different failure modes;
   computing both removes the most error-prone authoring surface.
2. **Global concurrency** — `pipeline.concurrency` config default **and** `--concurrency`
   flag override (flag wins); default `max(10, largest batch_size)`; validate concurrency ≥
   largest batch_size so the loader can fill full batches (§6).
3. **Legacy configs** — **hard-require a validated graph; refuse to run otherwise** (§3.3,
   §7). Inference is a build-time, reviewable step (`config infer-deps --write`), never a
   silent runtime fallback. Running with missing data edges silently yields wrong leads —
   unacceptable for the data-correctness goal.
4. **Bulk mode** — **no separate engine.** The funnel shape keeps early (high-volume)
   batches full; two engines is a data-consistency hazard. One engine; revisit only on a
   measured regression (§5.2).
