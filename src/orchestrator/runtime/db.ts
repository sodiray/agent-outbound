import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
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
    google_place_id TEXT DEFAULT '',
    parent_row_id TEXT DEFAULT '',
    latitude REAL DEFAULT 0,
    longitude REAL DEFAULT 0,
    source TEXT DEFAULT '',
    source_query TEXT DEFAULT '',
    sourced_at TEXT DEFAULT '',
    duplicate_of TEXT DEFAULT '',
    duplicate_status TEXT DEFAULT '',
    source_filter_result TEXT DEFAULT '',
    source_filter_failures TEXT DEFAULT '',
    disqualified_at TEXT DEFAULT '',
    disqualified_gate TEXT DEFAULT '',
    disqualify_reason TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email_primary TEXT DEFAULT '',
    contact_name_primary TEXT DEFAULT '',
    contact_title_primary TEXT DEFAULT '',
    contact_name TEXT DEFAULT '',
    contact_email TEXT DEFAULT '',
    contact_title TEXT DEFAULT '',
    email_verification_status TEXT DEFAULT '',
    email_verification_confidence REAL DEFAULT 0,
    email_verified_at TEXT DEFAULT '',
    fit_score REAL DEFAULT 0,
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
    sequence_status TEXT DEFAULT 'idle',
    sequence_step INTEGER DEFAULT 0,
    sequence_step_attempts INTEGER DEFAULT 0,
    next_action_date TEXT DEFAULT '',
    launched_at TEXT DEFAULT '',
    last_outreach_at TEXT DEFAULT '',
    email_last_message_id TEXT DEFAULT '',
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
    title TEXT DEFAULT '',
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    linkedin_url TEXT DEFAULT '',
    role TEXT DEFAULT 'secondary',
    is_primary INTEGER DEFAULT 0,
    email_verification_status TEXT DEFAULT '',
    email_verification_confidence REAL DEFAULT 0,
    email_verified_at TEXT DEFAULT '',
    dne_email INTEGER DEFAULT 0,
    dnc_phone INTEGER DEFAULT 0,
    crm_person_id TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(row_id) REFERENCES records(_row_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_contacts_row ON contacts(row_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_row_email ON contacts(row_id, email);
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

  CREATE TABLE IF NOT EXISTS score_events (
    event_id TEXT PRIMARY KEY,
    row_id TEXT NOT NULL,
    axis TEXT NOT NULL,
    score INTEGER NOT NULL,
    reasoning TEXT NOT NULL,
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
    occurred_at TEXT NOT NULL,
    FOREIGN KEY(record_id) REFERENCES records(_row_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_pipeline_events_record ON pipeline_events(record_id, occurred_at DESC);

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
    last_run_at TEXT DEFAULT ''
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

const ensureRecordCompatibility = (db) => {
  try { db.exec("ALTER TABLE records ADD COLUMN reply_classification_latest TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN disposition_latest TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN disposition_follow_up_at TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN disqualified_at TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN disqualified_gate TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN disqualify_reason TEXT DEFAULT ''"); } catch {}
  // Soft-drop / review queue: a committed record a filter would now drop is flagged
  // for review instead of being disqualified, so we never destroy in-flight outreach.
  try { db.exec("ALTER TABLE records ADD COLUMN needs_review INTEGER DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN review_reason TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE records ADD COLUMN review_flagged_at TEXT DEFAULT ''"); } catch {}
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
export const hasPassedStep = ({ db, recordId, stepId }: { db: any; recordId: string; stepId: string }): boolean => {
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
    ensureRecordCompatibility(db);
    ensureSuppressionCompatibility(db);
    ensureTerritoryCompatibility(db);
    ensureDataAccessViewsInternal(db);
  }
  return db;
};

export const openListDb = ({ listDir, readonly = false }) => {
  ensureListDirs(listDir);
  const dbPath = getDbPath(listDir);
  if (readonly && !existsSync(dbPath)) {
    throw new Error(`List DB does not exist: ${dbPath}`);
  }
  return openDb({ dbPath, readonly });
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
  db.prepare(`
    INSERT INTO score_events (event_id, row_id, axis, score, reasoning, computed_at)
    VALUES (@event_id, @row_id, @axis, @score, @reasoning, @computed_at)
  `).run({
    event_id: event.event_id || event.id,
    row_id: event.row_id,
    axis: String(event.axis || ''),
    score: Number(event.score || 0),
    reasoning: String(event.reasoning || ''),
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
      payload: { axis: String(event.axis || ''), score: Number(event.score || 0) },
      occurred_at: event.computed_at || nowIso(),
    },
  });
};

export const insertPipelineEvent = ({ db, event }) => {
  db.prepare(`
    INSERT INTO pipeline_events (event_id, record_id, step_id, kind, passed, reason, occurred_at)
    VALUES (@event_id, @record_id, @step_id, @kind, @passed, @reason, @occurred_at)
  `).run({
    event_id: event.event_id || event.id,
    record_id: event.record_id || event.row_id,
    step_id: String(event.step_id || ''),
    kind: String(event.kind || ''),
    passed: event.passed ? 1 : 0,
    reason: String(event.reason || ''),
    occurred_at: event.occurred_at || nowIso(),
  });
};

export const inPlayWhere = (alias = '') => {
  const prefix = String(alias || '').trim();
  const disqualifiedCol = prefix ? `${prefix}.disqualified_at` : 'disqualified_at';
  const suppressedCol = prefix ? `${prefix}.suppressed` : 'suppressed';
  return `((${disqualifiedCol} IS NULL OR ${disqualifiedCol} = '') AND (${suppressedCol} IS NULL OR ${suppressedCol} = 0))`;
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

const isDynamicRecordValue = (value) => (
  value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint'
);

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

export const upsertRecord = ({ db, row: inputRow }) => {
  const rowId = String(inputRow._row_id || inputRow.id || '').trim();
  if (!rowId) throw new Error('Record id/_row_id is required.');
  const current = db.prepare('SELECT id, _row_id FROM records WHERE _row_id = ? OR id = ?').get(rowId, rowId);
  const row = withFieldOverrides({ db, recordId: String(current?._row_id || rowId), row: inputRow });
  const timestamp = nowIso();

  if (current?.id) {
    const knownFields = [
      '_row_id', '_created_at', '_updated_at',
      'business_name', 'address', 'city', 'state', 'zip', 'postal_code', 'country', 'website', 'domain', 'phone',
      'email_primary', 'contact_name_primary', 'contact_title_primary', 'fit_score', 'trigger_score',
      'fit_reasoning', 'trigger_reasoning',
      'priority_rank', 'sequence_name', 'sequence_status', 'sequence_step', 'next_action_date',
      'last_outreach_at', 'email_last_message_id', 'email_last_thread_id', 'email_last_draft_id',
      'email_thread_id', 'contact_name', 'contact_email', 'contact_title',
      'email_verification_status', 'email_verification_confidence', 'email_verified_at',
      'trigger_score_peak',
      'fit_updated_at', 'trigger_updated_at',
      'fit_score_updated_at', 'trigger_score_updated_at', 'source', 'source_query', 'sourced_at',
      'duplicate_of', 'duplicate_status', 'source_filter_result', 'source_filter_failures',
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
      contact_name: row.contact_name || row.contact_name_primary || '',
      contact_email: row.contact_email || row.email_primary || '',
      contact_title: row.contact_title || row.contact_title_primary || '',
      email_verification_status: row.email_verification_status || '',
      email_verification_confidence: Number(row.email_verification_confidence || 0),
      email_verified_at: row.email_verified_at || '',
      fit_score: scoreValueForWrite(row.fit_score),
      trigger_score: scoreValueForWrite(row.trigger_score),
      priority_rank: scoreValueForWrite(row.priority_rank),
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
      source_filter_result: row.source_filter_result || '',
      source_filter_failures: row.source_filter_failures || '',
      disqualified_at: row.disqualified_at || '',
      disqualified_gate: row.disqualified_gate || '',
      disqualify_reason: row.disqualify_reason || '',
      workflow_signals: typeof row.workflow_signals === 'string' ? row.workflow_signals : safeJson(row.workflow_signals),
      suppressed: row.suppressed ? 1 : 0,
      do_not_sms: row.do_not_sms ? 1 : 0,
      dne_email: row.dne_email ? 1 : 0,
      dnc_phone: row.dnc_phone ? 1 : 0,
      dnk_visit: row.dnk_visit ? 1 : 0,
      is_franchise: row.is_franchise ? 1 : 0,
      extra_json: typeof row.extra_json === 'string' ? row.extra_json : safeJson(row.extra_json),
      _row_id_current: current._row_id || current.id,
      updated_at: timestamp,
    });
    return;
  }

  const tableCols = getTableColumns(db, 'records');
  const knownInsertFields = new Set([
    '_row_id', '_created_at', '_updated_at', 'id', 'business_name', 'address', 'city', 'state', 'zip',
    'postal_code', 'country', 'website', 'domain', 'phone', 'email_primary', 'contact_name_primary',
    'contact_title_primary', 'fit_score', 'trigger_score', 'priority_rank', 'fit_reasoning', 'trigger_reasoning',
    'sequence_name', 'sequence_status', 'sequence_step', 'next_action_date', 'last_outreach_at',
    'email_last_message_id', 'email_last_thread_id', 'email_last_draft_id', 'email_last_reply_at',
    'email_reply_classification', 'reply_classification_latest', 'disposition_latest', 'disposition_follow_up_at',
    'email_thread_id', 'contact_name', 'contact_email', 'contact_title', 'email_verification_status',
    'email_verification_confidence', 'email_verified_at', 'trigger_score_peak', 'fit_updated_at',
    'trigger_updated_at', 'fit_score_updated_at', 'trigger_score_updated_at', 'source', 'source_query',
    'sourced_at', 'duplicate_of', 'duplicate_status', 'source_filter_result', 'source_filter_failures',
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
      && key !== 'updated_at'
      && isDynamicRecordValue(row[key])
  ));

  db.prepare(`
    INSERT INTO records (
      _row_id, _created_at, _updated_at,
      id, business_name, address, city, state, zip, postal_code, country, website, domain, phone,
      email_primary, contact_name_primary, contact_title_primary, fit_score, trigger_score, priority_rank,
      fit_reasoning, trigger_reasoning,
      sequence_name, sequence_status, sequence_step, next_action_date, last_outreach_at, email_last_message_id,
      email_last_thread_id, email_last_draft_id, email_last_reply_at, email_reply_classification,
      reply_classification_latest, disposition_latest, disposition_follow_up_at,
      email_thread_id, contact_name, contact_email, contact_title,
      email_verification_status, email_verification_confidence, email_verified_at,
      trigger_score_peak,
      fit_updated_at, trigger_updated_at,
      fit_score_updated_at, trigger_score_updated_at,
      source, source_query, sourced_at, duplicate_of, duplicate_status, source_filter_result, source_filter_failures,
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
      @sequence_name, @sequence_status, @sequence_step, @next_action_date, @last_outreach_at, @email_last_message_id,
      @email_last_thread_id, @email_last_draft_id, @email_last_reply_at, @email_reply_classification,
      @reply_classification_latest, @disposition_latest, @disposition_follow_up_at,
      @email_thread_id, @contact_name, @contact_email, @contact_title,
      @email_verification_status, @email_verification_confidence, @email_verified_at,
      @trigger_score_peak,
      @fit_updated_at, @trigger_updated_at,
      @fit_score_updated_at, @trigger_score_updated_at,
      @source, @source_query, @sourced_at, @duplicate_of, @duplicate_status, @source_filter_result, @source_filter_failures,
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
    contact_name_primary: row.contact_name_primary || '',
    contact_title_primary: row.contact_title_primary || '',
    fit_score: scoreValueForWrite(row.fit_score),
    trigger_score: scoreValueForWrite(row.trigger_score),
    fit_reasoning: row.fit_reasoning || '',
    trigger_reasoning: row.trigger_reasoning || '',
    priority_rank: scoreValueForWrite(row.priority_rank),
    sequence_name: row.sequence_name || 'default',
    sequence_status: row.sequence_status || 'idle',
    sequence_step: Number(row.sequence_step || 0),
    next_action_date: row.next_action_date || '',
    last_outreach_at: row.last_outreach_at || '',
    email_last_message_id: row.email_last_message_id || '',
    email_last_thread_id: row.email_last_thread_id || '',
    email_last_draft_id: row.email_last_draft_id || '',
    email_last_reply_at: row.email_last_reply_at || '',
    email_reply_classification: row.email_reply_classification || '',
    reply_classification_latest: row.reply_classification_latest || row.email_reply_classification || '',
    disposition_latest: row.disposition_latest || '',
    disposition_follow_up_at: row.disposition_follow_up_at || '',
    email_thread_id: row.email_thread_id || row.email_last_thread_id || '',
    contact_name: row.contact_name || row.contact_name_primary || '',
    contact_email: row.contact_email || row.email_primary || '',
    contact_title: row.contact_title || row.contact_title_primary || '',
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
    suppressed: row.suppressed ? 1 : 0,
    suppressed_reason: row.suppressed_reason || '',
    suppressed_at: row.suppressed_at || '',
    do_not_sms: row.do_not_sms ? 1 : 0,
    dne_email: row.dne_email ? 1 : 0,
    dnc_phone: row.dnc_phone ? 1 : 0,
    dnk_visit: row.dnk_visit ? 1 : 0,
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
export const reconcileOverrides = ({ db }) => {
  const rows = listActiveOverrides({ db });
  const now = nowIso();
  const summary = { drops_applied: 0, keeps_restored: 0 };
  rows.forEach((row) => {
    const record = getRecordById({ db, id: String(row.record_id) });
    if (!record) return;
    if (String(row.kind) === 'drop') {
      const alreadyDropped = String(record.disqualified_at || '').trim() !== '';
      if (alreadyDropped && String(record.disqualified_gate || '') === OVERRIDE_GATE) return;
      db.prepare(`
        UPDATE records SET disqualified_at = ?, disqualified_gate = ?, disqualify_reason = ?,
          needs_review = 0, review_reason = '', review_flagged_at = '', updated_at = ?
        WHERE _row_id = ?
      `).run(now, OVERRIDE_GATE, `override: ${String(row.reason || '')}`, now, String(record._row_id));
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
  'duplicate_of', 'duplicate_status',
]);

export const insertFieldOverride = ({ db, recordId, field, value, reason = '', createdBy = '' }) => {
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
export const reconcileFieldOverrides = ({ db }) => {
  const rows = listActiveFieldOverrides({ db });
  const tableCols = getTableColumns(db, 'records');
  const summary = { applied: 0 };
  rows.forEach((row) => {
    const field = String(row.field || '');
    if (!field || !tableCols.has(field)) return;
    const quoted = `"${field.replace(/"/g, '""')}"`;
    const result = db.prepare(`UPDATE records SET ${quoted} = ?, updated_at = ? WHERE _row_id = ? AND ${quoted} IS NOT ?`).run(
      row.value, nowIso(), String(row.record_id), row.value,
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
  const now = nowIso();
  const id = `int_${randomUUID().slice(0, 12)}`;
  db.prepare(`
    INSERT INTO interactions (interaction_id, record_id, contact, kind, summary, body, objections,
      follow_up_at, follow_up_done_at, follow_up_note, created_by, occurred_at, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, '')
  `).run(
    id, String(recordId), String(contact || ''), kindName, String(summary).trim(), String(body || ''), String(objections || ''),
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
  db.prepare(`
    UPDATE records
    SET duplicate_of = '', duplicate_status = ''
    WHERE duplicate_of = ?
  `).run(id);
  db.prepare('DELETE FROM records WHERE _row_id = ? OR id = ?').run(id, id);
};

export const deleteRecordsBatch = ({ db, where, params = [] as any[] }) => {
  const whereSql = String(where || '').trim();
  if (!whereSql) return { deleted: 0 };
  const bound = Array.isArray(params) ? params : [];

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
    const count = db.prepare('SELECT COUNT(*) as n FROM records').get();
    db.prepare('DELETE FROM records').run();
    return { deleted: Number(count?.n || 0), kept: 0 };
  }

  const placeholders = keepIds.map(() => '?').join(',');
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

export const upsertContact = ({ db, contact }) => {
  const rowId = String(contact?.row_id || contact?.record_id || '').trim();
  const email = String(contact?.email || '').trim().toLowerCase();
  if (!rowId || !email) return false;
  const now = nowIso();
  const existing = db.prepare('SELECT contact_id, id, created_at FROM contacts WHERE row_id = ? AND lower(email) = lower(?) LIMIT 1')
    .get(rowId, email);
  const contactId = String(existing?.contact_id || existing?.id || contact?.contact_id || contact?.id || `contact_${Math.random().toString(36).slice(2, 10)}`);

  db.prepare(`
    INSERT INTO contacts (
      contact_id, id, row_id, name, full_name, title, email, phone, linkedin_url, role, is_primary,
      email_verification_status, email_verification_confidence, email_verified_at, dne_email, dnc_phone, crm_person_id,
      created_at, updated_at
    )
    VALUES (
      @contact_id, @id, @row_id, @name, @full_name, @title, @email, @phone, @linkedin_url, @role, @is_primary,
      @email_verification_status, @email_verification_confidence, @email_verified_at, @dne_email, @dnc_phone, @crm_person_id,
      @created_at, @updated_at
    )
    ON CONFLICT(contact_id) DO UPDATE SET
      name = excluded.name,
      full_name = excluded.full_name,
      title = excluded.title,
      email = excluded.email,
      phone = excluded.phone,
      linkedin_url = excluded.linkedin_url,
      role = excluded.role,
    is_primary = excluded.is_primary,
      email_verification_status = excluded.email_verification_status,
      email_verification_confidence = excluded.email_verification_confidence,
      email_verified_at = excluded.email_verified_at,
      dne_email = excluded.dne_email,
      dnc_phone = excluded.dnc_phone,
      crm_person_id = excluded.crm_person_id,
      updated_at = excluded.updated_at
  `).run({
    contact_id: contactId,
    id: contactId,
    row_id: rowId,
    name: String(contact?.name || contact?.full_name || ''),
    full_name: String(contact?.full_name || contact?.name || ''),
    title: String(contact?.title || ''),
    email,
    phone: String(contact?.phone || ''),
    linkedin_url: String(contact?.linkedin_url || ''),
    role: String(contact?.role || 'secondary'),
    is_primary: contact?.is_primary ? 1 : 0,
    email_verification_status: String(contact?.email_verification_status || ''),
    email_verification_confidence: Number(contact?.email_verification_confidence || 0),
    email_verified_at: String(contact?.email_verified_at || ''),
    dne_email: contact?.dne_email ? 1 : 0,
    dnc_phone: contact?.dnc_phone ? 1 : 0,
    crm_person_id: String(contact?.crm_person_id || ''),
    created_at: existing?.created_at || now,
    updated_at: now,
  });
  return true;
};

export const listContactsByRecord = ({ db, recordId }) =>
  db.prepare('SELECT * FROM contacts WHERE row_id = ? ORDER BY is_primary DESC, updated_at DESC').all(recordId);

export const getPrimaryContact = ({ db, recordId }) =>
  db.prepare('SELECT * FROM contacts WHERE row_id = ? ORDER BY is_primary DESC, updated_at DESC LIMIT 1').get(recordId);

export const insertDraft = ({ db, draft }) => {
  const now = nowIso();
  db.prepare(`
    INSERT INTO drafts (
      draft_id, row_id, sequence_name, step_number, step_id, channel, status,
      subject, body, reason, artifacts_json, created_at, updated_at
    ) VALUES (
      @draft_id, @row_id, @sequence_name, @step_number, @step_id, @channel, @status,
      @subject, @body, @reason, @artifacts_json, @created_at, @updated_at
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
    created_at: String(draft?.created_at || now),
    updated_at: String(draft?.updated_at || now),
  });
};

export const updateDraft = ({ db, draftId, patch }) => {
  const existing = db.prepare('SELECT * FROM drafts WHERE draft_id = ? LIMIT 1').get(String(draftId || '').trim());
  if (!existing) return null;
  const merged = {
    ...existing,
    ...patch,
    artifacts_json: patch && Object.prototype.hasOwnProperty.call(patch, 'artifacts')
      ? safeJson((patch as any).artifacts)
      : existing.artifacts_json,
    updated_at: nowIso(),
  };
  db.prepare(`
    UPDATE drafts
    SET status = @status,
        subject = @subject,
        body = @body,
        reason = @reason,
        artifacts_json = @artifacts_json,
        updated_at = @updated_at
    WHERE draft_id = @draft_id
  `).run({
    draft_id: existing.draft_id,
    status: String(merged.status || existing.status || 'pending_approval'),
    subject: String(merged.subject || ''),
    body: String(merged.body || ''),
    reason: String(merged.reason || ''),
    artifacts_json: String(merged.artifacts_json || '{}'),
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
      id, kind, params, status, pages_fetched, total_seen, new_unique, last_run_at
    ) VALUES (
      @id, @kind, @params, 'pending', 0, 0, 0, ''
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

export const updateSearchTaskResult = ({
  db,
  id,
  status,
  pagesFetched = 0,
  totalSeen = 0,
  newUnique = 0,
  lastRunAt = nowIso(),
}) => {
  db.prepare(`
    UPDATE search_tasks
    SET status = @status,
        pages_fetched = @pages_fetched,
        total_seen = @total_seen,
        new_unique = @new_unique,
        last_run_at = @last_run_at
    WHERE id = @id
  `).run({
    id: String(id || ''),
    status: String(status || 'done'),
    pages_fetched: Number(pagesFetched || 0),
    total_seen: Number(totalSeen || 0),
    new_unique: Number(newUnique || 0),
    last_run_at: String(lastRunAt || nowIso()),
  });
};

export const nowTimestamp = nowIso;
