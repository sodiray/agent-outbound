# In-Person Visits

When a sequence step describes an in-person visit, the tool recognizes it and activates visit-specific behavior: route planning, calendar scheduling, and outcome tracking. Visits are not a hardcoded step type — they're a pattern the agent detects from the step's natural language description. The operator is the one who does the visiting; this tool is the planner, checklist, and logger.

## Why Visits Matter

In-person visits are the highest-signal, highest-conversion touch in local SMB outbound. They're also the most expensive in time — the operator can do maybe 12–20 quality visits a day. Route optimization and sequence coordination (visit *after* mail landed, *before* follow-up email) are what make this viable as a daily motion rather than a weekly exception.

## Lifecycle of a Visit

| State | What it means |
|---|---|
| Scheduled | Record has a planned visit date; part of an upcoming route |
| Calendar-booked | Calendar event created with context |
| Completed | Operator visited; disposition logged |
| Rescheduled | New date assigned; old calendar event archived |

## Dispositions

Every visit ends with a disposition — a typed value the operator logs that captures what actually happened. Visit dispositions are part of the broader disposition model (see [Record Model → Disposition](./record-model.md#disposition)). Default options:

| Disposition | Meaning | Downstream behavior |
|---|---|---|
| `talked_to_owner` | Spoke with the decision-maker | Sequence pauses or advances to a post-conversation step |
| `talked_to_staff` | Spoke with a gatekeeper or staff | Sequence continues |
| `left_card` | Left a business card | Sequence continues |
| `left_flyer` | Dropped a flyer or printed material | Sequence continues; flyer inventory decrements |
| `closed` | Business closed during hours | Retry; consider updating the record's hours |
| `come_back` | Owner asked to return at a specific time | Schedule a follow-up visit |
| `not_a_fit` | Determined on-site not a fit | Mark suppressed, reason `not_a_fit` |
| `booked_meeting` | Booked a formal meeting | Advance to engaged |
| `no_show` | Didn't visit | Reschedule or skip |

Dispositions are configurable per sequence — a sequence can extend the default set or restrict it.

Because dispositions are typed, the sequencer branches on them deterministically (`condition: "visit.disposition == talked_to_owner"`). The agent reads the disposition when composing post-visit follow-ups, so the follow-up email referencing "our conversation with the owner" only goes out when `talked_to_owner` was actually logged.

## Route Planning

When multiple visits come due on the same day, the tool batches them. Given:

- Records due for a visit
- The operator's home base
- Daily visit cap (defaults to 12)
- Business hours window
- Any existing calendar conflicts

The tool:

1. Clusters records by geographic proximity
2. Orders them to minimize drive time
3. Respects business hours — a restaurant opening at 11 am can't be the 9 am first stop
4. Produces an ordered route with estimated arrival times
5. Creates calendar events for each stop, with business name, phone, the reason for the visit, persona, and expected disposition options in the description

The operator sees this as a single ordered list:

```
=== TODAY'S ROUTE — Tue 2026-04-14 ===

1. 09:00  Northend Construction        208-695-5263
          123 Main St, Boise
          Reason: Day 5 visit, mail delivered 4/12
          Persona: owner_operator
          Flyer: ./assets/flyer.pdf

2. 09:35  Conner Construction          208-794-7621
          456 Oak Ave, Boise
          ...
```

## Per-Stop Briefs

The operator often wants more than a line per stop — a short brief per visit summarizing who to ask for, what to open with, what's known about the business, and what the prior touches were. The tool exposes the raw data; the agent composes the brief.

```
/outbound write briefs for Thursday's route and email them to me
```

Under the hood the agent reads the full route payload including enrichment, contacts, and prior touch history:

```
agent-outbound route show boise-plumbers --date 2026-04-21 \
  --include enrichment,contacts,prior-touches
```

Then composes a brief per stop — referencing the owner name from `website-scrape`, the hiring summary, the mail piece that landed, the workflow tags — and emails it to the operator, drops it in a folder, or renders it in chat. This is the pattern for most "write me X about Y" asks: the tool provides the data, the agent provides the narrative. See [Data Access](./data-access.md).

## Daily Visit Flow

Morning of:

```
/outbound show me today's route
```

The operator drives. At each stop, they log disposition from their phone:

```
/outbound log boise-plumbers --prospect "Northend Construction" --visit talked_to_owner --note "Owner John open to a meeting Thursday 2pm"
```

Or for a whole day, walk through them in bulk:

```
/outbound finish today's route
```

The tool walks each scheduled visit one-by-one, asking for disposition and notes.

## Do-Not-Knock

A record marked `dnk_visit = true` never appears in a route. The flag can be set:

- Automatically after a `not_a_fit` disposition
- Manually by the operator (e.g., after a neighbor complained)
- From an imported suppression list

Some cities have posted "no soliciting" ordinances. The operator can note these per-visit; an optional rule auto-sets `dnk_visit = true` when that note is present.

## Capacity

Daily visit capacity is a real constraint. The tool caps visits per day at a configured number (default 12). If more visits are due than capacity allows, extras carry to the next eligible day in priority order.

Territory can be further constrained:

- A home base and max drive radius
- Excluded ZIP codes

Which days visits are allowed at all is controlled by the sequence's `working_days` config — see [Sequencing → Working Days](./sequencing.md#working-days). The common case for SMB outbound is excluding Sunday; many operators also exclude Monday mornings.

## Gating on Other Steps

Visit steps typically gate on state from previous steps, described in natural language:

```
day 5: "visit in person" — condition: "only if the postcard has been delivered (not just dispatched), we haven't received a reply on any channel, and the business is not flagged do-not-visit"
```

If a record is due for a visit but the condition isn't met (mail not delivered yet), the visit defers. The record won't appear on today's route until the agent determines the condition is satisfied.

## Rescheduling

- `closed` disposition → creates a new visit at a later time for the same record
- `come_back` disposition → operator specifies the return time
- `no_show` → rescheduled to the next eligible day

Rescheduling preserves the sequence step cursor — the retry isn't a new sequence step, just a new attempt at the same visit.

## What Visits Don't Do

- Do not authenticate the operator at the destination (no physical check-in)
- Do not enforce drive time limits beyond planning (the operator manages their day)
- Do not record audio or video (the operator notes verbally / in text)
