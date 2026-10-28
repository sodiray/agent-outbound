import { randomUUID } from 'node:crypto';
import { executeStepBatch } from './step-executor.js';
import { getRecordById, ensureRecordColumns, upsertRecord } from '../runtime/db.js';
import { readToolCatalog } from '../lib/tool-catalog.js';
import { getMcpClient } from '../runtime/mcp.js';
import { evaluateFieldCheckGroup } from '../lib/conditions.js';
import { shouldRunForRecord, skippedWhenOutcome, stepConfigForWhen, whenPredicateForStep } from '../lib/step-when.js';

const text = (value: unknown) => String(value || '').trim();
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const path = (value: unknown, expression: string): unknown => expression.split('.').filter(Boolean)
  .reduce<unknown>((current, key) => object(current)[key], value);

export const ensureEventTurns = (db: any) => db.exec(`
  CREATE TABLE IF NOT EXISTS event_turns (
    turn_id TEXT PRIMARY KEY, record_id TEXT NOT NULL, block_id TEXT NOT NULL,
    source TEXT NOT NULL, event_id TEXT NOT NULL, turn_index INTEGER NOT NULL,
    status TEXT NOT NULL, opened_at TEXT NOT NULL, completed_at TEXT NOT NULL DEFAULT '',
    superseded_at TEXT NOT NULL DEFAULT '', ignored_at TEXT NOT NULL DEFAULT '',
    UNIQUE(record_id, block_id, source, event_id),
    UNIQUE(record_id, block_id, turn_index)
  );
  CREATE INDEX IF NOT EXISTS idx_event_turns_record_block ON event_turns(record_id, block_id, status, turn_index);
  CREATE TABLE IF NOT EXISTS event_turn_steps (
    turn_id TEXT NOT NULL, step_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '', outputs_json TEXT NOT NULL DEFAULT '{}', occurred_at TEXT NOT NULL,
    PRIMARY KEY(turn_id, step_id)
  );
`);

const outerReady = (db: any, recordId: string, block: Record<string, unknown>) => (Array.isArray(block.depends_on) ? block.depends_on : [])
  .every((id) => Boolean(db.prepare('SELECT 1 FROM pipeline_events WHERE record_id = ? AND step_id = ? AND passed = 1 LIMIT 1').get(recordId, text(id))));

const saveTurnStep = ({ db, turnId, step, status, reason, record }: { db: any; turnId: string; step: Record<string, unknown>; status: string; reason: string; record: Record<string, unknown> }) => {
  const outputs = object(step.outputs);
  const values = Object.fromEntries(Object.keys(outputs).map((field) => [field, record[field]]));
  db.prepare(`INSERT INTO event_turn_steps (turn_id,step_id,kind,status,reason,outputs_json,occurred_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(turn_id,step_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,outputs_json=excluded.outputs_json,occurred_at=excluded.occurred_at`)
    .run(turnId, text(step.id), text(step.kind), status, reason, JSON.stringify(values), new Date().toISOString());
};

const advanceTurn = async ({ db, listDir, config, turn, block }: { db: any; listDir: string; config: Record<string, unknown>; turn: Record<string, unknown>; block: Record<string, unknown> }) => {
  const turnId = text(turn.turn_id);
  const recordId = text(turn.record_id);
  const steps = Array.isArray(block.steps) ? block.steps.map(object) : [];
  const outcomes = new Map((db.prepare('SELECT * FROM event_turn_steps WHERE turn_id = ?').all(turnId) as Array<Record<string, unknown>>).map((row) => [text(row.step_id), row]));
  for (const step of steps) {
    const stepId = text(step.id);
    const existing = outcomes.get(stepId);
    if (existing?.status === 'passed' || existing?.status === 'skipped') continue;
    if (existing?.status === 'awaiting_review') return;
    const deps = Array.isArray(step.depends_on) ? step.depends_on.map(text) : [];
    if (!deps.every((dep) => outcomes.get(dep)?.status === 'passed' || outcomes.get(dep)?.status === 'skipped')) return;
    if (text(step.kind) === 'review') {
      const current = getRecordById({ db, id: recordId }) || {};
      const whenOutcome = shouldRunForRecord({
        record: current,
        predicate: whenPredicateForStep({ step, stepConfig: stepConfigForWhen(step) }),
        listDir,
      });
      if (!whenOutcome.passed) {
        const skipped = skippedWhenOutcome(whenOutcome);
        saveTurnStep({ db, turnId, step, status: 'skipped', reason: skipped.reason, record: current });
        outcomes.set(stepId, { status: 'skipped' });
        continue;
      }
      saveTurnStep({ db, turnId, step, status: 'awaiting_review', reason: 'awaiting_review', record: current });
      return;
    }
    const current = getRecordById({ db, id: recordId });
    if (!current) return;
    const scopedId = `${text(block.id)}:${turn.turn_index}:${stepId}`;
    const scopedStep = { ...step, id: scopedId };
    const mcp = text(step.kind) === 'action' ? await getMcpClient() : undefined;
    const result = (await executeStepBatch({ db, listDir, config, aiConfig: config.ai || {}, mcp, toolCatalog: readToolCatalog(listDir) }, scopedStep, scopedId, [{ ...current, _ao_turn_id: turnId }])).get(recordId);
    const after = getRecordById({ db, id: recordId }) || current;
    if (!result || result.errored) {
      saveTurnStep({ db, turnId, step, status: 'errored', reason: text(result?.reason || 'failed'), record: after });
      return;
    }
    if (result.parked) {
      saveTurnStep({ db, turnId, step, status: 'parked', reason: text(result.reason), record: after });
      return;
    }
    const status = result.executed === false || !result.passed ? 'skipped' : 'passed';
    saveTurnStep({ db, turnId, step, status, reason: text(result.reason), record: after });
    outcomes.set(stepId, { status });
  }
  db.prepare("UPDATE event_turns SET status = 'completed', completed_at = ? WHERE turn_id = ? AND status = 'open'")
    .run(new Date().toISOString(), turnId);
};

