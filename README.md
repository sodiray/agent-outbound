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
- `.mcp.json` entry — registers the outbound MCP server

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

## Using as an MCP server only

If you don't use Claude Code or prefer to wire things manually:

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

This works with any MCP client (Claude Desktop, Cursor, Windsurf, etc.). You get all 18 outbound tools without the `/outbound` command wrapper.

## Tools

The MCP server exposes 19 tools:

| Tool | Description |
|------|-------------|
| `outbound_list_create` | Create a new outreach list |
| `outbound_list_info` | Detailed status of a list |
| `outbound_lists` | Overview of all lists |
| `outbound_config_author` | Author config from natural language |
| `outbound_config_read` | Read current config |
| `outbound_config_update` | Write raw YAML config |
| `outbound_source` | Run sourcing (search + filter) |
| `outbound_enrich` | Run enrichment steps |
| `outbound_enrich_status` | Enrichment progress per source |
| `outbound_csv_read` | Read CSV rows with filters |
| `outbound_csv_stats` | Column stats and fill rates |
| `outbound_launch_draft` | Create step 1 drafts |
| `outbound_launch_send` | Send step 1 drafts |
| `outbound_launch_status` | Draft/send counts |
| `outbound_followup_send` | Send follow-up drafts |
| `outbound_sequence_run` | Advance sequences |
| `outbound_sequence_status` | Pipeline status |
| `outbound_sync` | Sync CSV data to configured destinations |
| `outbound_log` | Log prospect outcomes |

## License

MIT
