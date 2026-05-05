import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  addSuppression,
  getPrimaryContact,
  hasSuppression,
  insertChannelEvent,
  openGlobalSuppressionDb,
  openListDb,
  upsertRecord,
} from '../runtime/db.js';
import { readConfig } from '../lib/config.js';
import { getRecordRowId, stableHash, todayIsoDate } from '../lib/record.js';
import { executeChannelStep } from '../channels/execute.js';
import { evaluateConditionAction } from '../actions/evaluate-condition/index.js';
import { planRouteAction } from '../actions/plan-route/index.js';
import { emitActivity } from '../runtime/activity.js';
import { recordCostEvent } from '../lib/costs.js';
import { getMcpClient } from '../runtime/mcp.js';
import { runDeliveryPoll, runReplyPoll } from '../runtime/polling.js';
import { generateObjectWithTools } from '../runtime/llm.js';
import { assertToolSpecAvailable } from '../runtime/mcp.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { readToolCatalog } from '../lib/tool-catalog.js';
import {
  addIsoDays,
  applyWorkingDaysFilter,
  computeNextScheduledAction,
  resolveWorkingDayConfig,
  toIsoDate,
} from '../lib/working-days.js';
import { evaluateStructuredCondition } from '../lib/sequence-conditions.js';
import { resolveStepTemplate } from '../lib/templates.js';
import { isBudgetExceededError } from '../runtime/contract.js';
import { assertPhaseModelReferences } from '../lib/model-validation.js';

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

