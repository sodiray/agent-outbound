# Runtime (SDK + Composio Reference)

Deep reference for the in-process runtime. Read `architecture.md` first for the big picture; this doc covers the implementation contract — libraries, client lifecycle, auth bootstrap, tool loading, errors, and the operational details the orchestrator depends on.

## Libraries

```json
{
  "dependencies": {
    "ai": "^6.0.0",
    "@ai-sdk/anthropic": "^2.0.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0",
    "better-sqlite3": "^11.0.0",
    "hono": "^4.0.0"
  }
}
```

`@modelcontextprotocol/sdk` is the stable MCP client used to reach Composio's consumer MCP server. **There is no `@composio/core` or `@composio/vercel` dependency** — those libraries target Composio's developer API, which this tool does not use. `hono` is used only in `serve` mode for the HTTP surface.

## The MCP Client

Constructed once per CLI invocation, reused across every action:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const makeMcpClient = async () => {
  const transport = new StreamableHTTPClientTransport(
    new URL("https://connect.composio.dev/mcp"),
    {
      requestInit: {
        headers: {
          "x-consumer-api-key": assertEnv("COMPOSIO_API_KEY"),
        },
      },
    }
  );
  const client = new Client(
    { name: "agent-outbound", version: "0.x.x" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return client;
};
```

A single client serves the whole process. For long-running flows (`serve` mode), it persists for the life of the process; for one-shot CLI invocations it opens at startup and closes cleanly on exit.

Consumer MCP is **single-tenant by design**: the API key belongs to one operator's Composio account, and every tool call uses whichever connection exists under that account. There is no userId argument anywhere in this codebase.

## Auth Bootstrap (`agent-outbound init`)

One-time operator setup. `init` captures keys, validates them, and reports what's connected. It never initiates OAuth, never creates, modifies, or removes connections — those live entirely in the Composio dashboard.

### Interactive (default, stdin is a TTY)

```
$ agent-outbound init

Step 1 of 2 — Composio
----------------------
Composio consumer API key: ●●●●●●●●●●●●●●●●   (masked)
Validating Composio key... ok.

Toolkits currently connected (5):
  - GMAIL
  - HUNTER
  - SERPAPI
  - FIRECRAWL
  - GOOGLEMAPS

Step 2 of 2 — Anthropic
-----------------------
Anthropic API key: ●●●●●●●●●●●●●●●●
Validating Anthropic key... ok. (9 models available)

Setup complete.
```

### Non-interactive (flags, for CI or scripted setup)

```
agent-outbound init \
  --composio-api-key <ck_key> \
  --anthropic-api-key <sk_key> \
  --non-interactive
```

Missing keys in non-interactive mode are a hard error.

### Flow

1. **Composio key.** Prompt (masked), validate by opening an MCP connection and calling `tools/list`. If the MCP server returns a 401 or transport error, reject with the upstream message.
2. **Enumerate connected toolkits.** `COMPOSIO_SEARCH_TOOLS` takes structured queries (`queries: [{ use_case: "..." }]`, not strings). Run a spread of domain-relevant use-cases (email, research, CRM, mail, SMS, maps, calendar, etc.) and aggregate the `toolkit_connection_statuses[].toolkit` entries where `has_active_connection === true`. Print as a sanity-check summary so the operator can confirm they're pointed at the right Composio account.
3. **Anthropic key.** Prompt (masked), validate with `GET https://api.anthropic.com/v1/models`.
4. **Persist.** Write `COMPOSIO_API_KEY` and `ANTHROPIC_API_KEY` to `~/.agent-outbound/env` (file chmod 600, directory chmod 700). `process.env` overrides the file at runtime.
5. **Summary.** Print next-step hints (`list create`, `source`).

Every `init` run prompts fresh and overwrites whatever was saved before — no implicit reuse.

### Toolkit connections live in the Composio dashboard

The operator connects toolkits at `https://platform.composio.dev/apps/<toolkit>` in their own browser. Agent-outbound has no command that creates, refreshes, or revokes a connection. If `agent-outbound auth --list` shows that Apollo isn't connected, the operator goes to the dashboard and connects it; the next CLI run sees it.

```bash
agent-outbound auth --list       # show connected toolkits visible to this tool
```

## Tool Loading

Tool schemas are resolved at **config authoring time**, not at runtime. When the config author adds a step with a toolkit reference, the system resolves the toolkit to specific tool slugs and stores both the slugs and their schemas in the config. At execution time, the orchestrator reads schemas from the config's `tool_catalog` and synthesizes Vercel AI SDK tool definitions whose `execute` functions wrap `COMPOSIO_MULTI_EXECUTE_TOOL`. No Composio discovery calls happen at runtime.

See `performance.md § Priority 1` for the full rationale and migration plan.

### Tool spec in config

```yaml
tool:
  toolkits: [GMAIL]              # what was discovered from; retained for re-resolution
  tools: [GMAIL_SEND_EMAIL, GMAIL_CREATE_DRAFT]   # resolved at config time
```

`toolkits` records which Composio toolkit the tools came from — used for re-resolution when refreshing. `tools` is the definitive pinned set, populated at config authoring time.

### Tool catalog in config

Resolved tool schemas are stored in a top-level `tool_catalog` section of `outbound.yaml`:

```yaml
tool_catalog:
  GMAIL_SEND_EMAIL:
    description: "Send an email via Gmail"
    parameters:
      type: object
      properties:
        to: { type: string }
        subject: { type: string }
        body: { type: string }
      required: [to, subject, body]
```

The catalog is populated by the config author action and updated on any `modify_*` op that touches tool specs. A `refresh-tools` CLI command forces re-resolution of all toolkit references.

### Per-action loader

```ts
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { tool } from "ai";
import { z } from "zod";

export const loadTools = async (mcp: Client, spec: ToolSpec, catalog?: ToolCatalog) => {
  // Read from config catalog first; fall back to MCP for anything missing
  const schemas = catalog
    ? spec.tools.map((slug) => catalog[slug] ?? null).filter(Boolean)
    : await getToolSchemasCached(mcp, spec.tools);
  return Object.fromEntries(
    schemas.map((s) => [
      s.slug,
      tool({
        description: s.description,
        inputSchema: toZod(s.input_schema),
        execute: async (args) => invokeTool(mcp, s.slug, args),
      }),
    ])
  );
};

const invokeTool = async (mcp: Client, slug: string, args: Record<string, unknown>) => {
  const result = await mcp.callTool({
    name: "COMPOSIO_MULTI_EXECUTE_TOOL",
    arguments: { tools: [{ tool_slug: slug, arguments: args }] },
  });
  return unwrapSingle(result);
};
```

The agent receives tool definitions that look indistinguishable from first-class SDK tools. Under the hood every invocation hits the MCP server's `COMPOSIO_MULTI_EXECUTE_TOOL` meta-tool.

### Schema fetching is not free

`COMPOSIO_GET_TOOL_SCHEMAS` is cached per-process:

```ts
const schemaCache = new Map<string, ToolSchema>();

const getToolSchemasCached = async (mcp: Client, slugs: string[]) => {
  const missing = slugs.filter((s) => !schemaCache.has(s));
  if (missing.length > 0) {
    const fresh = await mcp.callTool({
      name: "COMPOSIO_GET_TOOL_SCHEMAS",
      arguments: { tool_slugs: missing },
    });
    for (const schema of unwrapSchemas(fresh)) schemaCache.set(schema.slug, schema);
  }
  return slugs.map((s) => schemaCache.get(s)!);
};
```

Cache is per-process, dropped on exit. If `launch draft` and `launch send` both pin `GMAIL_CREATE_DRAFT`, the schema fetches once per process.

### Discovery for `author-config`

When the operator asks to add a step, `author-config` needs to identify candidate slugs. It calls `COMPOSIO_SEARCH_TOOLS` with the operator's intent (e.g. "find an email from a name and domain") and filters by toolkit hints when the operator names one. Results feed a typed `ConfigChange` schema the model emits.

Author-config does not query live connection status — if the operator asks for a step that uses an unconnected toolkit, the step is written and the next `execute-step` will error with a clear "Hunter not connected" message.

## Action Module Convention

Every action is a small self-contained module with three co-located files:

```
src/orchestrator/actions/
  <action-name>/
    index.ts          # execute function, input/output types, tool pinner
    prompt.md         # prompt template (capability-described, provider-agnostic)
    schema.ts         # Zod output schema
```

This convention is enforced at code review. Adding a new action is a new folder — code, prompt, and schema land together.

### `index.ts` shape

```ts
import { readFileSync } from "node:fs";
import { z } from "zod";
import { generateText, stepCountIs, Output } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { loadTools } from "../../runtime/tools";
import { pickModel } from "../../runtime/models";
import { renderPrompt } from "../../runtime/prompts";
import { EmitFn } from "../../runtime/activity";
import OutputSchema from "./schema";

const PROMPT = readFileSync(new URL("./prompt.md", import.meta.url), "utf8");

export const execute = async ({
  mcp, config, record, emit,
}: Input): Promise<{ output: Output; usage: Usage }> => {
  emit({ type: "step.start", record_id: record._row_id, step_id: config.id });

  const tools = await loadTools(mcp, config.tool);
  const result = await generateText({
    model: pickModel(config.model ?? "sonnet"),
    system: renderPrompt(PROMPT, { ...record, ...config.prompt_args }),
    messages: [{ role: "user", content: buildUserPrompt(record) }],
    tools,
    stopWhen: stepCountIs(config.step_budget ?? 10),
    output: Output.object({ schema: OutputSchema }),
    onStepFinish: (step) => emit({
      type: "sdk.step",
      record_id: record._row_id,
      tool_calls: step.toolCalls,
      text_delta: step.text,
    }),
  });

  emit({ type: "step.complete", record_id: record._row_id, usage: result.usage });
  return { output: result.output, usage: result.usage };
};
```

### `prompt.md` shape

Capability-described, provider-agnostic. Uses `{{ placeholder }}` merge syntax resolved by `renderPrompt`.

```markdown
You are finding the most senior operational decision-maker for a business.

**Business:** {{business_name}}
**Website:** {{website}}

You have tools available for:
- scraping web pages (to read the team/about page)
- performing web searches (to find mentions of the owner)

Work through these steps:
1. Try the business's team or about page first — look for {{seniority_hint}}.
2. If no team page exists, search the web for "{{business_name}} owner".
3. Return the contact's full name, title, and LinkedIn URL if visible.

Prefer a direct hit from the website over search results. If multiple candidates
appear, prefer the most senior title.
```

**Never name specific Composio toolkits in a prompt.** All prompts are capability-described and provider-agnostic. The step's config pins which tools satisfy it.

### `schema.ts` shape

```ts
import { z } from "zod";

export default z.object({
  contact_name: z.string(),
  contact_title: z.string(),
  contact_linkedin_url: z.string().url().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
});
```

The schema's field names map to the step config's `columns` mapping at write time. Versioning is explicit (a file rename to `schema_v2.ts` when the shape changes); the orchestrator never rewrites columns across schema versions.

### Common elements across all actions

- Emit `*.start` / `*.complete` activity events
- Use `onStepFinish` to surface tool calls and intermediate reasoning
- Return both the output and the `usage` (for cost tracking)
- Fail loudly on schema validation errors; the orchestrator decides whether to retry

## Schemas

### Built-in vs. operator-authored schemas

Two kinds:

1. **Built-in action schemas** (for `author-config`, `execute-step`'s envelope, `classify-reply`, `plan-route`, `sync-crm`, etc.) ship with the tool. They live in the codebase at `src/schemas/<name>.ts` and are imported directly by action modules.

2. **Operator-authored step schemas** — when `author-config` adds a new enrichment or sequence step, it emits a per-list JSON Schema describing that step's output. These live in the list's tool-managed directory: `<list-root>/.outbound/schemas/<name>_v1.json`. The orchestrator compiles JSON Schema → Zod at action-load time and uses it to validate output.

Operators don't author schemas by hand. They describe intent (*"add a step to find a decision-maker"*); `author-config` emits the schema.

### Example (operator-added step schema)

Emitted at `<list-root>/.outbound/schemas/decision_maker_v1.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["contact_name", "contact_title", "confidence"],
  "properties": {
    "contact_name": { "type": "string" },
    "contact_title": { "type": "string" },
    "contact_linkedin_url": { "type": ["string", "null"], "format": "uri" },
    "confidence": { "enum": ["high", "medium", "low"] }
  }
}
```

The `v1` suffix signals a versioning discipline: when the shape changes meaningfully, `author-config` emits `decision_maker_v2.json` instead of mutating `_v1`. The orchestrator never rewrites columns across schema versions; the operator re-runs enrichment under the new schema.

### Schema-aware column mapping

The step config's `columns` mapping declares which schema fields go to which `records` table columns. If a schema field is missing from `columns`, the orchestrator logs a warning and drops it. If a column is declared but not in the schema, config validation fails at load time. If a column doesn't yet exist on the `records` table, the orchestrator runs `ALTER TABLE ADD COLUMN` at step registration time (see `data-schema.md`).

## Model Routing

```ts
export const pickModel = (choice: "opus" | "sonnet" | "haiku") => {
  switch (choice) {
    case "opus":   return anthropic("claude-opus-4-6");
    case "sonnet": return anthropic("claude-sonnet-4-6");
    case "haiku":  return anthropic("claude-haiku-4-5-20251001");
  }
};
```

Defaults are set per-action in the action module; operator can override per-step via `config.model`. Most steps default to `sonnet`. Reply classification, filter/condition evaluation, rubric criterion evaluation default to `haiku`. Email copywriting and outreach drafting default to `opus`.

## Prompt Caching

Anthropic's prompt cache is automatic when the same prefix is passed across calls within a 5-minute TTL. The runtime opportunistically builds prompts so that:

- System prompts are stable per action (cacheable)
- Tool schemas are stable per step (cacheable)
- Record-specific data goes last, after the cached prefix

For batch work (enriching 500 records through the same step), cache hit rate is ~high and cost drops substantially.

## Error Handling

### Error taxonomy

| Kind | Source | Handling |
|---|---|---|
| Schema validation | AI SDK output validation | Record step failure; continue next record |
| Tool execution | MCP upstream error (provider 4xx/5xx wrapped by Composio) | AI SDK retries automatically within step budget; if still failing, record failure |
| Connection not active | MCP error from Composio ("no active connection for toolkit X") | Halt channel; tell operator to reconnect in Composio dashboard |
| Composio auth | MCP connect returns 401 | Halt with message to re-run `agent-outbound init` |
| Anthropic API | Rate limit, 5xx | Exponential backoff up to N retries, then record failure |
| Step budget exceeded | `stopWhen` hit without final output | Record failure; step budget was too low |
| Config error | Invalid Zod parse of `outbound.yaml` | Halt; exit 2 with diagnostic |

### Retry policy

- Tool-call errors: handled inside the AI SDK step loop (automatic)
- Per-record step errors: recorded on the record; orchestrator continues the batch
- Transient Anthropic errors: exponential backoff, 3 attempts
- Config/auth errors: never retried; surfaced for operator action

### Idempotency

Destructive tool calls (email send, mail send, SMS send, calendar event create) are wrapped:

```ts
const key = idempotencyKey(record, step);
const marker = await readMarker(record, step);

if (marker?.status === "sent") {
  return { output: { provider_id: marker.provider_id }, usage: ZERO_USAGE };
}

await writeMarker(record, step, { status: "pending", key });
const result = await generateText({ ... });
await writeMarker(record, step, {
  status: "sent",
  key,
  provider_id: extractProviderId(result),
});
return result;
```

Markers live in a dedicated column per step (`step_<id>_idempotency`) or in a sidecar table. If a crash lands the record in `pending` without a `sent` marker and the provider-side state is unknown, the operator runs `agent-outbound reconcile <list>` which queries the provider for recent sends and updates markers.

## Polling (Replaces Triggers)

Agent-outbound has no trigger subscriptions, no webhooks, no WebSocket listeners. Consumer MCP does not expose a trigger meta-tool, and we've made an explicit design choice to poll for all async state.

### Reply detection

`sequence run` invokes the pinned reply-detection tool (e.g. `GMAIL_LIST_MESSAGES` with a `since` query matching the last polled timestamp), scans the results for replies to sent threads, and writes `channel_events` rows for each match. `classify-reply` then runs on each.

```ts
// Conceptually:
const since = await db.prepare(
  "SELECT MAX(occurred_at) FROM channel_events WHERE channel='email' AND kind='reply'"
).get();

const messages = await executeTool(mcp, "GMAIL_LIST_MESSAGES", {
  query: `is:reply after:${isoToUnix(since)}`,
  max_results: 100,
});

for (const msg of messages.items) {
  await handleMaybeReply(db, msg);
}
```

Polling cadence is controlled by how often the operator runs `sequence run` — via cron, manually, or by `serve` mode's internal scheduler (see below).

### Delivery tracking (mail, SMS)

`sequence run` iterates outstanding pieces from `channel_events` whose delivery status is still `pending` or `in_transit`, and invokes the provider's status tool (`LOB_GET_POSTCARD`, `TELNYX_GET_MESSAGE_STATUS`) to refresh their state.

### `serve` mode's scheduler

In `serve` mode, a simple internal scheduler (`setInterval`) runs polling passes at configurable intervals:

```yaml
watch:
  poll_replies_minutes: 5      # check Gmail for new replies every 5 min
  poll_delivery_minutes: 15    # refresh Lob / Telnyx delivery state every 15 min
```

Defaults are conservative; operators tune down for tighter sequences or up to save Composio tool-call quota.

## Activity Emission

Every action receives an `emit` function. The emit layer writes to:

1. **stdout** (human-formatted by default; JSON lines if `AO_STREAM=json`)
2. **Activity socket** at `.outbound/.activity/current.sock` (unix socket; JSON lines)
3. **History ring buffer** at `.outbound/.activity/history.jsonl` (last ~200 structured events, for the watch command on reconnect)

See `watch.md` for what the consuming side looks like.

Event types:

```ts
type ActivityEvent =
  | { type: "phase.start"; phase: string; meta: object }
  | { type: "phase.end"; phase: string; meta: object }
  | { type: "step.start"; step_id: string; record_id?: string; meta: object }
  | { type: "step.complete"; step_id: string; record_id?: string; usage: Usage }
  | { type: "step.failed"; step_id: string; record_id?: string; error: string }
  | { type: "sdk.step"; record_id?: string; tool_calls: ToolCall[]; text_delta?: string }
  | { type: "tool.call"; toolkit: string; action: string; args: object }
  | { type: "tool.result"; toolkit: string; action: string; ok: boolean; duration_ms: number }
  | { type: "route.planned"; route_id: string; stops: number; total_minutes: number }
  | { type: "crm.sync"; record_id: string; crm_ids: object };
```

Every event carries a timestamp added at emit time.

## Cost Tracking

Every AI SDK call returns `usage`:

```ts
{
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  cachedInputTokens?: number,   // cache hits
}
```

The orchestrator aggregates these per step, per record, per run. Written to `.outbound/costs.jsonl` as append-only events.

Separately, Composio tool-call counts are billed by Composio. The orchestrator counts MCP tool invocations and surfaces them in `agent-outbound stats <list>`.

## The SQLite Client

One module (`src/orchestrator/runtime/db.ts`) owns every read and write. No query strings outside this module; every call site uses a typed function.

```ts
import Database from "better-sqlite3";

export const openDb = (listPath: string) => {
  const db = new Database(`${listPath}/.outbound/prospects.db`);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  return db;
};
```

Typed query layer exposes CRUD-style functions per table:

```ts
export const records = {
  findById: (db, id) => db.prepare("SELECT * FROM records WHERE _row_id = ?").get(id),
  findDueForStep: (db, stepId, cutoff) => ...,
  upsert: (db, record) => ...,
  setSequenceState: (db, id, state) => ...,
};

export const channelEvents = {
  recordSent: (db, row_id, channel, meta) => ...,
  recordReply: (db, row_id, threadId, classification) => ...,
  latestByChannel: (db, row_id, channel) => ...,
};

export const suppression = {
  check: (db, type, value) => { /* hot-path query against indexed columns */ },
  add: (db, entry) => ...,
};
```

Every mutation that spans multiple tables wraps in a transaction:

```ts
db.transaction(() => {
  records.setSequenceState(db, id, "active");
  channelEvents.recordSent(db, id, "email", meta);
  idempotency.resolve(db, key, "sent", providerId);
  costEvents.insert(db, costEntry);
})();
```

### Global DB (suppression)

Global suppression lives in a separate SQLite file at `~/.agent-outbound/suppression.db` with the same schema as the per-list `suppression` table. Opened lazily; checked on every send alongside the per-list table.

### Schema

A single `SCHEMA` constant holds every `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` statement. `openDb` executes it on every open — new DBs get the schema, existing DBs see no-ops. No migration runner, no `schema_version` table, no numbered migration files. The schema is the source of truth; when it changes during development, the operator resets the list's DB and re-sources. See `storage.md § Schema Definition`.

## `serve` Mode

`agent-outbound serve` starts a long-running Node process that:

- Opens the list's SQLite DB (shared with CLI one-shots via WAL)
- Runs the polling scheduler for reply detection + delivery state
- Exposes the action API over local HTTP (`hono` on a user-configurable port, default 4949)
- Streams activity events over a WebSocket

### Startup

```ts
const serve = async (listPath: string, port = 4949) => {
  const db = openDb(listPath);
  const mcp = await makeMcpClient();
  const emit = makeEmitter(listPath);

  const scheduler = startPollingScheduler({ mcp, db, emit, config: readConfig(listPath) });

  const app = new Hono();
  for (const action of actionRegistry) {
    app.post(`/v1/actions/${action.name}`, async (c) => {
      const input = action.inputSchema.parse(await c.req.json());
      const output = await action.execute({ mcp, db, emit, ...input });
      return c.json({ ok: true, output });
    });
  }
  app.get("/v1/activity", (c) => upgradeWebSocket(c, emit));

  await writeServeMarker(listPath, process.pid, port);
  serve({ fetch: app.fetch, port });

  process.on("SIGINT", async () => {
    scheduler.stop();
    await flushActivity();
    await clearServeMarker(listPath);
    await mcp.close();
    db.close();
    process.exit(0);
  });
};
```

### HTTP surface

The HTTP surface mirrors the CLI action set 1:1. Each action becomes `POST /v1/actions/<name>` with JSON body matching the action's input schema and JSON response matching its output schema.

The `/outbound` Claude agent can discover a running `serve` via `.outbound/.serve/port` and prefer HTTP over Bash. When no `serve` is running, it falls back to CLI.

### Concurrency with CLI

SQLite WAL handles concurrent access between `serve` and any CLI one-shot the operator runs. `serve` owns the polling scheduler; one-shot `sequence run` from the CLI (when `serve` is not running) does polling itself.

## Process Lifecycle

- **Short-lived commands** (`source`, `enrich`, `sequence run`, most actions): one-shot, exit on completion.
- **Long-lived commands** (`serve`, `watch`): run until interrupted. Handle SIGINT cleanly — stop the scheduler, flush activity socket, clear serve marker, close the MCP client and DB.

## Testing

Two kinds of tests:

1. **Orchestrator unit tests** — deterministic. Mock the MCP client and the AI SDK; assert the orchestrator's state transitions, staleness logic, scoring math, config loading.
2. **Integration smoke tests** — end-to-end against a real Composio consumer API key in a dedicated test account. Run in CI only when the `RUN_SMOKE=1` env is set and a key is available.

Action code is deliberately thin — the interesting logic is in the orchestrator. Test the orchestrator against mocks; trust Composio and the AI SDK for the rest.

## Environment Variables

| Var | Purpose |
|---|---|
| `COMPOSIO_API_KEY` | Required. Composio **consumer** API key (`ck_...`) from the operator's Composio dashboard. |
| `ANTHROPIC_API_KEY` | Required. For the AI SDK's Anthropic provider. |
| `COMPOSIO_MCP_URL` | Optional. Override the MCP endpoint. Default `https://connect.composio.dev/mcp`. |
| `AO_STREAM` | Optional. `json` to output JSON lines on stdout; default is human-formatted. |
| `AO_DEFAULT_MODEL` | Optional. Overrides the default `sonnet` for steps that don't declare one. |
| `AO_LOG_LEVEL` | Optional. `debug`, `info`, `warn`, `error`. Default `info`. |

Env files: `~/.agent-outbound/env` for global settings; `<list>/.env.local` for list-specific overrides.
