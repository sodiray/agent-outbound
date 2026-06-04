# Plan: Single-Lead Intake

## Problem

Sourcing today is bulk and geographic: `geo_tiles` / `keyword_geo` strategies sweep an area and
produce many records. But a rep often wants to push **one specific business** through the pipeline —
a warm intro, a referral, a name seen on a sign or building. There's no way to say "here's a lead by
name, go find it and run it." This adds that.

## Goal

A command that takes a business **name** (plus a locality hint), does **basic research to resolve it**
to a real place, creates exactly one record, and (optionally) runs it straight through the pipeline +
scoring — the same record shape and dedup as bulk sourcing, just one at a time and name-driven.

Acceptance: it works for **Fatbeam Internet in Boise** (an ISP).

## What already exists (reuse, don't rebuild)

- **`MAPS_TEXT_SEARCH`** (googlemaps command server, in each list's `mcp.json`): free-text `query` →
  businesses with name, address, phone, website, types, place_id, coords, primary_type,
  business_status, user_rating_count. This is the "research to find it" step.
- Sourcing runner internals: `executeStrategyTask` already has a text-query branch; `mapStrategyRow`
  (output_map + robust field fallbacks), `extractRowsFromToolResult`, dedup-by-place_id helpers,
  `rowToRecordShape`, `upsertRecord`. The intake command assembles these.
- Pipeline + scoring runners (`runPipelineDataflow`, `runScoring`) already accept a `--where`, so a
  single record can be run by `_row_id`.

## Design

### Command

```
lead add <list> --name "Fatbeam Internet" [--near "Boise, ID"] [--query "..."]
                [--run] [--dry-run] [--max N]
```

- `--name` (required): the business name.
- `--near`: locality hint (city/state, address, landmark). Combined with name into the search query
  (`"<name> <near>"`). If `--query` is given, it's used verbatim instead.
- `--dry-run`: resolve and show the top candidate(s) + match confidence; write nothing.
- `--run`: after inserting, run the pipeline + scoring on just this record.
- `--max` (default ~5): how many candidates to fetch for disambiguation.

(Name: `lead add` reads as the rep's mental model — "add this lead." It's a new command group
alongside `source`.)

### Flow

1. **Resolve tool**: load `googlemaps` → `MAPS_TEXT_SEARCH` from the list's tool catalog (independent
   of whatever bulk strategy the list uses). Error clearly if the list has no googlemaps text tool.
2. **Research**: call `MAPS_TEXT_SEARCH` with `query`, `max_results = --max`, `max_pages = 1`.
3. **Best match**: rank candidates by name-token overlap with `--name` (tie-break: has-website, then
   `user_rating_count`). Pick the top. Surface the match + confidence; if confidence is low or there's
   a near-tie, `--dry-run`-style list the candidates and ask the rep to refine `--near`/`--query`
   (don't silently insert a wrong business).
4. **Map**: `mapStrategyRow` with the list's `source.strategies[0].output_map` if present (else the
   built-in fallbacks), then `rowToRecordShape`. Stamp provenance: `source = 'manual'`,
   `sourced_at = now`, `source_query = <query>`, and an `extra_json.intake = 'manual'` marker so
   manually-added leads are distinguishable.
5. **Dedup**: by `place_id` against existing records. If it already exists, don't duplicate — report
   the existing record (and still `--run` it if asked).
6. **Insert**: `upsertRecord` the single record.
7. **Optional `--run`**: `runPipelineDataflow({ where: "_row_id = '<id>'" })` then
   `runScoring({ where: same })`. Report the funnel outcome (survived / dropped at which gate) + score.

### Provenance & territory

- Single-lead intake **ignores tiles/territory** — it's a deliberate push by name, not a geo sweep.
- All pipeline gates still apply to the inserted record. A national/multi-location business may be
  dropped by `icp_semantic_gate`; that's expected — the rep can then `override keep` it (the override
  system already supports this). The intake command's job is to get it *in and evaluated*, not to
  force it past qualification.

## Files (for Codex)

- `src/orchestrator/sourcing/runner.ts` (or a small new `single-lead.ts`): `resolveSingleLead` /
  `addSingleLead` reusing the existing helpers above.
- `src/commands/leads.ts` (new): `leadAddCommand` (resolve → map → dedup → upsert → optional run+score),
  with `--dry-run` candidate preview.
- `src/commands/index.ts`: re-export.
- `src/cli.ts`: `lead add` dispatch + `--name/--near/--query/--run/--dry-run/--max` flag parsing + help.

## Validation (mine, via Chrome + CLI)

1. `lead add meridian-victory-eagle --name "Fatbeam Internet" --near "Boise, ID" --dry-run` →
   confirm it resolves Fatbeam (correct address/website/place_id), shows the match.
2. `lead add ... --run` → one record inserted, pipeline + score run; report where it lands (likely
   dropped at `icp_semantic_gate` as a regional ISP — then demonstrate `override keep` if desired).
3. Chrome: open the viz, confirm Fatbeam appears as a lead with the resolved data and its score/outcome.

## Out of scope (future)

- Place-details lookup by `--place-id` (no place-details tool yet; text search only).
- Bulk paste of many names; CSV intake.
- Auto-creating a list if one isn't specified.
