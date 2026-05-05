# Sequencing (Technical)

The sequence engine is a state machine that advances records through configured steps based on day offsets, agent-evaluated conditions, and reply/bounce events. Every step invokes a channel-specific executor via `execute-step`; cross-channel conditions are natural language descriptions evaluated by the agent against the record's full state.

For the user-facing description, see `../product/sequencing.md`.

## State Machine

### Per-record state

| Column | Values |
|---|---|
| `sequence_status` | `idle`, `active`, `engaged`, `completed`, `opted_out`, `bounced`, `suppressed` |
| `sequence_step` | `0` (not started), `1`, `2`, ... |
| `sequence_step_attempts` | retry counter for the current step |
| `next_action_date` | ISO date when the current step is due |
| `last_outreach_date` | ISO date of last outreach across any channel |
| `launched_at` | ISO date when step 1 fired |

### Status transitions

```
idle → active                    on: step 1 executed successfully
active → engaged                 on: positive reply detected on any channel
active → completed               on: all steps exhausted
active → opted_out               on: operator logs opt-out OR unsubscribe/STOP received
active → bounced                 on: hard bounce OR return-to-sender mail
active → suppressed              on: entry added to suppression list
engaged → (operator decides)     replies pause; operator advances manually
```

### Timing

`day` is relative to `launched_at` (step 1). `day: 0` is launch day. The orchestrator calculates `next_action_date` from `launched_at` and the step's `day` offset (calendar days, not business days).

After the raw date is computed, the sequence's **working-days filter** is applied:

- If the scheduled date lands on a day in `sequences.<name>.working_days`, use it as-is.
- Otherwise apply `non_working_day_policy`:
  - `shift_forward` (default) → advance `next_action_date` to the next working day.
  - `skip` → mark the step skipped; advance `sequence_step` without execution.

The filter is applied per-step at scheduling time. Shifting one step does not cascade to later steps — each step's `next_action_date` is computed from `launched_at + day` and filtered independently. This keeps the overall cadence anchored to launch.

Defaults: if `working_days` is unset, all seven days are allowed. If `non_working_day_policy` is unset, `shift_forward` is applied. Day names are lowercase three-letter abbreviations: `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun`.

For the product-level description, see `../product/sequencing.md#working-days`.

## Step Execution

Steps are generic — there is no step-type enum. Each step has a natural language description, and the agent determines what kind of work is required by reading the description and using whatever tools are pinned in the step's config.

The orchestrator's role is to advance the state machine, check suppression flags, and invoke the agent with the step's description and tools. The agent handles execution.

For steps the agent classifies as involving physical visits, the orchestrator batches them geographically and invokes route planning before execution. This classification happens as a lightweight structured-output call before the main execution pass.

## Cross-Channel Conditions

A step's `condition` is a natural-language description of when the step should execute. The agent reads the record's current state (all columns, including cross-channel state like delivery tracking, reply status, and visit outcomes) and evaluates whether the condition is met.

```yaml
sequence:
  steps:
    - action: email
      day: 0
      description: initial outreach
      config: { ... }

    - action: mail
      day: 2
      description: postcard reinforcing the email
      condition: >-
        The initial email was sent successfully and hasn't bounced.
      config: { ... }

    - action: visit
      day: 5
      description: drop by in person
      condition: >-
        The postcard has been delivered (not just dispatched) and we
        haven't received a reply on any channel yet. The business is
        not flagged as do-not-visit.
      defer: >-
        If the postcard is still in transit, wait up to 5 days for
        delivery confirmation. If it still hasn't arrived, skip this step.
      config: { ... }
```

Three outcomes:

1. **Pass** — step executes
2. **Fail (skip)** — step is skipped; record advances to the next step's timing
3. **Defer** — the agent determines the condition could become true later. The `defer` field (also natural language) describes how long to wait and what to do on timeout.

The agent can reason about nuance that field checks miss — distinguishing an auto-responder from a real reply, recognizing that "delivered" with a return-to-sender flag isn't truly delivered, or understanding that a reply on SMS counts even though the condition was written about email.

## Suppression & Consent Flags

Record-level flags are checked deterministically before any step executes — these are hard stops that don't require agent evaluation:

- `suppressed = true` → no outreach of any kind
- `dne_email = true` → the agent skips any step involving email
- `dnc_phone = true` → the agent skips any step involving phone or SMS
- `dnk_visit = true` → the agent skips any step involving an in-person visit

