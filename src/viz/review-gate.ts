// Pure decision gate for the Review page. A review approval can enrol a real
// person in a live campaign, so a decision must target exactly the record the
// operator is looking at. The UI imports these; the root build compiles them so
// tests can pin them without a DOM.

// A decision made on the Review page, as its undo history records it.
export type ReviewHistoryEntry = { stage_id: string; row_id: string };

export type ReviewShortcut = 'approve' | 'reject' | 'undo' | 'previous' | 'next' | null;

// A decision is possible only when the record whose detail is on screen is the
// record the decision targets, that detail has finished loading, the target is
// in the loaded queue (awaiting this stage), and no decision or undo is in
// flight.
export const canDecide = ({
  detailRowId,
  targetRowId,
  loading,
  busy,
  awaiting,
}: {
  detailRowId: string;
  targetRowId: string;
  loading: boolean;
  busy: boolean;
  awaiting: boolean;
}) => Boolean(targetRowId)
  && detailRowId === targetRowId
  && !loading
  && !busy
  && awaiting;

// Undo always reverses the latest history entry at the stage and record it was
// made on, never the current selection.
export const undoTargetFor = <Entry extends ReviewHistoryEntry>(history: readonly Entry[]): Entry | null => (
  history.at(-1) ?? null
);

// Maps a keydown to a Review page shortcut: J / K or ↓ / ↑ move, Space / Enter
// approve, X rejects, U undoes. Held keys auto-repeat; a repeat never decides
// or undoes, it only moves. Space and Enter on a focused control (`onControl`)
// belong to that control, so they never approve whatever row is selected.
export const reviewShortcut = ({
  key,
  repeat,
  modified,
  typing,
  onControl,
}: {
  key: string;
  repeat: boolean;
  modified: boolean;
  typing: boolean;
  onControl: boolean;
}): ReviewShortcut => {
  if (modified || typing) return null;
  const lower = key.toLowerCase();
  if (lower === 'j' || key === 'ArrowDown') return 'next';
  if (lower === 'k' || key === 'ArrowUp') return 'previous';
  if (repeat) return null;
  if (key === ' ' || key === 'Enter') return onControl ? null : 'approve';
  if (lower === 'x') return 'reject';
  if (lower === 'u') return 'undo';
  return null;
};