export const runEventTurns = async ({ db, listDir, config, recordIds }: { db: any; listDir: string; config: Record<string, unknown>; recordIds: string[] }) => {
  const blocks = (Array.isArray(config.pipeline) ? config.pipeline : []).map(object).filter((step) => text(step.kind) === 'on_event');
  if (blocks.length === 0) return { opened: 0, completed: 0 };
  ensureEventTurns(db);
  const ids = [...new Set(recordIds.filter(Boolean))];
  if (ids.length === 0) return { opened: 0, completed: 0 };
  for (const block of blocks) {
    for (const recordId of ids) {
      const record = getRecordById({ db, id: recordId });
      if (!record || !outerReady(db, recordId, block)) continue;
      const events = db.prepare(`SELECT * FROM external_events WHERE status = 'matched' AND record_id = ? AND source = ? AND event_type = ? ORDER BY occurred_at,event_id`)
        .all(recordId, text(block.source), text(block.event)) as Array<Record<string, unknown>>;
      for (const event of events) {
        const seen = db.prepare('SELECT 1 FROM event_turns WHERE record_id = ? AND block_id = ? AND source = ? AND event_id = ?').get(recordId, text(block.id), text(event.source), text(event.event_id));
        if (seen) continue;
        const current = getRecordById({ db, id: recordId }) || record;
        const max = Number(db.prepare('SELECT COALESCE(MAX(turn_index), 0) AS n FROM event_turns WHERE record_id = ? AND block_id = ?').get(recordId, text(block.id))?.n || 0);
        const until = object(block.until);
        const status = Object.keys(until).length > 0 && evaluateFieldCheckGroup({
          row: current,
          conditions: Array.isArray(until.conditions) ? until.conditions : [],
          match: text(until.match || 'all'),
          listDir,
        }).passed ? 'ignored' : 'open';
        const active = db.prepare("SELECT * FROM event_turns WHERE record_id = ? AND block_id = ? AND status = 'open' ORDER BY turn_index LIMIT 1").get(recordId, text(block.id)) as Record<string, unknown> | undefined;
        if (active && text(block.on_new_event || 'supersede') === 'queue') break;
        if (active) db.prepare("UPDATE event_turns SET status = 'superseded', superseded_at = ? WHERE turn_id = ?").run(new Date().toISOString(), text(active.turn_id));
        const turnId = randomUUID();
        db.prepare('INSERT INTO event_turns (turn_id,record_id,block_id,source,event_id,turn_index,status,opened_at,ignored_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(turnId, recordId, text(block.id), text(event.source), text(event.event_id), max + 1, status, new Date().toISOString(), status === 'ignored' ? new Date().toISOString() : '');
        if (status === 'open') {
          const payload = JSON.parse(text(event.payload_json) || '{}');
          const values = Object.fromEntries(Object.entries(object(block.event_fields)).map(([field, value]) => [field, path(payload, text(value))]));
          ensureRecordColumns({ db, columns: Object.keys(values) });
          upsertRecord({ db, row: { ...current, ...values } });
          await advanceTurn({
            db,
            listDir,
            config,
            turn: { turn_id: turnId, record_id: recordId, turn_index: max + 1 },
            block,
          });
        }
      }
      const active = db.prepare("SELECT * FROM event_turns WHERE record_id = ? AND block_id = ? AND status = 'open' ORDER BY turn_index LIMIT 1").get(recordId, text(block.id)) as Record<string, unknown> | undefined;
      if (active) await advanceTurn({ db, listDir, config, turn: active, block });
    }
  }
  const completed = Number(db.prepare("SELECT COUNT(*) AS n FROM event_turns WHERE status = 'completed' AND record_id IN (" + ids.map(() => '?').join(',') + ')').get(...ids)?.n || 0);
  const opened = Number(db.prepare('SELECT COUNT(*) AS n FROM event_turns WHERE record_id IN (' + ids.map(() => '?').join(',') + ')').get(...ids)?.n || 0);
  return { opened, completed };
};

export const listEventTurns = ({ db, recordId = '', blockId = '' }: { db: any; recordId?: string; blockId?: string }) => {
  ensureEventTurns(db);
  const turns = db.prepare('SELECT * FROM event_turns WHERE (? = \'\' OR record_id = ?) AND (? = \'\' OR block_id = ?) ORDER BY record_id,block_id,turn_index').all(recordId, recordId, blockId, blockId);
  return turns.map((turn: Record<string, unknown>) => ({ ...turn, steps: db.prepare('SELECT step_id,kind,status,reason,outputs_json,occurred_at FROM event_turn_steps WHERE turn_id = ? ORDER BY occurred_at,step_id').all(turn.turn_id) }));
};
