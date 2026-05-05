# Safety and Preview

The tool is driven by an agent. Agents retry on error, make bulk changes, and occasionally make mistakes. This doc covers the primitives the tool exposes so the agent can work safely: preview before commit, snapshot before bulk change, and undo when something went wrong.

## Why This Exists

An operator talking to the agent says *"enrich the whole list"* or *"launch the top 100."* Before the agent executes, the operator wants to know what's about to happen — how many records, how much AI spend, how many tool calls. After execution, if something looks wrong, they want to roll back without losing the rest of their work.

Safety and preview are the tool's way of making those two moments clean. The agent knows the primitives exist and uses them without being asked.

## Universal Dry-Run and Sample

Every costly or mutating command accepts `--dry-run` and `--sample N`:

```
agent-outbound source boise-plumbers --limit 200 --dry-run
agent-outbound enrich boise-plumbers --sample 5
agent-outbound score boise-plumbers --sample 10
agent-outbound launch draft boise-plumbers --top 50 --dry-run
agent-outbound sequence run --all-lists --dry-run
```

### `--dry-run`

Shows what the command *would* do without writing anything. Reports the records it would touch, the steps it would run, the projected AI spend, the projected tool-call counts. No changes to the database, no emails drafted, no mail dispatched.

### `--sample N`

Runs the command for real against N records chosen representatively. Writes those results. Then reports projected cost and behavior at full list scale, so the agent can extrapolate with actual evidence.

Sample is the stronger signal because the numbers are measured, not estimated. The agent prefers sample when the operator is about to authorize a large run — the output is specific enough to advise against running if costs or results look off.

### When the Agent Uses Them

The agent uses dry-run and sample whenever:

- A command will touch more than ~20 records
- The operator is authorizing a new sequence, new enrichment step, or new scoring config for the first time
- A budget is close to its cap
- The operator asks *"what would this do?"* or *"how much would this cost?"*

The agent doesn't use them for single-record actions (logging a visit, suppressing one record) — those are cheap and reversible by other means.

## Snapshots

```
agent-outbound snapshot create boise-plumbers --label "before re-enrich"
agent-outbound snapshot list boise-plumbers
agent-outbound snapshot restore boise-plumbers --id <snapshot_id>
agent-outbound snapshot delete boise-plumbers --id <snapshot_id>
```

A snapshot captures the full state of a list's database at a point in time. Snapshots are cheap (local, copy-on-write where possible) and named with a label the operator can recognize.

### When They Get Taken

- Automatically before config changes that remove enrichment steps or sequences
- Automatically before bulk operations over N records (threshold configurable)
- On demand by the agent before any run the operator flags as experimental

### Restore

`snapshot restore` rolls the list back to the snapshot's state. Records are restored, enrichment outputs are restored, sequence state is restored. Anything that happened after the snapshot is gone.

Restore is destructive in its own right — the agent confirms with the operator before running it and surfaces what will be lost (records added, touches sent, replies received since the snapshot).

### What Snapshots Don't Cover

- External state — emails already sent, mail already dispatched, calendar events already created. Those live in Gmail, Lob, Google Calendar. Rolling back a snapshot doesn't unsend anything.
- CRM state — the operator's CRM has its own history; restoring a list snapshot doesn't modify the CRM.
- Global suppression list — suppression is cross-list and never rolled back by a single-list snapshot.

Snapshots protect local execution state, not the world.

## Per-Record Revert

For surgical rollback without touching the whole list:

```
agent-outbound record revert boise-plumbers <row_id> --step hiring-check
agent-outbound record revert-score boise-plumbers <row_id>
agent-outbound record revert-sequence boise-plumbers <row_id> --to-step 1
```

Reverting a step clears that step's outputs on one record and marks it stale so the next enrichment run will recompute. Reverting a score clears the current fit/trigger scores and queues a re-score. Reverting a sequence resets the step cursor (without unsending anything already sent externally).

Per-record revert is the right tool when the operator says *"Beacon Plumbing's hiring data is wrong, re-do it"* — the agent clears that one record's hiring step and re-runs enrichment scoped to it.

## Idempotency

The agent retries commands when the underlying network, LLM, or tool call fails transiently. Every mutating command accepts an idempotency key so retries don't double-execute:

```
agent-outbound launch send boise-plumbers --top 50 --idem-key 2026-04-21-launch-top50
agent-outbound enrich boise-plumbers --step hiring-check --idem-key 2026-04-21-hiring-refresh
```

On replay with the same key, the tool returns the prior result with `already_done: true` instead of re-executing. The agent generates idempotency keys deterministically from the operator's request so that the same request on the same day is recognized as a retry.

Outreach sends (email, mail, SMS) have their own idempotency path — a send that fails mid-dispatch is tracked so it doesn't duplicate when the agent retries. Enrichment and scoring rely on per-record staleness so re-runs naturally deduplicate by skipping unchanged records; the idempotency key exists for the run-level wrapper.

## Validation Before Commit

For config changes, the tool offers a standalone validation pass:

```
agent-outbound config validate boise-plumbers
agent-outbound config validate boise-plumbers --file ./proposed.yaml
```

Runs schema validation, checks that every referenced toolkit is connected in Composio, checks that declared outputs don't collide across steps, checks that scoring descriptions are non-empty. Returns a structured report of errors and warnings. Nothing is written.

```
agent-outbound config diff boise-plumbers --file ./proposed.yaml
agent-outbound config diff boise-plumbers --from-snapshot <snapshot_id>
```

Produces a structured diff between the current config and a proposed change (or between the current config and a snapshot's config). The agent uses diff to explain changes to the operator before `config update`.

## What the Operator Sees

The operator asks:

> "Re-run the whole enrichment."
> "Launch the top 100."
> "Swap the hiring step to use a different tool."

The agent, using these primitives, responds:

> "That'll hit 247 records and cost about $14 in AI. Want me to run it on 10 first to sanity-check?"
> "Before I launch, I'll snapshot the list so we can roll back if the drafts look off."
> "The new config removes the old hiring step and replaces it with a Apollo-backed one — here's the diff. Should I apply it?"

The operator never has to know the commands. They get the safety by default because the agent uses it.

## What Safety Isn't

- **Not automatic approvals.** The tool doesn't decide which actions need operator sign-off. The agent makes that call and surfaces drafts / previews when appropriate.
- **Not a test environment.** Sample and dry-run happen against the real list's data. There's no staging copy.
- **Not a replacement for the audit log.** Suppression changes, opt-outs, forget operations all write to the append-only compliance log regardless of snapshots. See [Compliance](./compliance.md).
- **Not a full time machine.** Snapshots are point-in-time captures the operator opts into. They're not a continuous undo history.
- **Not a guarantee against external side effects.** Anything sent out of the tool (emails, mail, SMS, CRM writes) cannot be recalled by any command here.
