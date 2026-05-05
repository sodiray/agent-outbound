# Storage

The canonical record store is **SQLite**. One database file per list at `.outbound/prospects.db`. Every piece of state — records, contacts, per-channel events, scores, embeddings, duplicate links, suppression, routes, idempotency markers, costs, audit log — lives in this file.

SQLite is the authoritative store from day one. There is no CSV fallback mode; the tool does not ship a CSV backend.

## Why SQLite

- **Relational model.** Records, contacts, and events are real tables with foreign keys. Multi-contact businesses work cleanly. Channel history is preserved as an event log, not flattened to "last action only" columns.
- **Transactional writes.** Every mutation is wrapped in a transaction. Concurrent processes (CLI one-shots + long-running `serve` mode) coordinate via WAL-mode locking without losing writes.
- **Indexed queries.** The daily dashboard runs dozens of filters-and-joins per refresh. Linear CSV scans don't scale; indexed SQLite queries do.
- **Zero infrastructure.** One file. No daemon, no network service, no migration tooling. Trivial to back up (copy the file), move between machines, or inspect with `sqlite3`.
- **WAL concurrency.** Multiple readers + one writer at a time. Fits the CLI + `serve` + background trigger-handler model perfectly.

## File Layout

**Every list is its own directory.** Each list's directory contains both operator-owned files (at the root) and tool-managed state (inside a `.outbound/` subdirectory). The list's SQLite database is created inside that list's `.outbound/` folder — one database per list, always isolated to that list's directory.

```
boise-plumbers/                 # list directory (the "list root")
  outbound.yaml                 # operator-editable config
  .outbound/                    # tool-managed internal state (auto-created)
    prospects.db                # canonical SQLite store for THIS list
    prospects.db-wal            # WAL file (SQLite-managed)
    prospects.db-shm            # shared memory (SQLite-managed)
    .activity/
      current.sock              # live activity stream socket
      history.jsonl             # recent activity ring buffer (fallback to DB's activity_history)
    .serve/
      pid                       # running serve-mode PID (if any)
      port                      # HTTP port for serve mode
    logs/
      sourcing.log              # sourcing run history (append-only JSONL)
      compliance.log            # suppression audit trail
      crm.log                   # CRM sync history
      costs.jsonl               # LLM + Composio cost events
```

The tool creates only `outbound.yaml` and `.outbound/` when a list is initialized. Nothing else is scaffolded — the operator creates whatever directories and files they need (assets, templates, prompts, etc.) and references them in step descriptions using paths relative to the list directory.

The `.outbound/` directory is auto-created the first time the operator runs any command against the list. Its contents should not be hand-edited; the orchestrator owns every file inside.

### Path Resolution

All paths in config and step descriptions are **relative to the list directory**. There are no virtual roots or path aliases — `./assets/postcard.pdf` means `boise-plumbers/assets/postcard.pdf`. The agent is given the list directory as its working root in prompts, so relative references resolve naturally.

### Working directory

The operator runs `agent-outbound` commands from whichever parent directory holds their lists. Each `agent-outbound <command> <list-name>` resolves `<list-name>` to a subdirectory of the current working directory. There is no global registry of lists — a list is wherever its directory is.

### Global state (outside any list)

```
~/.agent-outbound/
  env                           # COMPOSIO_API_KEY + one or more LLM-provider keys (ANTHROPIC_API_KEY, DEEPINFRA_API_KEY, …) (chmod 600)
  suppression.db                # global suppression (separate SQLite file)
  settings.yaml                 # operator preferences
```

Global state is minimal — only auth credentials, the global suppression list, and operator preferences. Everything else is per-list and lives under that list's `.outbound/` directory.

## Schema Overview

The orchestrator owns the single authoritative schema. The full column-level reference is `data-schema.md`; this is the table inventory:

| Table | Purpose |
|---|---|
| `records` | One row per business location. Wide — identity, enrichment output, scores, sequence cursor, CRM IDs, suppression flags, duplicate links, outcome. |
| `record_embeddings` | One embedding per record. 384-dim vectors for dedup similarity search. |
| `contacts` | One row per contact. Relational to `records`. Supports multiple contacts per business. |
| `channel_events` | Append-only event log of every email, mail, visit, SMS, call touch. Provider IDs, timestamps, dispositions. |
| `score_events` | Append-only. Each scoring run emits one entry per axis with score + agent reasoning. |
| `suppression` | Suppression entries with reason, scope (global vs. per-list), source. Queried on every send. |
| `routes` | Daily visit routes. One row per planned route. |
| `route_stops` | Ordered stops within a route. Relational to `routes` and `records`. |
| `staleness` | Enrichment staleness tracking. Per (record, step) hash + timestamp. |
| `idempotency` | Destructive-action markers. Per (record, step) keys mapping to provider IDs. |
| `cost_events` | LLM token usage + Composio tool-call cost, per step per record. |
| `compliance_log` | Append-only audit log for suppression changes, opt-outs, forget requests. |
| `activity_history` | Recent phase/step/record events. Watch-mode reconnect source. Bounded ring buffer. |

## Concurrency Model

