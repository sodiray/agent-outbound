# Deliverability (Technical)

Email sending, verification, bounce handling, reply detection, and threading. Implementations of the `email` step type and the associated channel gates.

For the user-facing description, see `../product/deliverability.md`.

## Sending Configurations

### Direct Gmail / Outlook

```yaml
channels:
  email:
    sender: gmail
    inboxes:
      - toolkit_auth_id: gmail_ray_secondary_1
        daily_cap: 40
      - toolkit_auth_id: gmail_ray_secondary_2
        daily_cap: 40
    rotation_strategy: round_robin    # or "least_used_today"
```

The orchestrator picks the sending inbox per record based on strategy; writes the chosen inbox to `email_inbox_used` so subsequent threaded follow-ups route to the same one.

### Instantly

```yaml
channels:
  email:
    sender: instantly
    instantly_campaign_id: "cmp_123"
    daily_cap_per_campaign: 200
    per_inbox_cap: 30
```

Instantly handles rotation + warmup. The orchestrator hands Instantly a list of recipients and a template (or per-record merge fields); Instantly picks the sending inbox and throttles.

## Pre-Send Verification

### Verification step

```yaml
enrich:
  - description: verify email deliverability
    depends_on: [contact_email]
    config:
      tool: { toolkits: [NEVERBOUNCE], tools: [NEVERBOUNCE_VERIFY] }
      args:
        email: { from_column: contact_email }
      outputs:
        email_verification_status:
          type: string
          enum: [valid, invalid, risky, unknown]
          description: Deliverability verdict from the verification service
        email_verification_confidence:
          type: number
          description: Confidence score from the verifier (0–1)
      cache: 60d
      model: anthropic/claude-haiku-4-5-20251001
```

### Channel gate

```yaml
channels:
  email:
    verification:
      required: true
      gate_statuses: ["invalid", "risky", "unknown"]
      on_gate_fail: skip        # "skip", "suppress", or "retry_verify"
```

- `valid` → proceed
- `invalid` → skip and mark `suppressed = true`, `suppressed_reason = verification_failed`
- `risky` / `unknown` → skip (configurable)
- verification missing → skip step (queued for the next verification run)

## Thread Management

The orchestrator stores `email_thread_id` from the send response and passes it on subsequent sends. Gmail, Outlook, and Instantly all support threading via this ID.

If the thread ID is lost (rare), the follow-up is sent as a new thread with a `Re: {original_subject}` subject. Not ideal, but functional.

## Bounce Classification

`detect-replies` classifies on every send:

- **Hard bounce** → `email_bounce_type = hard`, `bounced` state, suppression added
- **Soft bounce** → `email_bounce_type = soft`, retry once, soft-suppress after
- **Auto-reply** → classified `auto`; sequence continues
- **Spam-trap hit** → hard-suppress immediately, operator alert

Classification runs via `detect-replies` on the response channel (bounce notifications arrive as emails in the sender inbox).

## Reply Detection

Polling only. Consumer MCP does not expose triggers, and this tool does not listen for webhooks.

During every `sequence run`, `detect-replies` invokes the pinned inbox-listing tool (e.g. `GMAIL_LIST_MESSAGES`) filtered on `after:<last_check>`, dedups against tracked thread IDs, and writes `channel_events` rows for matches. Each match is handed to `classify-reply`.

Polling cadence is controlled by how often `sequence run` fires:

- Manual/one-shot: `agent-outbound sequence run <list>`
- Cron: operator schedules it (every 5–15 min during active campaigns)
- `serve` mode: internal scheduler runs the reply-detection pass at `watch.poll_replies_minutes` (default 5)

Lag between a reply arriving in Gmail and the sequence advancing equals the poll interval. Tune `poll_replies_minutes` down (e.g. 2–3) during hot campaigns; up (15–30) during maintenance.

## Reply Classification

`generateObject` call at the evaluation tier (resolved from `ai.defaults.evaluation`):

```ts
const { built } = resolveModel(step.config.model, 'evaluation', aiConfig);
const classification = await generateObject({
  model: built,
  schema: z.object({
    classification: z.enum(["positive", "negative", "ooo", "auto", "bounce"]),
    reason: z.string(),
  }),
  prompt: `Classify this email reply: ${replyBody}`,
});
```

State transitions:
- Positive → `sequence_status = engaged`, pause sequence, alert operator
- Negative with unsubscribe → `opted_out`; else `engaged`, pause
- OOO/auto → no state change
- Bounce → `bounced` handling above

## Unsubscribe / CAN-SPAM

```yaml
channels:
  email:
    footer:
      unsubscribe_url: "https://example.com/unsub?token={{unsub_token}}"
      physical_address: "123 Main St, Boise, ID 83702"
      template: |
        —
        Not interested? Reply STOP or unsubscribe: {{unsubscribe_url}}
        {{physical_address}}
```

The orchestrator renders merge fields; the LLM is instructed to preserve the footer verbatim. Step validation requires both an unsubscribe URL and physical address to be present before any `email` step will execute.

When a recipient clicks unsubscribe (or replies STOP/UNSUBSCRIBE), the record moves to `opted_out` and is added to suppression.

## Sending Windows

```yaml
channels:
  email:
    send_hours: [08:00, 17:00]
    send_days: [mon, tue, wed, thu, fri]
    recipient_timezone_aware: true
```

With `recipient_timezone_aware`, the tool infers the recipient's timezone from address and sends within their business hours. Requires `city`/`state` populated.

## Idempotency

Email sends are destructive. Step config wraps with idempotency markers:

```yaml
config:
  idempotency:
    key_source: [_row_id, sequence_step]
    scope: list
```

Before the send, a `pending` marker is written to the record. On success, replaced with `sent:<message_id>`. Retries reuse the stored message ID.

## Monitoring

The daily operator dashboard surfaces:
- Sends today (per inbox or campaign)
- Bounce rate (rolling 7d)
- Reply rate (rolling 7d)
- Verification skip rate (rolling 7d)
- Any inbox close to its daily cap

Abnormal metrics (bounce > 5%, reply rate crashing) trigger an operator alert.

## Inputs / Outputs

**Inputs:**
- `outbound.yaml` → `channels.email` and `channels.email.verification`
- Canonical store — records with `contact_email`, `email_verification_status`
- Composio-connected Gmail/Outlook/Instantly accounts

**Outputs:**
- Sent emails (via provider)
- Canonical store — `email_*` columns updated on send, reply, bounce
- Suppression updates on bounces/opt-outs
