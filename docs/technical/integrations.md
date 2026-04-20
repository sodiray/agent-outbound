# Integrations

Integration behavior is tool-agnostic. See `tool-agnosticism.md` for the engineering spec.

## Principles

- Product code never hardcodes vendor/tool names for capabilities.
- Config author discovers, resolves, and pins toolkits/tools at config time.
- Resolved tool slugs and schemas are stored in the config (`tool.tools` + `tool_catalog`).
- At runtime, tool schemas are read from the config. No Composio discovery calls at runtime.
- Missing required toolkits are hard errors (no silent fallback).

## Config Surfaces

- Step-level tool pinning: `config.tool`
- Visit routing tool pinning: `channels.visit.tool`
- CRM tool pinning: `crm.tool`
- Resolved schemas: `tool_catalog` (top-level)

Each tool spec uses the same `ToolSpec` shape (`toolkits`, `tools`). The `tool_catalog` stores the full parameter schemas for every resolved tool slug, populated at config authoring time.

## Resolution Flow

Tool resolution happens at **config authoring time**, not at runtime:

1. Config author adds a step with `toolkits: ['FIRECRAWL']`
2. System calls `COMPOSIO_SEARCH_TOOLS` to resolve toolkit → tool slugs
3. System calls `COMPOSIO_GET_TOOL_SCHEMAS` to fetch parameter schemas
4. Resolved slugs written to `tool.tools`; schemas written to `tool_catalog`
5. At runtime, `loadTools` reads from `tool_catalog` directly

Re-resolution happens when:
- A `modify_*` config op touches a tool spec
- The operator runs `refresh-tools` explicitly

See `runtime.md § Tool Loading` and `performance.md § Priority 1`.

## Runtime Execution

`loadTools` reads schemas from the config's `tool_catalog`, synthesizes Vercel AI SDK tool definitions, and binds `execute()` to `COMPOSIO_MULTI_EXECUTE_TOOL`. No provider lookup tables are used by orchestrator code.
