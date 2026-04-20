# Physical Mail

When a sequence step describes sending physical mail, the tool recognizes it and activates mail-specific behavior: provider dispatch, delivery tracking, and downstream gating. Mail is not a hardcoded step type — it's a pattern the agent detects from the step's description. The key capability: the tool **knows when the piece actually arrives**, which lets downstream steps (visits, follow-up emails) land in concert with the mail, not before or after.

## Why Mail Is Different Here

Most outbound tools that include mail treat it as fire-and-forget: submit the piece, move on. This tool tracks delivery. A visit step gated on `mail delivered` will wait until the mail provider confirms delivery, then schedule the visit the next day. That timing tightness is the whole point.

## Providers

| Provider | Best for |
|---|---|
| **Lob** | Default. Postcards, letters, checks. USPS IMb tracking. |
| **PostGrid** | Lob alternative; often cheaper internationally. |
| **Postalytics** | Direct mail with built-in analytics and personalized URLs. |
| **Handwrytten** | Robot-written handwritten notes. Higher-touch than print; longer lead time. |
| Stannp / Thanks.io / Cardly / Echtpost | Geography-specific alternatives. |

The operator picks a provider per step. Different steps in one sequence can use different providers — a mass postcard via Lob, a handwritten closing note via Handwrytten.

## What a Mail Step Looks Like

From the operator's perspective:

```
/outbound add a mail step on day 2: Lob postcard, condition "no reply yet"
```

The tool stores:
- Which provider and template to use
- What data to merge in (first name, business name, offer snippet)
- The return address
- Conditions that must be met before dispatch (no reply, no bounce, not suppressed)

At dispatch time, the tool:
- Submits the piece through the provider
- Stores the piece ID, expected delivery date, and tracking URL on the record
- Tracks delivery state as updates arrive from the provider
- Advances downstream steps gated on delivery

## Lifecycle of a Mail Piece

| State | What it means |
|---|---|
| Drafted | Piece submitted to the provider; provider has accepted it |
| In transit | Provider confirmed print + mail |
| Delivered | Provider confirmed delivery; downstream gates can fire |
| Returned | Undeliverable; address added to bad-address list |
| Failed | Provider rejected the piece (bad address, billing, etc.) |

Delivery tracking is polling-based. Every sequencer run checks Lob / PostGrid / whichever provider is pinned for outstanding pieces and updates state. Cadence is controlled by `watch.poll_delivery_minutes` in config (default 15 min) when running `serve`; otherwise it runs whenever you invoke `sequence run`.

## Templates

Postcard and letter templates are created once in the provider's dashboard (Lob, PostGrid). The tool references them by template ID and passes merge data. The operator doesn't author templates from scratch per record — templates are reusable, merged per-record.

For operators who want to design from scratch: raw HTML or PDF can be generated per-record and submitted without a stored template. Useful for one-off pieces or highly personalized notes.

## Address Hygiene

Before dispatching a piece, the tool validates the destination address through the provider's CASS validation. Records that fail validation are skipped and flagged on the record — the operator can correct the address and try again.

An optional address-verification enrichment step runs this upfront for all records, writing `address_verified = true/false` so bad addresses get flagged before any mail step fires.

## Gating Downstream Steps

Any sequence step can gate on mail state. The common pattern:

```
day 0: email sent
day 2: postcard dispatched
day 5: visit in person — only if mail delivered AND no reply
day 7: follow-up email referencing the postcard — only if mail delivered
```

If the postcard hasn't been confirmed delivered by day 5, the visit step defers (waits, up to a configured max) until delivery confirms or the timeout elapses.

## Bad Addresses and Returns

Returned-to-sender mail auto-adds the address to a bad-address list. Future mail to the same address is skipped. The operator sees returned mail on the dashboard and can correct addresses, re-enrich, or mark the record.

## Multi-Piece Campaigns

A sequence can drop multiple mail pieces. Each piece fills state columns on the record. Full history (every piece ever sent) is preserved in channel event logs; the record itself shows the most-recent piece's state for the common gating queries.

## Cost and Cadence

- Postcards via Lob: ~$0.60–1.00 per piece
- Letters: ~$1.00–1.50
- Handwritten via Handwrytten: $3–6 per piece
- Lead time from dispatch to delivery: typically 3–7 business days for USPS First-Class

The tool tracks cost per piece on the record and rolls up cost-per-outcome.

## What Mail Doesn't Do

- Does not send anything without the sequence firing (no one-off mail sends from this tool — those would be a separate operator command)
- Does not enforce sending quotas (Lob/PostGrid enforce their own rate limits; the tool respects them)
- Does not design or template from scratch — templates live in the provider's dashboard
- Does not handle personalized URLs (pURLs) directly — Postalytics-specific feature, can be leveraged through its tool

## Compliance

Physical mail is generally exempt from CAN-SPAM and TCPA but subject to local solicitation rules in some jurisdictions and to the operator's internal suppression list. The tool always checks suppression flags before dispatching. See [Compliance](./compliance.md).
