import type {
  ActiveFilter,
  MetaResponse,
  RecordDetail,
  RecordsResponse,
  ReviewDecisionBatchResponse,
  ReviewDecisionInput,
  ReviewQueueResponse,
  SortDir,
} from './types.js';

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

const requestJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) {
    throw new Error(String(payload?.error || `Request failed: ${response.status}`));
  }
  return payload as T;
};

const getJson = <T,>(path: string) => requestJson<T>(path);

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

const fetchReviewQueuePage = (stageId: string, offset: number) => {
  const params = new URLSearchParams({ limit: '500', offset: String(offset) });
  return getJson<ReviewQueueResponse>(`/api/review/${encodeURIComponent(stageId)}?${params.toString()}`);
};

export const fetchReviewQueue = async (stageId: string): Promise<ReviewQueueResponse> => {
  const collect = async (offset: number, records: ReviewQueueResponse['records']): Promise<ReviewQueueResponse> => {
    const page = await fetchReviewQueuePage(stageId, offset);
    const nextRecords = [...records, ...page.records];
    if (nextRecords.length >= page.total || page.records.length === 0) {
      return { ...page, limit: nextRecords.length, offset: 0, records: nextRecords };
    }
    return collect(offset + page.records.length, nextRecords);
  };
  return collect(0, []);
};

export const submitReviewDecisions = (stageId: string, decisions: ReviewDecisionInput[]) => requestJson<ReviewDecisionBatchResponse>(
  `/api/review/${encodeURIComponent(stageId)}/decisions`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decisions }),
  },
);

export const clearReviewDecision = (stageId: string, rowId: string) => {
  const params = new URLSearchParams({ stage: stageId });
  return requestJson<Record<string, unknown>>(
    `/api/review/decisions/${encodeURIComponent(rowId)}?${params.toString()}`,
    { method: 'DELETE' },
  );
};
