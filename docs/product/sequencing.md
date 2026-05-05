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

### Branching on Structured Signals

Conditions are natural language, but the tool surfaces structured signals the condition can reference deterministically. The common ones:

- **Disposition** — the logged outcome of the previous step, as a typed enum (see [Record Model](./record-model.md#disposition)). Values like `talked_to_owner`, `gatekeeper`, `not_a_fit`, `booked_meeting`, `left_flyer`.
- **Reply classification** — the tool's classification of the most recent reply. Values like `booking_intent`, `question`, `objection`, `hard_no`, `positive_signal`, `out_of_office`, `bounce` (see [Deliverability](./deliverability.md#reply-detection)).
- **Channel delivery state** — mail `delivered` / `returned`, email `bounced` / `replied`, visit `completed`.

A condition can reference any of these by name, and the agent evaluates them against the record's structured state. This keeps sequence branching precise where precision matters (exact disposition, exact reply category) while leaving room for judgment when a condition is genuinely nuanced.

A common pattern: different next steps depending on the reply classification:

```
day 3: "follow up on the intro email"
  if reply_classification == booking_intent  → skip (sequence already paused by reply)
  if reply_classification == question         → branch to answer sequence
  if reply_classification == objection        → branch to nurture sequence
  if reply_classification == hard_no          → stop
  otherwise                                    → send follow-up
```

The operator describes these branches in plain English when authoring the sequence; the config records them as structured rules the sequencer evaluates without re-asking the LLM each time.

## Working Days

Day offsets are **calendar days** from launch. But real outbound doesn't run every day — an in-person visit on Sunday is useless, and most SMBs don't process mail or email on weekends. The sequence's `working_days` list declares which days of the week the sequence is allowed to act on; a `non_working_day_policy` declares what to do when a step's scheduled date lands on a non-working day.

```yaml
sequences:
  default:
    working_days: [mon, tue, wed, thu, fri, sat]   # Sunday excluded
    non_working_day_policy: shift_forward          # or: skip
    steps:
      - day: 0
        description: Send initial outreach email.
      - day: 2
        description: Drop by in person with the flyer.
```

If a record launches on Friday, day 2 lands on Sunday. With `shift_forward` (the default), the step is rescheduled to Monday. The day offset of every later step is still calculated from `launched_at`, not from the shifted date — so shifting one step forward doesn't cascade into shifting the rest of the sequence. Only steps that themselves land on non-working days get shifted.

| Policy | Behavior |
|---|---|
| `shift_forward` | Move the step to the next working day. Default. |
| `skip` | Drop the step entirely. Record advances to the next step's timing. |

**Defaults.** If `working_days` is not set, the sequence runs every day of the week. If `non_working_day_policy` is not set, `shift_forward` is assumed. Operators can describe working days in plain English when authoring a sequence — "no Sundays," "weekdays only" — and the tool writes the config.

**Why it's sequence-level.** Different sequences in the same list can have different norms: a main outreach sequence might exclude Sunday, a re-engage sequence might run weekdays only, a follow-up sequence might allow any day. The policy is attached to the sequence, not the list.

**Per-step override (future).** Some steps naturally don't care about working days — a scheduled automated email landing on Sunday is fine, while a visit isn't. A per-step override can be added when the pattern emerges; until then, a sequence's `working_days` applies to every step in it.

Holiday calendars (Thanksgiving, Christmas, local observances) are not yet modeled. Until they are, the operator pauses the sequence manually on holidays or sets `next_action_date` forward on affected records.

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

1. **Drafts** are created and enter a `pending_approval` queue
2. The operator reviews drafts, then triggers send — individually or in bulk

When step 1 involves other kinds of work, the flow is single-stage with operator confirmation.

```
/outbound launch boise-plumbers on the top 50 by priority
/outbound review drafts
/outbound send them
```

Once launched, the sequence state machine takes over.

### Draft Approval Queue

Every draft the tool generates — whether for a launch send, a follow-up, or any step that requires human review — lands in a `pending_approval` queue. The scheduler only dispatches drafts marked `ready`.

The agent reads the queue, surfaces drafts to the operator, and applies approvals:

```
agent-outbound drafts list boise-plumbers
agent-outbound drafts list boise-plumbers --step 1 --status pending_approval
agent-outbound drafts show boise-plumbers --id <draft_id>
agent-outbound drafts approve boise-plumbers --id <draft_id>
agent-outbound drafts approve boise-plumbers --all --where "fit_score >= 70"
agent-outbound drafts reject boise-plumbers --id <draft_id> --reason "wrong persona"
agent-outbound drafts edit boise-plumbers --id <draft_id> --body "..." --subject "..."
```

From the operator's perspective, they ask: *"Review the first batch of drafts."* The agent reads `drafts list`, walks through them with the operator (or summarizes them), applies approvals and edits, and reports back. The scheduler picks up `ready` drafts on the next tick.

Drafts stay in the queue until explicitly approved, rejected, or superseded by a sequence change. A rejected draft doesn't advance the record's sequence cursor — the record stays at that step until a new draft is approved.

## Templates and Variables

Steps reference **templates** rather than being pure natural-language prose. A template is a named, reusable message body with explicit variables. Each step in a sequence declares which template it uses and what data to merge:

```yaml
templates:
  intro_email_v1:
    channel_hint: email
    subject: "Quick thought for {{business_name}}"
    body: |
      Hey {{primary_contact.first_name}} — saw {{hook}} and had a quick
      thought about {{angle}}.
      ...
    variables:
      hook: "from website-scrape.recent_news or hiring-check.hiring_summary"
      angle: "selected by the agent from the record's workflow tags"

sequences:
  default:
    steps:
      - day: 0
        template: intro_email_v1
        description: "Send the intro email using the owner-operator variant"
```

Template benefits:

- **Version-pinned content.** A template has an ID; edits produce a new version; steps reference a specific version. If a template change regresses reply rates, the operator can roll the sequence back to the prior version without rewriting the config.
- **Deterministic substitution.** Variables are resolved from the record's enrichment fields (or computed at run time). The agent doesn't re-improvise the body every send — it only picks variable values for variables that require judgment.
- **A/B testing.** A step can reference `template: [intro_email_v1, intro_email_v2]` and the scheduler splits traffic. Results roll up under the template ID.
- **Cross-sequence reuse.** The same template can appear in a default sequence and a re-engage sequence.

Templates can reference assets on disk (a PDF flyer, an image, a Markdown block) when the channel needs them. For mail, a template maps to a Lob / PostGrid template ID plus the merge data. For visits, a template is the brief the operator sees at the stop.

Authoring a template is an operator command the agent runs:

```
/outbound create a template called intro_email_v1 for plumbing owner-operators
/outbound update the intro_email_v1 template — soften the opener
/outbound list templates for boise-plumbers
```

Legacy steps that use prose descriptions instead of templates still work — the agent interprets the description at execution time. Templates are the preferred path for any step that sends volume.

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
