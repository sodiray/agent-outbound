import { openListDb } from '../orchestrator/runtime/db.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';
import { readConfig } from '../orchestrator/lib/config.js';
import { assertRecordAccessForMutation } from '../orchestrator/policy/canary-isolation.js';
import {
  getCallBoard,
  claimCallBoardEntry,
  disposeCallBoardEntry,
  releaseCallBoardClaim,
  expireCallBoardLeases,
} from '../orchestrator/operator/call-board.js';
import { resolvePhoneAttemptPolicyConfig } from '../orchestrator/policy/phone-attempt.js';
import { runHealthChecks } from '../orchestrator/operator/health.js';
import {
  getAccountTimeline,
  getDecisionView,
  getCommercialMetrics,
  exportAuditLog,
} from '../orchestrator/operator/timeline.js';
import {
  listWorkQueue,
  listAllWorkQueueCounts,
  WORK_QUEUE_NAMES,
  type WorkQueueName,
} from '../orchestrator/operator/work-queues.js';

export const callBoardCommand = ({
  list,
  capacity = 25,
  limit = 50,
}: {
  list: string;
  capacity?: number;
  limit?: number;
}) => {
  const listDir = resolveListDir(list);
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) throw new Error(`Invalid config: ${errors.join('; ')}`);
  const db = openListDb({ listDir, readonly: true });
  try {
    return getCallBoard({
      db,
      capacity,
      limit,
      phonePolicy: resolvePhoneAttemptPolicyConfig(config),
    });
  } finally {
    db.close();
  }
};

export const callBoardClaimCommand = ({
  list,
  record,
  owner = 'operator',
}: {
  list: string;
  record: string;
  owner?: string;
}) => {
  const listDir = resolveListDir(list);
  assertRecordAccessForMutation({ listDir, recordId: record });
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) throw new Error(`Invalid config: ${errors.join('; ')}`);
  const db = openListDb({ listDir, readonly: false });
  try {
    return claimCallBoardEntry({
      db,
      recordId: record,
      claimedBy: owner,
      phonePolicy: resolvePhoneAttemptPolicyConfig(config),
    });
  } finally {
    db.close();
  }
};

export const callBoardDisposeCommand = ({
  list,
  record,
  disposition,
  note = '',
  owner = '',
}: {
  list: string;
  record: string;
  disposition: string;
  note?: string;
  owner?: string;
}) => {
  const listDir = resolveListDir(list);
  assertRecordAccessForMutation({ listDir, recordId: record });
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) throw new Error(`Invalid config: ${errors.join('; ')}`);
  const db = openListDb({ listDir, readonly: false });
  try {
    return disposeCallBoardEntry({
      db,
      recordId: record,
      disposition: disposition as any,
      note,
      disposedBy: owner || undefined,
      phonePolicy: resolvePhoneAttemptPolicyConfig(config),
    });
  } finally {
    db.close();
  }
};

export const callBoardReleaseCommand = ({
  list,
  record,
  owner = 'operator',
  force = false,
}: {
  list: string;
  record: string;
  owner?: string;
  force?: boolean;
}) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    return releaseCallBoardClaim({
      db,
      recordId: record,
      releasedBy: owner,
      force,
    });
  } finally {
    db.close();
  }
};

export const callBoardExpireCommand = ({
  list,
  limit = 500,
}: {
  list: string;
  limit?: number;
}) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    return expireCallBoardLeases({ db, limit });
  } finally {
    db.close();
  }
};

export const healthCheckCommand = ({ list, limit = 500 }: { list: string; limit?: number }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    return runHealthChecks({ db, limit });
  } finally {
    db.close();
  }
};

