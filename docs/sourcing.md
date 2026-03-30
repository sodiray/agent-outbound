# Sourcing

## Purpose

Find businesses matching criteria and add them to the canonical CSV. Sourcing has two phases:

1. **Search** — find businesses and write rows
2. **Filter** — qualify rows by running steps that produce reusable data + a pass/fail decision

All outputs go into the CSV. Rows are never deleted; failures are marked.

## Phase 1: Search

Each search entry in `source.searches` describes a query. The orchestrator runs all searches in parallel and delegates each one to the LLM via `execute-step`. The LLM calls whatever MCP tool the search config references, interprets the results, and returns structured business data.

The orchestrator:
- Writes returned businesses as new rows in the CSV
- Assigns a stable `_row_id` to each row
- Deduplicates against existing rows (by name + address similarity, domain match, etc.)
- Merges data when a duplicate is found (fills empty fields from the new result)
- Tracks search results in the sourcing log

The orchestrator does not know what tool was called or what fields came back. It writes whatever the LLM returns as row data.

## Phase 2: Filter

After searches complete, filters run against **all rows with stale filter results** — not just new rows. A row's filter result is stale when:

1. The row has never been evaluated against this filter (new row, or filter was added after the row was sourced)
2. The filter config changed (condition modified, args changed, filter added or removed)
3. A column the filter depends on changed (e.g., enrichment populated a `website` column that a filter reads via `from_column`)

This means: when you add a new filter, modify a filter condition, or enrich data that a filter depends on, existing rows automatically get re-evaluated on the next sourcing run. You don't need to re-source — the orchestrator detects staleness via the cache and re-runs only what's needed.

Each filter entry has:
- A `description` (human-readable intent)
- A `condition` (pass/fail text)
- A nested `config` (compiled execution plan)

For each filter, for each stale row:
1. Orchestrator calls `execute-step` with the filter config and row data
2. LLM executes the step (calls a tool, does research, etc.) and returns output
3. Orchestrator writes output to CSV columns specified in the filter config
4. Orchestrator calls `evaluate-condition` with the condition text and the step output
5. Orchestrator writes a deterministic pass/fail column for the filter

Filters run rows in parallel (concurrency from filter config, default 10).

After all filters run, the orchestrator recomputes the aggregate columns for every row that was re-evaluated:
- `source_filter_result: "passed" | "failed"`
- `source_filter_failures: "" | "filter_a,filter_b"` (comma-separated list of failed filter IDs)

A row that previously failed can become "passed" if filter config or upstream data changes. A row that previously passed can become "failed" if a new filter is added that it doesn't satisfy.

Rows that fail filters remain in the CSV. Enrichment and sequence skip them.

## Why Filters Produce Data

Filters aren't just gates — they're early enrichment. A filter that checks for "at least one email" also writes the email it found to a column. If the row passes, enrichment can reuse that column without re-fetching. If it fails, the data is still there for inspection.

## Config Shape

```yaml
source:
  searches:
    - source: google_maps
      query: "plumber Boise Idaho"
      # ... tool reference and other fields authored by the LLM

  filters:
    - description: check that we can find at least one contact email
      condition: at least one email address was found
      config:
        # execution plan: tool, args (with from_column bindings),
        # output column mapping, cache TTL, concurrency
```

The orchestrator validates the structure of filter `config` blocks via Zod. The content (tool names, column names, conditions) is the LLM's domain.

## Inputs / Outputs

**Inputs:**
- `outbound.yaml` → `source.searches` and `source.filters`
- `@internal/prospects.csv` (optional on first run)

**Outputs:**
- `@internal/prospects.csv` — new rows + filter output columns + filter decision columns (updated for all re-evaluated rows)
- `@internal/sourcing.log` — run history
- `@internal/.cache/hashes.json` — staleness hashes (filters are incremental)
