import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  addSuppression,
  getPrimaryContact,
  hasSuppression,
  inPlayWhere,
  insertChannelEvent,
  listContactsByRecord,
  openGlobalSuppressionDb,
  openListDb,
  ensureRecordColumns,
  upsertRecord,
} from '../runtime/db.js';
import { readConfig } from '../lib/config.js';
import { getRecordRowId, nowIso, stableHash, todayIsoDate } from '../lib/record.js';
import { executeChannelStep } from '../channels/execute.js';
import { evaluateConditionAction } from '../actions/evaluate-condition/index.js';
import { planRouteAction } from '../actions/plan-route/index.js';
import { emitActivity } from '../runtime/activity.js';
import { recordCostEvent } from '../lib/costs.js';
import { getMcpClient } from '../runtime/mcp.js';
import { runDeliveryPoll, runImapInboundPoll } from '../runtime/polling.js';
import { generateObjectWithTools } from '../runtime/llm.js';
import { assertToolSpecAvailable } from '../runtime/mcp.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { readToolCatalog } from '../lib/tool-catalog.js';
import {
  addIsoDays,
  applyWorkingDaysFilterInTimezone,
  computeNextScheduledAction,
  isActionDueOnDate,
  resolveWorkingDayConfig,
  toIsoDate,
  toZonedIsoDate,
} from '../lib/working-days.js';
import {
  recordUsesPipelineSequence,
  resolveSequencerSequence,
} from '../lib/sequence-resolution.js';
import { evaluateStructuredCondition } from '../lib/sequence-conditions.js';
import { resolveStepTemplate } from '../lib/templates.js';
import { isBudgetExceededError } from '../runtime/contract.js';
import { assertPhaseModelReferences } from '../lib/model-validation.js';
import {
  isOptionalPhoneCapacityStep,
  laterStepsDependOn,
  shouldExecuteSequenceOutbound,
} from '../policy/sequence-outbound.js';
import {
  assertListAccessForMutation,
  filterRecordsForCanary,
  loadCanaryConfig,
} from '../policy/canary-isolation.js';
import { applyContactRotation } from '../policy/contact-campaign.js';
import { isAffirmativeFlag } from '../policy/booleanish.js';
import { evaluateTransmitterSuppression } from '../policy/transmitter-suppression.js';
import { hydrateActiveContactOntoRecord } from '../policy/load-contacts.js';
import { evaluateSequenceReachability } from '../policy/sequence-reachability.js';
import { reconcileSequenceReachability } from '../policy/sequence-reachability-reconcile.js';
import { LIFECYCLE_STAGES } from '../policy/lifecycle.js';

/**
 * Sequence-status transitions that `logOutcome` can apply. These are a separate
 * axis from lifecycle_stage: why outreach stopped / how the sequence is parked,
 * not where the commercial deal stands.
 */
const LOG_SEQUENCE_STATUS_TRANSITIONS = ['engaged', 'opted_out', 'bounced', 'completed'] as const;

/** Accepted `--transition` values: full lifecycle vocabulary ∪ sequence-status controls. */
const LOG_ACCEPTED_TRANSITIONS = new Set<string>([
  ...LIFECYCLE_STAGES,
  ...LOG_SEQUENCE_STATUS_TRANSITIONS,
]);

const parseExtra = (value) => {
  try {
    if (!value) return {};
    if (typeof value === 'object') return value;
    return JSON.parse(String(value));
  } catch {
    return {};
  }
};

const formatDate = (date) => date.toISOString().slice(0, 10);

