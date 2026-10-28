# Models

Agent-Outbound is provider-agnostic. The operator decides which LLM provider and which specific model runs every step in the pipeline.

## Why This Matters

The pipeline runs a lot of LLM calls. A single `enrich` pass over 250 records with five steps is well over a thousand calls. At that volume, the choice between "the smartest model" and "the cheapest capable model" is the difference between pennies and hundreds of dollars per run.

Some steps deserve the smartest model (email copy that lands). Most don't (deciding whether a website has a "Services" page). Pinning model choice per step lets the operator spend where it matters and save everywhere else.

## Supported Providers

- **Anthropic** — Claude models (Opus, Sonnet, Haiku). Strong tool-calling, strong structured output, prompt caching for repeat-prefix workloads.
- **DeepInfra** — pay-per-token hosting for open-source models (Llama 3.x, DeepSeek, Qwen, Mistral, and others). Much cheaper per token; variable quality; tool-calling capability depends on the specific model.

Both keys are optional, but **at least one must be provided**. Connecting both is common — operators typically run most of the pipeline on DeepInfra for cost and keep Anthropic for copywriting.

## Jev typed decisions

Jev is a built-in optional dependency for pipeline `decide` steps. It is not a
general LLM provider and does not participate in `default_model` resolution.
Configure it only when a pipeline contains a `decide` step:

```yaml
ai:
  decide:
    model: jev-1.13.0
    api_key_env: JEV_API_KEY
```

The API key remains in the environment, never in configuration. Validation
requires the model and the configured key only for projects that use `decide`.
Jev returns typed Choice, Score, and Noul answers with calibrated probabilities
and confidence, and its input/output token usage appears in AI usage reports.

## Onboarding

During `agent-outbound init`, the tool walks the operator through each supported provider. Each is skippable; the operator can add or swap providers later by re-running `init` or `models refresh`.

**Anthropic.** If the operator provides an Anthropic API key, the tool validates it and fetches the full list of models visible to that key. Every model returned is available to pin. The operator doesn't pick — Anthropic's catalog is small and closed, and there's no reason to hide models.

**DeepInfra.** DeepInfra hosts hundreds of models and the catalog churns. Forcing the operator to opt-in prevents typos and keeps the usable list small and meaningful. If the operator provides a DeepInfra API key, the tool:

1. Validates the key.
2. Shows a short **recommended list** (6–8 curated models covering the useful tiers — a fast small model, a mid-size Llama, a large Llama, DeepSeek V3, Qwen 72B, etc.) as multi-select checkboxes.
3. Offers a free-text step: "Paste any additional DeepInfra model IDs you want to support (one per line)." Every entry here is validated against DeepInfra's model-list endpoint before it's saved — typos fail loudly at init, not at runtime.

The resulting set — including OpenRouter's returned model metadata — is stored
in `~/.agent-outbound/models.json`. This is the canonical "models supported on
this machine" list. For OpenRouter, the cached metadata includes each model's
`supported_parameters`; Agent-Outbound uses it to decide whether it may send
sampling settings such as `temperature`.

## Listing and Managing Models

```
agent-outbound models                          # list everything supported
agent-outbound models --provider deepinfra     # filter by provider
agent-outbound models --search llama           # filter by substring
agent-outbound models --json                   # machine-readable

agent-outbound models add deepinfra/<model-id>      # quick-add a DeepInfra model (validated)
agent-outbound models remove deepinfra/<model-id>   # drop a model from the supported list
agent-outbound models refresh                       # re-fetch Anthropic, re-open DeepInfra selector
```

`models` reads entirely from local state — no network round-trip. Listings are instant. The agent uses the same data when the operator asks "what models are available?"

`refresh` is the escape hatch. Anthropic ships a new model; DeepInfra's catalog changes; the operator wants to add three models without going through the interactive picker — `refresh` re-fetches Anthropic's list and re-opens the DeepInfra selector with current picks pre-checked.

## Validation

When a step references a model, the tool checks it against `models.json` — no network call. Two failure modes:

- **Format error** — `model` must be `provider/model-id`. Missing prefix, unknown provider, or malformed string rejects at config save.
- **Unsupported model** — valid format, but the specific model isn't in the operator's supported list. The error explains what to do:

  > `deepinfra/meta-llama/Meta-Llama-3.1-405B-Instruct` isn't in your supported models list.
  > Add it with: `agent-outbound models add deepinfra/meta-llama/Meta-Llama-3.1-405B-Instruct`
  > Or refresh the full list with: `agent-outbound models refresh`

