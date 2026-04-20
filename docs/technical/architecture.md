# Architecture

## The Layered Model

Three tiers, with a clean contract between each:

```
┌─────────────────────────────────────────────────────┐
│ Main Claude agent (Claude Code, /outbound)          │
│ - Operator's conversational interface               │
│ - Reasons about what the operator wants             │
│ - Invokes agent-outbound actions via CLI or HTTP    │
└──────────────────────┬──────────────────────────────┘
                       │ CLI commands or HTTP calls
┌──────────────────────▼──────────────────────────────┐
│ agent-outbound (Node + TypeScript)                  │
│ - Deterministic orchestrator                        │
│ - Owns SQLite canonical store + all writes          │
│ - Invokes granular action modules                   │
│ - Exposes: CLI one-shots + optional HTTP serve mode │
└──────────────────────┬──────────────────────────────┘
                       │ AI SDK with tools wrapped over MCP
┌──────────────────────▼──────────────────────────────┐
│ Vercel AI SDK (in-process)                          │
│ - generateText / generateObject                     │
│ - Tool schemas fetched from Composio consumer MCP   │
│ - Tool execute() wraps COMPOSIO_MULTI_EXECUTE_TOOL  │
└──────────────────────┬──────────────────────────────┘
                       │ JSON-RPC over HTTP + x-consumer-api-key
┌──────────────────────▼──────────────────────────────┐
│ Composio consumer MCP (connect.composio.dev/mcp)    │
│ - Single-tenant (one operator account)              │
│ - All toolkit connections managed in dashboard      │
│ - 7 meta-tools; we use SEARCH/GET_SCHEMAS/EXECUTE   │
└─────────────────────────────────────────────────────┘
```

Two layers of "AI":
- The **main Claude agent** in Claude Code is the operator's reasoning layer. It decides which agent-outbound action to invoke next.
- Each **per-action AI SDK call** inside agent-outbound is narrowly scoped: draft an email, classify a reply, plan a route, author a config diff. One job per agent.

## The Orchestrator

The orchestrator is deterministic code. It is specific to the outbound pipeline and has intimate knowledge of:

- **Pipeline phases and ordering:** sourcing (search → filter) → enrichment → scoring → sequence → CRM sync
- **Config schema:** Zod-validated structure for each phase
- **Dependency graph:** how to order enrichment steps based on declared dependencies
- **SQLite I/O:** reading records and related tables, writing via typed DB operations, stable `_row_id` generation (see `data-schema.md` and `storage.md`)
- **Staleness detection:** SHA-256 hashing of input dependencies to skip records that haven't changed
- **Sequence state machine:** step advancement, agent-evaluated conditions, status transitions, thread tracking, pause on reply/bounce, cross-step event coordination
- **Scoring engine:** two-axis scoring (fit + trigger) with agent-driven evaluation and explainability
- **Concurrency:** parallel execution of steps within a phase, configurable per step
- **Activity streaming:** emits structured events to stdout and to the watch socket as work happens

The orchestrator does NOT know:
- What Composio toolkits exist or what they do
- What any specific step accomplishes semantically
- How to pick a tool for a task
- What data a tool will return

## The LLM Layer (In-Process)

The LLM layer is **in-process**. The orchestrator calls the Vercel AI SDK (`ai` package) directly. Tools are synthesized from Composio consumer MCP schemas at step start and passed into `generateText` / `generateObject`. Every action runs as a typed, schema-enforced agent loop inside the Node process.

Primary libraries:

| Library | Role |
|---|---|
| `ai` | Vercel AI SDK — `generateText`, `generateObject`, tool loop |
| `@ai-sdk/anthropic` | Anthropic provider for the AI SDK |
| `@modelcontextprotocol/sdk` | MCP client talking to `connect.composio.dev/mcp` |
| `@xenova/transformers` | Local embedding model (`all-MiniLM-L6-v2`) for dedup vector similarity |
| `zod` | Output schemas for every action |
| `better-sqlite3` | SQLite driver |

