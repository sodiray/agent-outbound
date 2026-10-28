import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ensureRecordColumns, getRecordById, upsertRecord } from './db.js';
import type { openListDb } from './db.js';
import { flattenPipelineSteps } from '../lib/subpipelines.js';
import { assertListAccessForMutation, assertRecordAccessForMutation } from '../policy/canary-isolation.js';
import { externalObject, externalText, externalPath, validateExternalOutputs } from './external-values.js';

type Db = ReturnType<typeof openListDb>;
export const ExternalEventSchema = z.object({
  id: z.string().min(1).max(500), source: z.string().min(1).max(200), type: z.string().min(1).max(200),
  reference: z.string().min(1).max(2000), occurred_at: z.string().datetime(), data: z.record(z.unknown()),
}).strict();
type Event = z.infer<typeof ExternalEventSchema>;
const stableValue = (value: unknown): unknown => Array.isArray(value) ? value.map(stableValue)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stableValue(v)])) : value;
const fingerprint = (event: Event) => createHash('sha256').update(JSON.stringify(stableValue(event))).digest('hex');
const identifier = (value: unknown) => {
  const name = externalText(value);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid event reference field.');
  return `"${name}"`;
};
export const ensureExternalEvents = (db: Db) => db.exec(`
  CREATE TABLE IF NOT EXISTS external_events (
    source TEXT NOT NULL, event_id TEXT NOT NULL, event_type TEXT NOT NULL, reference TEXT NOT NULL,
    occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL, fingerprint TEXT NOT NULL,
    status TEXT NOT NULL, record_id TEXT NOT NULL DEFAULT '', resolved_at TEXT NOT NULL DEFAULT '', received_at TEXT NOT NULL,
    PRIMARY KEY(source,event_id)
  );
  CREATE TABLE IF NOT EXISTS external_event_consumptions (
    source TEXT NOT NULL, event_id TEXT NOT NULL, record_id TEXT NOT NULL, step_id TEXT NOT NULL,
    outputs_json TEXT NOT NULL, consumed_at TEXT NOT NULL,
    PRIMARY KEY(source,event_id,record_id,step_id),
    FOREIGN KEY(source,event_id) REFERENCES external_events(source,event_id)
  );
`);
const consumers = (config: unknown) => flattenPipelineSteps(config).filter((step) => step.kind === 'await_event' || step.kind === 'on_event');
const correlate = (db: Db, config: unknown, event: Event) => {
  const columns = new Set((db.prepare('PRAGMA table_info(records)').all() as Array<{ name: string }>).map((r) => r.name));
  const matches = new Set<string>();
  for (const step of consumers(config)) {
    if (step.source !== event.source || step.event !== event.type || !columns.has(externalText(step.reference_field))) continue;
    const rows = db.prepare(`SELECT _row_id FROM records WHERE ${identifier(step.reference_field)} = ?`).all(event.reference) as Array<{ _row_id: string }>;
    rows.forEach((row) => matches.add(row._row_id));
  }
  return [...matches];
};
export const ingestExternalEvents = ({ db, config, listDir, events }: { db: Db; config: unknown; listDir: string; events: unknown[] }) => {
  assertListAccessForMutation(listDir);
  if (events.length > 1000) throw new Error('External event batches are limited to 1000 events.');
  const parsed = events.map((event) => ExternalEventSchema.parse(event));
  ensureExternalEvents(db);
  return db.transaction(() => {
    const results = parsed.map((event) => {
      const existing = db.prepare('SELECT * FROM external_events WHERE source = ? AND event_id = ?').get(event.source, event.id);
      if (existing && existing.fingerprint !== fingerprint(event)) throw new Error('Conflicting external event ID reuse.');
      if (existing?.resolved_at) return { source: event.source, id: event.id, status: existing.status, record_id: existing.record_id, duplicate: true };
      const matches = correlate(db, config, event);
      if (matches.length === 1) assertRecordAccessForMutation({ listDir, recordId: matches[0] });
      const status = matches.length === 1 ? 'matched' : matches.length ? 'ambiguous' : 'unmatched';
      db.prepare(`INSERT INTO external_events (source,event_id,event_type,reference,occurred_at,payload_json,fingerprint,status,record_id,received_at)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source,event_id) DO UPDATE SET status = excluded.status, record_id = excluded.record_id`)
        .run(event.source, event.id, event.type, event.reference, event.occurred_at, JSON.stringify(event.data), fingerprint(event), status, matches.length === 1 ? matches[0] : '', new Date().toISOString());
      return { source: event.source, id: event.id, status, record_id: matches.length === 1 ? matches[0] : '', duplicate: Boolean(existing) };
    });
    return { events: results, record_ids: [...new Set(results.map((r) => externalText(r.record_id)).filter(Boolean))] };
  })();
};
export const listExternalEvents = (db: Db, status = '') => {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'external_events'").get()) return [];
  return db.prepare('SELECT * FROM external_events WHERE (? = ? OR status = ?) ORDER BY received_at,source,event_id').all(status, '', status);
};
export const resolveExternalEvent = ({ db, config, listDir, source, id, recordId }: { db: Db; config: unknown; listDir: string; source: string; id: string; recordId: string }) => {
  assertRecordAccessForMutation({ listDir, recordId });
  ensureExternalEvents(db);
  const event = db.prepare('SELECT * FROM external_events WHERE source = ? AND event_id = ?').get(source, id);
  if (!event || !getRecordById({ db, id: recordId })) throw new Error('Event and record are required.');
  if (!['unmatched', 'ambiguous'].includes(event.status)) throw new Error('Only unresolved events can be explicitly bound.');
  if (!consumers(config).some((step) => step.source === source && step.event === event.event_type)) throw new Error('No configured node accepts this source and event type.');
  db.prepare("UPDATE external_events SET status = 'matched', record_id = ?, resolved_at = ? WHERE source = ? AND event_id = ?")
    .run(recordId, new Date().toISOString(), source, id);
  return { source, id, record_id: recordId, status: 'matched' };
};
export const consumeExternalEvent = ({ db, config, listDir, step, record }: { db: Db; config: unknown; listDir: string; step: Record<string, unknown>; record: Record<string, unknown> }) => {
  assertRecordAccessForMutation({ listDir, recordId: externalText(record._row_id) });
  ensureExternalEvents(db);
  // Events may precede the operation output that supplies their reference.
  const unresolved = db.prepare("SELECT * FROM external_events WHERE source = ? AND event_type = ? AND status IN ('unmatched','ambiguous')")
    .all(step.source, step.event) as Array<Record<string, unknown>>;
  if (unresolved.length) ingestExternalEvents({ db, config, listDir, events: unresolved.map((e) => ({ id: e.event_id, source: e.source, type: e.event_type, reference: e.reference, occurred_at: e.occurred_at, data: JSON.parse(externalText(e.payload_json)) })) });
  return db.transaction(() => {
    const recordId = externalText(record._row_id);
    const prior = db.prepare('SELECT outputs_json FROM external_event_consumptions WHERE record_id = ? AND step_id = ? ORDER BY consumed_at LIMIT 1').get(recordId, step.id);
    const event = prior ? null : db.prepare(`SELECT * FROM external_events WHERE source = ? AND event_type = ? AND status = 'matched' AND record_id = ?
      AND (reference = ? OR resolved_at <> '') ORDER BY occurred_at,event_id LIMIT 1`)
      .get(step.source, step.event, recordId, record[externalText(step.reference_field)]);
    if (!prior && !event) return { passed: false, executed: false, parked: true, reason: 'awaiting_external_event' };
    const values = prior ? JSON.parse(prior.outputs_json) : validateExternalOutputs(step.outputs,
      Object.fromEntries(Object.entries(externalObject(step.output_map)).map(([field, path]) => [field, externalPath(JSON.parse(event.payload_json), externalText(path))])));
    ensureRecordColumns({ db, columns: Object.keys(values) });
    upsertRecord({ db, row: { ...getRecordById({ db, id: recordId }), ...values } });
    if (!prior) db.prepare('INSERT INTO external_event_consumptions (source,event_id,record_id,step_id,outputs_json,consumed_at) VALUES (?,?,?,?,?,?)')
      .run(event.source, event.event_id, recordId, step.id, JSON.stringify(values), new Date().toISOString());
    return { passed: true, reason: 'external_event_received', declaredOutputWrites: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { provided: true, value }])) };
  })();
};
