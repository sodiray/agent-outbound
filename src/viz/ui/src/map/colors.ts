import type { RecordRow } from '../types.js';

export const NEUTRAL_PIN = '#8b93a7';
export const DESELECTED_PIN = '#cfd3dc';

export const rowKey = (record: RecordRow) => String(record._row_id ?? record.id ?? '');

// Map a score to a red→green hue. The gradient spans [floor, 100] rather than
// [0, 100] so that when the list is filtered to a high qualifying floor (e.g. 75+)
// the surviving scores still spread across the full color range — floor is red,
// 100 is green — instead of all bunching up at green. floor=0 reproduces the
// original 0→100 scale.
export const scoreColor = (rank: number, floor = 0) => {
  const clamped = Math.max(0, Math.min(100, rank));
  const base = Math.max(0, Math.min(99, floor));
  const span = Math.max(1, 100 - base);
  const t = Math.max(0, Math.min(1, (clamped - base) / span));
  return `hsl(${t * 120}, 75%, 48%)`;
};

// Color a value on its OWN red→green gradient, scaled to that value's own
// [0, max] range — so each criterion is colored relative to its own maximum,
// not a global scale. 0 → red, max → green.
export const ratioColor = (value: number, max: number) => {
  const span = max > 0 ? max : 1;
  const t = Math.max(0, Math.min(1, value / span));
  return `hsl(${t * 120}, 75%, 48%)`;
};

export const recordScore = (record: RecordRow) => {
  const fitScore = record.fit_score === null || record.fit_score === undefined || record.fit_score === '' ? null : Number(record.fit_score);
  if (fitScore !== null && Number.isFinite(fitScore)) return fitScore;
  const priorityRank = record.priority_rank === null || record.priority_rank === undefined || record.priority_rank === '' ? null : Number(record.priority_rank);
  return priorityRank !== null && Number.isFinite(priorityRank) ? priorityRank : null;
};

export const hasScore = (record: RecordRow) =>
  recordScore(record) !== null;

export const pinColor = (record: RecordRow, deselected = false, floor = 0) => {
  if (deselected) return DESELECTED_PIN;
  if (!hasScore(record)) return NEUTRAL_PIN;
  return scoreColor(recordScore(record) || 0, floor);
};

export const isLocated = (record: RecordRow) => {
  const lat = Number(record.latitude);
  const lng = Number(record.longitude);
  return Number.isFinite(lat)
    && Number.isFinite(lng)
    && !(lat === 0 && lng === 0)
    && record.latitude !== null
    && record.latitude !== ''
    && record.longitude !== null
    && record.longitude !== '';
};

export const pointOf = (record: RecordRow) => ({ lat: Number(record.latitude), lng: Number(record.longitude) });
