# Data Access

Agent-Outbound is a CLI that an agent runs on the operator's behalf. The agent asks the operator questions ("what's happening on this list?", "write me briefs for today's route") and needs to pull the relevant state back out of the tool to answer. This doc covers the surface the tool exposes for reading state — the query, export, and schema commands an agent uses to see what's there.

## Why This Matters

The tool is not the interface to the operator. The agent is. The agent composes briefs, summaries, reports, and narratives from the tool's data — and writes them to the operator in whatever form makes sense (chat, email, a file, a slide).

For that to work, the tool has to expose state the agent can actually reach. Aggregate dashboards are not enough. The agent needs to ask arbitrary questions: *which records scored below 50 and have a `books_by_phone` tag? which enrichment step failed to find emails? how many Firecrawl calls did we make this week? what does the full timeline for Beacon Plumbing look like?*

Data access is how the agent answers those questions on its own, without a round-trip to the operator.

## The Three Surfaces

### 1. Query — arbitrary reads via SQL

```
agent-outbound query boise-plumbers --sql "
  SELECT business_name, fit_score, trigger_score, sequence_status
  FROM records_enriched
  WHERE fit_score >= 70
    AND sequence_status = 'idle'
  ORDER BY priority_rank DESC
  LIMIT 20
"
```

The list's data is exposed as a read-only SQL endpoint. The agent writes SQL; the tool runs it against the list's database with write protection on, a row cap, and a timeout. Output is JSON by default.

Read-only is enforced at the engine level — the query runner refuses to execute statements that would mutate state. An agent that accidentally writes `UPDATE` or `DELETE` gets a structured error back, not a silent failure and not a destructive one.

SQL is the right interaction for a wrapping agent because agents write SQL fluently and it's far more expressive than a hand-rolled filter DSL. The tool's job is to teach the schema (see below) and let the agent do what it's good at.

### 2. Schema — self-describing tables and views

```
agent-outbound schema boise-plumbers
agent-outbound schema boise-plumbers --table records
agent-outbound schema boise-plumbers --format markdown
```

Returns the full data contract for the list — every table, every column, every view, with descriptions and example queries. The agent reads this before writing a query against a list it hasn't seen. It's the tool's machine-readable documentation of its own state.

Alongside the raw tables, the tool exposes a set of **pre-joined views** that are stable by design even when the physical layout changes:

- `records_enriched` — records joined with the latest output of every enrichment step, flattened into columns. What the agent reads when it wants "the current picture of each record."
- `records_timeline` — one row per event (email sent, reply received, mail delivered, visit logged, score computed) with the record it belongs to. What the agent reads when it wants "what happened on this record, in order."
- `sequence_state` — records with their current sequence, step, next action, and gating state. What the agent reads when it wants "what's due and why."
- `ai_usage` — LLM token and dollar usage per step, per record, per run. See [AI Usage](./ai-usage.md).
- `tool_usage` — third-party tool invocations per toolkit, tool, step, and record. Counts only — no dollar cost. See [AI Usage](./ai-usage.md).

Views are the preferred surface. They're easier for the agent to reason about than multi-table joins, and they insulate the agent from physical schema refactors.

### 3. Export — project data to a file

```
agent-outbound export boise-plumbers \
  --to ./exports/top-fits.csv \
  --select "business_name, address, fit_score, trigger_score, \
           website-scrape.owner_name, hiring-check.is_hiring, \
           contacts.primary.email, days_since_last_touch" \
  --where "fit_score >= 60 AND sequence_status = 'idle'" \
  --format csv
```

Export writes a projection of the list's data to a file. The projection can reference:

- Base columns on the record (`business_name`, `priority_rank`)
- Outputs from enrichment steps (`website-scrape.owner_name`, `hiring-check.is_hiring`)
- Fields on linked entities (`contacts.primary.email`)
- Computed fields the tool provides (`days_since_last_touch`, `latest_channel_event_type`)

Supported formats: CSV, JSONL, Parquet.

### Why Export Matters for Agents