The orchestrator checks these flags before invoking the agent for condition evaluation or step execution. If a flag applies (based on a lightweight classification of the step's description), the step is skipped without an LLM call.

## Launch (Step 1)

Launch is step 1 of the sequence. It is not a separate phase — it's the entry point.

For email step 1, launch is two-stage:
1. **Draft creation** — orchestrator calls `execute-step` for each selected record → AI SDK call with `GMAIL_CREATE_DRAFT` creates drafts → orchestrator stores draft IDs
2. **Send** — operator reviews drafts, then triggers send → orchestrator calls `execute-step` to send each draft → stores message and thread IDs, initializes sequence state

For non-email step-1 actions, the flow is single-stage: the orchestrator executes directly with operator confirmation.

Launch writes: `email_last_draft_id`, `email_last_sent_at`, `email_thread_id`, `sequence_step = 1`, `sequence_status = active`, `next_action_date`, `launched_at`.

## Daily Sequencer Run

1. Poll for replies (`detect-replies` — `GMAIL_LIST_MESSAGES` filtered `since:<last-check>`, dedup against tracked threads)
2. Update status for records with replies
3. Poll delivery state for outstanding mail and SMS (`LOB_GET_POSTCARD`, `TELNYX_GET_MESSAGE_STATUS`)
4. Find records with due actions
5. For each due record:
   a. Check suppression and consent flags (deterministic — suppressed, DNE, DNC, DNK)
   b. Agent evaluates the step's natural-language `condition` against record state
   c. Execute, defer, or skip based on the agent's judgment
6. Classify due steps that involve physical visits (lightweight structured-output call), batch them geographically, invoke route planning, write visit schedule
7. Advance `sequence_step` and `next_action_date` on success

The sequencer can run:
- On demand: `agent-outbound sequence run <list>`
- Scheduled: a cron or background watcher (out of scope of the CLI itself)
- From `serve`: the internal scheduler runs `detect-replies` + delivery polling at `watch.poll_replies_minutes` / `watch.poll_delivery_minutes` cadence

## Multiple Sequences per List

```yaml
sequences:
  default:
    steps: [ ... ]
  re_engage:
    steps: [ ... ]
    start_when: >-
      The record completed the default sequence without engagement,
      but its trigger score has since rebounded above 60 — suggesting
      new timing signals worth acting on.
```

The sequencer assigns records to sequences. Records carry `sequence_name`. Switching sequences is explicit and resets `sequence_step`. The `start_when` field is agent-evaluated against the record's current state.

## Config Shape

```yaml
sequences:
  default:
    working_days: [mon, tue, wed, thu, fri, sat]
    non_working_day_policy: shift_forward
    steps:
      - day: 0
        description: >-
          Send an initial outreach email to the primary contact.
        config:
          tool:
            toolkits: [GMAIL]
            tools: [GMAIL_SEND_EMAIL]

      - day: 2
        description: >-
          Send a branded postcard via Lob reinforcing the email.
        condition: >-
          No reply has been received on any channel since the initial email.
        config:
          tool:
            toolkits: [LOB]
            tools: [LOB_SEND_POSTCARD]

      - day: 5
        description: >-
          Drop by in person with the flyer at ./assets/flyer.pdf.
        condition: >-
          The postcard has been delivered (confirmed, not just dispatched),
          no reply on any channel, and the business is not flagged do-not-visit.
        defer: >-
          If the postcard is in transit, wait up to 5 days for delivery
          confirmation. If still not delivered after 5 days, skip this step.
        config:
          disposition_options: [talked_to_owner, talked_to_staff, left_card, left_flyer, closed, come_back, not_a_fit]

      - day: 7
        description: >-
          Follow-up email referencing the visit. If the visit happened,
          mention it. If it was skipped, send a standard follow-up.
        condition: >-
          No reply has been received on any channel.
        config:
          tool:
            toolkits: [GMAIL]
            tools: [GMAIL_SEND_EMAIL]

    on_reply: pause
    on_bounce: stop
    on_opt_out: stop

  re_engage:
    start_when: >-
      The record completed the default sequence without engagement,
      but its trigger score has since rebounded above 70.
    steps: [ ... ]
```

Steps have no `action` type field — the agent reads the `description` to determine what kind of work is required. Conditions, `defer`, and `start_when` are natural language, evaluated by the agent against the record's full state. Day offsets, `on_reply`/`on_bounce`/`on_opt_out`, and tool config remain structured — those are operational mechanics, not judgment calls.

File references in step descriptions (e.g., `./assets/flyer.pdf`) are relative to the list directory.

## Inputs / Outputs

**Inputs:**
- `outbound.yaml` → `sequences.*`
- Canonical store — record data + state columns
- Channel configs (`channels.*`) for per-channel settings

**Outputs:**
- Canonical store — updated sequence state, channel-specific state columns
- Gmail drafts / mail pieces / calendar events — via Composio tool executions
