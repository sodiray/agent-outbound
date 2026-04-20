# User Flows

How the operator interacts with the system and what happens under the hood. All interactions go through `/outbound`, which runs CLI commands. For long-running operations, `agent-outbound watch` provides real-time visibility from a separate terminal.

## Flow 1: Create a New List

**User says:** "Create a new list called boise-plumbers for plumbing contractors in the Boise metro."

**Under the hood:**
1. `/outbound` runs `agent-outbound list create boise-plumbers`
2. CLI creates the list directory with a blank `outbound.yaml` at the root and a tool-managed `.outbound/` subdirectory containing a fresh SQLite database (`prospects.db`). Nothing else is scaffolded — the operator creates whatever directories and files they need (assets, templates, etc.).
3. `/outbound` runs `agent-outbound config author boise-plumbers "add searches for plumbing contractors in Boise metro"` — `author-config` calls `generateObject` with a `ConfigChange` schema and a Composio-toolkit-catalog lookup, emitting a typed diff that adds `source.searches` entries referencing whichever local-business-search and web-search toolkits are connected, plus default filters (has-website, has-phone, in-territory)
4. The agent also determines the list's **identity** — the ordered fields used for deduplication (e.g., `[name, address]` for a business list) — and writes it to config
5. The config diff also proposes default `list.territory` settings (home base, max visits per day) for operator review
6. Config written to `outbound.yaml`

## Flow 2: Source and Qualify

**User says:** "Source about 200 leads for boise-plumbers."

**Under the hood:**
1. `/outbound` runs `agent-outbound source boise-plumbers --limit 200`
2. Orchestrator runs all searches in parallel via `execute-step`
3. As records arrive, each is embedded using the list's identity fields and checked against existing records via nearest-neighbor search. Candidate duplicates are confirmed by a quick AI check; confirmed matches are linked (not deleted) and their unique data merged into the canonical record.
4. Runs filters on all records with stale filter results
5. Writes records, filter results, aggregate pass/fail
6. Progress streams to stdout throughout — `/outbound` reports summary (found, deduped, linked, passed, failed)

## Flow 3: Add a Signal Enrichment Step

**User says:** "Add enrichment to check if each business is actively hiring."

**Under the hood:**
1. `/outbound` runs `agent-outbound config author boise-plumbers "add an enrichment step that detects active hiring"`
2. `author-config` calls `generateObject` with a `ConfigChange` schema, the current config, available Composio toolkits, and the current store state
3. Model proposes a step with a pinned `[FIRECRAWL_SCRAPE, SERPAPI_SEARCH]` tool set and a typed output declaration: `is_hiring` (boolean — whether the business has open roles), `hiring_roles` (string — comma-separated list of open positions), `hiring_summary` (string — what the hiring activity signals about growth), with a 7-day cache TTL
4. Orchestrator validates the diff and writes to `outbound.yaml`

## Flow 4: Run Full Enrichment

**User says:** "Enrich boise-plumbers."

**Under the hood:**
1. `/outbound` runs `agent-outbound enrich boise-plumbers`
2. Orchestrator reads config, builds dependency graph across enrichment steps (including property-level dependencies like `website_research.owner_name`)
3. Processes steps in dependency order (parallel within each level, parallel records within each step)
4. Staleness check per record per step — if a step depends on specific upstream properties, only re-runs when those properties changed
5. For each stale step+record: builds a step-specific Zod schema from the `outputs` declaration → `execute-step` with pinned Composio tools → AI SDK agent loop → typed, validated output → coerced and written to `records` columns
6. Scoring runs after enrichment completes: fit and trigger scores computed, `priority_rank` written
7. Summary returned to `/outbound`

## Flow 5: Author a Sequence

**User says:** "Add a sequence: email on day 0, Lob postcard on day 2, visit on day 5 if the postcard has been delivered, bump email on day 7 if no reply yet."

**Under the hood:**
1. `/outbound` runs `agent-outbound config author boise-plumbers "add a sequence: email day 0, lob postcard day 2, visit day 5 conditional on mail delivered, email bump day 7 conditional on no reply"`
2. `author-config` calls `generateObject` with the current config, available toolkits, and the `ConfigChange` schema
3. Model emits a `sequences.default` block with four generic steps — each has a natural language description, day offset, optional condition, and tool references. No hardcoded step types.
4. Output includes a warning that a Lob return address needs to be set if not present
5. Orchestrator validates and writes

## Flow 6: Launch (Step 1)

**User says:** "Launch boise-plumbers on the top 50 by priority."

**Under the hood:**
1. `/outbound` runs `agent-outbound launch draft boise-plumbers --top 50 --order priority_rank --filter 'sequence_status=idle AND email_verification_status=valid'`
2. Orchestrator runs `execute-step` for each selected record → AI SDK call with `GMAIL_CREATE_DRAFT` creates the draft → stores draft IDs
3. Operator reviews drafts in Gmail
4. User says: "Send them."
5. `/outbound` runs `agent-outbound launch send boise-plumbers --top 50 --same-cohort`
6. Orchestrator sends each draft → stores `email_last_message_id`, `email_thread_id`, advances state to `active`, writes `launched_at` and `next_action_date`

## Flow 7: Daily Sequence Run

**User says:** "What do I need to do today?"

