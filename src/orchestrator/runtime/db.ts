import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureGlobalDirs,
  ensureListDirs,
  getComplianceLogPath,
  getCostsLogPath,
  getCrmLogPath,
  getDbPath,
  getGlobalSuppressionDbPath,
  getPipelineLogPath,
  getSourcingLogPath,
} from './paths.js';
import { deriveContactFirstName } from '../policy/contact-name.js';
import { isAffirmativeFlag } from '../policy/booleanish.js';
import { parseAccountCampaignFromRecord } from '../policy/contact-campaign.js';

const require = createRequire(import.meta.url);

let BetterSqlite3 = null;
const ensureDriver = () => {
  if (BetterSqlite3) return BetterSqlite3;
  try {
    BetterSqlite3 = require('better-sqlite3');
    return BetterSqlite3;
  } catch {
    throw new Error('Missing dependency "better-sqlite3". Install dependencies before running database commands.');
  }
};

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS raw_content (
    content_hash TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    raw_ref TEXT DEFAULT '',
    source_provider TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_raw_content_created_at ON raw_content(created_at);

  CREATE TABLE IF NOT EXISTS records (
    _row_id TEXT PRIMARY KEY,
    id TEXT DEFAULT '',
    _created_at TEXT DEFAULT '',
    _updated_at TEXT DEFAULT '',
    business_name TEXT DEFAULT '',
    address TEXT DEFAULT '',
    city TEXT DEFAULT '',
    state TEXT DEFAULT '',
    zip TEXT DEFAULT '',
    postal_code TEXT DEFAULT '',
    country TEXT DEFAULT '',
    website TEXT DEFAULT '',
    domain TEXT DEFAULT '',
    place_id TEXT DEFAULT '',
    google_place_id TEXT DEFAULT '',
    primary_type TEXT DEFAULT '',
    user_rating_count INTEGER DEFAULT 0,
    parent_row_id TEXT DEFAULT '',
    latitude REAL DEFAULT 0,
    longitude REAL DEFAULT 0,
    source TEXT DEFAULT '',
    source_query TEXT DEFAULT '',
    sourced_at TEXT DEFAULT '',
    duplicate_of TEXT DEFAULT '',
    duplicate_status TEXT DEFAULT '',
    duplicate_reason TEXT DEFAULT '',
    source_filter_result TEXT DEFAULT '',
    source_filter_failures TEXT DEFAULT '',
    disqualified_at TEXT DEFAULT '',
    disqualified_gate TEXT DEFAULT '',
    disqualify_reason TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    phone_confidence REAL DEFAULT NULL,
    phone_source_kind TEXT DEFAULT '',
    contact_linkedin_url TEXT DEFAULT '',
    linkedin_confidence REAL DEFAULT NULL,
    buyer_confidence REAL DEFAULT NULL,
    mail_confidence REAL DEFAULT NULL,
    mail_address_ready INTEGER DEFAULT 0,
    email_primary TEXT DEFAULT '',
    contact_name_primary TEXT DEFAULT '',
    contact_title_primary TEXT DEFAULT '',
    contact_name TEXT DEFAULT '',
    contact_first_name TEXT DEFAULT '',
    contact_email TEXT DEFAULT '',
    contact_title TEXT DEFAULT '',
    email_verification_status TEXT DEFAULT '',
    email_verification_confidence REAL DEFAULT 0,
    email_verification_reason TEXT DEFAULT '',
    email_verified_at TEXT DEFAULT '',
    fit_score REAL DEFAULT NULL,
    trigger_score REAL DEFAULT 0,
    trigger_score_peak REAL DEFAULT 0,
    fit_reasoning TEXT DEFAULT '',
    trigger_reasoning TEXT DEFAULT '',
    fit_updated_at TEXT DEFAULT '',
    trigger_updated_at TEXT DEFAULT '',
    fit_score_updated_at TEXT DEFAULT '',
    trigger_score_updated_at TEXT DEFAULT '',
    priority_rank REAL DEFAULT 0,
    sequence_name TEXT DEFAULT 'default',
    pipeline_name TEXT DEFAULT 'default',
    routed_by TEXT DEFAULT '',
    sequence_status TEXT DEFAULT 'idle',
    sequence_step INTEGER DEFAULT 0,
    sequence_step_attempts INTEGER DEFAULT 0,
    next_action_date TEXT DEFAULT '',
    launched_at TEXT DEFAULT '',
    last_outreach_at TEXT DEFAULT '',
    email_last_message_id TEXT DEFAULT '',
    email_last_from TEXT DEFAULT '',
    assigned_mailbox_id TEXT DEFAULT '',
    email_last_thread_id TEXT DEFAULT '',
    email_last_draft_id TEXT DEFAULT '',
    email_last_reply_at TEXT DEFAULT '',
    email_reply_classification TEXT DEFAULT '',
    reply_classification_latest TEXT DEFAULT '',
    email_thread_id TEXT DEFAULT '',
    disposition_latest TEXT DEFAULT '',
    disposition_follow_up_at TEXT DEFAULT '',
    mail_last_piece_id TEXT DEFAULT '',
    mail_last_cost_cents INTEGER DEFAULT 0,
    mail_last_expected_delivery TEXT DEFAULT '',
    mail_last_delivered_at TEXT DEFAULT '',
    mail_last_returned_at TEXT DEFAULT '',
    visit_scheduled_date TEXT DEFAULT '',
    visit_route_id TEXT DEFAULT '',
    visit_route_position INTEGER DEFAULT 0,
    sms_last_message_id TEXT DEFAULT '',
    call_last_disposition TEXT DEFAULT '',
    suppressed INTEGER DEFAULT 0,
    suppressed_reason TEXT DEFAULT '',
    suppressed_at TEXT DEFAULT '',
    do_not_sms INTEGER DEFAULT 0,
    dne_email INTEGER DEFAULT 0,
    dnc_phone INTEGER DEFAULT 0,
    dnk_visit INTEGER DEFAULT 0,
    crm_company_id TEXT DEFAULT '',
    crm_person_id TEXT DEFAULT '',
    crm_deal_id TEXT DEFAULT '',
    crm_last_synced_at TEXT DEFAULT '',
    crm_sync_hash TEXT DEFAULT '',
    workflow_signals TEXT DEFAULT '{}',
    company_resolution TEXT DEFAULT '',
    resolution_source TEXT DEFAULT '',
    resolution_reason TEXT DEFAULT '',
    resolution_candidate_name TEXT DEFAULT '',
    resolution_head_token TEXT DEFAULT '',
    linkedin_name TEXT DEFAULT '',
    linkedin_headline TEXT DEFAULT '',
    linkedin_location TEXT DEFAULT '',
    linkedin_urn TEXT DEFAULT '',
    vertical TEXT DEFAULT '',
    sub_vertical TEXT DEFAULT '',
    size_tier TEXT DEFAULT '',
    is_franchise INTEGER DEFAULT 0,
    persona TEXT DEFAULT '',
    outcome TEXT DEFAULT '',
    outcome_notes TEXT DEFAULT '',
    outcome_at TEXT DEFAULT '',
    outcome_value REAL DEFAULT 0,
    extra_json TEXT DEFAULT '{}',
    retry_count INTEGER DEFAULT 0,
    last_error TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_records_sequence ON records(sequence_status, next_action_date);
  CREATE INDEX IF NOT EXISTS idx_records_scores ON records(priority_rank DESC, fit_score DESC, trigger_score DESC);
  CREATE INDEX IF NOT EXISTS idx_records_reply ON records(email_last_reply_at);
  CREATE INDEX IF NOT EXISTS idx_records_visit ON records(visit_scheduled_date, visit_route_position);
  CREATE INDEX IF NOT EXISTS idx_records_row_id ON records(_row_id);
  CREATE INDEX IF NOT EXISTS idx_records_crm ON records(crm_company_id);

  CREATE TABLE IF NOT EXISTS record_embeddings (
    row_id TEXT PRIMARY KEY REFERENCES records(_row_id) ON DELETE CASCADE,
    embedding BLOB NOT NULL,
    identity_hash TEXT NOT NULL,
    embedded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_record_embeddings_hash ON record_embeddings(identity_hash);

  CREATE TABLE IF NOT EXISTS contacts (
    contact_id TEXT PRIMARY KEY,
    id TEXT DEFAULT '',
    row_id TEXT NOT NULL,
    name TEXT DEFAULT '',
    full_name TEXT DEFAULT '',
    first_name TEXT DEFAULT '',
    last_name TEXT DEFAULT '',
    title TEXT DEFAULT '',
    seniority TEXT DEFAULT '',
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    linkedin_url TEXT DEFAULT '',
    linkedin_urn TEXT DEFAULT '',
    role TEXT DEFAULT 'secondary',
    is_primary INTEGER DEFAULT 0,
    source TEXT DEFAULT '',
    source_query TEXT DEFAULT '',
    sourced_at TEXT DEFAULT '',
    confidence REAL DEFAULT 0,
    email_verification_status TEXT DEFAULT '',
    email_verification_confidence REAL DEFAULT 0,
    email_verification_reason TEXT DEFAULT '',
    email_verified_at TEXT DEFAULT '',
    dne_email INTEGER DEFAULT 0,
    dnc_phone INTEGER DEFAULT 0,
    dne_phone INTEGER DEFAULT 0,
    linkedin_suppressed INTEGER DEFAULT 0,
    crm_person_id TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(row_id) REFERENCES records(_row_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_contacts_row ON contacts(row_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_row_email ON contacts(row_id, email) WHERE email != '';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_contact_id ON contacts(contact_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_crm ON contacts(crm_person_id);

  CREATE TABLE IF NOT EXISTS channel_events (
    event_id TEXT PRIMARY KEY,
    id TEXT DEFAULT '',
    row_id TEXT NOT NULL,
    contact_id TEXT DEFAULT '',
    channel TEXT NOT NULL,
    event_type TEXT NOT NULL,
    action TEXT DEFAULT '',
    sequence_step TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    disposition TEXT DEFAULT '',
    provider_id TEXT DEFAULT '',
    thread_id TEXT DEFAULT '',
    provider_message_id TEXT DEFAULT '',
    provider_thread_id TEXT DEFAULT '',
    payload_json TEXT DEFAULT '{}',
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(row_id) REFERENCES records(_row_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_channel_events_row ON channel_events(row_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_channel_events_channel ON channel_events(channel, occurred_at DESC);

  CREATE TABLE IF NOT EXISTS channel_daily_cap_reservations (
    reservation_id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    interaction_type TEXT NOT NULL,
    day_start TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    accepted_at TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_channel_daily_cap_reservations_day
    ON channel_daily_cap_reservations(channel, interaction_type, day_start, status);

  CREATE TABLE IF NOT EXISTS inbound_messages (
    inbound_message_id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL,
    imap_uid INTEGER NOT NULL,
    rfc_message_id TEXT DEFAULT '',
    classification TEXT NOT NULL,
    correlation_status TEXT NOT NULL,
    correlation_reason TEXT DEFAULT '',
    record_id TEXT DEFAULT '',
    contact_id TEXT DEFAULT '',
    sender_email TEXT DEFAULT '',
    subject TEXT DEFAULT '',
    snippet TEXT DEFAULT '',
    references_json TEXT DEFAULT '[]',
    received_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(mailbox_id, imap_uid)
  );
  CREATE INDEX IF NOT EXISTS idx_inbound_messages_operator
    ON inbound_messages(correlation_status, classification, received_at DESC);
  CREATE INDEX IF NOT EXISTS idx_inbound_messages_record
    ON inbound_messages(record_id, received_at DESC);

  CREATE TABLE IF NOT EXISTS score_events (
    event_id TEXT PRIMARY KEY,
    row_id TEXT NOT NULL,
    axis TEXT NOT NULL,
    stage_id TEXT DEFAULT '',
    score INTEGER NOT NULL,
    reasoning TEXT NOT NULL,
    breakdown_json TEXT DEFAULT '',
    computed_at TEXT NOT NULL,
    FOREIGN KEY(row_id) REFERENCES records(_row_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_score_events_row ON score_events(row_id, computed_at DESC);

  CREATE TABLE IF NOT EXISTS pipeline_events (
    event_id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    passed INTEGER NOT NULL,
    reason TEXT DEFAULT '',
    wake_at TEXT DEFAULT '',
    side_effecting INTEGER DEFAULT 0,
    contact_id TEXT DEFAULT '',
    occurred_at TEXT NOT NULL,
    FOREIGN KEY(record_id) REFERENCES records(_row_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_pipeline_events_record ON pipeline_events(record_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_pipeline_events_contact ON pipeline_events(record_id, contact_id, step_id);

  CREATE TABLE IF NOT EXISTS batch_events (
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    size INTEGER NOT NULL,
    reason TEXT NOT NULL,
    wait_ms INTEGER DEFAULT 0,
    exec_ms INTEGER DEFAULT 0,
    occurred_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_batch_events_run ON batch_events(run_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_batch_events_step ON batch_events(step_id, occurred_at DESC);

  CREATE TABLE IF NOT EXISTS errored_events (
    run_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    error TEXT DEFAULT '',
    occurred_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_errored_events_run ON errored_events(run_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_errored_events_step ON errored_events(step_id, occurred_at DESC);

  CREATE TABLE IF NOT EXISTS overrides (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    step_id TEXT DEFAULT '',
    reason TEXT NOT NULL,
    created_by TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    cleared_at TEXT DEFAULT '',
    cleared_by TEXT DEFAULT '',
    FOREIGN KEY(record_id) REFERENCES records(_row_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_overrides_record ON overrides(record_id, cleared_at);

  CREATE TABLE IF NOT EXISTS field_overrides (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL,
    field TEXT NOT NULL,
    value TEXT,
    reason TEXT DEFAULT '',
    created_by TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    cleared_at TEXT DEFAULT '',
    cleared_by TEXT DEFAULT '',
    FOREIGN KEY(record_id) REFERENCES records(_row_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_field_overrides_record ON field_overrides(record_id, cleared_at);

  CREATE TABLE IF NOT EXISTS interactions (
    interaction_id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL,
    contact TEXT DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'note',
    summary TEXT NOT NULL,
    body TEXT DEFAULT '',
    objections TEXT DEFAULT '',
    follow_up_at TEXT DEFAULT '',
    follow_up_done_at TEXT DEFAULT '',
    follow_up_note TEXT DEFAULT '',
    created_by TEXT DEFAULT '',
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT DEFAULT '',
    FOREIGN KEY(record_id) REFERENCES records(_row_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_interactions_record ON interactions(record_id, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_interactions_follow_up ON interactions(follow_up_at, follow_up_done_at, deleted_at);

  CREATE TABLE IF NOT EXISTS lead_briefs (
    brief_id TEXT PRIMARY KEY,
    row_id TEXT NOT NULL UNIQUE,
    summary TEXT DEFAULT '',
    content TEXT DEFAULT '',
    roles_json TEXT DEFAULT '[]',
    dep_hash TEXT DEFAULT '',
    model TEXT DEFAULT '',
    status TEXT DEFAULT 'ready',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(row_id) REFERENCES records(_row_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_lead_briefs_row ON lead_briefs(row_id);

  CREATE TABLE IF NOT EXISTS run_state (
    run_id TEXT PRIMARY KEY,
    phase TEXT NOT NULL,
    active_step TEXT DEFAULT '',
    message TEXT DEFAULT '',
    target_count INTEGER DEFAULT 0,
    done_count INTEGER DEFAULT 0,
    step_index INTEGER DEFAULT 0,
    step_total INTEGER DEFAULT 0,
    status TEXT NOT NULL,        -- 'running' | 'done' | 'error'
    error TEXT DEFAULT '',
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_run_state_updated ON run_state(updated_at DESC);

  CREATE TABLE IF NOT EXISTS suppression (
    entry_id TEXT PRIMARY KEY,
    id TEXT DEFAULT '',
    identifier_value TEXT NOT NULL,
    identifier_type TEXT NOT NULL,
    value TEXT DEFAULT '',
    value_type TEXT DEFAULT '',
    scope TEXT NOT NULL,
    reason TEXT NOT NULL,
    source TEXT DEFAULT '',
    row_id TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_suppression_value ON suppression(identifier_type, identifier_value);

  CREATE TABLE IF NOT EXISTS routes (
    id TEXT PRIMARY KEY,
    route_date TEXT NOT NULL,
    status TEXT NOT NULL,
    total_drive_minutes INTEGER DEFAULT 0,
    summary_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_routes_date ON routes(route_date, status);

  CREATE TABLE IF NOT EXISTS route_stops (
    id TEXT PRIMARY KEY,
    route_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    stop_order INTEGER NOT NULL,
    scheduled_time TEXT DEFAULT '',
    drive_minutes_from_prev INTEGER DEFAULT 0,
    calendar_event_id TEXT DEFAULT '',
    eta TEXT DEFAULT '',
    disposition TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(route_id) REFERENCES routes(id) ON DELETE CASCADE,
    FOREIGN KEY(record_id) REFERENCES records(_row_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_route_stops_route ON route_stops(route_id, stop_order);

  CREATE TABLE IF NOT EXISTS drafts (
    draft_id TEXT PRIMARY KEY,
    row_id TEXT NOT NULL,
    sequence_name TEXT NOT NULL,
    step_number INTEGER NOT NULL,
    step_id TEXT DEFAULT '',
    channel TEXT DEFAULT 'email',
    status TEXT NOT NULL DEFAULT 'pending_approval',
    subject TEXT DEFAULT '',
    body TEXT DEFAULT '',
    reason TEXT DEFAULT '',
    artifacts_json TEXT DEFAULT '{}',
    content_binding_json TEXT DEFAULT '{}',
    content_hash TEXT DEFAULT '',
    template_id TEXT DEFAULT '',
    template_version INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(row_id) REFERENCES records(_row_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_drafts_row ON drafts(row_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS assets (
    asset_id   TEXT PRIMARY KEY,
    row_id     TEXT NOT NULL,
    step_id    TEXT NOT NULL,
    label      TEXT DEFAULT '',
    result     TEXT DEFAULT '',
    outputs_json TEXT DEFAULT '{}',
    is_reference INTEGER DEFAULT 0,
    status     TEXT DEFAULT 'ready',
    reason     TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_assets_row  ON assets(row_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_assets_step ON assets(step_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS account_timeline (
    timeline_id TEXT PRIMARY KEY,
    row_id TEXT NOT NULL,
    contact_id TEXT DEFAULT '',
    event_family TEXT NOT NULL,
    event_type TEXT NOT NULL,
    channel TEXT DEFAULT '',
    disposition TEXT DEFAULT '',
    classification TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    payload_json TEXT DEFAULT '{}',
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(row_id) REFERENCES records(_row_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_account_timeline_row ON account_timeline(row_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_account_timeline_type ON account_timeline(event_family, event_type, occurred_at DESC);

  CREATE TABLE IF NOT EXISTS saved_views (
    view_name TEXT PRIMARY KEY,
    select_sql TEXT NOT NULL,
    where_sql TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS staleness (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    dep_hash TEXT NOT NULL,
    input_hash TEXT DEFAULT '',
    policy_hash TEXT DEFAULT '',
    cache_ttl TEXT DEFAULT '',
    cache_ttl_seconds INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL,
    UNIQUE(record_id, step_id),
    FOREIGN KEY(record_id) REFERENCES records(_row_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_staleness_record ON staleness(record_id, step_id);

  CREATE TABLE IF NOT EXISTS search_state (
    id TEXT PRIMARY KEY,
    search_id TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    pagination_json TEXT DEFAULT '{}',
    exhausted INTEGER DEFAULT 0,
    last_result_count INTEGER DEFAULT 0,
    total_results_fetched INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL,
    UNIQUE(search_id)
  );
  CREATE INDEX IF NOT EXISTS idx_search_state_search ON search_state(search_id);

  CREATE TABLE IF NOT EXISTS search_tasks (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    params TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    pages_fetched INTEGER DEFAULT 0,
    total_seen INTEGER DEFAULT 0,
    new_unique INTEGER DEFAULT 0,
    last_run_at TEXT DEFAULT '',
    attempt_count INTEGER DEFAULT 0,
    last_error TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_search_tasks_status ON search_tasks(status);

  CREATE TABLE IF NOT EXISTS idempotency (
    id TEXT PRIMARY KEY,
    idem_key TEXT NOT NULL,
    scope TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_id TEXT DEFAULT '',
    payload_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(idem_key, scope)
  );

  CREATE TABLE IF NOT EXISTS live_interaction_ledger (
    ledger_id TEXT PRIMARY KEY,
    identity_key TEXT NOT NULL UNIQUE,
    record_id TEXT NOT NULL,
    contact_id TEXT DEFAULT '',
    channel TEXT NOT NULL,
    step_id TEXT NOT NULL,
    sequence_name TEXT DEFAULT '',
    step_number INTEGER DEFAULT 0,
    provider_id TEXT DEFAULT '',
    provider_message_id TEXT DEFAULT '',
    delivery_mode TEXT NOT NULL,
    status TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_live_interaction_ledger_live
    ON live_interaction_ledger(delivery_mode, status, record_id);
  CREATE INDEX IF NOT EXISTS idx_live_interaction_ledger_occurred
    ON live_interaction_ledger(occurred_at DESC);

  CREATE TABLE IF NOT EXISTS cost_events (
    id TEXT PRIMARY KEY,
    record_id TEXT DEFAULT '',
    step_id TEXT NOT NULL,
    model TEXT DEFAULT '',
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    tool_calls TEXT DEFAULT '[]',
    usd_cost REAL DEFAULT 0,
    provider TEXT DEFAULT '',
    payload_json TEXT DEFAULT '{}',
    occurred_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cost_reservations (
    reservation_id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'reserved',
    reserved_usd REAL NOT NULL,
    actual_usd REAL DEFAULT 0,
    ceiling_usd REAL NOT NULL,
    high_cost INTEGER DEFAULT 0,
    high_cost_eligible INTEGER DEFAULT 0,
    provider TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    settled_at TEXT DEFAULT '',
    released_at TEXT DEFAULT '',
    release_reason TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_cost_reservations_record_status
    ON cost_reservations(record_id, status);
  CREATE INDEX IF NOT EXISTS idx_cost_events_step ON cost_events(step_id, occurred_at DESC);

  CREATE TABLE IF NOT EXISTS compliance_log (
    id TEXT PRIMARY KEY,
    record_id TEXT DEFAULT '',
    action TEXT NOT NULL,
    reason TEXT DEFAULT '',
    payload_json TEXT DEFAULT '{}',
    occurred_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity_history (
    id TEXT PRIMARY KEY,
    event_type TEXT DEFAULT '',
    event TEXT NOT NULL,
    phase TEXT DEFAULT '',
    row_id TEXT DEFAULT '',
    payload_json TEXT DEFAULT '{}',
    occurred_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_activity_history_occurred ON activity_history(occurred_at DESC);

  CREATE TABLE IF NOT EXISTS observations (
    observation_id TEXT PRIMARY KEY,
    dedupe_key TEXT NOT NULL UNIQUE,
    project TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject_type TEXT DEFAULT '',
    subject_id TEXT DEFAULT '',
    summary TEXT NOT NULL,
    payload_json TEXT DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1,
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_observations_active
    ON observations(active, kind, last_observed_at DESC);

  CREATE TABLE IF NOT EXISTS pending_items (
    pending_id TEXT PRIMARY KEY,
    dedupe_key TEXT NOT NULL UNIQUE,
    project TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'open',
    subject_type TEXT DEFAULT '',
    subject_id TEXT DEFAULT '',
    summary TEXT NOT NULL,
    context_json TEXT DEFAULT '{}',
    source_state_json TEXT DEFAULT '{}',
    owner_id TEXT DEFAULT '',
    claimed_at TEXT DEFAULT '',
    claim_lease_expires_at TEXT DEFAULT '',
    delegated_task_id TEXT DEFAULT '',
    last_progress_at TEXT DEFAULT '',
    snoozed_until TEXT DEFAULT '',
    resolution_reason TEXT DEFAULT '',
    resolution_evidence_json TEXT DEFAULT '{}',
    idempotency_key TEXT DEFAULT '',
    observed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT DEFAULT '',
    dismissed_at TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_pending_attention
    ON pending_items(status, priority, created_at);
  CREATE INDEX IF NOT EXISTS idx_pending_subject
    ON pending_items(subject_type, subject_id, status);

  CREATE TABLE IF NOT EXISTS pending_item_events (
    event_id TEXT PRIMARY KEY,
    pending_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT DEFAULT '',
    reason TEXT DEFAULT '',
    details_json TEXT DEFAULT '{}',
    idempotency_key TEXT DEFAULT '',
    occurred_at TEXT NOT NULL,
    FOREIGN KEY(pending_id) REFERENCES pending_items(pending_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_pending_item_events
    ON pending_item_events(pending_id, occurred_at ASC);

  CREATE TABLE IF NOT EXISTS notification_deliveries (
    delivery_id TEXT PRIMARY KEY,
    dedupe_key TEXT NOT NULL UNIQUE,
    sink TEXT NOT NULL,
    event TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL,
    last_error TEXT DEFAULT '',
    available_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    delivered_at TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_notification_delivery_status
    ON notification_deliveries(status, updated_at);

  CREATE TABLE IF NOT EXISTS operator_monitor_state (
    phase TEXT PRIMARY KEY,
    last_attempted_at TEXT DEFAULT '',
    last_succeeded_at TEXT DEFAULT '',
    last_error TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS lead_territories (
    row_id TEXT NOT NULL,
    territory_id TEXT NOT NULL,
    assigned_at TEXT DEFAULT '',
    PRIMARY KEY (row_id, territory_id)
  );
  CREATE INDEX IF NOT EXISTS idx_lead_territories_territory ON lead_territories(territory_id);

  CREATE TABLE IF NOT EXISTS territory_notes (
    note_id TEXT PRIMARY KEY,
    territory_id TEXT NOT NULL,
    body TEXT DEFAULT '',
    created_at TEXT DEFAULT '',
    created_by TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_territory_notes_territory ON territory_notes(territory_id);
`;

const nowIso = () => new Date().toISOString();

type RawContentInput = {
  content_hash: string;
  body: string;
  raw_ref?: string;
  source_provider?: string;
  created_at?: string;
};

type LegacySnapshot = Record<string, unknown>;

type SqliteStatement = {
  all(...values: unknown[]): unknown[];
  get(...values: unknown[]): unknown;
  run(...values: unknown[]): unknown;
};

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: () => T): () => T;
};

const contentHash = (body: string) => createHash('sha256').update(body).digest('hex');

const excerptFromRawContent = (body: string, maxLength = 2000) => (
  body.length <= maxLength ? body : `${body.slice(0, maxLength)}…`
);

const parseJson = (value: unknown): unknown => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const snapshotList = (value: unknown): LegacySnapshot[] => {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((snapshot): snapshot is LegacySnapshot => Boolean(snapshot && typeof snapshot === 'object'));
};

const snapshotKey = (snapshot: LegacySnapshot) => (
  String(snapshot.source_id || snapshot.content_hash || JSON.stringify(snapshot))
);

export const storeRawContent = ({ db, content }: { db: SqliteDatabase; content: RawContentInput }): boolean => {
  const body = String(content.body || '');
  if (!body) return false;
  const hash = contentHash(body);
  const requestedHash = String(content.content_hash || '').trim();
  if (requestedHash && requestedHash !== hash) {
    throw new Error('raw_content content_hash must match the body SHA-256.');
  }
  db.prepare(`
    INSERT INTO raw_content (content_hash, body, byte_length, raw_ref, source_provider, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(content_hash) DO NOTHING
  `).run(
    hash,
    body,
    Buffer.byteLength(body, 'utf8'),
    String(content.raw_ref || ''),
    String(content.source_provider || ''),
    String(content.created_at || nowIso()),
  );
  return true;
};

/** Resolve full immutable bytes only where a caller genuinely needs them. */
export const resolveRawContentBody = ({ db, contentHash: hash }: { db: SqliteDatabase; contentHash: string }): string | null => {
  const contentHashValue = String(hash || '').trim();
  if (!contentHashValue) return null;
  const row = db.prepare('SELECT body FROM raw_content WHERE content_hash = ?').get(contentHashValue) as { body?: unknown } | undefined;
  return row?.body == null ? null : String(row.body);
};

const normalizeLegacySnapshot = ({ db, snapshot }: { db: SqliteDatabase; snapshot: LegacySnapshot }): LegacySnapshot => {
  const body = typeof snapshot.body === 'string' ? snapshot.body : '';
  const existingExcerpt = typeof snapshot.excerpt === 'string' ? snapshot.excerpt : '';
  const excerpt = excerptFromRawContent(body || existingExcerpt);
  const hash = body
    ? contentHash(body)
    : String(snapshot.content_hash || '').trim() || (excerpt ? contentHash(excerpt) : '');
  if (body && hash) {
    storeRawContent({
      db,
      content: {
        content_hash: hash,
        body,
        raw_ref: String(snapshot.raw_ref || ''),
        source_provider: String(snapshot.provider || snapshot.source || ''),
      },
    });
  }
  const { body: _body, excerpt: _excerpt, content_hash: _contentHash, ...rest } = snapshot;
  return {
    ...rest,
    ...(hash ? { content_hash: hash } : {}),
    ...(excerpt ? { excerpt } : {}),
  };
};

/**
 * One-time-compatible migration for the former four-copy snapshot shape.
 * observations_json.snapshots is the sole persisted snapshot history after this
 * runs; legacy snapshot columns are cleared only after their bytes are safe in
 * raw_content and their metadata has been merged.
 */
export const migrateContentAddressedEvidence = ({ db }: { db: SqliteDatabase }): number => {
  try { db.exec("ALTER TABLE records ADD COLUMN observations_json TEXT DEFAULT ''"); } catch {}
  const columns = new Set(
    db.prepare('PRAGMA table_info(records)').all().map((row: { name?: unknown }) => String(row.name || '')),
  );
  if (!columns.has('observations_json')) return 0;
  const legacyColumns = [
    'source_snapshots_json',
    'retrieval_snapshots_json',
    'last_retrieval_snapshot_json',
  ].filter((column) => columns.has(column));
  const rows = db.prepare('SELECT * FROM records').all() as Array<Record<string, unknown>>;
  const migrate = db.transaction(() => rows.reduce((count, row) => {
    const observationValue = parseJson(row.observations_json);
    const observationStore = observationValue && typeof observationValue === 'object' && !Array.isArray(observationValue)
      ? observationValue as Record<string, unknown>
      : {};
    const observations = Array.isArray(observationValue)
      ? observationValue
      : Array.isArray(observationStore.observations) ? observationStore.observations : [];
    const legacySnapshots = [
      ...snapshotList(observationStore.snapshots),
      ...snapshotList(row.source_snapshots_json),
      ...snapshotList(row.retrieval_snapshots_json),
      ...snapshotList(row.last_retrieval_snapshot_json),
    ];
    const snapshotsByKey = new Map<string, LegacySnapshot>();
    for (const snapshot of legacySnapshots) {
      const normalized = normalizeLegacySnapshot({ db, snapshot });
      snapshotsByKey.set(snapshotKey(normalized), normalized);
    }
    const snapshots = [...snapshotsByKey.values()];
    const nextObservationStore = {
      ...observationStore,
      observations,
      snapshots,
    };
    const nextObservationsJson = JSON.stringify(nextObservationStore);
    const legacyHasValues = legacyColumns.some((column) => String(row[column] || '').trim() !== '');
    const needsWrite = legacySnapshots.length > 0
      || legacyHasValues
      || String(row.observations_json || '') !== nextObservationsJson;
    if (!needsWrite) return count;
    const assignments = ['observations_json = @observations_json', ...legacyColumns.map((column) => `${column} = @empty`)];
    db.prepare(`UPDATE records SET ${assignments.join(', ')} WHERE _row_id = @_row_id`).run({
      _row_id: row._row_id,
      observations_json: nextObservationsJson,
      empty: '',
    });
    return count + 1;
  }, 0));
  return migrate();
};

export type Asset = {
  asset_id: string;
  row_id: string;
  step_id: string;
  label: string;
  result: string;
  outputs_json: string;
  is_reference: boolean;
  status: string;
  reason: string;
  created_at: string;
  updated_at: string;
};

const applyPragmas = (db, { readonly = false } = {}) => {
  if (!readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
};

const openRawDb = ({ dbPath, readonly = false }) => {
  const Driver = ensureDriver();
  const openVerified = (path) => {
    const db = new Driver(path, { readonly, fileMustExist: readonly });
    applyPragmas(db, { readonly });
    if (readonly) db.pragma('schema_version');
    return db;
  };
  try {
    return openVerified(dbPath);
  } catch (error) {
    if (!readonly || !String((error as Error)?.message || error).includes('unable to open database file')) throw error;
    const tempDir = mkdtempSync(join(tmpdir(), 'agent-outbound-readonly-db-'));
    const tempPath = join(tempDir, 'prospects.db');
    copyFileSync(dbPath, tempPath);
    return openVerified(tempPath);
  }
};

const ensureSuppressionCompatibility = (db) => {
  try { db.exec("ALTER TABLE suppression ADD COLUMN entry_id TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE suppression ADD COLUMN identifier_value TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE suppression ADD COLUMN identifier_type TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE suppression ADD COLUMN value TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE suppression ADD COLUMN value_type TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE suppression ADD COLUMN scope TEXT DEFAULT 'global'"); } catch {}
  try { db.exec("ALTER TABLE suppression ADD COLUMN reason TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE suppression ADD COLUMN source TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE suppression ADD COLUMN row_id TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE suppression ADD COLUMN created_at TEXT DEFAULT ''"); } catch {}
  try { db.exec("UPDATE suppression SET entry_id = id WHERE (entry_id IS NULL OR entry_id = '') AND id IS NOT NULL AND id != ''"); } catch {}
  try { db.exec("UPDATE suppression SET identifier_value = value WHERE (identifier_value IS NULL OR identifier_value = '') AND value IS NOT NULL AND value != ''"); } catch {}
  try { db.exec("UPDATE suppression SET identifier_type = value_type WHERE (identifier_type IS NULL OR identifier_type = '') AND value_type IS NOT NULL AND value_type != ''"); } catch {}
};

const ensureInboundMessageCompatibility = (db) => {
  try { db.exec("ALTER TABLE inbound_messages ADD COLUMN correlation_reason TEXT DEFAULT ''"); } catch {}
};

/**
 * Whole-corpus DML during open is only safe when canary isolation is off.
 * When active, scope updates to the allowlist (never mutate excluded records
 * just because the DB was opened).
 * Returns null when canary is off / unavailable (unscoped). Returns [] to skip
 * all DML under active isolation with empty allowlist.
 */
const canaryScopedRecordIds = (db: any): string[] | null => {
  try {
    const listDir = String(db?.__ao_list_dir || '').trim();
    if (!listDir) return null;
    const { loadCanaryConfig } = require('../policy/canary-isolation.js') as {
      loadCanaryConfig: (o?: { listDir?: string }) => { mode: string; allowlist_record_ids: string[] };
    };
    const cfg = loadCanaryConfig({ listDir });
    const mode = String(cfg?.mode || 'off');
    if (mode === 'off') return null;
    return (cfg.allowlist_record_ids || []).map((id) => String(id || '').trim()).filter(Boolean);
  } catch {
    return null;
  }
};

const ensureRecordCompatibility = (db) => {
  try { db.exec("ALTER TABLE records ADD COLUMN contact_first_name TEXT DEFAULT ''"); } catch {}
  try { db.exec('ALTER TABLE records ADD COLUMN phone_confidence REAL DEFAULT NULL'); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN phone_source_kind TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN contact_linkedin_url TEXT DEFAULT ''"); } catch {}
  try { db.exec('ALTER TABLE records ADD COLUMN linkedin_confidence REAL DEFAULT NULL'); } catch {}
  try { db.exec('ALTER TABLE records ADD COLUMN buyer_confidence REAL DEFAULT NULL'); } catch {}
  try { db.exec('ALTER TABLE records ADD COLUMN mail_confidence REAL DEFAULT NULL'); } catch {}
  try { db.exec('ALTER TABLE records ADD COLUMN mail_address_ready INTEGER DEFAULT 0'); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN place_id TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN primary_type TEXT DEFAULT ''"); } catch {}
  try { db.exec('ALTER TABLE records ADD COLUMN user_rating_count INTEGER DEFAULT 0'); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN company_resolution TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN resolution_source TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN resolution_reason TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN resolution_candidate_name TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN resolution_head_token TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN linkedin_name TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN linkedin_headline TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN linkedin_location TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN linkedin_urn TEXT DEFAULT ''"); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_records_place_id ON records(place_id)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_records_google_place_id ON records(google_place_id)'); } catch {}
  try {
    const columns = new Set(
      db.prepare('PRAGMA table_info(records)').all().map((row) => String(row.name || ''))
    );
    const resolutionEvidence = ['place_id', 'primary_type'].filter((column) => columns.has(column));
    if (resolutionEvidence.length > 0) {
      const allowIds = canaryScopedRecordIds(db);
      if (allowIds !== null) {
        if (allowIds.length === 0) {
          // Strict/canary with empty allowlist: skip whole-corpus DML entirely.
        } else {
          const placeholders = allowIds.map(() => '?').join(',');
          db.prepare(`
            UPDATE records
            SET company_resolution = 'resolved', resolution_source = 'places'
            WHERE company_resolution = ''
              AND (${resolutionEvidence.map((column) => `${column} != ''`).join(' OR ')})
              AND _row_id IN (${placeholders})
          `).run(...allowIds);
        }
      } else {
        db.exec(`
          UPDATE records
          SET company_resolution = 'resolved', resolution_source = 'places'
          WHERE company_resolution = ''
            AND (${resolutionEvidence.map((column) => `${column} != ''`).join(' OR ')})
        `);
      }
    }
  } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN reply_classification_latest TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN disposition_latest TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN disposition_follow_up_at TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN disqualified_at TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN disqualified_gate TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN disqualify_reason TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN duplicate_reason TEXT DEFAULT ''"); } catch {}
  // Soft-drop / review queue: a committed record a filter would now drop is flagged
  // for review instead of being disqualified, so we never destroy in-flight outreach.
  try { db.exec("ALTER TABLE records ADD COLUMN needs_review INTEGER DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN review_reason TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN review_flagged_at TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN routed_by TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN pipeline_name TEXT DEFAULT 'default'"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN assigned_mailbox_id TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN email_last_from TEXT DEFAULT ''"); } catch {}
  // Idempotent filters: fast lookup of "has this record already passed this step?".
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_pipeline_events_record_step ON pipeline_events(record_id, step_id)"); } catch {}
  // Backfill fit_score for records scored by the single-score path, which for a
  // while wrote only priority_rank. Guarded on score_updated_at recency so legacy
  // dual-axis rows (correct fit_score, stale combined priority_rank) are untouched.
  try {
    db.exec(`
      UPDATE records SET fit_score = priority_rank
      WHERE priority_rank IS NOT NULL
        AND COALESCE(score_updated_at, '') != ''
        AND COALESCE(score_updated_at, '') > COALESCE(fit_score_updated_at, '')
        AND (fit_score IS NULL OR fit_score != priority_rank)
    `);
  } catch {}
};

export const migrateScoreStageData = ({ db }: { db: { exec: (sql: string) => unknown; prepare: (sql: string) => { run: (...values: unknown[]) => { changes?: number }; all: () => Array<{ name?: unknown }> } } }): number => {
  try { db.exec("ALTER TABLE records ADD COLUMN fit_breakdown TEXT DEFAULT ''"); } catch {}
  const columns = new Set(
    db.prepare('PRAGMA table_info(records)').all().map((row) => String(row.name || '')),
  );
  if (!columns.has('fit_score') || !columns.has('fit_breakdown')) return 0;
  const emptyBreakdowns = ['fit_breakdown', 'score_breakdown']
    .filter((column) => columns.has(column))
    .map((column) => `TRIM(COALESCE(${column}, '')) IN ('', '[]', '{}')`);
  const blankBreakdown = emptyBreakdowns.length > 0 ? emptyBreakdowns.join(' AND ') : '1 = 1';
  const cleared = db.prepare(`
    UPDATE records
    SET fit_score = NULL,
        fit_breakdown = ?,
        fit_reasoning = ?
    WHERE fit_score = 0 AND ${blankBreakdown}
  `).run(
    JSON.stringify({
      criteria: [],
      missing_inputs: [],
      reason: 'legacy_fabricated_zero_cleared',
    }),
    'Legacy fabricated zero cleared: no graded breakdown was recorded.',
  );
  if (!columns.has('score_breakdown')) return Number(cleared.changes || 0);
  const canonicalized = db.prepare(`
    UPDATE records
    SET fit_breakdown = CASE
          WHEN TRIM(COALESCE(fit_breakdown, '')) IN ('', '[]', '{}')
            THEN '{"criteria":' || score_breakdown || ',"missing_inputs":[],"reason":"legacy_score_breakdown_migrated"}'
          ELSE fit_breakdown
        END,
        score_breakdown = ''
    WHERE TRIM(COALESCE(score_breakdown, '')) LIKE '[%'
  `).run();
  return Number(cleared.changes || 0) + Number(canonicalized.changes || 0);
};

const ensurePipelineEventCompatibility = (db) => {
  try { db.exec("ALTER TABLE pipeline_events ADD COLUMN wake_at TEXT DEFAULT ''"); } catch {}
  try { db.exec('ALTER TABLE pipeline_events ADD COLUMN side_effecting INTEGER DEFAULT 0'); } catch {}
  try { db.exec("ALTER TABLE pipeline_events ADD COLUMN contact_id TEXT DEFAULT ''"); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_pipeline_events_wake ON pipeline_events(record_id, wake_at)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_pipeline_events_contact ON pipeline_events(record_id, contact_id, step_id)'); } catch {}
};

const ensureStalenessCompatibility = (db) => {
  try { db.exec("ALTER TABLE staleness ADD COLUMN input_hash TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE staleness ADD COLUMN policy_hash TEXT DEFAULT ''"); } catch {}
};

const ensureScoreEventCompatibility = (db) => {
  try { db.exec("ALTER TABLE score_events ADD COLUMN stage_id TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE score_events ADD COLUMN breakdown_json TEXT DEFAULT ''"); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_score_events_row_axis ON score_events(row_id, axis, computed_at DESC)'); } catch {}
};

const ensureDraftCompatibility = (db) => {
  try { db.exec("ALTER TABLE drafts ADD COLUMN content_binding_json TEXT DEFAULT '{}'"); } catch {}
  try { db.exec("ALTER TABLE drafts ADD COLUMN content_hash TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE drafts ADD COLUMN template_id TEXT DEFAULT ''"); } catch {}
  try { db.exec('ALTER TABLE drafts ADD COLUMN template_version INTEGER'); } catch {}
};

const ensureLiveInteractionLedgerCompatibility = (db) => {
  try { db.exec("ALTER TABLE live_interaction_ledger ADD COLUMN sequence_name TEXT DEFAULT ''"); } catch {}
  try { db.exec('ALTER TABLE live_interaction_ledger ADD COLUMN step_number INTEGER DEFAULT 0'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_live_interaction_ledger_first_touch ON live_interaction_ledger(record_id, delivery_mode, status, sequence_name, step_number, channel)'); } catch {}
};

/**
 * Ensure drafts table has its generic content-binding column.
 */
export const ensureDraftColumns = ({ db }) => {
  ensureDraftCompatibility(db);
};

const ensureContactCompatibility = (db) => {
  try { db.exec("ALTER TABLE contacts ADD COLUMN first_name TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN last_name TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN seniority TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN linkedin_urn TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN source TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN source_query TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN sourced_at TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN confidence REAL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN email_verification_reason TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN dne_phone INTEGER DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN linkedin_suppressed INTEGER DEFAULT 0"); } catch {}

  db.transaction(() => {
    db.exec('DROP INDEX IF EXISTS idx_contacts_row_email');
    db.exec("CREATE UNIQUE INDEX idx_contacts_row_email ON contacts(row_id, email) WHERE email != ''");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_row_linkedin_urn ON contacts(row_id, linkedin_urn) WHERE linkedin_urn != ''");
    let recordIds = db.prepare("SELECT DISTINCT row_id FROM contacts WHERE row_id != ''").all() as Array<{ row_id?: string }>;
    // Scope primary-contact projection under canary — do not touch excluded accounts.
    const allowIds = canaryScopedRecordIds(db);
    if (allowIds !== null) {
      if (allowIds.length === 0) recordIds = [];
      else {
        const allowed = new Set(allowIds);
        recordIds = recordIds.filter((row) => allowed.has(String(row.row_id || '')));
      }
    }
    recordIds.forEach((row) => {
      syncPrimaryContactProjectionInternal({ db, recordId: String(row.row_id || '') });
    });
  })();
};

const ensureTerritoryCompatibility = (db) => {
  try { db.exec("ALTER TABLE lead_territories ADD COLUMN assigned_at TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE territory_notes ADD COLUMN created_by TEXT DEFAULT ''"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_lead_territories_territory ON lead_territories(territory_id)"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_territory_notes_territory ON territory_notes(territory_id)"); } catch {}
};

// The "commit line": a record is committed (outreach has begun / work invested)
// once it has been launched or has left the idle state. Committed records may be
// flagged for review by a filter, but never hard-dropped.
const COMMITTED_SEQUENCE_STATES = new Set(['active', 'engaged', 'blocked', 'completed', 'opted_out', 'bounced']);

export const isRecordCommitted = (record: any): boolean => {
  if (!record) return false;
  if (String(record.launched_at || '').trim() !== '') return true;
  return COMMITTED_SEQUENCE_STATES.has(String(record.sequence_status || '').trim());
};

// SQL fragment matching committed records (mirrors isRecordCommitted for counting/queries).
export const committedWhere = (alias = ''): string => {
  const prefix = String(alias || '').trim();
  const launchedCol = prefix ? `${prefix}.launched_at` : 'launched_at';
  const statusCol = prefix ? `${prefix}.sequence_status` : 'sequence_status';
  const states = [...COMMITTED_SEQUENCE_STATES].map((s) => `'${s}'`).join(', ');
  return `((${launchedCol} IS NOT NULL AND TRIM(${launchedCol}) != '') OR ${statusCol} IN (${states}))`;
};

// True when this record already passed this pipeline step (used to skip idempotent filters).
// When contactId is provided, only events for that contact count (multi-contact succession).
// Empty contact_id legacy rows are NOT treated as "any contact" when scoping — that made
// contact 2 inherit contact 1's completion.
export const hasPassedStep = ({
  db,
  recordId,
  stepId,
  contactId,
}: {
  db: ReturnType<typeof openListDb>;
  recordId: string;
  stepId: string;
  contactId?: string | null;
}): boolean => {
  const cid = String(contactId || '').trim();
  if (cid) {
    try {
      const row = db
        .prepare(`
          SELECT 1 FROM pipeline_events
          WHERE record_id = ? AND step_id = ? AND passed = 1
            AND contact_id = ?
          LIMIT 1
        `)
        .get(recordId, stepId, cid);
      return Boolean(row);
    } catch {
      // contact_id column may be absent on older harness DBs — fall through unscoped.
    }
  }
  const row = db
    .prepare('SELECT 1 FROM pipeline_events WHERE record_id = ? AND step_id = ? AND passed = 1 LIMIT 1')
    .get(recordId, stepId);
  return Boolean(row);
};

const ensureDataAccessViewsInternal = (db) => {
  db.exec(`
    DROP VIEW IF EXISTS records_enriched;
    CREATE VIEW records_enriched AS
    SELECT
      r.*,
      pc.contact_id AS primary_contact_id,
      pc.name AS primary_contact_name,
      pc.full_name AS primary_contact_full_name,
      pc.title AS primary_contact_title,
      pc.email AS primary_contact_email,
      pc.phone AS primary_contact_phone,
      pc.linkedin_url AS primary_contact_linkedin_url,
      pc.role AS primary_contact_role
    FROM records r
    LEFT JOIN contacts pc ON pc.contact_id = (
      SELECT c.contact_id
      FROM contacts c
      WHERE c.row_id = r._row_id
      ORDER BY c.is_primary DESC, c.updated_at DESC
      LIMIT 1
    );

    DROP VIEW IF EXISTS records_timeline;
    CREATE VIEW records_timeline AS
    SELECT
      ce.event_id AS timeline_id,
      ce.row_id AS row_id,
      ce.contact_id AS contact_id,
      'channel' AS event_family,
      ce.event_type AS event_type,
      ce.channel AS channel,
      ce.disposition AS disposition,
      CASE
        WHEN lower(ce.event_type) = 'reply' THEN COALESCE(json_extract(ce.payload_json, '$.classification'), '')
        ELSE ''
      END AS classification,
      ce.notes AS notes,
      ce.payload_json AS payload_json,
      ce.occurred_at AS occurred_at
    FROM channel_events ce
    UNION ALL
    SELECT
      se.event_id AS timeline_id,
      se.row_id AS row_id,
      '' AS contact_id,
      'score' AS event_family,
      se.axis || '_score_updated' AS event_type,
      '' AS channel,
      '' AS disposition,
      '' AS classification,
      se.reasoning AS notes,
      json_object('score', se.score, 'axis', se.axis) AS payload_json,
      se.computed_at AS occurred_at
    FROM score_events se
    UNION ALL
    SELECT
      rs.id AS timeline_id,
      rs.record_id AS row_id,
      '' AS contact_id,
      'visit' AS event_family,
      CASE WHEN rs.disposition != '' THEN 'visit_disposition' ELSE 'visit_scheduled' END AS event_type,
      'visit' AS channel,
      rs.disposition AS disposition,
      '' AS classification,
      rs.notes AS notes,
      json_object(
        'route_id', rs.route_id,
        'stop_order', rs.stop_order,
        'scheduled_time', rs.scheduled_time
      ) AS payload_json,
      COALESCE(NULLIF(rs.updated_at, ''), rs.created_at) AS occurred_at
    FROM route_stops rs
    UNION ALL
    SELECT
      cl.id AS timeline_id,
      cl.record_id AS row_id,
      '' AS contact_id,
      'compliance' AS event_family,
      cl.action AS event_type,
      '' AS channel,
      '' AS disposition,
      '' AS classification,
      cl.reason AS notes,
      cl.payload_json AS payload_json,
      cl.occurred_at AS occurred_at
    FROM compliance_log cl;

    DROP VIEW IF EXISTS sequence_state;
    CREATE VIEW sequence_state AS
    SELECT
      r._row_id AS row_id,
      r.business_name,
      r.sequence_name,
      r.pipeline_name,
      r.sequence_status,
      r.sequence_step,
      r.sequence_step_attempts,
      r.next_action_date,
      r.launched_at,
      r.email_last_reply_at,
      COALESCE(NULLIF(r.reply_classification_latest, ''), r.email_reply_classification, '') AS reply_classification_latest,
      r.disposition_latest,
      r.suppressed,
      r.dne_email,
      r.dnc_phone,
      r.dnk_visit,
      (
        SELECT COUNT(*)
        FROM drafts d
        WHERE d.row_id = r._row_id
          AND d.status = 'pending_approval'
      ) AS drafts_pending_approval,
      CASE
        WHEN r.suppressed = 1 THEN 'suppressed'
        WHEN r.sequence_status IN ('engaged', 'completed', 'opted_out', 'bounced') THEN r.sequence_status
        WHEN r.next_action_date = '' THEN 'awaiting_schedule'
        WHEN date(r.next_action_date) > date('now') THEN 'scheduled'
        ELSE 'due'
      END AS gating_state
    FROM records r;

    DROP VIEW IF EXISTS ai_usage;
    CREATE VIEW ai_usage AS
    SELECT
      ce.id AS usage_id,
      ce.record_id AS row_id,
      ce.step_id,
      ce.model,
      ce.provider,
      ce.input_tokens,
      ce.output_tokens,
      ce.cache_creation_tokens,
      ce.cache_read_tokens,
      ce.usd_cost,
      ce.occurred_at,
      date(ce.occurred_at) AS usage_date,
      COALESCE(json_extract(ce.payload_json, '$.run_id'), '') AS run_id
    FROM cost_events ce;

    DROP VIEW IF EXISTS tool_usage;
    CREATE VIEW tool_usage AS
    SELECT
      ce.id || ':' || CAST(j.key AS TEXT) AS usage_id,
      ce.record_id AS row_id,
      ce.step_id,
      UPPER(
        CASE
          WHEN instr(CAST(j.value AS TEXT), '.') > 0 THEN substr(CAST(j.value AS TEXT), 1, instr(CAST(j.value AS TEXT), '.') - 1)
          ELSE CAST(j.value AS TEXT)
        END
      ) AS toolkit,
      UPPER(CAST(j.value AS TEXT)) AS tool,
      1 AS calls,
      ce.occurred_at,
      date(ce.occurred_at) AS usage_date,
      COALESCE(json_extract(ce.payload_json, '$.run_id'), '') AS run_id
    FROM cost_events ce
    JOIN json_each(
      CASE
        WHEN json_valid(ce.tool_calls) THEN ce.tool_calls
        ELSE '[]'
      END
    ) j
    WHERE trim(CAST(j.value AS TEXT)) != '';
  `);
};

export const ensureDataAccessViews = ({ db }) => {
  ensureDataAccessViewsInternal(db);
};

const openDb = ({ dbPath, readonly = false }) => {
  const db = openRawDb({ dbPath, readonly });
  if (!readonly) {
    db.exec(SCHEMA_SQL);
    try { db.exec("ALTER TABLE records ADD COLUMN mail_last_cost_cents INTEGER DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE run_state ADD COLUMN step_index INTEGER DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE run_state ADD COLUMN step_total INTEGER DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE search_tasks ADD COLUMN pages_fetched INTEGER DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE search_tasks ADD COLUMN total_seen INTEGER DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE search_tasks ADD COLUMN new_unique INTEGER DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE search_tasks ADD COLUMN last_run_at TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE search_tasks ADD COLUMN attempt_count INTEGER DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE search_tasks ADD COLUMN last_error TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE notification_deliveries ADD COLUMN available_at TEXT NOT NULL DEFAULT ''"); } catch {}
    try { db.exec("UPDATE notification_deliveries SET available_at = created_at WHERE available_at = ''"); } catch {}
    ensureRecordCompatibility(db);
    migrateScoreStageData({ db });
    ensurePipelineEventCompatibility(db);
    ensureStalenessCompatibility(db);
    ensureScoreEventCompatibility(db);
    ensureContactCompatibility(db);
    ensureSuppressionCompatibility(db);
    ensureInboundMessageCompatibility(db);
    ensureTerritoryCompatibility(db);
    ensureDraftCompatibility(db);
    ensureLiveInteractionLedgerCompatibility(db);
    migrateContentAddressedEvidence({ db });
    ensureDataAccessViewsInternal(db);
  }
  return db;
};

/**
 * Open a list DB and pin listDir on the handle so every write chokepoint
 * (upsertRecord / insertDraft / updateDraft / insertChannelEvent / …) can
 * enforce canary isolation without each call site remembering to assert.
 */
export const openListDb = ({ listDir, readonly = false }) => {
  ensureListDirs(listDir);
  const dbPath = getDbPath(listDir);
  if (readonly && !existsSync(dbPath)) {
    throw new Error(`List DB does not exist: ${dbPath}`);
  }
  // Open raw first, pin listDir BEFORE schema/compatibility DML so canary can
  // scope whole-corpus updates (company_resolution backfill, contact projection).
  const db = openRawDb({ dbPath, readonly });
  try {
    Object.defineProperty(db, '__ao_list_dir', {
      value: String(listDir || ''),
      enumerable: false,
      writable: false,
      configurable: true,
    });
    Object.defineProperty(db, '__ao_readonly', {
      value: Boolean(readonly),
      enumerable: false,
      writable: false,
      configurable: true,
    });
  } catch {
    (db as any).__ao_list_dir = String(listDir || '');
    (db as any).__ao_readonly = Boolean(readonly);
  }
  if (!readonly) {
    db.exec(SCHEMA_SQL);
    try { db.exec("ALTER TABLE records ADD COLUMN mail_last_cost_cents INTEGER DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE run_state ADD COLUMN step_index INTEGER DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE run_state ADD COLUMN step_total INTEGER DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE search_tasks ADD COLUMN pages_fetched INTEGER DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE search_tasks ADD COLUMN total_seen INTEGER DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE search_tasks ADD COLUMN new_unique INTEGER DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE search_tasks ADD COLUMN last_run_at TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE search_tasks ADD COLUMN attempt_count INTEGER DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE search_tasks ADD COLUMN last_error TEXT DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE notification_deliveries ADD COLUMN available_at TEXT NOT NULL DEFAULT ''"); } catch {}
    try { db.exec("UPDATE notification_deliveries SET available_at = created_at WHERE available_at = ''"); } catch {}
    ensureRecordCompatibility(db);
    migrateScoreStageData({ db });
    ensurePipelineEventCompatibility(db);
    ensureStalenessCompatibility(db);
    ensureScoreEventCompatibility(db);
    ensureContactCompatibility(db);
    ensureSuppressionCompatibility(db);
    ensureInboundMessageCompatibility(db);
    ensureTerritoryCompatibility(db);
    ensureDraftCompatibility(db);
    ensureLiveInteractionLedgerCompatibility(db);
    migrateContentAddressedEvidence({ db });
    ensureDataAccessViewsInternal(db);
  }
  return db;
};

/**
 * Unavoidable canary gate for any record mutation on a list-scoped db handle.
 * No-op when mode=off or listDir was not pinned (unit tests with raw better-sqlite3).
 */
export const enforceCanaryRecordMutation = (db: any, recordId: unknown) => {
  if (!db || db.__ao_readonly) return;
  const listDir = String(db.__ao_list_dir || '').trim();
  if (!listDir) return;
  const rid = String(recordId || '').trim();
  if (!rid) return;
  // Lazy import avoids circular dependency (canary-isolation → paths; db → canary).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { assertRecordAccessForMutation } = require('../policy/canary-isolation.js') as typeof import('../policy/canary-isolation.js');
  assertRecordAccessForMutation({ listDir, recordId: rid });
};

export const openGlobalSuppressionDb = ({ readonly = false } = {}) => {
  ensureGlobalDirs();
  const dbPath = getGlobalSuppressionDbPath();
  const db = openRawDb({ dbPath, readonly });
  if (!readonly) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS suppression (
        entry_id TEXT PRIMARY KEY,
        id TEXT DEFAULT '',
        identifier_value TEXT NOT NULL,
        identifier_type TEXT NOT NULL,
        value TEXT DEFAULT '',
        value_type TEXT DEFAULT '',
        scope TEXT NOT NULL,
        reason TEXT NOT NULL,
        source TEXT DEFAULT '',
        row_id TEXT DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_suppression_value ON suppression(identifier_type, identifier_value);
    `);
    ensureSuppressionCompatibility(db);
  }
  return db;
};

export const withListDb = ({ listDir, readonly = false }, fn) => {
  const db = openListDb({ listDir, readonly });
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

const safeJson = (value) => {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
};

const normalizeAssetRow = (row: unknown): Asset | null => {
  if (!row || typeof row !== 'object') return null;
  const asset = row as Record<string, unknown>;
  return {
    asset_id: String(asset.asset_id || ''),
    row_id: String(asset.row_id || ''),
    step_id: String(asset.step_id || ''),
    label: String(asset.label || ''),
    result: String(asset.result || ''),
    outputs_json: String(asset.outputs_json || '{}'),
    is_reference: Number(asset.is_reference || 0) === 1,
    status: String(asset.status || 'ready'),
    reason: String(asset.reason || ''),
    created_at: String(asset.created_at || ''),
    updated_at: String(asset.updated_at || ''),
  };
};

const appendJsonLine = (path, payload) => {
  appendFileSync(path, `${JSON.stringify(payload)}\n`);
};

export const logSourcingEvent = ({ listDir, payload }) => {
  appendJsonLine(getSourcingLogPath(listDir), { at: nowIso(), ...payload });
};

export const logPipelineEvent = ({ listDir, payload }) => {
  appendJsonLine(getPipelineLogPath(listDir), { at: nowIso(), ...payload });
};

export const logComplianceEvent = ({ listDir, payload }) => {
  appendJsonLine(getComplianceLogPath(listDir), { at: nowIso(), ...payload });
};

export const logCrmEvent = ({ listDir, payload }) => {
  appendJsonLine(getCrmLogPath(listDir), { at: nowIso(), ...payload });
};

export const logCostEventFile = ({ listDir, payload }) => {
  appendJsonLine(getCostsLogPath(listDir), { at: nowIso(), ...payload });
};

export const insertCostEvent = ({ db, event }) => {
  enforceCanaryRecordMutation(db, event?.record_id || event?.row_id);
  db.prepare(`
    INSERT INTO cost_events (
      id, record_id, step_id, model, input_tokens, output_tokens, cache_creation_tokens,
      cache_read_tokens, tool_calls, usd_cost, provider, payload_json, occurred_at
    ) VALUES (
      @id, @record_id, @step_id, @model, @input_tokens, @output_tokens, @cache_creation_tokens,
      @cache_read_tokens, @tool_calls, @usd_cost, @provider, @payload_json, @occurred_at
    )
  `).run({
    id: event.id,
    record_id: event.record_id || '',
    step_id: event.step_id,
    model: event.model || '',
    input_tokens: Number(event.input_tokens || 0),
    output_tokens: Number(event.output_tokens || 0),
    cache_creation_tokens: Number(event.cache_creation_tokens || 0),
    cache_read_tokens: Number(event.cache_read_tokens || 0),
    tool_calls: Array.isArray(event.tool_calls) ? JSON.stringify(event.tool_calls) : (event.tool_calls || '[]'),
    usd_cost: event.usd_cost === null || event.usd_cost === undefined
      ? null
      : Number(event.usd_cost),
    provider: event.provider || '',
    payload_json: safeJson(event.payload),
    occurred_at: event.occurred_at || nowIso(),
  });
};

export const insertActivityEvent = ({ db, event }) => {
  db.prepare(`
    INSERT INTO activity_history (id, event_type, event, phase, row_id, payload_json, occurred_at)
    VALUES (@id, @event_type, @event, @phase, @row_id, @payload_json, @occurred_at)
  `).run({
    id: event.id,
    event_type: event.event_type || event.event,
    event: event.event,
    phase: event.phase || '',
    row_id: event.row_id || '',
    payload_json: safeJson(event.payload),
    occurred_at: event.occurred_at || nowIso(),
  });
};

const insertAccountTimelineEvent = ({ db, event }) => {
  try {
    db.prepare(`
      INSERT INTO account_timeline (
        timeline_id, row_id, contact_id, event_family, event_type, channel,
        disposition, classification, notes, payload_json, occurred_at, created_at
      ) VALUES (
        @timeline_id, @row_id, @contact_id, @event_family, @event_type, @channel,
        @disposition, @classification, @notes, @payload_json, @occurred_at, @created_at
      )
    `).run({
      timeline_id: event.timeline_id,
      row_id: event.row_id,
      contact_id: event.contact_id || '',
      event_family: event.event_family,
      event_type: event.event_type,
      channel: event.channel || '',
      disposition: event.disposition || '',
      classification: event.classification || '',
      notes: event.notes || '',
      payload_json: safeJson(event.payload),
      occurred_at: event.occurred_at || nowIso(),
      created_at: nowIso(),
    });
  } catch {
    // Timeline writes are additive and should not break the caller path.
  }
};

export const insertScoreEvent = ({ db, event }) => {
  ensureScoreEventCompatibility(db);
  db.prepare(`
    INSERT INTO score_events (event_id, row_id, axis, stage_id, score, reasoning, breakdown_json, computed_at)
    VALUES (@event_id, @row_id, @axis, @stage_id, @score, @reasoning, @breakdown_json, @computed_at)
  `).run({
    event_id: event.event_id || event.id,
    row_id: event.row_id,
    axis: String(event.axis || ''),
    stage_id: String(event.stage_id || event.step_id || ''),
    score: Number(event.score || 0),
    reasoning: String(event.reasoning || ''),
    breakdown_json: safeJson(event.breakdown),
    computed_at: event.computed_at || nowIso(),
  });
  insertAccountTimelineEvent({
    db,
    event: {
      timeline_id: event.event_id || event.id,
      row_id: event.row_id,
      event_family: 'score',
      event_type: `${String(event.axis || '').trim()}_score_updated`,
      notes: String(event.reasoning || ''),
      payload: {
        axis: String(event.axis || ''),
        stage_id: String(event.stage_id || event.step_id || ''),
        score: Number(event.score || 0),
      },
      occurred_at: event.computed_at || nowIso(),
    },
  });
};

export const syncNextActionDateFromPipelineEvents = ({
  db,
  recordId,
}: {
  db: {
    prepare: (sql: string) => {
      get: (...params: unknown[]) => { wake_at?: unknown } | undefined;
      run: (...params: unknown[]) => unknown;
    };
  };
  recordId: string;
}) => {
  const id = String(recordId || '').trim();
  if (!id) return '';
  const pending = db.prepare(`
    SELECT MIN(event.wake_at) AS wake_at
    FROM pipeline_events event
    WHERE event.record_id = ?
      AND event.passed = 0
      AND event.reason = 'wake_at'
      AND COALESCE(event.wake_at, '') != ''
      AND NOT EXISTS (
        SELECT 1
        FROM pipeline_events completed
        WHERE completed.record_id = event.record_id
          AND completed.step_id = event.step_id
          AND completed.passed = 1
      )
  `).get(id);
  const wakeAt = String(pending?.wake_at || '');
  db.prepare('UPDATE records SET next_action_date = ?, updated_at = ? WHERE _row_id = ?')
    .run(wakeAt, nowIso(), id);
  return wakeAt;
};

export const insertPipelineEvent = ({ db, event }) => {
  enforceCanaryRecordMutation(db, event?.record_id || event?.row_id);
  ensurePipelineEventCompatibility(db);
  db.prepare(`
    INSERT INTO pipeline_events (
      event_id, record_id, step_id, kind, passed, reason, wake_at, side_effecting, contact_id, occurred_at
    )
    VALUES (
      @event_id, @record_id, @step_id, @kind, @passed, @reason, @wake_at, @side_effecting, @contact_id, @occurred_at
    )
  `).run({
    event_id: event.event_id || event.id,
    record_id: event.record_id || event.row_id,
    step_id: String(event.step_id || ''),
    kind: String(event.kind || ''),
    passed: event.passed ? 1 : 0,
    reason: String(event.reason || ''),
    wake_at: String(event.wake_at || ''),
    side_effecting: event.side_effecting ? 1 : 0,
    contact_id: String(event.contact_id || event.active_contact_id || ''),
    occurred_at: event.occurred_at || nowIso(),
  });
  if (String(event.reason || '') === 'wake_at' || String(event.kind || '') === 'wait') {
    syncNextActionDateFromPipelineEvents({
      db,
      recordId: String(event.record_id || event.row_id || ''),
    });
  }
};

export const inPlayWhere = (alias = '') => {
  const prefix = String(alias || '').trim();
  const disqualifiedCol = prefix ? `${prefix}.disqualified_at` : 'disqualified_at';
  const suppressedCol = prefix ? `${prefix}.suppressed` : 'suppressed';
  return `((${disqualifiedCol} IS NULL OR ${disqualifiedCol} = '') AND lower(trim(CAST(COALESCE(${suppressedCol}, 0) AS TEXT))) IN ('', '0', 'false', 'no', 'off'))`;
};

const getTableColumns = (db, table) => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(cols.map((c) => c.name));
};

const scoreValueForWrite = (value) => {
  if (value === null) return null;
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : null;
};

const fitScoreValueForWrite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const isDynamicRecordValue = (value) => (
  value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint'
);

const SUPPRESSION_FLAG_FIELDS = new Set([
  'suppressed',
  'phone_suppressed',
  'dne_phone',
  'dne_email',
  'dnc_phone',
  'dnk_visit',
  'do_not_sms',
  'email_suppressed',
  'mail_suppressed',
]);

const BOOLEANISH_RECORD_FIELDS = new Set([
  ...SUPPRESSION_FLAG_FIELDS,
  'email_opted_out',
  'opted_out_email',
  'email_bounced',
  'linkedin_connected',
]);

const normalizeBooleanishRecordFields = (row) => Object.fromEntries(
  Object.entries(row).map(([field, value]) => {
    const isSuppressionFlag = SUPPRESSION_FLAG_FIELDS.has(field);
    const isBooleanishFlag = BOOLEANISH_RECORD_FIELDS.has(field);
    const isReadinessFlag = field.endsWith('_validated') || field.endsWith('_ready');
    if (!isBooleanishFlag && !isReadinessFlag) return [field, value];
    return [field, Number(isAffirmativeFlag(value, { failClosed: isSuppressionFlag }))];
  }),
);

const PRIMARY_CONTACT_PROJECTION_FIELDS = new Set([
  'contact_name',
  'contact_first_name',
  'contact_title',
  'contact_email',
  'contact_name_primary',
  'contact_title_primary',
  'owner_name',
]);

// Overlay active human field overrides onto an incoming row. upsertRecord is the
// chokepoint every writer (enrichment, generate, scoring, sequencer) flows
// through, so a manually-set field can never be clobbered by a pipeline rerun.
const withFieldOverrides = ({ db, recordId, row }) => {
  const overrides = (() => {
    try {
      return activeFieldOverrideMap({ db, recordId });
    } catch {
      return new Map();
    }
  })();
  if (overrides.size === 0) return row;
  return { ...row, ...Object.fromEntries(overrides) };
};

export const draftRevocationReason = (record: Record<string, unknown> | null | undefined): string | null => {
  const disqualifiedAt = String(record?.disqualified_at || '').trim();
  const lifecycle = String(record?.lifecycle_stage || '').trim().toLowerCase();
  if (disqualifiedAt || lifecycle === 'disqualified') return 'record_disqualified';
  if (!isAffirmativeFlag(record?.suppressed, { failClosed: true })) return null;
  const suppressionReason = String(record?.suppressed_reason || '').trim().toLowerCase();
  if (suppressionReason.includes('opt_out') || suppressionReason.includes('opt-out')) return 'record_opted_out';
  if (suppressionReason.includes('dnc') || suppressionReason.includes('do_not_contact')) return 'record_dnc';
  return 'record_suppressed';
};

export const revokeQueuedDraftsForRecord = ({
  db,
  record,
}: {
  db: any;
  record: Record<string, unknown> | null | undefined;
}): { revoked: number; reason: string | null } => {
  const rowId = String(record?._row_id || record?.id || '').trim();
  const reason = draftRevocationReason(record);
  if (!rowId || !reason) return { revoked: 0, reason: null };
  ensureDraftCompatibility(db);
  const result = db.prepare(`
    UPDATE drafts
    SET status = 'revoked', reason = ?, updated_at = ?
    WHERE row_id = ? AND status IN ('pending_approval', 'ready')
  `).run(reason, nowIso(), rowId);
  return { revoked: Number(result?.changes || 0), reason };
};

export const revokeQueuedDraftsForSuppression = ({
  db,
  value,
  valueType,
  reason,
}: {
  db: any;
  value: string;
  valueType: string;
  reason: string;
}): number => {
  const normalizedValue = String(value || '').trim().toLowerCase();
  const normalizedType = String(valueType || '').trim().toLowerCase();
  if (!normalizedValue || !['email', 'linkedin'].includes(normalizedType)) return 0;
  const recipientColumn = normalizedType === 'email' ? 'contact_email' : 'contact_linkedin_url';
  const legacyRecipientColumn = normalizedType === 'email' ? 'email_primary' : 'contact_linkedin_url';
  const result = db.prepare(`
    UPDATE drafts
    SET status = 'revoked', reason = ?, updated_at = ?
    WHERE status IN ('pending_approval', 'ready')
      AND channel = ?
      AND row_id IN (
        SELECT _row_id
        FROM records
        WHERE lower(COALESCE(${recipientColumn}, '')) = ?
           OR lower(COALESCE(${legacyRecipientColumn}, '')) = ?
      )
  `).run(
    `global_${normalizedType}_suppression:${String(reason || 'manual_suppress')}`,
    nowIso(),
    normalizedType,
    normalizedValue,
    normalizedValue,
  );
  return Number(result?.changes || 0);
};

export const upsertRecord = ({ db, row: inputRow }) => {
  const rowId = String(inputRow._row_id || inputRow.id || '').trim();
  if (!rowId) throw new Error('Record id/_row_id is required.');
  enforceCanaryRecordMutation(db, rowId);
  const current = db.prepare(`
    SELECT id, _row_id, contact_name, contact_first_name, contact_title, contact_email,
      contact_name_primary, contact_title_primary, pipeline_name
    FROM records
    WHERE _row_id = ? OR id = ?
  `).get(rowId, rowId);
  const row = normalizeBooleanishRecordFields(withFieldOverrides({
    db,
    recordId: String(current?._row_id || rowId),
    row: inputRow,
  }));
  const timestamp = nowIso();

  // Prefer _row_id existence: many records leave legacy `id` empty.
  if (current?._row_id || current?.id) {
    const knownFields = [
      '_row_id', '_created_at', '_updated_at',
      'business_name', 'address', 'city', 'state', 'zip', 'postal_code', 'country', 'website', 'domain', 'phone',
      'email_primary', 'contact_name_primary', 'contact_title_primary', 'fit_score', 'trigger_score',
      'fit_reasoning', 'trigger_reasoning',
      'priority_rank', 'sequence_name', 'pipeline_name', 'routed_by', 'sequence_status', 'sequence_step', 'next_action_date',
      'last_outreach_at', 'email_last_message_id', 'email_last_from', 'assigned_mailbox_id', 'email_last_thread_id', 'email_last_draft_id',
      'email_thread_id', 'contact_name', 'contact_first_name', 'contact_email', 'contact_title',
      'email_verification_status', 'email_verification_confidence', 'email_verified_at',
      'trigger_score_peak',
      'fit_updated_at', 'trigger_updated_at',
      'fit_score_updated_at', 'trigger_score_updated_at', 'source', 'source_query', 'sourced_at',
      'duplicate_of', 'duplicate_status', 'duplicate_reason', 'source_filter_result', 'source_filter_failures',
      'disqualified_at', 'disqualified_gate', 'disqualify_reason',
      'google_place_id', 'parent_row_id', 'latitude', 'longitude', 'workflow_signals',
      'vertical', 'sub_vertical', 'size_tier', 'is_franchise', 'persona',
      'outcome_at', 'outcome_value', 'launched_at', 'sequence_step_attempts',
      'email_last_reply_at', 'email_reply_classification', 'reply_classification_latest', 'disposition_latest', 'disposition_follow_up_at',
      'mail_last_piece_id', 'mail_last_cost_cents', 'mail_last_expected_delivery',
      'mail_last_delivered_at', 'mail_last_returned_at', 'visit_scheduled_date', 'visit_route_id', 'visit_route_position',
      'sms_last_message_id', 'call_last_disposition', 'suppressed', 'suppressed_reason', 'suppressed_at',
      'do_not_sms',
      'dne_email', 'dnc_phone', 'dnk_visit',
      'crm_company_id', 'crm_person_id', 'crm_deal_id', 'crm_last_synced_at', 'crm_sync_hash',
      'outcome', 'outcome_notes', 'extra_json', 'retry_count', 'last_error',
    ];
    const tableCols = getTableColumns(db, 'records');
    const dynamicFields = Object.keys(row).filter((k) => (
      tableCols.has(k)
        && !knownFields.includes(k)
        && !PRIMARY_CONTACT_PROJECTION_FIELDS.has(k)
        && k !== 'id'
        && k !== 'updated_at'
        && isDynamicRecordValue(row[k])
    ));
    const fields = [...knownFields, ...dynamicFields];

    const setSql = fields.map((field) => `${field} = @${field}`).join(', ');
    db.prepare(`UPDATE records SET ${setSql}, updated_at = @updated_at WHERE _row_id = @_row_id_current`).run({
      ...row,
      _row_id: row._row_id || rowId,
      id: row.id || row._row_id || rowId,
      _created_at: row._created_at || row.created_at || timestamp,
      _updated_at: timestamp,
      zip: row.zip || row.postal_code || '',
      email_thread_id: row.email_thread_id || row.email_last_thread_id || '',
      contact_name_primary: current.contact_name_primary || '',
      contact_title_primary: current.contact_title_primary || '',
      contact_name: current.contact_name || '',
      contact_first_name: current.contact_first_name || '',
      contact_email: current.contact_email || '',
      contact_title: current.contact_title || '',
      email_verification_status: row.email_verification_status || '',
      email_verification_confidence: Number(row.email_verification_confidence || 0),
      email_verified_at: row.email_verified_at || '',
      fit_score: fitScoreValueForWrite(row.fit_score),
      trigger_score: scoreValueForWrite(row.trigger_score),
      priority_rank: scoreValueForWrite(row.priority_rank),
      pipeline_name: row.pipeline_name || current.pipeline_name || 'default',
      fit_reasoning: row.fit_reasoning || '',
      trigger_reasoning: row.trigger_reasoning || '',
      mail_last_cost_cents: Number(row.mail_last_cost_cents || 0),
      mail_last_returned_at: row.mail_last_returned_at || '',
      fit_updated_at: row.fit_updated_at || row.fit_score_updated_at || '',
      trigger_updated_at: row.trigger_updated_at || row.trigger_score_updated_at || '',
      reply_classification_latest: row.reply_classification_latest || row.email_reply_classification || '',
      disposition_latest: row.disposition_latest || '',
      disposition_follow_up_at: row.disposition_follow_up_at || '',
      source: row.source || '',
      source_query: row.source_query || '',
      sourced_at: row.sourced_at || '',
      duplicate_of: row.duplicate_of || '',
      duplicate_status: row.duplicate_status || '',
      duplicate_reason: row.duplicate_reason || '',
      source_filter_result: row.source_filter_result || '',
      source_filter_failures: row.source_filter_failures || '',
      disqualified_at: row.disqualified_at || '',
      disqualified_gate: row.disqualified_gate || '',
      disqualify_reason: row.disqualify_reason || '',
      workflow_signals: typeof row.workflow_signals === 'string' ? row.workflow_signals : safeJson(row.workflow_signals),
      suppressed: Number(isAffirmativeFlag(row.suppressed, { failClosed: true })),
      do_not_sms: Number(isAffirmativeFlag(row.do_not_sms, { failClosed: true })),
      dne_email: Number(isAffirmativeFlag(row.dne_email, { failClosed: true })),
      dnc_phone: Number(isAffirmativeFlag(row.dnc_phone, { failClosed: true })),
      dnk_visit: Number(isAffirmativeFlag(row.dnk_visit, { failClosed: true })),
      is_franchise: row.is_franchise ? 1 : 0,
      extra_json: typeof row.extra_json === 'string' ? row.extra_json : safeJson(row.extra_json),
      _row_id_current: current._row_id || current.id,
      updated_at: timestamp,
    });
    // account_contact_plan_json owns the record-level recipient. Rehydrate it
    // whenever that plan is written because upsertRecord intentionally locks
    // contact_* projection fields against arbitrary pipeline outputs.
    if (row.account_contact_plan_json !== undefined) {
      syncPrimaryContactProjectionInternal({ db, recordId: String(current._row_id || current.id || rowId) });
    }
    revokeQueuedDraftsForRecord({
      db,
      record: {
        ...row,
        _row_id: String(current._row_id || current.id || rowId),
      },
    });
    return;
  }

  const tableCols = getTableColumns(db, 'records');
  const knownInsertFields = new Set([
    '_row_id', '_created_at', '_updated_at', 'id', 'business_name', 'address', 'city', 'state', 'zip',
    'postal_code', 'country', 'website', 'domain', 'phone', 'email_primary', 'contact_name_primary',
    'contact_title_primary', 'fit_score', 'trigger_score', 'priority_rank', 'fit_reasoning', 'trigger_reasoning',
    'sequence_name', 'pipeline_name', 'routed_by', 'sequence_status', 'sequence_step', 'next_action_date', 'last_outreach_at',
    'email_last_message_id', 'email_last_from', 'assigned_mailbox_id', 'email_last_thread_id', 'email_last_draft_id', 'email_last_reply_at',
    'email_reply_classification', 'reply_classification_latest', 'disposition_latest', 'disposition_follow_up_at',
    'email_thread_id', 'contact_name', 'contact_first_name', 'contact_email', 'contact_title', 'email_verification_status',
    'email_verification_confidence', 'email_verified_at', 'trigger_score_peak', 'fit_updated_at',
    'trigger_updated_at', 'fit_score_updated_at', 'trigger_score_updated_at', 'source', 'source_query',
    'sourced_at', 'duplicate_of', 'duplicate_status', 'duplicate_reason', 'source_filter_result', 'source_filter_failures',
    'disqualified_at', 'disqualified_gate', 'disqualify_reason', 'google_place_id', 'parent_row_id',
    'latitude', 'longitude', 'workflow_signals', 'vertical', 'sub_vertical', 'size_tier', 'is_franchise',
    'persona', 'outcome_at', 'outcome_value', 'launched_at', 'sequence_step_attempts', 'mail_last_piece_id',
    'mail_last_cost_cents', 'mail_last_expected_delivery', 'mail_last_delivered_at', 'mail_last_returned_at',
    'visit_scheduled_date', 'visit_route_id', 'visit_route_position', 'sms_last_message_id',
    'call_last_disposition', 'suppressed', 'suppressed_reason', 'suppressed_at', 'do_not_sms',
    'dne_email', 'dnc_phone', 'dnk_visit', 'crm_company_id', 'crm_person_id', 'crm_deal_id',
    'crm_last_synced_at', 'crm_sync_hash', 'outcome', 'outcome_notes', 'extra_json', 'retry_count',
    'last_error', 'created_at', 'updated_at',
  ]);
  const dynamicFields = Object.keys(row).filter((key) => (
    tableCols.has(key)
      && !knownInsertFields.has(key)
      && !PRIMARY_CONTACT_PROJECTION_FIELDS.has(key)
      && key !== 'updated_at'
      && isDynamicRecordValue(row[key])
  ));

  db.prepare(`
    INSERT INTO records (
      _row_id, _created_at, _updated_at,
      id, business_name, address, city, state, zip, postal_code, country, website, domain, phone,
      email_primary, contact_name_primary, contact_title_primary, fit_score, trigger_score, priority_rank,
      fit_reasoning, trigger_reasoning,
      sequence_name, pipeline_name, routed_by, sequence_status, sequence_step, next_action_date, last_outreach_at, email_last_message_id, email_last_from, assigned_mailbox_id,
      email_last_thread_id, email_last_draft_id, email_last_reply_at, email_reply_classification,
      reply_classification_latest, disposition_latest, disposition_follow_up_at,
      email_thread_id, contact_name, contact_first_name, contact_email, contact_title,
      email_verification_status, email_verification_confidence, email_verified_at,
      trigger_score_peak,
      fit_updated_at, trigger_updated_at,
      fit_score_updated_at, trigger_score_updated_at,
      source, source_query, sourced_at, duplicate_of, duplicate_status, duplicate_reason, source_filter_result, source_filter_failures,
      disqualified_at, disqualified_gate, disqualify_reason,
      google_place_id, parent_row_id, latitude, longitude,
      workflow_signals, vertical, sub_vertical, size_tier, is_franchise, persona,
      outcome_at, outcome_value, launched_at, sequence_step_attempts,
      mail_last_piece_id, mail_last_cost_cents, mail_last_expected_delivery, mail_last_delivered_at, mail_last_returned_at, visit_scheduled_date,
      visit_route_id, visit_route_position, sms_last_message_id, call_last_disposition, suppressed,
      suppressed_reason, suppressed_at, do_not_sms,
      dne_email, dnc_phone, dnk_visit,
      crm_company_id, crm_person_id, crm_deal_id, crm_last_synced_at, crm_sync_hash, outcome, outcome_notes,
      extra_json, retry_count, last_error, created_at, updated_at
    ) VALUES (
      @_row_id, @_created_at, @_updated_at,
      @id, @business_name, @address, @city, @state, @zip, @postal_code, @country, @website, @domain, @phone,
      @email_primary, @contact_name_primary, @contact_title_primary, @fit_score, @trigger_score, @priority_rank,
      @fit_reasoning, @trigger_reasoning,
      @sequence_name, @pipeline_name, @routed_by, @sequence_status, @sequence_step, @next_action_date, @last_outreach_at, @email_last_message_id, @email_last_from, @assigned_mailbox_id,
      @email_last_thread_id, @email_last_draft_id, @email_last_reply_at, @email_reply_classification,
      @reply_classification_latest, @disposition_latest, @disposition_follow_up_at,
      @email_thread_id, @contact_name, @contact_first_name, @contact_email, @contact_title,
      @email_verification_status, @email_verification_confidence, @email_verified_at,
      @trigger_score_peak,
      @fit_updated_at, @trigger_updated_at,
      @fit_score_updated_at, @trigger_score_updated_at,
      @source, @source_query, @sourced_at, @duplicate_of, @duplicate_status, @duplicate_reason, @source_filter_result, @source_filter_failures,
      @disqualified_at, @disqualified_gate, @disqualify_reason,
      @google_place_id, @parent_row_id, @latitude, @longitude,
      @workflow_signals, @vertical, @sub_vertical, @size_tier, @is_franchise, @persona,
      @outcome_at, @outcome_value, @launched_at, @sequence_step_attempts,
      @mail_last_piece_id, @mail_last_cost_cents, @mail_last_expected_delivery, @mail_last_delivered_at, @mail_last_returned_at, @visit_scheduled_date,
      @visit_route_id, @visit_route_position, @sms_last_message_id, @call_last_disposition, @suppressed,
      @suppressed_reason, @suppressed_at, @do_not_sms,
      @dne_email, @dnc_phone, @dnk_visit,
      @crm_company_id, @crm_person_id, @crm_deal_id, @crm_last_synced_at, @crm_sync_hash, @outcome, @outcome_notes,
      @extra_json, @retry_count, @last_error, @created_at, @updated_at
    )
  `).run({
    _row_id: row._row_id || rowId,
    _created_at: row._created_at || row.created_at || timestamp,
    _updated_at: timestamp,
    business_name: row.business_name || '',
    address: row.address || '',
    city: row.city || '',
    state: row.state || '',
    zip: row.zip || row.postal_code || '',
    postal_code: row.postal_code || '',
    country: row.country || '',
    website: row.website || '',
    domain: row.domain || '',
    phone: row.phone || '',
    email_primary: row.email_primary || '',
    contact_name_primary: '',
    contact_title_primary: '',
    fit_score: fitScoreValueForWrite(row.fit_score),
    trigger_score: scoreValueForWrite(row.trigger_score),
    fit_reasoning: row.fit_reasoning || '',
    trigger_reasoning: row.trigger_reasoning || '',
    priority_rank: scoreValueForWrite(row.priority_rank),
    sequence_name: row.sequence_name || 'default',
    pipeline_name: row.pipeline_name || 'default',
    routed_by: row.routed_by || '',
    sequence_status: row.sequence_status || 'idle',
    sequence_step: Number(row.sequence_step || 0),
    next_action_date: row.next_action_date || '',
    last_outreach_at: row.last_outreach_at || '',
    email_last_message_id: row.email_last_message_id || '',
    email_last_from: row.email_last_from || '',
    assigned_mailbox_id: row.assigned_mailbox_id || '',
    email_last_thread_id: row.email_last_thread_id || '',
    email_last_draft_id: row.email_last_draft_id || '',
    email_last_reply_at: row.email_last_reply_at || '',
    email_reply_classification: row.email_reply_classification || '',
    reply_classification_latest: row.reply_classification_latest || row.email_reply_classification || '',
    disposition_latest: row.disposition_latest || '',
    disposition_follow_up_at: row.disposition_follow_up_at || '',
    email_thread_id: row.email_thread_id || row.email_last_thread_id || '',
    contact_name: '',
    contact_first_name: '',
    contact_email: '',
    contact_title: '',
    email_verification_status: row.email_verification_status || '',
    email_verification_confidence: Number(row.email_verification_confidence || 0),
    email_verified_at: row.email_verified_at || '',
    trigger_score_peak: Number(row.trigger_score_peak || row.trigger_score || 0),
    fit_updated_at: row.fit_updated_at || row.fit_score_updated_at || '',
    trigger_updated_at: row.trigger_updated_at || row.trigger_score_updated_at || '',
    fit_score_updated_at: row.fit_score_updated_at || '',
    trigger_score_updated_at: row.trigger_score_updated_at || '',
    source: row.source || '',
    source_query: row.source_query || '',
    sourced_at: row.sourced_at || '',
    duplicate_of: row.duplicate_of || '',
    duplicate_status: row.duplicate_status || '',
    duplicate_reason: row.duplicate_reason || '',
    source_filter_result: row.source_filter_result || '',
    source_filter_failures: row.source_filter_failures || '',
    disqualified_at: row.disqualified_at || '',
    disqualified_gate: row.disqualified_gate || '',
    disqualify_reason: row.disqualify_reason || '',
    google_place_id: row.google_place_id || '',
    parent_row_id: row.parent_row_id || '',
    latitude: Number(row.latitude || 0),
    longitude: Number(row.longitude || 0),
    workflow_signals: typeof row.workflow_signals === 'string' ? row.workflow_signals : safeJson(row.workflow_signals),
    vertical: row.vertical || '',
    sub_vertical: row.sub_vertical || '',
    size_tier: row.size_tier || '',
    is_franchise: row.is_franchise ? 1 : 0,
    persona: row.persona || '',
    outcome_at: row.outcome_at || '',
    outcome_value: Number(row.outcome_value || 0),
    launched_at: row.launched_at || '',
    sequence_step_attempts: Number(row.sequence_step_attempts || 0),
    mail_last_piece_id: row.mail_last_piece_id || '',
    mail_last_cost_cents: Number(row.mail_last_cost_cents || 0),
    mail_last_expected_delivery: row.mail_last_expected_delivery || '',
    mail_last_delivered_at: row.mail_last_delivered_at || '',
    mail_last_returned_at: row.mail_last_returned_at || '',
    visit_scheduled_date: row.visit_scheduled_date || '',
    visit_route_id: row.visit_route_id || '',
    visit_route_position: Number(row.visit_route_position || 0),
    sms_last_message_id: row.sms_last_message_id || '',
    call_last_disposition: row.call_last_disposition || '',
    suppressed: Number(isAffirmativeFlag(row.suppressed, { failClosed: true })),
    suppressed_reason: row.suppressed_reason || '',
    suppressed_at: row.suppressed_at || '',
    do_not_sms: Number(isAffirmativeFlag(row.do_not_sms, { failClosed: true })),
    dne_email: Number(isAffirmativeFlag(row.dne_email, { failClosed: true })),
    dnc_phone: Number(isAffirmativeFlag(row.dnc_phone, { failClosed: true })),
    dnk_visit: Number(isAffirmativeFlag(row.dnk_visit, { failClosed: true })),
    crm_company_id: row.crm_company_id || '',
    crm_person_id: row.crm_person_id || '',
    crm_deal_id: row.crm_deal_id || '',
    crm_last_synced_at: row.crm_last_synced_at || '',
    crm_sync_hash: row.crm_sync_hash || '',
    outcome: row.outcome || '',
    outcome_notes: row.outcome_notes || '',
    extra_json: typeof row.extra_json === 'string' ? row.extra_json : safeJson(row.extra_json),
    retry_count: Number(row.retry_count || 0),
    last_error: row.last_error || '',
    id: rowId,
    created_at: row.created_at || timestamp,
    updated_at: timestamp,
  });

  if (dynamicFields.length > 0) {
    const setSql = dynamicFields.map((field) => `${field} = @${field}`).join(', ');
    db.prepare(`UPDATE records SET ${setSql}, updated_at = @updated_at WHERE _row_id = @_row_id_current`).run({
      ...row,
      _row_id_current: rowId,
      updated_at: timestamp,
    });
  }
  revokeQueuedDraftsForRecord({ db, record: { ...row, _row_id: row._row_id || rowId } });
};

export const listRecords = ({ db, whereSql = '1=1', params = [], limit = 1000, orderBy = 'updated_at DESC' }) =>
  db.prepare(`SELECT * FROM records WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ?`).all(...params, Number(limit));

export const getRecordById = ({ db, id }) => db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ?').get(id, id);

export const setLeadTerritories = ({ db, rowId, territoryIds, at = '' }) => {
  const cleanIds = [...new Set((Array.isArray(territoryIds) ? territoryIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
  const assignedAt = String(at || nowIso());
  const write = db.transaction(() => {
    db.prepare('DELETE FROM lead_territories WHERE row_id = ?').run(String(rowId));
    const insert = db.prepare('INSERT OR REPLACE INTO lead_territories (row_id, territory_id, assigned_at) VALUES (?, ?, ?)');
    cleanIds.forEach((territoryId) => insert.run(String(rowId), territoryId, assignedAt));
  });
  write();
  return { row_id: String(rowId), territory_ids: cleanIds, assigned_at: assignedAt };
};

export const getTerritoryMembership = ({ db }) => {
  const rows = db.prepare('SELECT territory_id, row_id FROM lead_territories ORDER BY territory_id, row_id').all();
  return rows.reduce((map, row) => {
    const territoryId = String(row.territory_id || '');
    const rowId = String(row.row_id || '');
    if (!territoryId || !rowId) return map;
    const set = map.get(territoryId) || new Set();
    set.add(rowId);
    map.set(territoryId, set);
    return map;
  }, new Map());
};

export const getTerritoriesForRow = ({ db, rowId }) => db
  .prepare('SELECT territory_id FROM lead_territories WHERE row_id = ? ORDER BY territory_id')
  .all(String(rowId))
  .map((row) => String(row.territory_id || ''))
  .filter(Boolean);

export const insertTerritoryNote = ({ db, territoryId, body, createdBy = '' }) => {
  const now = nowIso();
  const noteId = `tnote_${randomUUID().slice(0, 12)}`;
  db.prepare(`
    INSERT INTO territory_notes (note_id, territory_id, body, created_at, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(noteId, String(territoryId || ''), String(body || ''), now, String(createdBy || ''));
  return db.prepare('SELECT * FROM territory_notes WHERE note_id = ?').get(noteId);
};

export const getTerritoryNotes = ({ db, territoryId }) => db
  .prepare('SELECT * FROM territory_notes WHERE territory_id = ? ORDER BY created_at DESC')
  .all(String(territoryId || ''));

// Resolve a human-typed reference (id or business name) to exactly one record.
// Match order: exact _row_id/id, then exact business_name (case-insensitive), then
// business_name substring. Ambiguous matches throw with the candidate names so the
// caller can disambiguate; no match throws NOT_FOUND-style.
export const resolveRecordRef = ({ db, ref }) => {
  const needle = String(ref || '').trim();
  if (!needle) throw new Error('A record reference (id or business name) is required.');
  const exact = getRecordById({ db, id: needle });
  if (exact) return exact;
  const byNameExact = db.prepare('SELECT * FROM records WHERE LOWER(business_name) = LOWER(?)').all(needle);
  if (byNameExact.length === 1) return byNameExact[0];
  if (byNameExact.length > 1) {
    throw new Error(`Ambiguous record "${needle}" — ${byNameExact.length} exact name matches. Use the row id. Candidates: ${byNameExact.map((r) => `${r.business_name} (${r._row_id})`).join('; ')}`);
  }
  const byNameLike = db.prepare("SELECT * FROM records WHERE business_name LIKE '%' || ? || '%' COLLATE NOCASE").all(needle);
  if (byNameLike.length === 1) return byNameLike[0];
  if (byNameLike.length > 1) {
    throw new Error(`Ambiguous record "${needle}" — ${byNameLike.length} name matches. Use the row id. Candidates: ${byNameLike.slice(0, 12).map((r) => `${r.business_name} (${r._row_id})`).join('; ')}`);
  }
  throw new Error(`No record found matching "${needle}".`);
};

// --- Decision overrides -----------------------------------------------------
// Overrides are first-class human directives that supersede the pipeline's
// automated keep/drop verdict for a record. They are the source of truth for
// human intent; record state is reconciled to honor them on every run.

export const OVERRIDE_GATE = '__override__';

export const insertOverride = ({ db, recordId, kind, stepId = '', reason, createdBy = '' }) => {
  enforceCanaryRecordMutation(db, recordId);
  const id = `ovr_${randomUUID().slice(0, 12)}`;
  const now = nowIso();
  db.prepare(`
    INSERT INTO overrides (id, record_id, kind, step_id, reason, created_by, created_at, cleared_at, cleared_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', '')
  `).run(id, String(recordId), String(kind), String(stepId || ''), String(reason || ''), String(createdBy || ''), now);
  return { id, record_id: String(recordId), kind: String(kind), step_id: String(stepId || ''), reason: String(reason || ''), created_at: now };
};

export const listOverridesForRecord = ({ db, recordId, includeCleared = false }) => {
  const sql = includeCleared
    ? 'SELECT * FROM overrides WHERE record_id = ? ORDER BY created_at DESC'
    : "SELECT * FROM overrides WHERE record_id = ? AND (cleared_at IS NULL OR cleared_at = '') ORDER BY created_at DESC";
  return db.prepare(sql).all(String(recordId));
};

export const listActiveOverrides = ({ db }) =>
  db.prepare("SELECT * FROM overrides WHERE cleared_at IS NULL OR cleared_at = '' ORDER BY created_at DESC").all();

export const clearOverrides = ({ db, recordId, stepId = null, kind = null, createdBy = null, clearedBy = '' }) => {
  enforceCanaryRecordMutation(db, recordId);
  const now = nowIso();
  const active = listOverridesForRecord({ db, recordId });
  const matched = active.filter((override) => (
    (stepId === null || String(override.step_id || '') === String(stepId || ''))
    && (kind === null || String(override.kind || '') === String(kind || ''))
    && (createdBy === null || String(override.created_by || '') === String(createdBy || ''))
  ));
  const update = db.prepare("UPDATE overrides SET cleared_at = ?, cleared_by = ? WHERE id = ?");
  matched.forEach((o) => update.run(now, String(clearedBy || ''), o.id));
  return matched;
};

// Build per-record keep directives for the dataflow scheduler.
export const overridesByRecordMap = ({ db }) => {
  const rows = listActiveOverrides({ db });
  return rows.reduce((map, row) => {
    if (String(row.kind) !== 'keep') return map;
    const recordId = String(row.record_id);
    const existing = map.get(recordId) || { keepAll: false, keepSteps: new Set() };
    const stepId = String(row.step_id || '').trim();
    const next = stepId
      ? { keepAll: existing.keepAll, keepSteps: new Set([...existing.keepSteps, stepId]) }
      : { keepAll: true, keepSteps: existing.keepSteps };
    map.set(recordId, next);
    return map;
  }, new Map());
};

// Reconcile record state to honor every active override. Idempotent; safe to run
// at the start of every pipeline run and at override-create time. This is what
// makes overrides survive --reapply and full resets.
/**
 * Re-apply active drop/keep overrides onto records.
 * When `recordIds` is provided, only those records are touched (canary scope).
 * Direct SQL updates still go through enforceCanaryRecordMutation when listDir is pinned
 * — but that only fires on upsertRecord; these UPDATEs must be scoped explicitly.
 */
export const reconcileOverrides = ({
  db,
  recordIds = null,
}: {
  db: ReturnType<typeof openListDb>;
  recordIds?: string[] | null;
} = {} as any) => {
  const allow = Array.isArray(recordIds) && recordIds.length > 0
    ? new Set(recordIds.map((id) => String(id || '').trim()).filter(Boolean))
    : null;
  const rows = listActiveOverrides({ db });
  const now = nowIso();
  const summary = { drops_applied: 0, keeps_restored: 0, skipped_out_of_scope: 0 };
  rows.forEach((row) => {
    const rid = String(row.record_id || '').trim();
    if (allow && !allow.has(rid)) {
      summary.skipped_out_of_scope += 1;
      return;
    }
    // Canary gate for direct UPDATE paths that bypass upsertRecord.
    try {
      enforceCanaryRecordMutation(db, rid);
    } catch {
      summary.skipped_out_of_scope += 1;
      return;
    }
    const record = getRecordById({ db, id: rid });
    if (!record) return;
    if (String(row.kind) === 'drop') {
      const alreadyDropped = String(record.disqualified_at || '').trim() !== '';
      if (alreadyDropped && String(record.disqualified_gate || '') === OVERRIDE_GATE) return;
      const droppedRecord = {
        ...record,
        disqualified_at: now,
        disqualified_gate: OVERRIDE_GATE,
        disqualify_reason: `override: ${String(row.reason || '')}`,
      };
      db.prepare(`
        UPDATE records SET disqualified_at = ?, disqualified_gate = ?, disqualify_reason = ?,
          needs_review = 0, review_reason = '', review_flagged_at = '', updated_at = ?
        WHERE _row_id = ?
      `).run(
        droppedRecord.disqualified_at,
        droppedRecord.disqualified_gate,
        droppedRecord.disqualify_reason,
        now,
        String(record._row_id),
      );
      revokeQueuedDraftsForRecord({ db, record: droppedRecord });
      summary.drops_applied += 1;
      return;
    }
    if (String(row.kind) === 'keep') {
      const disqualifiedBy = String(record.disqualified_gate || '');
      const stepId = String(row.step_id || '').trim();
      const coversGate = stepId === '' || disqualifiedBy === stepId || disqualifiedBy === OVERRIDE_GATE;
      const isDisqualified = String(record.disqualified_at || '').trim() !== '';
      if (isDisqualified && coversGate) {
        db.prepare(`
          UPDATE records SET disqualified_at = '', disqualified_gate = '', disqualify_reason = '',
            needs_review = 0, review_reason = '', review_flagged_at = '', updated_at = ?
          WHERE _row_id = ?
        `).run(now, String(record._row_id));
        summary.keeps_restored += 1;
      }
    }
  });
  return summary;
};

// --- Field overrides --------------------------------------------------------
// Human-set values for individual record fields ("the decision maker is Teresa").
// Append-only with soft clears, one active override per (record, field). A field
// with an active override is owned by the human: every write path flows through
// upsertRecord, which re-asserts the override value, so enrichment and scoring
// reruns can never clobber field intel.

// Fields where a manual value would fight the machinery that owns them.
// Disqualification belongs to `override keep/drop`, suppression to `suppress`.
export const FIELD_OVERRIDE_PROTECTED = new Set([
  '_row_id', 'id', '_created_at', '_updated_at', 'created_at', 'updated_at',
  'extra_json', 'workflow_signals',
  'disqualified_at', 'disqualified_gate', 'disqualify_reason',
  'needs_review', 'review_reason', 'review_flagged_at',
  'suppressed', 'suppressed_reason', 'suppressed_at',
  'duplicate_of', 'duplicate_status', 'duplicate_reason',
]);

export const insertFieldOverride = ({ db, recordId, field, value, reason = '', createdBy = '' }) => {
  enforceCanaryRecordMutation(db, recordId);
  const fieldName = String(field || '').trim();
  if (!fieldName) throw new Error('A field name is required.');
  if (FIELD_OVERRIDE_PROTECTED.has(fieldName)) {
    throw new Error(`Field "${fieldName}" cannot be manually overridden — it is owned by the pipeline. Use the matching command (override drop/keep, suppress) instead.`);
  }
  const tableCols = getTableColumns(db, 'records');
  if (!tableCols.has(fieldName)) {
    throw new Error(`Unknown record field "${fieldName}". Run \`schema <list> --table records\` to see available columns.`);
  }
  const now = nowIso();
  // One active override per (record, field): supersede, keep history.
  db.prepare(`
    UPDATE field_overrides SET cleared_at = ?, cleared_by = 'superseded'
    WHERE record_id = ? AND field = ? AND (cleared_at IS NULL OR cleared_at = '')
  `).run(now, String(recordId), fieldName);
  const id = `fov_${randomUUID().slice(0, 12)}`;
  db.prepare(`
    INSERT INTO field_overrides (id, record_id, field, value, reason, created_by, created_at, cleared_at, cleared_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', '')
  `).run(id, String(recordId), fieldName, value === null || value === undefined ? null : String(value), String(reason || ''), String(createdBy || ''), now);
  return { id, record_id: String(recordId), field: fieldName, value: value === null || value === undefined ? null : String(value), reason: String(reason || ''), created_at: now };
};

export const listFieldOverridesForRecord = ({ db, recordId, includeCleared = false }) => {
  const sql = includeCleared
    ? 'SELECT * FROM field_overrides WHERE record_id = ? ORDER BY created_at DESC'
    : "SELECT * FROM field_overrides WHERE record_id = ? AND (cleared_at IS NULL OR cleared_at = '') ORDER BY created_at DESC";
  return db.prepare(sql).all(String(recordId));
};

export const listActiveFieldOverrides = ({ db }) =>
  db.prepare("SELECT * FROM field_overrides WHERE cleared_at IS NULL OR cleared_at = '' ORDER BY created_at DESC").all();

export const clearFieldOverrides = ({ db, recordId, field = null, clearedBy = '' }) => {
  enforceCanaryRecordMutation(db, recordId);
  const now = nowIso();
  const active = listFieldOverridesForRecord({ db, recordId });
  const matched = active.filter((o) => field === null || String(o.field) === String(field || '').trim());
  const update = db.prepare('UPDATE field_overrides SET cleared_at = ?, cleared_by = ? WHERE id = ?');
  matched.forEach((o) => update.run(now, String(clearedBy || ''), o.id));
  return matched;
};

export const activeFieldOverrideMap = ({ db, recordId }) => {
  const rows = listFieldOverridesForRecord({ db, recordId });
  // Rows are newest-first; first write per field wins (= the active latest).
  return rows.reduce((map, row) => {
    const field = String(row.field || '');
    if (!field || map.has(field)) return map;
    map.set(field, row.value === null || row.value === undefined ? null : String(row.value));
    return map;
  }, new Map());
};

// Re-stamp every active field override onto its record. Idempotent; belt-and-
// braces alongside the upsertRecord hook (covers direct UPDATEs that bypass it).
// When `recordIds` is provided, only those records are touched (canary scope).
export const reconcileFieldOverrides = ({
  db,
  recordIds = null,
}: {
  db: ReturnType<typeof openListDb>;
  recordIds?: string[] | null;
} = {} as any) => {
  const allow = Array.isArray(recordIds) && recordIds.length > 0
    ? new Set(recordIds.map((id) => String(id || '').trim()).filter(Boolean))
    : null;
  const rows = listActiveFieldOverrides({ db });
  const tableCols = getTableColumns(db, 'records');
  const summary = { applied: 0, skipped_out_of_scope: 0 };
  rows.forEach((row) => {
    const rid = String(row.record_id || '').trim();
    if (allow && !allow.has(rid)) {
      summary.skipped_out_of_scope += 1;
      return;
    }
    try {
      enforceCanaryRecordMutation(db, rid);
    } catch {
      summary.skipped_out_of_scope += 1;
      return;
    }
    const field = String(row.field || '');
    if (!field || !tableCols.has(field)) return;
    const quoted = `"${field.replace(/"/g, '""')}"`;
    const result = db.prepare(`UPDATE records SET ${quoted} = ?, updated_at = ? WHERE _row_id = ? AND ${quoted} IS NOT ?`).run(
      row.value, nowIso(), rid, row.value,
    );
    if (result.changes > 0) summary.applied += 1;
  });
  return summary;
};

// --- Interactions -------------------------------------------------------------
// The CRM slice: human touchpoints with a lead (visits, calls, notes) with what
// was said, the objections raised, and an optional follow-up date. Soft-deleted,
// never hard-deleted. An open follow-up surfaces in `followups` and is mirrored
// onto records.next_action_date while the record is idle (an active sequence
// owns that column and is left alone).

export const INTERACTION_KINDS = ['visit', 'call', 'email', 'meeting', 'note'];

const syncNextActionFromFollowUps = ({ db, recordId }) => {
  const record = getRecordById({ db, id: String(recordId) });
  if (!record) return;
  if (String(record.sequence_status || 'idle') !== 'idle') return;
  const earliest = db.prepare(`
    SELECT MIN(follow_up_at) AS due FROM interactions
    WHERE record_id = ? AND COALESCE(deleted_at, '') = ''
      AND COALESCE(follow_up_at, '') != '' AND COALESCE(follow_up_done_at, '') = ''
  `).get(String(recordId));
  db.prepare('UPDATE records SET next_action_date = ?, updated_at = ? WHERE _row_id = ?')
    .run(String(earliest?.due || ''), nowIso(), String(record._row_id));
};

export const insertInteraction = ({ db, recordId, kind = 'note', summary, body = '', objections = '', contact = '', followUpAt = '', followUpNote = '', occurredAt = '', createdBy = '' }) => {
  const kindName = String(kind || 'note').trim().toLowerCase();
  if (!INTERACTION_KINDS.includes(kindName)) {
    throw new Error(`Unknown interaction kind "${kindName}". Kinds: ${INTERACTION_KINDS.join(', ')}`);
  }
  if (!String(summary || '').trim()) throw new Error('An interaction summary is required.');
  const rid = String(recordId || '').trim();
  // Strict canary: non-allowlisted records cannot receive interactions.
  enforceCanaryRecordMutation(db, rid);
  const now = nowIso();
  const id = `int_${randomUUID().slice(0, 12)}`;
  db.prepare(`
    INSERT INTO interactions (interaction_id, record_id, contact, kind, summary, body, objections,
      follow_up_at, follow_up_done_at, follow_up_note, created_by, occurred_at, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, '')
  `).run(
    id, rid, String(contact || ''), kindName, String(summary).trim(), String(body || ''), String(objections || ''),
    String(followUpAt || ''), String(followUpNote || ''), String(createdBy || ''), String(occurredAt || now), now, now,
  );
  syncNextActionFromFollowUps({ db, recordId });
  return getInteraction({ db, interactionId: id });
};

export const getInteraction = ({ db, interactionId }) =>
  db.prepare('SELECT * FROM interactions WHERE interaction_id = ?').get(String(interactionId));

export const listInteractionsForRecord = ({ db, recordId, includeDeleted = false }) => {
  const sql = includeDeleted
    ? 'SELECT * FROM interactions WHERE record_id = ? ORDER BY occurred_at DESC, created_at DESC'
    : "SELECT * FROM interactions WHERE record_id = ? AND COALESCE(deleted_at, '') = '' ORDER BY occurred_at DESC, created_at DESC";
  return db.prepare(sql).all(String(recordId));
};

export const updateInteraction = ({ db, interactionId, patch = {} }: { db: any; interactionId: string; patch?: Record<string, any> }) => {
  const existing = getInteraction({ db, interactionId });
  if (!existing) throw new Error(`Interaction not found: ${interactionId}`);
  const editable = ['contact', 'kind', 'summary', 'body', 'objections', 'follow_up_at', 'follow_up_done_at', 'follow_up_note', 'occurred_at'];
  const updates = Object.entries(patch || {}).filter(([key, value]) => editable.includes(key) && value !== undefined);
  if (updates.length === 0) return existing;
  const kindName = patch.kind === undefined ? null : String(patch.kind).trim().toLowerCase();
  if (kindName !== null && !INTERACTION_KINDS.includes(kindName)) {
    throw new Error(`Unknown interaction kind "${kindName}". Kinds: ${INTERACTION_KINDS.join(', ')}`);
  }
  const setSql = updates.map(([key]) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE interactions SET ${setSql}, updated_at = ? WHERE interaction_id = ?`)
    .run(...updates.map(([key, value]) => (key === 'kind' ? kindName : String(value ?? ''))), nowIso(), String(interactionId));
  syncNextActionFromFollowUps({ db, recordId: String(existing.record_id) });
  return getInteraction({ db, interactionId });
};

export const completeFollowUp = ({ db, interactionId, note = '' }) => {
  const existing = getInteraction({ db, interactionId });
  if (!existing) throw new Error(`Interaction not found: ${interactionId}`);
  if (!String(existing.follow_up_at || '').trim()) throw new Error(`Interaction ${interactionId} has no follow-up to complete.`);
  db.prepare('UPDATE interactions SET follow_up_done_at = ?, follow_up_note = COALESCE(NULLIF(?, \'\'), follow_up_note), updated_at = ? WHERE interaction_id = ?')
    .run(nowIso(), String(note || ''), nowIso(), String(interactionId));
  syncNextActionFromFollowUps({ db, recordId: String(existing.record_id) });
  return getInteraction({ db, interactionId });
};

export const softDeleteInteraction = ({ db, interactionId }) => {
  const existing = getInteraction({ db, interactionId });
  if (!existing) throw new Error(`Interaction not found: ${interactionId}`);
  db.prepare('UPDATE interactions SET deleted_at = ?, updated_at = ? WHERE interaction_id = ?')
    .run(nowIso(), nowIso(), String(interactionId));
  syncNextActionFromFollowUps({ db, recordId: String(existing.record_id) });
  return getInteraction({ db, interactionId });
};

// Open follow-ups across the list, soonest first. `dueBy` (YYYY-MM-DD) filters
// to follow-ups due on or before that date.
export const listOpenFollowUps = ({ db, dueBy = '' }) => {
  const due = String(dueBy || '').trim();
  return db.prepare(`
    SELECT i.*, r.business_name, r.phone, r.address
    FROM interactions i
    LEFT JOIN records r ON r._row_id = i.record_id
    WHERE COALESCE(i.deleted_at, '') = ''
      AND COALESCE(i.follow_up_at, '') != ''
      AND COALESCE(i.follow_up_done_at, '') = ''
      ${due ? 'AND substr(i.follow_up_at, 1, 10) <= ?' : ''}
    ORDER BY i.follow_up_at ASC, i.occurred_at ASC
  `).all(...(due ? [due] : []));
};

// --- Lead briefs ---------------------------------------------------------------
// One brief per record (latest wins), refreshed when its dep hash changes.

export const getBriefForRecord = ({ db, rowId }) =>
  db.prepare('SELECT * FROM lead_briefs WHERE row_id = ?').get(String(rowId));

export const persistBrief = ({ db, rowId, summary, content, rolesJson = '[]', depHash = '', model = '' }) => {
  enforceCanaryRecordMutation(db, rowId);
  const now = nowIso();
  const existing = getBriefForRecord({ db, rowId });
  if (existing) {
    db.prepare(`
      UPDATE lead_briefs SET summary = ?, content = ?, roles_json = ?, dep_hash = ?, model = ?, status = 'ready', updated_at = ?
      WHERE row_id = ?
    `).run(String(summary || ''), String(content || ''), String(rolesJson || '[]'), String(depHash || ''), String(model || ''), now, String(rowId));
    return getBriefForRecord({ db, rowId });
  }
  db.prepare(`
    INSERT INTO lead_briefs (brief_id, row_id, summary, content, roles_json, dep_hash, model, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
  `).run(`brf_${randomUUID().slice(0, 12)}`, String(rowId), String(summary || ''), String(content || ''), String(rolesJson || '[]'), String(depHash || ''), String(model || ''), now, now);
  return getBriefForRecord({ db, rowId });
};

export const deleteRecord = ({ db, id }) => {
  const rid = String(id || '').trim();
  if (!rid) return;
  // Canary gate before any delete side effects (strict isolation boundary).
  enforceCanaryRecordMutation(db, rid);
  db.prepare(`
    UPDATE records
    SET duplicate_of = '', duplicate_status = ''
    WHERE duplicate_of = ?
  `).run(rid);
  db.prepare('DELETE FROM records WHERE _row_id = ? OR id = ?').run(rid, rid);
};

export const deleteRecordsBatch = ({ db, where, params = [] as any[] }) => {
  const whereSql = String(where || '').trim();
  if (!whereSql) return { deleted: 0 };
  const bound = Array.isArray(params) ? params : [];

  // Gate every candidate before bulk delete — refuse the batch if any is blocked.
  const candidates = db.prepare(`SELECT _row_id FROM records WHERE ${whereSql}`).all(...bound) as Array<{ _row_id?: string }>;
  for (const row of candidates) {
    enforceCanaryRecordMutation(db, row?._row_id);
  }

  db.prepare(`
    UPDATE records
    SET duplicate_of = '', duplicate_status = ''
    WHERE duplicate_of IN (SELECT _row_id FROM records WHERE ${whereSql})
      AND _row_id NOT IN (SELECT _row_id FROM records WHERE ${whereSql})
  `).run(...bound, ...bound);

  const count = db.prepare(`SELECT COUNT(*) as n FROM records WHERE ${whereSql}`).get(...bound);
  db.prepare(`DELETE FROM records WHERE ${whereSql}`).run(...bound);
  return { deleted: Number(count?.n || 0) };
};

export const deleteRecordsKeepTop = ({ db, limit, orderBy }) => {
  const keepLimit = Math.max(0, Number(limit || 0));
  if (keepLimit <= 0) {
    const allRows = db.prepare('SELECT _row_id FROM records').all() as Array<{ _row_id?: string }>;
    for (const row of allRows) enforceCanaryRecordMutation(db, row?._row_id);
    const count = db.prepare('SELECT COUNT(*) as n FROM records').get();
    db.prepare('DELETE FROM records').run();
    return { deleted: Number(count?.n || 0), kept: 0 };
  }

  const orderSql = String(orderBy || 'updated_at').trim();
  const keepRows = db.prepare(`
    SELECT _row_id
    FROM records
    ORDER BY ${orderSql} DESC
    LIMIT ?
  `).all(keepLimit);
  const keepIds = keepRows.map((row: any) => String(row?._row_id || '')).filter(Boolean);
  if (keepIds.length === 0) {
    const allRows = db.prepare('SELECT _row_id FROM records').all() as Array<{ _row_id?: string }>;
    for (const row of allRows) enforceCanaryRecordMutation(db, row?._row_id);
    const count = db.prepare('SELECT COUNT(*) as n FROM records').get();
    db.prepare('DELETE FROM records').run();
    return { deleted: Number(count?.n || 0), kept: 0 };
  }

  const placeholders = keepIds.map(() => '?').join(',');
  const toDelete = db.prepare(
    `SELECT _row_id FROM records WHERE _row_id NOT IN (${placeholders})`,
  ).all(...keepIds) as Array<{ _row_id?: string }>;
  for (const row of toDelete) enforceCanaryRecordMutation(db, row?._row_id);

  db.prepare(`
    UPDATE records
    SET duplicate_of = '', duplicate_status = ''
    WHERE duplicate_of != ''
      AND duplicate_of NOT IN (${placeholders})
  `).run(...keepIds);

  const count = db.prepare(`SELECT COUNT(*) as n FROM records WHERE _row_id NOT IN (${placeholders})`).get(...keepIds);
  db.prepare(`DELETE FROM records WHERE _row_id NOT IN (${placeholders})`).run(...keepIds);
  return { deleted: Number(count?.n || 0), kept: keepIds.length };
};

export const insertChannelEvent = ({ db, event }) => {
  enforceCanaryRecordMutation(db, event?.row_id || event?.record_id);
  db.prepare(`
    INSERT INTO channel_events (
      event_id, id, row_id, contact_id, channel, event_type, action, sequence_step, notes, disposition,
      provider_id, thread_id, provider_message_id, provider_thread_id, payload_json, occurred_at, created_at
    ) VALUES (
      @event_id, @id, @row_id, @contact_id, @channel, @event_type, @action, @sequence_step, @notes, @disposition,
      @provider_id, @thread_id, @provider_message_id, @provider_thread_id, @payload_json, @occurred_at, @created_at
    )
  `).run({
    event_id: event.event_id || event.id,
    id: event.id || event.event_id,
    row_id: event.row_id || event.record_id,
    contact_id: event.contact_id || '',
    channel: event.channel,
    event_type: event.event_type || event.action || 'event',
    action: event.action || event.event_type || 'event',
    sequence_step: event.sequence_step || '',
    notes: event.notes || '',
    disposition: event.disposition || '',
    provider_id: event.provider_id || event.provider_message_id || '',
    thread_id: event.thread_id || event.provider_thread_id || '',
    provider_message_id: event.provider_message_id || '',
    provider_thread_id: event.provider_thread_id || '',
    payload_json: safeJson(event.payload),
    occurred_at: event.occurred_at || nowIso(),
    created_at: nowIso(),
  });
  insertAccountTimelineEvent({
    db,
    event: {
      timeline_id: event.event_id || event.id,
      row_id: event.row_id || event.record_id,
      contact_id: event.contact_id || '',
      event_family: 'channel',
      event_type: event.event_type || event.action || 'event',
      channel: event.channel || '',
      disposition: event.disposition || '',
      classification: String(event?.payload?.classification || ''),
      notes: event.notes || '',
      payload: event.payload || {},
      occurred_at: event.occurred_at || nowIso(),
    },
  });
};

const normalizeContactIdentityPart = (value: unknown) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const contactNameTitleIdentity = (contact) => normalizeContactIdentityPart(
  `${String(contact?.full_name || contact?.name || '')} ${String(contact?.title || '')}`
);

const contactSeniorityRank = (contact) => {
  const seniority = normalizeContactIdentityPart(`${contact?.seniority || ''} ${contact?.title || ''}`);
  const words = seniority.split(' ').filter(Boolean);
  const tokens = new Set(words);
  const isVicePresident = tokens.has('vp')
    || words.some((word, index) => word === 'vice' && words[index + 1] === 'president');
  const isTopTier = ['owner', 'founder', 'cofounder', 'principal', 'partner', 'ceo', 'proprietor']
    .some((value) => tokens.has(value))
    || (tokens.has('president') && !isVicePresident);
  if (isTopTier) return 3;
  if (isVicePresident || ['head', 'director'].some((value) => tokens.has(value))) return 2;
  if (tokens.has('manager')) return 1;
  return 0;
};

const contactVerificationRank = (contact) => (
  ['valid', 'verified'].includes(String(contact?.email_verification_status || '').trim().toLowerCase()) ? 1 : 0
);

const contactRoleRank = (contact) => (
  String(contact?.role || '').trim().toLowerCase() === 'primary' ? 1 : 0
);

type PrimaryContactPreference = {
  title_patterns?: readonly string[];
  seniority?: readonly string[];
  excluded_patterns?: readonly string[];
};

type ContactPolicyForProjection = {
  primary_contact?: PrimaryContactPreference;
};

const normalizedPreferencePattern = (value: unknown) => (
  ` ${normalizeContactIdentityPart(value)} `
);

const firstPreferenceMatch = ({
  value,
  patterns,
}: {
  value: unknown;
  patterns: readonly string[] | undefined;
}) => {
  const normalizedValue = normalizedPreferencePattern(value);
  if (normalizedValue === '  ') return -1;
  return (patterns || []).findIndex((pattern) => {
    const normalizedPattern = normalizedPreferencePattern(pattern);
    return normalizedPattern !== '  ' && normalizedValue.includes(normalizedPattern);
  });
};

const contactPreferenceRank = ({
  contact,
  contactPolicy,
}: {
  contact: Record<string, unknown>;
  contactPolicy?: ContactPolicyForProjection;
}) => {
  const preference = contactPolicy?.primary_contact;
  if (!preference) return null;
  const title = String(contact.title || '');
  const seniority = String(contact.seniority || '');
  const excluded = firstPreferenceMatch({
    value: `${title} ${seniority}`,
    patterns: preference.excluded_patterns,
  }) >= 0;
  if (excluded) return null;

  const titleIndex = firstPreferenceMatch({ value: title, patterns: preference.title_patterns });
  if (titleIndex >= 0) return [0, titleIndex] as const;

  const seniorityIndex = firstPreferenceMatch({ value: seniority, patterns: preference.seniority });
  return seniorityIndex >= 0 ? [1, seniorityIndex] as const : null;
};

const stablePrimaryContactKey = (contact) => [
  normalizeContactIdentityPart(contact?.full_name || contact?.name),
  normalizeContactIdentityPart(contact?.title),
  normalizeContactIdentityPart(contact?.seniority),
  String(contact?.email || '').trim().toLowerCase(),
  String(contact?.linkedin_urn || '').trim(),
].join('\u0000');

const contactIsSuppressedForProjection = (contact) => (
  isAffirmativeFlag(contact?.dne_email, { failClosed: true })
  || isAffirmativeFlag(contact?.dnc_phone, { failClosed: true })
  || isAffirmativeFlag(contact?.dne_phone, { failClosed: true })
  || isAffirmativeFlag(contact?.linkedin_suppressed, { failClosed: true })
  || (String(contact?.suppression_state || '').trim().toLowerCase() !== ''
    && String(contact?.suppression_state || '').trim().toLowerCase() !== 'none')
);

const contactByIdForRecord = ({ db, recordId, contactId }) => db.prepare(`
  SELECT rowid AS contact_rowid, *
  FROM contacts
  WHERE row_id = ? AND (contact_id = ? OR id = ?)
  ORDER BY CASE WHEN contact_id = ? THEN 0 ELSE 1 END
  LIMIT 1
`).get(recordId, contactId, contactId, contactId) || null;

const primaryContactForRecord = ({
  db,
  recordId,
  contactPolicy,
}: {
  db: ReturnType<typeof openListDb>;
  recordId: string;
  contactPolicy?: ContactPolicyForProjection;
}) => {
  const contacts = db.prepare('SELECT rowid AS contact_rowid, * FROM contacts WHERE row_id = ? ORDER BY rowid ASC').all(recordId);
  return contacts.filter((contact) => !contactIsSuppressedForProjection(contact)).sort((left, right) => {
    const verificationDifference = contactVerificationRank(right) - contactVerificationRank(left);
    if (verificationDifference !== 0) return verificationDifference;
    const leftPreference = contactPreferenceRank({ contact: left, contactPolicy });
    const rightPreference = contactPreferenceRank({ contact: right, contactPolicy });
    if (leftPreference && rightPreference) {
      const preferenceCategoryDifference = leftPreference[0] - rightPreference[0];
      if (preferenceCategoryDifference !== 0) return preferenceCategoryDifference;
      const preferenceIndexDifference = leftPreference[1] - rightPreference[1];
      if (preferenceIndexDifference !== 0) return preferenceIndexDifference;
    }
    if (leftPreference) return -1;
    if (rightPreference) return 1;
    const roleDifference = contactRoleRank(right) - contactRoleRank(left);
    if (roleDifference !== 0) return roleDifference;
    const seniorityDifference = contactSeniorityRank(right) - contactSeniorityRank(left);
    if (seniorityDifference !== 0) return seniorityDifference;
    const emailDifference = Number(Boolean(String(right?.email || '').trim()))
      - Number(Boolean(String(left?.email || '').trim()));
    if (emailDifference !== 0) return emailDifference;
    const createdAtDifference = String(left?.created_at || '').localeCompare(String(right?.created_at || ''));
    if (createdAtDifference !== 0) return createdAtDifference;
    const stableKeyDifference = stablePrimaryContactKey(left).localeCompare(stablePrimaryContactKey(right));
    if (stableKeyDifference !== 0) return stableKeyDifference;
    return Number(left?.contact_rowid || 0) - Number(right?.contact_rowid || 0);
  })[0] || null;
};

const syncPrimaryContactProjectionInternal = ({
  db,
  recordId,
  contactPolicy,
}: {
  db: any;
  recordId: string;
  contactPolicy?: ContactPolicyForProjection;
}) => {
  const normalizedRecordId = String(recordId || '').trim();
  if (!normalizedRecordId) return null;
  const campaignRecordColumns = new Set(
    db.prepare('PRAGMA table_info(records)').all().map((row) => String(row.name || '')),
  );
  const record = campaignRecordColumns.has('account_contact_plan_json')
    ? db.prepare(`
      SELECT account_contact_plan_json
      FROM records WHERE _row_id = ?
    `).get(normalizedRecordId)
    : null;
  const campaign = record ? parseAccountCampaignFromRecord(record) : null;
  const plannedContactId = String(campaign?.active_contact_id || '').trim();
  const primaryContact = campaign
    ? (plannedContactId
      ? contactByIdForRecord({ db, recordId: normalizedRecordId, contactId: plannedContactId })
      : null)
    : primaryContactForRecord({ db, recordId: normalizedRecordId, contactPolicy });
  db.prepare(`
    UPDATE contacts
    SET is_primary = CASE WHEN contact_id = ? THEN 1 ELSE 0 END
    WHERE row_id = ?
      AND is_primary != CASE WHEN contact_id = ? THEN 1 ELSE 0 END
  `).run(
    String(primaryContact?.contact_id || ''),
    normalizedRecordId,
    String(primaryContact?.contact_id || '')
  );

  const recordColumns = new Set(
    db.prepare('PRAGMA table_info(records)').all().map((row) => String(row.name || ''))
  );
  const name = String(primaryContact?.full_name || primaryContact?.name || '');
  const projection = {
    contact_name: name,
    contact_first_name: deriveContactFirstName(name),
    contact_title: String(primaryContact?.title || ''),
    contact_email: String(primaryContact?.email || ''),
    contact_name_primary: name,
    contact_title_primary: String(primaryContact?.title || ''),
    owner_name: name,
    email_verification_status: String(primaryContact?.email_verification_status || ''),
    email_verification_confidence: String(primaryContact?.email_verification_confidence || 0),
    email_verified_at: String(primaryContact?.email_verified_at || ''),
    contact_linkedin_url: String(primaryContact?.linkedin_url || ''),
    linkedin_confidence: primaryContact?.linkedin_url
      ? Math.max(0, Math.min(100, Number(primaryContact?.confidence || 0)))
      : 0,
    ...(campaign ? {
      active_contact_id: plannedContactId,
      contact_id: plannedContactId,
    } : {}),
  };
  const writableProjection = Object.entries(projection)
    .filter(([column]) => recordColumns.has(column));
  if (writableProjection.length > 0) {
    const assignments = writableProjection.map(([column]) => `${column} = @${column}`).join(', ');
    const changed = writableProjection.map(([column]) => `COALESCE(${column}, '') != @${column}`).join(' OR ');
    db.prepare(`
      UPDATE records
      SET ${assignments}, updated_at = @updated_at
      WHERE _row_id = @record_id
        AND (${changed})
    `).run({
      ...Object.fromEntries(writableProjection),
      updated_at: nowIso(),
      record_id: normalizedRecordId,
    });
  }
  return primaryContact ? String(primaryContact.contact_id || '') : null;
};

export const syncPrimaryContactProjection = ({
  db,
  recordId,
  contactPolicy,
}: {
  db: any;
  recordId: string;
  contactPolicy?: ContactPolicyForProjection;
}) => {
  enforceCanaryRecordMutation(db, recordId);
  return db.transaction(() => syncPrimaryContactProjectionInternal({ db, recordId, contactPolicy }))();
};

/**
 * Project a specific contact (campaign active target) onto denormalized record
 * contact_* fields. Unlike syncPrimaryContactProjection (seniority primary), this
 * writes the named contact so channel sends / post-rotation state match the
 * active contact plan. Bypasses upsertRecord's primary-projection lock.
 */
export const projectContactOntoRecord = ({ db, recordId, contactId }) => {
  const normalizedRecordId = String(recordId || '').trim();
  const normalizedContactId = String(contactId || '').trim();
  if (!normalizedRecordId || !normalizedContactId || !db) return null;
  enforceCanaryRecordMutation(db, normalizedRecordId);

  return db.transaction(() => {
    const contact = db.prepare(`
      SELECT *
      FROM contacts
      WHERE (contact_id = ? OR id = ?) AND row_id = ?
      ORDER BY CASE WHEN contact_id = ? THEN 0 ELSE 1 END
      LIMIT 1
    `).get(normalizedContactId, normalizedContactId, normalizedRecordId, normalizedContactId)
      || db.prepare(`
        SELECT *
        FROM contacts
        WHERE contact_id = ? OR id = ?
        ORDER BY CASE WHEN contact_id = ? THEN 0 ELSE 1 END
        LIMIT 1
      `).get(normalizedContactId, normalizedContactId, normalizedContactId);

    if (!contact) return null;

    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?')
      .get(normalizedRecordId);
    const accountEmailBounced = isAffirmativeFlag(record?.email_bounced, { failClosed: true })
      && String(record?.email_status || '').toLowerCase() === 'account_bounced';

    const recordColumns = new Set(
      db.prepare('PRAGMA table_info(records)').all().map((row) => String(row.name || '')),
    );
    // Ensure optional outreach fields exist before projecting.
    for (const col of [
      'contact_phone', 'contact_linkedin_url', 'active_contact_id',
      'email_verification_status', 'email_verification_confidence', 'email_verified_at', 'linkedin_confidence',
    ]) {
      if (!recordColumns.has(col) && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) {
        try {
          db.exec(`ALTER TABLE records ADD COLUMN ${col} TEXT DEFAULT '';`);
          recordColumns.add(col);
        } catch {
          /* concurrent migration / missing rights */
        }
      }
    }

    const name = String(contact?.full_name || contact?.name || '');
    const projection: Record<string, string> = {
      contact_name: name,
      contact_first_name: deriveContactFirstName(name),
      contact_title: String(contact?.title || ''),
      contact_email: String(contact?.email || ''),
      contact_name_primary: name,
      contact_title_primary: String(contact?.title || ''),
      owner_name: name,
      contact_phone: String(contact?.phone || ''),
      contact_linkedin_url: String(contact?.linkedin_url || ''),
      linkedin_confidence: contact?.linkedin_url
        ? String(Math.max(0, Math.min(100, Number(contact?.confidence || 0))))
        : '0',
      active_contact_id: String(contact?.contact_id || contact?.id || normalizedContactId),
      email_verification_status: String(contact?.email_verification_status || ''),
      email_verification_confidence: String(contact?.email_verification_confidence || 0),
      email_verified_at: String(contact?.email_verified_at || ''),
      ...(accountEmailBounced ? {} : {
        dne_email: isAffirmativeFlag(contact?.dne_email, { failClosed: true }) ? '1' : '0',
      }),
    };
    const writableProjection = Object.entries(projection)
      .filter(([column]) => recordColumns.has(column));
    if (writableProjection.length === 0) return String(contact?.contact_id || '') || null;

    const assignments = writableProjection.map(([column]) => `${column} = @${column}`).join(', ');
    const changed = writableProjection.map(([column]) => `COALESCE(${column}, '') != @${column}`).join(' OR ');
    db.prepare(`
      UPDATE records
      SET ${assignments}, updated_at = @updated_at
      WHERE _row_id = @record_id
        AND (${changed})
    `).run({
      ...Object.fromEntries(writableProjection),
      updated_at: nowIso(),
      record_id: normalizedRecordId,
    });
    return String(contact?.contact_id || contact?.id || normalizedContactId) || null;
  })();
};

export const upsertContact = ({
  db,
  contact,
  contactPolicy,
}: {
  db: any;
  contact: Record<string, unknown>;
  contactPolicy?: ContactPolicyForProjection;
}) => {
  const rowId = String(contact?.row_id || contact?.record_id || '').trim();
  const email = String(contact?.email || '').trim().toLowerCase();
  const linkedinUrn = String(contact?.linkedin_urn || '').trim();
  const explicitContactId = String(contact?.contact_id || contact?.id || '').trim();
  const nameTitleIdentity = contactNameTitleIdentity(contact);
  if (!rowId || (!explicitContactId && !linkedinUrn && !email && !nameTitleIdentity)) return null;
  enforceCanaryRecordMutation(db, rowId);
  const now = nowIso();
  return db.transaction(() => {
    const explicitMatch = explicitContactId
      ? db.prepare(`
          SELECT *
          FROM contacts
          WHERE contact_id = ? OR id = ?
          ORDER BY CASE WHEN contact_id = ? THEN 0 ELSE 1 END
          LIMIT 1
        `).get(explicitContactId, explicitContactId, explicitContactId)
      : null;
    if (explicitMatch && String(explicitMatch.row_id || '') !== rowId) return null;

    const linkedinMatch = !explicitMatch && linkedinUrn
      ? db.prepare(`
          SELECT *
          FROM contacts
          WHERE row_id = ? AND linkedin_urn = ?
          LIMIT 1
        `).get(rowId, linkedinUrn)
      : null;
    const emailMatch = !explicitMatch && !linkedinMatch && email
      ? db.prepare(`
          SELECT *
          FROM contacts
          WHERE row_id = ? AND lower(email) = ?
          LIMIT 1
        `).get(rowId, email)
      : null;
    const nameTitleMatch = !explicitMatch && !linkedinMatch && !emailMatch && nameTitleIdentity
      ? db.prepare(`
          SELECT *
          FROM contacts
          WHERE row_id = ?
        `).all(rowId).find((candidate) => contactNameTitleIdentity(candidate) === nameTitleIdentity)
      : null;
    const existing = explicitMatch || linkedinMatch || emailMatch || nameTitleMatch;
    const contactId = String(existing?.contact_id || existing?.id || explicitContactId || `contact_${randomUUID()}`);
    const storedEmail = String(contact?.email ?? existing?.email ?? '').trim().toLowerCase();
    const storedLinkedinUrn = String(contact?.linkedin_urn ?? existing?.linkedin_urn ?? '').trim();

    db.prepare(`
      INSERT INTO contacts (
        contact_id, id, row_id, name, full_name, first_name, last_name, title, seniority,
        email, phone, linkedin_url, linkedin_urn, role, is_primary, source, source_query,
        sourced_at, confidence, email_verification_status, email_verification_confidence, email_verification_reason,
        email_verified_at, dne_email, dnc_phone, dne_phone, linkedin_suppressed,
        crm_person_id, created_at, updated_at
      )
      VALUES (
        @contact_id, @id, @row_id, @name, @full_name, @first_name, @last_name, @title, @seniority,
        @email, @phone, @linkedin_url, @linkedin_urn, @role, 0, @source, @source_query,
        @sourced_at, @confidence, @email_verification_status, @email_verification_confidence, @email_verification_reason,
        @email_verified_at, @dne_email, @dnc_phone, @dne_phone, @linkedin_suppressed,
        @crm_person_id, @created_at, @updated_at
      )
      ON CONFLICT(contact_id) DO UPDATE SET
        name = excluded.name,
        full_name = excluded.full_name,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        title = excluded.title,
        seniority = excluded.seniority,
        email = excluded.email,
        phone = excluded.phone,
        linkedin_url = excluded.linkedin_url,
        linkedin_urn = excluded.linkedin_urn,
        role = excluded.role,
        source = excluded.source,
        source_query = excluded.source_query,
        sourced_at = excluded.sourced_at,
        confidence = excluded.confidence,
        email_verification_status = excluded.email_verification_status,
        email_verification_confidence = excluded.email_verification_confidence,
        email_verification_reason = excluded.email_verification_reason,
        email_verified_at = excluded.email_verified_at,
        dne_email = excluded.dne_email,
        dnc_phone = excluded.dnc_phone,
        dne_phone = excluded.dne_phone,
        linkedin_suppressed = excluded.linkedin_suppressed,
        crm_person_id = excluded.crm_person_id,
        updated_at = excluded.updated_at
    `).run({
      contact_id: contactId,
      id: contactId,
      row_id: rowId,
      name: String(contact?.name ?? contact?.full_name ?? existing?.name ?? existing?.full_name ?? ''),
      full_name: String(contact?.full_name ?? contact?.name ?? existing?.full_name ?? existing?.name ?? ''),
      first_name: String(contact?.first_name ?? existing?.first_name ?? ''),
      last_name: String(contact?.last_name ?? existing?.last_name ?? ''),
      title: String(contact?.title ?? existing?.title ?? ''),
      seniority: String(contact?.seniority ?? existing?.seniority ?? ''),
      email: storedEmail,
      phone: String(contact?.phone ?? existing?.phone ?? ''),
      linkedin_url: String(contact?.linkedin_url ?? existing?.linkedin_url ?? ''),
      linkedin_urn: storedLinkedinUrn,
      role: String(contact?.role ?? existing?.role ?? 'secondary'),
      source: String(contact?.source ?? existing?.source ?? ''),
      source_query: String(contact?.source_query ?? existing?.source_query ?? ''),
      sourced_at: String(contact?.sourced_at ?? existing?.sourced_at ?? ''),
      confidence: Number(contact?.confidence ?? existing?.confidence ?? 0),
      email_verification_status: String(contact?.email_verification_status ?? existing?.email_verification_status ?? ''),
      email_verification_confidence: Number(contact?.email_verification_confidence ?? existing?.email_verification_confidence ?? 0),
      email_verification_reason: String(contact?.email_verification_reason ?? existing?.email_verification_reason ?? ''),
      email_verified_at: String(contact?.email_verified_at ?? existing?.email_verified_at ?? ''),
      dne_email: Number(
        isAffirmativeFlag(existing?.dne_email, { failClosed: true })
        || isAffirmativeFlag(contact?.dne_email, { failClosed: true }),
      ),
      dnc_phone: contact?.dnc_phone === undefined
        ? Number(isAffirmativeFlag(existing?.dnc_phone, { failClosed: true }))
        : Number(isAffirmativeFlag(contact.dnc_phone, { failClosed: true })),
      dne_phone: Number(
        isAffirmativeFlag(existing?.dne_phone, { failClosed: true })
        || isAffirmativeFlag(contact?.dne_phone, { failClosed: true }),
      ),
      linkedin_suppressed: contact?.linkedin_suppressed === undefined
        ? Number(isAffirmativeFlag(existing?.linkedin_suppressed, { failClosed: true }))
        : Number(isAffirmativeFlag(contact.linkedin_suppressed, { failClosed: true })),
      crm_person_id: String(contact?.crm_person_id ?? existing?.crm_person_id ?? ''),
      created_at: existing?.created_at || now,
      updated_at: now,
    });
    syncPrimaryContactProjectionInternal({ db, recordId: rowId, contactPolicy });
    return contactId;
  })();
};

export const deleteContact = ({ db, contactId }) => db.transaction(() => {
  const normalizedContactId = String(contactId || '').trim();
  if (!normalizedContactId) return false;
  const existing = db.prepare('SELECT contact_id, row_id FROM contacts WHERE contact_id = ? OR id = ? LIMIT 1')
    .get(normalizedContactId, normalizedContactId);
  if (!existing?.row_id) return false;
  enforceCanaryRecordMutation(db, existing.row_id);
  const deleted = db.prepare('DELETE FROM contacts WHERE contact_id = ?')
    .run(String(existing.contact_id || ''));
  syncPrimaryContactProjectionInternal({ db, recordId: String(existing.row_id) });
  return Number(deleted?.changes || 0) > 0;
})();

export const listContactsByRecord = ({ db, recordId }) =>
  db.prepare('SELECT * FROM contacts WHERE row_id = ? ORDER BY is_primary DESC, created_at ASC, contact_id ASC').all(recordId);

export const getPrimaryContact = ({
  db,
  recordId,
  contactPolicy,
}: {
  db: any;
  recordId: string;
  contactPolicy?: ContactPolicyForProjection;
}) => primaryContactForRecord({ db, recordId: String(recordId || ''), contactPolicy });

export const insertDraft = ({ db, draft }) => {
  const now = nowIso();
  ensureDraftCompatibility(db);
  enforceCanaryRecordMutation(db, draft?.row_id || draft?.record_id);
  const contentBinding = draft?.content_binding && typeof draft.content_binding === 'object'
    ? draft.content_binding
    : {};
  const contentHash = String(draft?.content_hash || '') || createHash('sha256')
    .update(JSON.stringify({ subject: String(draft?.subject || ''), body: String(draft?.body || '') }))
    .digest('hex');
  db.prepare(`
    INSERT INTO drafts (
      draft_id, row_id, sequence_name, step_number, step_id, channel, status,
      subject, body, reason, artifacts_json, content_binding_json,
      content_hash, template_id, template_version,
      created_at, updated_at
    ) VALUES (
      @draft_id, @row_id, @sequence_name, @step_number, @step_id, @channel, @status,
      @subject, @body, @reason, @artifacts_json, @content_binding_json,
      @content_hash, @template_id, @template_version,
      @created_at, @updated_at
    )
  `).run({
    draft_id: String(draft?.draft_id || draft?.id || ''),
    row_id: String(draft?.row_id || draft?.record_id || ''),
    sequence_name: String(draft?.sequence_name || 'default'),
    step_number: Number(draft?.step_number || 0),
    step_id: String(draft?.step_id || ''),
    channel: String(draft?.channel || 'email'),
    status: String(draft?.status || 'pending_approval'),
    subject: String(draft?.subject || ''),
    body: String(draft?.body || ''),
    reason: String(draft?.reason || ''),
    artifacts_json: safeJson(draft?.artifacts || {}),
    content_binding_json: safeJson(contentBinding),
    content_hash: contentHash,
    template_id: String(draft?.template_id || ''),
    template_version: draft?.template_version == null ? null : Number(draft.template_version),
    created_at: String(draft?.created_at || now),
    updated_at: String(draft?.updated_at || now),
  });
};

export const updateDraft = ({ db, draftId, patch }) => {
  ensureDraftCompatibility(db);
  const existing = db.prepare('SELECT * FROM drafts WHERE draft_id = ? LIMIT 1').get(String(draftId || '').trim());
  if (!existing) return null;
  // Draft approve/edit/reject always touches a record — canary gate is mandatory.
  enforceCanaryRecordMutation(db, existing.row_id || (patch as any)?.row_id);
  const contentChanged = Boolean(
    patch && (
      Object.prototype.hasOwnProperty.call(patch, 'subject')
      || Object.prototype.hasOwnProperty.call(patch, 'body')
    ),
  );
  const updatedSubject = contentChanged && Object.prototype.hasOwnProperty.call(patch, 'subject')
    ? String((patch as any).subject || '')
    : String(existing.subject || '');
  const updatedBody = contentChanged && Object.prototype.hasOwnProperty.call(patch, 'body')
    ? String((patch as any).body || '')
    : String(existing.body || '');
  const updatedContentHash = createHash('sha256')
    .update(JSON.stringify({ subject: updatedSubject, body: updatedBody }))
    .digest('hex');
  const merged = {
    ...existing,
    ...patch,
    artifacts_json: patch && Object.prototype.hasOwnProperty.call(patch, 'artifacts')
      ? safeJson((patch as any).artifacts)
      : existing.artifacts_json,
    content_binding_json: patch && Object.prototype.hasOwnProperty.call(patch, 'content_binding')
      ? safeJson((patch as any).content_binding)
      : (patch && Object.prototype.hasOwnProperty.call(patch, 'content_binding_json')
        ? (typeof (patch as any).content_binding_json === 'string'
          ? (patch as any).content_binding_json
          : safeJson((patch as any).content_binding_json))
        : existing.content_binding_json),
    content_hash: patch && Object.prototype.hasOwnProperty.call(patch, 'content_hash')
      ? String((patch as any).content_hash || '')
      : (contentChanged ? updatedContentHash : String(existing.content_hash || '')),
    template_id: patch && Object.prototype.hasOwnProperty.call(patch, 'template_id')
      ? String((patch as any).template_id || '')
      : String(existing.template_id || ''),
    template_version: patch && Object.prototype.hasOwnProperty.call(patch, 'template_version')
      ? ((patch as any).template_version == null ? null : Number((patch as any).template_version))
      : existing.template_version,
    updated_at: nowIso(),
  };
  db.prepare(`
    UPDATE drafts
    SET status = @status,
        subject = @subject,
        body = @body,
        reason = @reason,
        artifacts_json = @artifacts_json,
        content_binding_json = @content_binding_json,
        content_hash = @content_hash,
        template_id = @template_id,
        template_version = @template_version,
        updated_at = @updated_at
    WHERE draft_id = @draft_id
  `).run({
    draft_id: existing.draft_id,
    status: String(merged.status || existing.status || 'pending_approval'),
    subject: String(merged.subject || ''),
    body: String(merged.body || ''),
    reason: String(merged.reason || ''),
    artifacts_json: String(merged.artifacts_json || '{}'),
    content_binding_json: String(merged.content_binding_json || '{}'),
    content_hash: String(merged.content_hash || ''),
    template_id: String(merged.template_id || ''),
    template_version: merged.template_version == null ? null : Number(merged.template_version),
    updated_at: String(merged.updated_at),
  });
  return db.prepare('SELECT * FROM drafts WHERE draft_id = ? LIMIT 1').get(existing.draft_id);
};

export const insertAsset = ({
  db,
  rowId,
  stepId,
  label = '',
  result = '',
  outputsJson = '{}',
  isReference = false,
  status = 'ready',
  reason = '',
}) => {
  enforceCanaryRecordMutation(db, rowId);
  const assetId = `asset_${randomUUID().slice(0, 12)}`;
  const now = nowIso();
  db.prepare(`
    INSERT INTO assets (
      asset_id, row_id, step_id, label, result, outputs_json, is_reference,
      status, reason, created_at, updated_at
    ) VALUES (
      @asset_id, @row_id, @step_id, @label, @result, @outputs_json, @is_reference,
      @status, @reason, @created_at, @updated_at
    )
  `).run({
    asset_id: assetId,
    row_id: String(rowId || ''),
    step_id: String(stepId || ''),
    label: String(label || ''),
    result: String(result || ''),
    outputs_json: typeof outputsJson === 'string' ? outputsJson : safeJson(outputsJson || {}),
    is_reference: isReference ? 1 : 0,
    status: String(status || 'ready'),
    reason: String(reason || ''),
    created_at: now,
    updated_at: now,
  });
  return getAsset({ db, assetId });
};

export const updateAsset = ({
  db,
  assetId,
  label,
  result,
  outputsJson,
  isReference,
  status,
  reason,
}) => {
  const existing = db.prepare('SELECT * FROM assets WHERE asset_id = ? LIMIT 1').get(String(assetId || '').trim());
  if (!existing) return null;
  const merged = {
    ...existing,
    label: label === undefined ? existing.label : label,
    result: result === undefined ? existing.result : result,
    status: status === undefined ? existing.status : status,
    reason: reason === undefined ? existing.reason : reason,
    outputs_json: outputsJson === undefined
      ? existing.outputs_json
      : (typeof outputsJson === 'string' ? outputsJson : safeJson(outputsJson || {})),
    is_reference: isReference === undefined ? existing.is_reference : (isReference ? 1 : 0),
    updated_at: nowIso(),
  };
  db.prepare(`
    UPDATE assets
    SET label = @label,
        result = @result,
        outputs_json = @outputs_json,
        is_reference = @is_reference,
        status = @status,
        reason = @reason,
        updated_at = @updated_at
    WHERE asset_id = @asset_id
  `).run({
    asset_id: existing.asset_id,
    label: String(merged.label || ''),
    result: String(merged.result || ''),
    outputs_json: String(merged.outputs_json || '{}'),
    is_reference: merged.is_reference ? 1 : 0,
    status: String(merged.status || 'ready'),
    reason: String(merged.reason || ''),
    updated_at: String(merged.updated_at),
  });
  return getAsset({ db, assetId: existing.asset_id });
};

export const getAsset = ({ db, assetId }) =>
  normalizeAssetRow(db.prepare('SELECT * FROM assets WHERE asset_id = ? LIMIT 1').get(String(assetId || '').trim()));

export const getAssetsForRow = ({ db, rowId }) =>
  db.prepare('SELECT * FROM assets WHERE row_id = ? ORDER BY created_at DESC').all(String(rowId || '').trim()).map(normalizeAssetRow);

export const findAsset = ({ db, rowId, stepId }) =>
  normalizeAssetRow(db.prepare(`
    SELECT * FROM assets
    WHERE row_id = ? AND step_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(String(rowId || '').trim(), String(stepId || '').trim()));

export const listDrafts = ({ db, whereSql = '1=1', params = [], limit = 100, offset = 0 }) =>
  db.prepare(`
    SELECT d.*, r.business_name, COALESCE(r.fit_score, r.priority_rank) AS priority_rank
    FROM drafts d
    LEFT JOIN records r ON r._row_id = d.row_id
    WHERE ${whereSql}
    ORDER BY d.created_at DESC, d.draft_id DESC
    LIMIT ? OFFSET ?
  `).all(...params, Number(limit), Number(offset));

export const addSuppression = ({ db, entry }) => {
  db.prepare(`
    INSERT OR REPLACE INTO suppression
      (entry_id, id, identifier_value, identifier_type, value, value_type, scope, reason, source, row_id, created_at)
    VALUES
      (@entry_id, @id, @identifier_value, @identifier_type, @value, @value_type, @scope, @reason, @source, @row_id, @created_at)
  `).run({
    entry_id: entry.entry_id || entry.id,
    id: entry.id || entry.entry_id,
    identifier_value: String((entry.identifier_value || entry.value) || '').toLowerCase().trim(),
    identifier_type: entry.identifier_type || entry.value_type,
    value: String((entry.value || entry.identifier_value) || '').toLowerCase().trim(),
    value_type: entry.value_type || entry.identifier_type,
    scope: entry.scope,
    reason: entry.reason,
    source: entry.source || '',
    row_id: entry.row_id || entry.record_id || '',
    created_at: entry.created_at || nowIso(),
  });
};

const normalizeColumnType = (rawType) => {
  const normalized = String(rawType || '').trim().toUpperCase();
  if (normalized === 'INTEGER' || normalized === 'REAL' || normalized === 'TEXT') return normalized;
  return 'TEXT';
};

const defaultForColumnType = (type) => {
  if (type === 'INTEGER') return '0';
  if (type === 'REAL') return '0';
  return "''";
};

export const ensureRecordColumns = ({ db, columns = [] }) => {
  const existing = new Set(
    db.prepare("PRAGMA table_info(records)").all().map((row) => String(row.name || ''))
  );

  for (const raw of columns) {
    const column = typeof raw === 'string' ? String(raw || '').trim() : String(raw?.name || '').trim();
    if (!column) continue;
    if (existing.has(column)) continue;

    // Safe identifier guard for dynamic columns authored from config.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column)) continue;

    const type = normalizeColumnType(typeof raw === 'string' ? 'TEXT' : raw?.type);
    const defaultValue = defaultForColumnType(type);
    db.exec(`ALTER TABLE records ADD COLUMN ${column} ${type} DEFAULT ${defaultValue};`);
    existing.add(column);
  }
};

export const hasSuppression = ({ db, value, valueType }) => {
  const normalized = String(value || '').toLowerCase().trim();
  if (!normalized) return false;
  const row = db.prepare(`
    SELECT entry_id FROM suppression
    WHERE (identifier_value = ? AND identifier_type = ?)
       OR (value = ? AND value_type = ?)
    LIMIT 1
  `).get(normalized, valueType, normalized, valueType);
  return Boolean(row?.entry_id);
};

export const getSearchState = ({ db, searchId }) => (
  db.prepare('SELECT * FROM search_state WHERE search_id = ? LIMIT 1').get(String(searchId || '').trim())
);

export const upsertSearchState = ({
  db,
  searchId,
  configHash,
  paginationJson = '{}',
  exhausted = false,
  lastResultCount = 0,
  totalResultsFetched = 0,
  updatedAt = nowIso(),
}: {
  db: any;
  searchId: string;
  configHash: string;
  paginationJson?: string;
  exhausted?: boolean;
  lastResultCount?: number;
  totalResultsFetched?: number;
  updatedAt?: string;
}) => {
  const existing = getSearchState({ db, searchId });
  const id = String(existing?.id || `search_state_${Math.random().toString(36).slice(2, 12)}`);
  db.prepare(`
    INSERT INTO search_state (
      id, search_id, config_hash, pagination_json, exhausted, last_result_count, total_results_fetched, updated_at
    ) VALUES (
      @id, @search_id, @config_hash, @pagination_json, @exhausted, @last_result_count, @total_results_fetched, @updated_at
    )
    ON CONFLICT(search_id) DO UPDATE SET
      config_hash = excluded.config_hash,
      pagination_json = excluded.pagination_json,
      exhausted = excluded.exhausted,
      last_result_count = excluded.last_result_count,
      total_results_fetched = excluded.total_results_fetched,
      updated_at = excluded.updated_at
  `).run({
    id,
    search_id: String(searchId || '').trim(),
    config_hash: String(configHash || ''),
    pagination_json: String(paginationJson || '{}'),
    exhausted: exhausted ? 1 : 0,
    last_result_count: Number(lastResultCount || 0),
    total_results_fetched: Number(totalResultsFetched || 0),
    updated_at: String(updatedAt || nowIso()),
  });
};

export const clearSearchState = ({ db, searchId }) => {
  db.prepare('DELETE FROM search_state WHERE search_id = ?').run(String(searchId || '').trim());
};

export const upsertSearchTask = ({ db, task }) => {
  db.prepare(`
    INSERT INTO search_tasks (
      id, kind, params, status, pages_fetched, total_seen, new_unique, last_run_at, attempt_count, last_error
    ) VALUES (
      @id, @kind, @params, 'pending', 0, 0, 0, '', 0, ''
    )
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      params = excluded.params
  `).run({
    id: String(task?.id || ''),
    kind: String(task?.kind || ''),
    params: typeof task?.params === 'string' ? task.params : safeJson(task?.params || {}),
  });
};

export const listPendingSearchTasks = ({ db }) => (
  db.prepare("SELECT * FROM search_tasks WHERE status = 'pending' ORDER BY id").all()
);

export const listSearchTasks = ({ db }) => (
  db.prepare('SELECT * FROM search_tasks ORDER BY id').all()
);

export const getSearchTask = ({ db, id }) => (
  db.prepare('SELECT * FROM search_tasks WHERE id = ? LIMIT 1').get(String(id || ''))
);

export const listRecoverableGeoTileTasks = ({ db }) => (
  db.prepare(`
    SELECT * FROM search_tasks
    WHERE kind = 'geo_tiles' AND status = 'saturated'
    ORDER BY id
  `).all()
);

export const parkExhaustedSearchTasks = ({ db, maxAttempts }) => (
  db.prepare(`
    UPDATE search_tasks
    SET status = 'failed'
    WHERE status = 'error' AND COALESCE(attempt_count, 0) >= ?
  `).run(Math.max(1, Number(maxAttempts || 1)))
);

export const rearmErroredSearchTasks = ({ db, maxAttempts }) => (
  db.prepare(`
    UPDATE search_tasks
    SET status = 'pending'
    WHERE status = 'error' AND COALESCE(attempt_count, 0) < ?
  `).run(Math.max(1, Number(maxAttempts || 1)))
);

export const rearmDoneGeoTileTasks = ({ db }) => (
  db.prepare(`
    UPDATE search_tasks
    SET status = 'pending'
    WHERE kind = 'geo_tiles' AND status = 'done'
  `).run()
);

export const updateSearchTaskResult = ({
  db,
  id,
  status,
  pagesFetched = 0,
  totalSeen = 0,
  newUnique = 0,
  lastRunAt = nowIso(),
  attemptCount = null,
  lastError = null,
}) => {
  db.prepare(`
    UPDATE search_tasks
    SET status = @status,
        pages_fetched = @pages_fetched,
        total_seen = @total_seen,
        new_unique = @new_unique,
        last_run_at = @last_run_at,
        attempt_count = COALESCE(@attempt_count, attempt_count),
        last_error = COALESCE(@last_error, last_error)
    WHERE id = @id
  `).run({
    id: String(id || ''),
    status: String(status || 'done'),
    pages_fetched: Number(pagesFetched || 0),
    total_seen: Number(totalSeen || 0),
    new_unique: Number(newUnique || 0),
    last_run_at: String(lastRunAt || nowIso()),
    attempt_count: attemptCount === null ? null : Number(attemptCount || 0),
    last_error: lastError === null ? null : String(lastError || ''),
  });
};

export const nowTimestamp = nowIso;
