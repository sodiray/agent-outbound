# Test Plan: Wholesale Coffee Beans

End-to-end test of every agent-outbound feature, driven by the [scenario](./scenario.md). All config is authored via natural language — never hand-edited. Every command is timed.

The list is created in this directory (`examples/wholesale-coffee-beans/`). Run all commands from this directory.

## Timing Thresholds

| Command type | Expected | Flag if over |
|---|---|---|
| Local-only (list create, info, config read, suppress, log, forget, reconcile, duplicates) | < 500ms | > 1s |
| Config author (single LLM call) | < 15s | > 30s |
| Source (API calls + LLM per search) | < 90s total | > 180s |
| Enrich (per step, 10 records) | < 120s | > 240s |
| Score (10 records) | < 60s | > 120s |
| Sequence run / launch draft (10 records) | < 90s | > 180s |
| Dashboard | < 30s | > 60s |
| CRM sync | < 30s | > 60s |
| Route plan | < 30s | > 60s |

---

## Phase 0: Setup and Auth

Validates that the environment is configured and external integrations are reachable.

### Test 0.1 — Init

```
agent-outbound init
```

**Expected:** Status `ok`. Both Composio and Anthropic keys valid. Connected toolkits listed.

### Test 0.2 — Auth list

```
agent-outbound auth --list
```

**Expected:** Returns connected toolkits. Should include at minimum: Google Maps or Yelp (sourcing), Firecrawl (enrichment), Hunter or FullEnrich (contact), Gmail (email channel).

### Test 0.3 — Auth toolkit URL

```
agent-outbound auth FIRECRAWL
```

**Expected:** Returns Composio dashboard URL for Firecrawl. Status `ok`.

---

## Phase 1: List Creation

### Test 1.1 — Create list

```
agent-outbound list create coffee-shops --description "Independent coffee shops and cafes in the Boise metro area for wholesale bean sales"
```

**Expected:** Status `created`. Directory created with `outbound.yaml` and `.outbound/` containing `prospects.db`.

### Test 1.2 — List info (empty)

```
agent-outbound list info coffee-shops
```

**Expected:** 0 records. No errors.

### Test 1.3 — Lists command

```
agent-outbound lists
```

**Expected:** Shows coffee-shops and any other lists in the examples directory. Record count 0 for coffee-shops.

### Test 1.4 — Config read (blank)

```
agent-outbound config read coffee-shops
```

**Expected:** Returns the blank/default config. No errors.

---

## Phase 2: Config Authoring via Natural Language

Build the full campaign config through conversational prompts. Each prompt simulates what a real operator would say to their agent. Config is read after each authoring step to verify correctness.

### Test 2.1 — Sourcing searches + territory

```
agent-outbound config author coffee-shops --request "ok so I need to find independent coffee shops in the Boise area. Not just Boise proper but the whole treasure valley — Eagle, Meridian, Nampa, Garden City, Star, Kuna, and maybe Caldwell too. I want to search Google Maps for sure since that's going to have the best local coverage but also do a Firecrawl web search to catch any smaller shops that might not rank well on maps. My home base is in Garden City off Chinden and I don't want to drive more than 25 miles for a visit. I can do visits tuesday wednesday and thursday, max like 15 a day but realistically probably 10-12. Oh and the identity for dedup should probably be business name and address since there's going to be overlap between the maps results and the web results."
```

**Expected:**
- `source.searches` populated with Google Maps searches across multiple cities + Firecrawl web search
- `source.identity` set to `[business_name, address]` or similar
- `list.territory` populated: home_base Garden City or Boise, max_drive_radius ~25 miles, preferred_visit_days [tue, wed, thu], max_visits_per_day 15
- Status `updated`, written `true`

**Verify:** `config read coffee-shops`

### Test 2.2 — Source filters

