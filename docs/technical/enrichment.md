# Enrichment (Technical)

Enrichment fills in columns on qualified records. The orchestrator processes configured steps in dependency order, delegating each step's execution to the AI SDK with pinned Composio tools. Output is schema-validated and written to the `records` table (or appropriate child table) via the deterministic DB layer.

For the user-facing description, see `../product/enrichment.md`.

## Step Execution

Each enrichment step has a human-readable outer layer and a nested `config` with the compiled execution plan:

```yaml
enrich:
  - description: find the key decision-maker and their title
    config:
      args:
        business_name: { from_column: business_name }
        website: { from_column: website }
      outputs:
        contact_name:
          type: string
          description: Full name of the most senior operational decision-maker
        contact_title:
          type: string
          description: Their job title (e.g., Owner, Director, Studio Manager)
        contact_linkedin_url:
          type: string
          description: LinkedIn profile URL if found, empty string otherwise
      depends_on:
        - business_name
        - website
      cache: 90d
      concurrency: 10
      model: sonnet
      step_budget: 10
      tool:
        toolkits: [FIRECRAWL, SERPAPI]
        tools: [FIRECRAWL_SCRAPE, SERPAPI_SEARCH]
      prompt: |
        Scrape the website's team or about page. Identify the most senior
        operational decision-maker (owner, manager, director). Return their
        full name, title, and a LinkedIn URL if visible.
```

### The `outputs` declaration

Each key in `outputs` is both the field name the LLM returns and the database column name — they're always the same. Each value carries:

- **`type`** — `string`, `number`, `integer`, or `boolean`. Determines the SQLite column type (`TEXT`, `REAL`, `INTEGER`, `INTEGER`) and the Zod primitive used for validation.
- **`description`** — What the LLM should produce for this field. Injected into the execution prompt so the model knows the expected content.
- **`enum`** (optional) — Constrains the value to a fixed set (e.g., `[boutique, clinical, fitness-chain]`).

At config authoring time, the AI determines what outputs make sense for the step's purpose and declares their types and descriptions. This is the single source of truth for the LLM contract, the DB schema, and the dependency tracking.

### Execution flow

The orchestrator:
1. Reads config (including `tool_catalog`) and builds the dependency graph from `depends_on` declarations
2. Computes dependency levels via topological sort. Steps at the same level run in parallel; records within a step run in parallel up to the step's `concurrency` cap. See § Dependency Graph below.
3. For each record, checks staleness (SHA-256 hash of dependency values + config)
4. For stale/missing records, builds a step-specific Zod schema from the `outputs` declaration and calls `execute-step` with the step config, record data, and schema. Tool schemas are read from the config's `tool_catalog` — no Composio discovery calls at runtime.
5. The AI SDK runs the agent loop — model calls tools (schemas loaded from catalog), does research, returns a structured object matching the step-specific schema
6. Orchestrator validates each output field against its declared type (Zod primitives) and coerces for SQLite compatibility (booleans → 0/1, arrays → JSON strings, etc.)
7. Writes output fields directly to `records` columns (output key = column name) through the deterministic DB layer
8. Updates the staleness cache
9. If a step fails for a record, all downstream steps that transitively depend on it are skipped for that record

The orchestrator doesn't know what any step does. It hands the config to the LLM, validates the typed output, and writes it back.

For the full performance analysis and implementation plan, see `performance.md`.

## Staleness Detection

The orchestrator tracks whether a record's enrichment step needs to re-run by hashing:
- Values of dependency fields (declared in `depends_on` — either bare column names or qualified `step_id.output_field` references)
- The step config itself (including the `outputs` declaration)

If none have changed since the last run, the record is "fresh" and skipped. If any changed, the record is "stale" and re-processed.

When `depends_on` uses qualified references (e.g., `website_research.owner_name`), only the specific upstream output values are included in the hash — not the entire upstream step's output. This means a downstream step only re-runs when the specific properties it depends on change.

Cache TTL (`cache: 90d`) provides time-based expiration on top of the hash check.

### Default TTLs per category

| Category | TTL |
|---|---|
| Contact info | 90d |
| Tech stack | 90d |
| Reviews / social activity | 14d |
| Hiring signals | 7d |
| Website freshness | 7d |
| Vertical / persona / workflow | 180d |

## Skip Logic

Records where `source_filter_result = "failed"` or `suppressed = true` are skipped by enrichment. The orchestrator checks these before processing each record.

## Dependency Graph

Steps declare `depends_on` as a list of references. Each reference is either a bare column name (e.g., `website`) or a qualified property reference in the form `step_id.output_field` (e.g., `website_research.owner_name`). The orchestrator computes dependency levels:
- **Level 0**: steps with no dependencies, or dependencies already present from sourcing
- **Level N**: steps whose dependencies all appear in levels 0..N-1

Same-level steps run in parallel. Within each step, records run in parallel up to the step's concurrency cap (configurable per step, recommended 3-5 to start — bounded by Composio and Anthropic rate limits).

If a step fails for a specific record, all steps that transitively depend on it are skipped for that record. Other records are unaffected.

If dependencies form a cycle, the orchestrator errors at config validation.

### Property-level staleness

When `depends_on` uses qualified references (`step_id.output_field`), the staleness hash for the downstream step is computed from the specific output values of the upstream step — not the entire upstream step's output. This means if upstream step `website_research` re-runs and `owner_name` changes but `class_types` doesn't, a downstream step that only depends on `website_research.class_types` won't re-run.

This is a meaningful cost optimization. For a list of 200 records going through 4 enrichment steps, property-level staleness avoids re-running expensive downstream steps when unrelated upstream fields change.

## Inputs / Outputs

**Inputs:**
- `outbound.yaml` — enrichment steps with `outputs` declarations and nested `config`
- Canonical store
- Any files referenced by step configs (paths relative to the list directory)

**Outputs:**
- Canonical store — updated with columns derived from `outputs` declarations (column types match declared types)
- `staleness` table — per-(record, step) dependency hashes for staleness detection
