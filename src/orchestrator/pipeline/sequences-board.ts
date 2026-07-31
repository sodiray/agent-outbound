import { flattenPipelineSteps, stepSubpipelineName } from '../lib/subpipelines.js';

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
};

/**
 * Build a step-bucket board for a sub-pipeline (pipeline_name) or legacy sequence_name.
 * Counts are derived from pipeline_events + current assignment on records.
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
  const steps = flattenPipelineSteps(config)
    .filter((step: any) => {
      const sub = stepSubpipelineName(step);
      if (sub) return sub === name;
      // Top-level sequence steps don't apply for pipeline_name routing.
      return false;
    });

  // Prefer sub-pipeline assignment; fall back to sequence_name for legacy.
  const assignedCount = db.prepare(`
    SELECT COUNT(*) AS n FROM records
    WHERE COALESCE(pipeline_name, '') = ?
       OR (COALESCE(pipeline_name, '') IN ('', 'default') AND COALESCE(sequence_name, 'default') = ?)
  `).get(name, name);

  const buckets: SequenceBoardBucket[] = steps.map((step: any) => {
    const stepId = text(step.id);
    const kind = text(step.kind);
    // Latest event for this step among records assigned to this sequence.
    const rows = db.prepare(`
      WITH assigned AS (
        SELECT _row_id AS record_id
        FROM records
        WHERE COALESCE(pipeline_name, '') = ?
           OR (COALESCE(pipeline_name, '') IN ('', 'default') AND COALESCE(sequence_name, 'default') = ?)
      ),
      latest AS (
        SELECT e.record_id, e.passed, e.reason, e.occurred_at,
               ROW_NUMBER() OVER (PARTITION BY e.record_id ORDER BY e.occurred_at DESC) AS rn
        FROM pipeline_events e
        JOIN assigned a ON a.record_id = e.record_id
        WHERE e.step_id = ?
      )
      SELECT record_id, passed, reason
      FROM latest
      WHERE rn = 1
        AND (
          (passed = 1)
          OR (passed = 0 AND reason IN ('awaiting_manual', 'awaiting_review', 'wake_at'))
        )
      LIMIT ?
    `).all(name, name, stepId, Math.max(1, Number(limitPerBucket) || 50));

    // For "current position" view: include only records whose furthest progressed
    // incomplete step is this one, or who last completed this step and have no further.
    const recordIds = rows.map((row: any) => text(row.record_id)).filter(Boolean);
    return {
      step_id: stepId,
      kind,
      description: text(step.description),
      count: recordIds.length,
      record_ids: recordIds,
    };
  });

  const awaitingManual = db.prepare(`
    SELECT COUNT(DISTINCT e.record_id) AS n
    FROM pipeline_events e
    JOIN records r ON r._row_id = e.record_id
    WHERE e.kind = 'manual_task' AND e.passed = 0 AND e.reason = 'awaiting_manual'
      AND (COALESCE(r.pipeline_name, '') = ? OR COALESCE(r.sequence_name, 'default') = ?)
  `).get(name, name);

  return {
    sequence: name,
    buckets,
    total_assigned: Number(assignedCount?.n || 0),
    completed: 0,
    awaiting_manual: Number(awaitingManual?.n || 0),
  };
};

export const listConfiguredSequences = ({ config }: { config: any }) => {
  const fromPipeline = flattenPipelineSteps(config)
    .map((step: any) => stepSubpipelineName(step))
    .filter(Boolean);
  const fromSequences = Object.keys(config?.sequences || {});
  return [...new Set([...fromPipeline, ...fromSequences])].filter(Boolean).sort();
};
