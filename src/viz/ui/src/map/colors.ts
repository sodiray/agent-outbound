import type { RecordRow } from '../types.js';

export const NEUTRAL_PIN = '#8b93a7';
export const DESELECTED_PIN = '#cfd3dc';

export const rowKey = (record: RecordRow) => String(record._row_id ?? record.id ?? '');

export const scoreColor = (rank: number) => {
  const clamped = Math.max(0, Math.min(100, rank));
  return `hsl(${clamped * 1.2}, 75%, 48%)`;
};

export const hasScore = (record: RecordRow) =>
  record.priority_rank !== null
  && record.priority_rank !== undefined
  && record.priority_rank !== ''
  && Number.isFinite(Number(record.priority_rank));

export const pinColor = (record: RecordRow, deselected = false) => {
  if (deselected) return DESELECTED_PIN;
  if (!hasScore(record)) return NEUTRAL_PIN;
  return scoreColor(Number(record.priority_rank));
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
