# Plan: Asset Generation (generate steps + assets)

## Problem

The pipeline can discover facts about a lead (enrich) and judge it (filter/score), but it can't
**produce content for** a lead. There's no way to say "for every qualified lead, write the intro
email," or "build a personalized demo page," or "draft the internal-team briefing." Today the only
per-lead content generation happens late, inside the sequencer at send-time (`channels/execute.ts`
writes a `drafts` row), tied to one specific sequence step and not reusable.

We want generation to be a **first-class pipeline step** that produces a reusable **asset** per lead,
which a sequence can later consume (and gate for approval at the point of sending).

## Goal

Add a `generate` pipeline step kind and an `assets` store, plus the commands to inspect assets and the
sequence wiring to consume them. Acceptance: on the meridian list, a generate step writes an intro
email asset per in-play lead, an external tool-driven step writes a demo-page reference, and a sequence
step can declare it consumes an asset and requires approval before sending.

## Product shape (already aligned with the user — do not redesign)

A **generate step** is dynamic, exactly like the rest of the pipeline. It is one of two flavors,
decided the same way enrich already decides today:

- **Model-driven** — has a `prompt`/`prompt_file` + `model`. The LLM produces the result.
- **Tool/CLI-driven** — has a `tool` (+ `args`). The tool/CLI produces the result.

There is **no asset taxonomy**. `asset_type`/`label` is optional free-form metadata for filtering only,
never a behavioral switch. The step's `id` is its identity.

**Storage is always the database — one mode.** We store the result/response of the step:
- model-driven → whatever the LLM returned.
- tool/CLI-driven → whatever the tool/CLI returned.
- if a tool writes a file to disk, the tool hands back a reference (path/URL) and **that reference is
  what we store**. We do not manage file storage ourselves; we keep the pointer.

**Approval is not a generation concept.** Generation never blocks — it just fills the shelf. The
approval gate lives at the **sequence step that consumes the asset** (a step can require approval in
one sequence and auto-flow in another; approval is contextual to use, not to the asset).

**Generate-once by default.** Re-running the pipeline does not overwrite an existing asset unless
`--force` is passed, or the step's material inputs changed and the asset has not yet been
consumed/approved. (Mirrors enrich staleness; an approved/consumed asset is never silently regenerated.)

## What already exists (reuse, don't rebuild)

- **Step engine**: `dataflow.ts` already dispatches by `kind` (`dataflow.ts:72-101`, executable gate at
  `:101`, MCP/tool-catalog hydration at `:342-343`, per-step execution at `:455-546`). The enrich path
  is the template to copy.
- **Enrich runner**: `src/orchestrator/enrichment/runner.ts` — model vs tool dispatch
  (`executeEnrichmentAction`), `buildOutputZodSchema`, `applyOutputs`, staleness/`on_error`/`when`
  handling, custom-action dispatch (`action: decision_makers`). Generation reuses this machinery; the
  only difference is the **sink** (assets table, not record columns) and the **consumer** (sequence,
  not scoring).
- **Tool invocation**: local command tools and hosted Composio toolkits both already route through
  `execute-step` + `runtime/tools.ts` + `getMcpClient`/`closeMcpClient`. A tool-driven generate step
  uses the same path; `enrichmentStepNeedsMcp` has a sibling for generate (`dataflow.ts:342`).
- **Drafts table & helpers** as the structural template: `db.ts:319` (table), `insertDraft`
  (`db.ts:1522`), `updateDraft` (`db.ts:1549`), `ensureRecordColumns`/`upsertRecord`. The `assets`
  table mirrors this shape and helper style.
- **Sequence step schema** already has `draft_approval_required` (`config.ts:255`) and a `config`
  block. The new `uses_asset` + approval wiring extends this, reusing the existing approval flag where
  possible rather than inventing a parallel one.
- **List data dir**: `src/orchestrator/runtime/paths.ts` (`.outbound/<list>/`). Assets live in the DB;
  no new on-disk layout is required for v1.

## Design

### 1. Config — `generate` step kind

Add `PipelineGenerateStepSchema` to `src/schemas/config.ts` and include it in the
`PipelineStepSchema` discriminated union (`config.ts:232`). Field set (intentionally close to enrich so
the runner can share code):

