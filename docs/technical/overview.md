# Technical Overview

Implementation overview. For the user-facing description, see `../product/overview.md`. For the full architecture and runtime reference, see `architecture.md` and `runtime.md`.

## Shape of the System

- **CLI tool** (`agent-outbound`) written in TypeScript, Node.js.
- **Operator interface** is `/outbound` in Claude Code, which runs CLI commands via Bash (and optionally HTTP, when `serve` mode is running).
- **In-process LLM**: the CLI calls the Vercel AI SDK (`ai` package) with tools synthesized from Composio's consumer MCP server (`connect.composio.dev/mcp`, via `@modelcontextprotocol/sdk`). No subprocess spawning.
- **Canonical store**: SQLite, one DB file per list (`.outbound/prospects.db`). See `storage.md`.
- **External system of record**: the operator's CRM, mirrored via whichever CRM toolkit is configured in Composio.

## The Layered Model

Three tiers:

```
Main Claude agent (Claude Code / /outbound)
    ↓ invokes actions via CLI or HTTP
agent-outbound (Node + TS, deterministic orchestrator)
    ↓ AI SDK calls with pinned tools (fetched from Composio consumer MCP)
Per-action AI SDK agents (narrowly scoped: draft, classify, plan, sync)
```

Two layers of AI: the **main Claude agent** reasons about operator intent and picks actions; each **per-action AI SDK call** does one narrow job. Neither writes to SQLite directly — deterministic orchestrator code does all DB writes.

## Core Flow

```
Operator talks to /outbound in Claude Code
    ↓
/outbound invokes agent-outbound actions via Bash (CLI) or HTTP (serve mode)
    ↓
agent-outbound orchestrator:
  - Loads config, builds phase plan
  - For each action, loads the action module (code + prompt + schema)
  - Invokes the action: AI SDK generateText/Object with pinned Composio tools
  - AI SDK runs the agent loop: model → tool call → result → schema-validated output
  - Orchestrator applies typed output to SQLite via the DB layer
    ↓
Activity events stream to stdout and the watch socket
```

## Two Layers Inside agent-outbound

1. **The orchestrator** — deterministic code that owns the pipeline phases, config schema, dependency graph, SQLite I/O, staleness detection, sequence state machine, scoring engine, concurrency, and activity streaming.
2. **The LLM layer (action modules)** — narrowly-scoped in-process AI SDK calls with Composio tools pre-loaded per step. Handles authoring config, executing steps, evaluating conditions, planning routes, syncing to CRM, detecting replies, classifying replies.

The contract between them is the **config** (`outbound.yaml`), authored by the model via `generateObject` with a typed `ConfigChange` schema, and executed by the orchestrator step by step.

See `architecture.md` for the full model.

## Action Module Pattern

Every action is a small self-contained module with three co-located files:

```
actions/<name>/
  index.ts     # execute function, input/output types
  prompt.md    # prompt template (capability-described, provider-agnostic)
  schema.ts    # Zod output schema
```

Adding a new action is a new folder. Editing a prompt is editing a file. The schema enforces output shape. See `runtime.md § Action Module Convention`.

## Capability-Described Prompts

Prompts describe **jobs** (find an email, classify a reply, plan a route) — not **providers**. The step's config pins which specific Composio tools satisfy the job. Swapping Hunter for Apollo is a config change; the prompt and code never mention a specific provider. All prompts are capability-described and tool-agnostic.

See `architecture.md § Capability-Described Prompts`.

## Interface: CLI + Optional `serve`

- **CLI one-shots** (`agent-outbound <command>`) — default. Fresh process per invocation. Fits most operations.
- **`serve` mode** (`agent-outbound serve`) — optional long-running process. Runs a polling scheduler for reply detection and delivery tracking, exposes actions over local HTTP. No triggers or webhooks.

The main Claude agent prefers HTTP if `serve` is running, otherwise falls back to CLI. Operator sees no difference.

## Key Design Decisions

