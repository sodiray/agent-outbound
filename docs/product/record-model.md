# Record Model

Everything in the tool is organized around a **record**. A record is one business at one location — a plumbing company on a specific street, a dental office at a specific address. Every piece of information the tool gathers, every outreach attempt, every outcome, every state change — all lives on that record.

## What a Record Represents

A record is a business location that the tool has decided is worth considering. It's the unit of prioritization, outreach, and outcome tracking.

- **One record per business location.** A plumbing chain with three branches is three records.
- **Records are never deleted.** They can be marked suppressed, opted-out, or linked as duplicates of another record, but the history is preserved.
- **One record maps to one CRM Company.** Contacts map to CRM People; active sequences open an CRM Deal.

## What's Tracked On a Record

A record accumulates information across its lifecycle. Conceptually:

### Identity
Who the business is — name, address, phone, website, Google Place ID, geocoded coordinates.

### Contact
The primary decision-maker and how to reach them — name, title, email, phone, LinkedIn. Up to a handful of additional contacts can be enriched if relevant.

### Signals
Time-sensitive indicators: are they hiring, how many reviews have they gotten this month, when did their website last change, how active are they on social. See [Enrichment](./enrichment.md).

### Classification
What vertical they're in, what workflow patterns they exhibit (books by phone, runs weekly email promos, uses online booking), what persona the primary contact fits. See [Enrichment](./enrichment.md).

### Scores
Fit score (how good a prospect) and trigger score (how urgent to reach out). See [Scoring](./scoring.md).

### Sequence state
What sequence they're in, which step they're on, when the next action is due, whether they've replied, bounced, or opted out.

### Per-channel state
Last email sent/replied, mail pieces dispatched and delivered, visits scheduled and completed with dispositions, SMS sent/replied, calls logged.

### Suppression & consent
Whether the record is suppressed entirely, and per-channel flags: do-not-email, do-not-call, do-not-knock.

### CRM linkage
The CRM Company, Person, and Deal IDs this record mirrors to.

### Outcomes
Final outcome (meeting booked, closed-won, closed-lost, no response), outcome value, notes.

## Lifecycle

A record moves through these broad states, all tracked on itself:

1. **Sourced** — discovered by a search; checked for duplicates via AI-driven identity matching. Duplicates are linked, not deleted.
2. **Qualified / Disqualified** — passed or failed early filters. Disqualified records stay on the list, just skipped by downstream phases.
3. **Enriched** — contact info, signals, classification filled in.
4. **Scored** — fit and trigger computed. Ready for prioritization.
5. **Active in sequence** — outreach has launched; actions fire on schedule.
6. **Engaged** — a positive reply landed; sequence pauses; operator decides next move.
7. **Completed / Opted-out / Bounced / Suppressed** — terminal states for that sequence. Records can be re-engaged later under a different sequence.

## Multiple Contacts Per Business

Every record can have multiple contacts — primary decision-maker, secondary, gatekeeper, billing contact, whoever enrichment finds. Each is its own entity with name, title, email, phone, and LinkedIn URL. The tool queries across contacts natively; sequences can reference the primary contact by default and any other contact by role when a step needs to.

## Event History Per Channel

Every outreach touch — every email sent and replied, every mail piece dispatched and delivered, every visit scheduled and completed, every call logged — is preserved as an event, not overwritten. Records show both "latest state" (for fast daily queries) and full history (for audit and inspection). When the operator asks *"what did we send Beacon Plumbing?"*, they get the complete sequence of touches with dates, dispositions, and outcomes.

## Record vs. CRM

The record inside this tool is the **execution ledger** — dense, state-heavy, optimized for the daily outreach motion. The CRM Company is the **relationship ledger** — shared, durable, optimized for reading and reporting.

The tool mirrors the subset of record state that matters long-term into CRM. The full execution detail (staleness hashes, route IDs, retry counters, etc.) stays local. See [CRM](./crm.md).

## What the Operator Sees

The operator doesn't read records as raw tables most of the time. They see:

- **Aggregated views** in the daily dashboard (counts of replies, calls, visits, follow-ups due)
- **Routes** organized geographically for visit days
- **Per-list pipeline** broken down by sequence state
- **CRM** for the relationship view

When the operator needs to inspect or correct a specific record, `/outbound` commands like *"why did Beacon Plumbing score low on fit?"* or *"show me the history for Beacon Plumbing"* surface the record's state in human-readable form.
