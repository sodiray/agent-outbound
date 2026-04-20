# Compliance (Technical)

Suppression list format, channel-specific enforcement mechanisms, audit logging.

For the user-facing description, see `../product/compliance.md`.

## Suppression List

Canonical suppression list lives in the `suppression` table inside the per-list SQLite DB (`.outbound/prospects.db`). Global suppression lives in a separate SQLite file at `~/.agent-outbound/suppression.db` with the same schema. Every outreach step checks both before executing.

### Suppression columns on the record

| Column | Meaning |
|---|---|
| `suppressed` | Master kill switch — no outreach on any channel |
| `suppressed_reason` | `opt_out`, `bounce`, `dnc_request`, `manual`, `crm_dnc`, `verification_failed`, `not_a_fit` |
| `suppressed_at` | ISO timestamp |
| `dne_email` | Email channel opt-out |
| `dnc_phone` | Call and SMS channel opt-out |
| `dnk_visit` | Visit channel opt-out |

`suppressed = true` trumps everything. Per-channel flags allow finer-grained preferences.

### Suppression list file format

```csv
email,domain,phone,address_hash,business_name,reason,added_at
john@example.com,,,, ,opt_out,2026-03-04T...
,competitor.com,,,,manual,2026-02-12T...
,,+12085551234,,,tcpa_request,2026-01-20T...
```

Entries suppress by specific email, domain, phone, address hash, or business name (fuzzy). Before every send, the sequencer consults this list plus the record's own flags.

### Global vs. per-list

- **Global**: `~/.agent-outbound/suppression.db` (SQLite, schema identical to per-list `suppression`)
- **Per-list**: `<list>/.outbound/prospects.db` → `suppression` table

Both consulted on every send.

## Automatic Suppression Triggers

- Email hard-bounce → add email to suppression
- Email soft-bounce ×3 → add email to suppression
- Reply contains STOP/UNSUBSCRIBE/REMOVE (classified by `detect-replies`) → record moves to `opted_out`, email added
- SMS STOP received → phone added to suppression
- Mail returned-to-sender → address added to bad-address list
- Visit `not_a_fit` disposition → record `dnk_visit = true`
- CRM `do_not_contact` flipped on a synced record → `suppressed = true`

## Channel-Specific Enforcement

| Rule | Enforced where |
|---|---|
| Never send without valid `contact_email` | Email channel verification gate |
| Never send without footer (unsubscribe + physical address) | Email step prompt + step validation |
| Never SMS without `sms_consent = true` (if `requires_prior_consent` on) | SMS channel gate |
| Never call/SMS a number marked `dnc_phone` | Call/SMS channel gate |
| Never visit an address marked `dnk_visit` | Visit channel gate |
| Never mail an address on the returned-to-sender list | Mail channel gate |
| STOP reply → opt out immediately | `detect-replies` classifier |
| Hard bounce → suppress email | `detect-replies` classifier |
| CRM DNC flip → global suppression | CRM sync |

## CAN-SPAM Email Footer

Required in every email step:

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

Step validation rejects email steps missing either field. The step's prompt instructs the LLM to preserve the footer verbatim.

## Country Gating

```yaml
channels:
  email:
    country_allowlist: ["US"]           # only send to US
    country_denylist_eu: true           # never send to EU
```

Records outside the allowlist skip the email step.

## CRM DNC Sync

```yaml
crm:
  tool:
    toolkits: [YOUR_CRM]
  dnc_sync: true
```

Sync direction:
- When the CRM's do-not-contact field flips on → next sync sets `suppressed = true`
- When the tool sets `suppressed = true` → sync writes it back to the CRM

See `crm.md`.

## Data Retention / Forget

```
/outbound forget --email someone@example.com
```

Implementation:
1. Add email to global suppression with reason `forget_request`
2. Clear PII columns on matching records (`contact_name`, `contact_email`, `contact_phone`, `linkedin_url`, `outcome_notes`, `visit_notes`) while preserving `_row_id` and suppression state
3. Write operation to `.outbound/compliance.log`

## Compliance Audit Log

Every suppression change, opt-out, and forget operation appends a JSON line to `.outbound/compliance.log`:

```json
{
  "timestamp": "2026-04-14T10:22:14Z",
  "action": "opt_out",
  "target_type": "email",
  "target": "owner@example.com",
  "row_id": "abc-123",
  "reason": "reply_stop",
  "source": "detect-replies"
}
```

Append-only. If a prospect disputes a send, the operator produces the full history.

## Inputs / Outputs

**Inputs:**
- `outbound.yaml` → `suppression`, per-channel compliance settings
- Global and per-list suppression files
- Canonical store — `suppressed`, `dne_*` flags

**Outputs:**
- Canonical store — suppression state updated
- Global/per-list suppression files — new entries appended
- `.outbound/compliance.log` — audit trail
- CRM — DNC field synced (if `dnc_sync` enabled)
