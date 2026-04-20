# Sequencing

A **sequence** is a coordinated series of outreach steps, timed against each record's launch date. The sequence is what turns a list of scored leads into an executed motion.

This is the piece that makes the tool more than a Clay clone. Most outbound tools can express "email day 0, email day 3, email day 7." This tool expresses:

> Email day 0. Drop a Lob postcard day 2. Visit in person day 5 — **but only if the postcard has been delivered, no reply has been received, and the record isn't suppressed**. SMS day 7 if still silent. Operator-logged call day 10 if all of the above.

Cross-channel dependencies are what let physical touches land *with* digital ones instead of in parallel silos.

## Steps Are Generic

A step is a natural language description of work the agent should do, plus a day offset and optional condition. There are no hardcoded step types — no `email`, `mail`, `visit`, `sms` enum. The agent reads the description and figures out what kind of work it is, which tools to use, and how to execute it.

This means a step can be anything: send an email, dispatch a Lob postcard, drop a flyer in person, post a LinkedIn connection request, send a WhatsApp message, create a task in Asana, or anything else the operator can describe and the agent has tools for. New channels don't require new step types — just a new step description and the right tool connections.

A step's description can reference files on disk (relative to the list directory): a PDF flyer, a Photoshop design, a Markdown template, an image. It can also reference external platforms, template IDs, or URLs. The agent interprets these references contextually.

Every step carries a day offset from launch, an optional condition, and optional tool configuration.

## Cross-Step Conditions

A step's condition describes, in natural language, when the step should execute — including state from previous steps on any channel. The agent reads the record's current state and evaluates whether the condition is met. This is the primary mechanism for coordination.

Example:

```
day 0: "send initial outreach email"
day 2: "send a Lob postcard reinforcing the email"
day 5: "visit in person" — condition: "only if the postcard has been delivered and we haven't received a reply yet"
day 7: "follow-up email referencing the visit" — condition: "only if the visit happened and there's still been no reply on any channel"
```

Conditions are agent-evaluated and can have one of three outcomes:

1. **Pass** — step executes on schedule
2. **Fail (skip)** — step is skipped; the record advances to the next step's timing
3. **Defer** — the agent determines the condition could become true later (e.g., mail is in transit). Defer behavior is described per step: "wait up to 5 days for delivery confirmation, then skip."

Because conditions are natural language, the agent can reason about nuance that field checks miss — "mail shows delivered but was returned to sender" or "reply received but it was an auto-responder, not a real engagement."

## Lifecycle per Record

Every record in a sequence moves through states:

| State | What it means |
|---|---|
| `idle` | Not yet launched |
| `active` | Launched; sequence is progressing |
| `engaged` | A positive reply landed; sequence paused |
| `completed` | All steps exhausted without engagement |
| `opted_out` | Operator logged opt-out, or STOP/unsubscribe received |
| `bounced` | Hard email bounce or returned mail |
| `suppressed` | On the suppression list (globally or per-channel) |

Automatic transitions happen on reply, bounce, or suppression-list hit. Operator can force transitions via `/outbound log`.

## Launch

Launch is executing step 1 of the sequence. When step 1 involves email (the common case), it's a two-stage flow:

1. **Drafts** are created in the operator's Gmail/Outlook
2. The operator reviews drafts, then triggers send — individually or in bulk

When step 1 involves other kinds of work, the flow is single-stage with operator confirmation.

```
/outbound launch boise-plumbers on the top 50 by priority
/outbound review drafts
/outbound send them
```

Once launched, the sequence state machine takes over.

## Daily Sequencer Run

Every time the sequencer runs (on demand, on a cron, or from a long-running `serve` scheduler), it:

1. **Detects replies** across active threads and classifies them
2. **Detects bounces** and delivery updates (mail returns, delivery confirmations)
3. **Finds records with due actions** (`next_action_date ≤ today`)
4. **Checks suppression and consent flags**
5. **Evaluates each step's condition**
6. **Executes, defers, or skips** per the outcome
7. **Batches visit-type steps** into the day's route if any are due (the agent classifies which due steps involve physical visits)
8. **Advances state** on success

The daily run produces the operator's dashboard: what replied, what needs attention, what to visit, which follow-ups are ready.

## Suppression & Consent Flags

Regardless of sequence configuration, the tool enforces record-level flags before any step executes. The agent reads these flags as part of evaluating whether a step should proceed:

- `suppressed = true` → no outreach of any kind
- `dne_email = true` → the agent skips any step that would involve email
- `dnc_phone = true` → the agent skips any step that would involve phone or SMS
- `dnk_visit = true` → the agent skips any step that would involve an in-person visit

These flags are set automatically (bounces, STOP replies, returned mail) or manually by the operator. They act as hard stops that override the step's condition — even if the condition would pass, a suppression flag prevents execution.

See [Compliance](./compliance.md).

## Multiple Sequences per List

A list can run more than one sequence in parallel or sequentially:

- **Default** — the main outreach motion
- **Re-engage** — records that completed the default without engagement but whose trigger score rebounded
- **Event-driven** — records hitting a specific trigger signal (e.g., "recently expanded") get a specialized sequence

Each record carries which sequence it's in. Switching sequences is explicit and resets the step cursor.

## Authoring a Sequence

```
/outbound add a sequence: email day 0, Lob postcard day 2, visit day 5 if postcard delivered, bump email day 7 if no reply
```

The tool writes the full sequence configuration — step descriptions, day offsets, natural-language conditions, and tool references. The operator describes what they want in plain English; the agent authors the config and evaluates conditions against record state at execution time.

Because steps are generic, the operator can describe anything: "send a handwritten note via Handwrytten," "post a LinkedIn connection request with a personalized note," "drop off the flyer at `./assets/flyer.pdf` during an in-person visit." If the agent has the right tools connected, it can execute it.

## What Sequencing Does Not Own

- Does not create CRM records — that happens at launch via [CRM](./crm.md) sync.
- Does not manage the operator's inbox — replies land in Gmail; the tool reads them.
- Does not enforce quotas on the operator's behalf — the operator paces themselves for calls and visits; the tool caps daily visit capacity and email-inbox caps.
- Does not re-send completed sequences automatically — the operator explicitly starts a re-engage sequence.