The orchestrator is the only component that calls the AI SDK. The MCP client is the only thing that touches Composio — all third-party provider calls (Gmail, Hunter, Lob, etc.) flow through `COMPOSIO_MULTI_EXECUTE_TOOL` on that MCP server. **No AI SDK call ever writes to SQLite directly**; it returns typed output, the orchestrator applies it to the DB.

## The Action Module Pattern

**Actions are the boundary between the orchestrator and the AI SDK.** Each action is a small, self-contained module with three co-located files:

```
src/orchestrator/actions/
  author-config/
    index.ts          # execute function: loads tools, runs generateText/Object, returns typed output
    prompt.md         # the prompt template (capability-described, provider-agnostic)
    schema.ts         # Zod schema for the action's output
  execute-step/
    index.ts
    prompt.md
    schema.ts
  evaluate-condition/
    index.ts
    prompt.md
    schema.ts
  plan-route/
    index.ts
    prompt.md
    schema.ts
  sync-crm/
    index.ts
    prompt.md
    schema.ts
  detect-replies/
    index.ts
    prompt.md
    schema.ts
  classify-reply/
    index.ts
    prompt.md
    schema.ts
```

Each action exports:

- An **input type** (Zod-derived) — orchestrator-provided state
- An **output type** (Zod-derived) — structured return
- A **prompt** (loaded from `prompt.md`, templated with input values)
- A **tool pinner** — which Composio toolkits/actions to load for this action
- A **model choice** — `opus`, `sonnet`, or `haiku`
- A **step budget** — `stepCountIs(N)` for the agent loop
- An **execute function** — wires it all together, emits activity events, returns typed output

Why three co-located files:

1. **Prompts live next to the code that calls them.** Editing the prompt is never "go find the prompt file." Testing a prompt change never requires understanding call-site wiring.
2. **Schemas live next to the prompt.** The schema defines what the model must produce; the prompt describes how to produce it. They change together.
3. **Actions are small and composable.** A new capability = a new folder. Nothing else changes.

## Capability-Described Prompts

Prompts reference **capabilities, not providers.** The operator's Composio account determines which specific tools are connected; the prompt must work with whatever is loaded.

**Wrong** (provider-locked):
> Use `HUNTER_EMAIL_FINDER` to find the email for this person.

**Right** (capability-described):
> You have tools available for finding an email address from a person's name and company. Call whichever tool is loaded — it may be an email-finder service, a contact-enrichment API, or a web-search tool. Try the most direct path first; fall back to search if the primary lookup fails. Return the email address and your confidence.

When a step's config pins `[HUNTER_EMAIL_FINDER]`, the model sees only Hunter and uses it. Swap config to `[APOLLO_PEOPLE_SEARCH]` — same prompt, different tool, still works. Pin a waterfall `[HUNTER_EMAIL_FINDER, APOLLO_PEOPLE_SEARCH, DROPCONTACT_ENRICH]` — the model handles the fallback order.

The prompt becomes a description of **the job**. The config becomes the **assignment of specific tools to that job**. Adding, removing, or swapping providers is a config change — never a prompt change, never a code change.

This convention is enforced at code review time: no action prompt should name a specific toolkit. The default is always to describe the capability. The step's config declares which tools satisfy it; prompts stay provider-agnostic.

## The Action Set

### `author-config`

Called when the operator wants to create or modify list configuration. Produces typed config diffs (add/remove/modify search, filter, enrich step, sequence step, scoring criterion, channel setting).

Implementation: `generateObject({ schema: ConfigChangeSchema })` with `COMPOSIO_SEARCH_TOOLS` used by the orchestrator to pre-seed candidate tool slugs based on the operator's intent. The model picks slugs from the candidate set, then emits a typed `ConfigChange` diff. Orchestrator validates and applies.

### `execute-step`

Called when a phase needs to run a specific step for a specific record. The step's config declares its pinned tools, output schema, model, and step budget.