SQLite in WAL mode supports:
- **Multiple concurrent readers** (CLI one-shots, `serve`, `watch`, ad-hoc queries)
- **One writer at a time** (serialized via SQLite's internal locking)

Readers don't block writers, writers don't block readers. A short transaction (tens of ms) is enough for every mutation the orchestrator does.

For longer-running operations (e.g., enrichment batch of 500 records), the orchestrator breaks writes into per-record transactions rather than holding a single long transaction. Each per-record write is atomic; the batch as a whole is resumable.

Two processes that *both* need to write simultaneously simply serialize — the second blocks on SQLite's lock for milliseconds, which is almost always fine at operator scale. If `serve` mode is running and a CLI one-shot fires a mutation, they coordinate through SQLite; no explicit file locking or IPC needed.

## Writing the DB Is Deterministic

Only the orchestrator writes to SQLite. AI SDK calls (inside action modules) return typed structured output; the orchestrator applies those outputs to the database via typed DB operations. The AI never has a "write to SQLite" tool available.

This is a strict invariant:
- Destructive operations pass through idempotency wrappers
- Every mutation logs to the appropriate audit log
- Transactional integrity is guaranteed (related writes land together)
- Schema drift from AI-authored writes is impossible

## Schema Definition

The orchestrator ships with a single embedded schema — one authoritative `SCHEMA` constant holding every `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` statement. On every open, the orchestrator executes `SCHEMA` against the DB. New DBs get the schema; existing DBs see no-op statements (everything already exists).

There is no migration runner, no `schema_version` table, no numbered migration files. This is a single-operator utility; the schema either matches or it doesn't. When the schema changes during development, the operator can drop `.outbound/prospects.db` and re-source the list — it's not a production system with years of historical data to preserve.

The only dynamic `ALTER TABLE` is for operator-added enrichment step output columns: when `author-config` adds a step that writes a previously-unknown column to `records`, the orchestrator runs `ALTER TABLE records ADD COLUMN <name> <type>` at step registration time. This is an operator-driven schema extension, not a migration — it's triggered by the operator's config edit and only ever adds columns, never restructures them.

If a schema change between versions of the tool would require destructive structural changes (dropping a table, renaming a column), the release notes instruct the operator to re-source affected lists. The tool is small enough to make that a reasonable ask.

## Backup and Recovery

- **Manual backup**: during idle time, `cp prospects.db prospects.backup-<date>.db`. During activity, use SQLite's online backup: `sqlite3 prospects.db ".backup 'prospects.backup-<date>.db'"`.
- **Automatic backup**: the orchestrator snapshots before destructive operations (list resets, `forget` commands touching many records).
- **Recovery**: SQLite's WAL design recovers from crashes automatically; worst case loses the in-flight transaction.

The CRM holds the external durable copy of relationship-level state. If a list's DB is lost entirely, re-linking from the CRM rebuilds most of what matters (records, contacts). Sequence state is harder to reconstruct — that's the execution ledger that only lives here.

## When to Move to Postgres

SQLite covers single-operator, local-only use cases indefinitely. The upgrade story is Postgres, not "better SQLite."

Triggers for moving to Postgres:
- **Multi-operator** — more than one person writing to the same lists concurrently from different machines
- **Shared hosting** — running the tool as a service instead of a CLI
- **Cross-list analytics at scale** — rollups across many large lists that want partitioning or materialized views
- **Replication** — durability / HA requirements beyond "my laptop's disk"

Upgrade approach: the DB layer goes through a single module (`src/orchestrator/runtime/db.ts`). SQLite and Postgres drivers would implement the same interface; swapping is a driver change, not a rewrite of every query. Not in scope now.

## Inspecting the DB

Operator-friendly paths:

```bash
# Open the DB in the SQLite CLI
sqlite3 boise-plumbers/.outbound/prospects.db

# Schema inspection
.schema
.tables

# Common queries
SELECT business_name, fit_score, trigger_score, sequence_status
FROM records
WHERE sequence_status = 'active'
ORDER BY fit_score * 0.6 + trigger_score * 0.4 DESC
LIMIT 20;
```

For GUI, any SQLite viewer works (DB Browser for SQLite, TablePlus, DataGrip). Nothing is hidden — the operator can inspect directly.

## Why Not CSV

Earlier designs started on CSV with SQLite as an upgrade. That path was dropped. Reasons:

- **Multi-contact was always going to need a relational table.** Flattening as `contact_2_*`, `contact_3_*` columns was awkward from day one.
- **Channel history as "last action only"** was always going to be limiting. An event table is better from the start.
- **Concurrency between CLI and `serve`** wants SQLite's WAL mode. CSV file locks are strictly worse.
- **Indexing and queries** matter as soon as the daily dashboard runs against non-trivial data.

CSV's advantages (human-readable, git-trivial) aren't worth the architectural compromise. SQLite with any decent browser approximates the human-readability benefit; `.sql` dumps cover git-diffability when needed.

## Dependencies

The tool uses **`better-sqlite3`** as the Node SQLite driver — synchronous, fast, battle-tested. SQLite operations are I/O-bound and fit the synchronous model well. WAL mode is enabled on every connection at startup.
