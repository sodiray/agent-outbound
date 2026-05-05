import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readConfig } from '../orchestrator/lib/config.js';
import { validateWhereSql } from '../orchestrator/lib/sql-safety.js';
import { ensureDataAccessViews, getRecordById, listContactsByRecord, openListDb } from '../orchestrator/runtime/db.js';
import { listCommandDefinitions } from '../orchestrator/runtime/describe.js';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';

const DEFAULT_QUERY_LIMIT = 500;
const MAX_QUERY_LIMIT = 5000;

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');

const decodeCursor = (cursor: string) => {
  const raw = String(cursor || '').trim();
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const offset = Number(parsed?.offset || 0);
    return Number.isFinite(offset) && offset >= 0 ? offset : 0;
  } catch {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: 'Invalid cursor.',
      retryable: false,
      hint: 'Pass the cursor returned by the previous response.',
    });
  }
};

const normalizeSql = (sql: string) => {
  const normalized = String(sql || '').trim();
  if (!normalized) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: '--sql is required.',
      retryable: false,
    });
  }
  if (normalized.slice(0, -1).includes(';')) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: 'Only one SQL statement is allowed.',
      retryable: false,
      hint: 'Remove semicolon-separated statements.',
    });
  }
  return normalized.endsWith(';') ? normalized.slice(0, -1).trim() : normalized;
};

const assertReaderStatement = (db: any, sql: string) => {
  try {
    const stmt = db.prepare(sql);
    if (!stmt.reader) {
      throw new AgentOutboundError({
        code: 'SQL_WRITE_BLOCKED',
        message: 'Read-only endpoint blocked non-reader SQL.',
        retryable: false,
        hint: 'Use SELECT queries only.',
      });
    }
  } catch (error: any) {
    if (error instanceof AgentOutboundError) throw error;
    const msg = String(error?.message || error);
    if (/readonly|write|cannot modify|not authorized/i.test(msg)) {
      throw new AgentOutboundError({
        code: 'SQL_WRITE_BLOCKED',
        message: msg,
        retryable: false,
        hint: 'This command only supports read queries.',
      });
    }
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: msg,
      retryable: false,
      hint: 'Check SQL syntax and referenced columns/tables.',
    });
  }
};

const normalizeLimit = (input: any, fallback = DEFAULT_QUERY_LIMIT) => {
  const value = Number(input || fallback);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(MAX_QUERY_LIMIT, Math.floor(value));
};

const runPagedReadQuery = ({ db, sql, limit, cursor = '' }: { db: any; sql: string; limit: number; cursor?: string }) => {
  const normalized = normalizeSql(sql);
  assertReaderStatement(db, normalized);

  const offset = decodeCursor(cursor || '');
  const pageSql = `SELECT * FROM (${normalized}) q LIMIT ${limit + 1} OFFSET ${offset}`;
  assertReaderStatement(db, pageSql);
  const rows = db.prepare(pageSql).all();
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: pageRows,
    row_count: pageRows.length,
    truncated: hasMore,
    next_cursor: hasMore ? encodeCursor(offset + limit) : null,
    offset,
    limit,
  };
};

const ensureViews = (listDir: string) => {
  const writable = openListDb({ listDir, readonly: false });
  try {
    ensureDataAccessViews({ db: writable });
  } finally {
    writable.close();
  }
};

