# AI Usage

The tool tracks one kind of spend: **AI usage** — the tokens (and, when the provider reports it, the dollars) that flow through the LLM on behalf of the operator. It does not track third-party tool costs (Firecrawl, SerpAPI, Lob, Handwrytten, etc.), because it can't see them reliably. This doc explains the line the tool draws and why.

## Providers

The operator picks which LLM provider to use per step. Supported providers:

- **Anthropic** — Claude models (Opus, Sonnet, Haiku) direct from Anthropic's API.
- **DeepInfra** — a pay-per-token marketplace hosting open-source models (Llama, DeepSeek, Qwen, Mistral, and many more). Typically much cheaper than frontier proprietary models, at the cost of some capability on the hardest tasks.

Providers are connected during `agent-outbound init`. At least one key is required; most operators connect both. For DeepInfra, the operator selects which specific models to support at init time; only those appear in listings and can be pinned in config. See [Models](./models.md).

Every step in config pins a model using a `provider/model` identifier — e.g. `anthropic/claude-sonnet-4-6` or `deepinfra/meta-llama/Meta-Llama-3.1-70B-Instruct`.

## What the Tool Knows

Every time the tool calls an LLM — for sourcing, enrichment, scoring, reply classification, sequence condition evaluation, config authoring — it knows:

- How many input tokens went in
- How many output tokens came back
- Which model (and provider) was used
- Which list, step, and record the call belongs to

That is the honest, always-present signal. On top of that, the tool captures **dollar cost when the provider reports it**:

- **Anthropic** — dollar cost is computed from Anthropic's published per-model rates by the AI SDK on every response.
- **DeepInfra** — dollar cost comes back as an `estimated_cost` field on every chat completion. The tool reads it directly off the response.

The tool never maintains its own pricing tables. If a provider doesn't report a dollar figure on a given response, the tool records tokens only and the dollar figure for that call shows as `—`.

## Tokens Are the Primary Signal

Tokens are the number to trust. They're always present, they're provider-agnostic, and they give the operator a relative sense of which steps are expensive regardless of which model is pinned. A step chewing 30k tokens per record is a step to look at — whether that's pennies on DeepInfra or dollars on Opus.

Dollars are useful when the provider hands them over, but they're a convenience on top of the real signal.

## What the Tool Doesn't Know

Every time the tool invokes a third-party tool through Composio — a Firecrawl scrape, a SerpAPI search, a Lob mailer, a Handwrytten note, a Twilio SMS — the dollar cost of that call is determined by the third party's pricing plan, volume tier, contract, and billing cycle. The tool has no visibility into any of that.

Rather than ask the operator to configure estimated costs per tool (which rot instantly when plans change, discounts apply, or batches bill differently), the tool is explicit that it doesn't know.

For third-party tools, the tool tracks **invocation counts** as telemetry — how many times `FIRECRAWL_SCRAPE` was called, by which step, on which list, in what time window. Counts are useful (runaway loops, unexpected volume, capacity planning) without pretending to be cost.

## The Two Reads

### AI usage — tokens and dollars

```
agent-outbound ai-usage boise-plumbers
agent-outbound ai-usage boise-plumbers --step hiring-check
agent-outbound ai-usage boise-plumbers --period 7d --group-by step
agent-outbound ai-usage boise-plumbers --record <row_id>
```

Returns token counts and dollar costs scoped however the agent asks. Rolls up by step, by record, by run, by period. Dollar columns show `—` for any calls where the provider didn't report cost.

Exposed as a view too (`ai_usage`) so the agent can query and join against it in SQL.

### Tool usage — call counts only

```
agent-outbound usage boise-plumbers
agent-outbound usage boise-plumbers --toolkit FIRECRAWL
agent-outbound usage boise-plumbers --step hiring-check --period 7d
```

Returns invocation counts per toolkit, tool, step, record, and period. No dollars — counts.

Exposed as a view (`tool_usage`) for SQL access.

## Budgets

Both spend types can be capped, and caps are enforced.

### LLM budgets

LLM budgets can be set in **tokens** (always enforceable) or **dollars** (enforceable only for calls where the provider reported a cost).

```yaml
budgets:
  llm:
    list_daily_tokens: 2_000_000
    list_daily_usd: 20
    step_daily_tokens:
      hiring-check: 500_000
    step_daily_usd:
      hiring-check: 5
      website-scrape: 8
```

