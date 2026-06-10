import type { RecordRow } from '../types.js';

export const NEUTRAL_PIN = '#8b93a7';
export const DESELECTED_PIN = '#cfd3dc';

export const rowKey = (record: RecordRow) => String(record._row_id ?? record.id ?? '');

export const scoreColor = (rank: number) => {
  const clamped = Math.max(0, Math.min(100, rank));
  return `hsl(${clamped * 1.2}, 75%, 48%)`;
};

export const recordScore = (record: RecordRow) => {
  const fitScore = record.fit_score === null || record.fit_score === undefined || record.fit_score === '' ? null : Number(record.fit_score);
  if (fitScore !== null && Number.isFinite(fitScore)) return fitScore;
  const priorityRank = record.priority_rank === null || record.priority_rank === undefined || record.priority_rank === '' ? null : Number(record.priority_rank);
  return priorityRank !== null && Number.isFinite(priorityRank) ? priorityRank : null;
};

export const hasScore = (record: RecordRow) =>
  recordScore(record) !== null;

export const pinColor = (record: RecordRow, deselected = false) => {
  if (deselected) return DESELECTED_PIN;
  if (!hasScore(record)) return NEUTRAL_PIN;
  return scoreColor(recordScore(record) || 0);
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
