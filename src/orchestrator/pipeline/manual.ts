import { randomUUID } from 'node:crypto';
import { flattenPipelineSteps } from '../lib/subpipelines.js';
import { insertPipelineEvent, nowTimestamp } from '../runtime/db.js';

const text = (value: unknown) => String(value || '').trim();

export type ManualTaskRow = {
  record_id: string;
  step_id: string;
  task_type: string;
  business_name: string;
  address: string;
  contact_name: string;
  contact_email: string;
  sequence_name: string;
  pipeline_name: string;
  parked_at: string;
  reason: string;
};

/** Records currently parked on a manual_task step (reason awaiting_manual). */
export const listAwaitingManualTasks = ({
  db,
  taskType = '',
  limit = 100,
  offset = 0,
}: {
  db: any;
  taskType?: string;
  limit?: number;
  offset?: number;
}): { total: number; tasks: ManualTaskRow[] } => {
  const typeFilter = text(taskType);
  const rows = db.prepare(`
    SELECT
      e.record_id AS record_id,
      e.step_id AS step_id,
      e.occurred_at AS parked_at,
      e.reason AS reason,
      COALESCE(r.business_name, '') AS business_name,
      COALESCE(r.address, '') AS address,
      COALESCE(r.contact_name, '') AS contact_name,
      COALESCE(r.contact_email, '') AS contact_email,
      COALESCE(r.sequence_name, 'default') AS sequence_name,
      COALESCE(r.pipeline_name, 'default') AS pipeline_name
    FROM pipeline_events e
    JOIN records r ON r._row_id = e.record_id
    WHERE e.kind = 'manual_task'
      AND e.passed = 0
      AND e.reason = 'awaiting_manual'
      AND NOT EXISTS (
        SELECT 1 FROM pipeline_events done
        WHERE done.record_id = e.record_id
          AND done.step_id = e.step_id
          AND done.kind = 'manual_task'
          AND done.passed = 1
          AND done.occurred_at > e.occurred_at
      )
    ORDER BY e.occurred_at ASC
    LIMIT ? OFFSET ?
  `).all(Math.max(1, Number(limit) || 100), Math.max(0, Number(offset) || 0));

  const tasks: ManualTaskRow[] = rows.map((row: any) => {
    const stepId = text(row.step_id);
    const taskTypeFromId = stepId.includes('visit')
      ? 'visit'
      : stepId.includes('mail') || stepId.includes('letter')
        ? 'mail'
        : stepId.includes('linkedin')
          ? 'linkedin'
          : 'manual';
    return {
      record_id: text(row.record_id),
      step_id: stepId,
      task_type: taskTypeFromId,
      business_name: text(row.business_name),
      address: text(row.address),
      contact_name: text(row.contact_name),
      contact_email: text(row.contact_email),
      sequence_name: text(row.sequence_name),
      pipeline_name: text(row.pipeline_name),
      parked_at: text(row.parked_at),
      reason: text(row.reason),
    };
  }).filter((task) => !typeFilter || task.task_type === typeFilter);

  const totalRow = db.prepare(`
    SELECT COUNT(*) AS n
    FROM pipeline_events e
    WHERE e.kind = 'manual_task'
      AND e.passed = 0
      AND e.reason = 'awaiting_manual'
      AND NOT EXISTS (
        SELECT 1 FROM pipeline_events done
        WHERE done.record_id = e.record_id
          AND done.step_id = e.step_id
          AND done.kind = 'manual_task'
          AND done.passed = 1
          AND done.occurred_at > e.occurred_at
      )
  `).get();

  return {
    total: Number(totalRow?.n || tasks.length),
    tasks,
  };
};

/** Mark a parked manual_task complete so the pipeline can advance past it. */
export const completeManualTask = ({
  db,
  config,
  recordId,
  stepId,
  note = '',
  skip = false,
}: {
  db: any;
  config?: any;
  recordId: string;
  stepId: string;
  note?: string;
  skip?: boolean;
}) => {
  const rid = text(recordId);
  const sid = text(stepId);
  if (!rid || !sid) throw new Error('recordId and stepId are required.');

  const parked = db.prepare(`
    SELECT event_id
    FROM pipeline_events
    WHERE record_id = ? AND step_id = ? AND kind = 'manual_task'
      AND passed = 0 AND reason = 'awaiting_manual'
    ORDER BY occurred_at DESC
    LIMIT 1
  `).get(rid, sid);
  if (!parked) {
    throw new Error(`No awaiting manual task for record ${rid} step ${sid}.`);
  }

  // Guard: only complete steps that are configured as manual_task when config is present.
  if (config) {
    const steps = flattenPipelineSteps(config);
    const configured = steps.find((step: any) => text(step?.id) === sid);
    if (configured && text(configured.kind) !== 'manual_task') {
      throw new Error(`Step "${sid}" is not a manual_task (kind=${text(configured.kind)}).`);
    }
  }

  const now = nowTimestamp();
  insertPipelineEvent({
    db,
    event: {
      event_id: randomUUID(),
      record_id: rid,
      step_id: sid,
      kind: 'manual_task',
      passed: true,
      reason: skip ? `skipped:${text(note) || 'operator'}` : (text(note) || 'completed'),
      occurred_at: now,
    },
  });

  return {
    status: skip ? 'manual_skipped' : 'manual_completed',
    record_id: rid,
    step_id: sid,
    note: text(note),
    completed_at: now,
  };
};
