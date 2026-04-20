# agent-outbound

AI-powered outbound pipeline for Claude Code. Source leads, enrich data, score prospects, manage duplicates, run multi-step outreach sequences, plan in-person visit routes, and sync to your CRM — all driven by natural language and whatever MCP tools you have connected.

> **Security warning:** agent-outbound spawns Claude subprocesses with `--dangerously-skip-permissions`. These subprocesses run without permission prompts and have full access to your tools and file system. If a subprocess is orphaned (e.g. the parent MCP server exits unexpectedly), it will continue running until it finishes or you kill it manually. Only use this tool in environments where you trust the outbound config and connected MCP tools. Run `npx agent-outbound kill` to terminate any lingering subprocesses.

## What it does

This is a config-driven outbound system that runs inside Claude Code. You describe what you want in plain English, and it:

1. **Sources** prospects by searching with your connected tools (Google Maps, Yelp, Apollo, etc.)
2. **Filters** results based on criteria you define (field checks or semantic evaluation)
3. **Deduplicates** incoming records against existing data with identity-field matching
4. **Enriches** each prospect with additional data (emails, website research, company info, social media, job postings)
5. **Scores** leads on two axes — **fit** (product-market alignment) and **trigger** (timely engagement signals) — then computes a weighted priority rank
6. **Sequences** multi-step outreach (email, SMS, calls, in-person visits, direct mail) with state tracking, deferral logic, and reply/bounce handling
7. **Plans routes** for in-person visit days with optimized stop ordering
8. **Syncs** qualified prospects and contacts to your CRM

The system is **tool-agnostic**. It discovers whatever MCP tools you have connected to Claude Code and uses them. No vendor lock-in.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- Node.js 18+
- At least one MCP tool connected to Claude Code (e.g., Google Maps, Hunter, Firecrawl, Gmail)

## Quick start

```bash
# Install and configure
npx agent-outbound init

# Create your first list
npx agent-outbound list create boise-dental --description "Dental offices in Boise metro"

# Source initial prospects
npx agent-outbound source boise-dental --limit 50

# Enrich all records
npx agent-outbound enrich boise-dental

# Score and rank
npx agent-outbound score boise-dental

# Or do it all in one shot
npx agent-outbound run boise-dental --more 50
```

### Setup

`init` walks you through a two-step setup:

1. **Composio API key** — connects your external tools (Google Maps, Gmail, Hunter, etc.). Get one at [platform.composio.dev](https://platform.composio.dev).
2. **Anthropic API key** — powers the LLM layer that drives sourcing, enrichment, scoring, and sequencing.

Both keys are validated during setup. Composio reports which toolkits you have connected so you can verify your integrations are ready.

```bash
# Interactive setup (prompts for keys)
npx agent-outbound init

# Non-interactive (CI or scripted)
npx agent-outbound init --composio-api-key KEY --anthropic-api-key KEY --non-interactive
```

## How it works

### The two layers

1. **Orchestrator** (deterministic) — manages pipeline phases, SQLite state, staleness tracking, deduplication, dependency ordering, and the sequence state machine. It never calls external tools directly.

2. **LLM layer** (Claude) — handles all intelligence. When the orchestrator needs to search for businesses, enrich a row, or evaluate a condition, it delegates to Claude, which discovers and calls your connected MCP tools.

### The pipeline

```
outbound.yaml (config)
    |
    v
Source --> Filter --> Enrich --> Score --> Sequence --> CRM Sync
    |                                                     |
    v                                                     v
prospects.db (SQLite state)                      External CRM
```

Each phase reads and writes the same SQLite database. State is fully represented in columns — there's no hidden state outside the DB. The config (`outbound.yaml`) defines what to do; the orchestrator executes it deterministically.

### Config authoring

You never write `outbound.yaml` by hand. The `config author` command takes natural language:

```bash
npx agent-outbound config author boise-dental --request "add an enrichment step that finds contact emails for each business"
```

Claude searches your available MCP tools, finds one that can look up emails (Hunter, Apollo, etc.), and writes the config with proper tool references, argument bindings, and output column mappings.

The config author understands dependencies — if you ask it to remove an enrichment step that other steps depend on, it will block the removal and tell you which steps would break. Use `--force` to override.

### Staleness tracking

The orchestrator tracks a SHA-256 hash of each record's input data per enrichment/scoring step. When you re-run enrichment or scoring, only records whose inputs have changed get reprocessed. This means you can safely re-run `enrich` or `score` and only pay for new or updated records.

### Dependency ordering

Enrichment steps can declare `depends_on` references to other steps' outputs. The orchestrator resolves these into a DAG (directed acyclic graph) and executes steps in topological order. If a dependency is missing (e.g., you removed a step it depends on), the dependent step is skipped with a warning rather than failing silently.

## CLI reference

### List management

```bash
# Create a new list
npx agent-outbound list create <name> [--description TEXT]

# Get detailed status of a list (record counts, score averages, status breakdown)
npx agent-outbound list info <list>

# Overview of all lists in current directory
npx agent-outbound lists
```

### Config

```bash
# Read current config
npx agent-outbound config read <list>

# Update config from a YAML file or inline
npx agent-outbound config update <list> --file config.yaml
npx agent-outbound config update <list> --yaml "source: ..."

# Author config changes from natural language
npx agent-outbound config author <list> --request "add a step that scrapes each business website for team info"
npx agent-outbound config author <list> --request "remove the website-scrape step" --force

# Re-resolve tool references in config (after connecting new toolkits)
npx agent-outbound refresh-tools <list>
```

### Sourcing

Source runs your configured searches and populates the list with new records, deduplicating against existing data.

```bash
# Run all configured searches
npx agent-outbound source <list>

# Limit total records sourced
npx agent-outbound source <list> --limit 50

# Get more records via pagination (resumes where previous sourcing left off)
npx agent-outbound source <list> --more 20
```

**Pagination (`--more`):** The first time you source a list, pagination state is saved per search query. Running `--more N` resumes from where you left off, fetching pages until N new (non-duplicate) records are found or the source is exhausted. If you change a search's config (query, tool, args), the pagination state resets automatically.

### Record removal

Shrink your list by removing records that don't fit. Three modes — use exactly one per invocation.

```bash
# Remove a single record by ID
npx agent-outbound remove <list> --row ROW_ID

# Remove records matching a SQL WHERE clause
npx agent-outbound remove <list> --where "fit_score < 30"
npx agent-outbound remove <list> --where "city != 'Boise'"

# Keep only the top N records, sorted by a column (default: updated_at)
npx agent-outbound remove <list> --keep-top 100 --sort-by fit_score
```

SQL injection protection is built in — dangerous statements (DROP, DELETE, INSERT, UPDATE, ALTER, CREATE) are rejected.

### Enrichment

Enrichment runs your configured steps against records, adding data columns (emails, website content, social media, job postings, etc.).

```bash
# Enrich all records through all configured steps
npx agent-outbound enrich <list>

# Run only a specific step
npx agent-outbound enrich <list> --step website-scrape

# Enrich only records matching a condition
npx agent-outbound enrich <list> --where "fit_score > 70"

# Enrich at most N records
npx agent-outbound enrich <list> --limit 10

# Combine: enrich top prospects through a specific step
npx agent-outbound enrich <list> --step email-lookup --where "fit_score > 80" --limit 5
```

Enrichment automatically re-scores all records after completing, so priority ranks stay current with new data.

### Scoring

Scoring evaluates every record on two axes using your configured rubric:

- **Fit score** (0-100): How well does this business match your ideal customer profile?
- **Trigger score** (0-100): Are there timely signals suggesting they need your product right now?
- **Priority rank** (0-100): Weighted composite of fit and trigger, used for ordering.

```bash
npx agent-outbound score <list>
```

Only re-scores records whose input data has changed since the last run (staleness tracking).

### Pipeline mode

Run the full pipeline in one command: source, enrich new records, then score everything.

```bash
# Full pipeline: source all configured searches, enrich new records, score
npx agent-outbound run <list>

# Pipeline with pagination: get 20 more records, enrich just those, score all
npx agent-outbound run <list> --more 20
```

When using `--more`, enrichment is scoped only to the newly sourced records (not the entire list), so you don't re-enrich records that are already complete.

### Sequencing

Sequences are multi-step outreach campaigns. Each step has a channel (email, SMS, call, visit, mail), timing rules, and optional conditions.

```bash
# Generate draft messages for step 1
npx agent-outbound launch draft <list> [--limit N] [--sequence NAME]

# Send step 1 drafts
npx agent-outbound launch send <list> [--limit N]

# Send follow-up messages for next due steps
npx agent-outbound followup send <list> [--limit N]

# Advance all sequences: evaluate conditions, execute due steps, check replies
npx agent-outbound sequence run <list> [--sequence NAME] [--dry-run]

# Run sequences across all lists in the current directory
npx agent-outbound sequence run --all-lists [--sequence NAME] [--dry-run]

# View pipeline status (record counts by sequence state)
npx agent-outbound sequence status <list>
```

The sequencer handles reply detection, bounce handling, opt-out processing, deferral logic with configurable timeouts, and suppression gate checks before each action.

### In-person visits and route planning

For outbound strategies that include door-to-door or drop-in visits, the route planner optimizes your visit schedule.

```bash
# See today's scheduled visits
npx agent-outbound visits today <list>
npx agent-outbound visits today --all-lists
npx agent-outbound visits today <list> --date 2026-04-25

# Generate an optimized route for a day's visits
npx agent-outbound route plan <list> [--date 2026-04-25]
```

Route planning uses your territory config (home base address, drive radius, visit hours) to order stops and estimate drive times.

### Dashboard

Get a real-time summary of activity across your lists.

```bash
npx agent-outbound dashboard
npx agent-outbound dashboard --list boise-dental
npx agent-outbound dashboard --all-lists
npx agent-outbound dashboard --alerts  # include toolkit connectivity checks
```

Shows recent email replies, today's route schedule, pending calls, draft counts, bounces/opt-outs, and duplicate reviews needing attention.

### CRM sync

Push qualified prospects and contacts to your external CRM. Only syncs records with changed data (stable hashing). Syncs DNC flags back from the CRM as suppression entries.

```bash
npx agent-outbound crm sync <list> [--limit N]
```

### Duplicate management

The deduplication system flags potential duplicates during sourcing. You can review and resolve them manually.

```bash
# List duplicates needing review
npx agent-outbound duplicates list <list> [--status needs_review|confirmed] [--limit N]

# Confirm a duplicate — mark one record as canonical
npx agent-outbound duplicates confirm <list> --row ROW_ID --canonical ROW_ID

# Break a duplicate link (false positive)
npx agent-outbound duplicates break <list> --row ROW_ID
```

### Compliance

Built-in suppression and data deletion for regulatory compliance.

```bash
# Suppress a contact globally (prevents all future outreach)
npx agent-outbound suppress <list> --value "jane@example.com" [--type email|phone|domain] [--reason TEXT]

# Right-to-be-forgotten: scrub PII, suppress all channels, log compliance event
npx agent-outbound forget <list> --email "jane@example.com"
npx agent-outbound forget <list> --phone "208-555-1234"
```

`forget` clears contact name, title, email, and phone from the record; sets all do-not-contact flags; adds global suppression entries; and writes an immutable compliance audit log.

### Toolkit auth

Manage your connected Composio toolkits.

```bash
# List all connected toolkits
npx agent-outbound auth --list

# Get the Composio dashboard URL for a specific toolkit
npx agent-outbound auth <toolkit>
```

### Operations

```bash
# Live activity stream (recent history on connect, then real-time feed)
npx agent-outbound watch <list> [--history]

# Mark stale pending operations as failed (cleanup after crashes)
npx agent-outbound reconcile <list> [--stale-minutes N]

# Kill orphaned Claude subprocesses
npx agent-outbound kill

# Start the MCP server manually (usually auto-started via .mcp.json)
npx agent-outbound serve <list> [--port N]
```

## Using as an MCP server

If you don't use Claude Code or prefer to wire things manually, agent-outbound works as a standalone MCP server with any MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "outbound": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "agent-outbound", "serve"]
    }
  }
}
```

The server exposes 27 tools:

| Tool | Description |
|------|-------------|
| `outbound_list_create` | Create a new outreach list |
| `outbound_list_info` | Detailed status of a list |
| `outbound_lists` | Overview of all lists |
| `outbound_config_author` | Author config from natural language |
| `outbound_config_read` | Read current config |
| `outbound_config_update` | Write raw YAML config |
| `outbound_refresh_tools` | Re-resolve tool references in config |
| `outbound_source` | Run sourcing (search + filter + dedup) |
| `outbound_source_more` | Resume sourcing with pagination for more records |
| `outbound_remove` | Remove records (by ID, WHERE clause, or keep-top-N) |
| `outbound_enrich` | Run enrichment steps (with optional --where/--limit targeting) |
| `outbound_score` | Score records on fit, trigger, and priority rank |
| `outbound_run` | Full pipeline: source, enrich new records, score |
| `outbound_launch_draft` | Create step 1 outreach drafts |
| `outbound_launch_send` | Send step 1 drafts |
| `outbound_followup_send` | Send follow-up messages |
| `outbound_sequence_run` | Advance sequences (evaluate, execute, check replies) |
| `outbound_sequence_status` | Pipeline status by sequence state |
| `outbound_dashboard` | Real-time activity summary |
| `outbound_visits_today` | Today's scheduled visit stops |
| `outbound_route_plan` | Generate optimized visit route |
| `outbound_crm_sync` | Sync records to external CRM |
| `outbound_reconcile` | Clean up stale pending operations |
| `outbound_suppress` | Add global suppression entry |
| `outbound_forget` | Right-to-be-forgotten: scrub PII + suppress |
| `outbound_log` | Log prospect outcomes |
| `outbound_csv_read` | Read record rows with filters |
| `outbound_csv_stats` | Column stats and fill rates |

## Typical workflow

### Initial build

```bash
npx agent-outbound init
npx agent-outbound list create boise-dental --description "Dental offices in Boise metro area"
npx agent-outbound config author boise-dental --request "
  Search Google Maps for dental offices in Boise, Idaho within 15 miles.
  Filter out chains and franchises.
  Enrich with: website scrape for team info, email lookup via Hunter,
  LinkedIn company page, and recent job postings.
  Score fit based on independent practice, 5+ employees, accepts insurance.
  Score trigger based on hiring activity, recent website updates, or expansion signals.
