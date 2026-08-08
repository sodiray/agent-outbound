import { randomUUID } from 'node:crypto';
import { readConfig } from '../lib/config.js';
import { validatePipelineGraph } from '../lib/pipeline-graph.js';
import { avgStepCostUsd } from '../lib/costs.js';
import { getRecordRowId, nowIso } from '../lib/record.js';
import { assertPhaseModelReferences } from '../lib/model-validation.js';
import { prepareFieldCheckValueFiles } from '../lib/field-check-values.js';
import { countEnrichWorkForStep, enrichmentStepNeedsMcp, readStaleness, writeStaleness } from '../enrichment/runner.js';
import { closeMcpClient, getMcpClient } from '../runtime/mcp.js';
import { readToolCatalog } from '../lib/tool-catalog.js';
import { formatErrorMessage } from '../lib/error-format.js';
import { emitActivity } from '../runtime/activity.js';
import { beginRun, endRun, heartbeat, tickProgress } from '../runtime/progress.js';
import { hasPassedStep, inPlayWhere, insertPipelineEvent, logPipelineEvent, openListDb, overridesByRecordMap, reconcileFieldOverrides, reconcileOverrides } from '../runtime/db.js';
import { resolveWorkingDayConfig } from '../lib/working-days.js';
import {
  flattenPipelineSteps,
  holdingSubpipelineNames,
  stepSubpipelineName,
} from '../lib/subpipelines.js';
import { createBatchLoader } from './batch-loader.js';
import { executeStepBatch, type StepExecutionOutcome } from './step-executor.js';
import { isSkippedWhenOutcome } from '../lib/step-when.js';
import { computeWaitWakeAt } from './sequence-step-runtime.js';
import { countAwaitingReviewRecords } from './review.js';
import {
  pipelineStepId,
  filterDefHash,
  filterStalenessStepId,
  isFilterDefFresh,
  readInPlayRows,
  simulatePipeline,
  writeFilterFailure,
} from './shared.js';
import {
  assignmentDepHash,
  assignmentStalenessStepId,
  isAssignmentFresh,
} from './assignment-staleness.js';
import {
  assertListAccessForMutation,
  filterRecordsForCanary,
  loadCanaryConfig,
} from '../policy/canary-isolation.js';

type DataflowRecord = Record<string, any>;

type DataflowStep = {
  id: string;
  index: number;
  step: any;
  kind: string;
  tier: number;
  cost: number;
  dropGate: boolean;
  deps: string[];
  executable: boolean;
};

type RecordState = {
  record: DataflowRecord;
  resolved: Set<string>;
  pending: Set<string>;
  errored: Set<string>;
  status: { dropped: boolean };
};

type SchedulerState = {
  activeAdvancers: number;
  maxActiveAdvancers: number;
  completedOrder: string[];
  waiters: Array<(release: () => void) => void>;
};

export type DataflowCoreSummary = {
  completed_order: string[];
  max_active_advancers: number;
};

type DataflowCoreOptions = {
  records: DataflowRecord[];
  steps: DataflowStep[];
  concurrency: number;
  initialResolvedByRecord?: Map<string, Set<string>>;
  isApplicable?: (recordState: RecordState, step: DataflowStep) => boolean;
  isTimeReady: (recordState: RecordState, step: DataflowStep) => boolean;
  onStepOutcome: (recordState: RecordState, step: DataflowStep, outcome: StepExecutionOutcome) => Promise<{ record?: DataflowRecord; dropped?: boolean; resolved?: boolean; errored?: boolean }>;
  loadStep: (step: DataflowStep, record: DataflowRecord, inFlight: () => number) => Promise<StepExecutionOutcome>;
};

const stringArray = (value: unknown) => Array.isArray(value)
  ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
  : [];

const stepTier = (step: any) => {
  const kind = String(step?.kind || '').trim().toLowerCase();
  if (kind === 'assign') {
    const rules = Array.isArray(step?.rules) ? step.rules : [];
    return rules.some((rule: any) => String(rule?.type || 'field_check').trim().toLowerCase() === 'semantic') ? 1 : 0;
  }
  if ((kind === 'filter' || kind === 'exit') && String(step?.type || 'semantic').trim().toLowerCase() === 'field_check') return 0;
  if (kind === 'review') return 1;
  if (kind === 'filter' || kind === 'exit') return 1;
  if (kind === 'enrich') return 2;
  return 3;
};

const stepBatchSize = (step: any) => Math.max(1, Math.floor(Number(step?.batch_size || 10)));

const PIPELINE_ACTION_KINDS = new Set(['send_email', 'send_sms', 'linkedin_connect', 'manual_task']);

const stepBatchWindowMs = (step: any) => {
  const configured = Number(step?.batch_window_ms ?? step?.window_ms);
  if (Number.isFinite(configured) && configured >= 0) return Math.floor(configured);
  return stepTier(step) === 0 ? 0 : 150;
};

const largestBatchSize = (steps: DataflowStep[]) => Math.max(1, ...steps.map((entry) => stepBatchSize(entry.step)));

