import type { MouseEvent } from 'react';
import { clearReviewDecision, submitReviewDecisions } from './api.js';
import type { RecordRow } from './types.js';

// Review decision and undo for the Review page (/review). Both go through POST
// /api/review/:stage/decisions and DELETE /api/review/decisions/:row, which run
// the CLI's own `review approve|reject|clear` commands.

export type ReviewActionVerdict = 'approve' | 'reject';

const DEFAULT_REJECT_REASON = 'reviewed: not a fit';

export const actionLabel = (verdict: ReviewActionVerdict) => verdict === 'approve' ? 'Approve' : 'Reject';
export const actionPastTense = (verdict: ReviewActionVerdict) => verdict === 'approve' ? 'Approved' : 'Rejected';
export const actionInProgress = (verdict: ReviewActionVerdict) => verdict === 'approve' ? 'Approving' : 'Rejecting';

// Review shortcuts never fire while the operator is typing, or while focus sits
// on a control whose own activation the key would duplicate.
export const isReviewTypingTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable
    || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
    || Boolean(target.closest('.close-button, .scrim, .review-undo, .review-detail-undo'));
};

// Space and Enter activate a focused button (Enter also a focused link)
// themselves, so on one they are that control's key, not a review shortcut.
export const isReviewActivationTarget = (target: EventTarget | null, key: string) => {
  if (!(target instanceof HTMLElement) || (key !== ' ' && key !== 'Enter')) return false;
  const controls = 'button, [role="button"], [role="tab"], summary';
  return Boolean(target.closest(key === 'Enter' ? `${controls}, a[href]` : controls));
};

// A pointer click leaves focus on the clicked button, which would then take
// Space / Enter for itself; releasing it keeps those keys on their review
// shortcuts. Keyboard activation (detail 0) keeps focus where the operator put it.
export const releasePointerFocus = (event: MouseEvent<HTMLElement>) => {
  if (event.detail > 0) event.currentTarget.blur();
};

// Applies one decision and resolves only when the server applied it. A reject
// carries the standard review reason; the page has no reason or edit fields.
export const submitReviewVerdict = async ({
  stageId,
  rowId,
  verdict,
}: {
  stageId: string;
  rowId: string;
  verdict: ReviewActionVerdict;
}) => {
  const response = await submitReviewDecisions(stageId, [{
    row_id: rowId,
    verdict,
    reason: verdict === 'reject' ? DEFAULT_REJECT_REASON : undefined,
  }]);
  const result = response.results[0];
  if (!result?.ok) throw new Error(String(result?.error || 'The decision was not applied.'));
  return result;
};

export const undoReviewVerdict = ({ stageId, rowId }: { stageId: string; rowId: string }) => (
  clearReviewDecision(stageId, rowId)
);

// Puts an undone record back at its original position in a queue snapshot.
export const restoreRecordInOrder = ({
  records,
  record,
  order,
  keyOf,
}: {
  records: RecordRow[];
  record: RecordRow;
  order: string[];
  keyOf: (record: RecordRow) => string;
}) => {
  if (records.some((candidate) => keyOf(candidate) === keyOf(record))) return records;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...records, record].sort((left, right) => (
    (rank.get(keyOf(left)) ?? Number.MAX_SAFE_INTEGER)
    - (rank.get(keyOf(right)) ?? Number.MAX_SAFE_INTEGER)
  ));
};