"
npx agent-outbound source boise-dental --limit 100
npx agent-outbound enrich boise-dental
npx agent-outbound score boise-dental
```

### Daily operation

```bash
# Get 20 more fresh prospects, enrich and score in one pass
npx agent-outbound run boise-dental --more 20

# Trim the bottom of the list
npx agent-outbound remove boise-dental --where "fit_score < 30"

# Or keep only the top 200 by priority
npx agent-outbound remove boise-dental --keep-top 200 --sort-by priority_rank

# Re-enrich only high-priority prospects missing email
npx agent-outbound enrich boise-dental --step email-lookup --where "fit_score > 70 AND email_primary = ''"

# Advance sequences and send follow-ups
npx agent-outbound sequence run boise-dental
npx agent-outbound followup send boise-dental

# Plan tomorrow's visits
npx agent-outbound route plan boise-dental --date 2026-04-21

# Check what's happening
npx agent-outbound dashboard --alerts
```

### Working across multiple lists

```bash
npx agent-outbound list create boise-dental
npx agent-outbound list create boise-fitness
npx agent-outbound list create boise-restaurants

# See all lists
npx agent-outbound lists

# Run sequences across everything
npx agent-outbound sequence run --all-lists

# Dashboard across all lists
npx agent-outbound dashboard --all-lists

# Today's visits across all lists
npx agent-outbound visits today --all-lists
```

## License

MIT