const buildSteps = ({ db, steps }: { db?: any; steps: any[] }): DataflowStep[] => steps.map((step, index) => {
  const id = pipelineStepId(step, index);
  const kind = String(step?.kind || '').trim().toLowerCase();
  const reviewDeps = steps
    .flatMap((candidate, candidateIndex) => (
      candidateIndex < index
      && String(candidate?.kind || '').trim().toLowerCase() === 'review'
      && (
        !stepSubpipelineName(candidate)
        || stepSubpipelineName(candidate) === stepSubpipelineName(step)
      )
        ? [pipelineStepId(candidate, candidateIndex)]
        : []
    ));
  return {
    id,
    index,
    step,
    kind,
    tier: stepTier(step),
    cost: kind === 'review' ? 0 : (db ? avgStepCostUsd({ db, stepId: id }) : Number(step?.cost || 0)),
    dropGate: kind === 'review'
      || kind === 'exit'
      || (kind === 'filter' && String(step?.on_fail || 'drop').trim().toLowerCase() !== 'flag'),
    deps: [...new Set([...stringArray(step?.depends_on), ...stringArray(step?.runs_after), ...reviewDeps])],
    executable: (() => {
      // generate is executable on the normal path when selected by selectDataflowSteps
      // (critical-path / AO_RUN_GENERATE / run_in_pipeline / fixture).
      const base = ['filter', 'enrich', 'extract', 'compose', 'assign', 'review', 'wait', 'send_email', 'send_sms', 'linkedin_connect', 'manual_task', 'exit', 'generate'];
      // Deterministic pipeline fixture mode also executes sourcing-like kinds via fixtures.
      if (String(process.env.AO_PIPELINE_FIXTURE || '').trim() === '1') {
        return [...base, 'geo_tiles', 'linkedin_profile_search', 'pipeline'].includes(kind);
      }
      return base.includes(kind);
    })(),
  };
});

const envFlag = (name: string) => String(process.env[name] || '').trim() === '1';

/**
 * Generate steps that non-generate pipeline steps (transitively) depend on.
 * e.g. a policy application step → a required generated dependency.
 */
export const criticalPathGenerateIds = (
  steps: Array<{ id: string; kind: string; deps: string[] }>,
): Set<string> => {
  const byId = new Map(steps.map((entry) => [entry.id, entry]));
  const critical = new Set<string>();
  for (const entry of steps) {
    if (entry.kind === 'generate') continue;
    for (const dep of entry.deps) {
      if (byId.get(dep)?.kind === 'generate') critical.add(dep);
    }
  }
  // Pull in generate→generate prerequisites of critical generates.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...critical]) {
      const step = byId.get(id);
      if (!step) continue;
      for (const dep of step.deps) {
        if (byId.get(dep)?.kind === 'generate' && !critical.has(dep)) {
          critical.add(dep);
          changed = true;
        }
      }
    }
  }
  return critical;
};

/**
 * Whether a step stays in the dataflow step list.
 *
 * Non-generate always kept.
 *
 * Generate policy (production-first; fixtures only for $0 tests):
 * - **Critical path** (depended on transitively by any non-generate step, e.g.
 *   a generated dependency feeding a policy application): always on the normal path.
 *   Never requires AO_PIPELINE_FIXTURE.
 * - **Honest opt-in** (`run_in_pipeline: true` on the step or step.config):
 *   e.g. a configured generated asset — runs on production dataflow without
 *   AO_RUN_GENERATE, still subject to its `when:` gate (A/B/C only).
 * - **AO_RUN_GENERATE=1**: include every generate (expensive asset packs too).
 * - **AO_PIPELINE_FIXTURE=1**: full generate graph with deterministic fixtures.
 * - Otherwise deferred (not hidden from config — simply not selected for this run).
 */
export const includeStepInDataflow = ({
  step,
  criticalGenerateIds,
  pipelineFixture = envFlag('AO_PIPELINE_FIXTURE'),
  runGenerate = envFlag('AO_RUN_GENERATE'),
}: {
  step: { kind: string; id: string; step?: any };
  criticalGenerateIds: Set<string>;
  pipelineFixture?: boolean;
  runGenerate?: boolean;
}): boolean => {
  if (step.kind !== 'generate') return true;
  if (pipelineFixture || runGenerate) return true;
  if (criticalGenerateIds.has(step.id)) return true;
  const raw = step.step || {};
  if (raw.run_in_pipeline === true) return true;
  if (raw.config && typeof raw.config === 'object' && raw.config.run_in_pipeline === true) return true;
  return false;
};

export const selectDataflowSteps = (steps: DataflowStep[]): DataflowStep[] => {
  const criticalGenerateIds = criticalPathGenerateIds(steps);
  return steps.filter((step) => includeStepInDataflow({ step, criticalGenerateIds }));
};

const compareCost = (a: DataflowStep, b: DataflowStep) => (
  a.tier - b.tier
  || a.cost - b.cost
  || a.index - b.index
);

const defaultApplicable = (recordState: RecordState, step: DataflowStep) => (
  !recordState.status.dropped
  && recordState.errored.size === 0
  && step.executable
  && !recordState.resolved.has(step.id)
  && !recordState.pending.has(step.id)
  && !recordState.errored.has(step.id)
);

const dataReady = (recordState: RecordState, step: DataflowStep, applicable: (recordState: RecordState, step: DataflowStep) => boolean) => (
  applicable(recordState, step)
  && step.deps.every((dep) => recordState.resolved.has(dep))
);

export const timeReady = ({
  recordState,
  step,
  applicable,
  isTimeReady,
}: {
  recordState: RecordState;
  step: DataflowStep;
  applicable: (recordState: RecordState, step: DataflowStep) => boolean;
  isTimeReady: (recordState: RecordState, step: DataflowStep) => boolean;
}) => dataReady(recordState, step, applicable) && isTimeReady(recordState, step);

const economicallyReady = ({
  recordState,
  step,
  steps,
  applicable,
  isTimeReady,
}: {
  recordState: RecordState;
  step: DataflowStep;
  steps: DataflowStep[];
  applicable: (recordState: RecordState, step: DataflowStep) => boolean;
  isTimeReady: (recordState: RecordState, step: DataflowStep) => boolean;
}) => {
  if (!timeReady({ recordState, step, applicable, isTimeReady })) return false;
  return !steps.some((candidate) => (
    candidate.dropGate
    && !recordState.resolved.has(candidate.id)
    && (
      recordState.pending.has(candidate.id)
      || timeReady({ recordState, step: candidate, applicable, isTimeReady })
    )
    && compareCost(candidate, step) < 0
  ));
};

