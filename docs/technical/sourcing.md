# Sourcing (Technical)

Sourcing is a two-phase pipeline: search → filter. Both phases delegate work to the LLM layer via `execute-step`, which runs the AI SDK with pinned Composio tools.

For the user-facing description, see `../product/sourcing.md`.

## Phase 1: Search

Each search entry in `source.searches` describes a query against a specific source. The orchestrator runs all searches in parallel and invokes `execute-step` for each. The AI SDK call has the search's pinned toolkit loaded (whichever local-business-search toolkit the config author selected from Composio); the model calls the tool, interprets results, and emits structured business data via a declared schema.

A search can return rows through the structured final `results` payload or directly from its tool invocation. A direct result may be a row array or an object with one array-valued field. The orchestrator treats those rows as search results and applies the search's existing `output_map` before insertion.

The orchestrator:
- Writes returned businesses as new records
- Assigns a stable `_row_id`
- Deduplicates against existing records
- Merges data when a duplicate is found
- Tracks search results in the sourcing log

For a `keyword_geo` strategy, the orchestrator expands the current `keywords` or `keywords_from` value on every run. Each keyword/geography pair has durable task state. Newly added pairs are created as pending tasks without re-running completed pairs; pending work that has never run is selected before retried or resumed work. `source.budget.max_calls` limits each run, so repeated `source` runs continue through any remaining pending pairs. The sourcing summary reports newly created tasks and the pending count remaining after the run.

Record field names may use SQL keywords such as `group`, `order`, and `select`. Agent Outbound quotes record identifiers when it creates and updates dynamic record columns; field checks and review fields use those names directly. In SQL supplied to `query` or `--where`, quote such names with double quotes (for example, `"group" = 'enterprise'`).

### Deduplication

Dedup first applies the configured exact `dedup_key`. AI dedup then uses vector similarity search followed by AI confirmation only when the row has a fuzzy identity. A row whose configured exact key is its identity, or whose sole identity is an opaque 24-character hex external ID, skips AI dedup by default; `source.ai_dedup: on` explicitly enables it.

#### Identity

The list's config declares an **identity** — an ordered list of fields that the agent determined best distinguish records for this list:

```yaml
identity:
  - name
  - address
```

The identity fields are chosen by the agent when the list is first created, based on the list's purpose and the data shape. If the list goal changes and the identity should change, the agent updates the config, regenerates all embeddings, and re-runs the full dedup pass.

#### Embedding

Each record's identity fields are concatenated in the declared order (separated by `, `) and embedded into a 384-dimensional vector using `all-MiniLM-L6-v2` via `@xenova/transformers` (ONNX runtime, runs in-process in Node). The model is loaded once as a singleton and reused across all embedding calls. No external API, no per-embed cost.

Embeddings are L2-normalized and stored as binary BLOBs (`Float32Array.buffer`) in the `record_embeddings` table alongside the record ID.

#### Similarity Search

When a new record arrives during sourcing:

1. Build the identity string from the ordered fields
2. Embed it using the same model
3. Load all existing embeddings and compute dot product (cosine similarity, since vectors are L2-normalized) against each
4. Any existing records above a similarity threshold of 0.85 become **candidate duplicates**

AI confirmation considers only the top `source.ai_dedup_max_candidates` candidates by similarity (default `3`). It makes no more than `source.ai_dedup_max_calls` confirmation calls in one sourcing run (default `100`), including refresh and child relinking. On reaching that ceiling, sourcing stops AI dedup for the run, returns a warning, and marks remaining AI-dedup rows `needs_review` rather than continuing comparisons.

For the record counts in a typical list (hundreds to low thousands), in-memory dot product is fast — no vector index extension needed.

#### AI Confirmation

When `ai.decide` is configured, each candidate pair is sent to the decide provider as one yes/no question: “Do records A and B refer to the same real-world entity (the same person or the same business)?” The `noul` answer is interpreted as the probability of yes: yes at confidence `>= 0.7` is confirmed, yes below that threshold needs review, and no is not linked. Without `ai.decide`, confirmation falls back to the fast evaluation-tier model resolved from `ai.defaults.evaluation`, using the same question and state.

Neither path receives full records. Confirmation sends only the project-defined `source.ai_dedup_fields` payload: the same ordered, labelled `label: value` lines for record A and record B. A bare string is shorthand for `{ field: <name> }`; an object can supply a display label, and dotted paths traverse a JSON-typed record field. Empty values are omitted. `source.ai_dedup: on` requires a non-empty payload specification. Each value is capped by `source.ai_dedup_max_chars_per_field` (default `500`). `source.ai_dedup_context` optionally describes the record population for the question, such as “people who own small consulting firms; same person even if title differs.”

