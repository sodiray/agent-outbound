# Plan: Pluggable Tool Providers (non-Composio MCP + CLI support)

## Goal
Let an agent-outbound user plug in tools that are NOT built into Composio:
1. A standard **MCP server** they provide (stdio or http).
2. A plain **command/CLI** they provide (argv in, JSON on stdout).

Composio remains the default provider; existing configs keep working unchanged.

First consumer: source Boise businesses via `mission/utilities/maps-search` (a Google
Places CLI) instead of Yelp — because Google Maps returns each business's OWN website.

## Decisions (locked)
- Build the **full ToolProvider abstraction** (not a one-off hack).
- Support **both** a generic MCP provider AND a generic command/CLI provider.
- Registry is **per-list**: an `mcp.json` lives in the list directory next to
  `outbound.yaml`. (Composio needs no entry — it's implicit.)
- Primary sourcing provider going forward = **Google Maps only** (drop Yelp for now).
  Because Maps returns the website, we can skip the separate "find website" enrich step.

## Architecture

### The ToolProvider interface (new: `src/orchestrator/runtime/providers/types.ts`)
```ts
export interface ToolProvider {
  id: string;                          // e.g. "composio", or the per-list server name
  searchTools(queries, limit): Promise<ProviderToolSchema[]>;  // discovery for author
  getSchemas(slugs: string[]): Promise<ProviderToolSchema[]>;  // exact schemas
  executeTool(slug: string, args): Promise<unknown>;           // THE execute seam
  listToolkits?(): Promise<string[]>;  // composio-only; optional
  checkAvailability?(toolkits): Promise<Record<string, boolean>>; // composio-only
  close?(): Promise<void>;
}
export type ProviderToolSchema = {
  slug: string; server: string; toolkit?: string;
  name?: string; description?: string; input_schema?: Record<string, unknown>;
};
```

### Implementations
- **ComposioProvider** (`providers/composio.ts`): move the existing logic verbatim —
  `searchToolSchemas`/`fetchToolSchemas`/`resolveToolkitToolSlugs`/`executeComposioTool`
  (the meta-tool calls, session threading, result unwrapping). Behavior unchanged.
- **McpProvider** (`providers/mcp.ts`): connects to a user MCP server via the MCP SDK
  (`StdioClientTransport` or `StreamableHTTPClientTransport`). Uses standard
  `client.listTools()` (schemas come back directly) and `client.callTool()`. `searchTools`
  is a client-side filter over `listTools()`; `getSchemas` filters by name.
- **CommandProvider** (`providers/command.ts`): spawns a user CLI. Because a raw CLI has
  no schema-introspection, the registry entry DECLARES the tools (name, description,
  JSON input schema, and an argv template). `executeTool` builds argv from args, runs the
  process, parses stdout as JSON. `searchTools`/`getSchemas` read the declared tools.

### Provider registry (new: `src/orchestrator/lib/provider-registry.ts`)
Per-list file `<listDir>/mcp.json`:
```jsonc
{
  "mcpServers": {
    "googlemaps": {                       // server name = provider id
      "type": "command",                  // "stdio" | "http" | "command"
      "command": "node",
      "args": ["/abs/path/maps-search/src/cli.js"],
      "env": { "GOOGLE_MAPS_API_KEY": "${GOOGLE_MAPS_API_KEY}" },
      "tools": [                          // REQUIRED for type:"command" (declared schema)
        {
          "slug": "MAPS_TEXT_SEARCH",
          "description": "Search Google Places by text query; returns businesses with their own website.",
          "input_schema": { "type":"object",
            "properties": { "query": {"type":"string"}, "max": {"type":"integer"} },
            "required": ["query"] },
          "invoke": { "argv": ["text", "--query", "{{query}}", "--max", "{{max}}", "--json"],
                      "result": "stdout_json" }
        }
        // ...MAPS_NEARBY similarly
      ]
    }
  }
}
```
- `${VAR}` in env is expanded from the process env / `~/.agent-outbound/env`.
- For `type:"stdio"`/`"http"` the `tools` block is optional (schemas come from the live
  server via `listTools()`); when present it can pin/whitelist.
- A `ProviderRegistry` builds + caches one provider instance per server name, plus the
  implicit `composio` provider. `getProvider(id)` returns it; lifecycle closes them.

### Tool identity in config — add a `server` dimension (backward compatible)
`ToolSpecSchema` (src/schemas/config.ts) gains:
```ts
server: z.string().default('')   // '' => composio (default). else a registry server name.
```
So a Google Maps source step is:
```yaml
source:
  searches:
    - id: gmaps_hvac_boise
      tool: { server: googlemaps, tools: [MAPS_TEXT_SEARCH] }
      args: { query: "HVAC Boise ID", max: 20 }
      output_map: { business_name: name, website: website, phone: phone, address: address }
```
Omitting `server` keeps the current Composio behavior.

## The seams to change (precise)
1. **`runtime/tools.ts`** — the heart. Today everything funnels to `executeComposioTool`
   (line 217) and `loadTools` (237) wraps each tool with
   `execute: () => executeComposioTool(mcp, slug, args)`.
   Change: `loadTools(providers, spec, catalog)` resolves the provider via `spec.server`
   and wraps with `execute: () => provider.executeTool(slug, args)`. Schema lookup uses
   `provider.getSchemas`. Move Composio specifics into ComposioProvider.
2. **`runtime/mcp.ts`** — keep as the Composio MCP client; ComposioProvider wraps it.
   No more direct imports of `callMetaTool` outside the Composio provider.
3. **`lib/tool-catalog.ts`** — `collectConfigToolRefs` already yields each `tool` spec;
   include `server`. `resolveConfigToolCatalog` resolves each ref against the named
   provider (search/getSchemas) instead of always Composio. Catalog entries become
   keyed by `server:slug` to avoid cross-provider slug collisions.
4. **`runtime/llm.ts`** — `resolveTools`/`generateObjectWithTools` take the provider
   registry and pass it through to `loadTools`. (Tool object keys may need to be
   `server__slug` to disambiguate when a step mixes providers.)
5. **`schemas/config.ts`** — add `server` to `ToolSpecSchema`.
6. **`actions/author-config/index.ts` + `prompt.md`** — discovery enumerates tools from
   ALL registered providers (Composio search + each registry server's tools), labels each
   candidate with its `server`, and the prompt instructs the model to set
   `tool.server` + `tool.tools` from real candidates only. Per-list registry is loaded so
   the author knows the user's custom servers.
7. **CLI (`cli.ts` + `commands/`)** — add:
   - `mcp add <name> ...` (write a registry entry; flags for type/command/args/url/env)
   - `mcp list` / `mcp remove <name>` / `mcp test <name>` (connect + list/declare tools)
   `auth --list` stays Composio-specific; `mcp list` covers custom providers.

## Google Maps wrapper (in mission/utilities/maps-search)
Because we chose "both provider types", we get Google Maps working via the **command**
provider immediately (no new server process needed — just declare the existing CLI in the
registry). Separately, add a thin **stdio MCP server** (`maps-search/mcp/server.js`,
one file, MCP SDK) exposing `maps_text_search` + `maps_nearby` so the MCP path is exercised
and reusable. Both wrap the same Places API logic already in `src/cli.js`.

## Phasing (each phase: Codex builds → I review diff + build/typecheck → next)
- **P1 — Provider core (no behavior change):** introduce ToolProvider + ComposioProvider;
  refactor tools.ts/llm.ts/tool-catalog.ts to route through it with composio as default.
  Acceptance: build+typecheck green; existing Composio path still resolves (Yelp config
  still validates/loads). No config schema change visible yet.
- **P2 — Registry + CommandProvider + `server` field:** add registry loader, CommandProvider,
  `server` in ToolSpecSchema, CLI `mcp add/list/remove/test`. Acceptance: `mcp test googlemaps`
  lists declared tools; a hand-written Google Maps source step validates.
- **P3 — McpProvider + maps-search MCP server:** generic stdio/http MCP provider + the
  one-file MCP wrapper in utilities/maps-search. Acceptance: `mcp test` against the stdio
  server lists tools live.
- **P4 — Author + prompts:** multi-provider discovery + prompt updates. Acceptance:
  `config author` can emit a `server: googlemaps` step grounded on real declared tools.
- **P5 — Boise run:** hand-confirm a tiny `source --limit 5` via Google Maps; inspect rows.

Token spend is gated: P1–P4 are code (Codex) + my deterministic validation; only P5 runs
the LLM/source pipeline, and only at limit 5 after your go-ahead.

## Open questions for the user
- Registry filename: DECIDED — `mcp.json` in the list dir.
- For the Google Maps command provider, default field_map: Places `displayName.text`→
  business_name, `formattedAddress`→address, `nationalPhoneNumber`→phone,
  `websiteUri`→website, `types`→categories, `id`→place_id, `googleMapsUri`→maps_url.
