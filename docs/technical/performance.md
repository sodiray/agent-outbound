
# Performance

Implementation plan for performance improvements. Ordered by priority — build in this order.

For baseline measurements from a test run (10 records, 6 enrichment steps, 40 total enrichment executions), see `../../examples/wholesale-coffee-beans/test-results.md`.

Summary of timing:

| Phase | Wall clock | Notes |
|---|---|---|
| Config author (9 steps) | ~5 min | 22 enumeration queries + 1 discovery per invocation |
| Sourcing (10 records) | 4:14 | Filters + dedup dominate call count |
| Enrichment (36 processed) | 11:09 | Sequential steps, sequential records |
| Scoring | 0.14s | Fully cached (hash-based skip) |
| Sequencing (10 sends) | 2:37 | Intent classification + channel execution |
| **Total** | **~23 min** | |

Enrichment is 55% of total runtime. Sourcing is 21%.

## Priority 1: Config-time tool resolution

**Impact**: Eliminates all runtime Composio discovery calls

Every tool-using step currently resolves toolkit names to tool slugs at runtime via `COMPOSIO_SEARCH_TOOLS`, then fetches schemas via `COMPOSIO_GET_TOOL_SCHEMAS`. For 6 enrichment steps on 10 records, that's dozens of Composio round-trips. The in-memory caches help with repeats within a process, but the first invocation of each unique toolkit still pays the full cost.

Move tool resolution to config authoring time. When the config author adds or modifies a step that references a toolkit, the system should immediately:

1. Resolve the toolkit name to specific tool slugs via `COMPOSIO_SEARCH_TOOLS`
2. Fetch the tool schemas via `COMPOSIO_GET_TOOL_SCHEMAS`
3. Store the resolved slugs in `tool.tools`
4. Store the schema metadata in a top-level `tool_catalog` section

The config becomes self-describing. At runtime, the enrichment/sourcing/sequencing runners read tool slugs and schemas directly from the config. The only Composio calls at runtime are `COMPOSIO_MULTI_EXECUTE_TOOL` (actual tool invocations), which are irreducible.

### Config shape change

```yaml
# Before: toolkit reference, resolved at runtime
enrich:
  - id: website-scrape
    config:
      tool:
        toolkits: ['FIRECRAWL']
        tools: []

# After: resolved at config time
enrich:
  - id: website-scrape
    config:
      tool:
        toolkits: ['FIRECRAWL']
        tools: ['FIRECRAWL_SCRAPE_URL', 'FIRECRAWL_CRAWL_URLS']

# Tool schemas stored at config level
tool_catalog:
  FIRECRAWL_SCRAPE_URL:
    description: "Scrape content from a URL"
    parameters:
      type: object
      properties:
        url: { type: string, description: "URL to scrape" }
      required: [url]
```

### What changes

| Component | Change |
|---|---|
| Config schema (`src/schemas/config.ts`) | Add `tool_catalog` top-level field |
| Config author action | After generating changes, resolve new toolkit references → populate `tool.tools` + `tool_catalog` |
| `loadTools` in `runtime/tools.ts` | Read from config `tool_catalog` first; fall back to Composio only for missing schemas |
| `resolveToolkitToolSlugs` | Still used during config authoring; skipped at runtime when `tool.tools` is populated |
| All runners | Pass config's tool catalog to `loadTools` |

### Staleness

If a Composio tool's schema changes after config authoring, the cached schema may be stale. The config author should re-resolve on any `modify_*` op that touches tool specs. A manual `refresh-tools` CLI command should also be available for explicit re-resolution.

### Effect on config author enumeration

The 22-query enumeration (`listConnectedToolkits`) still runs during config authoring but becomes a non-issue — it happens during an interactive session, not on every pipeline run.

## Priority 2: Parallel enrichment across records

**Impact**: 3-5x speedup on enrichment phase

The enrichment runner currently processes records sequentially within each step:

```typescript
for (const step of selectedSteps) {
  for (const record of rows) {       // sequential — this is the bottleneck
    await executeStepAction(record, step)
  }
}
```

The `concurrency` field exists in `StepConfigSchema` but the runner never reads it. Implement a concurrency pool for the inner record loop:

