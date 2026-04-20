# Data Schema

SQLite schema for the canonical record store (one DB file per list at `.outbound/prospects.db`). This is the table-by-table reference. For storage-level concerns (WAL, backup, upgrade path), see `storage.md`. For the user-facing view of what a record represents, see `../product/record-model.md`.

## Design Principles

- **Wide `records` table** — identity, enrichment output, scores, sequence cursor, CRM linkage, suppression flags, outcome all live on the record row. `ALTER TABLE ADD COLUMN` when enrichment steps declare new output columns.
- **Relational for multi-valued state** — contacts, events, scores, routes, suppression entries are their own tables.
- **Append-only for history** — `channel_events`, `score_events`, `compliance_log`, `cost_events` are never updated, only inserted. Current state is derived via indexed queries on latest events.
- **FKs enforced** — `PRAGMA foreign_keys = ON` on every connection.

## Tables

### `records`

One row per business location. The center of gravity.

| Column | Type | Purpose |
|---|---|---|
| `_row_id` | TEXT PRIMARY KEY | UUID v4; stable identity across phases |
| `_created_at` | TEXT NOT NULL | ISO timestamp |
| `_updated_at` | TEXT NOT NULL | ISO timestamp, bumped on every write |
| `business_name` | TEXT | Legal or DBA name |
| `address` | TEXT | Full street address |
| `city` | TEXT | |
| `state` | TEXT | |
| `zip` | TEXT | |
| `latitude` | REAL | For route planning |
| `longitude` | REAL | For route planning |
| `phone` | TEXT | Primary business phone |
| `website` | TEXT | Canonical URL (normalized) |
| `domain` | TEXT | Extracted from website; dedup key |
| `google_place_id` | TEXT | Stable Google Maps identifier |
| `parent_row_id` | TEXT | Self-FK for parent/branch relationships |
| `source` | TEXT | Search ID that produced this record |
| `source_query` | TEXT | Human-readable query string |
| `sourced_at` | TEXT | ISO timestamp |
| `duplicate_of` | TEXT | Self-FK to the canonical record if this is a duplicate |
| `duplicate_status` | TEXT | `confirmed`, `needs_review`, or NULL |
| `source_filter_result` | TEXT | `passed`, `failed`, or NULL |
| `source_filter_failures` | TEXT | Comma-separated failed filter IDs |
| *(enrichment columns)* | varies | Added per-step via `ALTER TABLE`; type derived from `outputs` declaration (`string` → TEXT, `number` → REAL, `integer`/`boolean` → INTEGER) |
| `vertical` | TEXT | From vertical classifier |
| `sub_vertical` | TEXT | |
| `workflow_signals` | TEXT | Comma-separated workflow tags |
| `persona` | TEXT | Named persona hypothesis |
| `size_tier` | TEXT | `solo`, `small`, `mid`, `regional` |
| `is_franchise` | INTEGER | Boolean |
| `fit_score` | INTEGER | 0–100 |
| `fit_score_breakdown` | TEXT | JSON |
| `fit_score_updated_at` | TEXT | |
| `trigger_score` | INTEGER | 0–100 |
| `trigger_score_breakdown` | TEXT | JSON |
| `trigger_score_updated_at` | TEXT | |
| `trigger_score_peak` | INTEGER | Monotonic max |
| `priority_rank` | INTEGER | Computed rank within list |
| `sequence_name` | TEXT | Which sequence the record is in |
| `sequence_status` | TEXT | `idle`, `active`, `engaged`, `completed`, `opted_out`, `bounced`, `suppressed` |
| `sequence_step` | INTEGER | Cursor within the sequence |
| `sequence_step_attempts` | INTEGER | Retry counter |
| `next_action_date` | TEXT | ISO date when the next step is due |
| `last_outreach_date` | TEXT | |
| `launched_at` | TEXT | When step 1 fired |
| `suppressed` | INTEGER | Boolean master kill switch |
| `suppressed_reason` | TEXT | `opt_out`, `bounce`, `dnc_request`, `manual`, `crm_dnc`, `verification_failed`, `not_a_fit` |
| `suppressed_at` | TEXT | |
| `dne_email` | INTEGER | Boolean |
| `dnc_phone` | INTEGER | Boolean |
| `dnk_visit` | INTEGER | Boolean |
| `crm_company_id` | TEXT | CRM Company ID |
| `crm_person_id` | TEXT | Primary CRM Person ID |
| `crm_deal_id` | TEXT | CRM Deal ID |
| `crm_sync_hash` | TEXT | Hash of last-synced state |
| `crm_last_synced_at` | TEXT | |
| `outcome` | TEXT | `open`, `meeting_booked`, `closed_won`, `closed_lost`, `no_response` |
| `outcome_at` | TEXT | |
| `outcome_notes` | TEXT | Free text |
| `outcome_value` | INTEGER | Cents |