const csvEscape = (value: any) => {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[",\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
};

const parseSelectProjection = (input: string) => {
  return String(input || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const resolveProjectionExpression = ({ token, config }: { token: string; config: any }) => {
  const normalized = String(token || '').trim();
  if (!normalized) return '';
  if (normalized === 'contacts.primary.email') return 'primary_contact_email AS contacts_primary_email';
  if (normalized === 'contacts.primary.name') return 'primary_contact_name AS contacts_primary_name';
  if (normalized === 'contacts.primary.phone') return 'primary_contact_phone AS contacts_primary_phone';
  if (normalized === 'days_since_last_touch') {
    return `CAST(julianday('now') - julianday(COALESCE(NULLIF(last_outreach_at, ''), created_at)) AS INTEGER) AS days_since_last_touch`;
  }
  if (normalized === 'latest_channel_event_type') {
    return `(SELECT ce.event_type FROM channel_events ce WHERE ce.row_id = records_enriched._row_id ORDER BY ce.occurred_at DESC LIMIT 1) AS latest_channel_event_type`;
  }

  const dotParts = normalized.split('.');
  if (dotParts.length === 2) {
    const [stepId, fieldName] = dotParts;
    const enrich = Array.isArray(config?.enrich) ? config.enrich : [];
    const matched = enrich.find((step: any) => String(step?.id || '').trim() === stepId);
    if (matched && fieldName) {
      return `${fieldName} AS ${stepId}_${fieldName}`;
    }
  }
  return normalized;
};

const extractConfiguredColumnDescriptions = (config: any) => {
  const descriptions: Record<string, string> = {};
  const enrich = Array.isArray(config?.enrich) ? config.enrich : [];
  for (const step of enrich) {
    const stepId = String(step?.id || '').trim();
    const outputs = step?.config?.outputs && typeof step.config.outputs === 'object' ? step.config.outputs : {};
    for (const [field, def] of Object.entries(outputs)) {
      const description = String((def as any)?.description || '').trim();
      if (!description) continue;
      descriptions[String(field)] = description;
      if (stepId) descriptions[`${stepId}.${String(field)}`] = description;
    }
  }
  return descriptions;
};

const baseColumnDescriptions: Record<string, string> = {
  _row_id: 'Canonical account record id in this list.',
  business_name: 'Business name.',
  address: 'Street address.',
  phone: 'Primary business phone number.',
  email_primary: 'Primary account email on record.',
  fit_score: 'Fit score from scoring pipeline.',
  trigger_score: 'Trigger score from scoring pipeline.',
  priority_rank: 'Combined priority rank used for launch ordering.',
  sequence_status: 'Sequence lifecycle state for the account.',
  sequence_step: 'Current sequence step cursor.',
  next_action_date: 'Next due action date for sequencing.',
  launched_at: 'Sequence launch date for this account.',
  email_reply_classification: 'Legacy reply classification.',
  reply_classification_latest: 'Latest typed reply classification.',
  disposition_latest: 'Latest typed disposition value.',
  disposition_follow_up_at: 'Follow-up target date from latest disposition.',
};

const buildMarkdownSchema = ({ tables, views, relationships, examples }: any) => {
  const lines: string[] = [];
  lines.push('# Schema');
  lines.push('');
  for (const section of [
    { name: 'Tables', rows: tables },
    { name: 'Views', rows: views },
  ]) {
    lines.push(`## ${section.name}`);
    lines.push('');
    for (const item of section.rows) {
      lines.push(`### ${item.name}`);
      lines.push('');
      lines.push('| Column | Type | Description |');
      lines.push('|---|---|---|');
      for (const col of item.columns) {
        lines.push(`| ${col.name} | ${col.type} | ${col.description || ''} |`);
      }
      lines.push('');
    }
  }
  lines.push('## Relationships');
  lines.push('');
  if (!relationships.length) {
    lines.push('_None_');
  } else {
    for (const rel of relationships) {
      lines.push(`- ${rel.from_table}.${rel.from_column} -> ${rel.to_table}.${rel.to_column}`);
    }
  }
  lines.push('');
  lines.push('## Canonical Examples');
  lines.push('');
  for (const example of examples) {
    lines.push(`- ${example}`);
  }
  return lines.join('\n');
};

const periodLowerBound = (period: string) => {
  const raw = String(period || '').trim().toLowerCase();
  if (!raw) return '';
  const match = raw.match(/^(\d+)\s*([dwmy])$/);
  if (!match) return '';
  const amount = Number(match[1] || 0);
  const unit = String(match[2] || 'd');
  const days = unit === 'd' ? amount : unit === 'w' ? amount * 7 : unit === 'm' ? amount * 30 : amount * 365;
  const ts = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Date(ts).toISOString();
};

export const describeCommand = ({ command = '' }) => {
  const commands = listCommandDefinitions({ command });
  return {
    count: commands.length,
    commands,
  };
};

export const queryCommand = ({ list, sql, limit = DEFAULT_QUERY_LIMIT, cursor = '', timeoutMs = 4000 }) => {
  const listDir = resolveListDir(list);
  ensureViews(listDir);
  const db = openListDb({ listDir, readonly: true });
  try {
    const timeout = Math.max(1, Number(timeoutMs || 4000));
    try { db.pragma(`busy_timeout = ${timeout}`); } catch {}
    const page = runPagedReadQuery({
      db,
      sql: String(sql || ''),
      limit: normalizeLimit(limit),
      cursor: String(cursor || ''),
    });
    const warnings = [];
    return { ...page, warnings };
  } finally {
    db.close();
  }
};

export const schemaCommand = ({ list, table = '', format = 'json' }) => {
  const listDir = resolveListDir(list);
  ensureViews(listDir);
  const { config } = readConfig(listDir);
  const configuredDescriptions = extractConfiguredColumnDescriptions(config || {});

  const db = openListDb({ listDir, readonly: true });
  try {
    const objects = db.prepare(`
      SELECT type, name
      FROM sqlite_master
      WHERE type IN ('table', 'view')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name ASC
    `).all();

    const filter = String(table || '').trim();
    const selected = filter ? objects.filter((obj: any) => obj.name === filter) : objects;
    if (filter && selected.length === 0) {
      throw new AgentOutboundError({
        code: 'NOT_FOUND',
        message: `Unknown table/view "${filter}".`,
        retryable: false,
      });
    }

    const tables: any[] = [];
    const views: any[] = [];
    const relationships: any[] = [];

    for (const obj of selected) {
      const columns = db.prepare(`PRAGMA table_info(${obj.name})`).all().map((col: any) => ({
        name: String(col.name || ''),
        type: String(col.type || ''),
        nullable: Number(col.notnull || 0) === 0,
        default: col.dflt_value,
        description: configuredDescriptions[String(col.name || '')] || baseColumnDescriptions[String(col.name || '')] || '',
      }));
      const bucket = obj.type === 'view' ? views : tables;
      bucket.push({ name: obj.name, type: obj.type, columns });

      if (obj.type === 'table') {
        const fks = db.prepare(`PRAGMA foreign_key_list(${obj.name})`).all();
        for (const fk of fks) {
          relationships.push({
            from_table: obj.name,
            from_column: fk.from,
            to_table: fk.table,
            to_column: fk.to,
          });
        }
      }
    }

    const examples = [
      'SELECT business_name, priority_rank FROM records_enriched ORDER BY priority_rank DESC LIMIT 20',
      'SELECT * FROM sequence_state WHERE gating_state = \'due\' ORDER BY next_action_date ASC',
      'SELECT row_id, event_type, occurred_at FROM records_timeline ORDER BY occurred_at DESC LIMIT 50',
      'SELECT step_id, SUM(usd_cost) FROM ai_usage GROUP BY step_id ORDER BY SUM(usd_cost) DESC',
      'SELECT toolkit, SUM(calls) FROM tool_usage GROUP BY toolkit ORDER BY SUM(calls) DESC',
    ];

    const response = { tables, views, relationships, examples };
    if (String(format || 'json').trim().toLowerCase() === 'markdown') {
      return {
        ...response,
        markdown: buildMarkdownSchema({ ...response, examples }),
      };
    }
    if (String(format || 'json').trim().toLowerCase() !== 'json') {
      throw new AgentOutboundError({
        code: 'UNSUPPORTED_FORMAT',
        message: `Unsupported format "${format}".`,
        retryable: false,
        hint: 'Use --format json or --format markdown.',
      });
    }
    return response;
  } finally {
    db.close();
  }
};

const parquetTypeForValue = (value: any) => {
  if (typeof value === 'boolean') return 'BOOLEAN';
  if (typeof value === 'number') return Number.isInteger(value) ? 'INT64' : 'DOUBLE';
  return 'UTF8';
};

const writeParquetFile = async ({ absolute, rows }: { absolute: string; rows: any[] }) => {
  try {
    const dynamicImport = new Function('modulePath', 'return import(modulePath)') as any;
    const parquetModule: any = await dynamicImport('parquetjs-lite');
    const schemaShape: Record<string, any> = {};
    const sample = rows[0] || {};
    for (const key of Object.keys(sample)) {
      schemaShape[key] = { type: parquetTypeForValue(sample[key]), optional: true };
    }
    const schema = new parquetModule.ParquetSchema(schemaShape);
    const writer = await parquetModule.ParquetWriter.openFile(schema, absolute);
    try {
      for (const row of rows) {
        const normalized: Record<string, any> = {};
        for (const [key, value] of Object.entries(row || {})) {
          if (value === null || value === undefined) normalized[key] = undefined;
          else if (typeof value === 'object') normalized[key] = JSON.stringify(value);
          else normalized[key] = value;
        }
        await writer.appendRow(normalized);
      }
    } finally {
      await writer.close();
    }
    return true;
  } catch {
    // Fallback below.
  }

  const payload = JSON.stringify(rows || []);
  const script = [
    'import json, sys',
    'rows = json.loads(sys.stdin.read() or "[]")',
    'try:',
    '  import pyarrow as pa',
    '  import pyarrow.parquet as pq',
    'except Exception as e:',
    '  sys.stderr.write("pyarrow unavailable")',
    '  raise',
    'table = pa.Table.from_pylist(rows)',
    `pq.write_table(table, r'''${absolute.replace(/\\/g, '\\\\')}''')`,
  ].join('\n');
  const python = spawnSync('python3', ['-c', script], { input: payload, encoding: 'utf8' });
  if (python.status === 0) return true;
  return false;
};

export const exportCommand = async ({ list, toFile, select, where = '', format = 'csv' }: {
  list: string;
  toFile: string;
  select: string;
  where?: string;
  format?: string;
}) => {
  const listDir = resolveListDir(list);
  ensureViews(listDir);
  const { config } = readConfig(listDir);
  const projection = parseSelectProjection(select);
  if (projection.length === 0) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: '--select must include at least one field.',
      retryable: false,
    });
  }

  const whereCheck = validateWhereSql(String(where || '').trim());
  if (!whereCheck.ok) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: whereCheck.error || 'Invalid --where SQL fragment.',
      retryable: false,
    });
  }

  const expressions = projection.map((token) => resolveProjectionExpression({ token, config }));
  const sql = `
    SELECT ${expressions.join(', ')}
    FROM records_enriched
    WHERE ${String(where || '').trim() || '1=1'}
    ORDER BY priority_rank DESC, _row_id ASC
  `;

  const db = openListDb({ listDir, readonly: true });
  try {
    const rows = db.prepare(sql).all();
    const absolute = resolve(process.cwd(), String(toFile || '').trim());
    mkdirSync(dirname(absolute), { recursive: true });

    const normalizedFormat = String(format || 'csv').trim().toLowerCase();
    if (normalizedFormat === 'csv') {
      const headers = rows.length > 0 ? Object.keys(rows[0]) : projection.map((p) => p.replace(/\W+/g, '_'));
      const lines = [headers.join(',')];
      for (const row of rows) {
        lines.push(headers.map((key) => csvEscape((row as any)[key])).join(','));
      }
      writeFileSync(absolute, `${lines.join('\n')}\n`);
    } else if (normalizedFormat === 'jsonl') {
      const body = rows.map((row: any) => JSON.stringify(row)).join('\n');
      writeFileSync(absolute, body ? `${body}\n` : '');
    } else if (normalizedFormat === 'parquet') {
      const wrote = await writeParquetFile({ absolute, rows });
      if (!wrote) {
        throw new AgentOutboundError({
          code: 'UNSUPPORTED_FORMAT',
          message: 'Parquet export requires `parquetjs-lite` or Python `pyarrow` in this environment.',
          retryable: false,
          hint: 'Install parquetjs-lite (Node) or pyarrow (Python), or use --format csv/jsonl.',
        });
      }
    } else {
      throw new AgentOutboundError({
        code: 'UNSUPPORTED_FORMAT',
        message: `Unsupported export format "${format}".`,
        retryable: false,
      });
    }

    return {
      file: absolute,
      format: normalizedFormat,
      rows_written: rows.length,
      columns: projection,
    };
  } finally {
    db.close();
  }
};

