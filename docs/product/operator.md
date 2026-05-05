# Daily Operator

## Purpose

One question every morning — *"what do I need to do today?"* — and the agent pulls together everything across active lists and channels. Replies first, visits with a planned route, mail pieces landing, calls to make, follow-up drafts ready to review, low-inventory alerts — everything in one view.

The operator's job is to execute; the dashboard is the queue the agent composes from the tool's state.

## Usage

```
/outbound what do I need to do today?
```

Or more specific:

```
/outbound who replied?
/outbound show me today's route
/outbound show me the call list
/outbound what follow-ups are due?
/outbound show me low-inventory alerts
/outbound show me bounces and opt-outs from this week
```

## Output

```
=== OUTBOUND DASHBOARD — Tue 2026-04-14 ===

REPLIES (3) — handle these first
  Scott Asin (Asin General Contractors) — positive, wants to meet Thursday
    boise-contractors · step 4 · replied 09:14
  Bill Cahill (Beacon Plumbing) — positive, "sounds interesting, call me"
    boise-plumbers · step 2 · replied 07:42
  Jerod Mollenhauer (Recon Roofing) — asked about pricing
    boise-roofers · step 3 · replied 08:02

TODAY'S ROUTE — 12 visits, 9:00–15:30
  1. 09:00  Northend Construction    208-695-5263
            mail delivered 4/12 · owner_operator · fit 82 / trigger 74
  2. 09:35  Conner Construction      208-794-7621
            mail delivered 4/11 · owner_operator · fit 78 / trigger 68
  3. 10:15  Beacon Plumbing          208-555-0901
            mail delivered 4/13 · practice_manager · fit 75 / trigger 82
  ... (9 more — `/outbound show me today's route` for full list)

CALLS (14) — step 2, day 3
  boise-plumbers (8):
    Brendan Walker (Northend Construction) — 208-695-5263 · fit 80
    Chris Conner (Conner Construction) — 208-794-7621 · fit 76
    ... (6 more)
  boise-roofers (6):
    ... (6)

FOLLOW-UP EMAILS (8) — drafts ready, review in Gmail
  Cascade Enterprises — boise-contractors · step 4 · draft ready
  Strite Design + Remodel — boise-contractors · step 4 · draft ready
  ... (6 more)
    → /outbound send follow-ups to approve in bulk

MAIL PIECES LANDING TODAY (11)
  Viking Plumbing — Lob piece_abc · delivered 4/14
    → visit scheduled 4/17
  Quick Cool HVAC — PostGrid piece_def · delivered 4/14
    → visit scheduled 4/18
  ... (9 more)

DEFERRED (5) — waiting on gating conditions
  Elite Dental — visit scheduled, waiting on mail delivery confirm
  Sunrise Plumbing — visit scheduled, waiting on mail delivery confirm
  ... (3 more)

BOUNCES / OPT-OUTS (2 new)
  noone@deadbiz.com — hard bounce, suppressed
  Viking Plumbing — replied STOP, opted out

PIPELINE
  boise-plumbers:    Active 87  Engaged 4  Completed 12  Opted-out 3  Bounced 2
  boise-contractors: Active 56  Engaged 2  Completed 8   Opted-out 1  Bounced 1
  boise-roofers:     Active 41  Engaged 1  Completed 4   Opted-out 0  Bounced 0

ALERTS
  Low flyer inventory: 14 left — print more before next route
  Sending inbox 'ray+2@example.com' at 38/40 cap today — rotate or defer
  Email verification skip rate: 8% (rolling 7d) — investigate data quality
