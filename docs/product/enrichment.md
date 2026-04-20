# Enrichment

Enrichment is the phase that turns a sourced record into a scoreable, outreach-ready lead. Given a qualified record (passed filters), enrichment fills in contact info, timing signals, classification, and persona hypothesis.

Enrichment never adds or removes records — it only adds information to existing ones.

## Categories of Enrichment

### Contact
Finding the primary decision-maker and how to reach them.
- Name, title
- Business email (verified)
- Personal phone if available
- LinkedIn URL
- Occasionally a secondary contact (office manager, gatekeeper)

### Signals
Time-sensitive indicators of buying readiness. These feed the **trigger score** (see [Scoring](./scoring.md)).
- **Hiring**: is the business actively hiring, for what roles, when was the listing posted
- **Reviews**: review count, recency, average rating, whether the owner replies to reviews
- **Social activity**: post cadence, last post date, engagement level
- **Website freshness**: when the site last meaningfully changed, summary of changes
- **Tech stack**: platforms and tools in use (detects online booking, ecommerce, etc.)

### Fit
Attributes that feed the **fit score** (see [Scoring](./scoring.md)).
- **Vertical classification**: primary vertical, sub-vertical
- **Size tier**: solo, small, mid, regional (estimated from review count, social footprint, site richness)
- **Franchise check**: branded chain vs. independent

### Workflow tagging
Descriptions of *how the business operates* — which drives whether they're a fit for a specific offer. Examples:

- `books_by_phone` — appointments taken via phone, not online
- `runs_email_promos` — active newsletter / promo emails
- `weekly_instagram` — posts at least weekly on Instagram
- `has_online_booking` — booking widget on site
- `uses_pos_only_for_checkout` — no CRM, no email capture
- `recent_expansion` — new location opened in last 12 months

The operator defines the vocabulary; the tool applies the tags consistently across the list by reading website, social footprint, and review content.

### Persona
A single-value field on the record naming the decision-maker persona — e.g., `owner_operator`, `practice_manager`, `office_manager`, `gm`, `franchisee`, `multi_unit_owner`. Persona drives messaging, not scoring. Sequence steps can select different templates per persona.

## Incremental by Default

Every enrichment step tracks whether a record needs to re-run by watching its dependencies. If nothing has changed since the last run, the record is skipped. Adding a new enrichment step doesn't re-run all previous steps. Changing a prompt on one step only re-runs that step.

Each category also has a sensible re-freshness cadence:

| Category | Refresh cadence |
|---|---|
| Contact info (name, email) | 90 days |
| Tech stack | 90 days |
| Reviews / social activity | 14 days |
| Hiring signals | 7 days |
| Website freshness | 7 days |
| Vertical / persona / workflow | 180 days |

These are defaults; the operator can tune per list or per step.

## Adding an Enrichment Step

The operator describes intent:

```
/outbound add a step to find the decision-maker and their email
/outbound add a step to detect active hiring
/outbound add a step to classify workflow signals: books_by_phone, runs_email_promos, weekly_instagram, has_online_booking
/outbound add a step to estimate size tier
```

The tool authors the underlying step — which providers to call, which order to call them in, and how to extract the answer. Critically, it also determines the **output contract**: what fields the step will produce, what type each field is (string, number, boolean), and a description of what the executing agent should put in each field. This output contract is written into the config and serves as the single source of truth — it tells the executing model what to return, validates the response, and determines the database column types.

For example, a hiring detection step would declare outputs like `is_hiring` (boolean — whether the business is hiring), `hiring_roles` (string — comma-separated list of open roles), and `hiring_summary` (string — brief note on what the hiring activity signals).

## Running Enrichment

```
/outbound enrich boise-plumbers
/outbound enrich boise-plumbers --stale-only
/outbound why is contact_email empty for Northend Construction?
```

Enrichment runs can take 5–45 minutes depending on the list size and how many steps are configured. Progress streams as it happens (see [Watch](./watch.md)).

## What Enrichment Doesn't Do

- Does not add new records to the list.
- Does not remove records or exclude them from sequences — filters do that in the sourcing phase.
- Does not score records — scoring is its own phase.
- Does not interact with the CRM — CRM sync happens when records enter a sequence.

## Outputs of Enrichment

A fully enriched record has:

- Identity fields (from sourcing)
- Primary contact with verified email
- Signal columns (hiring, reviews, social, website freshness, tech stack)
- Classification (vertical, sub-vertical, size tier, franchise flag)
- Workflow tags
- Persona
- All column values backed by staleness tracking so re-runs are cheap

Every output field has a declared type, so downstream steps and scoring can rely on consistent data. If a downstream enrichment step depends on a specific field from an upstream step, it only re-runs when that particular field changes — not when any upstream output changes. This keeps re-enrichment costs low as lists grow.
