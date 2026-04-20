# Physical Mail (Technical)

Mail steps dispatch physical pieces through Composio mail toolkits (Lob, PostGrid, Postalytics, Handwrytten) and track delivery via polling. Delivery state is a column on the record; downstream steps gate on it.

For the user-facing description, see `../product/mail.md`.

## Step Lifecycle States

Written to the record via `mail_last_*` columns:

```
drafted       →  mail_last_piece_id set; piece submitted to provider
in_transit    →  provider confirmed print+mail
delivered     →  mail_last_delivered_at set (from polling)
returned      →  mail_last_returned_at set (undeliverable)
failed        →  provider rejected the piece
```

## Delivery Tracking

Polling only. Every sequencer run iterates records with `mail_last_piece_id` set and `mail_last_delivered_at` null, invokes the provider's status tool (e.g. `LOB_GET_POSTCARD`), and updates state. In `serve` mode the scheduler runs this pass at `watch.poll_delivery_minutes` (default 15); without `serve`, it runs whenever the operator triggers `sequence run`.

Visit-gated steps (where a visit should schedule after delivery confirms) work naturally with polling if the cadence is tighter than the expected delivery window — set `poll_delivery_minutes` to 15–30 min during active campaigns.

## Step Config

```yaml
sequences:
  default:
    steps:
      - action: mail
        day: 2
        description: branded postcard after initial email
        condition: email_last_reply_at is null
        config:
          tool: { toolkit: LOB, action: SEND_POSTCARD }
          template_id: "tmpl_abc123"
          args:
            to:
              name: { from_column: contact_name, fallback: business_name }
              address_line_1: { from_column: address }
              address_city: { from_column: city }
              address_state: { from_column: state }
              address_zip: { from_column: zip }
            merge_variables:
              first_name: { from_column: contact_first_name, fallback: "there" }
              business_name: { from_column: business_name }
              offer_snippet: { from_column: offer_snippet }
            from:
              name: { literal: "Ray Epps" }
              address_line_1: { literal: "123 Main St" }
              address_city: { literal: "Boise" }
              address_state: { literal: "ID" }
              address_zip: { literal: "83702" }
          columns:
            piece_id: mail_last_piece_id
            expected_delivery_date: mail_last_expected_delivery
            tracking_url: mail_tracking_url
          retry:
            on_bad_address: skip
            on_provider_error: retry_once
```

## Templates

Templates are created in the provider's dashboard (Lob, PostGrid) — out of scope of this tool. Step config references `template_id` and passes merge variables.

Alternative: raw HTML or PDF bytes via files in the list directory (e.g., `./templates/...`). The LLM renders merge fields before submission.

## Return Address

Declared at the list level (`list.territory.return_address` or `channels.mail.return_address`) and overridable per-step. Required for CASS-validated delivery.

## Address Hygiene

Before dispatching, the step validates the destination address via the provider's CASS validation. Step config declares `on_invalid_address: skip | normalize | fail`.

Records failing CASS get `mail_last_invalid_address = true` and are skipped; written to `source_filter_failures` for operator correction.

Optional pre-step: `address_verification` enrichment step that runs the provider's validation endpoint for all active records and populates `address_verified`. Sequencing can gate on that column.

## Gating Downstream Steps

Any step can gate on mail state:

```yaml
- action: visit
  day: 5
  condition: >
    mail_last_delivered_at is not null AND
    now - mail_last_delivered_at < 3 days
  config: { ... }
```

The sequencer's defer behavior (see `sequencing.md`) handles in-transit mail.

## Cost Tracking

Each step writes `mail_last_cost_cents` when the provider returns a cost. Rolled up in reporting.

## Idempotency

Mail sends are destructive — resending on retry would double-mail. Step config enables idempotency:

```yaml
config:
  idempotency:
    key_source: [_row_id, sequence_step]
    scope: list
```

The action writes a `pending` marker to the record before dispatch; on success, replaces with `sent:<piece_id>`. Retries with the same marker reuse the stored piece ID instead of re-dispatching.

## Compliance

The sequencer always checks `suppressed`, `dne_mail` (if used), and the global suppression list before dispatching. Returned mail (undeliverable) auto-adds the address to a "bad address" list to prevent waste.

## Failure Modes

- **Bad address** — CASS fails → skip, flag, optionally re-enrich address
- **Provider rejection** — rare; retry once, then flag
- **Billing failure** — halt the whole mail channel until resolved; surfaces a big warning on the daily operator view
- **Never confirms delivery** — after `mail_last_expected_delivery + grace_period`, mark as "delivery_unknown" so sequencing decisions have explicit state

## Multi-Piece Campaigns

Multi-piece history lives in the `channel_events` table — each dispatch, delivery, and return is an append-only row keyed by `(row_id, channel='mail', event_type)`. The `records` table carries only `mail_last_*` cursor columns (most-recent piece state) for cheap gating queries; full history is always available via `channel_events`.

## Inputs / Outputs

**Inputs:**
- `outbound.yaml` → `sequences.*.steps[*]` where action is `mail`, `channels.mail`, `list.territory.return_address`
- Canonical store — record data including address fields
- Provider status tools (Lob, PostGrid, etc.) polled per sequencer run

**Outputs:**
- Canonical store — `mail_last_*` columns
- Provider dashboard — the actual piece in motion
- Downstream step evaluations can gate on delivery state
