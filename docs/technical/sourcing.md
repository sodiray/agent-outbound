# Sourcing (Technical)

Sourcing is a two-phase pipeline: search → filter. Both phases delegate work to the LLM layer via `execute-step`, which runs the AI SDK with pinned Composio tools.

For the user-facing description, see `../product/sourcing.md`.

## Phase 1: Search

Each search entry in `source.searches` describes a query against a specific source. The orchestrator runs all searches in parallel and invokes `execute-step` for each. The AI SDK call has the search's pinned toolkit loaded (whichever local-business-search toolkit the config author selected from Composio); the model calls the tool, interprets results, and emits structured business data via a declared schema.

The orchestrator:
- Writes returned businesses as new records
- Assigns a stable `_row_id`
- Deduplicates against existing records
- Merges data when a duplicate is found
- Tracks search results in the sourcing log

### Deduplication

Dedup is AI-driven, using vector similarity search followed by AI confirmation. See below for the full dedup pipeline.

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

For the record counts in a typical list (hundreds to low thousands), in-memory dot product is fast — no vector index extension needed.

#### AI Confirmation

Each candidate pair is sent to a fast evaluation-tier model (resolved from `ai.defaults.evaluation`) via structured output. The model sees both full records and returns:

```
{ same: boolean, confidence: number, reasoning: string }
```

- `confidence >= 0.7` and `same = true` → auto-linked as duplicate
- `confidence < 0.7` → flagged as `needs_review` for operator resolution
- `same = false` → not linked

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
- `outbound.yaml` → `source.searches` and `source.filters`
- Canonical store (optional on first run)

**Outputs:**
- Canonical store — new records + embeddings + duplicate links + filter output columns + filter decision columns (updated for all re-evaluated records)
- `.outbound/sourcing.log` — run history
- `.outbound/.cache/hashes.json` — staleness hashes (filters are incremental)
