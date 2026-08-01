import type {
  ActiveFilter,
  MetaResponse,
  RecordDetail,
  RecordsResponse,
  RejectedRecordsResponse,
  RejectedRestoreResponse,
  RejectedSourcesResponse,
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

export const fetchRejectedSources = () => getJson<RejectedSourcesResponse>('/api/rejected/sources');

export const fetchRejectedRecords = ({
  source = '',
  limit = 50,
  offset = 0,
}: {
  source?: string;
  limit?: number;
  offset?: number;
}) => {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (source) params.set('source', source);
  return getJson<RejectedRecordsResponse>(`/api/rejected?${params.toString()}`);
};

export const restoreRejectedRecord = (rowId: string) => requestJson<RejectedRestoreResponse>(
  `/api/rejected/${encodeURIComponent(rowId)}/restore`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  },
);

export type SequenceSummary = {
  name: string;
  step_count: number;
  manual?: boolean;
  description?: string;
};

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

export type ManualTask = {
  record_id: string;
  step_id: string;
  task_type: string;
  business_name: string;
  address: string;
  contact_name: string;
  contact_email: string;
  sequence_name: string;
  pipeline_name: string;
  parked_at: string;
  reason: string;
};

export const fetchSequences = async () => {
  const payload = await getJson<{
    ok?: boolean;
    sequences?: Array<SequenceSummary | string>;
    error?: string;
  }>('/api/sequences');
  if (payload.ok === false) throw new Error(String(payload.error || 'Failed to load sequences'));
  const raw = Array.isArray(payload.sequences) ? payload.sequences : [];
  return raw.map((item): SequenceSummary => {
    if (typeof item === 'string') {
      return { name: item, step_count: 0 };
    }
    return {
      name: String(item.name || ''),
      step_count: Number(item.step_count || 0),
      manual: Boolean(item.manual),
      description: item.description || '',
    };
  }).filter((item) => item.name);
};

export const fetchSequenceBoard = async (name: string) => {
  const payload = await getJson<{ ok?: boolean; board?: SequenceBoard; error?: string }>(
    `/api/sequences/${encodeURIComponent(name)}/board`,
  );
  if (payload.ok === false || !payload.board) {
    throw new Error(String(payload.error || 'Failed to load sequence board'));
  }
  return payload.board;
};

export const fetchManualTasks = async ({
  type = '',
  limit = 100,
  offset = 0,
}: {
  type?: string;
  limit?: number;
  offset?: number;
} = {}) => {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (type) params.set('type', type);
  const payload = await getJson<{
    ok?: boolean;
    total?: number;
    tasks?: ManualTask[];
    error?: string;
  }>(`/api/manual?${params.toString()}`);
  if (payload.ok === false) throw new Error(String(payload.error || 'Failed to load manual tasks'));
  return {
    total: Number(payload.total || 0),
    tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
  };
};

export const completeManualTask = ({
  rowId,
  stepId,
  note = '',
  skip = false,
}: {
  rowId: string;
  stepId: string;
  note?: string;
  skip?: boolean;
}) => requestJson<{ ok?: boolean; error?: string; record_id?: string; step_id?: string }>(
  `/api/manual/${encodeURIComponent(rowId)}/complete`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step_id: stepId, note, skip }),
  },
);