```

## Sections

### Replies
Surfaced first because they're most time-sensitive. Pulled from `detect-replies` runs. Classification shown (`positive` / `negative` / `ooo`). Operator can respond via Gmail directly; the sequence is already paused.

### Today's Route
One table for all visits due today, across all lists. Pre-routed and scheduled. Each line: time, business, phone, context (why we're visiting, persona, scores), and the flyer to bring. See `visits.md` for the full route flow.

### Calls
Rows due for a `call` step today. Grouped by list. Phone, primary contact, fit score. Operator calls; logs disposition via `/outbound log`.

### Follow-up Emails
Drafts ready for review in Gmail. The operator approves and sends in bulk via `/outbound send follow-ups`, or reviews individually in Gmail.

### Mail Pieces Landing Today
Mail that was dispatched earlier and is confirmed/estimated to deliver today. Useful because downstream steps are gated on delivery — the operator sees what's about to unlock.

### Deferred
Records waiting on a gating condition (e.g., "visit waiting on mail delivery confirmation"). Shows why they're deferred and when they're expected to fire.

### Bounces / Opt-outs (new)
Anything that hit suppression in the last 24 hours. Read-only; the operator doesn't have to act on these, but should see them in case something's off (e.g., a spike in bounces).

### Pipeline
Per-list snapshot of sequence state distribution. Quick visual on list health.

### Alerts
Anything that could degrade the operation: low physical collateral, sending inbox approaching cap, unusual bounce/verification rate, Composio auth expiring, calendar conflicts.

## Commands the Operator Will Run

### Daily reviewing
```
/outbound what do I need to do today?
/outbound who replied?
/outbound show me today's route
/outbound show me the call list for boise-plumbers
/outbound show me alerts
```

### Executing
```
/outbound send follow-ups                       # review + approve follow-up drafts
/outbound send follow-ups for boise-plumbers    # scoped
/outbound finish today's route                  # walk through visits, logging each
/outbound log boise-plumbers --prospect "Northend Construction" --visit talked_to_owner --note "..."
/outbound log boise-plumbers --prospect "Viking Plumbing" --call voicemail
/outbound suppress --email spam@example.com --reason manual
```

### Inspection / debugging
```
/outbound why did Beacon Plumbing score low on fit?
/outbound show me the history for Beacon Plumbing
/outbound why is Elite Dental deferred?
/outbound show me this week's bounces
/outbound export today's route with enrichment to a CSV so I can skim it on my phone
/outbound which prospects replied with booking intent this month?
```

For these, the agent uses the [data access surface](./data-access.md) — `record show` for full detail on one account, `query` for arbitrary questions across the list, `export` to project data into a file the operator can open or pass along.

### Pipeline management
```
/outbound pause boise-plumbers                  # stops all sends, preserves state
/outbound resume boise-plumbers
/outbound re-score boise-plumbers
/outbound re-enrich boise-plumbers --stale-only
/outbound snapshot the list before we swap the hiring step  # see safety-and-preview.md
```

### Draft approval

```
/outbound show me the drafts waiting for approval
/outbound approve the top 10 drafts
/outbound edit the draft for Beacon Plumbing — make it shorter
/outbound reject the draft for Viking Plumbing, wrong persona
```

The agent reads the pending-approval queue (`drafts list`), walks drafts through with the operator, applies approvals and edits. See [Sequencing → Draft Approval Queue](./sequencing.md#draft-approval-queue).

### Cost and usage

```
/outbound how much have I spent on AI for boise-plumbers this week?
/outbound how many Firecrawl calls has the hiring step made today?
/outbound what's my projected AI spend for tonight's enrichment run?
```

The agent reads `ai-usage` and `usage` (see [AI Usage](./ai-usage.md)) and answers with specific numbers. For projected spend on a new run, the agent uses `--sample` before committing.

## What the Agent Does Behind the Scenes

When the operator asks a question, the agent typically:

1. Reads the relevant tool data — `record show`, `query`, `export`, `route show`, etc.
2. Composes the answer — a brief, a summary, a table, a CSV
3. Uses safety primitives when appropriate — `--sample` before big runs, snapshots before destructive changes
4. Relays results in whatever form the operator asked for — chat, email, a file

The operator doesn't need to know the commands. They stay in conversation; the agent drives the tool.

