# Compliance

Compliance is not optional. Violations range from irritating (bounced sends) to expensive (TCPA lawsuits, CAN-SPAM fines) to reputation-ending (domain burnout).

The tool's job is to make compliance the default, not a thing the operator has to remember.

## The Suppression List

One canonical list of "do not contact" entries, consulted before every outreach. Stored locally; mirrored to the CRM when applicable.

Suppression works at two granularities:

### Master flag (`suppressed`)
When true, no outreach on any channel. Used for:
- Hard opt-outs
- Hard bounces
- GDPR / right-to-be-forgotten requests
- Operator-manual suppression

### Per-channel flags
Finer-grained preferences:
- `dne_email` — do not email
- `dnc_phone` — do not call, do not SMS
- `dnk_visit` — do not knock (opt-out from visits)

A prospect saying "email me but don't call" → `dnc_phone = true`, email still works.

### Suppression by identifier

Entries can suppress by:
- Specific email address
- Entire domain
- Specific phone number
- Address (street + city + state + zip)
- Business name (fuzzy match, lowest confidence)

Before every send, the tool consults both the list and the record's own flags.

## Automatic Suppression

The tool adds to suppression automatically on:

- **Email hard-bounce** — email address suppressed
- **Email soft-bounce × 3** — email address suppressed
- **Reply containing STOP / UNSUBSCRIBE / REMOVE** — record moved to `opted_out`, email added to suppression
- **SMS STOP received** — phone number added to suppression
- **Mail returned-to-sender** — address added to bad-address list (not full suppression, but no re-mailing)
- **Visit `not_a_fit` disposition** — record gets `dnk_visit = true`
- **CRM `do_not_contact` flipped on a synced record** — record's `suppressed = true`

## Manual Suppression

```
/outbound log boise-plumbers --prospect "Beacon Plumbing" --action opted_out --note "Owner asked to stop"
/outbound suppress --email noone@example.com --reason dnc_request
/outbound suppress --domain competitor.com --reason manual
/outbound forget --email someone@example.com        # GDPR-style full PII clear
```

## Global vs. Per-List Suppression

Two levels:

- **Global** — applied across every list. Use for hard opt-outs, known bad addresses, competitor domains.
- **Per-list** — list-specific. Use for "already contacted in this campaign" or list-scoped preferences.

Both are consulted on every send.

## What the Tool Enforces Automatically

- **CAN-SPAM (US email)**: every email has an unsubscribe link and physical mailing address in the footer. Step validation blocks sending if these are missing.
- **STOP handling (SMS)**: STOP, UNSUBSCRIBE, REMOVE replies to SMS automatically suppress. This is legally required.
- **Bounce handling**: hard bounces immediately suppress; soft bounces retry and then suppress.
- **Verification before send**: emails must be verified (configurable; default required). Unverified emails are skipped, not sent.
- **Channel gates**: `dne_email`, `dnc_phone`, `dnk_visit` respected at every step.

## What the Operator Is Responsible For

- **Jurisdictional rules** — CASL (Canada), TCPA consent for cold SMS, local solicitation permits for door-to-door. The tool surfaces warnings where applicable but doesn't know the full legal context of every jurisdiction.
- **Manual disputes** — if a recipient disputes a send, the operator produces the audit history (the tool keeps it; the operator presents it).
- **Honest messaging** — the tool enforces structure (unsubscribe, physical address) but can't enforce whether the operator's subject line is accurate or their claims are honest.

## Regions

### CAN-SPAM (US email)
Enforced automatically as described above.

### CASL (Canada)
Stricter than CAN-SPAM. Cold email to Canadian businesses generally requires implied or express consent. The tool doesn't ship a compliant CASL motion — if the operator targets Canada, they understand the rules themselves. The tool supports country gating (`country_allowlist: ["US"]`) to keep non-US recipients out.

### TCPA (US phone + SMS)
Calls to business numbers during business hours are generally OK. Automated cold SMS to mobile numbers is a gray area. The tool supports `channels.sms.requires_prior_consent = true` which only sends if `sms_consent = true` is explicitly set on a record.

### Local solicitation ordinances
Some cities require permits for door-to-door. Some have posted "no soliciting" rules by neighborhood. The operator configures permits and excluded ZIPs per list.

### GDPR (EU)
The tool doesn't ship a GDPR-compliant motion. Country gating can keep EU recipients out of email sends. A `/outbound forget --email ...` command clears PII from matching records while preserving suppression state.

## The Audit Log

Every suppression change, opt-out, and forget operation writes to an append-only audit log. If a prospect disputes a send, the operator can produce a full history: when did they get added, when did they opt out, what happened when.

## CRM DNC Sync

If the operator's CRM has a do-not-contact field on Companies or People and `dnc_sync` is enabled, the tool mirrors it bidirectionally:

- Flipped on in the CRM → next sync sets `suppressed = true` on the record
- Set by the tool → sync writes it back to the CRM

See [CRM](./crm.md).

## Data Retention

The tool retains records indefinitely — never deletes, only marks. For right-to-be-forgotten:

```
/outbound forget --email someone@example.com
```

This:
1. Adds the email to global suppression
2. Clears PII columns on matching records (name, email, phone, LinkedIn, notes) while preserving `_row_id` and suppression state
3. Writes the operation to the audit log
