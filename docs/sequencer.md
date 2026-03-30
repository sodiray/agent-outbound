# Sequence

## Purpose

Define and execute a multi-step outreach cadence. The sequence is what happens after enrichment: which actions to take, when, and under what conditions.

Sequence lives in `outbound.yaml` under `sequence:`. Step 1 is "launch" (the initial outreach action). Steps 2+ are follow-ups with configurable timing and per-step conditions.

## State Machine

The orchestrator owns the sequence state machine. All state is stored in the canonical CSV.

### Per-Row State

| Column | Values | Description |
|--------|--------|-------------|
| `sequence_status` | `active`, `engaged`, `completed`, `opted_out`, `bounced` | Current lifecycle state |
| `sequence_step` | `1`, `2`, `3`, ... | Which step the row is on |
| `next_action_date` | ISO date | When the next step is due |
| `last_outreach_date` | ISO date | When the last outreach was performed |
| `thread_id` | string | Thread ID for email threading (if applicable) |

### Status Transitions

```
(not launched) → active         on: step 1 executed
active → engaged                on: reply detected
active → completed              on: all steps exhausted
active → opted_out              on: operator logs opt-out
active → bounced                on: bounce detected
engaged → (operator decides)    replies pause the sequence
```

### Timing

`day` is always relative to launch (step 1). `day: 0` is launch day. The orchestrator calculates `next_action_date` from the launch date and the step's `day` offset.

## Step Types

The sequence config declares step types. The orchestrator uses the type to determine what kind of work to request, but the actual execution is always delegated to the LLM via `execute-step`.

### `email`

The LLM creates a draft, applies labels, sends — using whatever MCP tools were referenced in the config at authoring time. Could be Gmail, could be Outlook, could be any email service the user connected.

For step 1 (launch): creates drafts for operator review. Operator approves, then the orchestrator triggers sends.

For follow-up steps: the LLM creates the email as a reply in the same thread (using the stored `thread_id` or equivalent).

### `call`

Semi-manual. The orchestrator produces a call list with contact info. The operator makes the calls and logs outcomes via `/outreach`.

### `manual`

Fully manual. The orchestrator produces a to-do list. The operator does the work and logs outcomes.

## Conditions

Steps can include a `condition` (human-readable) and a compiled `config.condition` (structured check). The orchestrator calls `evaluate-condition` before executing a step. If the condition fails, the row skips this step and advances to the next step's timing.

## Launch (Step 1)

Launch is executing step 1 of the sequence. It is not a separate phase — it's the entry point into the sequence.

Launch has a two-stage flow:
1. **Draft creation:** orchestrator calls `execute-step` for each selected row → LLM creates drafts via connected MCP tools → orchestrator stores draft IDs in CSV
2. **Send:** operator reviews drafts, then triggers send → orchestrator calls `execute-step` to send each draft → stores thread IDs, initializes sequence state

Launch writes to CSV: `draft_id`, `draft_status`, `thread_id`, `sequence_step = 1`, `sequence_status = active`, `next_action_date`.

## Daily Sequencer Run

When the sequencer runs, it:
1. Checks for replies (calls `execute-step` with reply-detection config)
2. Updates status for rows with replies (`active → engaged`, pause sequence)
3. Finds rows with due actions (`next_action_date <= today` and `sequence_status = active`)
4. For email steps: creates follow-up drafts (via `execute-step`), operator reviews, then sends
5. For call/manual steps: produces action lists for the operator
6. Advances `sequence_step` and `next_action_date` after each step completes

## Config Shape

```yaml
sequence:
  steps:
    - action: email
      day: 0
      description: initial outreach email
      config:
        subject: { from_column: reviewed_email_subject }
        body: { from_column: reviewed_email_body }
        recipient: { from_column: contact_email }
        # ... tool references for draft/send/label

    - action: call
      day: 3
      description: phone follow-up
      config:
        phone: { from_column: phone }
        contact_name: { from_column: contact_name }

    - action: email
      day: 7
      description: follow-up bump
      config:
        body:
          template: "Hey {{first_name}}, just bumping this up..."
        template_args:
          first_name: { from_column: first_name }
        recipient: { from_column: contact_email }

  on_reply: pause
  on_bounce: pause
```

## Inputs / Outputs

**Inputs:**
- `outbound.yaml` → `sequence.steps` with nested `config`
- `@internal/prospects.csv` — row data + sequence state columns

**Outputs:**
- `@internal/prospects.csv` — updated sequence state, draft IDs, thread IDs, send timestamps
