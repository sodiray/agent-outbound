# Agent Contract

Agent-Outbound is a CLI that an agent drives. The operator talks to Claude Code (or whatever agent they've wired up); the agent runs `agent-outbound` commands and composes the results into whatever the operator needed. For that loop to work, the CLI has to behave predictably when an agent is the caller.

This doc describes the contract the tool upholds for its agent consumers — how outputs are shaped, how errors are returned, how the CLI describes itself, and how replays work. It's less a feature list and more a promise about how every command behaves.

## Why It Matters

An agent wrapping the CLI is parsing output in a prompt. If the shape drifts, the agent breaks silently. If errors are strings, the agent can't decide whether to retry or escalate. If a new command shows up and the agent doesn't know about it, the operator doesn't get the capability.

The contract exists so the wrapping agent can trust what it gets back and can discover what's available without a human updating its prompt.

## Stable JSON Output

Every command returns JSON by default. Output shapes are documented, versioned, and stable between releases. A breaking change to an output shape bumps the tool's schema version and is called out in release notes.

Common fields present on nearly every command response:

- `ok` — boolean, whether the command succeeded
- `command` — which command ran
- `list` — which list was operated on, when applicable
- `schema_version` — which schema version this response conforms to
- `result` — the command-specific payload
- `warnings` — non-fatal observations the agent should relay
- `usage` — AI usage summary for this invocation

The agent reads `schema_version` and `ok` to decide how to interpret the rest. If `ok` is false, `result` is absent and an `error` field is present (see below).

## Machine-Readable Errors

Every failure returns a structured error:

```json
{
  "ok": false,
  "command": "enrich",
  "error": {
    "code": "BUDGET_EXCEEDED",
    "message": "LLM budget for boise-plumbers reached: $20.00 used of $20.00 cap (daily).",
    "retryable": false,
    "hint": "Raise the daily cap with `config update` or wait for the window to reset.",
    "fields": {
      "list": "boise-plumbers",
      "budget": "llm.list_daily_usd",
      "used_usd": 20.00,
      "cap_usd": 20.00,
      "window": "daily",
      "resets_at": "2026-04-22T00:00:00Z"
    }
  }
}
```

- `code` — stable machine-readable identifier the agent branches on (`BUDGET_EXCEEDED`, `TOOL_NOT_CONNECTED`, `DEPENDENT_STEP_EXISTS`, `SQL_WRITE_BLOCKED`, etc.)
- `message` — human-readable summary the agent can pass through
- `retryable` — whether the agent should try again without operator intervention
- `hint` — a next-step suggestion the agent can relay to the operator
- `fields` — structured detail the agent can use to compose a better explanation

The agent branches on `code` and `retryable` before deciding to retry, escalate, or ask the operator.

## Self-Describing CLI

```
agent-outbound describe
agent-outbound describe --command enrich
agent-outbound describe --format json
```

Returns the full catalog of commands — each command's purpose, flags, input schema, output schema, and examples. An agent that starts a session against a newer release can call `describe` to discover commands it didn't know about before, without needing its prompt updated.

`describe` is the counterpart to `schema` (see [Data Access](./data-access.md)). `schema` describes the data; `describe` describes the commands.

```
agent-outbound help --json
agent-outbound <command> --help --json
```

Also returns structured help for any single command — flags, types, defaults, and examples.

## Deterministic Ordering and Cursor Pagination

Every read command that can return many rows has a stable `ORDER BY` and paginates with cursors:

```
agent-outbound query boise-plumbers --sql "..." --cursor <cursor>
agent-outbound export boise-plumbers --select "..." --cursor <cursor>
agent-outbound route show --date 2026-04-21 --cursor <cursor>
```

Cursors are opaque tokens the tool emits when results are truncated. The agent passes them back on the next call. The order of results between pages is stable regardless of concurrent writes to the list.

This matters because an agent that's scanning a list in chunks should never see the same record twice or miss one because sort order shifted mid-scan.

## Idempotency Keys and Replay

Mutating commands accept `--idem-key <key>`. When the agent retries a command with the same key, the tool returns the prior result with `already_done: true`:

```json
{
  "ok": true,
  "command": "launch send",
  "idem_key": "2026-04-21-launch-top50",
  "already_done": true,
  "result": { ... original result ... }
}
```

The agent generates keys deterministically from the operator's request (e.g., a hash of the request description plus date) so that retrying the same operator ask gives the same key. See [Safety and Preview](./safety-and-preview.md) for details.

## Rate and Cache Signals in Responses

When a response reflects cached or throttled behavior, the tool says so:

```json
{
  "ok": true,
  "result": { ... },
  "signals": {
    "cached_fraction": 0.73,
    "throttled_calls": 4,
    "skipped_stale_records": 118
  }
}
```

The agent relays these to the operator when relevant — for example, *"enriched 247 records, 73% were cached so actual new AI spend was $1.40."*

## Optional Summary Output Mode

Some commands support `--format summary` alongside the default `--format json`:

```
agent-outbound pipeline show boise-plumbers --format summary
agent-outbound ai-usage boise-plumbers --period 7d --format summary
```

Returns a short human-readable text block suitable for pass-through to the operator without re-summarization by the agent. The JSON response still includes the full structured data; the summary is an additional `summary` field.

This is a token-saver for the wrapping agent — for common asks, it can pass the summary through instead of paying to compose one from raw data.

## Versioning Promise

- `schema_version` is bumped when an output shape changes in a breaking way.
- Command flags are additive — new optional flags don't break existing agent prompts.
- Deprecated commands stay available for at least one release with a warning in the response.
- Error `code` values are stable — once introduced, they don't get renamed.

## What the Agent Relies On

A well-behaved wrapping agent assumes the following at all times:

1. Commands either succeed cleanly or return a structured error — never a silent failure.
2. Output shapes match `describe`'s declaration.
3. Retries with an idempotency key don't duplicate side effects.
4. Read commands paginate and preserve order across pages.
5. Errors with `retryable: true` can be retried without operator intervention.
6. `describe` is the source of truth for what commands and flags exist.

If any of these is ever not true, it's a bug in the tool — not something the agent needs to work around.

## What the Operator Sees

None of this. The contract is between the tool and the agent. The operator sees coherent, reliable behavior from the agent: consistent answers, graceful handling of failures, correct explanations when something stops ("hit your daily AI cap, want to raise it?").

The contract is invisible when it works. It only shows up when it breaks.
