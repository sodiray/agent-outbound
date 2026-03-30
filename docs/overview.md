# Outbound

Config-driven outbound pipeline for sourcing, enriching, and sequencing cold outreach. Built for operators running locally via Claude Code.

## How It Works

The system has two layers:

1. **The orchestrator** — deterministic code that knows the pipeline phases, config schema, dependency graph, CSV I/O, staleness tracking, sequence state machine, and rubric scoring. It does not know what tools exist, what columns mean, or what any specific step does.

2. **The LLM layer** — Claude (with connected MCP tools) handles all intelligence. It discovers tools, selects tools, calls tools, interprets results, authors config, evaluates conditions, and executes steps. The orchestrator delegates to the LLM for every decision.

The contract between them is the **config** (`outbound.yaml`). The config is hyper-specific — exact column names, tool references, prompts, conditions — but it was authored by the LLM, not by code. The orchestrator validates its structure (Zod) and executes it step by step.

```
User talks to /outbound command
    ↓
Claude runs: agent-outbound config author <list> "add email lookup step"
    ↓
Claude discovers available tools, authors config → outbound.yaml
    ↓
Claude runs: agent-outbound enrich <list>
    ↓
Orchestrator executes config phase by phase, streaming progress to stdout
    ↓
For each step: delegate to Claude with step config + row data
    ↓
Claude calls MCP tools, produces output → streamed back to caller
    ↓
Orchestrator writes results to CSV, advances state
```

## Interface

The outbound system is a **CLI tool** (`agent-outbound`). Claude Code runs CLI commands via Bash, which means:

- **Full real-time visibility** — stdout streams directly to the user as operations run
- **Self-documenting** — `agent-outbound --help` lists all commands; `agent-outbound <command> --schema` shows expected arguments
- **No hidden subprocess overhead** — the CLI IS the process; progress from LLM calls is piped directly to the caller

The `/outbound` Claude Code command teaches Claude how to use the CLI. It runs `--help` to discover commands and `--schema` to learn arguments.

## Pipeline Phases

The orchestrator executes these in order:

1. **Sourcing: Search** — find businesses, write rows to CSV, deduplicate
2. **Sourcing: Filter** — qualify rows by executing filter steps on any row with stale filter results (new rows, config changes, upstream data changes), mark pass/fail
3. **Enrichment** — fill in columns for qualified rows, step by step in dependency order
4. **Rubric** — score each row against configured criteria, produce lead_score
5. **Sequence** — execute outreach steps (emails, calls, manual actions) on a timed cadence

Each phase reads and writes the canonical CSV. The CSV is the single source of truth at every stage.

## Key Design Decisions

- **The orchestrator is a config machine.** It generates config (via the LLM) and executes config (via the LLM). It never interprets what a step means or what a tool does.
- **Tool-agnostic.** The LLM discovers and uses whatever MCP tools are connected to the Claude session (Composio, direct MCP tools, or any other tool server). No custom API keys. The orchestrator doesn't validate tool availability — that happens at execution time when the LLM tries to use them.
- **CSV is the contract between all phases.** Search writes rows, filters write data + pass/fail, enrichment writes columns, rubric writes scores, sequence writes send state.
- **Config is authored by the LLM, executed by the LLM.** The operator talks to `/outbound`, which prompts Claude to produce or modify config. At runtime, the orchestrator hands each step back to Claude for execution.
- **Actions are the delegation boundary.** Each operation the orchestrator needs intelligence for (author config, execute step, evaluate condition, sync destination) is an action — a code module with a prompt template and an execute function.
- **Progress is streamed.** All LLM activity (tool calls, reasoning, results) is piped back to the caller in real time. The user always sees what's happening.

## Quick Start

```bash
# Install globally or use npx
npx agent-outbound init

# Discover commands
agent-outbound --help

# Get argument details for any command
agent-outbound source --schema
```

## Directory Structure

```
agent-outbound/
  package.json
  command.md           # the /outbound command prompt for Claude Code
  docs/
    overview.md        # this file
    architecture.md    # orchestrator, actions, config schema, data flow
    sourcing.md        # sourcing phase: search + filter
    enrichment.md      # enrichment phase: steps, staleness, rubric
    sequencer.md       # sequence phase: state machine, timing, execution
    operator.md        # daily operator dashboard
    watch.md           # live activity monitoring
    user-flows.md      # example interactions
  src/
    cli.js             # CLI entry point and command routing
    orchestrator/
      sourcing/        # sourcing orchestration
      enrichment/      # enrichment orchestration
      sequencer/       # sequence orchestration (includes launch)
      actions/         # action modules (author-config, execute-step, evaluate-condition, sync-destination)
      lib/             # shared utilities (csv, claude cli, hashing, yaml, runtime)
```

## File Paths (Virtual Roots)

Config fields that reference files (prompts, templates) use virtual roots:

- `@list/...` — resolves relative to the list home directory (user-owned)
- `@internal/...` — resolves to a per-list internal directory owned by the utility