```ts
// Build a step-specific schema from the outputs declaration
const outputShape = buildOutputZodSchema(step.config.outputs);

const { output } = await generateText({
  model: pickModel(step.config.model),
  system: loadPrompt(step.config.prompt_file, step.config.prompt_args),
  messages: [{ role: "user", content: renderedUserPrompt }],
  tools: await loadTools(step.config.tool),
  stopWhen: stepCountIs(step.config.step_budget ?? 10),
  output: Output.object({ schema: outputShape }),
});
```

The step-specific schema is built at runtime from the `outputs` declaration in config. Each output field becomes a typed Zod property with its description — the LLM sees exact field names, types, and what to produce. Output is validated against this schema by the AI SDK. The orchestrator then coerces values for SQLite compatibility (booleans → 0/1, arrays → JSON strings) and writes each field directly to its `records` column through the deterministic DB layer.

Side-effect-only steps (sending an email, dispatching mail) use `generateText` without `output` and extract side-effect metadata (message ID, thread ID) from tool results.

### `evaluate-condition`

Called for filter conditions and sequence step gates. Conditions are natural language descriptions evaluated by the agent against the record's current state.

The agent receives the full record (all columns) and the condition text, then returns `{ passed: boolean, defer: boolean, reason: string }`. Uses Haiku for cost efficiency since conditions are evaluated frequently.

For simple sourcing filters (e.g., "has a website"), the orchestrator may use a deterministic fast path for patterns like `<column> is not null` to avoid unnecessary LLM calls. But scoring and sequence conditions are always agent-evaluated — they require judgment, not field checks.

### `plan-route`

Called during sequence execution when a batch of `visit` steps is due. Output is a structured route with ordered stops and calendar events.

Tools pinned: whichever routing toolkit is configured in `channels.visit.tool`. Validated at config time and re-checked at execution time. Model: `sonnet`.

### `sync-crm`

Called after state-changing operations to mirror deltas to the operator's CRM. Tools pinned: whichever CRM toolkit is configured in `crm.tool`. Step budget ~4 for linked records, ~12 for first-time linkage.

### `detect-replies`

Scans tracked threads for new messages via polling (e.g. `GMAIL_LIST_MESSAGES` filtered on `after:<last-check>`). Each detected reply is handed to `classify-reply`.

### `classify-reply`

`generateObject` call with Haiku. Produces `{ classification: "positive" | "negative" | "ooo" | "auto" | "bounce", reason: string }`.

## Schema-Driven Outputs

Every action that returns data declares a Zod schema. The AI SDK validates the model's output against that schema before returning. Invalid output throws — the orchestrator catches the error, records it as a step failure, moves on.

Two patterns for mixing tools and structured output:

1. **Single-call** (AI SDK 6): `generateText({ tools, output: Output.object({ schema }) })`. Model tool-calls, then emits the object in a final step. Budget `stepCountIs(toolSteps + 2)`.
2. **Two-pass**: `generateText` with tools for exploration; feed resulting messages into `generateObject` with a different (usually cheaper) model for extraction.

Default is single-call.

## Model Routing

| Config | Model ID | Used for |
|---|---|---|
| `opus` | `claude-opus-4-6` | Copywriting, nuanced messaging, subtle classifications |
| `sonnet` (default) | `claude-sonnet-4-6` | Research, tool-heavy steps, sequencing logic |
| `haiku` | `claude-haiku-4-5-20251001` | Condition evaluation, reply classification, simple extraction |

Haiku fits hot paths (filter evaluation, reply classification, scoring) that fire many times per list. Using Sonnet there wastes money; using Opus wastes a lot of money.

## Step Budgeting