```yaml
- kind: generate
  id: intro_email                      # identity (required)
  description: "Personalized intro email"
  label: email                         # OPTIONAL free-form metadata (filtering only)
  depends_on: [score]                  # DAG; generation runs after qualification
  when: { conditions: [{ field: priority_rank, operator: is_not_empty }] }

  # --- model-driven flavor ---
  model: deepinfra/moonshotai/Kimi-K2.6
  prompt_file: prompts/intro-email.md
  prompt_args: {}
  reasoning: false

  # --- OR tool/CLI-driven flavor ---
  tool: { ... }                        # ToolSpecSchema (command tool or Composio toolkit)
  args: {}

  # shared
  outputs:                             # optional structured parse of the result (like enrich)
    subject: { type: string }
    body: { type: string }
  on_error: empty                      # generation should default to non-fatal (empty | fail)
  step_budget: 8
  concurrency: 10
  cache_key: ""                        # explicit staleness override
```

- Flavor is inferred exactly like enrich: a `tool` (or `action`) present ⇒ tool-driven; otherwise
  model-driven. Validate that exactly one flavor is resolvable; error clearly otherwise.
- `outputs` is optional. The **raw result is always stored** on the asset; `outputs` only declares
  structured fields parsed out of the result for convenient downstream reference.

### 2. Data — `assets` table

New table in `db.ts` (model on the drafts table at `db.ts:319`), flat, one storage mode:

```sql
CREATE TABLE IF NOT EXISTS assets (
  asset_id   TEXT PRIMARY KEY,
  row_id     TEXT NOT NULL,            -- FK to records._row_id
  step_id    TEXT NOT NULL,            -- which generate step produced it
  label      TEXT DEFAULT '',          -- optional free-form metadata
  result     TEXT DEFAULT '',          -- the stored response (text or JSON string)
  outputs_json TEXT DEFAULT '{}',      -- structured fields parsed from result (if `outputs` declared)
  is_reference INTEGER DEFAULT 0,      -- 1 when result is a path/URL pointer (so `assets open` follows it)
  status     TEXT DEFAULT 'ready',     -- generation never gates; 'ready' on creation
  reason     TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_row  ON assets(row_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_step ON assets(step_id, created_at DESC);
```

- Uniqueness for generate-once: one current asset per `(row_id, step_id)`. Regeneration updates in
  place (or supersedes) rather than appending duplicates.
- Helpers mirroring drafts: `insertAsset`, `updateAsset`, `getAssetsForRow`, `getAsset`,
  `findAsset({ rowId, stepId })`. Keep the `{ db, ... }` argument style used elsewhere.
- `is_reference` is set by the runner when a tool-driven step returns a pointer (path/URL) rather than
  inline content — see step 3. No mime/path/uri split; it's just the result plus this one flag.

### 3. Runner — `src/orchestrator/generate/runner.ts`

A thin sibling of the enrich runner that reuses its engine:

- For each in-scope record: resolve flavor, run it (model-driven via the same `execute-step` path used
  by enrich; tool-driven via the same tool/Composio path), capture the **raw result**.
- If `outputs` declared, parse structured fields (reuse `buildOutputZodSchema` + a parse step) into
  `outputs_json`; never fail the whole step if structured parse fails when `on_error: empty` — store
  the raw result, leave `outputs_json` empty.
- Reference detection: if a tool-driven result is a bare path/URL (or the tool declares it returns a
  reference), set `is_reference = 1`. Keep this heuristic simple and documented; prefer an explicit
  signal from the tool result over guessing.
- Persist via `insertAsset`/`updateAsset`. Honor staleness (`cache_key` + material-field hash, same
  approach as enrich) and `--force`; never regenerate an asset whose status indicates it's been
  consumed/approved.
- `on_error: empty` ⇒ a failed generation completes neutrally (empty asset, status note), never drops
  or flags the lead — generation is additive.

### 4. Dataflow wiring

In `src/orchestrator/pipeline/dataflow.ts`:
- Add `generate` to the kind dispatch (`:72-101`): give it a `stepKindRank` after enrich, mark it
  `executable`, and route execution to the generate runner (`:455-546` region) the same way enrich is
  routed at `:462`.
- MCP/tool-catalog hydration (`:342-343`): tool-driven generate steps need the MCP client/tool catalog
  — add the sibling check (`generateStepNeedsMcp`).
- Generate steps are **never drop gates** — they only produce. A failure is an errored_event /
  neutral-empty, never a record drop.
- Honor `--force` pre-resolution rules already established for enrich (`:311`).

### 5. Sequence consumption + approval

In `config.ts` `SequenceStepSchema` (`:237`):
- Add `uses_asset: z.string().optional()` — the `id` of the generate step whose asset this sequence
  step sends.