const nextStep = ({
  recordState,
  steps,
  applicable,
  isTimeReady,
}: {
  recordState: RecordState;
  steps: DataflowStep[];
  applicable: (recordState: RecordState, step: DataflowStep) => boolean;
  isTimeReady: (recordState: RecordState, step: DataflowStep) => boolean;
}) => steps
  .filter((step) => economicallyReady({
    recordState,
    step,
    steps,
    applicable,
    isTimeReady,
  }))
  .sort(compareCost)[0] || null;

const withAdvancePermit = async <T>(state: SchedulerState, limit: number, task: () => Promise<T>): Promise<T> => {
  const release = await acquireAdvancePermit(state, limit);
  try {
    return await task();
  } finally {
    release();
  }
};

const acquireAdvancePermit = async (state: SchedulerState, limit: number) => {
  const reserve = () => {
    state.activeAdvancers += 1;
    state.maxActiveAdvancers = Math.max(state.maxActiveAdvancers, state.activeAdvancers);
    const release = () => {
      const next = state.waiters.shift();
      if (next) {
        next(release);
        return;
      }
      state.activeAdvancers -= 1;
    };
    return release;
  };
  if (state.activeAdvancers < limit && state.waiters.length === 0) return reserve();
  return new Promise<() => void>((resolve) => {
    state.waiters = [...state.waiters, resolve];
  });
};

const withAdvancePermitImmediate = async <T>(state: SchedulerState, limit: number, task: () => T): Promise<T> => {
  const release = await acquireAdvancePermit(state, limit);
  try {
    return task();
  } finally {
    release();
  }
};

export const runDataflowCore = async ({
  records,
  steps,
  concurrency,
  initialResolvedByRecord = new Map<string, Set<string>>(),
  isApplicable = defaultApplicable,
  isTimeReady,
  onStepOutcome,
  loadStep,
}: DataflowCoreOptions): Promise<DataflowCoreSummary> => {
  const state: SchedulerState = {
    activeAdvancers: 0,
    maxActiveAdvancers: 0,
    completedOrder: [],
    waiters: [],
  };
  const resolvedByRecord = new Map<string, Set<string>>();
  const pendingByRecord = new Map<string, Set<string>>();
  const erroredByRecord = new Map<string, Set<string>>();
  const statusByRecord = new Map<string, { dropped: boolean }>();
  const sharedSet = (sets: Map<string, Set<string>>, id: string, initial?: Set<string>) => {
    const existing = sets.get(id);
    if (existing) return existing;
    const created = new Set<string>(initial || []);
    sets.set(id, created);
    return created;
  };
  const sharedStatus = (id: string) => {
    const existing = statusByRecord.get(id);
    if (existing) return existing;
    const created = { dropped: false };
    statusByRecord.set(id, created);
    return created;
  };
  const recordStates = records.map((record) => ({
    record,
    resolved: sharedSet(resolvedByRecord, getRecordRowId(record), initialResolvedByRecord.get(getRecordRowId(record))),
    pending: sharedSet(pendingByRecord, getRecordRowId(record)),
    errored: sharedSet(erroredByRecord, getRecordRowId(record)),
    status: sharedStatus(getRecordRowId(record)),
  }));
  const advance = async (recordState: RecordState): Promise<void> => {
    const selected = await withAdvancePermit(state, concurrency, async () => {
      const candidate = nextStep({
        recordState,
        steps,
        applicable: isApplicable,
        isTimeReady,
      });
      if (candidate) recordState.pending.add(candidate.id);
      return candidate;
    });
    if (!selected) {
      if (process.env.AO_DATAFLOW_DEBUG === '1') {
        const rid = getRecordRowId(recordState.record);
        const why = steps.map((candidate) => {
          const reasons: string[] = [];
          if (recordState.status.dropped) reasons.push('record_dropped');
          if (recordState.errored.size > 0) reasons.push(`record_errored:${[...recordState.errored].join('|')}`);
          if (!candidate.executable) reasons.push('not_executable');
          if (recordState.resolved.has(candidate.id)) reasons.push('already_resolved');
          if (recordState.pending.has(candidate.id)) reasons.push('pending');
          const unmet = candidate.deps.filter((dep) => !recordState.resolved.has(dep));
          if (unmet.length) reasons.push(`deps_unresolved:${unmet.join('|')}`);
          return `${candidate.id}=${reasons.length ? reasons.join(',') : 'ELIGIBLE?'}`;
        });
        process.stderr.write(`[dataflow-debug] ${rid}\n  ${why.join('\n  ')}\n`);
      }
      state.completedOrder = [...state.completedOrder, getRecordRowId(recordState.record)];
      return;
    }
    const outcomePromise = await withAdvancePermitImmediate(state, concurrency, () => loadStep(selected, recordState.record, () => state.activeAdvancers));
    const persisted = await withAdvancePermit(state, concurrency, async () => onStepOutcome(recordState, selected, outcomePromise));
    recordState.pending.delete(selected.id);
    if (persisted.errored) recordState.errored.add(selected.id);
    recordState.record = persisted.record || recordState.record;
    if (persisted.resolved !== false) recordState.resolved.add(selected.id);
    recordState.status.dropped = Boolean(recordState.status.dropped || persisted.dropped);
    return advance(recordState);
  };
  await Promise.all(recordStates.map((recordState) => advance(recordState)));
  return {
    completed_order: state.completedOrder,
    max_active_advancers: state.maxActiveAdvancers,
  };
};