```
agent-outbound config author coffee-shops --request "I need a filter to weed out the chains and franchises. No Starbucks, no Dutch Bros, no Black Rock Coffee, no Human Bean, none of those. Also filter out anything that doesn't have a real physical address in one of our target cities — I don't want PO boxes or listings that are just a website with no storefront. And honestly if they don't have a website at all they're probably not the kind of shop we want to work with, so filter those out too."
```

**Expected:**
- `source.filters` populated with at least two or three filter entries — franchise exclusion, physical address validation, website required
- Filters have clear conditions and descriptions
- Status `updated`, written `true`

**Verify:** `config read coffee-shops` — filters present, existing searches and territory preserved.

### Test 2.3 — Enrichment: website research

```
agent-outbound config author coffee-shops --request "first enrichment step should be scraping their website. I want to know what their vibe is — are they a cozy neighborhood spot, a trendy third-wave place, a drive-through quick-stop, whatever. I need to know what they serve, especially whether espresso and specialty coffee is a big part of their menu or if its more of a side thing. See if you can find the owner or managers name anywhere on the site, an about page or team page or whatever. And look for any mention of their current coffee supplier or roaster — if they're proudly partnered with someone that's useful to know. Use Firecrawl for the scraping. Cache it for a couple weeks since websites don't change that fast."
```

**Expected:**
- New enrichment step with id like `website_research`
- Tool pinned to Firecrawl
- Typed `outputs` declared: vibe/category (string, maybe enum), menu/offerings (string), owner name (string), current roaster (string), whether coffee is core offering (boolean or string)
- Cache ~14 days
- Status `updated`, written `true`

**Verify:** `config read coffee-shops`

### Test 2.4 — Enrichment: contact lookup

```
agent-outbound config author coffee-shops --request "next I need a step to find the owners email address. Use Hunter and FullEnrich for this — try Hunter first and if that doesn't find anything fall back to FullEnrich. This step depends on the website research step since we need the owner name from that. I want the email, the contacts full name, and their title or role. Cache this for 30 days since contact info doesn't change often."
```

**Expected:**
- New enrichment step with tool pinned to Hunter + FullEnrich
- `depends_on` references the website research step
- Typed `outputs`: contact_email (string), contact_name (string), contact_title (string)
- Cache 30 days
- Status `updated`, written `true`

**Verify:** `config read coffee-shops`

### Test 2.5 — Enrichment: social and content presence

```
agent-outbound config author coffee-shops --request "I want to know about their social media and online content presence. Are they active on Instagram? Do they post regularly? Do they have a Facebook page? Any other social platforms? Do they have a blog or news section on their site? This is important for two reasons — it tells me the owner is engaged and accessible, and it gives me material to reference in my outreach emails. Use firecrawl to look at their site and search for their social profiles. I want to know: do they have active social media (yes/no), which platforms theyre on, roughly how active they are, and whether they have any kind of blog or content. Don't need to cache this too long, maybe a week or two since social activity changes."
```

**Expected:**
- New enrichment step for social/content
- Tool: Firecrawl
- Typed `outputs`: has_social_media (boolean), social_platforms (string), social_activity_level (string, maybe enum), has_blog (boolean), content_summary (string)
- Cache ~14 days
- Status `updated`, written `true`

**Verify:** `config read coffee-shops`

### Test 2.6 — Enrichment: hiring signals

```
agent-outbound config author coffee-shops --request "add a hiring check. I want to know if the shop is actively hiring, and specifically whether they're hiring baristas or front of house staff — that's a growth signal for me. If they're hiring a manager or opening a new location that's even better. Search their website careers page if they have one and do a web search for job postings with their name. Use firecrawl. This data goes stale fast so only cache it for like 7 days. Use haiku for this one since it doesn't need to be super sophisticated, just pattern matching on job postings."
```

**Expected:**
- New enrichment step for hiring
- Tool: Firecrawl, model: haiku
- Typed `outputs`: is_hiring (boolean), hiring_roles (string), hiring_summary (string)
- Cache 7 days
- Status `updated`, written `true`