- **SQLite from day one.** Relational, transactional, WAL-concurrent. No CSV mode. See `storage.md`.
- **In-process beats subprocess.** Intentional trade-off: more runtime code in the CLI in exchange for determinism, structured outputs, prompt caching, and no per-step subprocess overhead.
- **Every action has a Zod schema.** `generateObject` validates model output at the SDK boundary; invalid output is a typed error, not a parsing surprise.
- **Tools are pinned per step.** Each step's config declares exactly which Composio toolkits and action slugs it needs. Tool context stays small, model performance stays high.
- **Capability-described prompts.** Prompts describe the job; config declares the tool. Providers are swappable without prompt or code changes.
- **Model routing is per step.** Haiku for evaluation and classification, Sonnet for research and tool-heavy steps, Opus for copywriting.
- **Composio-only for external work.** No custom API clients. Swapping a provider is a config change.
- **AI-driven deduplication.** Identity fields embedded via `all-MiniLM-L6-v2` (`@xenova/transformers`, in-process), stored as BLOBs in SQLite, similarity via dot product, confirmed by Haiku-class model. Duplicates linked, not deleted.
- **Deterministic DB writes.** AI SDK calls return typed output; only orchestrator code writes to SQLite. AI never has a "write to SQLite" tool.
- **The CRM is the external system of record.** The tool mirrors state into the operator's configured CRM; it does not duplicate the CRM's role.
- **Cross-step coordination is first-class.** Sequence steps gate on other steps' state (mail delivered, email replied, visit completed). Steps are generic — no hardcoded step-type enum.
- **Fit and timing scores are separate.** Fit is stable; trigger is time-sensitive. Both are agent-driven — natural language descriptions evaluated against enriched records. See `scoring.md`.

## Directory Structure

```
agent-outbound/
  package.json
  command.md                # /outbound command prompt for Claude Code
  docs/
    product/                # user-facing: what the tool does, channels, value
    technical/              # implementation: this folder
  src/
    cli.ts                  # CLI entry point and command routing
    serve.ts                # HTTP server for serve mode
    orchestrator/
      sourcing/             # sourcing orchestration
      enrichment/           # enrichment orchestration
      scoring/              # fit + trigger scoring
      sequencer/            # sequence orchestration (includes launch)
      crm/                  # CRM sync orchestration
      actions/              # action modules (each a folder with index/prompt/schema)
        author-config/
        execute-step/
        evaluate-condition/
        plan-route/
        sync-crm/
        detect-replies/
        classify-reply/
      runtime/
        db.ts               # SQLite client + single authoritative SCHEMA; the only module that runs SQL
        mcp.ts              # Composio consumer MCP client + tool loader
        models.ts           # model router (opus/sonnet/haiku)
        prompts.ts          # prompt rendering (merge-field resolution)
        activity.ts         # activity event emitter
        idempotency.ts      # destructive-action markers
        polling.ts          # polling scheduler (replaces triggers)
      lib/                  # shared utilities (hashing, yaml, dates)
    schemas/                # Zod schemas shared across actions
```

## List Directory Layout

Each list is its own directory. The tool creates only `outbound.yaml` and `.outbound/` — nothing else is scaffolded. The operator creates whatever files and directories they need.

```
boise-plumbers/                 # the list directory (list root)
  outbound.yaml                 # operator-editable config
  .outbound/                    # tool-managed state (auto-created on first run)
    prospects.db                # THIS list's SQLite database
    prospects.db-wal
    prospects.db-shm
    .activity/                  # watch socket + history ring buffer
    .serve/                     # serve mode pid + port
    logs/                       # sourcing.log, compliance.log, crm.log, costs.jsonl
```

**One SQLite database per list**, always inside that list's own `.outbound/` directory. A list's state is fully contained in its directory; moving a list is `cp -r <list-dir>` and it goes with everything intact. See `storage.md`.

## File Paths

All paths in config and step descriptions are **relative to the list directory**. There are no virtual roots or path aliases — `./prompts/foo.md` means `boise-plumbers/prompts/foo.md`. The agent is given the list directory as its working root in prompts.

## What to Read Next

- `architecture.md` — layered model, action modules, capability prompts, CLI/serve interface, data flow, config schema
- `runtime.md` — SDK + MCP reference (client, auth, tools, action convention, serve mode, polling, errors, SQLite client)
- `storage.md` — SQLite schema overview, WAL concurrency, single-schema definition, backup
- `data-schema.md` — table-by-table column reference
- `integrations.md` — tool reference format, auth, versioning
- `performance.md` — prioritized performance optimization plan (config-time tool resolution, parallel enrichment, dependency DAG, batch filters, prompt caching)
- `tool-agnosticism.md` — engineering spec for platform-agnostic design (sections 1-3, 5 complete)

Per-phase and per-channel technical specs live alongside: `sourcing.md`, `enrichment.md`, `scoring.md`, `sequencing.md`, `mail.md`, `visits.md`, `deliverability.md`, `compliance.md`, `crm.md`, `operator.md`, `watch.md`.
