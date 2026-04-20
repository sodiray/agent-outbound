import { createHash, randomUUID } from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const todayIsoDate = () => nowIso().slice(0, 10);

export const stableHash = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value || {});
  return createHash('sha256').update(text).digest('hex');
};

export const normalizeDomain = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    const withProtocol = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`;
    return new URL(withProtocol).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
};

export const makeRecordId = (row) => {
  return String(row?._row_id || row?.id || randomUUID());
};

export const getRecordRowId = (row) => String(row?._row_id || row?.id || makeRecordId(row)).trim();

export const rowToRecordShape = ({ listName, row }) => {
  const rowId = getRecordRowId(row);
  return {
    id: rowId,
    _row_id: rowId,
    business_name: String(row.business_name || row.name || ''),
    address: String(row.address || ''),
    city: String(row.city || ''),
    state: String(row.state || ''),
    zip: String(row.zip || row.postal_code || ''),
    postal_code: String(row.postal_code || ''),
    country: String(row.country || ''),
    website: String(row.website || ''),
    domain: normalizeDomain(row.domain || row.website || ''),
    google_place_id: String(row.google_place_id || row.place_id || ''),
    parent_row_id: String(row.parent_row_id || ''),
    duplicate_of: String(row.duplicate_of || ''),
    duplicate_status: String(row.duplicate_status || ''),
    latitude: Number(row.latitude || 0),
    longitude: Number(row.longitude || 0),
    phone: String(row.phone || ''),
    email_primary: String(row.email_primary || row.email || ''),
    contact_name_primary: String(row.contact_name_primary || row.contact_name || ''),
    contact_title_primary: String(row.contact_title_primary || row.contact_title || ''),
    fit_score: Number(row.fit_score || 0),
    trigger_score: Number(row.trigger_score || 0),
    priority_rank: Number(row.priority_rank || 0),
    sequence_name: String(row.sequence_name || 'default'),
    sequence_status: String(row.sequence_status || 'idle'),
    sequence_step: Number(row.sequence_step || 0),
    next_action_date: String(row.next_action_date || ''),
    last_outreach_at: String(row.last_outreach_at || ''),
    email_last_message_id: String(row.email_last_message_id || ''),
    email_last_thread_id: String(row.email_last_thread_id || ''),
    email_last_draft_id: String(row.email_last_draft_id || ''),
    email_last_reply_at: String(row.email_last_reply_at || ''),
    email_reply_classification: String(row.email_reply_classification || ''),
    mail_last_piece_id: String(row.mail_last_piece_id || ''),
    mail_last_cost_cents: Number(row.mail_last_cost_cents || 0),
    mail_last_expected_delivery: String(row.mail_last_expected_delivery || ''),
    mail_last_delivered_at: String(row.mail_last_delivered_at || ''),
    visit_scheduled_date: String(row.visit_scheduled_date || ''),
    visit_route_id: String(row.visit_route_id || ''),
    visit_route_position: Number(row.visit_route_position || 0),
    sms_last_message_id: String(row.sms_last_message_id || ''),
    call_last_disposition: String(row.call_last_disposition || ''),
    suppressed: Boolean(row.suppressed),
    suppressed_reason: String(row.suppressed_reason || ''),
    suppressed_at: String(row.suppressed_at || ''),
    dne_email: Boolean(row.dne_email),
    dnc_phone: Boolean(row.dnc_phone),
    dnk_visit: Boolean(row.dnk_visit),
    do_not_sms: Boolean(row.do_not_sms),
    crm_company_id: String(row.crm_company_id || ''),
    crm_person_id: String(row.crm_person_id || ''),
    crm_deal_id: String(row.crm_deal_id || ''),
    crm_last_synced_at: String(row.crm_last_synced_at || ''),
    crm_sync_hash: String(row.crm_sync_hash || ''),
    source_filter_result: String(row.source_filter_result || ''),
    source_filter_failures: String(row.source_filter_failures || ''),
    outcome: String(row.outcome || ''),
    outcome_notes: String(row.outcome_notes || ''),
    extra_json: row.extra_json || {},
    retry_count: Number(row.retry_count || 0),
    last_error: String(row.last_error || ''),
  };
};
