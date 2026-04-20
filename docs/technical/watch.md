# Watch

## Purpose

See what the outbound system is doing, in real time, from a separate terminal.

Operations like sourcing, enrichment, and sequencing can run for 5–45 minutes. During that time the orchestrator is executing hundreds of AI SDK calls, each making tool calls through Composio. The `watch` command gives you a live window into all of it as it happens, without interfering with the running operation.

## Usage

Open a second terminal and run:

```
npx agent-outbound watch ./boise-plumbers
```

Everything the system does for that list streams to your terminal. Ctrl+C to exit.

## How It Works

The running CLI emits structured activity events (see `runtime.md § Activity Emission`) in two places:

1. **stdout** of the running process — formatted for the caller
2. **Unix socket** at `<list>/.outbound/.activity/current.sock` — JSON lines

The `watch` command connects to the socket as a read-only consumer and streams events to your terminal, formatted for human reading. Multiple watchers can connect to the same socket simultaneously. When no process is running, the socket is absent and `watch` tails the history ring buffer at `<list>/.outbound/.activity/history.jsonl` instead, then waits for a new run to start.

No subprocess stdout piping is involved. The running CLI is a single Node process; the activity events come from `onStepFinish` callbacks and orchestrator emissions within that process.

## What You See

When you connect, you first see recent activity from the history buffer (the last ~200 events), then the live stream.

```
=== recent activity ===
[14:20:01] phase.start enrichment (4 steps, 45 records)
[14:20:01] step.start place_details (45 records, model=sonnet, concurrency=10)
[14:20:45] step.complete place_details (45 ok, 0 failed, total $0.18)
[14:21:01] step.start hiring_contact (45 records, model=sonnet, concurrency=10)
[14:21:15] step progress hiring_contact 12/45

=== live ===
[14:21:16] record.start hiring_contact _row_id=abc Master Pilates
  tool.call  FIRECRAWL_SCRAPE url=https://masterpilatess.com
  tool.result ok, 8.2KB, 2.1s
  tool.call  SERPAPI_SEARCH query="Master Pilates owner Boise"
  tool.result ok, 10 results, 0.9s
  final output {contact_name: "Jane Smith", contact_title: "Studio Manager",
                contact_linkedin_url: null, confidence: "medium"}
[14:21:34] record.complete _row_id=abc duration=18.2s cost=$0.027
[14:21:34] record.start hiring_contact _row_id=def Boise Hot Yoga
  tool.call  FIRECRAWL_SCRAPE url=https://boisehotyoga.com
  tool.result ok, 12KB, 3.4s
  tool.call  SERPAPI_SEARCH query="Boise Hot Yoga manager"
  tool.result ok, 10 results, 1.1s
  final output {contact_name: "Mike Torres", contact_title: "Owner",
                contact_linkedin_url: "https://linkedin.com/in/...", confidence: "high"}
[14:21:52] record.complete _row_id=def duration=18.1s cost=$0.031
[14:21:52] step progress hiring_contact 14/45
```

The indented lines are AI SDK step events (tool calls and final structured output) from `onStepFinish`. The bracketed lines are orchestrator events (phase/step/record transitions).

## What Gets Streamed

Everything. Every phase, every step, every record, every AI SDK step, every tool call, every result.

- **Phase events** — `phase.start`, `phase.end`
- **Step events** — `step.start`, `step.complete`, `step.failed`
- **Record events** — `record.start`, `record.complete`, `record.failed`, `record.skipped` (stale-cache hit)
- **AI SDK step events** — each model turn, with tool calls and final output
- **Tool events** — individual Composio tool calls with args summary and result size/duration
- **Channel events** — `mail.submitted`, `mail.delivered`, `email.sent`, `email.replied`, `visit.scheduled`, `visit.completed`
- **Routing events** — `route.planned` with stop count and total drive time
- **CRM events** — `crm.sync` with CRM entity IDs created/updated
- **Cost events** — running totals of tokens and tool calls
- **Errors** — any failures with context

## Tool-Call Detail

Each `tool.call` event carries:

- `toolkit` — e.g., `FIRECRAWL`
- `action` — e.g., `SCRAPE`
- `args` — args summary (truncated for readability)
- Associated with the record being processed

Each `tool.result` event carries:

- `ok: boolean`
- `duration_ms`
- `size_bytes` — approximate size of the result
- `error` — if `ok` is false, the error message

Args with obvious secrets are redacted in the watch view (OAuth tokens, API keys). Full payloads are never written to the activity log.

## When Nothing Is Running

If no operation is in progress for the list, `watch` shows the recent history and waits:

```
$ npx agent-outbound watch ./boise-plumbers

=== recent activity ===
[14:20:01] phase.start enrichment (4 steps, 45 records)
[14:20:45] step.complete place_details (45 ok)
[14:25:12] step.complete hiring_contact (45 ok, 2 failed)
[14:31:08] step.complete contact_email (43 ok, 5 failed)
[14:35:22] phase.end enrichment (total $1.84, 12m 21s)

waiting for activity...

[14:40:01] phase.start sourcing (3 searches)         ← operator ran /outbound source
[14:40:01] step.start search_local_business_plumbers_boise
  tool.call  <SEARCH_TOOL> location="Boise, ID" query="plumber"
  ...
```

## History Buffer

The history buffer (`history.jsonl`) stores the last ~200 structured events. It's a compact summary — phase starts, step completions, per-record failures, cost totals. It does **not** include the full AI SDK step events (tool calls and reasoning) from past operations; those are only available in the live stream while you're connected.

If you need to audit a past run in detail, check `.outbound/costs.jsonl` (cost aggregates), `.outbound/sourcing.log`, `.outbound/compliance.log`, and `.outbound/crm.log`. These are append-only logs of specific event types.

## Multiple Watchers

The activity socket supports multiple simultaneous consumers. Multiple watch terminals see the same events. Useful when one terminal is full-detail and another is filtered (see Filtering below).

## Scoping and Filtering

Each `watch` session is scoped to a single list (`./boise-plumbers`). Open one watch per list if you're running operations across several.

Optional filters:

```
npx agent-outbound watch ./boise-plumbers --event tool.call,tool.result
npx agent-outbound watch ./boise-plumbers --step hiring_contact
npx agent-outbound watch ./boise-plumbers --record abc-123
npx agent-outbound watch ./boise-plumbers --error-only
npx agent-outbound watch ./boise-plumbers --cost      # only record.complete events with cost
```

Filters run locally against the stream; the emitter isn't aware of them.

## Modes

| Mode | Flag | Description |
|---|---|---|
| Live (default) | *(none)* | Follow the current list's activity socket |
| All lists | `--all-lists` | Tail activity sockets for every list under the current directory |

Reply/delivery events surface in the activity stream when polling passes (`detect-replies`, delivery status checks) find new state — same event surface as any other orchestrator work.

## Inputs / Outputs

**Inputs:**
- List directory path (required)

**Outputs:**
- Real-time, human-formatted stream of orchestrator and AI SDK activity
- History summary on connect

## Relationship to Other Logging

- `stdout` of the running CLI → immediate, caller-visible; default human-formatted, `--format json` for machine-readable
- **Activity socket + history.jsonl** → the watch command's source; structured events suitable for any consumer
- `costs.jsonl`, `sourcing.log`, `compliance.log`, `crm.log` → append-only subject logs for audit and reporting

Watch is the interactive view. The logs are the archive.