```typescript
for (const step of selectedSteps) {
  await pMap(rows, (record) => executeStepAction(record, step), {
    concurrency: step.config?.concurrency ?? 3
  })
}
```

Apply the same pattern to:
- `scoring/runner.ts` — parallelize per-record scoring
- `sourcing/runner.ts` — parallelize filter evaluation + dedup across records
- `sequencer/runner.ts` — parallelize per-record sequence execution

### Constraints

- SQLite writes serialize naturally (WAL mode). The `busy_timeout = 5000ms` pragma handles contention. If this becomes a bottleneck at high concurrency, batch writes after parallel LLM calls complete.
- Composio and LLM-provider rate limits cap effective parallelism. Start with concurrency 3-5 and tune.

## Priority 3: Dependency DAG for enrichment

**Impact**: Skip unnecessary re-enrichment + enable branch parallelism

The architecture and enrichment docs describe dependency-level parallelism, but the current runner does not implement it. `depends_on` only affects cache invalidation hashing — it does not control execution order. Steps always run in array order. If step A fails, step B (which depends on A) still runs with missing inputs. Independent branches cannot be parallelized.

### What to build

Parse `depends_on` into a DAG at the start of each enrichment run:

1. **Topological sort**: Execute steps in dependency order, not array order
2. **Level-based parallelism**: Steps at the same dependency level run concurrently (in addition to Priority 2's record-level parallelism within each step)
3. **Skip downstream on failure**: If step A fails for a record, skip all steps that transitively depend on A for that record
4. **Targeted re-enrichment**: On re-runs, only re-execute steps whose specific upstream dependencies changed

Example execution graph for a config with 5 steps:

```
website-scrape ──┬── contact-lookup ──┬── outreach-draft
                 ├── hiring-check     │
social-research ──────────────────────┘
```

`website-scrape` and `social-research` run in parallel (level 0). `contact-lookup` and `hiring-check` run in parallel after `website-scrape` completes (level 1). `outreach-draft` runs last (level 2).

This is what `enrichment.md` already describes as the target behavior. The implementation needs to match.

## Priority 4: Batch and code-based filter evaluation

**Impact**: Eliminate most filter LLM calls

Every filter is currently evaluated per-record via individual Haiku LLM calls. For 10 records with 3 filters, that's 30 calls — even when filters are simple field checks like "has a website."

### Two-tier evaluation

1. **Code-based filters**: For conditions expressible as field comparisons (equality, range, presence), evaluate in code. Tag these with `type: field_check`.
2. **Batched LLM filters**: For semantic conditions requiring judgment, batch multiple records into a single Haiku call with structured output returning a boolean per record.

### Config shape change

```yaml
filters:
  # Code-based (no LLM call)
  - id: has-website
    type: field_check
    condition: { field: website, operator: is_not_empty }

  # LLM-evaluated (batched)
  - id: good-fit
    type: semantic
    condition: "Business appears to be independently owned and would benefit from wholesale pricing"
```

## Priority 5: Prompt caching

**Impact**: 30-50% token cost reduction on enrichment and scoring

Each enrichment step sends the same prompt template and step config for every record — only the record data varies. With 40 records per step, the shared prompt prefix is sent 40 times without caching.

`runtime.md` already describes the prompt caching approach. The implementation needs to structure messages so the system prompt + step config is a stable cacheable prefix, with per-record data appended as the variable suffix. This is a configuration change in the AI SDK provider setup, not an architectural change.

## Lower priority

### Consolidate route planning validation

`plan-route/index.ts` calls `assertToolSpecAvailable()` then `loadTools()` for the same toolkit — two Composio calls where one suffices. Remove the `assertToolSpecAvailable` call; let `loadTools` handle the failure.

### Cache config per pipeline run

Config is re-parsed from YAML on every runner invocation. The sequencer calls `readConfig()` three separate times. Read once at pipeline start, pass through.

## Expected outcome

With priorities 1-2 implemented, a 10-record pipeline run drops from ~23 minutes to ~8-10 minutes. With all five, the target is ~5-7 minutes — bounded by actual tool execution time and LLM inference, which are irreducible.

At 100 records (production scale), current architecture takes ~2-3 hours. With parallelism and config-time resolution, the target is ~20-30 minutes.