const addDays = (isoDate, days) => {
  const base = new Date(`${isoDate}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + Number(days || 0));
  return formatDate(base);
};

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const resolveSequencerClock = ({
  now,
  timeZone,
}: {
  now?: string | Date;
  timeZone?: string;
}): { logicalNow: Date; today: string } => {
  const environmentDateOverride = now == null
    ? String(process.env.AO_NOW || '').trim()
    : '';
  const requestedNow = now ?? nowIso();
  const logicalNow = requestedNow instanceof Date ? requestedNow : new Date(String(requestedNow));
  const dateOverride = typeof now === 'string' && ISO_DATE_PATTERN.test(now)
    ? now
    : ISO_DATE_PATTERN.test(environmentDateOverride)
      ? environmentDateOverride
    : '';
  const today = dateOverride || toZonedIsoDate(logicalNow, timeZone) || todayIsoDate();
  return { logicalNow, today };
};

const parseWaitDays = (raw) => {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return 14;

  const natural = text.match(/wait\s+up\s+to\s+(\d+)\s*(day|days|d|hour|hours|h|week|weeks|w)/);
  const compact = text.match(/(\d+)\s*(d|h|m|s|day|days|hour|hours|week|weeks)/);
  const match = natural || compact;
  if (!match) return 14;

  const amount = Number(match[1] || 14);
  const unit = String(match[2] || 'd').toLowerCase();
  if (unit.startsWith('w')) return amount * 7;
  if (unit.startsWith('d')) return amount;
  if (unit.startsWith('h')) return Math.ceil(amount / 24);
  if (unit.startsWith('m')) return Math.ceil(amount / 1440);
  return Math.ceil(amount / 86400);
};

const parseTimeoutPolicy = (rawText) => {
  const text = String(rawText || '').toLowerCase();
  if (text.includes('fail')) return 'fail_record';
  if (text.includes('block') || text.includes('blocked')) return 'mark_blocked';
  return 'skip_step';
};

export const getSequence = (config, name = 'default') => {
  return resolveSequencerSequence({ config, name });
};

const recordSequenceName = (record) => String(record?.sequence_name || 'default').trim() || 'default';

const holdingSequenceNames = (config) => new Set(
  (Array.isArray(config?.pipeline) ? config.pipeline : [])
    .filter((step) => (
      String(step?.kind || '') === 'assign'
      && String(step?.target || 'sequence_name') === 'sequence_name'
    ))
    .map((step) => String(step?.fallback || '').trim())
    .filter(Boolean),
);

const partitionRecordsBySequence = ({ config, records }) => {
  const grouped = (records || []).reduce((groups, record) => {
    const name = recordSequenceName(record);
    const current = groups.get(name) || [];
    groups.set(name, [...current, record]);
    return groups;
  }, new Map());
  const groups = [];
  const invalid = [];
  Array.from(grouped.entries()).forEach(([name, groupedRecords]) => {
    try {
      const sequence = getSequence(config, name);
      groups.push({
        name,
        sequence,
        steps: Array.isArray(sequence?.steps) ? sequence.steps : [],
        timing: resolveWorkingDayConfig(sequence),
        records: groupedRecords,
      });
    } catch (error) {
      groupedRecords.forEach((record) => {
        invalid.push({
          record,
          sequenceName: name,
          error: String(error?.message || error),
        });
      });
    }
  });
  return { groups, invalid };
};

const persistSequenceDataFailures = ({ db, failures, summary, persist = true }) => {
  failures.forEach((failure) => {
    const recordId = getRecordRowId(failure.record);
    if (persist) {
      upsertRecord({
        db,
        row: {
          ...failure.record,
          last_error: failure.error,
        },
      });
    }
    summary.failed += 1;
    summary.errors.push({
      record_id: recordId,
      sequence_name: failure.sequenceName,
      error: failure.error,
    });
  });
};

const sequenceScope = ({ sequenceName = '', holdingNames = new Set() }) => {
  const filter = String(sequenceName || '').trim();
  const holding = Array.from(holdingNames);
  return {
    sql: [
      holding.length > 0 ? `AND COALESCE(sequence_name, 'default') NOT IN (${holding.map(() => '?').join(', ')})` : '',
      filter ? "AND COALESCE(sequence_name, 'default') = ?" : '',
    ].filter(Boolean).join(' '),
    params: [...holding, ...(filter ? [filter] : [])],
  };
};

const getStepDay = (step) => {
  return Number(step?.day || 0);
};

const toLaunchTimestamp = (isoDate) => `${isoDate}T00:00:00.000Z`;

const advanceAfterCompletedStep = ({ record, completedStepNumber, steps, timing, today, lastError = '' }) => {
  const launchTimestamp = String(record?.launched_at || '').trim() || toLaunchTimestamp(today);
  const launchedAtDate = toIsoDate(launchTimestamp) || today;
  const advancement = computeNextScheduledAction({
    steps,
    completedStepNumber,
    launchedAtDate,
    workingDays: timing.workingDays,
    policy: timing.policy,
    timeZone: timing.timeZone,
  });

  return {
    row: {
      ...record,
      launched_at: launchTimestamp,
      sequence_step: advancement.sequenceStep,
      next_action_date: advancement.nextActionDate,
      sequence_status: advancement.completed ? 'completed' : 'active',
      last_error: lastError,
    },
    autoSkippedSteps: advancement.skippedStepNumbers,
  };
};

const getLaunchDecision = ({ sequence, firstStep, today }) => {
  const timing = resolveWorkingDayConfig(sequence || {});
  const launchBaseDate = addIsoDays(today, getStepDay(firstStep));
  const filtered = applyWorkingDaysFilterInTimezone({
    isoDate: launchBaseDate,
    workingDays: timing.workingDays,
    policy: timing.policy,
    timeZone: timing.timeZone,
  });
  return { timing, launchBaseDate, filtered };
};

/**
 * Collect in-play sequence records, then apply logical-time outbound gate.
 * `now` controls wait due_at / sequence_state blocks without mutating wall clock.
 */
export const collectDueRecords = ({
  db,
  limit = 0,
  sequenceName = '',
  holdingNames = new Set(),
  now = new Date(),
  today,
  timeZone,
  config,
  listDir = '',
  canaryConfig,
}: {
  db: any;
  limit?: number;
  sequenceName?: string;
  holdingNames?: Set<string> | Set<unknown>;
  now?: string | Date;
  /** Pipeline-local date for date-only waits. */
  today?: string;
  /** Pipeline timezone for date-only waits when today is omitted. */
  timeZone?: string;
  /** Filters nested pipeline records from the sequencer executor. */
  config?: Record<string, unknown>;
  /** When set, canary isolation filters due records to the allowlist. */
  listDir?: string;
  canaryConfig?: import('../policy/canary-isolation.js').CanaryIsolationConfig;
}) => {
  const holdings = holdingNames instanceof Set
    ? (holdingNames as Set<string>)
    : new Set<string>();
  const scope = sequenceScope({ sequenceName, holdingNames: holdings });
  const capped = Math.max(0, Number(limit || 0));
  // Over-fetch then filter by logical time so waits that are not due are excluded.
  const fetchLimit = capped > 0 ? Math.max(capped * 4, capped) : 0;
  const rows = db.prepare(`
    SELECT * FROM records
    WHERE ${inPlayWhere()}
      AND (sequence_status IS NULL OR sequence_status NOT IN ('completed','opted_out'))
      ${scope.sql}
    ORDER BY updated_at DESC
    ${fetchLimit > 0 ? 'LIMIT ?' : ''}
  `).all(...scope.params, ...(fetchLimit > 0 ? [fetchLimit] : []));
  const due = (rows || []).filter((record: any) => {
    const state = String(record.account_sequence_state || '').trim().toLowerCase();
    if (state === 'unreachable') {
      const hydrated = hydrateActiveContactOntoRecord({ db, record });
      const reachability = evaluateSequenceReachability({
        record: hydrated.record,
        contacts: listContactsByRecord({ db, recordId: getRecordRowId(hydrated.record) }),
      });
      return reachability.applicable && reachability.reachable;
    }
    return shouldExecuteSequenceOutbound(record, now, { today, timeZone }).execute;
  });
  const sequencerDue = config
    ? due.filter((record) => !recordUsesPipelineSequence({ config, record }))
    : due;
  const isolation = canaryConfig
    || (listDir ? loadCanaryConfig({ listDir }) : null);
  const scoped = isolation ? filterRecordsForCanary(sequencerDue, isolation) : sequencerDue;
  return capped > 0 ? scoped.slice(0, capped) : scoped;
};

const StepIntentSchema = z.object({
  uses_email: z.boolean().default(false),
  uses_mail: z.boolean().default(false),
  uses_sms: z.boolean().default(false),
  uses_call: z.boolean().default(false),
  uses_phone: z.boolean().default(false),
  uses_visit: z.boolean().default(false),
  reason: z.string().default(''),
});

const classifyStepIntent = async ({ db, listDir, step, cache, aiConfig = {}, model = '' }: any) => {
  const key = String(step?.id || step?.description || '').trim() || JSON.stringify(step || {});
  if (cache.has(key)) return cache.get(key);

  const prompt = [
    'Classify which communication channels this sequence step description implies.',
    'Return booleans only; do not infer extra fields.',
    '',
    `Step description: ${String(step?.description || '').trim()}`,
    '',
    'Interpretation rules:',
    '- uses_email: true if the step sends, drafts, replies to, or references an email action.',
    '- uses_mail: true if the step sends physical mail such as postcard/letter/LOB dispatch.',
    '- uses_sms: true if the step sends SMS/text messages.',
    '- uses_call: true if the step is a phone call task.',
    '- uses_phone: true if SMS or call is involved.',
    '- uses_visit: true if the step involves in-person visits, drop-bys, route stops, or door knocks.',
  ].join('\n');

  try {
    const result = await generateObjectWithTools({
      task: 'sequence-step-intent',
      model,
      role: 'evaluation',
      aiConfig,
      schema: StepIntentSchema,
      prompt,
      toolSpec: {},
      maxSteps: 2,
    });
    recordCostEvent({
      db,
      listDir,
      stepId: `sequence:step_intent:${step?.id || 'step'}`,
      model: String((result as any)?.model || ''),
      provider: String((result as any)?.provider || ''),
      usage: result.usage,
    });
    const parsed = StepIntentSchema.parse(result.object);
    cache.set(key, parsed);
    return parsed;
  } catch {
    const fallback = {
      uses_email: false,
      uses_mail: false,
      uses_sms: false,
      uses_call: false,
      uses_phone: false,
      uses_visit: false,
      reason: '',
    };
    cache.set(key, fallback);
    return fallback;
  }
};

const declaredLaunchChannel = (step: Record<string, unknown>): 'email' | 'linkedin' | 'mail' | 'sms' | 'call' | 'visit' | null => {
  const kind = String(step.kind || '').trim().toLowerCase();
  const config = step.config && typeof step.config === 'object' ? step.config as Record<string, unknown> : {};
  const configuredChannel = String(config.channel || '').trim().toLowerCase();
  if (kind === 'send_email' || configuredChannel === 'email') return 'email';
  if (kind === 'linkedin_connect' || configuredChannel === 'linkedin') return 'linkedin';
  if (configuredChannel === 'mail') return 'mail';
  if (configuredChannel === 'sms') return 'sms';
  if (configuredChannel === 'call' || configuredChannel === 'phone') return 'call';
  if (configuredChannel === 'visit') return 'visit';
  return null;
};

const resolveLaunchChannelHint = ({ step, intent }: {
  step: Record<string, unknown>;
  intent: Record<string, unknown>;
}): string => {
  const declared = declaredLaunchChannel(step);
  if (declared) return declared;
  if (intent.uses_email === true) return 'email';
  if (intent.uses_mail === true) return 'mail';
  if (intent.uses_sms === true) return 'sms';
  if (intent.uses_call === true) return 'call';
  if (intent.uses_visit === true) return 'visit';
  return 'manual';
};

/**
 * Pick the next due sequence step.
 *
 * Linear by default (sequence_step + 1). When the next step is optional phone
 * capacity that is already open-parked and no later step depends_on it, walk
 * forward so independent mail (depends_on email_2, not phone) can run without
 * waiting for the call board to clear the phone park.
 */
const resolveDueStep = ({
  record,
  steps,
  today,
  db = null,
}: {
  record: Record<string, unknown>;
  steps: any[];
  today: string;
  db?: any;
}) => {
  const dueDate = String(record.next_action_date || '').trim();
  if (dueDate && !isActionDueOnDate({ nextActionDate: dueDate, today })) {
    return { step: null, stepNumber: Number(record.sequence_step || 0) + 1 };
  }

  let cursor = Number(record.sequence_step || 0); // 0-based completed count
  while (cursor < steps.length) {
    const stepNumber = cursor + 1;
    const step = steps[cursor];
    if (!step) return { step: null, stepNumber };

    // Optional phone capacity already parked and not required by later steps:
    // skip the cursor past it so independent channels (mail) can execute.
    if (db && isOptionalPhoneCapacityStep(step)) {
      const stepId = String(step.id || '').trim();
      const recordId = getRecordRowId(record);
      let openPark = false;
      try {
        openPark = Boolean(db.prepare(`
          SELECT 1 AS ok
          FROM pipeline_events
          WHERE record_id = ? AND step_id = ? AND kind = 'manual_task'
            AND passed = 0 AND reason = 'awaiting_manual'
            AND NOT EXISTS (
              SELECT 1 FROM pipeline_events done
              WHERE done.record_id = pipeline_events.record_id
                AND done.step_id = pipeline_events.step_id
                AND done.kind = 'manual_task'
                AND done.passed = 1
                AND done.occurred_at > pipeline_events.occurred_at
            )
          LIMIT 1
        `).get(recordId, stepId)?.ok);
      } catch {
        openPark = false;
      }
      if (openPark && stepId && !laterStepsDependOn(steps, stepId)) {
        cursor += 1;
        continue;
      }
    }

    return { step, stepNumber };
  }

  return { step: null, stepNumber: cursor + 1 };
};

const planVisitRoutesIfNeeded = async ({ mcp, db, listDir, config, visitCandidates, today, aiConfig = {} }: any) => {
  const visits = (visitCandidates || []).filter((row) => row);
  if (visits.length === 0) return { routes_created: 0, stops: 0 };
  const toolSpec = config?.channels?.visit?.tool || {};
  const hasToolkit = Array.isArray(toolSpec?.toolkits) && toolSpec.toolkits.length > 0;
  const hasTools = Array.isArray(toolSpec?.tools) && toolSpec.tools.length > 0;
  if (!hasToolkit && !hasTools) {
    throw new Error('Visit route planning requires channels.visit.tool to be configured.');
  }
  await assertToolSpecAvailable({
    toolSpec,
    capability: 'visit route planning',
  });

  const route = await planRouteAction({
    mcp,
    routeDate: today,
    territory: config?.list?.territory || {},
    stops: visits,
    toolSpec,
    toolCatalog: readToolCatalog(listDir),
    aiConfig,
    model: config?.channels?.visit?.model || '',
    listDir,
  });
  recordCostEvent({
    db,
    listDir,
    stepId: 'sequence:plan_route',
    model: String((route as any)?.model || ''),
    provider: String((route as any)?.provider || ''),
    usage: route.usage,
  });

  const routeId = `route_${today}_${randomUUID().slice(0, 8)}`;

  db.prepare(`
    INSERT INTO routes (id, route_date, status, total_drive_minutes, summary_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    routeId,
    today,
    'planned',
    Number(route.total_drive_minutes || 0),
    JSON.stringify({ summary: route.summary || '' }),
    new Date().toISOString(),
    new Date().toISOString()
  );

  for (const stop of route.stops || []) {
    db.prepare(`
      INSERT INTO route_stops (
        id, route_id, record_id, stop_order, scheduled_time, drive_minutes_from_prev, calendar_event_id, eta, notes, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      routeId,
      stop.record_id,
      Number(stop.stop_order || 0),
      String(stop.scheduled_time || ''),
      Number(stop.drive_minutes_from_prev || 0),
      String(stop.calendar_event_id || ''),
      String(stop.eta || ''),
      String(stop.notes || ''),
      new Date().toISOString(),
      new Date().toISOString()
    );

    const record = visits.find((item) => getRecordRowId(item) === stop.record_id);
    if (!record) continue;
    upsertRecord({
      db,
      row: {
        ...record,
        visit_route_id: routeId,
        visit_route_position: Number(stop.stop_order || 0),
        visit_scheduled_date: today,
      },
    });
  }

  return { routes_created: 1, stops: (route.stops || []).length };
};

const checkSuppressionGate = ({ intent, record, primaryContact, extra, globalSuppressionDb, listDb, channelsConfig }) => {
  if (isAffirmativeFlag(record.suppressed, { failClosed: true })) return { blocked: true, reason: 'record_suppressed' };

  if (intent.uses_email) {
    const contactDne = isAffirmativeFlag(primaryContact?.dne_email, { failClosed: true });
    const emailSuppressed = isAffirmativeFlag(record.email_suppressed, { failClosed: true });
    if (isAffirmativeFlag(record.dne_email, { failClosed: true }) || contactDne || emailSuppressed) {
      return { blocked: true, reason: emailSuppressed ? 'email_suppressed' : 'dne_email' };
    }
    const email = String(primaryContact?.email || record.email_primary || '').trim();
    if (email && (hasSuppression({ db: globalSuppressionDb, value: email, valueType: 'email' })
      || hasSuppression({ db: listDb, value: email, valueType: 'email' }))) {
      return { blocked: true, reason: 'email_suppressed' };
    }

    const verification = channelsConfig?.email?.verification || {};
    // Only enforce verification when explicitly configured — an absent verification
    // section means the operator hasn't set up verification yet, not that it's required.
    const required = verification.required === true;
    const statuses = Array.isArray(verification.gate_statuses) && verification.gate_statuses.length > 0
      ? verification.gate_statuses
      : ['valid', 'risky'];
    const actual = String(
      primaryContact?.email_verification_status
      || extra.email_verification_status
      || record.email_verification_status
      || ''
    ).toLowerCase();

    if (required && !statuses.map((s) => String(s).toLowerCase()).includes(actual)) {
      return { blocked: true, reason: 'email_verification_gate_failed' };
    }
  }

  if (intent.uses_phone) {
    const contactDnc = isAffirmativeFlag(primaryContact?.dnc_phone, { failClosed: true });
    if (isAffirmativeFlag(record.dnc_phone, { failClosed: true }) || contactDnc) {
      return { blocked: true, reason: 'dnc_phone' };
    }
    if (intent.uses_sms && isAffirmativeFlag(record.do_not_sms, { failClosed: true })) {
      return { blocked: true, reason: 'do_not_sms' };
    }
    const phone = String(primaryContact?.phone || record.phone || '').trim();
    if (phone && (hasSuppression({ db: globalSuppressionDb, value: phone, valueType: 'phone' })
      || hasSuppression({ db: listDb, value: phone, valueType: 'phone' }))) {
      return { blocked: true, reason: 'phone_suppressed' };
    }
  }

  if (intent.uses_mail) {
    if (isAffirmativeFlag(record.mail_suppressed, { failClosed: true })) {
      return { blocked: true, reason: 'mail_suppressed' };
    }
    const verificationRequired = Boolean(channelsConfig?.mail?.address_verification?.required);
    const allowedStatuses = Array.isArray(channelsConfig?.mail?.address_verification?.gate_statuses)
      ? channelsConfig.mail.address_verification.gate_statuses.map((v) => String(v || '').toLowerCase()).filter(Boolean)
      : ['valid'];
    if (verificationRequired) {
      const actual = String(record.address_verification_status || '').toLowerCase();
      if (!actual || !allowedStatuses.includes(actual)) {
        return { blocked: true, reason: 'address_verification_gate_failed' };
      }
    }

    const addressRaw = [
      String(record.address || '').trim().toLowerCase(),
      String(record.city || '').trim().toLowerCase(),
      String(record.state || '').trim().toLowerCase(),
      String(record.zip || '').trim().toLowerCase(),
    ].filter(Boolean).join(', ');
    const addressHash = addressRaw ? stableHash(addressRaw) : '';
    if (addressHash && (
      hasSuppression({ db: globalSuppressionDb, value: addressHash, valueType: 'address_hash' })
      || hasSuppression({ db: listDb, value: addressHash, valueType: 'address_hash' })
    )) {
      return { blocked: true, reason: 'address_suppressed' };
    }
    if (addressRaw && (
      hasSuppression({ db: globalSuppressionDb, value: addressRaw, valueType: 'address' })
      || hasSuppression({ db: listDb, value: addressRaw, valueType: 'address' })
    )) {
      return { blocked: true, reason: 'address_suppressed' };
    }
  }

  if (intent.uses_visit && isAffirmativeFlag(record.dnk_visit, { failClosed: true })) return { blocked: true, reason: 'dnk_visit' };
  return { blocked: false, reason: '' };
};

const evaluateStepCondition = async ({ db, listDir, record, conditionText, stepKey, aiConfig = {}, model = '' }) => {
  const structured = evaluateStructuredCondition({ conditionText, record });
  if (structured.matched !== null) {
    return {
      outcome: structured.matched ? 'pass' : 'skip',
      reason: structured.reason || '',
      source: structured.source,
    };
  }

  const recordId = getRecordRowId(record);
  const row = { ...record, ...parseExtra(record.extra_json) };
  const llm = await evaluateConditionAction({
    conditionText,
    row,
    stepOutput: {},
    aiConfig,
    model,
  });
  recordCostEvent({
    db,
    listDir,
    recordId,
    stepId: `sequence:condition:${stepKey}`,
    model: String((llm as any)?.model || ''),
    provider: String((llm as any)?.provider || ''),
    usage: llm.usage,
  });

  return {
    outcome: llm.defer ? 'defer' : (llm.passed ? 'pass' : 'skip'),
    reason: llm.reason || '',
    source: 'llm',
  };
};

const applyDeferPolicy = ({ record, step, stepNumber, today, steps, timing }) => {
  const extra = parseExtra(record.extra_json);
  if (!extra.defer_state) extra.defer_state = {};
  const key = String(step?.id || stepNumber);
  const existing = extra.defer_state[key] || {};
  const deferText = String(step?.defer || '').trim();

  const firstDeferredAt = existing.first_deferred_at || today;
  const waitDays = parseWaitDays(deferText || '14d');
  const deadline = existing.deadline || addDays(firstDeferredAt, waitDays);
  const timedOut = today > deadline;

  if (!timedOut) {
    const timeoutPolicy = parseTimeoutPolicy(deferText);
    extra.defer_state[key] = {
      first_deferred_at: firstDeferredAt,
      deadline,
      timeout_policy: timeoutPolicy,
      last_seen_at: today,
    };

    return {
      row: {
        ...record,
        extra_json: extra,
        next_action_date: addDays(today, 1),
        sequence_status: 'active',
        last_error: `Deferred by condition until ${deadline}`,
      },
      autoSkippedSteps: [],
    };
  }

  const policy = parseTimeoutPolicy(deferText);
  if (policy === 'fail_record') {
    extra.defer_state[key] = { ...extra.defer_state[key], timed_out_at: today, resolved: 'failed' };
    return {
      row: {
        ...record,
        extra_json: extra,
        sequence_status: 'blocked',
        next_action_date: '',
        last_error: `Deferred condition timed out (${key}).`,
      },
      autoSkippedSteps: [],
    };
  }

  if (policy === 'mark_blocked') {
    extra.defer_state[key] = { ...extra.defer_state[key], timed_out_at: today, resolved: 'blocked' };
    return {
      row: {
        ...record,
        extra_json: extra,
        sequence_status: 'blocked',
        next_action_date: '',
        last_error: `Condition deferred timeout -> blocked (${key}).`,
      },
      autoSkippedSteps: [],
    };
  }

  // skip_step default
  extra.defer_state[key] = { ...extra.defer_state[key], timed_out_at: today, resolved: 'skipped' };
  const advanced = advanceAfterCompletedStep({
    record,
    completedStepNumber: stepNumber,
    steps,
    timing,
    today,
    lastError: `Condition timeout, step skipped (${key}).`,
  });
  return {
    row: {
      ...advanced.row,
      extra_json: extra,
    },
    autoSkippedSteps: advanced.autoSkippedSteps,
  };
};

export const runSequencer = async ({
  listDir,
  sequenceName = '',
  dryRun = false,
  sample = 0,
  now,
}: {
  listDir: string;
  sequenceName?: string;
  dryRun?: boolean;
  sample?: number;
  /** Logical clock for due/wait gating (defaults to wall clock). */
  now?: string | Date;
} = {} as any) => {
  // Canary isolation: refuse unscoped sequence mutations against dirty prod corpus.
  const canaryConfig = dryRun
    ? loadCanaryConfig({ listDir })
    : assertListAccessForMutation(listDir);

  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) throw new Error(`Invalid config: ${errors.join('; ')}`);
  assertPhaseModelReferences({ config, phase: 'sequence' });

  const sequenceFilter = String(sequenceName || '').trim();
  const holdingNames = holdingSequenceNames(config);
  if (sequenceFilter && !holdingNames.has(sequenceFilter)) getSequence(config, sequenceFilter);

  const db = openListDb({ listDir, readonly: false });
  const { logicalNow, today } = resolveSequencerClock({
    now,
    timeZone: config?.operations?.timezone,
  });
  const sampleLimit = Math.max(0, Number(sample || 0));
  const scope = sequenceScope({ sequenceName: sequenceFilter, holdingNames });
  const sequenceState = (() => {
    try {
      // Prefer collectDueRecords so wait due_at / sequence_state honor logical `now`.
      const records = collectDueRecords({
        db,
        limit: sampleLimit,
        sequenceName: sequenceFilter,
        holdingNames,
        now: logicalNow,
        today,
        timeZone: config?.operations?.timezone,
        config,
        listDir,
        canaryConfig,
      });
      // When sample is 0, collectDueRecords returns all due; still partition.
      const allScoped = sampleLimit > 0
        ? records
        : filterRecordsForCanary(
          db.prepare(`
            SELECT * FROM records
            WHERE ${inPlayWhere()}
              ${scope.sql}
            ORDER BY updated_at DESC
          `).all(...scope.params).filter((r) => (
            !recordUsesPipelineSequence({ config, record: r })
            && shouldExecuteSequenceOutbound(r, logicalNow, {
              today,
              timeZone: config?.operations?.timezone,
            }).execute
          )),
          canaryConfig,
        );
      const finalRecords = sampleLimit > 0 ? records : allScoped;
      return { records: finalRecords, partition: partitionRecordsBySequence({ config, records: finalRecords }) };
    } catch (error) {
      db.close();
      throw error;
    }
  })();
  const records = sequenceState.records;
  const sequenceGroups = sequenceState.partition.groups;
  const sequenceFailureIds = new Set(
    sequenceState.partition.invalid.map((failure) => getRecordRowId(failure.record)),
  );

  const summary = {
    records: records.length,
    steps: sequenceGroups.reduce((total, group) => total + group.steps.length, 0),
    replies: 0,
    engaged: 0,
    opted_out: 0,
    executed: 0,
    deferred: 0,
    drafted: 0,
    awaiting_approval: 0,
    skipped: 0,
    failed: 0,
    routes_created: 0,
    route_stops: 0,
    errors: [],
  };

  persistSequenceDataFailures({
    db,
    failures: sequenceState.partition.invalid,
    summary,
    persist: !dryRun,
  });
  const globalSuppressionDb = dryRun ? null : (() => {
    try {
      return openGlobalSuppressionDb({ readonly: false });
    } catch (error) {
      db.close();
      throw error;
    }
  })();
  // AO_SEQUENCER_NO_MCP=1: validation/harness path — real sequencer writes without MCP poll.
  const skipMcp = dryRun
    || String(process.env.AO_SEQUENCER_NO_MCP || '').trim() === '1'
    || String(process.env.AO_PIPELINE_FIXTURE || '').trim() === '1';
  const mcp = skipMcp
    ? null
    : await getMcpClient().catch((error) => {
      db.close();
      globalSuppressionDb?.close();
      throw error;
    });
  const toolCatalog = skipMcp ? {} : readToolCatalog(listDir);

  emitActivity({ event: 'phase_start', phase: 'sequence', rows: records.length, steps: summary.steps });

  try {
    if (dryRun) {
      const dryRunNow = `${today}T12:00:00.000Z`;
      const dryRunCounts = sequenceGroups.reduce((counts, group) => (
        group.records.reduce((groupCounts, record) => {
          if (record.sequence_status === 'completed' || record.sequence_status === 'opted_out') return groupCounts;
          // next_action_json / account_sequence_state gate (not only sequence_step integers)
          if (!shouldExecuteSequenceOutbound(record, dryRunNow, {
            today,
            timeZone: config?.operations?.timezone,
          }).execute) return groupCounts;
          const { step } = resolveDueStep({ record, steps: group.steps, today });
          return {
            due: groupCounts.due + (step ? 1 : 0),
            completed: groupCounts.completed
              + (Number(record.sequence_step || 0) >= group.steps.length && group.steps.length > 0 ? 1 : 0),
          };
        }, counts)
      ), { due: 0, completed: 0 });
      emitActivity({ event: 'phase_complete', phase: 'sequence', processed: 0, skipped: records.length, failed: 0 });
      return {
        ...summary,
        dry_run: true,
        due_records: dryRunCounts.due,
        completed_records: dryRunCounts.completed,
        note: 'Dry-run executes no writes and does not dispatch routes/messages.',
      };
    }

    const visitCandidates = [];
    const pendingVisitExecutions = [];

    const inboundSummary = await runImapInboundPoll({ db, listDir, config });
    summary.replies = inboundSummary.replies;
    summary.engaged = inboundSummary.replies;
    summary.opted_out = 0;

    if (mcp) {
      await runDeliveryPoll({ mcp, db, listDir, config });
    }

    // Must re-apply canary filter — never re-query the full production due set.
    const freshRecords = collectDueRecords({
      db,
      limit: sampleLimit,
      sequenceName: sequenceFilter,
      holdingNames,
      now: logicalNow,
      today,
      timeZone: config?.operations?.timezone,
      config,
      listDir,
      canaryConfig,
    });
    const freshPartition = partitionRecordsBySequence({ config, records: freshRecords });
    const newSequenceFailures = freshPartition.invalid.filter(
      (failure) => !sequenceFailureIds.has(getRecordRowId(failure.record)),
    );
    newSequenceFailures.forEach((failure) => sequenceFailureIds.add(getRecordRowId(failure.record)));
    persistSequenceDataFailures({
      db,
      failures: newSequenceFailures,
      summary,
    });
    const freshGroups = freshPartition.groups;

    for (const group of freshGroups) {
      const activeSequenceName = group.name;
      const sequence = group.sequence;
      const steps = group.steps;
      const timing = group.timing;
      const stepIntentCache = new Map();
      await mapWithConcurrency<any, void>(group.records as any[], async (record) => {
      const recordId = getRecordRowId(record);
      if (record.sequence_status === 'opted_out' || record.sequence_status === 'completed') {
        summary.skipped += 1;
        return;
      }

      // Consume next_action_json + account_sequence_state so policy succession is honored.
      // Record-level: phone next_action keeps the account in play (mail independence).
      const outboundGate = shouldExecuteSequenceOutbound(record, logicalNow);
      if (!outboundGate.execute) {
        upsertRecord({
          db,
          row: {
            ...record,
            last_error: `sequence_outbound_gated: ${outboundGate.reason}`,
          },
        });
        summary.skipped += 1;
        return;
      }

      const { step, stepNumber } = resolveDueStep({ record, steps, today, db });
      if (!step) {
        if (Number(record.sequence_step || 0) >= steps.length && steps.length > 0) {
          upsertRecord({ db, row: { ...record, sequence_status: 'completed', next_action_date: '' } });
        }
        summary.skipped += 1;
        return;
      }

      const stepIntent = await classifyStepIntent({
        db,
        listDir,
        step,
        cache: stepIntentCache,
        aiConfig: config?.ai || {},
      });

      const gate = checkSuppressionGate({
        intent: stepIntent,
        record,
        primaryContact: getPrimaryContact({ db, recordId }),
        extra: parseExtra(record.extra_json),
        globalSuppressionDb,
        listDb: db,
        channelsConfig: config.channels || {},
      });

      if (gate.blocked) {
        // Gate-blocked records keep their current sequence_status — gate blocks are
        // per-step, not terminal. The record will be re-evaluated next run.
        // Only write last_error so the operator can inspect why it was skipped.
        upsertRecord({ db, row: { ...record, last_error: `gate_blocked: ${gate.reason}` } });
        summary.skipped += 1;
        return;
      }

      if (String(step?.condition || '').trim()) {
        const decision = await evaluateStepCondition({
          db,
          listDir,
          record,
          conditionText: step.condition,
          stepKey: step.id || stepNumber,
          aiConfig: config?.ai || {},
        });

        if (decision.outcome === 'skip') {
          const advanced = advanceAfterCompletedStep({
            record,
            completedStepNumber: stepNumber,
            steps,
            timing,
            today,
            lastError: `Condition skipped step: ${decision.reason}`,
          });
          upsertRecord({
            db,
            row: advanced.row,
          });
          summary.skipped += 1 + advanced.autoSkippedSteps.length;
          return;
        }

        if (decision.outcome === 'defer') {
          const deferred = applyDeferPolicy({ record, step, stepNumber, today, steps, timing });
          upsertRecord({ db, row: deferred.row });
          summary.deferred += 1;
          summary.skipped += deferred.autoSkippedSteps.length;
          return;
        }
      }

      if (stepIntent.uses_visit) {
        visitCandidates.push({
          ...record,
          visit_scheduled_date: today,
        });
        pendingVisitExecutions.push({
          recordId,
          sequenceName: activeSequenceName,
          sequence,
          stepNumber,
          step: {
            ...step,
            day: getStepDay(step),
          },
          channelHint: stepIntent.uses_mail ? 'mail' : (stepIntent.uses_visit ? 'visit' : 'manual'),
        });
        return;
      }

      const stepDescriptionText = String(step?.description || '').toLowerCase();
      const templateResolved = resolveStepTemplate({ config, step, record }) || null;
      const executableStep = templateResolved
        ? {
          ...step,
          description: templateResolved.rendered_description || String(step?.description || ''),
          config: {
            ...(step?.config || {}),
            template_context: {
              template_id: templateResolved.template_id,
              template_version: templateResolved.template_version,
              subject: templateResolved.subject,
              body: templateResolved.body,
              variables: templateResolved.variables,
            },
          },
        }
        : step;
      const channelHint = stepIntent.uses_email
        ? 'email'
        : (stepIntent.uses_mail
          ? 'mail'
          : (stepIntent.uses_phone
            ? ((stepIntent.uses_sms || stepDescriptionText.includes('sms') || stepDescriptionText.includes('text')) ? 'sms' : 'call')
            : 'manual'));
      const approvalRequired = stepIntent.uses_email && step?.draft_approval_required !== false;
      const readyDraft = approvalRequired
        ? db.prepare(`
          SELECT draft_id
          FROM drafts
          WHERE row_id = ?
            AND sequence_name = ?
            AND step_number = ?
            AND status = 'ready'
          ORDER BY updated_at DESC
          LIMIT 1
        `).get(recordId, activeSequenceName, stepNumber)
        : null;
      const pendingDraft = approvalRequired && !readyDraft
        ? db.prepare(`
          SELECT draft_id
          FROM drafts
          WHERE row_id = ?
            AND sequence_name = ?
            AND step_number = ?
            AND status = 'pending_approval'
          ORDER BY updated_at DESC
          LIMIT 1
        `).get(recordId, activeSequenceName, stepNumber)
        : null;
      if (pendingDraft) {
        summary.awaiting_approval += 1;
        summary.skipped += 1;
        upsertRecord({ db, row: { ...record, last_error: 'Awaiting draft approval.' } });
        return;
      }
      const sequenceIntent: 'send' | 'draft' = approvalRequired && !readyDraft ? 'draft' : 'send';

      const result = await executeChannelStep({
        mcp,
        listDir,
        listName: config?.list?.name || '',
        toolCatalog,
        db,
        record,
        sequenceName: activeSequenceName,
        stepNumber,
        step: {
          ...executableStep,
          day: getStepDay(executableStep),
        },
        sequence,
        aiConfig: config?.ai || {},
        dryRun,
        intent: sequenceIntent,
        channelHint,
      });

      if (result.status === 'sent') {
        if (sequenceIntent === 'draft') summary.drafted += 1;
        else summary.executed += 1;
        summary.skipped += Array.isArray(result.auto_skipped_steps) ? result.auto_skipped_steps.length : 0;
        emitActivity({ event: 'row_complete', phase: 'sequence', row: record.business_name || recordId, step: step.id || stepNumber });
      } else if (result.status === 'skipped') {
        // Optional phone capacity park: advance cursor past phone when no later step
        // depends on it so independent mail can become due next tick without waiting
        // for call-board completion. Park remains open for the operator.
        if (
          !dryRun
          && (result.parked || String(result.reason || '') === 'awaiting_manual')
          && isOptionalPhoneCapacityStep(step)
          && !laterStepsDependOn(steps, String(step.id || ''))
        ) {
          const advanced = advanceAfterCompletedStep({
            record,
            completedStepNumber: stepNumber,
            steps,
            timing,
            today,
            lastError: 'phone_parked_cursor_advanced_for_independent_channels',
          });
          upsertRecord({ db, row: advanced.row });
        }
        summary.skipped += 1;
      } else {
        summary.failed += 1;
        summary.errors.push({ record_id: recordId, step: step.id || stepNumber, error: result.reason || 'failed' });
      }
      }, 3);
    }

    const routeSummary = await planVisitRoutesIfNeeded({
      mcp,
      db,
      listDir,
      config,
      visitCandidates,
      today,
      aiConfig: config?.ai || {},
    });

    summary.routes_created = routeSummary.routes_created;
    summary.route_stops = routeSummary.stops;

    for (const pending of pendingVisitExecutions) {
      const liveRecord = db.prepare('SELECT * FROM records WHERE _row_id = ? OR id = ? LIMIT 1')
        .get(pending.recordId, pending.recordId);
      if (!liveRecord) {
        summary.failed += 1;
        summary.errors.push({ record_id: pending.recordId, step: pending.step.id || pending.stepNumber, error: 'record_not_found' });
        continue;
      }

      const result = await executeChannelStep({
        mcp,
        listDir,
        listName: config?.list?.name || '',
        toolCatalog,
        db,
        record: liveRecord,
        sequenceName: pending.sequenceName,
        stepNumber: pending.stepNumber,
        step: pending.step,
        sequence: pending.sequence,
        aiConfig: config?.ai || {},
        dryRun,
        channelHint: pending.channelHint,
      });

      if (result.status === 'sent') {
        summary.executed += 1;
        summary.skipped += Array.isArray(result.auto_skipped_steps) ? result.auto_skipped_steps.length : 0;
        emitActivity({
          event: 'row_complete',
          phase: 'sequence',
          row: liveRecord.business_name || pending.recordId,
          step: pending.step.id || pending.stepNumber,
        });
      } else if (result.status === 'skipped') {
        summary.skipped += 1;
      } else {
        summary.failed += 1;
        summary.errors.push({ record_id: pending.recordId, step: pending.step.id || pending.stepNumber, error: result.reason || 'failed' });
      }
    }

    emitActivity({
      event: 'phase_complete',
      phase: 'sequence',
      executed: summary.executed,
      deferred: summary.deferred,
      failed: summary.failed,
      replies: summary.replies,
    });

    return summary;
  } finally {
    db.close();
    globalSuppressionDb?.close();
  }
};

export const getSequenceStatus = ({ listDir }) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    const byStatus = db.prepare(`
      SELECT sequence_status as status, COUNT(*) as count
      FROM records
      WHERE ${inPlayWhere()}
      GROUP BY sequence_status
      ORDER BY count DESC
    `).all();

    const dueToday = db.prepare(`
      SELECT COUNT(*) as count
      FROM records
      WHERE ${inPlayWhere()} AND sequence_status = 'active' AND next_action_date != '' AND next_action_date <= ?
    `).get(todayIsoDate());

    const drafts = db.prepare(`
      SELECT COUNT(*) as count
      FROM drafts
      WHERE status = 'pending_approval'
    `).get();

    const replies24h = db.prepare(`
      SELECT COUNT(*) as count
      FROM records
      WHERE ${inPlayWhere()} AND email_last_reply_at != '' AND email_last_reply_at >= datetime('now', '-1 day')
    `).get();
    const duplicateReviews = db.prepare(`
      SELECT COUNT(*) as count
      FROM records
      WHERE ${inPlayWhere()} AND duplicate_status = 'needs_review'
    `).get();

    return {
      by_status: byStatus,
      due_today: Number(dueToday?.count || 0),
      drafts_pending: Number(drafts?.count || 0),
      replies_24h: Number(replies24h?.count || 0),
      duplicates_needs_review: Number(duplicateReviews?.count || 0),
    };
  } finally {
    db.close();
  }
};

export const launchDraft = async ({ listDir, sequenceName = '', limit = 50 }) => {
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) throw new Error(`Invalid config: ${errors.join('; ')}`);
  assertPhaseModelReferences({ config, phase: 'sequence' });

  const sequenceFilter = String(sequenceName || '').trim();
  const holdingNames = holdingSequenceNames(config);
  if (sequenceFilter && !holdingNames.has(sequenceFilter)) getSequence(config, sequenceFilter);
  const db = openListDb({ listDir, readonly: false });
  try {
    assertListAccessForMutation(listDir);
    const canaryConfig = loadCanaryConfig({ listDir });
    const scope = sequenceScope({ sequenceName: sequenceFilter, holdingNames });
    // Filter allowlist BEFORE applying LIMIT so excluded rows cannot starve canary rows.
    const rawRecords = db.prepare(`
      SELECT * FROM records
      WHERE sequence_status = 'idle' AND ${inPlayWhere()}
        ${scope.sql}
      ORDER BY COALESCE(fit_score, priority_rank) DESC, updated_at DESC
    `).all(...scope.params);
    const records = filterRecordsForCanary(rawRecords, canaryConfig)
      .slice(0, Math.max(0, Number(limit) || 50));
    const partition = partitionRecordsBySequence({ config, records });
    const groups = partition.groups;
    const summary = { drafted: 0, scheduled: 0, skipped: 0, failed: 0, errors: [] };
    persistSequenceDataFailures({ db, failures: partition.invalid, summary });
    if (groups.length === 0) return summary;
    const mcp = await getMcpClient();
    const toolCatalog = readToolCatalog(listDir);
    const launchToday = toZonedIsoDate(new Date(), config?.operations?.timezone) || todayIsoDate();
    for (const group of groups) {
      const activeSequenceName = group.name;
      const sequence = group.sequence;
      const firstStep = group.steps[0];
      if (!firstStep) {
        summary.skipped += group.records.length;
        continue;
      }
      const launchIntent = await classifyStepIntent({
        db,
        listDir,
        step: firstStep,
        cache: new Map(),
        aiConfig: config?.ai || {},
      });
      const launchChannelHint = resolveLaunchChannelHint({ step: firstStep, intent: launchIntent });
      const launchMode = launchIntent.uses_email ? 'draft' : 'send';
      for (const record of group.records) {
      const recordId = getRecordRowId(record);
      try {
        const enrollment = reconcileSequenceReachability({ db, record });
        if (!enrollment.reachable) {
          summary.skipped += 1;
          continue;
        }
        const enrolledRecord = enrollment.record;
        if (launchMode !== 'draft') {
          const launchDecision = getLaunchDecision({ sequence, firstStep, today: launchToday });
          if ('skip' in launchDecision.filtered) {
            const advancement = computeNextScheduledAction({
              steps: sequence.steps || [],
              completedStepNumber: 1,
              launchedAtDate: launchDecision.launchBaseDate,
              workingDays: launchDecision.timing.workingDays,
              policy: launchDecision.timing.policy,
              timeZone: launchDecision.timing.timeZone,
            });
            upsertRecord({
              db,
              row: {
                ...enrolledRecord,
                sequence_name: activeSequenceName,
                sequence_step: advancement.sequenceStep,
                launched_at: toLaunchTimestamp(launchDecision.launchBaseDate),
                next_action_date: advancement.nextActionDate,
                sequence_status: advancement.completed ? 'completed' : 'active',
                last_error: 'Launch step skipped by non_working_day_policy.',
              },
            });
            summary.skipped += 1 + advancement.skippedStepNumbers.length;
            continue;
          }

          if (launchDecision.filtered.date > launchToday) {
            upsertRecord({
              db,
              row: {
                ...enrolledRecord,
                sequence_name: activeSequenceName,
                next_action_date: launchDecision.filtered.date,
                sequence_status: 'idle',
                last_error: `Launch shifted to ${launchDecision.filtered.date} by non_working_day_policy.`,
              },
            });
            summary.scheduled += 1;
            continue;
          }
        }

        const templateResolved = resolveStepTemplate({ config, step: firstStep, record: enrolledRecord }) || null;
        const executableStep = templateResolved
          ? {
            ...firstStep,
            description: templateResolved.rendered_description || String(firstStep?.description || ''),
            config: {
              ...(firstStep?.config || {}),
              template_context: {
                template_id: templateResolved.template_id,
                template_version: templateResolved.template_version,
                subject: templateResolved.subject,
                body: templateResolved.body,
                variables: templateResolved.variables,
              },
            },
          }
          : firstStep;

        const result = await executeChannelStep({
          mcp,
          listDir,
          listName: config?.list?.name || '',
          toolCatalog,
          db,
          record: enrolledRecord,
          sequenceName: activeSequenceName,
          stepNumber: 1,
          step: {
            ...executableStep,
            day: getStepDay(executableStep),
          },
          sequence,
          aiConfig: config?.ai || {},
          dryRun: false,
          intent: launchMode,
          channelHint: launchChannelHint,
        });

        if (result.status === 'sent') {
          if (launchMode === 'draft') {
            const latest = db.prepare('SELECT * FROM records WHERE id = ? OR _row_id = ?').get(recordId, recordId);
            upsertRecord({
              db,
              row: {
                ...latest,
                sequence_status: 'idle',
                sequence_step: 0,
                next_action_date: '',
                launched_at: '',
              },
            });
          }
          summary.skipped += Array.isArray(result.auto_skipped_steps) ? result.auto_skipped_steps.length : 0;
          summary.drafted += 1;
        } else if (result.status === 'skipped' && /^channel_not_permitted:/i.test(String(result.reason || ''))) {
          summary.skipped += 1 + (Array.isArray(result.auto_skipped_steps) ? result.auto_skipped_steps.length : 0);
        } else {
          summary.failed += 1;
          summary.errors.push({ record_id: recordId, error: result.reason || result.status });
        }
      } catch (error) {
        if (isBudgetExceededError(error)) throw error;
        summary.failed += 1;
        summary.errors.push({ record_id: recordId, error: String(error?.message || error) });
      }
      }
    }

    return summary;
  } finally {
    db.close();
  }
};

export const launchSend = async ({ listDir, limit = 50 }) => {
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) throw new Error(`Invalid config: ${errors.join('; ')}`);
  assertPhaseModelReferences({ config, phase: 'sequence' });

  const db = openListDb({ listDir, readonly: false });
  try {
    assertListAccessForMutation(listDir);
    const canaryConfig = loadCanaryConfig({ listDir });
    const holdingNames = holdingSequenceNames(config);
    const scope = sequenceScope({ holdingNames });
    // Filter allowlist BEFORE LIMIT so excluded rows cannot starve canary selection.
    const rawRows = db.prepare(`
      SELECT * FROM records
      WHERE ${inPlayWhere()} AND sequence_status = 'idle'
        ${scope.sql}
      ORDER BY COALESCE(fit_score, priority_rank) DESC, updated_at DESC
    `).all(...scope.params);
    const rows = filterRecordsForCanary(rawRows, canaryConfig)
      .slice(0, Math.max(0, Number(limit) || 50));
    const summary = { sent: 0, scheduled: 0, skipped: 0, failed: 0, errors: [] };
    const partition = partitionRecordsBySequence({ config, records: rows });
    const groups = partition.groups;
    persistSequenceDataFailures({ db, failures: partition.invalid, summary });
    const launchableGroups = groups.map((group) => {
      const firstStep = group.steps[0];
      const channel = firstStep ? declaredLaunchChannel(firstStep) : null;
      if (channel !== 'email' && channel !== 'linkedin' && channel !== 'mail') return group;
      const records = group.records.filter((row) => {
        const launchSuppression = evaluateTransmitterSuppression({ db, record: row, channel });
        if (launchSuppression.blocked) {
          upsertRecord({ db, row: { ...row, last_error: `gate_blocked: ${launchSuppression.reason}` } });
          summary.skipped += 1;
          return false;
        }
        return true;
      });
      return { ...group, records };
    }).filter((group) => group.records.length > 0);
    if (launchableGroups.length === 0) return { ...summary, requested_limit: Number(limit) };
    const mcp = await getMcpClient();
    const toolCatalog = readToolCatalog(listDir);
    const launchToday = toZonedIsoDate(new Date(), config?.operations?.timezone) || todayIsoDate();
    for (const group of launchableGroups) {
      const activeSequenceName = group.name;
      const sequence = group.sequence;
      const firstStep = group.steps[0];
      if (!firstStep) {
        summary.skipped += group.records.length;
        continue;
      }
      const launchIntent = await classifyStepIntent({
        db,
        listDir,
        step: firstStep,
        cache: new Map(),
        aiConfig: config?.ai || {},
      });
      const launchChannelHint = resolveLaunchChannelHint({ step: firstStep, intent: launchIntent });
      const launchSuppressionChannel: 'email' | 'linkedin' | 'mail' | null = (
        launchChannelHint === 'email' || launchChannelHint === 'linkedin' || launchChannelHint === 'mail'
          ? launchChannelHint
          : null
      );
      const launchableRecords = launchSuppressionChannel
        ? group.records.filter((row) => {
          const launchSuppression = evaluateTransmitterSuppression({
            db,
            record: row,
            channel: launchSuppressionChannel,
          });
          if (launchSuppression.blocked) {
            upsertRecord({ db, row: { ...row, last_error: `gate_blocked: ${launchSuppression.reason}` } });
            summary.skipped += 1;
            return false;
          }
          return true;
        })
        : group.records;

      for (const row of launchableRecords) {
        try {
          const enrollment = reconcileSequenceReachability({ db, record: row });
          if (!enrollment.reachable) {
            summary.skipped += 1;
            continue;
          }
          const enrolledRow = enrollment.record;
          const readyDraft = launchIntent.uses_email
            ? db.prepare(`
              SELECT draft_id
              FROM drafts
              WHERE row_id = ?
                AND sequence_name = ?
                AND step_number = 1
                AND status = 'ready'
              ORDER BY updated_at DESC
              LIMIT 1
            `).get(getRecordRowId(enrolledRow), activeSequenceName)
            : null;
          if (launchIntent.uses_email && !readyDraft) {
            summary.skipped += 1;
            continue;
          }

          const launchDecision = getLaunchDecision({ sequence, firstStep, today: launchToday });
          if ('skip' in launchDecision.filtered) {
            const advancement = computeNextScheduledAction({
              steps: sequence.steps || [],
              completedStepNumber: 1,
              launchedAtDate: launchDecision.launchBaseDate,
              workingDays: launchDecision.timing.workingDays,
              policy: launchDecision.timing.policy,
              timeZone: launchDecision.timing.timeZone,
            });
            upsertRecord({
              db,
              row: {
                ...enrolledRow,
                sequence_name: activeSequenceName,
                sequence_step: advancement.sequenceStep,
                launched_at: toLaunchTimestamp(launchDecision.launchBaseDate),
                next_action_date: advancement.nextActionDate,
                sequence_status: advancement.completed ? 'completed' : 'active',
                last_error: 'Launch step skipped by non_working_day_policy.',
              },
            });
            summary.skipped += 1 + advancement.skippedStepNumbers.length;
            continue;
          }

          if (launchDecision.filtered.date > launchToday) {
            upsertRecord({
              db,
              row: {
                ...enrolledRow,
                sequence_name: activeSequenceName,
                next_action_date: launchDecision.filtered.date,
                sequence_status: 'idle',
                last_error: `Launch shifted to ${launchDecision.filtered.date} by non_working_day_policy.`,
              },
            });
            summary.scheduled += 1;
            continue;
          }

          const templateResolved = resolveStepTemplate({ config, step: firstStep, record: enrolledRow }) || null;
          const executableStep = templateResolved
            ? {
              ...firstStep,
              description: templateResolved.rendered_description || String(firstStep?.description || ''),
              config: {
                ...(firstStep?.config || {}),
                template_context: {
                  template_id: templateResolved.template_id,
                  template_version: templateResolved.template_version,
                  subject: templateResolved.subject,
                  body: templateResolved.body,
                  variables: templateResolved.variables,
                },
              },
            }
            : firstStep;

          const result = await executeChannelStep({
            mcp,
            listDir,
            listName: config?.list?.name || '',
            toolCatalog,
            db,
            record: enrolledRow,
            sequenceName: activeSequenceName,
            stepNumber: 1,
            step: {
              ...executableStep,
              day: getStepDay(executableStep),
            },
            sequence,
            aiConfig: config?.ai || {},
            dryRun: false,
            intent: 'send',
            channelHint: launchChannelHint,
          });

          if (result.status === 'sent') {
            summary.sent += 1;
            summary.skipped += Array.isArray(result.auto_skipped_steps) ? result.auto_skipped_steps.length : 0;
          } else if (result.status === 'skipped' && /^channel_not_permitted:/i.test(String(result.reason || ''))) {
            summary.skipped += 1 + (Array.isArray(result.auto_skipped_steps) ? result.auto_skipped_steps.length : 0);
          } else {
            summary.failed += 1;
            summary.errors.push({ record_id: getRecordRowId(row), error: result.reason || result.status });
          }
        } catch (error) {
          if (isBudgetExceededError(error)) throw error;
          summary.failed += 1;
          summary.errors.push({ record_id: getRecordRowId(row), error: String(error?.message || error) });
        }
      }
    }

    return { ...summary, requested_limit: Number(limit) };
  } finally {
    db.close();
  }
};

export const followupSend = async ({ listDir, limit = 50 }) => {
  const result = await runSequencer({ listDir, dryRun: false });
  return {
    ...result,
    requested_limit: Number(limit),
    note: 'Follow-up send executes due sequence steps through the sequencer.',
  };
};

export const logOutcome = ({ listDir, prospect, action, note = '', transition = '', followUpIn = '' }) => {
  const db = openListDb({ listDir, readonly: false });
  const globalSuppressionDb = openGlobalSuppressionDb({ readonly: false });
  try {
    const search = `%${String(prospect || '').toLowerCase()}%`;
    const matches = db.prepare(`
      SELECT * FROM records
      WHERE ${inPlayWhere()} AND (lower(business_name) LIKE ? OR lower(id) LIKE ? OR lower(_row_id) LIKE ? OR lower(email_primary) LIKE ?)
      LIMIT 5
    `).all(search, search, search, search);

    if (matches.length === 0) return { error: `No record found for prospect match "${prospect}".` };
    if (matches.length > 1) {
      return {
        error: `Multiple records match "${prospect}". Be more specific.`,
        matches: matches.map((row) => ({ id: getRecordRowId(row), business_name: row.business_name })),
      };
    }

    const row = matches[0];
    // Infer transition from action if not explicitly provided
    const normalizedAction = String(action || '').toLowerCase();
    const inferredTransition = transition
      ? String(transition).toLowerCase().trim()
      : (normalizedAction === 'opted_out' || normalizedAction === 'opt_out')
        ? 'opted_out'
        : (normalizedAction === 'talked_to_owner' || normalizedAction === 'booked_meeting' || normalizedAction === 'meeting_booked')
          ? 'engaged'
          : (normalizedAction === 'not_a_fit')
            ? 'opted_out'
            : '';
    const normalizedTransition = inferredTransition;

    // Reject unknown transitions loudly — never report status:updated when the
    // requested transition cannot be applied.
    if (normalizedTransition && !LOG_ACCEPTED_TRANSITIONS.has(normalizedTransition)) {
      const accepted = [...LOG_ACCEPTED_TRANSITIONS].sort().join(', ');
      return {
        ok: false,
        status: 'error',
        error: `Unknown transition "${normalizedTransition}". Accepted transitions: ${accepted}.`,
      };
    }

    const updated: Record<string, unknown> = {
      ...row,
      outcome: String(action || ''),
      disposition_latest: String(action || ''),
      disposition_follow_up_at: followUpIn ? addDays(nowIso().slice(0, 10), parseWaitDays(followUpIn)) : String(row.disposition_follow_up_at || ''),
      outcome_notes: [String(row.outcome_notes || ''), `[${nowIso().slice(0, 10)}] ${action}: ${note}`]
        .filter(Boolean)
        .join('\n'),
      outcome_at: nowIso(),
    };

    // lifecycle_stage axis: any accepted lifecycle vocabulary value writes the field.
    // sequence_status is a separate axis (handled below for the four sequence transitions).
    if (normalizedTransition && (LIFECYCLE_STAGES as readonly string[]).includes(normalizedTransition)) {
      ensureRecordColumns({ db, columns: ['lifecycle_stage'] });
      updated.lifecycle_stage = normalizedTransition;
    }

    // sequence_status axis — load-bearing safety behaviour for opt-out / bounce.
    if (normalizedTransition === 'engaged') {
      updated.sequence_status = 'engaged';
      updated.next_action_date = '';
    } else if (normalizedTransition === 'opted_out') {
      updated.sequence_status = 'opted_out';
      updated.suppressed = 1;
      updated.suppressed_reason = 'opt_out';
      updated.suppressed_at = nowIso();
    } else if (normalizedTransition === 'bounced') {
      updated.sequence_status = 'bounced';
      updated.suppressed = 1;
      updated.suppressed_reason = 'hard_bounce';
      updated.suppressed_at = nowIso();
    } else if (normalizedTransition === 'completed') {
      updated.sequence_status = 'completed';
      updated.next_action_date = '';
    }

    // Call-board dispositions must close open phone parks and rotate contacts.
    // Terminal dispositions complete the manual_tail so the successor can start.
    const terminalCallBoard = /^(no_answer|left_voicemail|not_interested|wrong_number|gatekeeper|callback|talked_to_owner|booked_meeting|meeting_booked|completed|not_a_fit|opted_out|opt_out)$/i
      .test(normalizedAction);
    let parkClosed: string | null = null;
    let rotationResult: { rotated: boolean; active_contact_id?: string | null } | null = null;
    if (terminalCallBoard) {
      try {
        const recordId = getRecordRowId(row);
        const activeContactId = String(row.active_contact_id || row.contact_id || '').trim();
        // Ensure contact_id column exists for contact-scoped completion.
        try { db.exec("ALTER TABLE pipeline_events ADD COLUMN contact_id TEXT DEFAULT ''"); } catch { /* */ }
        const openPark = db.prepare(`
          SELECT event_id, step_id, contact_id FROM pipeline_events
          WHERE record_id = ? AND kind = 'manual_task'
            AND passed = 0 AND reason = 'awaiting_manual'
            AND (
              lower(step_id) LIKE '%phone%'
              OR lower(step_id) LIKE '%call%'
              OR lower(step_id) LIKE '%manual_tail%'
            )
            ${activeContactId ? "AND (contact_id = ? OR contact_id IS NULL OR contact_id = '')" : ''}
          ORDER BY occurred_at DESC LIMIT 1
        `).get(...(activeContactId ? [recordId, activeContactId] : [recordId])) as
          | { event_id?: string; step_id?: string; contact_id?: string }
          | undefined;
        if (openPark?.step_id) {
          parkClosed = String(openPark.step_id);
          db.prepare(`
            INSERT INTO pipeline_events (
              event_id, record_id, step_id, kind, passed, reason, contact_id, occurred_at
            ) VALUES (?, ?, ?, 'manual_task', 1, ?, ?, ?)
          `).run(
            randomUUID(),
            recordId,
            parkClosed,
            `call_board:${normalizedAction}`,
            activeContactId,
            nowIso(),
          );
          // Rotate after manual-tail completion when not opted out / engaged.
          if (!['engaged', 'opted_out'].includes(normalizedTransition)) {
            const rotation = applyContactRotation(updated, {
              reason: `call_board_disposition:${normalizedAction}`,
            });
            if (rotation.rotated && rotation.active_contact_id) {
              rotationResult = {
                rotated: true,
                active_contact_id: rotation.active_contact_id,
              };
              updated.active_contact_id = rotation.active_contact_id;
              updated.contact_id = rotation.active_contact_id;
              updated.sequence_step = 0;
              updated.sequence_status = 'idle';
              // 3 business-day quiet period before successor contact outreach.
              const quiet = addDays(nowIso().slice(0, 10), 3);
              updated.next_action_date = quiet;
              updated.next_action_json = JSON.stringify({
                type: 'contact_rotation',
                active_contact_id: rotation.active_contact_id,
                previous_contact_id: rotation.previous_contact_id,
                quiet_until: quiet,
                reason: `call_board:${normalizedAction}`,
              });
              if (rotation.account_contact_plan_json) {
                updated.account_contact_plan_json = rotation.account_contact_plan_json;
              }
            } else if (!rotation.rotated) {
              updated.sequence_status = updated.sequence_status || 'completed';
              updated.contact_campaign_status = 'exhausted';
            }
          }
        }
      } catch {
        /* park close / rotation best-effort — disposition still records */
      }
    }

    upsertRecord({ db, row: updated });

    insertChannelEvent({
      db,
      event: {
        id: randomUUID(),
        record_id: getRecordRowId(row),
        channel: 'operator',
        action: 'outcome_logged',
        disposition: String(action || ''),
        contact_id: String(updated.active_contact_id || row.active_contact_id || ''),
        payload: {
          note,
          transition,
          follow_up_in: followUpIn || '',
          ...(parkClosed ? { park_closed: parkClosed } : {}),
          ...(rotationResult ? { rotation: rotationResult } : {}),
        },
        occurred_at: nowIso(),
      },
    });

    if (isAffirmativeFlag(updated.suppressed, { failClosed: true }) && updated.email_primary) {
      const suppressionEntry = {
        id: randomUUID(),
        value: updated.email_primary,
        value_type: 'email',
        scope: 'global',
        reason: updated.suppressed_reason || 'opt_out',
        source: 'log_outcome',
        record_id: getRecordRowId(updated),
      };
      addSuppression({ db, entry: suppressionEntry });
      addSuppression({ db: globalSuppressionDb, entry: suppressionEntry });
    }

    return {
      status: 'updated',
      record_id: getRecordRowId(updated),
      sequence_status: updated.sequence_status,
      lifecycle_stage: updated.lifecycle_stage ?? row.lifecycle_stage ?? '',
      suppressed: isAffirmativeFlag(updated.suppressed, { failClosed: true }),
    };
  } finally {
    db.close();
    globalSuppressionDb.close();
  }
};