**Indexes:**
- `idx_records_domain` on `domain`
- `idx_records_place_id` on `google_place_id`
- `idx_records_sequence` on `(sequence_status, next_action_date)`
- `idx_records_priority` on `(priority_rank DESC)`
- `idx_records_crm` on `crm_company_id`

**Invariant:** records are never deleted. Dedup sets `duplicate_of` to link duplicates to a canonical record; removal sets `suppressed = 1`.

### `record_embeddings`

Vector embeddings for deduplication. One embedding per record, derived from the list's identity fields.

| Column | Type | Purpose |
|---|---|---|
| `row_id` | TEXT PRIMARY KEY REFERENCES records(_row_id) | |
| `embedding` | BLOB NOT NULL | 384-dimensional vector (binary `Float32Array`, L2-normalized) |
| `identity_hash` | TEXT NOT NULL | SHA-256 of identity field values + identity schema; used for staleness detection |
| `embedded_at` | TEXT NOT NULL | ISO timestamp |

Similarity search is performed in-process via dot product of normalized vectors (equivalent to cosine similarity). No vector index extension is used — for typical list sizes (hundreds to low thousands of records), loading all embeddings and computing dot products in JS is fast enough.

### `contacts`

One row per contact. Supports multi-contact businesses natively.

| Column | Type | Purpose |
|---|---|---|
| `contact_id` | TEXT PRIMARY KEY | UUID |
| `row_id` | TEXT NOT NULL REFERENCES records(_row_id) | |
| `role` | TEXT | `primary`, `secondary`, `gatekeeper`, `billing`, etc. |
| `name` | TEXT | |
| `title` | TEXT | |
| `email` | TEXT | |
| `email_verification_status` | TEXT | `valid`, `invalid`, `risky`, `unknown` |
| `email_verification_confidence` | REAL | 0–1 |
| `email_verified_at` | TEXT | |
| `phone` | TEXT | |
| `linkedin_url` | TEXT | |
| `crm_person_id` | TEXT | |
| `dne_email` | INTEGER | Per-contact email opt-out |
| `dnc_phone` | INTEGER | Per-contact phone opt-out |
| `created_at` | TEXT | |
| `updated_at` | TEXT | |

**Indexes:**
- `idx_contacts_row` on `row_id`
- `idx_contacts_email` on `email`
- `idx_contacts_crm` on `crm_person_id`

### `channel_events`

Append-only log of every touch across every channel. Queried for history, reply detection, bounce tracking, cross-channel gating.

| Column | Type | Purpose |
|---|---|---|
| `event_id` | TEXT PRIMARY KEY | UUID |
| `row_id` | TEXT NOT NULL REFERENCES records(_row_id) | |
| `contact_id` | TEXT REFERENCES contacts(contact_id) | Nullable; for contact-bound events |
| `channel` | TEXT NOT NULL | `email`, `mail`, `visit`, `sms`, `call` |
| `event_type` | TEXT NOT NULL | `draft_created`, `sent`, `delivered`, `replied`, `bounced`, `returned`, `visit_completed`, `call_logged`, ... |
| `sequence_step` | INTEGER | Which sequence step produced this |
| `occurred_at` | TEXT NOT NULL | ISO timestamp |
| `provider_id` | TEXT | Provider's ID (Gmail message ID, Lob piece ID, etc.) |
| `thread_id` | TEXT | Email thread ID (for threading follow-ups) |
| `disposition` | TEXT | Visit/call disposition |
| `notes` | TEXT | Free text |
| `metadata` | TEXT | JSON — tracking URLs, reply classification, bounce type, inbox used, cost cents, etc. |

**Indexes:**
- `idx_events_row` on `(row_id, occurred_at DESC)` — most-recent first
- `idx_events_channel` on `(channel, event_type, occurred_at DESC)`
- `idx_events_thread` on `thread_id`
- `idx_events_provider` on `provider_id`

