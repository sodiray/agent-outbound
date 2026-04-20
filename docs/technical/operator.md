# Daily Operator Dashboard (Technical)

Implementation of `/outbound what do I need to do today?` and related queries. For the user-facing description, see `../product/operator.md`.

## Data Sources

The dashboard is a read-only composition over the canonical store and the recent activity log. Each section maps to a specific query:

| Section | Source |
|---|---|
| Replies | `detect-replies` output (Gmail triggers or polling); records where `email_last_reply_at IN last 24h` and `email_reply_classification != null` |
| Today's route | Records where `visit_scheduled_date = today`, ordered by `visit_route_position` |
| Calls | Records where the current sequence step is `call` and `next_action_date <= today` and `sequence_status = active` |
| Follow-up emails | Records where the current sequence step is `email` with `sequence_status = active` and `email_last_draft_id` set (drafted, not sent) |
| Mail landing | Records where `mail_last_expected_delivery = today` OR `mail_last_delivered_at IN last 24h` |
| Deferred | Records whose due step evaluated `defer` in the last sequence run |
| Bounces / opt-outs | Records where `suppressed_at IN last 24h` |
| Pipeline | `sequence_status` distribution per list, aggregated |
| Alerts | Inventory counts from channel config; cap tracking from channel event log; rolling bounce/verification rates from `.outbound/costs.jsonl` and `detect-replies` history; Composio auth health verified via MCP `tools/list` at CLI startup |

## Implementation

The dashboard runs as a synchronous `agent-outbound dashboard` command that:

1. Loads each configured list's `outbound.yaml`
2. Opens each list's canonical store (read-only)
3. Tails each list's `.outbound/.activity/history.jsonl` for the past 24h
4. Queries Composio for connection status if `--alerts` is passed
5. Formats output (human by default, JSON with `--format json`)

No LLM calls on the happy path — the dashboard is deterministic queries. LLM calls happen only for inspection commands like `/outbound why did X score low on fit?`, which invoke a `generateText` call with the record's state and scoring breakdowns as context.

## Commands

Read commands compose into the dashboard or scoped variants:

```
agent-outbound dashboard [--list <list>] [--all-lists] [--section replies,route,calls] [--format json]
agent-outbound dashboard --alerts
```

Write commands (`log`, `suppress`, `forget`, `pause`, `resume`) directly mutate the canonical store and trigger relevant downstream operations (CRM sync, suppression list append, compliance log append).

## Inputs / Outputs

**Inputs:**
- Canonical store — all active lists
- Recent activity log (`.outbound/.activity/history.jsonl` per list)
- Channel configs (for caps and limits)
- Composio (for connection status)

**Outputs:**
- Formatted dashboard (stdout)
- Optional Slack digest via `SLACK_POST_MESSAGE` if Slack is connected and configured