**Verify:** `config read coffee-shops`

### Test 2.7 — Scoring

```
agent-outbound config author coffee-shops --request "ok let me set up scoring. For fit score — the ideal shop is independently owned, not a franchise or chain. Espresso and specialty coffee should be core to what they do, not a side offering. I want to see a solid web presence with a real website, active social media, good reviews. Having an identifiable owner or manager by name is huge because thats who im emailing. If we couldn't find an owner name or email during enrichment that's a significant hit to the score. Bonus if they have a cozy or third-wave vibe rather than a quick-service drive-through. For trigger score — actively hiring is the strongest signal, especially barista roles because it means theyre growing. Recent social media activity means the owner is engaged and reachable. If there are recent negative reviews mentioning coffee quality thats a direct pain point we solve. No visible roaster partnership on their site is a good sign since it means theyre either unbranded or open to switching. Weight fit at 60% and trigger at 40% for priority."
```

**Expected:**
- `score.fit.description` populated with natural language matching the ICP
- `score.trigger.description` populated with timing signals
- `score.priority.weight` set to `{ fit: 0.6, trigger: 0.4 }`
- Models set (haiku for both is fine)
- Status `updated`, written `true`

**Verify:** `config read coffee-shops` — scoring present, all enrichment and sourcing preserved.

### Test 2.8 — Sequence

```
agent-outbound config author coffee-shops --request "alright the sequence. Day 0 I want to send a personalized intro email. It should reference something specific about the shop — a menu item, their instagram, a review, their vibe, whatever we found in enrichment. The pitch is simple: we're Sawtooth Roasting, a local roaster in Garden City, and we'd love to bring by some sample roasts for a free tasting. Keep it casual, like one local business owner to another. Not salesy. Day 3 if they havent replied, send a follow-up in the same email thread. Add a new angle — maybe mention a seasonal single-origin we just got in, or reference something they posted on social media recently, or mention that we work with a few other shops in the area. Short and conversational. Day 7 if still no reply and we've sent at least one email, schedule an in-person visit. Walk in, ask for the owner, introduce ourselves, leave a sample bag and a one-page flyer if they're not available. Dispositions should be: talked_to_owner, talked_to_staff, left_sample, closed, come_back, not_a_fit. Use Gmail for the emails and sonnet for drafting since the personalization matters."
```

**Expected:**
- `sequences.default` with three steps
- Step 1: day 0, email, tool pinned to Gmail toolkit, model sonnet
- Step 2: day 3, follow-up email in same thread, condition "no reply", tool pinned to Gmail toolkit
- Step 3: day 7, in-person visit, condition referencing prior touchpoints, disposition options
- `on_reply: pause`, `on_bounce: pause`, `on_opt_out: stop`
- Status `updated`, written `true`

**Verify:** `config read coffee-shops` — full config now has sourcing, filters, enrichment (4 steps), scoring, and sequence.

### Test 2.9 — Tool swap

```
agent-outbound config author coffee-shops --request "actually lets swap out Hunter on the contact lookup step and use Apollo instead. I think Apollo has better coverage for small local businesses. Keep FullEnrich as the fallback."
```

**Expected:**
- Contact lookup step updated: Hunter replaced with Apollo, FullEnrich preserved
- No other config changes
- Status `updated`, written `true`

**Verify:** `config read coffee-shops` — only the tool reference on the contact step changed.

### Test 2.10 — Config validation safety (intentional bad input)

```
agent-outbound config author coffee-shops --request "add a territory with preferred_visit_days set to [tuesday, wednesday, thursday] and required_toolkits should be {tools: [GOOGLE_MAPS]}"
```

**Expected:** This prompt contains values in wrong shapes (full day names instead of `tue`/`wed`/`thu`, `required_toolkits` as object instead of array). The config author should either normalize correctly OR return `validation_failed` with `written: false`. Must NOT wipe existing config.