| Action | Typical budget |
|---|---|
| `evaluate-condition` (model-backed) | 1 |
| `execute-step` enrichment (single-tool lookup) | 3 |
| `execute-step` enrichment (waterfall/research) | 8–12 |
| `execute-step` sequence (email draft with research) | 6 |
| `execute-step` sequence (email send) | 2 |
| `author-config` (single change) | 10 |
| `author-config` (complex, multi-tool) | 20 |
| `plan-route` | 8 |
| `sync-crm` (subsequent sync, linked record) | 4 |
| `sync-crm` (first-time linkage) | 12 |
| `detect-replies` batch | 6 |

When using `Output.object`, add 1 for the final emission. If the budget runs out before a final emission, the action fails with a clear error.

## Interface: CLI and Optional `serve` Mode

The orchestrator is exposed two ways:

### CLI (default, one-shot)

```
agent-outbound <command> [flags]
```

Each invocation spawns a fresh Node process, runs the command, exits. Fits most operations (source, enrich, add-step, launch, send-followups). Node startup + deps load is ~200–500ms; acceptable overhead for operator-initiated commands.

Examples:

```
agent-outbound list create boise-plumbers
agent-outbound source boise-plumbers --limit 200
agent-outbound config author boise-plumbers "add a hiring-signals enrichment step"
agent-outbound enrich boise-plumbers
agent-outbound sequence run boise-plumbers
agent-outbound log boise-plumbers --prospect "..." --visit talked_to_owner --note "..."
```

### `serve` (long-running, local HTTP + polling scheduler)

```
agent-outbound serve [--port 4949]
```

Starts a persistent Node process that:

- Runs a polling scheduler for reply detection and delivery tracking (intervals are config-driven)
- Exposes the same action surface over local HTTP (`POST /v1/actions/<name>`)
- Streams activity events over a WebSocket (`/v1/activity`)
- Shares the SQLite DB with any concurrent CLI one-shots (SQLite WAL handles coordination)

`serve` is optional. It's useful when:

- The operator wants polling to run on a regular cadence without depending on cron or manual `sequence run`
- Other agents or tools want to call agent-outbound actions programmatically

Without `serve`, everything still works via CLI — polling runs whenever the operator invokes `sequence run`.

### The Main Claude Agent Calling In