export const viewsSaveCommand = ({ list, name, select, where = '' }) => {
  const viewName = String(name || '').trim();
  if (!viewName) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: '--name is required.',
      retryable: false,
    });
  }
  const selectSql = String(select || '').trim();
  if (!selectSql) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: '--select is required.',
      retryable: false,
    });
  }
  const whereCheck = validateWhereSql(String(where || '').trim());
  if (!whereCheck.ok) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: whereCheck.error || 'Invalid --where SQL fragment.',
      retryable: false,
    });
  }

  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO saved_views (view_name, select_sql, where_sql, created_at, updated_at)
      VALUES (@view_name, @select_sql, @where_sql, @created_at, @updated_at)
      ON CONFLICT(view_name) DO UPDATE SET
        select_sql = excluded.select_sql,
        where_sql = excluded.where_sql,
        updated_at = excluded.updated_at
    `).run({
      view_name: viewName,
      select_sql: selectSql,
      where_sql: String(where || '').trim(),
      created_at: now,
      updated_at: now,
    });
    return { status: 'saved', name: viewName };
  } finally {
    db.close();
  }
};

const parseInclude = (include: string) => new Set(
  String(include || '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
);

export const recordShowCommand = ({ list, rowId, include = '' }) => {
  const listDir = resolveListDir(list);
  ensureViews(listDir);
  const db = openListDb({ listDir, readonly: true });
  try {
    const record = getRecordById({ db, id: rowId });
    if (!record) {
      throw new AgentOutboundError({
        code: 'NOT_FOUND',
        message: `Record not found: ${rowId}`,
        retryable: false,
      });
    }
    const includes = parseInclude(include);
    const sections: Record<string, any> = {};
    const recordId = String(record._row_id || record.id || '');

    if (includes.has('contacts')) {
      sections.contacts = listContactsByRecord({ db, recordId });
    }
    if (includes.has('events')) {
      sections.events = db.prepare(`
        SELECT * FROM records_timeline
        WHERE row_id = ?
        ORDER BY occurred_at DESC, timeline_id DESC
        LIMIT 200
      `).all(recordId);
    }
    if (includes.has('scores')) {
      sections.scores = db.prepare(`
        SELECT * FROM score_events
        WHERE row_id = ?
        ORDER BY computed_at DESC
        LIMIT 100
      `).all(recordId);
    }
    if (includes.has('enrichment')) {
      sections.enrichment = db.prepare('SELECT * FROM records_enriched WHERE _row_id = ? LIMIT 1').get(recordId) || {};
    }
    if (includes.has('sequence')) {
      sections.sequence = db.prepare('SELECT * FROM sequence_state WHERE row_id = ? LIMIT 1').get(recordId) || {};
    }
    if (includes.has('drafts')) {
      sections.drafts = db.prepare(`
        SELECT *
        FROM drafts
        WHERE row_id = ?
        ORDER BY created_at DESC
      `).all(recordId);
    }
    if (includes.has('ai-usage')) {
      sections.ai_usage = db.prepare(`
        SELECT * FROM ai_usage
        WHERE row_id = ?
        ORDER BY occurred_at DESC
        LIMIT 200
      `).all(recordId);
    }

    return { record, sections };
  } finally {
    db.close();
  }
};

export const pipelineShowCommand = ({ list }) => {
  const listDir = resolveListDir(list);
  ensureViews(listDir);
  const db = openListDb({ listDir, readonly: true });
  try {
    const rows = db.prepare(`
      SELECT
        CASE
          WHEN outcome = 'won' THEN 'won'
          WHEN outcome = 'lost' THEN 'lost'
          WHEN sequence_status = 'idle' THEN 'cold'
          WHEN sequence_status = 'active' AND email_last_reply_at = '' THEN 'contacted'
          WHEN sequence_status = 'engaged' THEN 'engaged'
          WHEN COALESCE(NULLIF(reply_classification_latest, ''), email_reply_classification, '') = 'booking_intent' THEN 'meeting-booked'
          WHEN email_last_reply_at != '' THEN 'replied'
          ELSE 'contacted'
        END AS stage,
        COUNT(*) AS count,
        AVG(
          CASE
            WHEN launched_at != '' THEN julianday('now') - julianday(launched_at)
            ELSE NULL
          END
        ) AS avg_age_days
      FROM records
      GROUP BY stage
      ORDER BY stage
    `).all();

    const stageOrder = ['cold', 'contacted', 'replied', 'engaged', 'meeting-booked', 'won', 'lost'];
    const byStage = new Map(rows.map((row: any) => [String(row.stage), row]));
    const stages = stageOrder.map((stage) => {
      const row: any = byStage.get(stage);
      return {
        stage,
        count: Number(row?.count || 0),
        avg_age_days: Number(row?.avg_age_days || 0),
      };
    });
    const total = stages.reduce((sum, stage) => sum + stage.count, 0);
    const summary = stages.map((stage) => `${stage.stage}: ${stage.count}`).join(' | ');
    return { stages, total, summary };
  } finally {
    db.close();
  }
};

export const routeShowCommand = ({ list, date, include = '', cursor = '', limit = 100 }) => {
  const listDir = resolveListDir(list);
  ensureViews(listDir);
  const includes = parseInclude(include);
  const db = openListDb({ listDir, readonly: true });
  try {
    const pageLimit = normalizeLimit(limit, 100);
    const offset = decodeCursor(cursor || '');
    const rows = db.prepare(`
      SELECT
        rs.id AS stop_id,
        rs.route_id,
        rs.record_id,
        rs.stop_order,
        rs.scheduled_time,
        rs.eta,
        rs.notes,
        rs.disposition,
        rt.route_date,
        rt.status AS route_status,
        re.business_name,
        re.address,
        re.city,
        re.state,
        re.priority_rank,
        re.primary_contact_name,
        re.primary_contact_email,
        re.primary_contact_phone
      FROM route_stops rs
      INNER JOIN routes rt ON rt.id = rs.route_id
      LEFT JOIN records_enriched re ON re._row_id = rs.record_id
      WHERE rt.route_date = ?
      ORDER BY rs.stop_order ASC, rs.id ASC
      LIMIT ? OFFSET ?
    `).all(String(date || '').trim(), pageLimit + 1, offset);

    const hasMore = rows.length > pageLimit;
    const pageRows = hasMore ? rows.slice(0, pageLimit) : rows;

    if (includes.has('contacts')) {
      for (const row of pageRows) {
        (row as any).contacts = listContactsByRecord({ db, recordId: row.record_id });
      }
    }
    if (includes.has('prior-touches')) {
      for (const row of pageRows) {
        (row as any).prior_touches = db.prepare(`
          SELECT event_type, channel, disposition, notes, occurred_at
          FROM records_timeline
          WHERE row_id = ?
          ORDER BY occurred_at DESC
          LIMIT 15
        `).all(row.record_id);
      }
    }
    if (includes.has('enrichment')) {
      for (const row of pageRows) {
        (row as any).enrichment = db.prepare('SELECT * FROM records_enriched WHERE _row_id = ? LIMIT 1').get(row.record_id) || {};
      }
    }

    return {
      route_date: String(date || '').trim(),
      row_count: pageRows.length,
      rows: pageRows,
      next_cursor: hasMore ? encodeCursor(offset + pageLimit) : null,
    };
  } finally {
    db.close();
  }
};

export const repliesShowCommand = ({
  list,
  recordId = '',
  since = '',
  until = '',
  classification = '',
  cursor = '',
  limit = 100,
}) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    const clauses = ['lower(ce.event_type) = \'reply\''];
    const params: any[] = [];
    if (recordId) {
      clauses.push('(ce.row_id = ? OR ce.row_id IN (SELECT _row_id FROM records WHERE id = ?))');
      params.push(recordId, recordId);
    }
    if (since) {
      clauses.push('ce.occurred_at >= ?');
      params.push(String(since));
    }
    if (until) {
      clauses.push('ce.occurred_at <= ?');
      params.push(String(until));
    }
    if (classification) {
      clauses.push(`COALESCE(NULLIF(json_extract(ce.payload_json, '$.classification'), ''), '') = ?`);
      params.push(String(classification));
    }

    const pageLimit = normalizeLimit(limit, 100);
    const offset = decodeCursor(cursor || '');
    const rows = db.prepare(`
      SELECT
        ce.event_id,
        ce.row_id,
        r.business_name,
        ce.contact_id,
        ce.channel,
        ce.thread_id,
        ce.provider_message_id,
        ce.provider_thread_id,
        ce.notes,
        ce.payload_json,
        COALESCE(NULLIF(json_extract(ce.payload_json, '$.classification'), ''), r.reply_classification_latest, r.email_reply_classification, '') AS classification,
        ce.occurred_at
      FROM channel_events ce
      LEFT JOIN records r ON r._row_id = ce.row_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY ce.occurred_at DESC, ce.event_id DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageLimit + 1, offset);
    const hasMore = rows.length > pageLimit;
    const pageRows = hasMore ? rows.slice(0, pageLimit) : rows;

    return {
      rows: pageRows,
      count: pageRows.length,
      next_cursor: hasMore ? encodeCursor(offset + pageLimit) : null,
    };
  } finally {
    db.close();
  }
};