The fallback model returns:

```
{ same: boolean, confidence: number, reasoning: string }
```

- `confidence >= 0.7` and `same = true` → auto-linked as duplicate
- `confidence < 0.7` → flagged as `needs_review` for operator resolution
- `same = false` → not linked

Every AI confirmation call, including a non-match, is written to the cost ledger as `sourcing:dedup` (or `sourcing:dedup_relink` during relinking), so `ai-usage` reports the total confirmation spend.

#### Linking

Confirmed duplicates are **linked, not deleted**. The new record gets `duplicate_of` set to the canonical record's ID and `duplicate_status` set to `confirmed` or `needs_review`. Both records stay in the database with all their data.

At enrichment time, the orchestrator presents data from all linked records to the agent as context. The agent decides which data to use — best email, best phone, richest signals — producing a richer canonical record than any single source alone.

#### Incremental Behavior

Dedup runs as part of the sourcing loop, not as a separate phase. Each batch of new records is embedded and checked against existing records immediately after insertion. The identity string for each record is hashed (SHA-256) alongside the identity schema; re-embedding only happens when either the record's identity fields or the identity schema itself changes.

### Geography

Search configs declare territory constraints (city list, ZIP list, county, radius from a home base). The LLM uses these when authoring queries. After results land, an optional geocoding step populates `latitude`/`longitude` for later route planning.

## Phase 2: Filter

After searches complete, filters run against **all records with stale filter results** — not just new records. A record's filter result is stale when:

1. The record has never been evaluated against this filter
2. The filter config changed (condition modified, args changed)
3. A column the filter depends on changed (e.g., a later enrichment step populated a column the filter reads via `from_column`)

### Filter execution

For each filter, for each stale record:
1. Orchestrator calls `execute-step` with filter config and record data
2. AI SDK runs the agent loop with pinned filter tools; model emits schema-validated output
3. Orchestrator writes output to columns specified in the filter config
4. Orchestrator calls `evaluate-condition` with the condition text and the step output
5. Orchestrator writes a deterministic pass/fail column for the filter

Filters run records in parallel (concurrency from filter config, default 10).

### Aggregate columns

After all filters run, the orchestrator recomputes aggregate columns for every re-evaluated record:
- `source_filter_result: "passed" | "failed"`
- `source_filter_failures: "" | "filter_a,filter_b"`

A record that previously failed can become "passed" if filter config or upstream data changes. A record that previously passed can become "failed" if a new filter is added that it doesn't satisfy.

## Config Shape

```yaml
source:
  # Optional. Exact-key identities skip AI dedup by default; fuzzy identities run it.
  # Set on only when an exact-key identity also needs fuzzy AI matching.
  ai_dedup: on # on | off
  # Required when ai_dedup is on. The exact A/B confirmation payload, in order.
  ai_dedup_fields:
    - { field: first_name, label: First name }
    - { field: company, label: Firm }
    - { field: extra_json.headline, label: Headline }
  ai_dedup_max_chars_per_field: 200
  ai_dedup_context: people who own small consulting firms; same person even if title differs
  ai_dedup_max_candidates: 3 # top vector candidates confirmed per row
  ai_dedup_max_calls: 100 # total confirmation calls per sourcing run
  searches:
    - source: local_business_search
      query: "plumber Boise Idaho"
      config:
        tool:
          toolkits: [YOUR_SEARCH_TOOLKIT]    # e.g., GOOGLE_MAPS, FOURSQUARE, etc.
          tools: [SEARCH_PLACES_ACTION]       # specific action slug from Composio
        args:
          query: { literal: "plumber" }
          location: { literal: "Boise, ID" }
          radius_meters: { literal: 20000 }
        output_map:
          place_id: google_place_id
          name: business_name
          address: address
          phone: phone
          website: website
        model: anthropic/claude-sonnet-4-6
        step_budget: 5

  filters:
    - description: must have a website
      condition: website field is non-empty
      config:
        tool: null
        args:
          website: { from_column: website }
        concurrency: 50
```

The orchestrator validates structure via Zod. Tool references resolve at action time.

## Inputs / Outputs

**Inputs:**
- `outbound.yaml` → `source.searches`, `source.strategies`, and ordered `pipeline` filters
- Canonical store (optional on first run)

**Outputs:**
- Canonical store — new records + embeddings + duplicate links + filter output columns + filter decision columns (updated for all re-evaluated records)
- `.outbound/sourcing.log` — run history
- `.outbound/.cache/hashes.json` — staleness hashes (filters are incremental)
