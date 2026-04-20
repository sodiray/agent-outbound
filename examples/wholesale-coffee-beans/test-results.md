# Test Results: Wholesale Coffee Beans — Run 4 (Agnostic Model)

**Date:** 2026-04-17  
**Purpose:** Validate the fully agnostic model after team refactored out all hardcoded platform references (Attio, Google Maps, etc.). All external tools are now discovered dynamically via Composio toolkit resolution.

## Bugs Found and Fixed During This Run

### BUG-A: Toolkit resolution fails — wrong Composio API format (Critical)

**File:** `src/orchestrator/runtime/tools.ts` — `resolveToolkitToolSlugs`

**Symptom:** Every command using toolkit-only tool specs (no explicit slugs) got 0 tools loaded. Sourcing, enrichment, CRM sync, and sequencing all failed.

**Root cause (two issues):**
1. Passed toolkit names as raw strings to `COMPOSIO_SEARCH_TOOLS`, but the API expects `{ use_case: string }` objects.
2. Looked for tool slugs in `data.tools` (doesn't exist), but Composio returns them in `results[].primary_tool_slugs` and `results[].related_tool_slugs`, with schemas in `data.tool_schemas`.

**Fix:** Rewrote to format queries as `[{ use_case: toolkitName }]`, extract slugs from `primary_tool_slugs`/`related_tool_slugs`, and pre-populate schema cache from `tool_schemas`.

### BUG-B: `hasPinnedTools` ignores toolkit-only specs (Critical)

**File:** `src/orchestrator/runtime/llm.ts`

**Symptom:** Tool specs with `toolkits: ['YELP']` but `tools: []` were treated as "no tools" — the AI ran without any external tool access.

**Fix:** Extended check to `(tools.length > 0) || (toolkits.length > 0)`.

### BUG-C: `assertToolSpecAvailable` uses lossy semantic search (Moderate)

**File:** `src/orchestrator/runtime/mcp.ts`

**Symptom:** CRM sync failed with "ATTIO not available" even though Attio is connected, because `enumerateConnectedToolkits` (semantic search via broad use-case queries) didn't match Attio.

**Fix:** Changed to check specific required toolkits directly via `COMPOSIO_MANAGE_CONNECTIONS` instead of relying on semantic enumeration.

### BUG-D: Config `modify_step`/`remove_step` with array-by-id paths silently fail (Moderate, NOT FIXED)

**File:** `src/orchestrator/lib/config.ts`

**Symptom:** Paths like `source.searches[id=google-maps-treasure-valley-coffee]` or `enrich[id=website-scrape]` report `written: true` but have no effect on the YAML.

**Root cause:** `tokenizePath` can't resolve array-by-id syntax. It treats `id=...` as a literal property key on an array object, which creates orphaned properties that are ignored on write.

**Impact:** Config author can't modify or remove individual items in arrays. This is the single biggest product issue — it means toolkit changes, step removals, and search modifications all require manual YAML editing.

---

## Phase Results

### Phase 0: Setup and Auth — PASS
| Test | Result | Time |
|------|--------|------|
| 0.1 Init | ok, keys valid, 10 toolkits | 13.5s |
| 0.2 Auth list | 12 toolkits listed (Attio missing — see BUG-C) | 7.2s |

### Phase 1: List Creation — PASS
| Test | Result | Time |
|------|--------|------|
| 1.1 Create list | created | 0.24s |
| 1.2 List info (empty) | 0 records | 0.26s |
| 1.4 Config read (blank) | Clean config — no Attio or platform-specific defaults | 0.19s |

### Phase 2: Config Authoring — PASS (with caveats)
| Test | Result | Time |
|------|--------|------|
| 2.1 Sourcing + territory | Retry needed (identity as object first time) | 79s |
| 2.2 Source filters | 3 filters added | 33s |
| 2.3 Website enrichment | Added with Firecrawl | 27s |
| 2.4 Contact lookup | Added with Hunter, depends_on correct | 24s |
| 2.5 Social/content | Added | 34s |
| 2.6 Hiring check | Added, haiku model, 7d cache | 26s |
| 2.7 Scoring | Fit + trigger set, 60/40 weights | 27s |
| 2.8 Sequence | 3 steps (email d0, followup d3, visit d7) | 39s |
| 2.9 Tool swap (Hunter → Apollo) | Reported success but path failed (BUG-D) | 27s |
| 2.10 Validation safety | Correctly normalized malformed inputs | 20s |

**Caveats:**
- Model hallucinated tool slugs (e.g., `FIRECRAWL_SCRAPE`, `COMPOSIO_SEARCH_GOOGLEMAPS`) — required manual YAML cleanup
- `modify_step` with array-by-id paths silently failed (BUG-D) — tool swap didn't actually take effect
- First config author attempt on 2.1 wrapped identity in an extra object

### Phase 3: Sourcing — PASS
| Test | Result | Time |
|------|--------|------|
| 3.1 Source (limit 10) | 42 found, 10 inserted, 10 filtered out | 4:14 |
| 3.2 Verify records | 10 records, all idle | 0.18s |
| 3.3 Duplicates | 0 needs_review | 0.19s |

**Data issue:** Yelp doesn't populate `business_name` — field names don't match `output_map`. Website URLs are Yelp listing pages, not actual business websites.

### Phase 4: Enrichment — PASS (36/40)
| Test | Result | Time |
|------|--------|------|
| 4.1 Full enrichment | 36 processed, 4 failed, scoring auto-ran (10/10) | 11:09 |
| 4.2 Verify scores | avg_fit=12.9, avg_trigger=17 | 0.20s |

4 failures: 1 website-scrape (null outputs), 3 hiring-check (null booleans). Output schemas need defaults.

### Phase 5: Scoring — PASS
| Test | Result | Time |
|------|--------|------|
| 5.1 Re-score | 10 skipped_unchanged | 0.14s |

### Phase 6: Sequencing — PASS
| Test | Result | Time |
|------|--------|------|
| 6.1 Status (pre) | 10 idle | 0.36s |
| 6.2 Launch draft | 5 drafted, 0 failed | 1:19 |
| 6.3 Launch send | 5 sent, 0 failed | 1:18 |
| 6.4 Status (post) | 5 active, 5 idle | 0.18s |
| 6.5 Sequence run (dry) | 10 executed, 0 failed | 14.5s |

### Phase 7: Dashboard — PASS
| Test | Result | Time |
|------|--------|------|
| 7.1 Dashboard | 5 idle, 3 active, 1 engaged, 1 opted_out | 0.14s |

### Phase 8: Visits — PASS
| Test | Result | Time |
|------|--------|------|
| 8.1 Visits today | 0 stops (correct) | 0.12s |

### Phase 9: Logging and Compliance — PASS
| Test | Result | Time |
|------|--------|------|
| 9.1 Log talked_to_owner | → engaged | 0.13s |
| 9.2 Log opted_out | → opted_out + suppressed | 0.13s |
| 9.3 Suppress email | Created | 0.23s |
| 9.4 Suppress domain | Created | 0.22s |
| 9.5 GDPR forget | Cleared | 0.17s |
| 9.6 Reconcile | 0 stale | 0.20s |

### Phase 11: CRM Sync — PASS (after BUG-C fix)
| Test | Result | Time |
|------|--------|------|
| 11.1 CRM sync | 1 synced, 9 skipped, 0 failed | 3:06 |

Required explicit `crm.tool` config (no more hardcoded Attio default).

### Phase 13: Config Safety — PARTIAL PASS
| Test | Result | Time |
|------|--------|------|
| 13.1 Conflicting instructions | remove_step silently failed (BUG-D), add worked | 39s |
| 13.2 Vague prompt | Made unsolicited changes (should ask for clarification) | ~40s |
| 13.3 Raw YAML update | Updated without corruption | 0.3s |

---

## Known Issues (not fixed, for engineering)

| # | Issue | Severity | Impact |
|---|-------|----------|--------|
| D | Array-by-id paths in config ops silently fail | **High** | Config author can't modify/remove individual array items |
| E | Yelp sourcing doesn't map business_name or actual website URL | Moderate | Empty names, enrichment scrapes Yelp pages instead of business sites |
| F | Enrichment output schemas need boolean/string defaults | Low | 4/40 enrichments fail with null instead of false/empty |
| G | Config author makes changes on vague prompts | Low | UX — should ask for clarification |
| H | Config author hallucinated Composio tool slugs | Low | Requires manual YAML cleanup after authoring |

## Files Modified This Session
- `src/orchestrator/runtime/tools.ts` — Fixed `resolveToolkitToolSlugs` (BUG-A)
- `src/orchestrator/runtime/llm.ts` — Fixed `hasPinnedTools` (BUG-B)
- `src/orchestrator/runtime/mcp.ts` — Fixed `assertToolSpecAvailable` (BUG-C)
