# User Flows

How the operator interacts with the system and what happens under the hood. All interactions go through `/outbound`, which runs CLI commands.

## Flow 1: Create a New List

**User says:** "Create a new list called boise-dental for dental offices in Boise."

**Under the hood:**
1. `/outbound` runs `agent-outbound list create boise-dental`
2. CLI creates the list home directory with a blank `outbound.yaml` and initializes the canonical CSV
3. `/outbound` runs `agent-outbound config author boise-dental "add searches for dental offices in Boise"` — the `author-config` action prompts Claude, which searches available MCP tools for business search capabilities and produces initial `source.searches` config
4. Config is written to `outbound.yaml`

## Flow 2: Source Leads

**User says:** "Source about 100 leads for boise-dental."

**Under the hood:**
1. `/outbound` runs `agent-outbound source boise-dental --limit 100`
2. Orchestrator reads config, runs all searches in parallel
3. For each search: calls `execute-step` — Claude calls the MCP tool referenced in the search config, returns business data
4. Orchestrator writes rows, deduplicates, assigns `_row_id`
5. Orchestrator runs filters on all rows with stale filter results: for each filter, calls `execute-step` then `evaluate-condition`
6. Writes filter results and aggregate pass/fail
7. Progress streams to stdout throughout — `/outbound` reports summary

## Flow 3: Add an Enrichment Step

**User says:** "Add a step to find the key decision-maker and their email."

**Under the hood:**
1. `/outbound` runs `agent-outbound config author boise-dental "add a step to find the key decision-maker and their email"`
2. The `author-config` action prompts Claude with the user's request, current config, current CSV state, and available MCP tools
3. Claude searches available tools, finds an email-finding tool, writes a new enrichment step config with tool reference, args (bound to CSV columns), output columns, and dependencies
4. Orchestrator validates the config structure (Zod) and writes it to `outbound.yaml`

## Flow 4: Run Enrichment

**User says:** "Enrich boise-dental."

**Under the hood:**
1. `/outbound` runs `agent-outbound enrich boise-dental`
2. Orchestrator reads config, builds dependency graph, processes steps in dependency order (parallel sources within each level, parallel rows within each source)
3. For each step, for each row: checks staleness, calls `execute-step` with step config + row data
4. Claude executes (calls MCP tools, does research, writes copy), returns structured output — all streamed to stdout
5. Orchestrator maps outputs to CSV columns, updates staleness cache
6. `/outbound` sees the streaming progress and reports summary

## Flow 5: Launch (Step 1)

**User says:** "Create drafts for the ready leads."

**Under the hood:**
1. `/outbound` runs `agent-outbound launch draft boise-dental`
2. Orchestrator reads sequence step 1 config, for each selected row:
   - Calls `execute-step` — Claude creates a draft via the MCP tool referenced in config
   - Orchestrator stores draft ID and status in CSV
3. User reviews drafts in their email client

**User says:** "Send them."

4. `/outbound` runs `agent-outbound launch send boise-dental`
5. Orchestrator calls `execute-step` for each draft — Claude sends via the configured tool
6. Orchestrator stores thread IDs, initializes sequence state

## Flow 6: Daily Sequencer Run

**User says:** "What do I need to do today?"

**Under the hood:**
1. `/outbound` runs `agent-outbound sequence status boise-dental` for overview
2. `/outbound` runs `agent-outbound sequence run boise-dental` — orchestrator checks for replies (via `execute-step` in parallel), finds due actions, creates follow-up drafts (in parallel), produces call/manual lists
3. `/outbound` presents due actions to the operator
4. When follow-up drafts are approved: `/outbound` runs `agent-outbound followup send boise-dental`, orchestrator advances sequence state

## Flow 7: Log an Outcome

**User says:** "I called Beacon Plumbing — not interested."

**Under the hood:**
1. `/outbound` runs `agent-outbound log boise-dental --prospect "Beacon Plumbing" --action opted_out --note "not interested"`
2. Orchestrator updates CSV sequence state and outcome notes

## Flow 8: Swap a Tool

**User says:** "I disconnected Hunter and connected Apollo. Update the email-finding step."

**Under the hood:**
1. `/outbound` runs `agent-outbound config author boise-dental "swap the email-finding step from Hunter to Apollo"`
2. The `author-config` action prompts Claude with the current step config and available MCP tools (Apollo is now connected)
3. Claude finds the Apollo email tool, confirms it can satisfy the same capability, rewrites the step config
4. Orchestrator validates and writes the updated config
5. Next enrichment run uses Apollo instead of Hunter — no code changes

## Flow 9: Sync to Destination

**User says:** "Sync the list to Google Sheets."

**Under the hood:**
1. `/outbound` runs `agent-outbound sync boise-dental`
2. Orchestrator reads the destination config from `outbound.yaml`
3. Calls the `sync-destination` action — a single Claude session that reads the local CSV file, reads the Google Sheet, and syncs owned columns while preserving any additional data in the sheet
4. Progress streams to stdout — the user sees the read, diff, and write operations as they happen