Before any LLM call, the tool checks the relevant budgets. If the projected call would exceed a cap, the step halts — no more records are processed until the window resets or the operator raises the cap. Token caps work across every provider. Dollar caps only count calls whose provider reported a dollar figure; calls without one contribute to the token total but not the dollar total. The agent gets a structured error with the current usage and the ceiling so it can explain the stop to the operator.

### Tool-invocation budgets

```yaml
budgets:
  tools:
    FIRECRAWL_SCRAPE:
      daily: 500
      weekly: 3000
    SERPAPI_SEARCH:
      daily: 200
```

Cap counts, not dollars. Hits the same enforcement path — the step halts when a cap would be exceeded. The agent can translate "500 Firecrawl calls today" into whatever the operator's billing plan makes of it.

Budgets are optional. If not set, there are no caps — the tool still tracks usage and exposes it for reads.

## Sample / Dry-Run Reports Both

Every costly action supports a `--sample N` or `--dry-run` that reports projected spend before committing. See [Safety and Preview](./safety-and-preview.md).

```
agent-outbound enrich boise-plumbers --sample 5
```

Sample output includes:
- Projected tokens (input + output) if run at full scale
- Projected dollars (for providers that report cost) if run at full scale
- Projected tool-call counts per toolkit if run at full scale

## Sample output

```
=== sample: enrich boise-plumbers (5 of 247 records) ===

Step: hiring-check  (deepinfra/meta-llama/Meta-Llama-3.1-70B-Instruct)
  Ran on 5 records.
  Tokens (sample): 48,200 in / 3,800 out
  Projected at 247 records: ~2.58M tokens
  LLM cost (sample): $0.018
  Projected at 247 records: $0.89
  Tool calls (sample): FIRECRAWL_SCRAPE × 5, SERPAPI_SEARCH × 9
  Projected at 247 records: FIRECRAWL_SCRAPE × 247, SERPAPI_SEARCH × ~445

Step: website-scrape  (anthropic/claude-sonnet-4-6)
  Ran on 5 records.
  Tokens (sample): 12,400 in / 2,100 out
  Projected at 247 records: ~716K tokens
  LLM cost (sample): $0.12
  Projected at 247 records: $5.93
  Tool calls (sample): FIRECRAWL_SCRAPE × 5
  Projected at 247 records: FIRECRAWL_SCRAPE × 247

Not tracked: Firecrawl / SerpAPI dollar costs (billed by those providers).
Your AI token budget for this list today: 340k used / 2M cap.
Your AI dollar budget for this list today: $0.82 used / $20.00 cap.
```

The sample is the agent's primary way to advise the operator before a big run. The agent reads it and can say *"this will cost roughly $6.82 in AI and 3.3M tokens, and make ~500 Firecrawl calls — your Firecrawl plan caps at 1000/day."*

## What the Operator Sees

The operator asks questions like:

> "How much has this list cost me in AI this month?"
> "Which step is burning the most tokens?"
> "Are we about to hit the Firecrawl cap?"
> "Why did the enrichment stop?"

The agent reads `ai-usage` or `usage` and answers with specific numbers. If a budget halted a run, the agent explains *which* budget, *what* the current usage is, and offers to raise the cap.

## Scope, Plainly Stated

**Agent-Outbound tracks LLM tokens always and LLM dollars when the provider hands them over.** Third-party tool costs (Firecrawl, SerpAPI, Lob, Handwrytten, Twilio, Instantly, CRM providers, and all other toolkits) are billed by those providers directly and are not visible here. The tool tracks how many times each is called, but cannot translate that to dollars.

This scoping is deliberate. Attempting to model third-party costs — or to maintain local pricing tables for every LLM provider — would require operator-supplied rate tables that go stale instantly, and the resulting numbers would be wrong in ways that look right. Honest token counts plus pass-through dollars is more useful than a blended estimate pretending to be a total.

## What AI Usage Isn't

- **Not a billing product.** The tool doesn't charge anyone. Dollar figures are pass-through from the LLM provider's own usage response.
- **Not a total cost of ownership view.** For that, the operator combines this data with their own knowledge of their third-party plans.
- **Not a cross-list rollup.** Usage is scoped to one list at a time. The agent aggregates across lists when asked.
- **Not retroactive pricing.** If a provider changes its prices, historical rows keep the dollar figure the provider reported at the time. The tool reports what was actually spent.