**Under the hood:**
1. `/outbound` runs `agent-outbound sequence run --all-lists` — detects replies, updates delivery state, finds due actions, evaluates conditions, defers or executes
2. For each due step, the agent reads the description and executes accordingly — sending emails, dispatching mail pieces, making API calls, or whatever the step describes
3. Steps the agent classifies as in-person visits are batched by geography, routed, and scheduled on the operator's calendar
4. `/outbound` runs `agent-outbound dashboard --all-lists` and renders the operator view (see `operator.md`)

## Flow 8: Walk Today's Route

**User says:** "I'm about to start the route."

**Under the hood:**
1. `/outbound` runs `agent-outbound visits today --all-lists` and prints the route
2. Operator drives, makes stops. At each: "Talked to owner John at Northend. Booked Thursday 2pm meeting."
3. `/outbound` runs `agent-outbound log boise-plumbers --prospect "Northend Construction" --visit talked_to_owner --note "..." --outcome meeting_booked`
4. Orchestrator updates visit state, advances sequence state to `engaged`, pauses sequence, writes meeting note

Alternative bulk flow:
1. User says "Finish today's route."
2. `/outbound` walks each scheduled visit in order, asking for disposition + notes for each

## Flow 9: Mail Delivery Triggers a Visit

**Scenario:** Viking Plumbing had step 2 (Lob postcard) fire on day 2. Step 3 is a visit with the condition "only if the postcard has been delivered and we haven't received a reply yet." The postcard lands today (day 4, two days ahead of schedule).

**Under the hood:**
1. Next delivery-polling pass calls Lob's status tool → orchestrator updates delivery state
2. Next `sequence run` evaluates step 3's condition for Viking — agent determines it's now met (delivered, no reply)
3. Record added to tomorrow's route via `plan-route`
4. Calendar event created
5. Tomorrow's dashboard surfaces the visit

The visit landed 1 day after delivery rather than 3 days after dispatch — exactly the tightness that makes this motion work.

## Flow 10: Reply Received, Sequence Pauses

**Scenario:** Beacon Plumbing replies to step 2.

**Under the hood:**
1. Gmail trigger fires (or polling catches it) → `detect-replies` runs
2. `detect-replies` classifier (Haiku via `generateObject`) tags it `positive` — "sounds interesting, call me"
3. Orchestrator updates `email_last_reply_at`, `email_reply_classification`, `sequence_status = engaged`
4. Sequence paused — no further steps fire until operator intervenes
5. Reply surfaces on today's dashboard under `REPLIES`

## Flow 11: Log an Outcome and CRM Syncs

**User says:** "I called Brendan at Northend, he wants to meet Thursday."

**Under the hood:**
1. `/outbound` runs `agent-outbound log boise-plumbers --prospect "Northend Construction" --call conversation --note "Meeting Thursday" --outcome meeting_booked`
2. Orchestrator updates `call_last_disposition`, `outcome`, `outcome_notes`
3. `sync-crm` runs against the changed record → AI SDK call with the configured CRM toolkit updates the Deal stage to "Meeting Booked" and writes a note on the Person
4. `crm_last_synced_at` updated

## Flow 12: Suppress a Record

**User says:** "Viking Plumbing said they're not interested — stop contacting them."

**Under the hood:**
1. `/outbound` runs `agent-outbound log boise-plumbers --prospect "Viking Plumbing" --action opted_out --note "Not interested"`
2. Orchestrator sets `sequence_status = opted_out`, `suppressed = true`, `suppressed_reason = opt_out`
3. Adds Viking's email and phone to the per-list suppression table
4. `sync-crm` flips `do_not_contact = true` on the CRM Company record
5. No further sends or visits on this record

## Flow 13: Swap a Tool

**User says:** "I disconnected Hunter and connected Apollo. Update the email-finding step."

**Under the hood:**
1. `/outbound` runs `agent-outbound config author boise-plumbers "swap the email-finding step from Hunter to Apollo"`
2. `author-config` confirms Apollo is connected, rewrites the step's tool reference
3. Next enrichment run uses Apollo — no code changes

## Flow 14: Add a Re-Engage Sequence

**User says:** "For any record that completed the default sequence but has a trigger score above 70, start a re-engage sequence 30 days later."

**Under the hood:**
1. `/outbound` runs `agent-outbound config author boise-plumbers "add a re_engage sequence: ..."`
2. `author-config` adds `sequences.re_engage` with a `start_when` condition and a new three-step cadence
3. Next sequence run picks up eligible records and starts them on the new sequence

## Flow 15: Watch a Long-Running Operation

**User says:** (in a second terminal) "I want to see what's happening while enrichment runs."

**What they do:**
1. Terminal 1: `/outbound enrich boise-plumbers`
2. Terminal 2: `npx agent-outbound watch ./boise-plumbers`

**What they see:**
The watch terminal shows recent activity, then switches to a live stream — each record being processed, each AI SDK step, each tool invocation. Ctrl+C to exit. See `watch.md`.

## Flow 16: Forget a Prospect (GDPR-style)

**User says:** "That prospect asked to be removed from everything."

**Under the hood:**
1. `/outbound` runs `agent-outbound forget --email someone@example.com`
2. Orchestrator adds to global suppression, clears PII columns on matching records, writes to compliance audit log, flips `do_not_contact` in the CRM