const readPassedPipelineEvents = ({ db, recordIds }: { db: any; recordIds: string[] }) => {
  if (recordIds.length === 0) return new Map<string, Set<string>>();
  const placeholders = recordIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT record_id, step_id
    FROM pipeline_events
    WHERE passed = 1 AND record_id IN (${placeholders})
  `).all(...recordIds);
  const state = new Map<string, Set<string>>();
  rows.forEach((row: any) => {
    const recordId = String(row?.record_id || '').trim();
    const stepId = String(row?.step_id || '').trim();
    if (!recordId || !stepId) return;
    state.set(recordId, new Set([...(state.get(recordId) || new Set<string>()), stepId]));
  });
  return state;
};

const refreshRecord = ({ db, record }: { db: any; record: DataflowRecord }) => (
  db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1').get(getRecordRowId(record), getRecordRowId(record)) || record
);

type PipelineClock = string | Date | (() => string | Date);

type TimeReadinessDb = {
  prepare: (sql: string) => {
    get: (...params: unknown[]) => Record<string, unknown> | undefined;
  };
};

// Falls back to nowIso() rather than `new Date()` so the AO_NOW test override
// is honoured here too — one clock for the whole run. An explicit
// caller-supplied clock still wins, so tests injecting their own are unaffected.
const clockIso = (clock?: PipelineClock) => {
  const value = typeof clock === 'function' ? clock() : (clock || nowIso());
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid pipeline clock value "${String(value)}".`);
  return parsed.toISOString();
};

const existingWakeAt = ({
  db,
  recordId,
  stepId,
}: {
  db: TimeReadinessDb;
  recordId: string;
  stepId: string;
}) => {
  const row = db.prepare(`
    SELECT wake_at
    FROM pipeline_events
    WHERE record_id = ? AND step_id = ?
      AND passed = 0 AND reason = 'wake_at' AND COALESCE(wake_at, '') != ''
    ORDER BY occurred_at DESC
    LIMIT 1
  `).get(recordId, stepId);
  return String(row?.wake_at || '');
};

const waitAnchorAt = ({
  db,
  recordState,
  step,
  now,
}: {
  db: TimeReadinessDb;
  recordState: RecordState;
  step: DataflowStep;
  now: string;
}) => {
  if (step.deps.length === 0) {
    return String(
      recordState.record.created_at
      || recordState.record._created_at
      || now,
    );
  }
  const placeholders = step.deps.map(() => '?').join(', ');
  const row = db.prepare(`
    SELECT MAX(occurred_at) AS occurred_at
    FROM pipeline_events
    WHERE record_id = ? AND passed = 1 AND step_id IN (${placeholders})
  `).get(getRecordRowId(recordState.record), ...step.deps);
  return String(row?.occurred_at || now);
};

const makeTimeReadiness = ({
  db,
  clock,
  config,
}: {
  db: TimeReadinessDb;
  clock?: PipelineClock;
  config: Record<string, unknown>;
}) => (recordState: RecordState, step: DataflowStep) => {
  if (step.kind !== 'wait') return true;
  const recordId = getRecordRowId(recordState.record);
  const now = clockIso(clock);
  const persistedWakeAt = existingWakeAt({ db, recordId, stepId: step.id });
  const wakeAt = persistedWakeAt || (() => {
    const stepConfig = step.step && typeof step.step === 'object'
      ? step.step as Record<string, unknown>
      : {};
    const operations = config.operations && typeof config.operations === 'object'
      ? config.operations as Record<string, unknown>
      : {};
    const timing = resolveWorkingDayConfig({
      ...stepConfig,
      timezone: stepConfig.timezone || operations.timezone,
    });
    const scheduled = computeWaitWakeAt({
      anchorAt: waitAnchorAt({ db, recordState, step, now }),
      after: String(step.step?.after || ''),
      workingDays: timing.workingDays,
      policy: timing.policy,
      timeZone: timing.timeZone,
    });
    insertPipelineEvent({
      db,
      event: {
        event_id: randomUUID(),
        record_id: recordId,
        step_id: step.id,
        kind: step.kind,
        passed: false,
        reason: 'wake_at',
        wake_at: scheduled.wakeAt,
        occurred_at: now,
      },
    });
    return scheduled.wakeAt;
  })();
  return new Date(wakeAt).getTime() <= new Date(now).getTime();
};

const enrichWork = ({ db, listDir, step, stepId, record, force }: { db: any; listDir: string; step: any; stepId: string; record: DataflowRecord; force: boolean }) => (
  countEnrichWorkForStep({ db, listDir, step, stepId, rows: [record], force })
);

const hasAwaitingReviewEvent = ({ db, recordId, stepId }: { db: any; recordId: string; stepId: string }) => Boolean(db.prepare(`
  SELECT 1
  FROM pipeline_events
  WHERE record_id = ? AND step_id = ? AND kind = 'review'
    AND passed = 0 AND reason = 'awaiting_review'
  LIMIT 1
`).get(recordId, stepId));

const hasActiveReviewVerdict = ({ db, recordId, stepId }: { db: any; recordId: string; stepId: string }) => Boolean(db.prepare(`
  SELECT 1
  FROM overrides
  WHERE record_id = ? AND (cleared_at IS NULL OR cleared_at = '')
    AND (
      (kind = 'keep' AND (step_id = ? OR step_id = ''))
      OR (kind = 'drop' AND step_id = '' AND created_by = 'review:' || ?)
    )
  LIMIT 1
`).get(recordId, stepId, stepId));

type KeepDirective = { keepAll: boolean; keepSteps: Set<string> };

