# Overview

Agent-Outbound is a local outbound tool for one operator running a serious local SMB motion. It sources leads, enriches them with signals from across the web, ranks them, and executes coordinated outreach across any channel the operator can describe and the agent has tools for — all from a single canonical record per business.

## Who It's For

One operator, working locally, who is running outbound against local businesses. The operator owns the relationship ledger in their CRM. Agent-Outbound is their execution layer — the thing that actually finds leads, enriches them, decides when to act, and records what happened.

It is not a team product. It is not a SaaS. It is a CLI that runs on the operator's laptop.

## What It Does

1. **Sources leads** from local business search tools, directories, and arbitrary web sources — whichever toolkits are connected in Composio. Deduplicates across all of them using AI-driven identity matching — records from different sources describing the same business are linked together, not deleted, so all data is preserved.
2. **Enriches records** with contact info, hiring signals, review signals, social activity, tech stack, workflow classification, and persona hypothesis.
3. **Scores records** on two axes: fit (how good a prospect) and trigger (how urgent to reach out right now). Scoring is agent-driven — the operator describes what matters in natural language; the agent reads enriched data and scores with judgment and reasoning.
4. **Plans sequences** that coordinate touches across any channel — email on Monday, postcard delivered Wednesday, in-person visit Friday if the postcard landed and no reply yet.
5. **Executes sequences** with cross-step dependencies that make the touches land in concert instead of in parallel silos. Steps are generic — the agent determines what kind of work each step requires based on its description.
6. **Plans daily visit routes**, batches them geographically, schedules them on the operator's calendar, and tracks outcomes per stop.
7. **Detects replies and bounces** and pauses sequences accordingly.
8. **Mirrors state into the CRM** so the operator's relationship view stays authoritative for everyone else.

## Channels Are Open-Ended

Sequence steps are not tied to a fixed set of channel types. A step is a natural language description of work the agent should do — and the agent figures out what kind of work it is based on the description and the tools available.

Common channels include email, physical mail (Lob, PostGrid, Handwrytten), in-person visits, phone calls, SMS, LinkedIn outreach, and door flyer drops. But the operator can describe any step the agent has tools for. If a new channel or integration becomes available, it's a new step description and a tool connection — no code changes.

This matters because local SMB outbound is inherently multi-channel and the right channel mix varies by vertical, territory, and operator style. The tool shouldn't constrain what the operator can do.

## The Value

- **It actually does things**, across channels. Email, mail, visits, SMS, LinkedIn, and anything else the agent has tools for — all on one timeline tied to one record.
- **Cross-step coordination is the point**. Visits land the day after mail confirms delivery, not three days after it was dispatched. The tool knows when mail arrived because it tracks delivery events.
- **Lead quality is separated from timing**. Fit and trigger are different scores with natural-language reasoning; the operator can prioritize by "hot right now" without losing track of "always a great fit."
- **Workflow-level classification** (not just vertical) — the tool identifies whether a business books by phone, runs email promos, posts weekly, has online booking. Actionable for message selection.
- **CRM stays authoritative** for the relationship record. The tool mirrors state outbound-side, never fights the CRM for ownership of contacts or deals.
- **Compliance is the default**. Suppression is global, opt-outs are honored immediately, CAN-SPAM footers are enforced per step, do-not-knock is a first-class flag on visits.

## What This Tool Is Not

- **Not a CRM.** The operator's CRM is the CRM. This tool writes into it.
- **Not an inbox.** Replies land in the operator's email. The tool reads them and updates state.
- **Not an analytics platform.** The canonical record store is browsable, and the CRM is where reporting lives.
- **Not a team product.** Single-operator, local. No multi-seat support.
- **Not a third-party destination syncer.** There is no spreadsheet or database sync. The canonical record store is internal; the CRM is the shared view.
- **Not a cold-email-at-scale blaster.** It sends modest daily volume with verification, rotation, and warmup built in. For 1000+ sends/day, it routes through Instantly rather than direct Gmail.

## How the Operator Works With It

Everything runs through `/outbound` inside Claude Code. Examples:

```
/outbound create a list called boise-plumbers for plumbing contractors in the Boise metro
/outbound source 200 leads
/outbound add a step to find the decision-maker and their email
/outbound enrich the list
/outbound add a sequence: email day 0, postcard day 2, visit day 5 if postcard delivered, bump email day 7 if no reply
/outbound launch the top 50 by priority
/outbound what do I need to do today?
/outbound show me today's route
/outbound log Northend Construction — talked to owner John, booked a meeting Thursday 2pm
```

The operator doesn't write config by hand. They describe what they want; the tool authors the underlying configuration and executes it.

## Running Alongside the CRM

The moment a lead goes into a sequence, it gets a matching Company, Person, and Deal in the operator's CRM. Every meaningful state change — sent, replied, delivered, visited, opted out — mirrors into the CRM. If the operator flips a Company's do-not-contact flag inside the CRM, the tool picks it up on the next sync and stops all outreach.

See [CRM](./crm.md).

## Compliance by Default

Email footers enforce CAN-SPAM. Verified addresses only. STOP replies suppress immediately. Hard bounces suppress immediately. Do-not-knock is a flag. Returned mail gets address-marked. Opted-out records are suppressed across every channel. The audit log is append-only.

See [Compliance](./compliance.md).

## What to Read Next

- [Record model](./record-model.md) — what a record represents and what lifecycle it goes through
- [Sourcing](./sourcing.md), [Enrichment](./enrichment.md), [Scoring](./scoring.md) — the pre-outreach phases
- [Sequencing](./sequencing.md) — the outreach motion, with cross-step dependencies
- [Mail](./mail.md), [Visits](./visits.md), [Deliverability](./deliverability.md) — channel-specific behavior (mail tracking, route planning, email deliverability)
- [CRM](./crm.md), [Compliance](./compliance.md), [Integrations](./integrations.md) — cross-cutting concerns
- [Operator](./operator.md), [User flows](./user-flows.md), [Watch](./watch.md) — day-to-day use

For implementation detail, see the sibling `/docs/technical/` folder.
