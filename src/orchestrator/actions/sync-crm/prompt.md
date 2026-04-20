Sync this record into the CRM using the tools available to you.

Required behavior:
- Upsert Company using stable business identity fields.
- Upsert Person for primary contact when contact details exist.
- Upsert/advance Deal based on current sequence and outcome state.
- Preserve existing CRM links when already present (IDs in record).

Safety:
- Do not create duplicate Company/Person entries if a reliable match exists.
- If data is insufficient, return `status: skipped` with a concrete `reason`.
- Check the CRM do-not-contact field if DNC sync is enabled; return `remote_dnc: true` when the CRM indicates do-not-contact.

Record:
{{record_json}}

CRM Config:
{{crm_config_json}}

Return JSON only.