**Verify:** `config read coffee-shops` — existing config fully intact regardless of outcome.

---

## Phase 3: Sourcing

Run the search + filter pipeline against real APIs.

### Test 3.1 — Source with limit

```
agent-outbound source coffee-shops --limit 10
```

**Expected:**
- Searches execute against Google Maps and Firecrawl
- Records created in the database
- Deduplication runs (overlap expected between Maps and web results)
- Filters run on new records (franchise, address, website checks)
- Summary: records found, duplicates linked, filter pass/fail counts

### Test 3.2 — Verify sourced records

```
agent-outbound list info coffee-shops
```

**Expected:** Record count > 0. Some records may have failed filters.

### Test 3.3 — Check for duplicates

```
agent-outbound duplicates list coffee-shops --status needs_review
```

**Expected:** Returns any duplicates flagged for review. May be 0 if dedup was clean.

### Test 3.4 — Incremental source (re-run)

```
agent-outbound source coffee-shops --limit 10
```

**Expected:** Few or no new records. Demonstrates incremental behavior — doesn't re-add businesses already in the list.

---

## Phase 4: Enrichment

### Test 4.1 — Full enrichment run

```
agent-outbound enrich coffee-shops
```

**Expected:**
- Steps run in dependency order: website_research first, then contact_lookup (depends on it), then social/content and hiring (independent)
- Typed outputs written to DB columns with correct types (booleans as 0/1 integers, strings, enums constrained)
- Scoring auto-runs after enrichment: fit_score, trigger_score, priority_rank populated
- Summary: processed counts per step, failure counts, skip counts

### Test 4.2 — Verify enrichment populated scores

```
agent-outbound list info coffee-shops
```

**Expected:** avg_fit_score and avg_trigger_score are non-zero.

### Test 4.3 — Staleness: re-run skips fresh records

```
agent-outbound enrich coffee-shops
```

**Expected:** All records `skipped_fresh` for every step. No API calls. Fast completion.

### Test 4.4 — Single step enrichment

```
agent-outbound enrich coffee-shops --step hiring_check
```

**Expected:** Only hiring_check runs. Other steps skipped. If records are fresh, all skip.

---

## Phase 5: Scoring

### Test 5.1 — Explicit re-score

```
agent-outbound score coffee-shops
```

**Expected:** Fit and trigger scores recomputed. Priority rank updated. Returns summary.

---

## Phase 6: Sequencing

### Test 6.1 — Sequence status (pre-launch)

```
agent-outbound sequence status coffee-shops
```

**Expected:** All records in `idle` state.

### Test 6.2 — Launch draft

```
agent-outbound launch draft coffee-shops --limit 5
```

**Expected:** Draft emails created for top 5 by priority. Each personalized from enrichment data.

### Test 6.3 — Launch send

```
agent-outbound launch send coffee-shops --limit 5
```

**Expected:** Emails sent. Records advance to `active`. Thread IDs stored. Next action date set.

### Test 6.4 — Sequence status (post-launch)

```
agent-outbound sequence status coffee-shops
```

**Expected:** 5 records `active`, remainder `idle`.

### Test 6.5 — Sequence run (dry run)

```
agent-outbound sequence run coffee-shops --dry-run
```

**Expected:** No actions fire (day 3 follow-ups not yet due). Clean evaluation.

### Test 6.6 — Sequence run (live)

```
agent-outbound sequence run coffee-shops
```

**Expected:** Checks replies, evaluates conditions. No follow-ups due yet. Clean run.

### Test 6.7 — Follow-up send

```
agent-outbound followup send coffee-shops
```

**Expected:** 0 follow-ups sent (none due yet). No errors.

---

## Phase 7: Operator Dashboard

- **Test 7.1** — `dashboard --list coffee-shops` → Pipeline status (5 active, rest idle), replies, alerts.
- **Test 7.2** — `dashboard --all-lists` → Cross-list dashboard.
- **Test 7.3** — `dashboard --list coffee-shops --alerts` → Alerts section (may be empty for fresh list).