const initializeResolved = ({
  db,
  listDir,
  rows,
  steps,
  force,
  reapply,
  overridesByRecord = new Map<string, KeepDirective>(),
}: {
  db: any;
  listDir: string;
  rows: DataflowRecord[];
  steps: DataflowStep[];
  force: boolean;
  reapply: boolean;
  overridesByRecord?: Map<string, KeepDirective>;
}) => {
  const passed = readPassedPipelineEvents({ db, recordIds: rows.map((row) => getRecordRowId(row)) });
  return new Map(rows.map((row) => {
    const recordId = getRecordRowId(row);
    const initial = new Set(Array.from(passed.get(recordId) || []).filter((stepId) => {
      const step = steps.find((entry) => entry.id === stepId);
      if (!step) return true;
      if (step.kind === 'enrich' || step.kind === 'extract' || step.kind === 'generate' || step.kind === 'compose') return !force;
      if (step.kind === 'review') {
        if (!hasAwaitingReviewEvent({ db, recordId, stepId: step.id })) return true;
        return hasActiveReviewVerdict({ db, recordId, stepId: step.id });
      }
      if (step.kind === 'assign') {
        const cached = readStaleness({
          db,
          recordId,
          stepId: assignmentStalenessStepId(step.id),
        });
        return isAssignmentFresh({
          cached,
          step: step.step,
          record: row,
          listDir,
          force,
        });
      }
      if (step.kind !== 'filter' && step.kind !== 'exit') return true;
      if (reapply) return false;
      const staleStepId = filterStalenessStepId(step.id);
      const cached = readStaleness({ db, recordId, stepId: staleStepId });
      if (!cached) {
        writeStaleness({
          db,
          recordId,
          stepId: staleStepId,
          depHash: filterDefHash(step.step, { listDir }),
          cacheTtl: '',
          cacheTtlSeconds: 0,
        });
        return true;
      }
      return isFilterDefFresh({ cached, stepConfig: step.step, listDir });
    }));
    // Force-resolve gates the human has chosen to keep this record past, even under
    // --reapply. Review gates execute once so their pass event is persisted.
    const keep = overridesByRecord.get(recordId);
    if (keep) {
      const kept = steps
        .filter((entry) => (
          entry.dropGate
          && entry.kind !== 'review'
          && (keep.keepAll || keep.keepSteps.has(entry.id))
        ))
        .map((entry) => entry.id);
      kept.forEach((id) => initial.add(id));
    }
    steps
      .filter((entry) => entry.kind === 'enrich' && !initial.has(entry.id))
      .forEach((entry) => {
        const work = enrichWork({ db, listDir, step: entry.step, stepId: entry.id, record: row, force });
        if (Number(work.would_enrich || 0) === 0) initial.add(entry.id);
      });
    return [recordId, initial] as [string, Set<string>];
  }));
};

const makeApplicable = ({ db, listDir, config, force }: { db: any; listDir: string; config: unknown; force: boolean }) => {
  const holdingPipelines = holdingSubpipelineNames(config);
  return (recordState: RecordState, step: DataflowStep) => {
    if (!defaultApplicable(recordState, step)) return false;
    const subpipeline = stepSubpipelineName(step.step);
    if (
      subpipeline
      && (
        holdingPipelines.has(subpipeline)
        || String(recordState.record?.pipeline_name || 'default').trim() !== subpipeline
      )
    ) {
      return false;
    }
    if (step.kind === 'review') {
      const recordId = getRecordRowId(recordState.record);
      if (!hasAwaitingReviewEvent({ db, recordId, stepId: step.id })) return true;
      return hasActiveReviewVerdict({ db, recordId, stepId: step.id });
    }
    if (step.kind === 'manual_task') {
      const recordId = getRecordRowId(recordState.record);
      const awaiting = Boolean(db.prepare(`
        SELECT 1 AS ok
        FROM pipeline_events
        WHERE record_id = ? AND step_id = ? AND kind = 'manual_task'
          AND passed = 0 AND reason = 'awaiting_manual'
        LIMIT 1
      `).get(recordId, step.id)?.ok);
      if (!awaiting) return true;
      // Parked until completeManualTask writes a passed event.
      const completed = Boolean(db.prepare(`
        SELECT 1 AS ok
        FROM pipeline_events
        WHERE record_id = ? AND step_id = ? AND kind = 'manual_task' AND passed = 1
        LIMIT 1
      `).get(recordId, step.id)?.ok);
      return completed;
    }
    if (step.kind !== 'enrich') return true;
    const work = enrichWork({ db, listDir, step: step.step, stepId: step.id, record: recordState.record, force });
    return Number(work.would_enrich || 0) > 0;
  };
};

const createLazyExecutionContext = ({
  db,
  listDir,
  config,
  force,
  clock,
}: {
  db: any;
  listDir: string;
  config: any;
  force: boolean;
  clock?: PipelineClock;
}) => {
  const state: { mcp: any; toolCatalog: any } = { mcp: null, toolCatalog: null };
  return async (step: DataflowStep) => {
    if (
      (step.kind === 'enrich' || step.kind === 'generate')
      && enrichmentStepNeedsMcp(step.step, { listDir })
      && !state.mcp
    ) {
      state.mcp = await getMcpClient();
    }
    if (PIPELINE_ACTION_KINDS.has(step.kind) && step.step?.config?.tool && !state.mcp) state.mcp = await getMcpClient();
    if ((step.kind === 'enrich' || step.kind === 'generate' || PIPELINE_ACTION_KINDS.has(step.kind)) && !state.toolCatalog) {
      state.toolCatalog = readToolCatalog(listDir);
    }
    return {
      db,
      listDir,
      config,
      aiConfig: config?.ai || {},
      mcp: state.mcp,
      toolCatalog: state.toolCatalog,
      force,
      now: clockIso(clock),
    };
  };
};

const unsupportedStepErrors = (steps: DataflowStep[]) => steps
  .filter((entry) => !entry.executable)
  .map((entry) => ({ step: entry.id, error: `unsupported_pipeline_step_kind:${entry.kind || 'unknown'}` }));

