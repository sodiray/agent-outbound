# Watch

A separate-terminal view into what the tool is doing in real time.

## Why It Exists

Operations like sourcing, enrichment, and sequencing can run for 5–45 minutes. During that time the tool is doing hundreds of individual things — making tool calls, scoring records, drafting emails, planning routes. The `watch` command is a live window into all of it, without interfering with the running operation.

If the operator kicks off a long enrichment and wants to see progress, they open a second terminal and run:

```
npx agent-outbound watch ./boise-plumbers
```

Everything happening on that list streams to the terminal. Ctrl+C to exit.

## What You See

When the operator connects, they first see a summary of recent activity (what phase is running, how far along it is). Then the live stream begins.

```
=== recent activity ===
[14:20:01] enrichment started (4 steps, 45 records)
[14:20:45] step place_details complete (45 ok, 0 failed)
[14:21:01] step hiring_contact: 12/45 complete

=== live ===
[14:21:16] record.start hiring_contact Master Pilates
  tool.call  FIRECRAWL_SCRAPE url=https://masterpilatess.com
  tool.result ok, 8.2KB, 2.1s
  tool.call  SERPAPI_SEARCH query="Master Pilates owner Boise"
  tool.result ok, 10 results, 0.9s
  final output contact_name="Jane Smith", contact_title="Studio Manager"
[14:21:34] record.complete duration=18.2s cost=$0.027
[14:21:52] step progress hiring_contact 14/45
```

Everything happening gets streamed: phase starts, step starts, per-record progress, tool calls and results, errors, final outputs, cost totals.

## Multiple Watchers

Multiple terminals can watch the same list simultaneously. One full-detail, one filtered to errors only — both see the same underlying stream.

## Filtering

Optional filters:

```
npx agent-outbound watch ./boise-plumbers --event tool.call,tool.result
npx agent-outbound watch ./boise-plumbers --step hiring_contact
npx agent-outbound watch ./boise-plumbers --record abc-123
npx agent-outbound watch ./boise-plumbers --error-only
npx agent-outbound watch ./boise-plumbers --cost
```

## When Nothing Is Running

If no operation is in progress, `watch` shows recent history and waits for the next activity. The next time the operator runs something via `/outbound`, the live stream picks up. Reply and delivery events appear whenever the polling pass (`detect-replies`, delivery status checks) surfaces them.

## What Watch Is Not

- Not interactive — it's read-only; the operator doesn't type into it
- Not a log archive — for past detail beyond the recent history buffer, the operator reads the structured logs (`sourcing.log`, `compliance.log`, `crm.log`, `costs.jsonl`)
- Not scoped to multiple lists by default — one watch per list. Use `--all-lists` to tail every list's activity in one stream.
