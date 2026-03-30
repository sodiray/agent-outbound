# Architecture

## Two Layers

### The Orchestrator

The orchestrator is deterministic code. It is specific to the outbound pipeline and has intimate knowledge of:

- **Pipeline phases and ordering:** sourcing (search → filter) → enrichment → rubric → sequence
- **Config schema:** Zod-validated structure for each phase (searches, filters, enrichment steps, rubric criteria, sequence steps)
- **Dependency graph:** how to order enrichment steps based on declared dependencies between them
- **CSV I/O:** reading rows, writing columns, ensuring column existence, stable `_row_id` generation
- **Staleness detection:** SHA-256 hashing of input dependencies to skip rows that haven't changed
- **Sequence state machine:** step advancement, day offsets, status transitions (active → engaged → completed/opted_out/bounced), thread tracking, pause on reply/bounce
- **Rubric scoring:** summing earned points across criteria, calculating lead_score as a percentage
- **Concurrency:** parallel execution of steps within a phase, configurable per step
- **Destination sync:** one-way sync of canonical CSV to external destinations after mutations
- **Progress streaming:** all LLM activity is piped to stdout so the caller has real-time visibility

The orchestrator does NOT know:
- What MCP tools exist or what they do
- What any column name means
- What any specific step accomplishes
- How to pick a tool for a task
- What data a tool will return

### The LLM Layer

Claude (via CLI, with connected MCP tools) handles all intelligence:

- **Authoring config:** user says "add a step that finds emails" → Claude searches available MCP tools for email-finding capabilities, finds one that's connected, writes a step config with the tool name, args, output columns, and condition
- **Executing steps:** orchestrator hands Claude a step config + row data → Claude calls the referenced tool (or does pure reasoning), interprets the result, returns structured output
- **Evaluating conditions:** orchestrator hands Claude a condition string + row data → Claude returns pass/fail
- **Discovering tools:** Claude queries all available MCP tools to see what's connected and what capabilities exist
- **Syncing destinations:** orchestrator hands Claude the CSV file path, destination details, and sync rules → Claude reads the file, reads the destination, and syncs them

The LLM is the only component that touches external services. The orchestrator never calls any API directly, and only interacts with external systems through Claude.

## CLI Interface

The outbound system exposes a CLI (`agent-outbound`) instead of an MCP tool server. This design choice provides:

- **Real-time progress streaming** — stdout pipes directly to the caller. When Claude runs `agent-outbound enrich my-list`, the user sees each step executing, each row being processed, as it happens.
- **Self-documentation** — `agent-outbound --help` lists all commands with descriptions. `agent-outbound <command> --schema` returns structured argument documentation. Claude uses these to discover capabilities.
- **Simplified architecture** — no MCP server registration, no JSON-schema tool definitions, no request-response limitations. The CLI is the interface.

The `/outbound` Claude Code command teaches Claude the CLI pattern:
```
You have the agent-outbound CLI.
Run `agent-outbound --help` to discover commands.
Run `agent-outbound <command> --schema` for argument details.
Run commands via Bash. Output streams in real time.
```

## Actions

Actions are the boundary between the orchestrator and the LLM. Each action is a code module with:

- A **prompt template** — the instructions that get sent to Claude
- An **execute function** — builds the full prompt from config + data, calls Claude, parses the response
- **Progress streaming** — Claude's output (tool calls, reasoning, intermediate results) is piped to the CLI's stdout in real time
- **Zod-validated output** — the orchestrator knows the shape of what comes back (not the content)

The action set:

### `author-config`

Called when the user wants to create or modify config. The orchestrator provides:
- The user's request (from the CLI command)
- The current config (outbound.yaml)
- The current CSV state (headers, row count, sample data)

The action prompts Claude to explore available MCP tools, understand what's possible, and produce config entries. Claude returns structured config that the orchestrator validates (Zod) and writes to the YAML.

This single action covers: adding searches, adding filters, adding enrichment steps, adding sequence steps, modifying existing steps, removing steps. The pattern is always the same — Claude sees the current state, the user's intent, and the available tools, and produces config.

### `execute-step`

Called when the orchestrator is running a phase and needs to execute a specific step for a specific row. The orchestrator provides:
- The step's config (args, tool reference, prompt, output column mapping)
- The row's current data (all columns)
- Context about the pipeline phase

The action prompts Claude with the step config and row data. Claude does whatever the step says — call an MCP tool, do web research, write copy, evaluate data. Claude returns structured output matching the step's declared output keys. The orchestrator writes those outputs to the CSV columns specified in the step config.

Output mapping behavior:
- If `step.config.columns` is present, orchestrator maps output keys to the declared destination columns.
- If `step.config.columns` is omitted, orchestrator writes output keys directly as column names.

Pre-processing before handoff:
- Orchestrator resolves `from_column`/`literal` arg bindings deterministically from row data.
- Orchestrator resolves step file/template references (`prompt.file`, `files.*`, `{ file: ... }`, `{ template_file: ... }`) and renders templates with resolved `template_args` before calling Claude.

### `evaluate-condition`

Called when the orchestrator needs a pass/fail decision (filter conditions, rubric criteria, sequence step conditions). The orchestrator provides:
- The condition text (from config)
- The row data (relevant columns)
- The output from the step that just ran (if applicable)