**Query patterns:**
- "Most recent email for this record": `SELECT * FROM channel_events WHERE row_id=? AND channel='email' ORDER BY occurred_at DESC LIMIT 1`
- "Was mail delivered?": `EXISTS(SELECT 1 FROM channel_events WHERE row_id=? AND channel='mail' AND event_type='delivered')`
- "Any replies in the last 24h across a list": aggregate on `(channel='email', event_type='replied', occurred_at >= ...)`

### `score_events`

Append-only scoring history. Every scoring run writes one entry per axis per record; current score is either derived from the most recent entry or cached on the `records` row.

| Column | Type | Purpose |
|---|---|---|
| `event_id` | TEXT PRIMARY KEY | UUID |
| `row_id` | TEXT NOT NULL REFERENCES records(_row_id) | |
| `axis` | TEXT NOT NULL | `fit` or `trigger` |
| `score` | INTEGER NOT NULL | 0–100 |
| `reasoning` | TEXT NOT NULL | Agent's natural language explanation of the score |
| `computed_at` | TEXT NOT NULL | |

**Indexes:**
- `idx_scores_row` on `(row_id, axis, computed_at DESC)`

### `suppression`

Suppression entries. Global entries live in `~/.agent-outbound/suppression.db` with the same schema.

| Column | Type | Purpose |
|---|---|---|
| `entry_id` | TEXT PRIMARY KEY | UUID |
| `scope` | TEXT NOT NULL | `global` or `list` |
| `identifier_type` | TEXT NOT NULL | `email`, `domain`, `phone`, `address_hash`, `business_name` |
| `identifier_value` | TEXT NOT NULL | |
| `reason` | TEXT | `opt_out`, `bounce`, `dnc_request`, `manual`, `crm_dnc`, `forget_request`, `not_a_fit`, `verification_failed`, `returned_mail` |
| `source` | TEXT | Who added it: `operator`, `detect_replies`, `bounce_classifier`, `crm_sync`, `visit_disposition`, `forget_cmd` |
| `row_id` | TEXT | Optional FK back to the record that triggered the entry |
| `added_at` | TEXT NOT NULL | |

**Indexes:**
- `idx_supp_lookup` on `(identifier_type, identifier_value)` — the hot-path lookup before every send

**Query pattern before a send:** check `identifier_type + identifier_value` against both this list's DB and the global suppression DB.

### `routes` and `route_stops`

Daily visit routes.

```
routes
  route_id TEXT PRIMARY KEY
  list_id TEXT
  route_date TEXT NOT NULL       -- ISO date
  home_base TEXT
  total_drive_minutes INTEGER
  planned_at TEXT NOT NULL

route_stops
  stop_id TEXT PRIMARY KEY
  route_id TEXT NOT NULL REFERENCES routes(route_id)
  row_id TEXT NOT NULL REFERENCES records(_row_id)
  position INTEGER NOT NULL
  scheduled_time TEXT NOT NULL   -- ISO time
  drive_minutes_from_prev INTEGER
  calendar_event_id TEXT
  completed_at TEXT
  disposition TEXT
  notes TEXT
```

**Indexes:**
- `idx_stops_route` on `(route_id, position)`
- `idx_stops_row` on `row_id`
- `idx_stops_date` on `(route_date, scheduled_time)` (via join to `routes`)

### `staleness`

Enrichment staleness tracking, per (record, step).

| Column | Type | Purpose |
|---|---|---|
| `row_id` | TEXT NOT NULL REFERENCES records(_row_id) | |
| `step_id` | TEXT NOT NULL | Step ID from config |
| `input_hash` | TEXT NOT NULL | SHA-256 of dependency values + prompt + config |
| `last_refreshed_at` | TEXT NOT NULL | |
| `ttl` | TEXT | Step's cache TTL, e.g., `90d` |
| PRIMARY KEY | `(row_id, step_id)` |

### `idempotency`

Destructive-action markers.

| Column | Type | Purpose |
|---|---|---|
| `key` | TEXT PRIMARY KEY | Composite idempotency key (e.g., `<row_id>:<step_id>`) |
| `row_id` | TEXT NOT NULL | |
| `step_id` | TEXT NOT NULL | |
| `status` | TEXT NOT NULL | `pending`, `sent`, `failed` |
| `provider_id` | TEXT | Provider's ID once sent |
| `created_at` | TEXT NOT NULL | |
| `resolved_at` | TEXT | |

