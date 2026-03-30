# Daily Operator

## Purpose

A single command that shows you everything you need to do today across all active outreach. Your morning dashboard.

## Usage

```
/outbound what do I need to do today?
```

Or more specific:

```
/outbound who replied?
/outbound show me the call list for boise-dental
/outbound what follow-ups are due?
```

## Output

```
=== OUTBOUND DASHBOARD ===

REPLIES (3) -- handle these first
  Scott Asin (Asin General Contractors) -- replied, wants to meet Thursday
  Bill Cahill (Beacon Plumbing) -- replied, "sounds interesting, call me"
  Jerod Mollenhauer (Recon Roofing) -- asked about pricing

CALLS (14) -- step 2, day 3
  Brendan Walker (Northend Construction) -- 208-695-5263
  Chris Conner (Conner Construction) -- 208-794-7621
  ... (12 more)

MANUAL (6) -- step 3, day 4
  Beacon Plumbing -- walk into the business and leave a handwritten note
  Viking Plumbing -- walk into the business and leave a handwritten note
  ... (4 more)

FOLLOW-UP EMAILS (8) -- step 4, day 7, drafts ready
  Cascade Enterprises -- draft ready, review in email client
  Strite Design + Remodel -- draft ready, review in email client
  ... (6 more)

PIPELINE
  Active: 287 | Engaged: 5 | Completed: 0 | Opted out: 2 | Bounced: 1

ENRICHMENT
  boise-dental: 45/80 enriched, 12 pending
  boise-realestate-april: not started
```

## Data Sources

Everything comes from the CSV and the sequencer:

1. **Replies:** detected by the sequencer via `execute-step` (reply search), marked `sequence_status = engaged`
2. **Calls:** rows where `sequence_step` matches a call step and `next_action_date <= today` and `sequence_status = active`
3. **Follow-up emails:** rows where due step is an email step with `sequence_status = active`
4. **Pipeline stats:** aggregated from `sequence_status` column
5. **Enrichment status:** from enrichment config + CSV fill rates (via `agent-outbound enrich-status`)

## Actions

The operator view is primarily read-only — it shows you what to do. Write actions go through `/outbound`:

```
"I just called Brendan at Northend, he wants to meet Thursday"
→ agent-outbound log boise-dental --prospect "Northend" --action engaged --note "Meeting Thursday"

"Mark Viking Plumbing as not interested"
→ agent-outbound log boise-dental --prospect "Viking Plumbing" --action opted_out

"Send the follow-up drafts for boise-dental"
→ agent-outbound followup send boise-dental
```
