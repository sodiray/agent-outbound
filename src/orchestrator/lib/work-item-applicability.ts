/**
 * Work-item applicability: decide when operator-facing artifacts (drafts,
 * parked manual tasks) are no longer applicable to a record.
 *
 * Two surfaces, one shape:
 * - Drafts queued for a sequence/pipeline the record has left
 * - Parked manual_task events for a step that now evaluates not-applicable
 *
 * Fail toward leaving the item alone when the signal is inconclusive. A stale
 * item is a nuisance; a wrongly-revoked one loses real work.
 *
 * This module is pure (no db writes). Callers stamp status=revoked on drafts
 * or write a later passed park event with `skipped:not_applicable:…`.
 * Nothing is deleted.
 */

import { isAffirmativeFlag } from '../policy/booleanish.js';
import { pipelineNameForRecord } from './sequence-resolution.js';
import {
  shouldRunForRecord,
  stepConfigForWhen,
  whenPredicateForStep,
} from './step-when.js';
import { stepSubpipelineName } from './subpipelines.js';

const text = (value: unknown) => String(value ?? '').trim();

/**
 * Clear-cut record-level reasons that no outbound work item is actionable.
 * Returns null when the record may still have legitimate queued work.
 *
 * @param opts.includeCompletedSequence — when false (draft path), a normally
 *   completed sequence does not revoke drafts. Successful last-step sends mark
 *   the sequence completed while the draft is still `ready`; revoking it then
 *   races the status=`sent` write. Parks still close on completed.
 */
export const recordTerminalWorkReason = (
  record: Record<string, unknown> | null | undefined,
  opts: { includeCompletedSequence?: boolean } = {},
): string | null => {
  if (!record) return null;
  const disqualifiedAt = text(record.disqualified_at);
  const lifecycle = text(record.lifecycle_stage).toLowerCase();
  if (disqualifiedAt || lifecycle === 'disqualified') return 'record_disqualified';

  if (isAffirmativeFlag(record.suppressed, { failClosed: true })) {
    const suppressionReason = text(record.suppressed_reason).toLowerCase();
    if (suppressionReason.includes('opt_out') || suppressionReason.includes('opt-out')) {
      return 'record_opted_out';
    }
    if (suppressionReason.includes('dnc') || suppressionReason.includes('do_not_contact')) {
      return 'record_dnc';
    }
    return 'record_suppressed';
  }

  const seqState = text(record.account_sequence_state || record.sequence_status).toLowerCase();
  if (seqState === 'cancelled') return 'sequence_terminal:cancelled';
  if (opts.includeCompletedSequence !== false && seqState === 'completed') {
    return 'sequence_terminal:completed';
  }

  return null;
};

/**
 * Whether a queued draft is still bound to a sequence/pipeline the record is in.
 *
 * Drafts carry `sequence_name` from the sequence or nested pipeline that created
 * them. Author-step approvals use channel `author_step` and are not sequence-
 * membership bound — leave them alone here.
 *
 * Inconclusive (empty draft sequence, or sentinel `pipeline`) → null (keep).
 */
export const draftLeftSequenceReason = ({
  draft,
  record,
}: {
  draft: Record<string, unknown>;
  record: Record<string, unknown>;
}): string | null => {
  const channel = text(draft.channel).toLowerCase();
  if (channel === 'author_step') return null;

  const draftSeq = text(draft.sequence_name);
  if (!draftSeq || draftSeq === 'pipeline') return null;

  const recordSeq = text(record.sequence_name) || 'default';
  const recordPipe = text(record.pipeline_name);
  if (draftSeq === recordSeq) return null;
  if (recordPipe && draftSeq === recordPipe) return null;

  return `left_sequence:${draftSeq}`;
};

/**
 * Why a draft should no longer be offered as approvable, or null if still OK.
 *
 * Does not treat sequence `completed` as a draft-revocation signal — that
 * state is written on the same success path that still needs to mark the
 * approved draft `sent`. Cancellation, suppression, and left-sequence still
 * revoke.
 */
export const draftInapplicabilityReason = ({
  draft,
  record,
}: {
  draft: Record<string, unknown>;
  record: Record<string, unknown>;
}): string | null => {
  const terminal = recordTerminalWorkReason(record, { includeCompletedSequence: false });
  if (terminal) return terminal;
  return draftLeftSequenceReason({ draft, record });
};

/**
 * Why a parked manual_task should no longer be offered, or null if still OK.
 *
 * Requires the step definition when config is supplied. Without config, only
 * record-terminal reasons can fire (we cannot re-evaluate when:/membership).
 *
 * When `config` is supplied but `step` is null/undefined, the step is treated
 * as undeclared (historical park for a removed step).
 */
export const manualParkInapplicabilityReason = ({
  record,
  step,
  config,
  listDir = '',
}: {
  record: Record<string, unknown>;
  /** Declared step, or null when config is present but step id is absent. */
  step?: Record<string, unknown> | null;
  config?: unknown;
  listDir?: string;
}): string | null => {
  // Parks close on completed/cancelled/suppressed — no race with a sent stamp.
  const terminal = recordTerminalWorkReason(record, { includeCompletedSequence: true });
  if (terminal) return terminal;

  // No config: cannot judge step membership / when. Leave park alone.
  if (config == null) return null;

  // Step gone from the pipeline — historical park for a removed step.
  // Still listed as undeclared (empty labels); operator skip remains the
  // tidy path. Fail toward leaving it alone rather than auto-closing.
  if (!step) return null;

  // Nested pipeline membership: record left the subpipeline that owns this step.
  const subpipeline = stepSubpipelineName(step);
  if (subpipeline) {
    const membership = pipelineNameForRecord({ config, record });
    if (membership !== subpipeline) {
      return `left_pipeline:${subpipeline}`;
    }
  }

  // when: gate re-evaluation against current record state.
  try {
    const predicate = whenPredicateForStep({
      step,
      stepConfig: stepConfigForWhen(step),
    });
    if (predicate) {
      const outcome = shouldRunForRecord({
        record,
        predicate,
        listDir,
      });
      if (!outcome.passed) {
        const detail = text(outcome.reason) || 'when_not_matched';
        if (detail.startsWith('when_not_matched')) return detail;
        if (detail.startsWith('skipped:')) {
          return `when_not_matched:${detail.slice('skipped:'.length)}`;
        }
        return `when_not_matched:${detail}`;
      }
    }
  } catch {
    // Inconclusive evaluation (missing inputs, bad predicate) → leave alone.
    return null;
  }

  return null;
};

/**
 * Normalize a short inapplicability reason into the park close event reason.
 */
export const manualParkCloseReason = (reason: string): string => {
  const r = text(reason);
  if (!r) return 'skipped:not_applicable';
  if (r.startsWith('skipped:not_applicable:')) return r;
  if (r.startsWith('skipped:')) return `skipped:not_applicable:${r.slice('skipped:'.length)}`;
  return `skipped:not_applicable:${r}`;
};
