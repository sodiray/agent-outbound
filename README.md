# agent-outbound

AI-powered outbound pipeline for Claude Code. Source leads, enrich data, score prospects, and run multi-step outreach sequences — all driven by natural language and whatever MCP tools you have connected.

## What it does

This is a config-driven outbound system that runs inside Claude Code. You describe what you want in plain English, and it:

1. **Sources** prospects by searching with your connected tools (Google Maps, Yelp, Apollo, etc.)
2. **Filters** results based on criteria you define
3. **Enriches** each prospect with additional data (emails, website research, company info)
4. **Scores** leads against a rubric you configure
5. **Sequences** multi-step outreach (email drafts, follow-ups, call lists) with state tracking

The system is **tool-agnostic**. It discovers whatever MCP tools you have connected to Claude Code and uses them. No vendor lock-in.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- Node.js 18+
- At least one MCP tool connected to Claude Code (e.g., Google Maps, Hunter, Firecrawl, Gmail)

## Quick start

```bash
# In your project directory
npx agent-outbound init
```

This creates:
- `.claude/commands/outbound.md` — the `/outbound` command for Claude Code

Then open Claude Code and type:

```
/outbound create a list called my-prospects
```

## How it works

### The two layers

1. **Orchestrator** (deterministic) — manages pipeline phases, CSV state, staleness tracking, deduplication, dependency ordering, and the sequence state machine. It never calls external tools directly.

2. **LLM layer** (Claude) — handles all intelligence. When the orchestrator needs to search for businesses, enrich a row, or evaluate a condition, it delegates to Claude, which discovers and calls your connected MCP tools.

### The pipeline

```
outbound.yaml (config)
    ↓
Source → Filter → Enrich → Score → Sequence
    ↓
prospects.csv (state)
```

Every phase reads and writes the same canonical CSV. State is fully represented in columns. The config (`outbound.yaml`) defines what to do; the orchestrator executes it.

### Config authoring

You never write `outbound.yaml` by hand. The `/outbound` command takes natural language:

```
/outbound add an enrichment step that finds contact emails for each business
```

Claude searches your available MCP tools, finds one that can look up emails (Hunter, Apollo, etc.), and writes the config with proper tool references, argument bindings, and output column mappings.

## CLI Commands

Run `agent-outbound --help` for the full command list. Run `agent-outbound <command> --schema` for argument details.

| Command | Description |
|---------|-------------|
| `lists` | Overview of all lists |
| `list info` | Detailed status of a list |
| `list create` | Create a new outreach list |
| `config author` | Author config from natural language |
| `config read` | Read current config |
| `config update` | Write raw YAML config |
| `source` | Run sourcing (search + filter) |
| `enrich` | Run enrichment steps |
| `enrich-status` | Enrichment progress per source |
| `csv read` | Read CSV rows with filters |
| `csv stats` | Column stats and fill rates |
| `launch draft` | Create step 1 drafts |
| `launch send` | Send step 1 drafts |
| `launch status` | Draft/send counts |
| `sequence run` | Advance sequences |
| `sequence status` | Pipeline status |
| `followup send` | Send follow-up drafts |
| `sync` | Sync CSV data to configured destinations |
| `log` | Log prospect outcomes |

All commands that run LLM operations (source, enrich, sync) stream progress to stderr in real time.

## MCP server (backward compatibility)

The MCP server is still available via `agent-outbound serve` for use with MCP clients that don't support CLI tools.

## License

MIT