export const aiUsageCommand = ({ list, step = '', record = '', period = '', groupBy = '' }) => {
  const listDir = resolveListDir(list);
  ensureViews(listDir);
  const db = openListDb({ listDir, readonly: true });
  try {
    const clauses = ['1=1'];
    const params: any[] = [];
    if (step) {
      clauses.push('step_id = ?');
      params.push(String(step));
    }
    if (record) {
      clauses.push('row_id = ?');
      params.push(String(record));
    }
    const lowerBound = periodLowerBound(period);
    if (lowerBound) {
      clauses.push('occurred_at >= ?');
      params.push(lowerBound);
    }

    const group = String(groupBy || '').trim().toLowerCase();
    let selectExpr = 'step_id';
    if (group === 'record') selectExpr = 'row_id';
    else if (group === 'run') selectExpr = "COALESCE(NULLIF(run_id, ''), 'unknown')";
    else if (group === 'period') selectExpr = 'usage_date';
    else selectExpr = 'step_id';

    const rows = db.prepare(`
      SELECT
        ${selectExpr} AS group_key,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(usd_cost) AS usd_cost,
        SUM(CASE WHEN usd_cost IS NOT NULL THEN 1 ELSE 0 END) AS usd_reported_calls,
        COUNT(*) AS calls
      FROM ai_usage
      WHERE ${clauses.join(' AND ')}
      GROUP BY group_key
      ORDER BY usd_cost DESC, group_key ASC
    `).all(...params);

    const totals = db.prepare(`
      SELECT
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(usd_cost) AS usd_cost,
        SUM(CASE WHEN usd_cost IS NOT NULL THEN 1 ELSE 0 END) AS usd_reported_calls,
        COUNT(*) AS calls
      FROM ai_usage
      WHERE ${clauses.join(' AND ')}
    `).get(...params);

    const calls = Number(totals?.calls || 0);
    const usdReportedCalls = Number(totals?.usd_reported_calls || 0);
    const missingUsdCalls = Math.max(0, calls - usdReportedCalls);
    const usdDisplay = totals?.usd_cost === null || totals?.usd_cost === undefined
      ? '—'
      : `$${Number(totals?.usd_cost || 0).toFixed(2)}`;
    const summary = `AI usage: ${usdDisplay} across ${calls} calls (${usdReportedCalls} with provider-reported USD${missingUsdCalls > 0 ? `, ${missingUsdCalls} without USD` : ''}). Agent-Outbound tracks AI usage only; third-party tool costs are provider-billed and not visible here.`;
    return { rows, totals, summary };
  } finally {
    db.close();
  }
};