`/outbound` in Claude Code defaults to running CLI commands via Bash. When `serve` is detected running (via the list's `.outbound/.serve/port` file), the main agent can route its calls through the HTTP endpoint instead — same action names, same arguments. Operator sees no difference.

Discovery is simple:
1. Check for `<list-root>/.outbound/.serve/port`
2. If present and reachable, use HTTP
3. Else, use CLI

## The Main Claude Agent's View

The main agent in Claude Code doesn't know about prompts, schemas, toolkits, or the AI SDK. It knows:

- A vocabulary of agent-outbound actions (list.create, list.source, list.enrich, list.score, config.author, sequence.add_step, sequence.launch, sequence.run, route.plan, record.log, record.suppress, crm.sync, pipeline.status, ...)
- How to invoke them (CLI or HTTP)
- How to read their outputs (structured JSON when `--format json` / the HTTP response)

It composes multi-step flows by invoking actions in sequence, reasoning over outputs, and reporting to the operator. It never talks to Composio directly. It never writes to SQLite.

This is the contract: **agent-outbound is a well-defined action API; the main Claude agent is its caller.**

## Activity Streaming

The orchestrator emits structured events as work progresses. Event sources:

- **Orchestrator-level:** phase start/end, step start/end, record-level progress, errors
- **AI SDK-level:** `onStepFinish` fires after each model turn with tool calls and intermediate text
- **Tool-level:** each tool call is an event (name, args summary, result size, duration)

Events go three places:

1. **stdout** — formatted for the caller (human-readable by default, JSON lines when `--format json`)
2. **Activity socket** (`.outbound/.activity/current.sock`) — the `watch` command connects and streams structured events in real time
3. **activity_history table** (bounded ring buffer) — so `watch` can show recent events on reconnect

See `watch.md`.

## Concurrency

- Phases run in sequence (sourcing → enrichment → scoring → sequence → crm).
- Within a phase, records within a step run in parallel up to the step's `concurrency` cap (default configurable per step, recommended 3-5 to start).
- In enrichment, dependency levels are computed from `depends_on` declarations. Steps at the same level run concurrently; levels execute in topological order. See `enrichment.md § Dependency Graph`.
- Every parallel unit is its own AI SDK call. The MCP client is shared.
- SQLite writes serialize via WAL locking — contention is tens of ms in the worst case. For high concurrency, batch writes after parallel LLM calls complete.
- Tool execution through Composio is rate-limited per-toolkit by Composio and per-service by upstream providers. The orchestrator respects 429s with exponential backoff.

Concurrency is bounded by: step's `concurrency` config, process-level cap, Composio rate limits, Anthropic API rate limits, SQLite write serialization. See `performance.md § Priority 2` for implementation details.

## Error Handling & Idempotency

The AI SDK retries failed tool calls automatically inside its step loop. That's right for read-only tools (Firecrawl returned empty, retry). It's wrong for destructive tools (Gmail send succeeded, then the API returned a transient error; retry would duplicate-send).

Destructive tool actions are wrapped with **idempotency keys** in the step's config:

```yaml
config:
  tool:
    toolkits: [GMAIL]
    tools: [GMAIL_SEND_EMAIL]
  idempotency:
    key_source: [_row_id, sequence_step]
    scope: list
```

Before the AI SDK call, the action writes an `idempotency` row with status `pending`. On success, updates to `sent` with the provider ID. On retry, the action checks — if `sent`, it reuses the stored provider ID instead of re-executing.

Idempotency markers live in the `idempotency` table (see `data-schema.md`).

Errors surface at three levels:

1. **Per-record step error** — recorded on the record and as a `channel_events` entry. Orchestrator continues to the next record.
2. **Per-step failure** — if all records in a step fail, the phase halts with a loud error.
3. **Config/auth errors** — missing API key, disconnected Composio account, broken tool reference: surface immediately, halt the run, tell the operator exactly what to fix.

## Auth and Bootstrap

See `runtime.md` for the full flow. Summary:

- **One-time:** operator runs `agent-outbound init`. Interactive, two steps. Step 1 captures `COMPOSIO_API_KEY` (the consumer `ck_...` key from the Composio dashboard, masked), validates it by opening an MCP connection to `connect.composio.dev/mcp` and calling `tools/list`, then enumerates connected toolkits as a sanity check. Step 2 captures `ANTHROPIC_API_KEY` (masked), validates via Anthropic's `/v1/models` endpoint. Writes to `~/.agent-outbound/env` (chmod 600). Non-interactive mode via flags for CI.
- **Per-run:** CLI reads `COMPOSIO_API_KEY` at startup, opens an MCP client once, and reuses it for every action. Consumer MCP is single-tenant — there is no userId anywhere.
- **Connecting toolkits:** operator connects toolkits (Gmail, Hunter, Apollo, etc.) in the Composio dashboard under their own account. This tool never initiates OAuth, never manages connections.
- **Disconnect recovery:** if a step errors with "connection not active," orchestrator surfaces the MCP error verbatim and halts the channel. Operator reconnects in the Composio dashboard; next run works.

## Events: Polling Only

Reply detection and delivery-confirmation flows all run via **polling**. Consumer MCP does not expose trigger or webhook subscriptions, and agent-outbound does not listen for external events.

- **Reply detection.** `sequence run` invokes the pinned reply-detection tool (e.g. `GMAIL_LIST_MESSAGES` with a `since:<last-check>` filter), compares message IDs against sent threads, and writes `channel_events` rows for matches.
- **Delivery tracking.** `sequence run` iterates `channel_events` with non-final delivery states and invokes provider status tools (`LOB_GET_POSTCARD`, `TELNYX_GET_MESSAGE_STATUS`) to refresh.
- **Cadence.** Controlled by how often `sequence run` fires: cron, operator-triggered, or `serve` mode's internal scheduler (`poll_replies_minutes`, `poll_delivery_minutes`).

## Data Flow

```
outbound.yaml (includes tool_catalog with resolved schemas)
    ↓
Orchestrator reads config, builds phase + dependency plan, loads tool schemas from tool_catalog
    ↓
Phase 1: Sourcing
  For each search:
    action: execute-step — generateText with search-tool pinned (schema from catalog) → records inserted
  For each new record:
    Embed identity fields → nearest-neighbor search → AI confirmation on candidates → link duplicates
  For each filter on stale records:
    action: execute-step + evaluate-condition → pass/fail
    ↓
Phase 2: Enrichment
  For each dependency level (parallel):
    For each record (parallel, checking staleness):
      action: execute-step → generateText({ tools from catalog, output: Output.object({schema}) })
      → write output columns + insert channel_events where relevant
    ↓
Phase 3: Scoring
  For each record (parallel):
    Agent evaluates fit description against enriched record → fit_score + reasoning
    Agent evaluates trigger description against enriched record → trigger_score + reasoning
    Compute priority_rank from weighted fit + trigger scores
    Insert score_events
    ↓
Phase 4: Sequence (scheduled, on-demand, or trigger-woken)
  action: detect-replies → classify-reply → update state + insert channel_events
  For each due step:
    Check suppression/consent flags (deterministic)
    Agent evaluates step's natural-language condition against record state
    execute-step — agent reads step description, determines work type, uses pinned tools
    Insert channel_events; advance state
  Steps classified as visits: batch → plan-route → write routes + route_stops + calendar events
    ↓
Phase 5: CRM Sync
  action: sync-crm → CRM writes via configured CRM toolkit
```

## Config Schema

The config (`outbound.yaml`) stays declarative. Tool schemas are stored in a top-level `tool_catalog` alongside the step configs:

```yaml
tool_catalog:
  FIRECRAWL_SCRAPE:
    description: "Scrape content from a URL"
    parameters: { ... }
  SERPAPI_SEARCH:
    description: "Search the web"
    parameters: { ... }

enrich:
  - description: find decision-maker and email
    id: decision_maker
    config:
      tool:
        toolkits: [FIRECRAWL, SERPAPI]        # source toolkits (for re-resolution)
        tools: [FIRECRAWL_SCRAPE, SERPAPI_SEARCH]   # resolved at config time
      args:
        business_name: { from_column: business_name }
        website: { from_column: website }
      outputs:
        contact_name:
          type: string
          description: Full name of the most senior decision-maker
        contact_title:
          type: string
          description: Job title (e.g., Owner, Director, Manager)
        contact_linkedin_url:
          type: string
          description: LinkedIn profile URL if found
      depends_on: [business_name, website]
      cache: 90d
      concurrency: 10
      model: sonnet
      step_budget: 10
      prompt_file: ./prompts/decision_maker.md
      prompt_args:
        seniority_hint: "owner, manager, or director"
```

The `outputs` declaration is the single source of truth for the LLM contract, DB column schema, and dependency tracking. Each key is both the output field name and the database column name. Each value carries `type` (determines SQLite type and Zod validation), `description` (injected into the execution prompt), and optional `enum` (constrains values). At runtime, the orchestrator builds a step-specific Zod schema from `outputs` and passes it to `generateObject` — the LLM sees typed field definitions, not a generic `z.record(z.any())`.

Named prompts for operator-added steps live wherever the operator puts them (referenced by relative path from the list directory).

The orchestrator validates structure via Zod at config-load time. Tool references (toolkit → slugs, slug → schema) are resolved at config authoring time and stored in the config itself (`tool.tools` and `tool_catalog`). At runtime, the orchestrator reads schemas directly from the config — no Composio discovery calls. Adding a new toolkit requires re-running config author or `refresh-tools`, which re-resolves and updates the config. See `runtime.md § Tool Loading` and `performance.md § Priority 1`.