const getSequence = (config, name = 'default') => {
  const sequences = config?.sequences || {};
  return sequences[name] || sequences.default || { steps: [] };
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
  const filtered = applyWorkingDaysFilter({
    isoDate: launchBaseDate,
    workingDays: timing.workingDays,
    policy: timing.policy,
  });
  return { timing, launchBaseDate, filtered };
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

const resolveDueStep = ({ record, steps, today }) => {
  const next = Number(record.sequence_step || 0) + 1;
  const step = steps[next - 1];
  if (!step) return { step: null, stepNumber: next };

  const dueDate = String(record.next_action_date || '').trim();
  if (!dueDate || dueDate <= today) return { step, stepNumber: next };
  return { step: null, stepNumber: next };
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
  if (record.suppressed) return { blocked: true, reason: 'record_suppressed' };

  if (intent.uses_email) {
    const contactDne = Number(primaryContact?.dne_email || 0) > 0;
    if (record.dne_email || contactDne) return { blocked: true, reason: 'dne_email' };
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
    const contactDnc = Number(primaryContact?.dnc_phone || 0) > 0;
    if (record.dnc_phone || contactDnc) {
      return { blocked: true, reason: 'dnc_phone' };
    }
    if (intent.uses_sms && Number(record.do_not_sms || 0) > 0) {
      return { blocked: true, reason: 'do_not_sms' };
    }
    const phone = String(primaryContact?.phone || record.phone || '').trim();
    if (phone && (hasSuppression({ db: globalSuppressionDb, value: phone, valueType: 'phone' })
      || hasSuppression({ db: listDb, value: phone, valueType: 'phone' }))) {
      return { blocked: true, reason: 'phone_suppressed' };
    }
  }

  if (intent.uses_mail) {
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

  if (intent.uses_visit && record.dnk_visit) return { blocked: true, reason: 'dnk_visit' };
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

export const runSequencer = async ({ listDir, sequenceName = 'default', dryRun = false, sample = 0 }) => {
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) throw new Error(`Invalid config: ${errors.join('; ')}`);
  assertPhaseModelReferences({ config, phase: 'sequence' });

  const sequence = getSequence(config, sequenceName);
  const steps = Array.isArray(sequence?.steps) ? sequence.steps : [];
  const timing = resolveWorkingDayConfig(sequence);

  const db = openListDb({ listDir, readonly: false });
  const globalSuppressionDb = openGlobalSuppressionDb({ readonly: false });
  const mcp = dryRun ? null : await getMcpClient();
  const toolCatalog = dryRun ? {} : readToolCatalog(listDir);

  const today = todayIsoDate();
  const sampleLimit = Math.max(0, Number(sample || 0));
  const records = db.prepare(`
    SELECT * FROM records
    ORDER BY updated_at DESC
    ${sampleLimit > 0 ? `LIMIT ${sampleLimit}` : ''}
  `).all();

  const summary = {
    records: records.length,
    steps: steps.length,
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

  emitActivity({ event: 'phase_start', phase: 'sequence', rows: records.length, steps: steps.length });

  try {
    if (dryRun) {
      let due = 0;
      let completed = 0;
      for (const record of records) {
        if (record.sequence_status === 'completed' || record.sequence_status === 'opted_out') continue;
        const { step } = resolveDueStep({ record, steps, today });
        if (step) due += 1;
        if (Number(record.sequence_step || 0) >= steps.length && steps.length > 0) completed += 1;
      }
      emitActivity({ event: 'phase_complete', phase: 'sequence', processed: 0, skipped: records.length, failed: 0 });
      return {
        ...summary,
        dry_run: true,
        due_records: due,
        completed_records: completed,
        note: 'Dry-run executes no writes and does not dispatch routes/messages.',
      };
    }

    const stepIntentCache = new Map();
    const visitCandidates = [];
    const pendingVisitExecutions = [];

    const replySummary = await runReplyPoll({
      mcp,
      db,
      globalSuppressionDb,
      listDir,
      config,
    });
    summary.replies = replySummary.replied;
    summary.engaged = replySummary.engaged;
    summary.opted_out = replySummary.opted_out;

    await runDeliveryPoll({ mcp, db, listDir, config });

    const freshRecords = db.prepare(`
      SELECT * FROM records
      ORDER BY updated_at DESC
      ${sampleLimit > 0 ? `LIMIT ${sampleLimit}` : ''}
    `).all();

    await mapWithConcurrency<any, void>(freshRecords as any[], async (record) => {
      const recordId = getRecordRowId(record);
      if (record.sequence_status === 'opted_out' || record.sequence_status === 'completed') {
        summary.skipped += 1;
        return;
      }

      const { step, stepNumber } = resolveDueStep({ record, steps, today });
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
      let sequenceIntent: 'send' | 'draft' = 'send';
      if (stepIntent.uses_email && step?.draft_approval_required !== false) {
        const readyDraft = db.prepare(`
          SELECT draft_id
          FROM drafts
          WHERE row_id = ?
            AND sequence_name = ?
            AND step_number = ?
            AND status = 'ready'
          ORDER BY updated_at DESC
          LIMIT 1
        `).get(recordId, sequenceName, stepNumber);
        const pendingDraft = db.prepare(`
          SELECT draft_id
          FROM drafts
          WHERE row_id = ?
            AND sequence_name = ?
            AND step_number = ?
            AND status = 'pending_approval'
          ORDER BY updated_at DESC
          LIMIT 1
        `).get(recordId, sequenceName, stepNumber);
        if (readyDraft) {
          sequenceIntent = 'send';
        } else if (pendingDraft) {
          summary.awaiting_approval += 1;
          summary.skipped += 1;
          upsertRecord({ db, row: { ...record, last_error: 'Awaiting draft approval.' } });
          return;
        } else {
          sequenceIntent = 'draft';
        }
      }

      const result = await executeChannelStep({
        mcp,
        listDir,
        listName: config?.list?.name || '',
        toolCatalog,
        db,
        record,
        sequenceName,
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
        summary.skipped += 1;
      } else {
        summary.failed += 1;
        summary.errors.push({ record_id: recordId, step: step.id || stepNumber, error: result.reason || 'failed' });
      }
    }, 3);

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
        sequenceName,
        stepNumber: pending.stepNumber,
        step: pending.step,
        sequence,
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
    globalSuppressionDb.close();
  }
};

export const getSequenceStatus = ({ listDir }) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    const byStatus = db.prepare(`
      SELECT sequence_status as status, COUNT(*) as count
      FROM records
      GROUP BY sequence_status
      ORDER BY count DESC
    `).all();

    const dueToday = db.prepare(`
      SELECT COUNT(*) as count
      FROM records
      WHERE sequence_status = 'active' AND next_action_date != '' AND next_action_date <= ?
    `).get(todayIsoDate());

    const drafts = db.prepare(`
      SELECT COUNT(*) as count
      FROM drafts
      WHERE status = 'pending_approval'
    `).get();

    const replies24h = db.prepare(`
      SELECT COUNT(*) as count
      FROM records
      WHERE email_last_reply_at != '' AND email_last_reply_at >= datetime('now', '-1 day')
    `).get();
    const duplicateReviews = db.prepare(`
      SELECT COUNT(*) as count
      FROM records
      WHERE duplicate_status = 'needs_review'
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

export const launchDraft = async ({ listDir, sequenceName = 'default', limit = 50 }) => {
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) throw new Error(`Invalid config: ${errors.join('; ')}`);
  assertPhaseModelReferences({ config, phase: 'sequence' });

  const sequence = getSequence(config, sequenceName);
  const firstStep = (sequence.steps || [])[0];
  if (!firstStep) throw new Error(`Sequence "${sequenceName}" has no steps.`);

  const db = openListDb({ listDir, readonly: false });
  const mcp = await getMcpClient();
  const toolCatalog = readToolCatalog(listDir);
  const records = db.prepare(`
    SELECT * FROM records
    WHERE sequence_status = 'idle'
    ORDER BY priority_rank DESC, updated_at DESC
    LIMIT ?
  `).all(Number(limit));

  const summary = { drafted: 0, scheduled: 0, skipped: 0, failed: 0, errors: [] };
  const launchIntent = await classifyStepIntent({
    db,
    listDir,
    step: firstStep,
    cache: new Map(),
    aiConfig: config?.ai || {},
  });
  const launchChannelHint = launchIntent.uses_email
    ? 'email'
    : (launchIntent.uses_mail
      ? 'mail'
      : (launchIntent.uses_sms ? 'sms' : (launchIntent.uses_call ? 'call' : (launchIntent.uses_visit ? 'visit' : 'manual'))));
  const launchMode = launchIntent.uses_email ? 'draft' : 'send';
  const launchToday = todayIsoDate();

  try {
    for (const record of records) {
      const recordId = getRecordRowId(record);
      try {
        if (launchMode !== 'draft') {
          const launchDecision = getLaunchDecision({ sequence, firstStep, today: launchToday });
          if ('skip' in launchDecision.filtered) {
            const advancement = computeNextScheduledAction({
              steps: sequence.steps || [],
              completedStepNumber: 1,
              launchedAtDate: launchDecision.launchBaseDate,
              workingDays: launchDecision.timing.workingDays,
              policy: launchDecision.timing.policy,
            });
            upsertRecord({
              db,
              row: {
                ...record,
                sequence_name: sequenceName,
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
                ...record,
                sequence_name: sequenceName,
                next_action_date: launchDecision.filtered.date,
                sequence_status: 'idle',
                last_error: `Launch shifted to ${launchDecision.filtered.date} by non_working_day_policy.`,
              },
            });
            summary.scheduled += 1;
            continue;
          }
        }

        const templateResolved = resolveStepTemplate({ config, step: firstStep, record }) || null;
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
          record,
          sequenceName,
          stepNumber: 1,
          step: {
            ...executableStep,
            day: getStepDay(executableStep),
            config: {
              ...(executableStep.config || {}),
              idempotency: null,
            },
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

    return summary;
  } finally {
    db.close();
  }
};

export const launchSend = async ({ listDir, limit = 50 }) => {
  const { config, errors } = readConfig(listDir);
  if (errors.length > 0) throw new Error(`Invalid config: ${errors.join('; ')}`);
  assertPhaseModelReferences({ config, phase: 'sequence' });
  const sequence = getSequence(config, 'default');
  const firstStep = (sequence.steps || [])[0];
  if (!firstStep) throw new Error('Default sequence has no step 1 to send.');

  const db = openListDb({ listDir, readonly: false });
  const mcp = await getMcpClient();
  const toolCatalog = readToolCatalog(listDir);
  try {
    const launchIntent = await classifyStepIntent({
      db,
      listDir,
      step: firstStep,
      cache: new Map(),
      aiConfig: config?.ai || {},
    });
    const launchChannelHint = launchIntent.uses_email
      ? 'email'
      : (launchIntent.uses_mail
        ? 'mail'
        : (launchIntent.uses_sms ? 'sms' : (launchIntent.uses_call ? 'call' : (launchIntent.uses_visit ? 'visit' : 'manual'))));
    const launchFilterSql = launchIntent.uses_email
      ? `sequence_status = 'idle'
         AND EXISTS (
           SELECT 1 FROM drafts d
           WHERE d.row_id = records._row_id
             AND d.sequence_name = 'default'
             AND d.step_number = 1
             AND d.status = 'ready'
         )`
      : "sequence_status = 'idle'";

    const rows = db.prepare(`
      SELECT * FROM records
      WHERE ${launchFilterSql}
      ORDER BY priority_rank DESC, updated_at DESC
      LIMIT ?
    `).all(Number(limit));

    let sent = 0;
    let scheduled = 0;
    let skipped = 0;
    let failed = 0;
    const errorsOut = [];
    const launchToday = todayIsoDate();
    for (const row of rows) {
      try {
        const launchDecision = getLaunchDecision({ sequence, firstStep, today: launchToday });
        if ('skip' in launchDecision.filtered) {
          const advancement = computeNextScheduledAction({
            steps: sequence.steps || [],
            completedStepNumber: 1,
            launchedAtDate: launchDecision.launchBaseDate,
            workingDays: launchDecision.timing.workingDays,
            policy: launchDecision.timing.policy,
          });
          upsertRecord({
            db,
            row: {
              ...row,
              sequence_name: 'default',
              sequence_step: advancement.sequenceStep,
              launched_at: toLaunchTimestamp(launchDecision.launchBaseDate),
              next_action_date: advancement.nextActionDate,
              sequence_status: advancement.completed ? 'completed' : 'active',
              last_error: 'Launch step skipped by non_working_day_policy.',
            },
          });
          skipped += 1 + advancement.skippedStepNumbers.length;
          continue;
        }

        if (launchDecision.filtered.date > launchToday) {
          upsertRecord({
            db,
            row: {
              ...row,
              sequence_name: 'default',
              next_action_date: launchDecision.filtered.date,
              sequence_status: 'idle',
              last_error: `Launch shifted to ${launchDecision.filtered.date} by non_working_day_policy.`,
            },
          });
          scheduled += 1;
          continue;
        }

        const templateResolved = resolveStepTemplate({ config, step: firstStep, record: row }) || null;
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
          record: row,
          sequenceName: 'default',
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
          sent += 1;
          skipped += Array.isArray(result.auto_skipped_steps) ? result.auto_skipped_steps.length : 0;
        } else {
          failed += 1;
          errorsOut.push({ record_id: getRecordRowId(row), error: result.reason || result.status });
        }
      } catch (error) {
        if (isBudgetExceededError(error)) throw error;
        failed += 1;
        errorsOut.push({ record_id: getRecordRowId(row), error: String(error?.message || error) });
      }
    }

    return { sent, scheduled, skipped, failed, errors: errorsOut, requested_limit: Number(limit) };
  } finally {
    db.close();
  }
};

export const followupSend = async ({ listDir, limit = 50 }) => {
  const result = await runSequencer({ listDir, sequenceName: 'default', dryRun: false });
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
      WHERE lower(business_name) LIKE ? OR lower(id) LIKE ? OR lower(_row_id) LIKE ? OR lower(email_primary) LIKE ?
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
      ? String(transition).toLowerCase()
      : (normalizedAction === 'opted_out' || normalizedAction === 'opt_out')
        ? 'opted_out'
        : (normalizedAction === 'talked_to_owner' || normalizedAction === 'booked_meeting' || normalizedAction === 'meeting_booked')
          ? 'engaged'
          : (normalizedAction === 'not_a_fit')
            ? 'opted_out'
            : '';
    const normalizedTransition = inferredTransition;

    const updated = {
      ...row,
      outcome: String(action || ''),
      disposition_latest: String(action || ''),
      disposition_follow_up_at: followUpIn ? addDays(new Date().toISOString().slice(0, 10), parseWaitDays(followUpIn)) : String(row.disposition_follow_up_at || ''),
      outcome_notes: [String(row.outcome_notes || ''), `[${new Date().toISOString().slice(0, 10)}] ${action}: ${note}`]
        .filter(Boolean)
        .join('\n'),
      outcome_at: new Date().toISOString(),
    };

    if (normalizedTransition === 'engaged') {
      updated.sequence_status = 'engaged';
      updated.next_action_date = '';
    } else if (normalizedTransition === 'opted_out') {
      updated.sequence_status = 'opted_out';
      updated.suppressed = 1;
      updated.suppressed_reason = 'opt_out';
      updated.suppressed_at = new Date().toISOString();
    } else if (normalizedTransition === 'bounced') {
      updated.sequence_status = 'bounced';
      updated.suppressed = 1;
      updated.suppressed_reason = 'hard_bounce';
      updated.suppressed_at = new Date().toISOString();
    } else if (normalizedTransition === 'completed') {
      updated.sequence_status = 'completed';
      updated.next_action_date = '';
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
        payload: { note, transition, follow_up_in: followUpIn || '' },
        occurred_at: new Date().toISOString(),
      },
    });

    if (updated.suppressed && updated.email_primary) {
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
      suppressed: Boolean(updated.suppressed),
    };
  } finally {
    db.close();
    globalSuppressionDb.close();
  }
};