---

## Phase 8: Visits and Routing

- **Test 8.1** — `visits today coffee-shops` → 0 stops (sequence hasn't reached day 7 yet).
- **Test 8.2** — `route plan coffee-shops --date 2026-04-23` → 0 stops if no visits scheduled, otherwise ordered route with drive times.

---

## Phase 9: Logging and Compliance

Substitute `{BUSINESS_NAME}` with actual names from sourced records.

- **Test 9.1 — Log outcome:** `log coffee-shops --prospect "{BUSINESS_NAME}" --action talked_to_owner --note "Owner happy with current roaster but open to samples. Booked tasting for Tuesday."` → Activity recorded, state may advance to `engaged`.
- **Test 9.2 — Log opt-out:** `log coffee-shops --prospect "{BUSINESS_NAME_2}" --action opted_out --note "Not interested, asked not to contact"` → Record → `opted_out`, suppressed.
- **Test 9.3 — Suppress email:** `suppress coffee-shops --value test@example.com --type email --reason "requested removal"` → Entry in list + global suppression.
- **Test 9.4 — Suppress domain:** `suppress coffee-shops --value competitor-roaster.com --type domain --reason "competitor"` → Domain suppression created.
- **Test 9.5 — GDPR forget:** `forget coffee-shops --email test@example.com` → PII cleared, global suppression added, audit log written, record preserved.
- **Test 9.6 — Reconcile:** `reconcile coffee-shops --stale-minutes 30` → Stale pending idempotency entries marked failed.

---

## Phase 10: Duplicate Management

- **Test 10.1** — `duplicates list coffee-shops --status needs_review --limit 50` → Any `needs_review` duplicates (may be 0).
- **Test 10.2** — `duplicates confirm coffee-shops --row {ROW_ID} --canonical {CANONICAL_ROW_ID}` → Link confirmed (if duplicates exist).
- **Test 10.3** — `duplicates break coffee-shops --row {ROW_ID}` → Record unlinked.

---

## Phase 11: CRM Sync

- **Test 11.1** — `crm sync coffee-shops --limit 10` → Records synced to connected CRM. Companies/People created or updated.

---

## Phase 12: Watch and Serve

- **Test 12.1** — `serve coffee-shops --port 49391` → HTTP server starts. PID/port written. Run in background.
- **Test 12.2** — `watch coffee-shops --history` → Prints recent activity from earlier phases.

---

## Phase 13: Config Safety and Edge Cases

### Test 13.1 — Conflicting instructions

```
agent-outbound config author coffee-shops --request "remove all the enrichment steps and also add a new enrichment step for tech stack detection at the same time"
```

**Expected:** Handles coherently or returns warnings. Must not corrupt config. **Verify:** `config read`

### Test 13.2 — Vague/useless prompt

```
agent-outbound config author coffee-shops --request "make it better"
```

**Expected:** No changes or notes asking for clarification. Must not corrupt config. **Verify:** `config read`

### Test 13.3 — Config update with raw YAML

```
agent-outbound config update coffee-shops --yaml "list:\n  name: coffee-shops-updated"
```

**Expected:** Config updated with provided YAML. Validates before writing.

---

## Success Criteria

1. **Every phase completes without crashes.** Commands may return errors but must not throw unhandled exceptions.
2. **Config is never corrupted.** No authoring step wipes or breaks existing config.
3. **Data flows coherently.** Records sourced → enriched → scored → sequenced, each phase reading the previous correctly.
4. **Typed outputs respected.** Booleans as 0/1, enums constrained, strings as strings. No SQLite binding errors.
5. **Staleness works.** Re-running enrichment on fresh records skips them.
6. **Compliance commands work.** Suppress, forget, reconcile execute correctly against real records.
7. **No command exceeds 2x its timing threshold** without explanation.
