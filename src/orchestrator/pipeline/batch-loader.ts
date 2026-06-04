import { getRecordRowId } from '../lib/record.js';

export type BatchOutcomeValue<Outcome> = Outcome | Error;

export type BatchLoaderOptions<RecordShape, Outcome> = {
  executor: (rows: RecordShape[]) => Promise<Map<string, BatchOutcomeValue<Outcome>>>;
  fallback: (record: RecordShape, cause: unknown) => Promise<Outcome>;
  getRecordId?: (record: RecordShape) => string;
  maxBatch?: number;
  windowMs?: number;
  quiescenceGraceMs?: number;
  inFlight?: () => number;
  onFlush?: (info: { size: number; reason: 'size' | 'time' | 'quiescence'; first_enqueued_at: string; wait_ms: number; exec_ms: number; occurred_at: string }) => void | Promise<void>;
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

const normalizeQuiescenceGraceMs = (value: number | undefined, windowMs: number) => {
  if (value !== undefined) return Math.max(0, Math.floor(Number(value || 0)));
  if (windowMs <= 0) return 0;
  return Math.min(windowMs, 100);
};

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
  quiescenceGraceMs,
  inFlight,
  onFlush,
}: BatchLoaderOptions<RecordShape, Outcome>): BatchLoader<RecordShape, Outcome> => {
  const state: {
    pending: Array<PendingRecord<RecordShape, Outcome>>;
    timer: ReturnType<typeof setTimeout> | undefined;
    quiescenceTimer: ReturnType<typeof setTimeout> | undefined;
    firstEnqueuedAt: number;
    lastPendingChangeAt: number;
  } = {
    pending: [],
    timer: undefined,
    quiescenceTimer: undefined,
    firstEnqueuedAt: 0,
    lastPendingChangeAt: 0,
  };
  const batchLimit = normalizeMaxBatch(maxBatch);
  const windowLimit = normalizeWindowMs(windowMs);
  const quiescenceGraceLimit = normalizeQuiescenceGraceMs(quiescenceGraceMs, windowLimit);

  const clearTimer = () => {
    if (!state.timer) return;
    clearTimeout(state.timer);
    state.timer = undefined;
  };

  const clearQuiescenceTimer = () => {
    if (!state.quiescenceTimer) return;
    clearTimeout(state.quiescenceTimer);
    state.quiescenceTimer = undefined;
  };

  const notifyFlush = async ({ size, reason, firstEnqueuedAt, waitMs, execMs }: { size: number; reason: 'size' | 'time' | 'quiescence'; firstEnqueuedAt: number; waitMs: number; execMs: number }) => {
    if (!onFlush) return;
    const occurredAt = new Date().toISOString();
    await onFlush({
      size,
      reason,
      first_enqueued_at: new Date(firstEnqueuedAt).toISOString(),
      wait_ms: Math.max(0, waitMs),
      exec_ms: Math.max(0, execMs),
      occurred_at: occurredAt,
    });
  };

  const flush = async (reason: 'size' | 'time' | 'quiescence' = 'quiescence') => {
    const entries = state.pending;
    if (entries.length === 0) return;

    const firstEnqueuedAt = state.firstEnqueuedAt || Date.now();
    state.pending = [];
    state.firstEnqueuedAt = 0;
    state.lastPendingChangeAt = 0;
    clearTimer();
    clearQuiescenceTimer();
    const execStartedAt = Date.now();
    const waitMs = execStartedAt - firstEnqueuedAt;

    try {
      const results = await executor(entries.map((entry) => entry.record));
      await notifyFlush({ size: entries.length, reason, firstEnqueuedAt, waitMs, execMs: Date.now() - execStartedAt });
      await scatterBatchResults({ entries, results, fallback, getRecordId });
    } catch (error) {
      await notifyFlush({ size: entries.length, reason, firstEnqueuedAt, waitMs, execMs: Date.now() - execStartedAt });
      await Promise.all(entries.map((entry) => resolveWithFallback({ entry, fallback, cause: error })));
    }
  };

  const flushSoon = (reason: 'size' | 'time' | 'quiescence') => {
    void flush(reason);
  };

  const armTimer = () => {
    if (state.timer) return;
    state.timer = setTimeout(() => flushSoon('time'), windowLimit);
  };

  const shouldFlushForQuiescence = () => {
    if (!inFlight) return false;
    const count = Number(inFlight());
    return count > 0 && state.pending.length >= count;
  };

  const armQuiescenceTimer = () => {
    clearQuiescenceTimer();
    state.quiescenceTimer = setTimeout(() => {
      state.quiescenceTimer = undefined;
      const stableForMs = Date.now() - state.lastPendingChangeAt;
      if (stableForMs >= quiescenceGraceLimit && shouldFlushForQuiescence()) {
        flushSoon('quiescence');
      }
    }, quiescenceGraceLimit);
  };

  const scheduleFlush = () => {
    if (state.pending.length >= batchLimit) {
      flushSoon('size');
      return;
    }

    armTimer();

    if (shouldFlushForQuiescence()) {
      armQuiescenceTimer();
    }
  };

  const load = (record: RecordShape) => new Promise<Outcome>((resolve, reject) => {
    if (state.pending.length === 0) state.firstEnqueuedAt = Date.now();
    state.lastPendingChangeAt = Date.now();
    state.pending = [...state.pending, { record, resolve, reject }];
    scheduleFlush();
  });

  return {
    load,
    flush,
    pendingCount: () => state.pending.length,
  };
};
