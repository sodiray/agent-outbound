import { getRecordRowId } from '../lib/record.js';

export type BatchOutcomeValue<Outcome> = Outcome | Error;

export type BatchLoaderOptions<RecordShape, Outcome> = {
  executor: (rows: RecordShape[]) => Promise<Map<string, BatchOutcomeValue<Outcome>>>;
  fallback: (record: RecordShape, cause: unknown) => Promise<Outcome>;
  getRecordId?: (record: RecordShape) => string;
  maxBatch?: number;
  windowMs?: number;
  inFlight?: () => number;
};

export type BatchLoader<RecordShape, Outcome> = {
  load: (record: RecordShape) => Promise<Outcome>;
  flush: () => Promise<void>;
  pendingCount: () => number;
};

type PendingRecord<RecordShape, Outcome> = {
  record: RecordShape;
  resolve: (outcome: Outcome) => void;
  reject: (error: unknown) => void;
};

const normalizeMaxBatch = (value: number | undefined) => Math.max(1, Math.floor(Number(value || 10)));

const normalizeWindowMs = (value: number | undefined) => Math.max(0, Math.floor(Number(value || 0)));

const isErrorValue = <Outcome>(value: BatchOutcomeValue<Outcome> | undefined): value is Error => value instanceof Error;

const resolveWithFallback = async <RecordShape, Outcome>({
  entry,
  fallback,
  cause,
}: {
  entry: PendingRecord<RecordShape, Outcome>;
  fallback: (record: RecordShape, cause: unknown) => Promise<Outcome>;
  cause: unknown;
}) => {
  try {
    entry.resolve(await fallback(entry.record, cause));
  } catch (error) {
    entry.reject(error);
  }
};

const scatterBatchResults = async <RecordShape, Outcome>({
  entries,
  results,
  fallback,
  getRecordId,
}: {
  entries: Array<PendingRecord<RecordShape, Outcome>>;
  results: Map<string, BatchOutcomeValue<Outcome>>;
  fallback: (record: RecordShape, cause: unknown) => Promise<Outcome>;
  getRecordId: (record: RecordShape) => string;
}) => {
  await Promise.all(entries.map(async (entry) => {
    const recordId = getRecordId(entry.record);
    if (!results.has(recordId)) {
      await resolveWithFallback({ entry, fallback, cause: 'batch_omitted_row' });
      return;
    }

    const result = results.get(recordId);
    if (isErrorValue(result)) {
      entry.reject(result);
      return;
    }

    entry.resolve(result as Outcome);
  }));
};

/**
 * Create one loader instance per pipeline step; callers then use load(record).
 */
export const createBatchLoader = <RecordShape = Record<string, unknown>, Outcome = unknown>({
  executor,
  fallback,
  getRecordId = (record: RecordShape) => String(getRecordRowId(record)),
  maxBatch,
  windowMs,
  inFlight,
}: BatchLoaderOptions<RecordShape, Outcome>): BatchLoader<RecordShape, Outcome> => {
  const state: {
    pending: Array<PendingRecord<RecordShape, Outcome>>;
    timer: ReturnType<typeof setTimeout> | undefined;
  } = {
    pending: [],
    timer: undefined,
  };
  const batchLimit = normalizeMaxBatch(maxBatch);
  const windowLimit = normalizeWindowMs(windowMs);

  const clearTimer = () => {
    if (!state.timer) return;
    clearTimeout(state.timer);
    state.timer = undefined;
  };

  const flush = async () => {
    const entries = state.pending;
    if (entries.length === 0) return;

    state.pending = [];
    clearTimer();

    try {
      const results = await executor(entries.map((entry) => entry.record));
      await scatterBatchResults({ entries, results, fallback, getRecordId });
    } catch (error) {
      await Promise.all(entries.map((entry) => resolveWithFallback({ entry, fallback, cause: error })));
    }
  };

  const flushSoon = () => {
    void flush();
  };

  const armTimer = () => {
    if (state.timer) return;
    state.timer = setTimeout(flushSoon, windowLimit);
  };

  const shouldFlushForQuiescence = () => {
    if (!inFlight) return false;
    const count = Number(inFlight());
    return count > 0 && state.pending.length >= count;
  };

  const scheduleFlush = () => {
    if (state.pending.length >= batchLimit) {
      flushSoon();
      return;
    }

    if (shouldFlushForQuiescence()) {
      flushSoon();
      return;
    }

    armTimer();
  };

  const load = (record: RecordShape) => new Promise<Outcome>((resolve, reject) => {
    state.pending = [...state.pending, { record, resolve, reject }];
    scheduleFlush();
  });

  return {
    load,
    flush,
    pendingCount: () => state.pending.length,
  };
};