export const usageCommand = ({ list, toolkit = '', tool = '', step = '', record = '', period = '', groupBy = '' }) => {
  const listDir = resolveListDir(list);
  ensureViews(listDir);
  const db = openListDb({ listDir, readonly: true });
  try {
    const clauses = ['1=1'];
    const params: any[] = [];
    if (toolkit) {
      clauses.push('toolkit = ?');
      params.push(String(toolkit).toUpperCase());
    }
    if (tool) {
      clauses.push('tool = ?');
      params.push(String(tool).toUpperCase());
    }
    if (step) {
      clauses.push('step_id = ?');
      params.push(String(step));
    }
    if (record) {
      clauses.push('row_id = ?');
      params.push(String(record));
    }
    const lowerBound = periodLowerBound(period);
    if (lowerBound) {
      clauses.push('occurred_at >= ?');
      params.push(lowerBound);
    }

    const group = String(groupBy || '').trim().toLowerCase();
    let selectExpr = 'tool';
    if (group === 'toolkit') selectExpr = 'toolkit';
    else if (group === 'step') selectExpr = 'step_id';
    else if (group === 'record') selectExpr = 'row_id';
    else if (group === 'period') selectExpr = 'usage_date';
    else selectExpr = 'tool';

    const rows = db.prepare(`
      SELECT
        ${selectExpr} AS group_key,
        SUM(calls) AS calls
      FROM tool_usage
      WHERE ${clauses.join(' AND ')}
      GROUP BY group_key
      ORDER BY calls DESC, group_key ASC
    `).all(...params);

    const total = db.prepare(`
      SELECT SUM(calls) AS total_calls
      FROM tool_usage
      WHERE ${clauses.join(' AND ')}
    `).get(...params);

    return {
      rows,
      total_calls: Number(total?.total_calls || 0),
      scope_note: 'Agent-Outbound tracks AI usage only. Third-party tool costs are billed by providers; this command reports invocation counts.',
    };
  } finally {
    db.close();
  }
};