### `cost_events`

Per-operation cost tracking (LLM + Composio).

| Column | Type | Purpose |
|---|---|---|
| `event_id` | TEXT PRIMARY KEY | |
| `row_id` | TEXT REFERENCES records(_row_id) | Nullable for phase-level costs |
| `step_id` | TEXT | |
| `provider` | TEXT NOT NULL | `llm`, `composio`, or a provider-specific marker |
| `input_tokens` | INTEGER | |
| `output_tokens` | INTEGER | |
| `cached_input_tokens` | INTEGER | |
| `tool_calls` | INTEGER | Composio tool invocations |
| `usd_cents` | INTEGER | Computed cost |
| `occurred_at` | TEXT NOT NULL | |

### `compliance_log`

Append-only audit trail for suppression and compliance operations.

| Column | Type | Purpose |
|---|---|---|
| `event_id` | TEXT PRIMARY KEY | |
| `action` | TEXT NOT NULL | `opt_out`, `suppress`, `forget`, `unsuppress`, `bounce_classified`, `stop_received` |
| `target_type` | TEXT | `email`, `phone`, `address`, `domain`, `row_id` |
| `target_value` | TEXT | |
| `row_id` | TEXT | Optional FK |
| `reason` | TEXT | |
| `source` | TEXT | Same taxonomy as `suppression.source` |
| `occurred_at` | TEXT NOT NULL | |

### `activity_history`

Bounded ring buffer of recent phase/step/record events — the source that `watch` reads from on reconnect. Capped to the last ~200 structured events to keep the DB small; detailed streaming goes through the activity socket.

| Column | Type | Purpose |
|---|---|---|
| `event_id` | TEXT PRIMARY KEY | |
| `event_type` | TEXT NOT NULL | `phase.start`, `phase.end`, `step.start`, `step.complete`, `step.failed`, `tool.call`, `tool.result`, ... |
| `payload` | TEXT | JSON |
| `occurred_at` | TEXT NOT NULL | |

Entries older than the last 200 are evicted on insert.

## Column Naming Conventions

- **Underscore prefix (`_row_id`, `_created_at`, `_updated_at`)** — orchestrator-managed identity/timestamps
- **`<phase>_<field>` (`sequence_status`, `source_filter_result`)** — phase or channel cursor state on the `records` table
- **`fit_score`, `trigger_score`** — agent-evaluated scores cached on the record row; detailed reasoning in `score_events`
- **No prefix** — enrichment output (business-domain fields)
- **Plural table names** (`records`, `contacts`, `channel_events`) — per SQL convention

## Access Layer

Every read and write goes through `src/orchestrator/runtime/db.ts`, which:

- Opens SQLite with WAL mode + foreign keys enabled
- Exposes typed query functions per table (`records.findById`, `records.insert`, `channelEvents.recordSent`, `suppression.check`, etc.)
- Wraps related writes in transactions
- Emits activity events on mutations (for the watch stream)
- Executes the single authoritative `SCHEMA` (`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`) on open — no migration runner, no `schema_version` tracking

No query strings outside this module. Every call site uses a typed function. This keeps schema changes localized and makes the DB boundary enforceable.

## ALTER TABLE for Enrichment Columns

Enrichment steps declare their outputs with explicit types in `config.outputs`. When the enrichment runner encounters a step whose output fields don't exist as columns on the `records` table, it runs `ALTER TABLE records ADD COLUMN <name> <type>` before execution. SQLite supports this instantly; no table rebuild required.

Column type is derived directly from the `type` field in the output declaration:

| Output `type` | SQLite column type | Zod validation |
|---|---|---|
| `string` | `TEXT` | `z.string()` |
| `number` | `REAL` | `z.number()` |
| `integer` | `INTEGER` | `z.number().int()` |
| `boolean` | `INTEGER` (0/1) | `z.boolean()` |

Values are coerced before writing: booleans become 0/1, numbers are cast, arrays and objects are JSON-serialized to TEXT. This coercion layer ensures SQLite never receives an unbindable type regardless of what the LLM returns.

Dropping a column is an explicit operator action — the tool will never drop a column automatically. If a schema-level change between tool versions requires restructuring (dropping/renaming), the operator resets `.outbound/prospects.db` and re-sources the list. Release notes call this out when relevant.
