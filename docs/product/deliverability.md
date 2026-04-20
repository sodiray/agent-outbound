# Deliverability

Email is the cheapest channel and the easiest to ruin. A burned sending domain takes weeks to recover; a burned primary Gmail takes months. This doc covers what the tool does to keep the operator's email reputation safe.

## Sending Accounts

The tool supports two setups:

### Direct Gmail / Outlook (low volume)

For under ~40 cold emails per day per inbox, sending directly through Gmail or Outlook works fine. Key rules the tool enforces:

- **Use a dedicated secondary domain.** Never the operator's primary domain. Domain reputation damage on a secondary doesn't hurt their main one.
- **Daily per-inbox cap** — configurable, defaults to 40. Overflow queues to tomorrow.
- **Separate SPF/DKIM/DMARC** configured on the secondary domain (this is a one-time setup the operator does outside the tool).

### Instantly (scale)

For higher volume or multi-inbox rotation, the tool routes sends through Instantly. Instantly handles:

- Inbox rotation across multiple warmed sending accounts
- Warmup network participation
- Per-domain and per-inbox caps
- Unified deliverability reporting

Setup: the operator connects Instantly via `agent-outbound auth instantly`, creates a campaign in Instantly's dashboard, and the tool sends via that campaign.

## Pre-Send Verification

Before any email step fires, the tool ensures the recipient's email has been verified. Two modes:

- **Optional**: skip if no verification data; the send proceeds anyway (not recommended)
- **Required** (default): every email step checks `email_verification_status`. Valid → proceed. Invalid/risky/unknown → skip (or run a re-verification step, configurable)

Verification runs as an enrichment step using NeverBounce, Kickbox, or Hunter's verifier. Results are cached for 60 days (emails can go bad over time).

## Warmup

For serious volume, the operator uses Instantly's built-in warmup. For direct-Gmail setups, the operator does manual warmup externally (the tool doesn't orchestrate warmup itself).

## Threading

Follow-up emails thread into the same Gmail/Outlook conversation as the initial email. The tool tracks the thread identifier per record and uses it on every follow-up send. From the recipient's view, it's a natural continuation.

## Bounce Handling

The tool classifies every bounce:

- **Hard bounce** (invalid address, domain doesn't exist) → mark `bounced`, stop sequence, add to suppression
- **Soft bounce** (full inbox, temporary failure) → retry once, then soft-suppress
- **Auto-reply / OOO** → classified as auto, sequence continues as if no reply
- **Spam-trap hit** → hard-suppress immediately, alert the operator

## Reply Detection

Polling only. During every sequencer run, the tool checks the sender inbox for new messages in tracked threads and classifies anything new. Lag between a reply arriving and the sequence reacting to it equals the poll interval — usually 5 minutes when `serve` is running, or whenever you next invoke `sequence run`.

Once a reply is detected, it's classified:

- `positive` — wants to engage
- `negative` — not interested, asks to stop, hostile
- `ooo` / `auto` — vacation responder; ignore for sequence purposes but record
- `bounce` — mailer-daemon / NDR

Positive replies pause the sequence and surface on the operator dashboard. Negative + STOP replies opt the record out. Bounces stop the sequence and suppress.

## Unsubscribe / CAN-SPAM

Every email includes an unsubscribe link and physical mailing address in the footer. The tool enforces this through the step's prompt template; the email step's configuration won't pass validation without these.

When a recipient clicks unsubscribe or replies STOP, the record is moved to `opted_out` and added to suppression immediately. Subsequent steps are canceled.

See [Compliance](./compliance.md).

## Sending Windows

The operator can configure timing constraints per list:

- Send hours (e.g., 8 am–5 pm)
- Send days (no sends on weekends by default)
- Timezone-aware: respect the recipient's business hours based on their address

## What the Operator Sees

On the daily dashboard:

- Sends today (per inbox or per campaign)
- Bounce rate (rolling 7 days)
- Reply rate (rolling 7 days)
- Verification skip rate
- Any inbox near its daily cap

Abnormal metrics — bounce rate > 5%, reply rate crashing — cause the operator to pause and investigate.

## What Deliverability Doesn't Do

- Does not warm new sending domains (that's external — manual or via Instantly)
- Does not register OAuth apps with Gmail / Outlook on the operator's behalf (Composio's managed auth handles this)
- Does not manually recover burned sending domains
- Does not send anonymous or spoofed email
