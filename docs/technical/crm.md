# CRM Sync

The `sync-crm` action mirrors record state into the configured CRM toolkit via Composio. Delta-based: only changed records sync.

For the user-facing description, see `../product/crm.md`.

## Config Shape

```yaml
crm:
  tool:
    toolkits: [YOUR_CRM_TOOLKIT]
    tools: []
  dnc_sync: true
  deal_stage_mapping: {}
  config: {}
```

`crm.tool` is required for CRM sync execution.

## Sync Model

Per record:

1. Build deterministic snapshot of record + contacts + CRM config
2. Compare to `crm_sync_hash`
3. If changed, call `sync-crm` action with pinned tools
4. Persist returned linkage IDs and sync timestamp

Stored linkage columns on `records`:

- `crm_company_id`
- `crm_person_id`
- `crm_deal_id`
- `crm_sync_hash`
- `crm_last_synced_at`

Stored linkage column on `contacts`:

- `crm_person_id`

## DNC Sync

If `crm.dnc_sync` is enabled and the action returns `remote_dnc: true`:

- set `suppressed = true`
- set `suppressed_reason = crm_dnc`
- write suppression entry to list + global suppression stores

## Action Contract

`sync-crm` returns:

```json
{
  "status": "synced | skipped | failed",
  "company_id": "...",
  "person_id": "...",
  "deal_id": "...",
  "remote_dnc": false,
  "reason": "..."
}
```

The product layer stays tool-agnostic. CRM-specific mapping details belong in prompt + `crm.config`, interpreted by the model using configured tools.