This runs at config save (in `author-config`) and again at the start of every `sequence run` / `enrich` / `source` — stale configs fail loud before they burn a single LLM call.

## Sampling and OpenRouter capabilities

Evaluation and research roles request `temperature: 0` for deterministic work
when the chosen model accepts temperature. A per-step `temperature` setting
from `0` through `2` overrides that default for any LLM-backed pipeline step:

```yaml
- kind: enrich
  id: condense_evidence
  model: openrouter/openai/gpt-4.1-mini
  temperature: 0
```

For OpenRouter, this is capability-aware: the value is sent only if the local
inventory says the model supports `temperature`. A known unsupported model
causes `config validate` to fail clearly. When capability metadata is absent or
stale, Agent-Outbound omits temperature rather than risking a rejected request;
set `AO_DEBUG_LLM=1` to see that decision and run `agent-outbound models refresh`
to refresh the metadata. Sampling is part of a step definition, so changing it
makes memoized/free LLM work stale. It does not replay settled paid or
side-effecting effects, whose freshness keys are their resolved arguments.

## Picking a Model Per Step

Every step in `outbound.yaml` that drives an LLM call can pin a model using the `provider/model` format:

```yaml
enrich:
  - id: has-website
    config:
      model: deepinfra/meta-llama/Meta-Llama-3.1-8B-Instruct   # cheap eval
  - id: decision-maker
    config:
      model: anthropic/claude-sonnet-4-6                        # research + tool use
sequences:
  default:
    steps:
      - id: email-day-0
        config:
          model: anthropic/claude-opus-4-6                      # copywriting
```

The `provider/` prefix is required — no shorthand. This keeps configs unambiguous and self-documenting.

## Defaults

To avoid repeating the same model across dozens of steps, the operator can set top-level defaults:

```yaml
ai:
  default_model: anthropic/claude-sonnet-4-6
  defaults:
    evaluation: anthropic/claude-haiku-4-5-20251001     # used by filter/condition/scoring actions
    copywriting: anthropic/claude-opus-4-6              # used by drafting actions
```

Resolution order when a step runs:

1. The step's own `model:` field, if set.
2. The action-role default (evaluation / research / copywriting) for whichever action is running.
3. The top-level `ai.default_model`.

## Where Model Choice Matters

Places where the operator can pin a model:

- Every **sourcing search** and **sourcing filter**
- Every **enrichment step**
- **Fit scoring** and **trigger scoring** — axis-level defaults plus per-criterion overrides
- Every **sequence step** and the sequence-level **reply check**
- **CRM sync** (when it runs)

## Trade-offs to Think About

- **Tool-calling reliability.** Steps that invoke Composio tools (research, sourcing, scraping) need a model that's good at tool use. Claude Sonnet/Opus and the larger DeepInfra models (Llama 3.1 70B, DeepSeek V3, Qwen 2.5 72B) handle it. Smaller DeepInfra models often don't.
- **Structured output reliability.** The pipeline validates every response against a schema. Frontier models hit schemas reliably; smaller open-source models sometimes return JSON that doesn't validate, causing the step to fail on that record. The tool has a free-form-text fallback to recover when it can, but reliability varies by model.
- **Prompt caching.** Anthropic supports ephemeral prompt caching; over a big batch run, the effective cost per call drops substantially on repeat prefixes. DeepInfra doesn't. If you're running the same system prompt across 500 records, Anthropic's cached rate can beat DeepInfra's list rate.
- **Copywriting quality.** Email copy is usually worth the Opus-tier spend. Eval and classification almost never are.

## How the Operator Chooses

The operator doesn't write this by hand. They describe intent to the agent:

> "Use DeepInfra's Llama 70B for enrichment and Anthropic Opus for the email drafts."

The agent updates the config's `ai.defaults` and per-step `model:` fields accordingly. They can always come back and tune individual steps later:

> "Switch the hiring-check step to a cheaper model — it's costing too much per record."

## Cost Consequences

How model choice shows up in spend is covered in [AI Usage](./ai-usage.md). The short version: tokens are always tracked regardless of provider, and dollar figures are recorded whenever the provider reports them (Anthropic computes from published rates; DeepInfra returns an `estimated_cost` on every response). The tool never maintains its own pricing tables.
