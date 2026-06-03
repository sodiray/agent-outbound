import type { ActiveFilter, MetaResponse, RecordDetail, RecordsResponse, SortDir } from './types.js';

type RecordsParams = {
  sort: string;
  dir: SortDir;
  q: string;
  filters: ActiveFilter[];
};

export type ProgressRun = {
  run_id: string;
  phase: string;
  active_step: string;
  message: string;
  step_index: number;
  step_total: number;
  target_count: number;
  done_count: number;
  status: string;
  error: string;
  started_at: string;
  updated_at: string;
  age_ms: number | null;
};

export type ProgressResponse = { run: ProgressRun | null };

const getJson = async <T,>(path: string): Promise<T> => {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
};

export const fetchMeta = () => getJson<MetaResponse>('/api/meta');

export const fetchProgress = () => getJson<ProgressResponse>('/api/progress');

export const fetchRecords = ({ sort, dir, q, filters }: RecordsParams) => {
  const params = new URLSearchParams();
  params.set('sort', sort);
  params.set('dir', dir);
  params.set('limit', '500');
  if (q.trim()) params.set('q', q.trim());
  filters.forEach((filter) => {
    if ((filter.kind === 'enum' || filter.kind === 'boolean') && filter.value) {
      params.set(`filter.${filter.key}`, filter.value);
      return;
    }
    if (filter.kind === 'range') {
      if (filter.min) params.set(`filter.${filter.key}.min`, filter.min);
      if (filter.max) params.set(`filter.${filter.key}.max`, filter.max);
    }
  });
  return getJson<RecordsResponse>(`/api/records?${params.toString()}`);
};

export const fetchRecordDetail = (rowId: string) => getJson<RecordDetail>(`/api/records/${encodeURIComponent(rowId)}`);
