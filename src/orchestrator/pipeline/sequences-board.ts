import { flattenPipelineSteps, stepSubpipelineName } from '../lib/subpipelines.js';
import { resolveConfiguredSequence } from '../lib/sequence-resolution.js';

const text = (value: unknown) => String(value || '').trim();

export type SequenceBoardBucket = {
  step_id: string;
  kind: string;
  description: string;
  count: number;
  record_ids: string[];
};

export type SequenceBoard = {
  sequence: string;
  buckets: SequenceBoardBucket[];
  total_assigned: number;
  completed: number;
  awaiting_manual: number;
  empty_reason?: string;
};

const isParkedReason = (reason: string) => (
  reason === 'awaiting_manual'
  || reason === 'awaiting_review'
  || reason === 'wake_at'
  || reason.startsWith('Daily email cap')
  || reason.startsWith('Draft ')
);

/**
 * Current-position board for a sub-pipeline.
 *
 * A record appears in exactly one bucket:
 * - the first step that is not yet successfully completed, if that step has a
 *   parked/failed event or is simply next (no event yet after prior completes);
 * - or "completed" when every step has a passed=1 event.
 *
 * Completed earlier steps do NOT keep the record in those columns.
 */
export const getSequenceBoard = ({
  db,
  config,
  sequence,
  limitPerBucket = 50,
}: {
  db: any;
  config: any;
  sequence: string;
  limitPerBucket?: number;
}): SequenceBoard => {
  const name = text(sequence) || 'default';
  const resolved = resolveConfiguredSequence({ config, name });
  const steps = flattenPipelineSteps(config)
    .filter((step: any) => stepSubpipelineName(step) === name);

  const assignedRows = db.prepare(`
    SELECT _row_id AS record_id
    FROM records
    WHERE COALESCE(pipeline_name, '') = ?
       OR (COALESCE(pipeline_name, '') IN ('', 'default') AND COALESCE(sequence_name, 'default') = ?)
  `).all(name, name) as Array<{ record_id: string }>;

  const assignedIds = assignedRows.map((row) => text(row.record_id)).filter(Boolean);
  const limit = Math.max(1, Number(limitPerBucket) || 50);

  const bucketIds = steps.map((step: any) => text(step.id));
  const byBucket = new Map<string, string[]>(bucketIds.map((id) => [id, []]));
  let completed = 0;
  let awaitingManual = 0;

  for (const recordId of assignedIds) {
    const events = db.prepare(`
      SELECT step_id, passed, reason, occurred_at
      FROM pipeline_events
      WHERE record_id = ?
      ORDER BY occurred_at ASC
    `).all(recordId) as Array<{ step_id: string; passed: number; reason: string }>;

    // Latest event per step_id
    const latest = new Map<string, { passed: number; reason: string }>();
    for (const event of events) {
      const sid = text(event.step_id);
      if (!sid) continue;
      latest.set(sid, { passed: Number(event.passed), reason: text(event.reason) });
    }

    let placed = false;
    for (const step of steps) {
      const stepId = text(step.id);
      const state = latest.get(stepId);
      if (state && Number(state.passed) === 1) {
        continue; // completed this step — look further
      }
      // Not completed: this is current position (parked, failed, or not started).
      const list = byBucket.get(stepId) || [];
      if (list.length < limit) list.push(recordId);
      byBucket.set(stepId, list);
      if (state && isParkedReason(state.reason)) {
        if (text(step.kind) === 'manual_task' || state.reason === 'awaiting_manual') {
          awaitingManual += 1;
        }
      }
      placed = true;
      break;
    }
    if (!placed && steps.length > 0) {
      completed += 1;
    }
  }

  const buckets: SequenceBoardBucket[] = steps.map((step: any) => {
    const stepId = text(step.id);
    const recordIds = byBucket.get(stepId) || [];
    return {
      step_id: stepId,
      kind: text(step.kind),
      description: text(step.description),
      count: recordIds.length,
      record_ids: recordIds,
    };
  });

  return {
    sequence: name,
    buckets,
    total_assigned: assignedIds.length,
    completed,
    awaiting_manual: awaitingManual,
    ...(steps.length === 0
      ? {
        empty_reason: resolved.kind === 'sequencer'
          ? `Sequence "${name}" is a traditional sequencer; this board shows nested pipeline steps only.`
          : `Sequence "${name}" has no nested pipeline steps.`,
      }
      : {}),
  };
};
