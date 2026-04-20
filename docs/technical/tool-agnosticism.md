# Tool Agnosticism — Engineering Spec

> **Overall status**: Sections 1-3 and 5 are complete. Code changes have shipped. Documentation updates listed at the bottom are partially complete.

Agent-outbound must never contain code that knows about a specific external tool, CRM, mapping provider, or enrichment vendor. The product works through automated discovery and AI-driven configuration against whatever the operator has connected in Composio. This document specifies the changes required to bring the codebase in line with that principle.

## The Two-Phase Rule

Every tool-dependent feature follows the same contract:

**Config time (CLI setup / config authoring):**
The AI authors config by discovering what's available in Composio. Before writing a toolkit reference into the config, the system validates that the toolkit is connected. The config is a validated, executable plan.

**Execution time (running the list):**
The runner reads the config and executes it. Before calling any tool-dependent action, it checks that the required toolkit is still available in Composio. If it's not (disconnected, expired auth), it throws a hard error:

> "This list requires [TOOLKIT_NAME] but it is not available in Composio. Reconnect it at https://platform.composio.dev/apps/[toolkit] or update your config."

No defaults. No fallbacks. No silent skipping. The config says exactly what tools will be used, and execution either succeeds or fails loudly.

---

## 1. CRM Abstraction

> **Status: Completed** (2026-04-17)

### Problem

The CRM layer is entirely Attio-specific. Database columns are named `attio_*`, the config schema has a dedicated `CrmAttioSchema`, the runner reads `config.attio.*`, the sync prompt instructs the AI to use Attio specifically, and the fallback toolkit is hardcoded to `['ATTIO']`.

### Solution

Make the CRM layer generic. The product stores CRM entity IDs and sync state without knowing which CRM produced them. The AI figures out how to use whatever CRM toolkit is connected.

### Config schema changes (`src/schemas/config.ts`)

Delete `CrmAttioSchema`. Replace the CRM config with:

```yaml
crm:
  tool:                           # required — no default
    toolkits: ['ATTIO']           # or ['HUBSPOT'], ['SALESFORCE'], etc.
    tools: []                     # optional pinned action slugs
  dnc_sync: true                  # read DNC status from CRM (generic concept)
  deal_stage_mapping: {}          # maps sequence states to CRM stage names
  config: {}                      # opaque pass-through for CRM-specific settings
```

The Zod schema becomes:

```ts
crm: z.object({
  tool: ToolSpecSchema,            // required — not optional, not defaulted
  dnc_sync: z.boolean().default(true),
  deal_stage_mapping: z.record(z.string()).default({}),
  config: z.record(z.any()).default({}),
}).partial().default({}),
```

Key changes:
- No `provider` field (the toolkit *is* the provider)
- No `attio` sub-object
- No `attio_dnc_field` in `SuppressionSchema` — the DNC field name goes in `crm.config` if needed, interpreted by the AI, not the product code

### Database columns (`src/orchestrator/runtime/db.ts`)

Rename all `attio_*` columns to `crm_*`:

| Old column | New column |
|---|---|
| `attio_company_id` | `crm_company_id` |
| `attio_person_id` | `crm_person_id` |
| `attio_deal_id` | `crm_deal_id` |
| `attio_sync_hash` | `crm_sync_hash` |
| `attio_last_synced_at` | `crm_last_synced_at` |

Same rename on the `contacts` table (`attio_person_id` → `crm_person_id`).

Same rename on all indexes (`idx_records_attio` → `idx_records_crm`, `idx_contacts_attio` → `idx_contacts_crm`).

No migration needed — hard cutover. Existing example databases will be deleted and recreated.

### Record shape (`src/orchestrator/lib/record.ts`)

Rename the mapped fields to match the new column names.

### CRM runner (`src/orchestrator/crm/runner.ts`)

Stop reading `config.attio.*`. Read from `config.crm` directly:
- `config.crm.dnc_sync` for the DNC sync flag
- `config.crm.deal_stage_mapping` for stage mapping
- `config.crm.config` for any CRM-specific pass-through
- `config.crm.tool` for the toolkit spec

The snapshot function should reference the generic `crm_*` columns. Suppression reasons should use `crm_dnc` instead of `attio_dnc`.

The runner's job is orchestration: staleness detection, cost tracking, suppression on DNC. It must not interpret CRM-specific field names — that's the AI's job.

### CRM sync action (`src/orchestrator/actions/sync-crm/index.ts`)

Remove the hardcoded `toolkits: ['ATTIO']` fallback. Read `crmConfig.tool` directly. If no tool is configured, throw:

> "CRM sync requires a configured toolkit. Run config author to set up CRM integration."

### CRM sync prompt (`src/orchestrator/actions/sync-crm/prompt.md`)

Replace all Attio references with generic CRM instructions:

```markdown
Sync this record into the CRM using the tools available to you.

Required behavior:
- Upsert Company using stable business identity fields.
- Upsert Person for primary contact when contact details exist.
- Upsert/advance Deal based on current sequence and outcome state.
- Preserve existing CRM links when already present (IDs in record).

Safety:
- Do not create duplicate Company/Person entries if a reliable match exists.
- If data is insufficient, return `status: skipped` with a concrete `reason`.
- Check the CRM's do-not-contact field if DNC sync is enabled; return `remote_dnc: true` if the CRM indicates do-not-contact.

Record:
{{record_json}}

CRM Config:
{{crm_config_json}}

Return JSON only.
```

### CRM sync result schema (`src/orchestrator/actions/sync-crm/schema.ts`)

Already generic (`company_id`, `person_id`, `deal_id`, `remote_dnc`). No changes needed.

### Files affected

| File | Change |
|---|---|
| `src/schemas/config.ts` | Delete `CrmAttioSchema`, `attio_dnc_field` in `SuppressionSchema`. Rewrite CRM section. |
| `src/orchestrator/runtime/db.ts` | Rename all `attio_*` columns/indexes to `crm_*`. |
| `src/orchestrator/lib/record.ts` | Rename `attio_*` fields to `crm_*`. |
| `src/orchestrator/crm/runner.ts` | Read from generic `config.crm.*`. Rename all `attio_*` references. |
| `src/orchestrator/actions/sync-crm/index.ts` | Remove `['ATTIO']` fallback. Error if no toolkit configured. |
| `src/orchestrator/actions/sync-crm/prompt.md` | Replace Attio-specific instructions with generic CRM. |
| `src/orchestrator/runtime/paths.ts` | Remove `provider: attio` from scaffold template. |

---

## 2. Route Planning — Remove Hardcoded Router Lookup

> **Status: Completed** (2026-04-17)

### Problem

`plan-route/index.ts` contains a `defaultToolSpec()` function that maps string values (`'mapbox'`, `'route4me'`) to specific Composio toolkit names, defaulting to `['GOOGLE_MAPS']`.

### Solution

Delete the lookup table. Route planning works the same as every other tool-dependent action: the toolkit comes from the config, validated at config time, checked at execution time.

### Changes

**`src/orchestrator/actions/plan-route/index.ts`:**
- Delete `defaultToolSpec()` function
- Remove the `router` parameter from `planRouteAction`
- `toolSpec` is required — if empty or missing, throw: "Route planning requires a configured toolkit in channels.visit.tool."

**`src/orchestrator/sequencer/runner.ts`:**
- Remove `router: config?.channels?.visit?.router || 'google_maps'`
- Pass `toolSpec: config?.channels?.visit?.tool` directly
- If `config?.channels?.visit?.tool` is missing or empty when a visit step is due, throw a clear error

**`src/commands/index.ts`:**
- Same: remove `router` references, pass `config?.channels?.visit?.tool` directly

**`src/schemas/config.ts`:**
- No schema change needed — `channels` is already `z.record(z.any())`, so `channels.visit.tool` is naturally supported
- The `router` field in `channels.visit` is no longer used; it can be ignored or cleaned up

### Files affected

| File | Change |
|---|---|
| `src/orchestrator/actions/plan-route/index.ts` | Delete `defaultToolSpec()`, remove `router` param, require `toolSpec`. |
| `src/orchestrator/sequencer/runner.ts` | Remove `router` references. Pass `tool` from config directly. Error if missing. |
| `src/commands/index.ts` | Same cleanup. |

---

## 3. MCP Enumeration Queries — Remove Vendor Names

> **Status: Completed** (2026-04-17)

### Problem

`ENUMERATION_QUERIES` in `mcp.ts` is a fixed list of 20 search phrases that mention specific tools by name (Attio, Gmail, Yelp, Apollo, Clearbit, Twilio, etc.). This creates an implicit vocabulary of tools the product "knows about."

### Solution

Rewrite the queries to use functional descriptions only. The purpose of enumeration is to discover which *categories* of tools are connected, not to find specific vendors.

### New queries

Replace the current `ENUMERATION_QUERIES` with:

```ts
const ENUMERATION_QUERIES = [
  { use_case: 'send and read email messages' },
  { use_case: 'find a business contact or email by name and company' },
  { use_case: 'scrape web pages or run a web search' },
  { use_case: 'search local businesses and places by location' },
  { use_case: 'verify an email address for deliverability' },
  { use_case: 'send physical mail or a postcard' },
  { use_case: 'send an SMS or text message' },
  { use_case: 'manage CRM records companies contacts deals' },
  { use_case: 'manage calendar events or booking links' },
  { use_case: 'send team chat or workspace messages' },
  { use_case: 'manage tasks projects and issues' },
  { use_case: 'manage files documents and spreadsheets' },
  { use_case: 'post and read social media content' },
  { use_case: 'manage code repositories and pull requests' },
  { use_case: 'enrich leads with contact and company data' },
  { use_case: 'search business listings reviews and ratings' },
  { use_case: 'cloud file storage and sharing' },
  { use_case: 'application monitoring and alerting' },
  { use_case: 'customer support and helpdesk tickets' },
  { use_case: 'make and receive phone calls' },
  { use_case: 'plan routes and calculate drive times between locations' },
  { use_case: 'look up public business records and registrations' },
];
```

### Validation

Before shipping, run both old and new query sets against a Composio account with several toolkits connected. Compare the discovered toolkits. If any connected toolkit is missed by the new queries, adjust the functional description — don't add the vendor name back.

### Files affected

| File | Change |
|---|---|
| `src/orchestrator/runtime/mcp.ts` | Replace `ENUMERATION_QUERIES` contents. |

---

## 5. Scaffold Template

> **Status: Completed** (2026-04-17)

### Problem

`paths.ts` generates new `outbound.yaml` files with `provider: attio` hardcoded.

### Solution

Remove the CRM section from the scaffold entirely. A new list starts with no CRM configured. The operator sets it up via config authoring, which validates the toolkit exists.

### Files affected

| File | Change |
|---|---|
| `src/orchestrator/runtime/paths.ts` | Remove `provider: attio` line from scaffold template. |

---

## Documentation Updates Required

After the code changes ship, these docs need to be rewritten to remove Attio and vendor-specific references:

| Doc file | What changes |
|---|---|
| `docs/product/crm.md` | Rewrite entirely. Title should be "CRM Sync" not "CRM (Attio)". Remove all Attio-specific field mappings. Describe generic CRM sync behavior. |
| `docs/technical/crm.md` | Rewrite entirely. Remove Attio field mapping tables, Attio code examples, `attio_*` column references. Describe generic `crm_*` columns and CRM-agnostic sync action. |
| `docs/technical/data-schema.md` | Rename all `attio_*` columns to `crm_*` in the schema tables. Update index names. Update `suppressed_reason` enum to use `crm_dnc` instead of `attio_dnc`. Same for `suppression.reason`. |
| `docs/product/record-model.md` | Replace "One record maps to one Attio Company" with generic CRM language. Replace "Attio Company/Person/Deal" with "CRM Company/Person/Deal". |
| `docs/product/visits.md` | Remove "Google Calendar" references where they assume that's the only calendar provider. The product creates calendar events via whatever calendar toolkit is connected. |
| `docs/technical/visits.md` | Remove the routing toolkit comparison table (Google Maps vs Mapbox vs Route4Me vs OptimoRoute). Remove `channels.visit.router`. Describe that the toolkit comes from `channels.visit.tool`, validated at config time. |
| `docs/product/integrations.md` | Remove the "Preferred default" column from the coverage map — there are no preferred defaults. Reframe as "Capability → Example providers" with a note that any connected Composio toolkit providing that capability works. Remove "Minimum functional setup" section that prescribes specific tools. Remove "Attio is the default system of record" from the CRM row. |
| `docs/technical/integrations.md` | Remove hardcoded action slug examples in "Gap Coverage Patterns" section (e.g., `[FIRECRAWL_SCRAPE, SERPAPI_SEARCH]`). These are authored by the AI at config time, not prescribed by the product. |

---

## Verification

After all changes are made:

1. `grep -ri 'attio' src/` should return zero results
2. `grep -ri 'google_maps\|GOOGLE_MAPS' src/` should return zero results (outside of user-facing help text)
3. `grep -ri 'mapbox\|route4me\|MAPBOX\|ROUTE4ME' src/` should return zero results
4. The enumeration queries in `mcp.ts` should contain no proper nouns (vendor/product names)
5. Create a fresh list, author config, run sourcing, enrichment, sequencing, and CRM sync end-to-end. Confirm no hardcoded tool assumptions surface.
