# CRM Sync

The tool's local record store is the execution ledger. CRM sync mirrors long-lived relationship state to the operator's connected CRM tools.

## What Syncs

- Company: business identity fields
- Person: primary contact fields when present
- Deal/opportunity: sequence/outcome state

The exact field mapping is driven by config and available CRM tools.

## How It Runs

- `crm sync` runs after meaningful state changes or on demand.
- Only changed records are synced.
- Existing linked CRM IDs are reused to avoid duplicates.

## Compliance

If CRM indicates do-not-contact and `crm.dnc_sync` is enabled, the record is suppressed in the tool.

## Operator Controls

Configured in `outbound.yaml`:

- `crm.tool` (required): toolkit/tool pinning
- `crm.dnc_sync`
- `crm.deal_stage_mapping`
- `crm.config` (provider-specific pass-through interpreted by the AI)
