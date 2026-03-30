# Watch

## Purpose

See what the outbound system is doing, in real time, from a separate terminal.

Operations like sourcing, enrichment, and sequencing can run for 5–45 minutes. During that time, the system is searching for businesses, scraping websites, finding contacts, drafting emails — hundreds of individual steps happening under the hood. Today, you trigger a command through `/outbound` and wait for the final summary. The `watch` command gives you a live window into all of that work as it happens.

## Usage

Open a second terminal and run:

```
npx agent-outbound watch ./boise-pilates
```

Everything the system does for that list streams to your terminal. When you're done watching, Ctrl+C to exit.

## What You See

When you connect, you first see a short summary of recent activity (what phase is running, how far along it is). Then the live stream begins.

```
=== recent activity ===
[14:20:01] enrichment started (4 steps, 45 rows)
[14:20:01] step place_details: 45 rows
[14:20:45] step place_details: complete (45 ok, 0 failed)
[14:21:01] step hiring_contact: 45 rows
[14:21:15] step hiring_contact: 12/45 complete

=== live ===
[14:21:16] hiring_contact: Master Pilates — calling claude
  Scraping website at masterpilatess.com...
  Found team page at /about-us
  Identified: Jane Smith, Studio Manager
  Searching Google for confirmation...
  ✓ complete
[14:21:34] hiring_contact: Boise Hot Yoga — calling claude
  Scraping website at boisehotyoga.com...
  No team page found, trying /staff...
  No staff page found
  Searching Google for "Boise Hot Yoga manager"...
  Found: Mike Torres, Owner (Google)
  ✓ complete
[14:21:52] hiring_contact: 14/45 complete, 0 failed
```

The indented lines are the raw output from Claude as it works — the tool calls, the reasoning, the results. The bracketed lines are progress markers from the orchestrator.

## What Gets Streamed

Everything. Every phase, every step, every row, every Claude call, every tool invocation, every result. Specifically:

- **Phase start/complete** — "enrichment started", "sourcing complete"
- **Step start/complete** — "step hiring_contact: 45 rows", "step hiring_contact: complete"
- **Row-level progress** — "Master Pilates — calling claude", "14/45 complete"
- **Claude output** — the full output from every Claude subprocess, including tool calls it makes, reasoning, and structured results
- **Filter decisions** — which rows passed, which failed, why
- **Dedup stats** — how many duplicates were found during sourcing
- **Errors** — any failures, with context about which step and row

## When Nothing Is Running

If no operation is in progress for the list, `watch` shows the recent activity history and waits. When the next operation starts (you trigger `/outbound enrich boise-pilates` in Claude Code), the live stream picks up automatically.

```
$ npx agent-outbound watch ./boise-pilates

=== recent activity ===
[14:20:01] enrichment started (4 steps, 45 rows)
[14:20:45] step place_details: complete (45 ok, 0 failed)
[14:25:12] step hiring_contact: complete (45 ok, 2 failed)
[14:31:08] step contact_email: complete (43 ok, 5 failed)
[14:35:22] enrichment complete

waiting for activity...

[14:40:01] sourcing started (3 searches)       ← user triggered /outbound source
[14:40:01] search 1/3: plumber Boise Idaho
  Calling Google Maps search...
  ...
```

## History

The recent activity section shows the last ~150–200 structured events (phase starts, step completions, progress, errors). This is a compact summary — it does not include the full Claude output from past operations. Full Claude output is only available in the live stream while you're connected.

This means: if an enrichment run finished 10 minutes ago and you start `watch` now, you'll see that it ran, how long it took, how many rows succeeded or failed — but not the detailed Claude output from each row. To see that level of detail, you need to be watching while it runs.

## Multiple Watchers

Multiple people (or terminals) can watch the same list simultaneously. Each watcher sees the same stream.

## Scoping

Each `watch` session is scoped to a single list. If you're running operations on multiple lists, open a `watch` terminal for each one.

## Inputs / Outputs

**Inputs:**
- List directory path (required)

**Outputs:**
- Real-time stream of all orchestrator and Claude activity for the list
- Recent activity history on connect