export const timelineCommand = ({
  list,
  record,
  limit = 100,
}: {
  list: string;
  record: string;
  limit?: number;
}) => {
  const listDir = resolveListDir(list);
  const config = (() => {
    try {
      return readConfig(listDir).config as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  const db = openListDb({ listDir, readonly: true });
  try {
    return getAccountTimeline({ db, recordId: record, limit, config });
  } finally {
    db.close();
  }
};

export const decisionViewCommand = ({ list, record }: { list: string; record: string }) => {
  const listDir = resolveListDir(list);
  const config = (() => {
    try {
      return readConfig(listDir).config as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  const db = openListDb({ listDir, readonly: true });
  try {
    return getDecisionView({ db, recordId: record, config });
  } finally {
    db.close();
  }
};

export const metricsCommand = ({ list }: { list: string }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    return getCommercialMetrics({ db });
  } finally {
    db.close();
  }
};

/**
 * Dump transition_audit / stage_review / decision fields as JSON.
 * One record (`record` / `recordId` / `row`) or whole-list export (capped by limit).
 */
export const auditExportCommand = ({
  list,
  record = '',
  recordId = '',
  row = '',
  limit = 500,
}: {
  list: string;
  record?: string;
  recordId?: string;
  row?: string;
  limit?: number;
}) => {
  const listDir = resolveListDir(list);
  const rid = String(recordId || record || row || '').trim();
  const db = openListDb({ listDir, readonly: true });
  try {
    return exportAuditLog({
      db,
      recordId: rid || undefined,
      limit: Number(limit) || 500,
    });
  } finally {
    db.close();
  }
};

/**
 * Unified work queues command.
 * - `queue` omitted or `all` → counts snapshot for every queue
 * - `queue` = repair | enrichment_hold | objection | callback | meeting |
 *   recycle | reentry | stage_review | manual | reply → that queue's items
 */
export const workQueuesCommand = ({
  list,
  queue = '',
  limit = 100,
  offset = 0,
  status = 'open',
  taskType = '',
  type = '',
}: {
  list: string;
  queue?: string;
  limit?: number;
  offset?: number;
  status?: string;
  taskType?: string;
  type?: string;
}) => {
  const listDir = resolveListDir(list);
  const q = String(queue || '').trim().toLowerCase().replace(/-/g, '_');
  // Manual queue may close inapplicable parks; open write when serving it.
  const needsWrite = q === 'manual';
  const config = (() => {
    try {
      return readConfig(listDir).config;
    } catch {
      return undefined;
    }
  })();
  const db = openListDb({ listDir, readonly: !needsWrite });
  try {
    if (!q || q === 'all' || q === 'counts') {
      return listAllWorkQueueCounts({ db, limit: 0 });
    }
    return listWorkQueue({
      db,
      config,
      queue: q,
      limit: Number(limit) || 100,
      offset: Number(offset) || 0,
      status,
      taskType: taskType || type || '',
      listDir,
      reconcile: needsWrite,
    });
  } finally {
    db.close();
  }
};

/** Per-queue thin wrappers (HTTP action aliases). */
const queueCommand = (name: WorkQueueName) => ({
  list,
  limit = 100,
  offset = 0,
  status = 'open',
  taskType = '',
  type = '',
}: {
  list: string;
  limit?: number;
  offset?: number;
  status?: string;
  taskType?: string;
  type?: string;
}) => workQueuesCommand({
  list,
  queue: name,
  limit,
  offset,
  status,
  taskType: taskType || type || '',
});

export const queueRepairCommand = queueCommand('repair');
export const queueEnrichmentHoldCommand = queueCommand('enrichment_hold');
export const queueObjectionCommand = queueCommand('objection');
export const queueCallbackCommand = queueCommand('callback');
export const queueMeetingCommand = queueCommand('meeting');
export const queueRecycleCommand = queueCommand('recycle');
export const queueReentryCommand = queueCommand('reentry');
export const queueStageReviewCommand = queueCommand('stage_review');
export const queueManualCommand = queueCommand('manual');
export const queueReplyCommand = queueCommand('reply');

export { WORK_QUEUE_NAMES };
