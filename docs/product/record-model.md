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

## Accounts and Contacts

A record is the **account** — the business, the execution unit, the thing the sequence runs against. Every account has one or more **contacts** — the people at the business the operator actually talks to.

Account-level fields: identity, classification, scores, sequence state, suppression flags, CRM linkage.

Contact-level fields: name, title, role (owner, manager, front-desk, gatekeeper, billing), email, phone, LinkedIn, disposition of the most recent interaction.

Why this split matters: in local SMB outbound, the operator talks to different people at the same business across channels and across visits. The owner isn't in on Monday but the manager takes a flyer; the owner picks up the phone Wednesday; the operator lands a meeting Thursday. The tool represents this naturally — one account with a timeline spanning three contacts — so sequences, reply detection, and reporting all compose correctly.

Sequences default to the primary contact for channels that need one (email, SMS, LinkedIn). A step can target a different contact by role when the sequence calls for it:

```
day 0: email to primary contact
day 2: postcard addressed to "Owner" (no specific contact)
day 5: visit — ask for the owner by name; fall back to manager
day 8: email to secondary contact if primary went silent
```

Channel events and dispositions attach to the `(account, contact)` pair they actually involved. When the agent composes a timeline, it can show "spoke to manager at door, then owner called back" as two separate events on the same account.

The operator's CRM mirrors this split — one CRM Company per account, one CRM Person per contact, one CRM Deal per account. See [CRM](./crm.md).

## Disposition

Every meaningful interaction the operator logs carries a **disposition** — a typed enum capturing what happened. Dispositions are structured (not free-text notes) so the sequencer, scoring, and reporting can branch on them.

Core disposition values:

| Disposition | When the operator uses it |
|---|---|
| `met_dm` | Spoke to the decision-maker |
| `gatekeeper` | Only got past the gatekeeper; DM unavailable |
| `not_fit` | Determined this isn't a fit |
| `warm` | Positive signal, not yet ready |
| `hot` | Ready-to-buy signal, move fast |
| `bad_data` | Bad address, wrong number, closed business |
| `callback` | Asked to be contacted later |
| `booked_meeting` | A real meeting got booked |

Visits add a few more (`talked_to_staff`, `left_card`, `left_flyer`, `closed`, `come_back`, `no_show`) — see [Visits](./visits.md#dispositions).

Every disposition optionally carries a follow-up window (`--follow-up-in 7d`) and a free-text note. The sequence branches on the enum value; the note feeds the agent when it composes future briefs for this account.

## Reply Classification

The tool classifies every reply it receives (email, SMS) into a typed enum so the sequencer and the agent can branch deterministically:

| Classification | Meaning |
|---|---|
| `booking_intent` | Wants to schedule / buy |
| `question` | Asked something that needs an answer |
| `objection` | Push-back, needs addressing |
| `hard_no` | Clear rejection |
| `positive_signal` | Warm but non-specific |
| `out_of_office` | Auto-reply, sequence continues |
| `unsubscribe` | STOP / unsubscribe / remove |
| `bounce` | NDR / mailer-daemon |

Classification is persisted alongside the reply on the record. Sequences can branch on it (see [Sequencing](./sequencing.md#branching-on-structured-signals)). The agent reads it when composing how to handle the reply.

## Multiple Contacts Per Business

Every account can have multiple contacts — primary decision-maker, secondary, gatekeeper, billing contact, whoever enrichment finds. Each is its own entity with name, title, role, email, phone, and LinkedIn URL. The tool queries across contacts natively; sequences reference the primary contact by default and any other contact by role when a step needs to.

## Event History Per Channel

Every outreach touch — every email sent and replied, every mail piece dispatched and delivered, every visit scheduled and completed, every call logged — is preserved as an event, not overwritten. Records show both "latest state" (for fast daily queries) and full history (for audit and inspection). When the operator asks *"what did we send Beacon Plumbing?"*, they get the complete sequence of touches with dates, dispositions, and outcomes.

## Record vs. CRM

The record inside this tool is the **execution ledger** — dense, state-heavy, optimized for the daily outreach motion. The CRM Company is the **relationship ledger** — shared, durable, optimized for reading and reporting.

The tool mirrors the subset of record state that matters long-term into CRM. The full execution detail (staleness hashes, route IDs, retry counters, etc.) stays local. See [CRM](./crm.md).

## What the Operator Sees

The operator doesn't read records as raw tables. They talk to the agent; the agent reads the tool and composes the answer.

Common views the agent assembles on the operator's behalf:

- **Daily dashboard** — counts of replies, calls, visits, follow-ups due (see [Operator](./operator.md))
- **Routes** organized geographically for visit days (see [Visits](./visits.md))
- **Per-list pipeline** broken down by sequence state
- **CRM** for the relationship view (see [CRM](./crm.md))

For specific questions — *"why did Beacon Plumbing score low?"*, *"show me the history for Beacon Plumbing"*, *"which leads replied this week?"* — the agent uses the tool's [data access surface](./data-access.md): `record show` for one account's full detail, `query` for arbitrary reads, `export` for projections the operator can use externally. The agent composes the results into a response tailored to the question.