An agent that wants to answer a compound question ("which prospects are hot, by neighborhood, compared to last month") is better off exporting the relevant columns to a file and running code over that file than stuffing thousands of rows into its context window. Export is the tool's handoff to the agent's coding ability — the agent projects the data it needs, loads the CSV in a code sandbox, groups and pivots and summarizes, and hands the human a report.

Export is also how the agent produces deliverables for the operator: a CSV of today's route with enrichment context, a spreadsheet of replied leads for a CRM import, a sample of failing records for debugging.

### Saved projections

```
agent-outbound views save boise-plumbers --name today-route-brief \
  --select "business_name, address, primary_contact.name, \
           website-scrape.summary, hiring-check.hiring_summary, \
           latest_touch_summary, persona"
```

Common projections can be named and reused. The agent builds a library of projections per list — one for route briefs, one for CRM sync, one for weekly pipeline review — and uses them instead of rewriting the `--select` every time.

## Single-Record Reads

For detail on one record, the tool provides a focused read command:

```
agent-outbound record show boise-plumbers <row_id>
agent-outbound record show boise-plumbers <row_id> --include enrichment,scores,events,contacts,sequence,drafts,ai-usage
```

Returns the full detail the agent needs to write a brief, draft a reply, or explain a decision to the operator:

- Base identity fields
- All enrichment outputs with step attribution (*which step produced which value, when, at what cost*)
- Score history with reasoning
- Channel events timeline
- Contacts
- Sequence state (current step, next action, gating reason)
- Open drafts
- AI usage to-date on this record

`--include` controls which sections are returned so the agent pays only for the data it needs.

## Pipeline and Route Reads

Two high-level reads the agent uses constantly:

```
agent-outbound pipeline show boise-plumbers
```

Rolls sequence state into a real funnel view — cold, contacted, replied, engaged, meeting-booked, won, lost — with per-stage counts and age. The agent uses this when the operator asks *"how's this list doing?"*

```
agent-outbound route show boise-plumbers --date 2026-04-21 --include enrichment,contacts,prior-touches
```

Returns the full payload for a route — every stop with its record data, enriched context, primary contact, and prior-touch history. The agent uses this when the operator says *"write me briefs for Thursday's route"* — one SQL query away from everything the brief needs.

## Reply Threads

```
agent-outbound replies show boise-plumbers --record <row_id>
agent-outbound replies show boise-plumbers --since 2026-04-14 --classification positive
```

Returns the full thread content for replies, not just classification flags. The agent reads this before generating a response draft or deciding how to advance the record.

## What the Operator Sees

The operator doesn't run these commands directly. They ask the agent:

> "Show me the top 20 idle leads by priority."
> "Write briefs for everyone on Thursday's route."
> "Pull a CSV of anyone who replied in the last two weeks, I want to import it into Attio."
> "Why did Beacon Plumbing score low?"

The agent picks the right read (`query`, `export`, `record show`, `route show`, `schema` lookup), composes the answer, and presents it to the operator in whatever form makes sense.

Data access is the agent's window into the tool. It determines how well the agent can answer the operator.

## What Data Access Isn't

- **Not a mutation surface.** Every command here is read-only. Changing state (logging an outcome, updating a record, triggering a sequence) uses the action commands, not `query` or `export`.
- **Not a reporting product.** The tool doesn't render charts or build dashboards. It exposes the data; the agent composes the report.
- **Not a replacement for the operator's CRM.** Durable relationship state lives in the CRM. Data access reads the tool's execution ledger; the agent syncs summaries into the CRM through the CRM tools separately.
- **Not an analytics warehouse.** One list, one database. For cross-list rollups, the agent pulls from each and joins in memory (or via export + code).

## What Agents Can't Do Without This

Most agent-side capabilities depend on data access. Without it:

- Briefs can't be written (no per-record enrichment fetch)
- Reports can't be composed (no structured reads)
- CRM syncs can't be enriched (no projections)
- Questions can't be answered (no query surface)
- Debugging can't happen (no schema introspection)

Everything else the tool does — sourcing, enrichment, scoring, sequencing — is execution. Data access is how the agent turns that execution into something the operator can see and act on.
