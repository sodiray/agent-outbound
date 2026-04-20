import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readGlobalEnv } from '../orchestrator/runtime/env.js';
import { listConnectedToolkits, validateComposioKey } from '../orchestrator/runtime/mcp.js';
import { validateAnthropicKey } from '../orchestrator/runtime/anthropic.js';

const detectLists = (): string[] => {
  const cwd = process.cwd();
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(cwd, e.name, 'outbound.yaml')))
      .map((e) => e.name);
  } catch {
    return [];
  }
};

const checkState = async () => {
  const env = readGlobalEnv();
  const composioKey = String(env.COMPOSIO_API_KEY || process.env.COMPOSIO_API_KEY || '').trim();
  const anthropicKey = String(env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim();

  const composio = composioKey
    ? await validateComposioKey(composioKey).catch(() => ({ ok: false, toolkits: [] as string[], error: 'validation failed' }))
    : { ok: false, toolkits: [] as string[], error: 'not configured' };

  const anthropic = anthropicKey
    ? await validateAnthropicKey(anthropicKey).catch(() => ({ ok: false, error: 'validation failed' }))
    : { ok: false, error: 'not configured' };

  const toolkits: string[] = composio.ok
    ? await listConnectedToolkits(composioKey).catch(() => [] as string[])
    : [];

  const lists = detectLists();

  return { composioKey: Boolean(composioKey), composioValid: Boolean(composio.ok), anthropicKey: Boolean(anthropicKey), anthropicValid: Boolean(anthropic.ok), toolkits, lists };
};

export const onboardCommand = async () => {
  const state = await checkState();

  const composioStatus = state.composioValid
    ? '✓ configured and valid'
    : state.composioKey
      ? '⚠ key found but validation failed'
      : '✗ not configured';

  const anthropicStatus = state.anthropicValid
    ? '✓ configured and valid'
    : state.anthropicKey
      ? '⚠ key found but validation failed'
      : '✗ not configured';

  const toolkitStatus = state.toolkits.length > 0
    ? state.toolkits.join(', ')
    : state.composioValid
      ? '(none connected yet)'
      : '(requires valid Composio key)';

  const listStatus = state.lists.length > 0
    ? state.lists.join(', ')
    : '(none)';

  const output = `# Agent Outbound

You are now helping the user set up and operate Agent Outbound — a local CLI tool that builds targeted prospect lists, enriches them with public data, scores them for relevance, and runs multi-step outreach sequences.

The tool is config-driven. Each "list" is a self-contained pipeline: source → enrich → score → sequence. State lives in SQLite. Intelligence comes from you (Claude) being called by the orchestrator at decision points — you are the AI layer that makes search, enrichment, and scoring work.

The user's job: define WHO they want to reach and WHY.
Your job: translate that into config, run the pipeline, and iterate.

---

## Current State

- Anthropic API key: ${anthropicStatus}
- Composio API key: ${composioStatus}
- Connected toolkits: ${toolkitStatus}
- Existing lists: ${listStatus}
- Working directory: ${process.cwd()}

---

## Setup Decisions

Walk the user through these in order. Skip any that are already resolved (see Current State above).

### 1. API Keys

Both keys are required before any pipeline work can happen.

**Anthropic API key** — Powers the LLM layer (Claude). Get one from console.anthropic.com.
**Composio API key** — Connects external tools (Google Maps, Hunter, Firecrawl, etc.). Get one from platform.composio.dev.

Once you have both keys, run:
\`\`\`
npx agent-outbound init --composio-api-key KEY --anthropic-api-key KEY --non-interactive
\`\`\`

### 2. Toolkit Connections

Based on what the user wants to accomplish, recommend which toolkits to connect on Composio. Common stacks by use case:

- **Local services** (restaurants, dentists, gyms, salons): GOOGLEMAPS + FIRECRAWL + HUNTER
- **B2B / SaaS companies**: APOLLO + FIRECRAWL + HUNTER
- **Real estate / property**: GOOGLEMAPS + FIRECRAWL
- **E-commerce / DTC brands**: FIRECRAWL + HUNTER + APOLLO

Core toolkits and what they provide:
- GOOGLEMAPS — Local business search (name, address, phone, rating, hours, category)
- FIRECRAWL — Website content scraping (about pages, team pages, blog posts, job listings)
- HUNTER — Email discovery and verification
- APOLLO — B2B contact/company search with email
- GMAIL — Outbound email delivery for sequences
- TWILIO — SMS delivery for sequences

To connect a toolkit, the user visits their Composio dashboard. Show them the URL:
\`\`\`
npx agent-outbound auth <TOOLKIT_NAME>
\`\`\`

After connecting, verify with:
\`\`\`
npx agent-outbound auth --list
\`\`\`

### 3. First List Definition

Ask the user:
- **Who** are you trying to reach? (industry, business type, role)
- **Where** are they? (city, region, radius — or "anywhere")
- **Why** would they want what you're selling? (the pain/trigger)
- **What signals** indicate a great prospect vs. a bad one?

Then create the list:
\`\`\`
npx agent-outbound list create <slug-name> --description "One sentence: who, where, why"
\`\`\`

### 4. Configure the Pipeline

Use natural language to set up sourcing, enrichment, and scoring in one shot:
\`\`\`
npx agent-outbound config author <list> --request "<describe what to search for, what data to enrich with, and how to score them>"
\`\`\`

Example request for a dental office list:
"Search Google Maps for dental offices within 25 miles of Boise ID. Filter out large chains (10+ locations). Enrich with website scrape focusing on about page, team size, and services offered. Look up primary email via Hunter. Score fit based on independent practice with 3-15 employees. Score trigger based on hiring activity, recent website updates, or expansion signals."

You can iterate on config with additional requests:
\`\`\`
npx agent-outbound config author <list> --request "add a step that scrapes their Google reviews for sentiment"
npx agent-outbound config author <list> --request "change fit scoring to also penalize franchises"
\`\`\`

### 5. Enrichment Strategy

Enrichment steps run in dependency order. Common patterns by vertical:

**Local services:**
1. website-scrape (about page, services, team info)
2. email-lookup (primary contact email)
3. social-presence (Instagram, Facebook activity)
4. review-sentiment (Google/Yelp review analysis)

**B2B / SaaS:**
1. website-scrape (product, pricing, team, blog)
2. job-postings (hiring signals from careers page)
3. email-lookup (decision maker contact)
4. linkedin-presence (company size, growth)
5. tech-stack (what tools they use)

**Real estate:**
1. website-scrape (listings, agent bios)
2. public-records (property data, transaction history)
3. email-lookup (agent/broker contact)

### 6. Scoring Criteria

Two axes:
- **Fit** — Does this business match the ideal customer profile? (static attributes: size, industry, location, revenue)
- **Trigger** — Is there a timely reason to reach out NOW? (dynamic signals: hiring, expansion, new funding, pain indicators)

Ask the user what makes someone a perfect fit and what signals urgency. Feed that into the config author request.

---

## Operating the Pipeline

### Daily workflow
\`\`\`
npx agent-outbound run <list> --more 20     # Get 20 more prospects, enrich, score
npx agent-outbound list info <list>          # Check status and score distribution
npx agent-outbound dashboard                 # Activity summary across lists
\`\`\`

### Individual phases (when you need control)
\`\`\`
npx agent-outbound source <list>             # Run all configured searches
npx agent-outbound source <list> --more N    # Paginate for N new (deduplicated) records
npx agent-outbound enrich <list>             # Run all enrichment steps
npx agent-outbound enrich <list> --step website-scrape --limit 5    # Target specific step/records
npx agent-outbound enrich <list> --where "fit_score > 70"           # Enrich only high-fit records
npx agent-outbound score <list>              # Score/rank all records
\`\`\`

### Trimming and cleanup
\`\`\`
npx agent-outbound remove <list> --where "fit_score < 30"     # Drop low-quality records
npx agent-outbound remove <list> --keep-top 50 --sort-by fit_score   # Keep only top 50
npx agent-outbound remove <list> --row ROW_ID                 # Delete one specific record
\`\`\`

### Sequencing (multi-step outreach)
\`\`\`
npx agent-outbound launch draft <list>       # Generate outreach message drafts
npx agent-outbound launch send <list>        # Send first-step messages
npx agent-outbound followup send <list>      # Advance to next sequence steps
npx agent-outbound sequence run <list>       # Full state machine advance
npx agent-outbound sequence status <list>    # See where records are in the funnel
\`\`\`

### In-person visits
\`\`\`
npx agent-outbound route plan <list>         # Generate optimized visit route
npx agent-outbound visits today <list>       # Today's scheduled stops
\`\`\`

### Config iteration
\`\`\`
npx agent-outbound config read <list>        # See current YAML config
npx agent-outbound config author <list> --request "..."   # Modify with natural language
npx agent-outbound config author <list> --request "remove the social-presence step" --force
npx agent-outbound refresh-tools <list>      # Re-resolve tools after connecting new toolkits
\`\`\`

### Monitoring
\`\`\`
npx agent-outbound dashboard --all-lists --alerts    # Full overview with connectivity checks
npx agent-outbound watch <list>                      # Live activity stream
npx agent-outbound lists                             # Overview of all lists in cwd
\`\`\`

---

## Workflow Guidance

- **Start small.** Source 20-30 records, enrich, review scores before scaling up. This validates the config works before burning tokens on 500 records.
- **Use \`list info\` constantly.** It's your feedback loop — check score distributions, record counts, and status breakdowns after every operation.
- **Config is iterative.** Don't try to get it perfect on the first \`config author\` call. Run a small batch, review results, refine scoring/enrichment, repeat.
- **Review before sending.** Always have the user validate outreach drafts (\`launch draft\`) before sending (\`launch send\`). Outbound is high-stakes — bad emails burn the domain.
- **One list per vertical.** Don't mix dentists and restaurants in one list. Different verticals need different enrichment steps, scoring criteria, and outreach angles.
- **The run command is your friend.** \`run <list> --more N\` is the single command for "get me N more prospects, fully processed." Use it for daily pipeline operation.

---

## How It Works (Architecture)

You don't need to understand this to use the tool, but it helps when debugging.

- **SQLite** — Each list has a \`prospects.db\` with full schema (records, staleness, embeddings, search state, idempotency, suppression). Foreign key cascades handle cleanup.
- **Staleness tracking** — SHA-256 hash of each record's input data per enrichment step. Only re-processes records whose inputs changed. This makes re-runs cheap.
- **Dependency DAG** — Enrichment steps declare dependencies. The orchestrator resolves topological order and runs levels in parallel.
- **Dedup** — Identity fields (configurable, default: business_name + address) detect duplicates at ingest time. Embedding similarity catches fuzzy matches.
- **Tool discovery** — At runtime, the orchestrator asks Composio "what tools are available?" and maps them to configured step references. No hardcoded tool IDs.
- **Pagination state** — Search results track position. \`--more N\` resumes from where the last search stopped, avoiding re-fetching.
`;

  process.stdout.write(output);
};
