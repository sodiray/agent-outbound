# Enrichment

## Purpose

Given a list of businesses (rows in the canonical CSV), fill in configured data points. Enrichment never adds or removes rows — it only adds columns and values.

Enrichment is:
- **Config-driven:** add/remove/reorder steps by modifying config (via `/outreach`)
- **Incremental:** only stale/missing outputs get recomputed
- **Executed by the LLM:** the orchestrator delegates each step to Claude, which calls tools and produces output

## Step Execution

Each enrichment step has a human-readable outer layer and a nested `config` with the compiled execution plan:

```yaml
enrich:
  - description: find the key decision-maker and best contact info
    config:
      args:
        business_name: { from_column: business_name }
        website: { from_column: website }
      columns:
        decision_maker_name: key_contact_name
        decision_maker_email: key_contact_email
      depends_on: [business_name, website]
      cache: 90d
      concurrency: 10
      # ... tool reference, prompt, platform, model
```

The orchestrator:
1. Reads config and builds the dependency graph from `depends_on` declarations
2. Processes steps in dependency order (steps at the same level run in parallel; rows within a step run in parallel)
3. For each row, checks staleness (SHA-256 hash of input dependencies + prompt content + referenced file content)
4. For stale/missing rows, calls `execute-step` with the step config and row data
5. The LLM executes the step — calls MCP tools, does research, writes copy — and returns structured output
6. Orchestrator maps output keys to CSV columns via the `columns` config and writes them
7. Updates the staleness cache

The orchestrator doesn't know what any step does. It doesn't know whether a step calls Hunter, Apollo, Google Maps, or just does pure AI reasoning. It hands the config to the LLM and writes back whatever comes out.

## Staleness Detection

The orchestrator tracks whether a row's enrichment step needs to re-run by hashing:
- Values of input columns (declared in `depends_on`)
- Prompt file content (if the step references a prompt file)
- Referenced file contents (if the step includes supporting files)
- The step config itself

If none of these have changed since the last run, the row is "fresh" and skipped. If any changed, the row is "stale" and re-processed.

Cache TTL (`cache: 90d`) provides a time-based expiration on top of the hash check.

## Skip Logic

Rows where `source_filter_result = "failed"` are skipped by enrichment. The orchestrator checks this before processing each row.

## Rubric

The rubric is a standalone phase that runs after enrichment. It scores each row against configured criteria.

### Config Shape

```yaml
rubric:
  - description: has the decision maker's email address
    score: +3
    config:
      columns: [key_contact_email]
      result_column: rubric_has_dm_email

  - description: has no email address
    score: -3
    config:
      columns: [key_contact_email]
      result_column: rubric_no_email
```

### How It Works

For each row:
1. For each criterion: the orchestrator calls `evaluate-condition` with the criterion description and the referenced column values
2. Writes `result_column` as `"true"` or `"false"`
3. Sums earned points (positive scores for true criteria, negative scores for true negative criteria)
4. Writes `lead_score = max(0, round((earned / max_possible) * 100))` — always 0-100
5. Writes `lead_score_breakdown` with per-criterion results

The rubric uses the same staleness detection as enrichment steps.

## Inputs / Outputs

**Inputs:**
- `outbound.yaml` — enrichment steps and rubric criteria with nested `config`
- `@internal/prospects.csv` — canonical dataset
- Any `@list/...` and `@internal/...` files referenced by step configs

**Outputs:**
- `@internal/prospects.csv` — updated with columns defined by step configs
- `@internal/.cache/hashes.json` — dependency hashes for staleness detection
