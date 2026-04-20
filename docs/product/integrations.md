# Integrations

Integrations are capability-based. The tool does not assume a specific vendor. Operators connect toolkits in Composio, then config author pins the toolkit(s) needed for each workflow.

## Capability Coverage

| Capability | Example provider categories | Notes |
|---|---|---|
| Local business sourcing | business listing/search providers | Use one or more toolkit-backed searches |
| Web research/scraping | web crawl/search providers | Used by enrichment steps |
| Contact discovery | people/contact data providers | Optional, based on workflow |
| Email send/reply detection | inbox providers | Supports draft/send/reply loops |
| Mail dispatch + tracking | direct mail providers | Delivery signals feed sequence gates |
| Visit routing | mapping/routing providers | Route planning uses `channels.visit.tool` |
| Calendar scheduling | calendar providers | Used for visit event creation |
| CRM sync | CRM providers | Uses `crm.tool` and generic sync action |
| SMS/call | messaging/telephony providers | Subject to suppression/compliance gates |

## Setup Model

1. Connect desired toolkits in Composio.
2. Use config author to generate/update config.
3. Validate and run.

Execution-time checks fail loudly if required toolkits are disconnected.