export const runPipelineDataflow = async ({
  listDir,
  where = '',
  limit = 0,
  dryRun = false,
  force = false,
  reapply = false,
  concurrency,
  clock,
}: {
  listDir: string;
  where?: string;
  limit?: number;
  dryRun?: boolean;
  force?: boolean;
  reapply?: boolean;
  concurrency?: number;
  clock?: PipelineClock;
}) => {
  // Canary isolation: refuse unscoped mutations against dirty prod corpus.
  const canaryConfig = dryRun
    ? loadCanaryConfig({ listDir })
    : assertListAccessForMutation(listDir);

  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) throw new Error(`Invalid config: ${errors.join('; ')}`);
  prepareFieldCheckValueFiles({ config, listDir });
  assertPhaseModelReferences({
    config: {
      ...config,
      pipeline: flattenPipelineSteps(config)
        .filter((step) => String(step?.kind || '') !== 'wait'),
    },
    phase: 'pipeline',
  });
  const graph = validatePipelineGraph(config, { listDir });
  graph.warnings.forEach((warning) => console.warn(warning));
  if (graph.errors.length > 0) throw new Error(`Invalid pipeline graph: ${graph.errors.join('; ')}`);

  const rawSteps: any[] = flattenPipelineSteps(config);
  const db = openListDb({ listDir, readonly: dryRun });
  try {
    // Keep generates required by a non-generate policy step.
    // Non-critical generate stays deferred unless AO_RUN_GENERATE=1 or run_in_pipeline.
    // Fixture mode still includes the full generate graph for deterministic dry runs.
    const steps = selectDataflowSteps(buildSteps({ db, steps: rawSteps }));
    // Select canary-allowed in-play set FIRST. Reconciliation must not touch
    // non-allowlisted production rows under canary/strict mode.
    // Filter canary before limit so excluded production rows cannot starve allowlist.
    const rawInPlay = readInPlayRows({ db, where, limit: 0 });
    const canaryRows = filterRecordsForCanary(rawInPlay, canaryConfig);
    const rows = Number(limit || 0) > 0 ? canaryRows.slice(0, Number(limit)) : canaryRows;
    // Honor human decision overrides only for the canary-scoped set.
    if (!dryRun) {
      reconcileOverrides({
        db,
        recordIds: rows.map((r) => getRecordRowId(r)).filter(Boolean),
      });
      reconcileFieldOverrides({
        db,
        recordIds: rows.map((r) => getRecordRowId(r)).filter(Boolean),
      });
    }
    if (dryRun) return simulatePipeline({ db, listDir, steps: steps.map((entry) => ({ ...entry.step, id: entry.id })), baseRows: rows, force, reapply });
    const overridesByRecord = overridesByRecordMap({ db });

    const largestBatch = largestBatchSize(steps);
    const globalConcurrency = Math.max(1, Math.floor(Number(concurrency || Math.max(10, largestBatch))));
    if (globalConcurrency < largestBatch) {
      throw new Error(`Pipeline dataflow concurrency (${globalConcurrency}) must be >= largest batch_size (${largestBatch}).`);
    }

    const byStep: Record<string, number> = {};
    const summary = {
      records_in: rows.length,
      by_step: byStep,
      survivors: rows.length,
      steps: steps.length,
      processed: 0,
      failed: 0,
      errored: 0,
      review_flagged: 0,
      awaiting_review: 0,
      newly_parked: 0,
      skipped_passed: 0,
      errors: unsupportedStepErrors(steps) as any[],
    };
    const resolvedByRecord = initializeResolved({ db, listDir, rows, steps, force, reapply, overridesByRecord });
    summary.skipped_passed = rows.reduce((total, row) => total + steps.filter((step) => (
      (step.kind === 'filter' || step.kind === 'exit')
      && resolvedByRecord.get(getRecordRowId(row))?.has(step.id)
      && hasPassedStep({
        db,
        recordId: getRecordRowId(row),
        stepId: step.id,
        contactId: String((row as any).active_contact_id || (row as any).contact_id || '') || null,
      })
    )).length, 0);

    emitActivity({ event: 'phase_start', phase: 'pipeline', rows: rows.length, steps: steps.length, engine: 'dataflow' });
    const runId = beginRun(db, { phase: 'pipeline', target: rows.length, message: `Filtering ${rows.length} records` });
    const progressState = { done: 0 };
    const heartbeatTimer = setInterval(() => heartbeat(db, runId), 3000);
    const contextFor = createLazyExecutionContext({
      db,
      listDir,
      config,
      force,
      clock,
    });
    const loaders = new Map<string, ReturnType<typeof createBatchLoader<DataflowRecord, StepExecutionOutcome>>>();
    const loaderFor = (step: DataflowStep, inFlight: () => number) => {
      const existing = loaders.get(step.id);
      if (existing) return existing;
      const loader = createBatchLoader<DataflowRecord, StepExecutionOutcome>({
        maxBatch: stepBatchSize(step.step),
        windowMs: stepBatchWindowMs(step.step),
        inFlight,
        executor: async (batchRows) => executeStepBatch(await contextFor(step), step.step, step.id, batchRows),
        fallback: async (_record, cause) => ({ passed: false, errored: true, reason: formatErrorMessage(cause, 'batch_failed') }),
        onFlush: async (info) => {
          emitActivity({ event: 'batch_flush', phase: 'pipeline', step: step.id, size: info.size, reason: info.reason, wait_ms: info.wait_ms, exec_ms: info.exec_ms });
          db.prepare(`
            INSERT INTO batch_events (run_id, step_id, size, reason, wait_ms, exec_ms, occurred_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(runId, step.id, info.size, info.reason, info.wait_ms, info.exec_ms, info.occurred_at);
        },
      });
      loaders.set(step.id, loader);
      return loader;
    };

    await runDataflowCore({
      records: rows,
      steps,
      concurrency: globalConcurrency,
      initialResolvedByRecord: resolvedByRecord,
      isApplicable: makeApplicable({ db, listDir, config, force }),
      isTimeReady: makeTimeReadiness({ db, clock, config }),
      loadStep: async (step, record, inFlight) => {
        emitActivity({ event: 'step_start', phase: 'pipeline', step: step.id, kind: step.kind, rows: 1 });
        tickProgress(db, runId, { activeStep: step.id, stepIndex: step.index, stepTotal: steps.length, message: `${step.kind} · ${step.id}` });
        return loaderFor(step, inFlight).load(record);
      },
      onStepOutcome: async (recordState, step, outcome) => {
        const recordId = getRecordRowId(recordState.record);
        const now = clockIso(clock);
        // enrich + generate both write fields then must refresh so dependents (policy_apply) see them.
        if (step.kind === 'enrich' || step.kind === 'extract' || step.kind === 'generate' || step.kind === 'compose') {
          if (outcome.errored) {
            const error = String(outcome.reason || 'failed');
            db.prepare(`
              INSERT INTO errored_events (run_id, record_id, step_id, kind, error, occurred_at)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(runId, recordId, step.id, step.kind, error, now);
            summary.failed += 1;
            summary.errored += 1;
            summary.errors.push({ step: step.id, record_id: recordId, error, errored: true });
            progressState.done += 1;
            tickProgress(db, runId, { done: progressState.done, target: rows.length });
            emitActivity({ event: 'error', phase: 'pipeline', step: step.id, row: recordId, detail: error, errored: true });
            return { record: refreshRecord({ db, record: recordState.record }), resolved: false, errored: true };
          }
          insertPipelineEvent({
            db,
            event: {
              event_id: randomUUID(),
              record_id: recordId,
              step_id: step.id,
              kind: step.kind,
              passed: true,
              reason: String(outcome.reason || ''),
              occurred_at: now,
            },
          });
          summary.processed += outcome.passed ? 1 : 0;
          summary.failed += outcome.passed ? 0 : 1;
          if (!outcome.passed) summary.errors.push({ step: step.id, record_id: recordId, error: String(outcome.reason || 'failed') });
          progressState.done += 1;
          tickProgress(db, runId, { done: progressState.done, target: rows.length });
          emitActivity({ event: 'step_complete', phase: 'pipeline', step: step.id, kind: step.kind, processed: outcome.passed ? 1 : 0, failed: outcome.passed ? 0 : 1 });
          return { record: refreshRecord({ db, record: recordState.record }) };
        }

        if (outcome.errored) {
          const error = String(outcome.reason || 'failed');
          db.prepare(`
            INSERT INTO errored_events (run_id, record_id, step_id, kind, error, occurred_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(runId, recordId, step.id, step.kind, error, now);
          summary.failed += 1;
          summary.errored += 1;
          summary.errors.push({ step: step.id, record_id: recordId, error, errored: true });
          progressState.done += 1;
          tickProgress(db, runId, { done: progressState.done, target: rows.length });
          emitActivity({ event: 'error', phase: 'pipeline', step: step.id, row: recordId, detail: error, errored: true });
          return { record: refreshRecord({ db, record: recordState.record }), resolved: false, errored: true };
        }

        if (step.kind === 'assign') {
          insertPipelineEvent({
            db,
            event: {
              event_id: randomUUID(),
              record_id: recordId,
              step_id: step.id,
              kind: step.kind,
              passed: true,
              reason: String(outcome.reason || ''),
              occurred_at: now,
            },
          });
          writeStaleness({
            db,
            recordId,
            stepId: assignmentStalenessStepId(step.id),
            depHash: assignmentDepHash({ step: step.step, record: refreshRecord({ db, record: recordState.record }), listDir }),
            cacheTtl: '',
            cacheTtlSeconds: 0,
          });
          summary.processed += 1;
          progressState.done += 1;
          tickProgress(db, runId, { done: progressState.done, target: rows.length });
          emitActivity({ event: 'step_complete', phase: 'pipeline', step: step.id, kind: step.kind, processed: 1, rows: 1 });
          return { record: refreshRecord({ db, record: recordState.record }) };
        }

        if (step.kind === 'review') {
          if (outcome.passed) {
            insertPipelineEvent({
              db,
              event: {
                event_id: randomUUID(),
                record_id: recordId,
                step_id: step.id,
                kind: step.kind,
                passed: true,
                reason: String(outcome.reason || ''),
                occurred_at: now,
              },
            });
            progressState.done += 1;
            tickProgress(db, runId, { done: progressState.done, target: rows.length });
            emitActivity({ event: 'step_complete', phase: 'pipeline', step: step.id, kind: step.kind, passed: 1, rows: 1 });
            return { record: refreshRecord({ db, record: recordState.record }) };
          }
          if (String(outcome.reason || '') === 'review: dropped') {
            insertPipelineEvent({
              db,
              event: {
                event_id: randomUUID(),
                record_id: recordId,
                step_id: step.id,
                kind: step.kind,
                passed: false,
                reason: 'review: dropped',
                occurred_at: now,
              },
            });
            byStep[step.id] = Number(byStep[step.id] || 0) + 1;
            progressState.done += 1;
            tickProgress(db, runId, { done: progressState.done, target: rows.length });
            emitActivity({ event: 'step_complete', phase: 'pipeline', step: step.id, kind: step.kind, dropped: 1, rows: 1 });
            return { record: refreshRecord({ db, record: recordState.record }), dropped: true };
          }
          const alreadyAwaiting = hasAwaitingReviewEvent({ db, recordId, stepId: step.id });
          if (!alreadyAwaiting) {
            insertPipelineEvent({
              db,
              event: {
                event_id: randomUUID(),
                record_id: recordId,
                step_id: step.id,
                kind: step.kind,
                passed: false,
                reason: 'awaiting_review',
                occurred_at: now,
              },
            });
          }
          summary.newly_parked += alreadyAwaiting ? 0 : 1;
          progressState.done += 1;
          tickProgress(db, runId, { done: progressState.done, target: rows.length });
          emitActivity({ event: 'step_complete', phase: 'pipeline', step: step.id, kind: step.kind, awaiting_review: 1, rows: 1 });
          return { record: refreshRecord({ db, record: recordState.record }), resolved: false };
        }

        if (
          (step.kind === 'manual_task' && !isSkippedWhenOutcome(outcome))
          || String(outcome.reason || '') === 'awaiting_manual'
        ) {
          const alreadyAwaiting = Boolean(db.prepare(`
            SELECT 1 AS ok
            FROM pipeline_events
            WHERE record_id = ? AND step_id = ? AND kind = 'manual_task'
              AND passed = 0 AND reason = 'awaiting_manual'
            LIMIT 1
          `).get(recordId, step.id)?.ok);
          if (!alreadyAwaiting) {
            insertPipelineEvent({
              db,
              event: {
                event_id: randomUUID(),
                record_id: recordId,
                step_id: step.id,
                kind: 'manual_task',
                passed: false,
                reason: 'awaiting_manual',
                occurred_at: now,
              },
            });
          }
          summary.newly_parked += alreadyAwaiting ? 0 : 1;
          progressState.done += 1;
          tickProgress(db, runId, { done: progressState.done, target: rows.length });
          emitActivity({
            event: 'step_complete',
            phase: 'pipeline',
            step: step.id,
            kind: 'manual_task',
            awaiting_manual: 1,
            rows: 1,
          });
          return { record: refreshRecord({ db, record: recordState.record }), resolved: false };
        }

        if (step.kind === 'wait' || PIPELINE_ACTION_KINDS.has(step.kind)) {
          insertPipelineEvent({
            db,
            event: {
              event_id: randomUUID(),
              record_id: recordId,
              step_id: step.id,
              kind: step.kind,
              passed: outcome.passed,
              reason: String(outcome.reason || ''),
              side_effecting: Boolean(step.step?.side_effecting),
              occurred_at: now,
            },
          });
          summary.processed += outcome.passed ? 1 : 0;
          summary.failed += outcome.passed ? 0 : 1;
          if (!outcome.passed) {
            summary.errors.push({
              step: step.id,
              record_id: recordId,
              error: String(outcome.reason || 'failed'),
            });
          }
          progressState.done += 1;
          tickProgress(db, runId, { done: progressState.done, target: rows.length });
          emitActivity({
            event: 'step_complete',
            phase: 'pipeline',
            step: step.id,
            kind: step.kind,
            processed: outcome.passed ? 1 : 0,
            failed: outcome.passed ? 0 : 1,
            rows: 1,
          });
          return {
            record: refreshRecord({ db, record: recordState.record }),
            resolved: outcome.passed,
            errored: !outcome.passed,
          };
        }

        // A human "keep" override on a failing drop gate converts the verdict to a
        // pass (audited), so the record is never dropped here.
        const keep = overridesByRecord.get(recordId);
        const keptHere = step.dropGate && !outcome.passed && Boolean(keep && (keep.keepAll || keep.keepSteps.has(step.id)));
        const effectivePassed = outcome.passed || keptHere;
        const reason = effectivePassed
          ? (keptHere ? `override: kept (auto-verdict was: ${String(outcome.reason || '').trim() || 'failed'})` : '')
          : (String(outcome.reason || '').trim() || 'failed');
        insertPipelineEvent({
          db,
          event: {
            event_id: randomUUID(),
            record_id: recordId,
            step_id: step.id,
            kind: step.kind,
            passed: effectivePassed,
            reason,
            occurred_at: now,
          },
        });
        writeStaleness({
          db,
          recordId,
          stepId: filterStalenessStepId(step.id),
          depHash: filterDefHash(step.step, { listDir }),
          cacheTtl: '',
          cacheTtlSeconds: 0,
        });
        const action = effectivePassed
          ? ''
          : writeFilterFailure({
            db,
            record: recordState.record,
            stepId: step.id,
            reason,
            drop: step.dropGate,
          });
        if (action === 'dropped') byStep[step.id] = Number(byStep[step.id] || 0) + 1;
        if (action === 'review_flagged') summary.review_flagged += 1;
        progressState.done += 1;
        tickProgress(db, runId, { done: progressState.done, target: rows.length });
        emitActivity({ event: 'step_complete', phase: 'pipeline', step: step.id, kind: step.kind, dropped: action === 'dropped' ? 1 : 0, review_flagged: action === 'review_flagged' ? 1 : 0, skipped_passed: 0, rows: 1 });
        return {
          record: refreshRecord({ db, record: recordState.record }),
          dropped: action === 'dropped',
        };
      },
    }).finally(async () => {
      clearInterval(heartbeatTimer);
      await Promise.all(Array.from(loaders.values()).map((loader) => loader.flush()));
      await closeMcpClient();
    });

    summary.survivors = Number(db.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${inPlayWhere()}`).get()?.n || 0);
    summary.awaiting_review = countAwaitingReviewRecords({ db, config });
    const funnel = {
      records_in: summary.records_in,
      by_step: summary.by_step,
      survivors: summary.survivors,
      awaiting_review: summary.awaiting_review,
      newly_parked: summary.newly_parked,
    };
    logPipelineEvent({ listDir, payload: funnel });
    emitActivity({ event: 'phase_complete', phase: 'pipeline', ...funnel, engine: 'dataflow' });
    if (summary.errored > 0) {
      console.warn(`Pipeline completed with ${summary.errored} evaluation/execution errors; errored records remain in play for retry.`);
    }
    endRun(db, runId, {
      status: summary.errored > 0 ? 'error' : 'done',
      message: summary.errored > 0
        ? `Pipeline incomplete · ${summary.errored} errored records need retry · ${summary.awaiting_review} awaiting review`
        : `Pipeline complete · ${summary.survivors} survivors · ${summary.awaiting_review} awaiting review`,
    });
    return summary;
  } catch (error) {
    throw error;
  } finally {
    db.close();
  }
};