- Approval: reuse the existing `draft_approval_required` flag as the gate (alias/accept
  `requires_approval` for readability if cheap). When a step `uses_asset` and requires approval, the
  send path must not fire until that asset is approved.

In `src/orchestrator/channels/execute.ts` + `sequencer/runner.ts`:
- When a sequence step has `uses_asset`, **read the asset** (`findAsset({ rowId, stepId: uses_asset })`)
  instead of generating content inline at send-time. Map the asset's `outputs_json` (e.g.
  `subject`/`body`) or `result` into the outgoing draft/message. If `is_reference`, make the reference
  available to the template (e.g. a `{{demo_url}}`-style variable) so it can be dropped into the body.
- If `requires_approval` and the asset isn't approved, hold the step (existing draft-approval
  semantics) rather than sending.

### 6. Commands — `assets` family

New `src/commands/assets.ts` (model on `src/commands/drafts.ts`), wired in `commands/index.ts` and
`cli.ts`:

- `assets list <list> [--label X] [--step ID] [--row ID] [--status S]` — table: row, business, step,
  label, status, preview (truncated result).
- `assets show <list> <row_id> [--step ID]` — full result + parsed outputs for a lead's asset(s).
- `assets open <list> <row_id> --step ID` — if `is_reference`, open the path/URL; otherwise print.
- (Approval verbs intentionally live with drafts/sequence, not here — generation has no approval.)

Add `generate` as a runnable phase where sensible: it runs as part of `pipeline` (it's a pipeline
step), and optionally a focused `generate <list> [--where ...] [--step ID] [--force]` entry for
re-running just generation, mirroring how `score` can run standalone.

## Files (for Codex)

- `src/schemas/config.ts`: `PipelineGenerateStepSchema` + union (`:232`); `uses_asset` /approval on
  `SequenceStepSchema` (`:237`).
- `src/orchestrator/runtime/db.ts`: `assets` table (near `:319`) + `insertAsset`/`updateAsset`/
  `getAssetsForRow`/`getAsset`/`findAsset` (near `:1522`).
- `src/orchestrator/generate/runner.ts` (new): generation engine reusing enrich internals.
- `src/orchestrator/pipeline/dataflow.ts`: `generate` kind dispatch + MCP hydration + routing.
- `src/orchestrator/channels/execute.ts` + `src/orchestrator/sequencer/runner.ts`: consume
  `uses_asset`; approval hold.
- `src/commands/assets.ts` (new) + `commands/index.ts` + `cli.ts`: `assets list/show/open`, optional
  `generate` phase, help text.
- Reuse (don't fork): `enrichment/runner.ts` helpers, `actions/execute-step`, `runtime/tools.ts`,
  `runtime/mcp.ts` (`getMcpClient`/`closeMcpClient`), `lib/templates.ts`.

## Validation (mine, via Chrome + CLI; run under Node 24)

1. **Model-driven**: add an `intro_email` generate step to meridian (`when` in-play). Run `pipeline`
   (or `generate`). `assets list meridian --label email` shows one per qualified lead; `assets show`
   on Fatbeam renders a sensible subject/body grounded in its enrich/score data.
2. **Tool/CLI-driven reference**: add a `demo_page` generate step whose tool returns a URL/path. Run
   it; `assets show` Fatbeam shows the reference with `is_reference=1`; `assets open` follows it.
3. **Generate-once**: re-run `pipeline` → assets unchanged (no duplicate rows). `generate --force` (or
   changed inputs) regenerates. An approved/consumed asset is not silently overwritten.
4. **Sequence consumption + approval**: a sequence step with `uses_asset: intro_email` +
   `requires_approval: true` reads the asset and holds for approval; with `false` it flows. Confirm the
   draft/message body comes from the asset, not a fresh inline generation.
5. **Clean exit**: tool-driven runs that touch Composio MCP exit cleanly (~2s, 0 lingering procs) via
   `closeMcpClient` teardown — verify (this regressed twice before).
6. Chrome: viz renders generated assets on the lead detail panel (extend the panel if assets aren't
   surfaced yet).

## Out of scope (future)

- On-disk asset library / exports beyond storing references (v1 keeps everything in the DB).
- Asset versioning/history (one current asset per step per lead; supersede-in-place for v1).
- Multi-asset-per-step fan-out (e.g. A/B email variants as distinct assets) — revisit after v1.
- A dedicated approval UI for assets (approval stays at the sequence/draft layer).