For simple conditions (numeric comparisons, non-empty checks), this can be evaluated deterministically without calling Claude. For fuzzy conditions, it delegates to Claude. The action decides which path based on the condition text.

Deterministic condition evaluation is best-effort optimization, not authoritative semantic understanding. If a deterministic rule cannot be applied confidently, evaluation falls back to Claude.

### `sync-destination`

Called when the orchestrator needs to sync the canonical CSV to an external destination. The orchestrator provides:
- The local CSV file path
- The destination type and config (sheet ID, worksheet name, etc.)
- The list of owned columns to sync

The action prompts Claude with the file path, destination details, and sync rules. Claude reads the local file, reads the destination state, and performs the sync — all in a single session using its connected MCP tools. This avoids the overhead of multiple subprocess spawns for mechanical read/write operations.

Sync rules (enforced by the prompt):
- Owned columns from CSV overwrite the destination
- Additional columns in the destination are preserved
- Rows matched by `_row_id`
- Rows in the destination that aren't in the CSV are removed

## Config Schema

The config (`outbound.yaml`) is the contract between authoring and execution. It has this structure:

```yaml
source:
  searches:
    - source: <source type>
      query: <search query>
      # ... any fields the LLM authored for this search

  filters:
    - description: <human-readable intent>
      condition: <pass/fail condition text>
      config:
        # compiled execution plan — tool, args, columns, etc.

enrich:
  - description: <human-readable intent>
    config:
      # compiled execution plan — tool, args, columns, dependencies, etc.

rubric:
  - description: <criterion description>
    score: <point value, positive or negative>
    config:
      columns: [<columns to evaluate>]
      result_column: <where to write true/false>

sequence:
  steps:
    - action: <step type>
      day: <day offset from launch>
      description: <what to do>
      config:
        # compiled execution plan — bindings, templates, conditions
  on_reply: pause
  on_bounce: pause
```

Every "intent object" (filter, enrichment step, sequence step) has a human-readable outer layer and a nested `config` block that is the compiled execution plan. The outer layer is what the operator sees. The inner `config` is what the orchestrator executes.

The orchestrator validates the structure of `config` blocks via Zod. It does not validate the content — it doesn't check that a tool name is real, a column exists, or a condition makes sense. Those are LLM concerns resolved at execution time.

## Data Flow

```
outbound.yaml
    ↓
Orchestrator reads config, builds dependency graph
    ↓
Phase 1: Sourcing
  For each search → execute-step → write rows to CSV → deduplicate
  For each filter on all stale rows → execute-step → evaluate-condition → write pass/fail
    ↓
Phase 2: Enrichment
  For each dependency level (parallel sources within level):
    For each row (parallel, checking staleness):
      → execute-step → write output columns to CSV
    ↓
Phase 3: Rubric
  For each row (parallel):
    For each criterion (parallel) → evaluate-condition → write result column
    Sum scores → write lead_score
    ↓
Phase 4: Sequence
  Check due actions based on day offsets and sequence state
  For each due action → execute-step (draft, send, search replies)
  Advance state machine (step, status, next_action_date)
    ↓
Destination sync → sync-destination action
```

## Data Persistence

The orchestrator maintains an internal canonical CSV (`@internal/prospects.csv`). This is the single source of truth. If a destination is configured (Google Sheets, published CSV), the orchestrator syncs one-way after every mutation using the `sync-destination` action.

Destination sync rules:
- One-way (utility → destination)
- Owned columns overwritten when values differ
- User-added destination columns preserved
- Rows matched by `_row_id`

## Tools

The system is tool-agnostic. The LLM discovers and uses whatever MCP tools are connected to the Claude session — this includes direct MCP tools (google-maps, hunter, firecrawl), Composio integrations, or any other tool server. No custom API keys are needed.

The orchestrator does not interact with tools directly. It delegates to the LLM, which has tools available in its session. At authoring time, the LLM searches available tools to discover what's connected and writes tool references into the config. At execution time, the LLM calls those tools.

If a tool referenced in config is no longer connected at execution time, the LLM reports the failure. The orchestrator records it as a step error. The user can then ask the `/outbound` command to rebind the step to a different tool — which is just another `author-config` action.

## Progress Streaming

All LLM activity during CLI commands is streamed to stdout in real time. When Claude calls a tool, reasons about data, or produces output, the caller sees it immediately.

This is achieved by piping Claude subprocess stdout directly to the CLI's stdout. The orchestrator prints progress markers at key milestones (starting a phase, processing a row, completing a step) and the LLM's own output streams between them.

The result: the user watching a `agent-outbound enrich my-list` command sees:
```
[enrich] web_research: processing 3 stale rows (5 skipped)
[enrich] web_research: row 1/3 (Master Plumbing) — calling firecrawl...
  ... Claude's tool calls and reasoning stream here ...
[enrich] web_research: row 1/3 complete
[enrich] web_research: row 2/3 (Goodson Plumbing) — calling firecrawl...
  ... Claude's tool calls stream here ...
[enrich] web_research: complete (3 processed, 0 failed)
[enrich] email_draft: processing 3 stale rows...
  ...
[rubric] scoring 3 rows against 6 criteria...
[sync] syncing 8 rows to Google Sheets...
```
