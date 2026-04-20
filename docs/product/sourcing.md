# Sourcing

Sourcing is how a list gets its starting set of records. The operator describes a territory and a vertical; the tool queries the right sources, deduplicates, and runs early qualifying filters.

## What Sourcing Does

Two phases:

1. **Search** — find businesses matching criteria and add them as records.
2. **Filter** — qualify records with early-enrichment steps that produce reusable data plus a pass/fail decision.

Records are never deleted. Failures are marked; everything stays in the list for inspection.

## Sources Available

Any Composio toolkit that can search for local businesses works as a source. Common categories:

| Capability | Example toolkits |
|---|---|
| **Local business search** | Google Maps, Foursquare, Radar, etc. |
| **Geofence / polygon search** | Radar, Mapbox, etc. |
| **SERP and directory search** | SerpApi, Firecrawl, etc. |
| **Directory scraping** | Firecrawl (for industry sites, chamber of commerce lists, trade associations). |

The config author selects which toolkits to use based on what the operator has connected in Composio. For a given vertical and territory, the operator usually runs multiple searches across sources to maximize coverage. The tool dedupes overlapping results.

## Multi-Source Strategy

A single list can combine searches across sources. For plumbers in the Boise metro:

- Local business search for `"plumber Boise"`, `"plumbing contractor Meridian"`, `"plumber Eagle"`, `"plumber Garden City"`
- A second search toolkit for a wider Ada County sweep
- SERP search for `"plumbers Boise directory"` to catch listings from BBB, Angi, etc.

The results are checked against each other using AI-driven deduplication. Records identified as the same business are linked together, preserving all data from every source. If one source had a phone and another had a website, both end up contributing to the canonical record.

## Deduplication

Deduplication is AI-driven, because records from different sources describe the same business in different ways — "Bob's Plumbing" from one source, "Bob's Plumbing LLC" from another, "Robert's Plumbing Services" from a third — and deterministic matching breaks down on these variations.

### Identity

When a list is first sourced, the agent determines an **identity** — an ordered list of fields that best distinguish records for this particular list. For a business list, it might be `[name, address]`. For a people list, `[name, company]`. The identity is stored in the list's config and applies consistently across all sourcing runs.

The agent picks the identity fields by looking at the list's purpose and the data available. If the list goal changes and the identity should change, the agent updates the config and regenerates identity embeddings for all existing records.

### How Dedup Works

1. Each record's identity fields are embedded into a vector and stored locally (in the list's database — no external services).
2. When new records arrive, the tool searches for existing records within a similarity threshold (nearest-neighbor search).
3. Candidate matches are confirmed by a quick AI check — the agent sees both full records and determines whether they're the same entity or not.
4. Confirmed duplicates are **linked, not deleted**. The new record is flagged as `duplicate_of` the existing canonical record, but both are preserved. Different sources carry different data — one might have the email, another has reviews, a third has the owner's name. All of it stays available.
5. At enrichment time, data from linked records can be merged into the canonical record — best email, best phone, all signals combined.

### Why Link Instead of Delete

- Different sources contribute different data. Deleting a duplicate loses its unique fields.
- The AI might be wrong. A hard delete on a false positive is unrecoverable.
- The operator can inspect linked records and manually break or confirm links.
- Merging enrichment data from linked records produces a richer canonical record than any single source alone.

## Filters

After searches complete, filters run against records. A filter is a qualification step that:

- Checks a condition
- Produces reusable data as a side effect
- Marks the record `passed` or `failed`

Filters aren't just gates. A filter that checks "has at least one email" also writes the email it found. If the record passes, later enrichment can reuse that column. If it fails, the data is still there for inspection.

Common local-SMB filter patterns:

- Must have a website (keep-in-business signal)
- Must be in the target territory
- Must be in the target vertical (classification from name + category)
- Must have a minimum review count
- Must not be a franchise (if targeting independents)
- Must not match a suppression pattern (already a customer, already in another list)

Records that fail filters stay on the list, marked. Enrichment and sequencing skip them.

## Incremental Behavior

If the operator adds a new filter, modifies a condition, or enriches a column that a filter depends on, existing records are automatically re-evaluated on the next sourcing run. No need to re-source — the tool detects what's stale and re-runs only that.

This matters because local-SMB sourcing is often iterative: the operator sources once, notices a bunch of franchise locations they don't want, adds a filter, and re-runs. Only the filter evaluation happens; no new searches fire.

## What the Operator Asks For

```
/outbound create a list called boise-plumbers for plumbing contractors in the Boise metro
/outbound source 200 leads
/outbound add a filter to exclude franchises
/outbound re-run filters
/outbound show me why records are failing
```

The operator describes the territory, vertical, and filter intent. The tool authors the underlying configuration (which sources to query, which filters to apply, which data to capture).

## What Goes Into a List

After sourcing, each record has:

- Identity (name, address, phone, website, coordinates)
- Provenance (which search found it, when)
- Filter results (passed/failed, and which filters it failed)
- Any data the filters captured along the way (website presence, basic classification)

See [Record model](./record-model.md).

## What Sourcing Doesn't Do

- Does not add contacts or decision-makers — that's enrichment.
- Does not score records — that's after enrichment.
- Does not interact with the CRM — CRM sync happens when records enter a sequence.
- Does not run continuously. Sourcing is on-demand; the operator triggers it.
