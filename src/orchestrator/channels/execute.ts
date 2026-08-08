import { randomUUID } from 'node:crypto';
import {
  buildIdempotencyKey,
  claimIdempotency,
  completeIdempotency,
  failIdempotency,
  getIdempotencyRecord,
  reconcileIdempotencyProviderAccepted,
} from '../runtime/idempotency.js';
import {
  findAsset,
  insertChannelEvent,
  insertDraft,
  insertPipelineEvent,
  nowTimestamp,
  upsertRecord,
  updateDraft,
  ensureRecordColumns,
  ensureDraftColumns,
  projectContactOntoRecord,
} from '../runtime/db.js';
import { getRecordRowId } from '../lib/record.js';
import { executeStepAction } from '../actions/execute-step/index.js';
import { computeNextScheduledAction, resolveWorkingDayConfig, toIsoDate, toZonedIsoDate } from '../lib/working-days.js';
import { recordCostEvent } from '../lib/costs.js';
import { isBudgetExceededError } from '../runtime/contract.js';
import { readConfig } from '../lib/config.js';
import { resolveChannelProviderCredentials } from '../lib/channel-credentials.js';
import { countMailboxSendsToday, resolveSendMailbox, smtpCredentialEnv } from '../lib/mailboxes.js';
import {
  commitLiveInteraction,
  isSinkOrFixtureMode,
  recordUnbudgetedLiveInteraction,
  recordSinkInteraction,
  releaseLiveInteractionReservation,
  reserveLiveInteraction,
  resolveLiveInteractionBudget,
} from '../runtime/live-interaction-budget.js';
import {
  guardChannelExecution,
  assertWorkAllowed,
  advanceAfterSuccessfulAction,
  parseAccountCampaignFromRecord,
  assertActionTarget,
  hydrateActiveContactOntoRecord,
  projectActiveContactFields,
  resolveActiveContactEmailForSend,
  evaluateExternalActionAuthorization,
  resolveStageAssetVersion,
  isReviewRequired,
  pauseForStageReview,
  invalidateStageReviewIfAssetChanged,
  appendTransitionAudit,
  readinessChannelPermission,
  evaluateTransmitterSuppression,
  resolveReviewPresentation,
  type ResolvedReviewPresentation,
} from '../policy/index.js';
import { shouldExecuteSequenceOutbound } from '../policy/sequence-outbound.js';
import { reconcileSequenceReachability } from '../policy/sequence-reachability-reconcile.js';
import {
  applyLinkedinInviteSent,
  evaluateLinkedinConnectGate,
} from '../policy/linkedin-lifecycle.js';
import { assertOutboundContent } from '../lib/outbound-content.js';
import { resolveLinkedinInvitationMessage } from './unipile.js';

const linkedinBodyForReview = ({
  record,
  step,
}: {
  record: Record<string, unknown>;
  step?: { config?: Record<string, unknown> } | null;
}) => {
  const content = resolveLinkedinInvitationMessage({ record, step });
  return 'text' in content ? content.text : '';
};

/**
 * Material asset_version for the outbound about to execute.
 * Must match pause-time composition so account/contact/recipient/content/step
 * drift invalidates authorization (see resolveStageAssetVersion).
 */
const currentStageAssetVersion = ({
  record,
  stageId,
  assetForStep,
  draftId,
  policyVersion,
  recipient,
  bodyText,
  subjectText,
  activeContactId,
  reviewPresentation,
}: {
  record: Record<string, unknown>;
  stageId: string;
  assetForStep?: { asset_id?: string } | null;
  draftId?: string | null;
  policyVersion?: string | null;
  recipient?: string | null;
  bodyText?: string | null;
  subjectText?: string | null;
  activeContactId?: string | null;
  reviewPresentation?: ResolvedReviewPresentation | null;
}): string => {
  const accountId = String(record._row_id || record.id || record.account_id || '');
  const contact = String(
    activeContactId
    || record.active_contact_id
    || record.contact_id
    || '',
  ).trim();
  const to = String(
    recipient
    || record.contact_email
    || record.email
    || record.linkedin_url
    || record.contact_linkedin
    || record.address
    || '',
  ).trim();
  return resolveStageAssetVersion({
    accountId,
    activeContactId: contact || null,
    contactId: String(record.contact_id || '') || null,
    recipient: to || null,
    stepId: stageId,
    stageId,
    assetId: assetForStep?.asset_id ? String(assetForStep.asset_id) : null,
    draftId: draftId ?? null,
    policyVersion: policyVersion ?? null,
    bodyText: bodyText ?? null,
    subjectText: subjectText ?? null,
    reviewPresentation: reviewPresentation ?? null,
  });
};

/**
 * Persist a version-bound pending stage review and pause the sequence.
 * Used when policy.review_required_for gates an external action without authorization.
 */
const applyStageReviewPause = ({
  db,
  record,
  stageId,
  assetVersion,
  channel,
  actionType,
  contactId,
  reason,
  presentation,
}: {
  db: any;
  record: Record<string, unknown>;
  stageId: string;
  assetVersion: string;
  channel?: string | null;
  actionType: string;
  contactId?: string | null;
  reason: string;
  presentation?: ResolvedReviewPresentation | null;
}) => {
  const accountId = String(record._row_id || record.id || record.account_id || '');
  const lifecycle = String(record.lifecycle_stage || 'contacted');
  const pendingActionType = String(channel || '').trim().toLowerCase() === 'mail'
    ? 'send_mail'
    : actionType;
  const paused = pauseForStageReview({
    account_id: accountId,
    stage_id: stageId,
    asset_version: assetVersion,
    contact_id: contactId ?? null,
    channel: channel ?? null,
    action_type: actionType,
    pending_action: {
      action_type: pendingActionType,
      account_id: accountId,
      contact_id: contactId ?? null,
      lifecycle_stage: lifecycle,
      sequence_state: 'active',
      work_state: 'executing_external_action',
      reason: `resume after stage review ${stageId}`,
      on_success: 'wait_or_followup',
    },
    lifecycle_stage: lifecycle,
    reason,
    presentation: presentation ?? null,
  });
  const next: Record<string, unknown> = {
    ...record,
    ...paused.patch,
    transition_audit_json: appendTransitionAudit(record.transition_audit_json, paused.audit),
  };
  ensureRecordColumns({
    db,
    columns: [
      ...Object.keys(paused.patch),
      'transition_audit_json',
      'related_review_id',
    ],
  });
  upsertRecord({ db, row: next });
  return next;
};

/**
 * If authorized stage review is bound to a different material asset_version,
 * invalidate + re-pause and persist. Returns { record, blocked } — when blocked,
 * caller must not send (fail closed).
 */
const applyStageReviewMaterialInvalidation = ({
  db,
  record,
  stageId,
  currentAssetVersion,
  channel,
  actionType,
  contactId,
  presentation,
}: {
  db: any;
  record: Record<string, unknown>;
  stageId: string;
  currentAssetVersion: string;
  channel?: string | null;
  actionType: string;
  contactId?: string | null;
  presentation?: ResolvedReviewPresentation | null;
}): { record: Record<string, unknown>; blocked: boolean; reason?: string } => {
  const result = invalidateStageReviewIfAssetChanged({
    record,
    stage_id: stageId,
    current_asset_version: currentAssetVersion,
    account_id: String(record._row_id || record.id || record.account_id || ''),
    contact_id: contactId ?? null,
    channel: channel ?? null,
    action_type: actionType,
    lifecycle_stage: String(record.lifecycle_stage || 'contacted'),
    re_pause: true,
    presentation: presentation ?? null,
  });
  if (!result.invalidated || !result.patch) {
    return { record, blocked: false };
  }
  let auditJson = record.transition_audit_json;
  for (const audit of result.audits) {
    auditJson = appendTransitionAudit(auditJson, audit);
  }
  const next: Record<string, unknown> = {
    ...record,
    ...result.patch,
    transition_audit_json: auditJson,
  };
  ensureRecordColumns({
    db,
    columns: [
      ...Object.keys(result.patch),
      'transition_audit_json',
      'related_review_id',
    ],
  });
  upsertRecord({ db, row: next });
  return {
    record: next,
    blocked: true,
    reason: 'Stage review invalidated: asset changed; re-paused for review.',
  };
};

/** Map step/channel hints onto assertActionTarget's named-channel union. */
const namedAssertChannel = ({
  channelHint,
  stepKind,
  taskType,
  channel,
}: {
  channelHint?: string;
  stepKind?: string;
  taskType?: string;
  channel?: string;
}): 'email' | 'phone' | 'linkedin' | 'mail' | null => {
  const hay = `${channelHint || ''} ${stepKind || ''} ${taskType || ''} ${channel || ''}`.toLowerCase();
  if (hay.includes('linkedin')) return 'linkedin';
  // Prefer email over bare "mail" substring (email contains "mail").
  if (hay.includes('email') || hay.includes('send_email')) return 'email';
  if (/\bmail\b/.test(hay) || hay.includes('postcard') || hay.includes('golden_ticket')) return 'mail';
  if (hay.includes('phone') || hay.includes('call') || hay.includes('sms')) return 'phone';
  return null;
};

/**
 * After contact rotation (or any successful named send), re-project denormalized
 * contact_* from the active contact. Uses a direct DB write because upsertRecord
 * locks primary-projection fields against pipeline clobber.
 */
const applyActiveContactProjection = ({
  db,
  recordId,
  updatedRecord,
  contactId,
}: {
  db: any;
  recordId: string;
  updatedRecord: Record<string, unknown>;
  contactId?: string | null;
}) => {
  const targetId = String(contactId || updatedRecord.active_contact_id || '').trim();
  if (!targetId || !db) return;
  try {
    projectContactOntoRecord({ db, recordId, contactId: targetId });
  } catch {
    /* harness without contacts table */
  }
  const projected = projectActiveContactFields({
    db,
    contactId: targetId,
    rowId: recordId,
  });
  if (Object.keys(projected).length) {
    Object.assign(updatedRecord, projected);
  }
  updatedRecord.active_contact_id = targetId;
  updatedRecord.contact_id = targetId;
};

const inferEventChannel = ({ description, artifacts, outputs, channelHint }) => {
  const hinted = String(channelHint || '').trim().toLowerCase();
  if (hinted === 'email' || hinted === 'mail' || hinted === 'visit' || hinted === 'sms' || hinted === 'call') {
    return hinted;
  }
  if (hinted === 'phone') return 'call';
  const data = { ...(artifacts || {}), ...(outputs || {}) };
  if (data.thread_id || data.message_id || data.draft_id) return 'email';
  if (data.piece_id || data.expected_delivery_date) return 'mail';
  if (data.sms_message_id) return 'sms';
  if (data.call_disposition || data.call_id) return 'call';
  return 'manual';
};

const applyStepOutputs = ({ record, step, outputs }) => {
  const mapped = { ...(record || {}) };
  const declaredOutputs = (step?.config?.outputs && typeof step.config.outputs === 'object') ? step.config.outputs : {};
  for (const [field, def] of Object.entries(declaredOutputs)) {
    if (!(field in (outputs || {}))) continue;
    const type = String((def as any)?.type || 'string').trim().toLowerCase();
    const raw = (outputs || {})[field];
    if (raw === null || raw === undefined) {
      mapped[field] = type === 'string' ? '' : 0;
      continue;
    }
    if (type === 'boolean') {
      mapped[field] = raw ? 1 : 0;
      continue;
    }
    if (type === 'integer') {
      const num = Number(raw);
      mapped[field] = Number.isFinite(num) ? Math.round(num) : 0;
      continue;
    }
    if (type === 'number') {
      const num = Number(raw);
      mapped[field] = Number.isFinite(num) ? num : 0;
      continue;
    }
    mapped[field] = Array.isArray(raw) ? raw.map((v) => String(v)).join(', ') : (typeof raw === 'object' ? JSON.stringify(raw) : String(raw));
  }

  const columns = (step?.config?.columns && typeof step.config.columns === 'object') ? step.config.columns : {};
  for (const [outputField, columnName] of Object.entries(columns)) {
    const target = String(columnName || '').trim();
    if (!target || target in mapped) continue;
    if (!(outputField in (outputs || {}))) continue;
    const raw = (outputs || {})[outputField];
    mapped[target] = Array.isArray(raw) ? raw.map((v) => String(v)).join(', ') : (typeof raw === 'object' ? JSON.stringify(raw) : String(raw ?? ''));
  }
  return mapped;
};

const applyArtifactUpdates = ({
  record,
  artifacts,
  outputs,
  intent,
  persistEmailMessageId = true,
  existingEmailLastMessageId = '',
}) => {
  const next = { ...(record || {}) };
  const data = { ...(artifacts || {}), ...(outputs || {}) };

  const threadId = String(data.thread_id || data.provider_thread_id || '').trim();
  if (threadId) {
    next.email_thread_id = threadId;
    next.email_last_thread_id = threadId;
  }
  if (data.draft_id) {
    next.email_last_draft_id = String(data.draft_id);
  }
  const messageId = String(data.message_id || data.provider_message_id || data.provider_id || '').trim();
  if (intent !== 'draft' && messageId && persistEmailMessageId) {
    next.email_last_message_id = messageId;
  }
  if (!persistEmailMessageId) {
    next.email_last_message_id = existingEmailLastMessageId;
  }
  if (data.piece_id) {
    next.mail_last_piece_id = String(data.piece_id);
  }
  if (data.mail_cost_cents !== undefined) {
    next.mail_last_cost_cents = Number(data.mail_cost_cents || 0);
  }
  if (data.sms_message_id) {
    next.sms_last_message_id = String(data.sms_message_id);
  }
  if (data.call_disposition) {
    next.call_last_disposition = String(data.call_disposition);
  }
  return next;
};

const parseAssetOutputs = (value: unknown): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const outputString = (outputs: Record<string, unknown>, key: string) => (
  Object.prototype.hasOwnProperty.call(outputs, key) && outputs[key] !== null && outputs[key] !== undefined
    ? String(outputs[key])
    : ''
);

const assetDraftOverride = ({ asset, usesAssetId, stepArtifacts, stepOutputs }) => {
  const outputs = parseAssetOutputs(asset?.outputs_json);
  const reference = asset?.is_reference ? String(asset?.result || '').trim() : '';
  const subject = outputString(outputs, 'subject') || String(stepArtifacts.subject || stepOutputs.subject || '');
  const body = outputString(outputs, 'body') || String(asset?.result || '');
  return {
    subject,
    body,
    artifacts: {
      uses_asset: usesAssetId,
      asset_id: String(asset?.asset_id || ''),
      asset_step_id: String(asset?.step_id || ''),
      asset_status: String(asset?.status || ''),
      asset_outputs: outputs,
      ...(reference ? { reference, asset_url: reference } : {}),
    },
  };
};

const isBlankValue = (value: unknown): boolean => (
  value === undefined || value === null || String(value).trim() === ''
);

/**
 * Resolve tool-call arguments once from the same record the provider receives.
 * Drafts use this before review; sends freeze the approved draft afterward.
 */
const resolveToolCallArguments = ({
  stepConfig,
  record,
}: {
  stepConfig: Record<string, unknown>;
  record: Record<string, unknown>;
}): Record<string, unknown> => {
  const staticArgs = stepConfig.args && typeof stepConfig.args === 'object'
    ? stepConfig.args as Record<string, unknown>
    : {};
  const argsMap = stepConfig.args_map && typeof stepConfig.args_map === 'object'
    ? stepConfig.args_map as Record<string, string>
    : {};

  return Object.entries(argsMap).reduce<Record<string, unknown>>(
    (resolvedArgs, [argName, fieldName]) => {
      const value = record[String(fieldName || '').trim()];
      return isBlankValue(value)
        ? resolvedArgs
        : { ...resolvedArgs, [argName]: value };
    },
    { ...staticArgs },
  );
};

const firstContentValue = (...values: unknown[]): string => {
  const value = values.find((candidate) => !isBlankValue(candidate));
  return value === undefined ? '' : String(value);
};

export const executeChannelStep = async ({
  mcp,
  listDir,
  listName,
  toolCatalog,
  db,
  record,
  sequenceName,
  stepNumber,
  step,
  sequence,
  aiConfig = {},
  dryRun = false,
  intent = 'send',
  channelHint = '',
  now: suppliedNow,
}: any) => {
  const suppliedInstant = suppliedNow instanceof Date
    ? suppliedNow
    : suppliedNow
      ? new Date(String(suppliedNow))
      : null;
  const now = suppliedInstant && !Number.isNaN(suppliedInstant.getTime())
    ? suppliedInstant.toISOString()
    : nowTimestamp();
  const recordId = getRecordRowId(record);
  const sequenceStepId = String(step?.id || `step_${stepNumber}`);
  const deliveryState: { emailMode: 'live' | 'sink' | 'unlimited' | null } = { emailMode: null };

  // Canary isolation FIRST — before idempotency, models, tools, or providers.
  // A later DB guard is insufficient: SMTP sink / Unipile can already have fired.
  if (!dryRun && listDir && recordId) {
    const { assertRecordAccessForMutation } = await import('../policy/canary-isolation.js');
    assertRecordAccessForMutation({ listDir: String(listDir), recordId });
  }

  // Reachability is a current delivery fact. Resolve the active contact before
  // evaluating it so stale denormalized fields cannot keep an empty target active.
  const hydrated = hydrateActiveContactOntoRecord({ db, record });
  const reachableRecord = hydrated.record;
  const currentSequenceState = String(reachableRecord.account_sequence_state || '').trim().toLowerCase();
  if (currentSequenceState && currentSequenceState !== 'unreachable') {
    const preReachabilityGate = shouldExecuteSequenceOutbound(reachableRecord, now, {
      channel: String(channelHint || step?.config?.channel || '').trim(),
      stepKind: String(step?.kind || '').trim().toLowerCase(),
      taskType: String(step?.config?.task_type || step?.config?.taskType || '').trim(),
      timeZone: sequence?.timezone,
    });
    if (!preReachabilityGate.execute) {
      return {
        status: 'skipped',
        reason: `sequence_outbound_gated: ${preReachabilityGate.reason}`,
        provider_id: '',
        auto_skipped_steps: [],
      };
    }
  }
  const reachability = reconcileSequenceReachability({
    db,
    record: reachableRecord,
    persist: !dryRun,
  });
  if (!reachability.reachable) {
    return {
      status: 'skipped',
      reason: 'sequence_unreachable:no_reachable_contact',
      provider_id: '',
      auto_skipped_steps: [],
    };
  }

  const sequenceRecord = reachability.record;

  const usesAssetId = String(step?.uses_asset || '').trim();
  const assetForStep = usesAssetId ? findAsset({ db, rowId: recordId, stepId: usesAssetId }) : null;

  // Nested pipeline + sequencer share this chokepoint: never auto-send (or draft)
  // when account_sequence_state / next_action policy forbids outbound.
  // Mirrors sequencer/runner filter so paused_inbound|review|repair, recycle_wait,
  // completed, cancelled, and non-outbound next_action types cannot leak sends.
  // Channel-aware: phone park / next_action=phone does NOT block independent mail
  // (or email / linkedin) — Tier A/B mail depends_on email_2, not phone_1.
  const earlyStepKind = String(step?.kind || '').trim().toLowerCase();
  const earlyTaskType = String(step?.config?.task_type || step?.config?.taskType || '').trim();
  const earlyChannel = String(channelHint || step?.config?.channel || '').trim();
  const outboundGate = shouldExecuteSequenceOutbound(sequenceRecord, now, {
    channel: earlyChannel || namedAssertChannel({
      channelHint,
      stepKind: earlyStepKind,
      taskType: earlyTaskType,
      channel: earlyChannel,
    }),
    stepKind: earlyStepKind,
    taskType: earlyTaskType,
    timeZone: sequence?.timezone,
  });
  if (!outboundGate.execute) {
    return {
      status: 'skipped',
      reason: `sequence_outbound_gated: ${outboundGate.reason}`,
      provider_id: '',
      auto_skipped_steps: [],
    };
  }

  const readinessChannel = namedAssertChannel({
    channelHint,
    stepKind: earlyStepKind,
    taskType: earlyTaskType,
    channel: earlyChannel,
  });
  const readinessPermission = readinessChannel
    ? readinessChannelPermission({ record: sequenceRecord, channel: readinessChannel })
    : { computed: false, permitted: true };
  if (readinessPermission.computed && !readinessPermission.permitted) {
    const reason = `channel_not_permitted:${readinessChannel}`;
    const timing = resolveWorkingDayConfig({
      ...sequence,
      timezone: sequence?.timezone,
    });
    const launchedAt = String(record.launched_at || '').trim()
      || (Number(stepNumber) === 1 ? now : '');
    const launchedAtDate = toIsoDate(launchedAt) || toZonedIsoDate(now, timing.timeZone);
    const progression = computeNextScheduledAction({
      steps: Array.isArray(sequence?.steps) ? sequence.steps : [],
      completedStepNumber: Number(stepNumber || 0),
      launchedAtDate,
      workingDays: timing.workingDays,
      policy: timing.policy,
      timeZone: timing.timeZone,
    });
    if (!dryRun) {
      ensureRecordColumns({
        db,
        columns: [
          'sequence_name',
          'sequence_step',
          'sequence_status',
          'next_action_date',
          'launched_at',
          'last_error',
        ],
      });
      upsertRecord({
        db,
        row: {
          ...sequenceRecord,
          sequence_name: sequenceName,
          sequence_step: progression.sequenceStep,
          sequence_status: progression.completed ? 'completed' : 'active',
          next_action_date: progression.nextActionDate,
          launched_at: launchedAt,
          last_error: reason,
        },
      });
    }
    return {
      status: 'skipped',
      reason,
      provider_id: '',
      next_step: progression.sequenceStep + 1,
      auto_skipped_steps: progression.skippedStepNumbers,
    };
  }

  // Resolve campaign active contact onto denormalized fields before args_map /
  // templates / Unipile read contact_email (etc.). Seniority-primary projection
  // alone can be stale after rotation.
  const sendRecord = sequenceRecord;
  const activeContactId = hydrated.active_contact_id;

  // Early step/channel identity for pre-claim gates and idempotency pins.
  // Named channel must be known before claim so blank-email fail-closed does
  // not poison the key, and so multi-channel keys include channel.
  const stepKindEarly = String(step?.kind || '').trim().toLowerCase();
  const taskTypeEarly = String(step?.config?.task_type || step?.config?.taskType || '').trim();
  const channelEarly = String(channelHint || step?.config?.channel || '').trim();
  const assertChannelEarly = namedAssertChannel({
    channelHint,
    stepKind: stepKindEarly,
    taskType: taskTypeEarly,
    channel: channelEarly,
  });
  const idemChannelPin = assertChannelEarly
    || String(channelHint || step?.config?.channel || stepKindEarly || '').trim().toLowerCase()
    || '';

  // Email sends fail closed when the active contact has no email.
  // Contacts-table email is authoritative when the row exists — never soft-pass
  // via denormalized email_primary / stale seniority-primary contact_email.
  const isLiveEmailSend = intent === 'send'
    && !dryRun
    && (
      assertChannelEarly === 'email'
      || stepKindEarly === 'send_email'
      || String(channelHint || '').trim().toLowerCase() === 'email'
      || String(channelEarly || '').trim().toLowerCase() === 'email'
    );
  if (isLiveEmailSend && activeContactId) {
    const resolved = resolveActiveContactEmailForSend({
      contact: hydrated.contact,
      record: sendRecord,
    });
    if (!resolved.email) {
      const reason = hydrated.contact
        ? `Active contact ${activeContactId} has blank email (contacts table); refuse email send`
        : `Active contact ${activeContactId} has no email for send; refuse email send`;
      return {
        status: 'skipped',
        reason,
        provider_id: '',
        auto_skipped_steps: [],
      };
    }
  }

  const idemConfig = step?.config?.idempotency;
  const idemKeySource = Array.isArray(idemConfig?.key_source)
    ? idemConfig.key_source.filter((value: unknown) => String(value || '').trim() !== '')
    : [];
  // Build the key early for complete/fail paths, but claim exclusively only
  // immediately before a provider side-effect (after draft/review gates). Claiming
  // before gates left pending leases that blocked approve→send and concurrent
  // workers incorrectly.
  const idemKey = intent !== 'draft' && !dryRun && idemKeySource.length > 0
    ? (() => {
    const idemRecipient = String(
      resolveActiveContactEmailForSend({ record: sendRecord }).email
      || sendRecord.contact_email
      || sendRecord.email
      || '',
    ).trim().toLowerCase();
    const idemContentVer = String(
      sendRecord.email_last_body
      || '',
    ).trim().slice(0, 64);
    const key = buildIdempotencyKey({
      keySource: idemKeySource,
      record: sendRecord,
      scope: idemConfig.scope || 'list',
      context: {
        step_id: sequenceStepId,
        active_contact_id: activeContactId,
        contact_id: activeContactId,
        channel: idemChannelPin,
        recipient: idemRecipient,
        content_version: idemContentVer,
      },
    });
    return key.endsWith(':') ? '' : key;
  })()
    : '';
  if (idemKey) {
    // Fast path: already sent — skip without provider work.
    const existingIdem = getIdempotencyRecord({
      db,
      idemKey,
      scope: idemConfig.scope || 'list',
    });
    if (existingIdem?.status === 'sent') {
      return {
        status: 'skipped',
        reason: 'Already sent (idempotent).',
        provider_id: existingIdem.provider_id || '',
      };
    }
    if (existingIdem?.status === 'uncertain') {
      return {
        status: 'skipped',
        reason: 'Prior send provider-uncertain; reconcile before resend.',
        provider_id: existingIdem.provider_id || '',
      };
    }
  }

  /** Exclusive claim immediately before provider send. */
  const claimExclusiveSend = ():
    | { ok: true; claim_id: string }
    | { ok: false; result: Record<string, unknown> } => {
    if (dryRun || intent === 'draft') {
      return { ok: true, claim_id: '' };
    }
    if (!idemKey) {
      return {
        ok: false,
        result: {
          status: 'failed',
          reason: 'Idempotency key is required before an external send; refusing unprotected transmission.',
          provider_id: '',
          auto_skipped_steps: [],
        },
      };
    }
    // Production reconcile path: if a prior attempt already recorded a provider id
    // (SMTP/Unipile accepted) but status is still pending/failed after a lost response,
    // mark sent and skip re-send. Avoids duplicate delivery on retry.
    const priorIdem = getIdempotencyRecord({
      db,
      idemKey,
      scope: idemConfig?.scope || 'list',
    });
    if (priorIdem && (priorIdem.status === 'pending' || priorIdem.status === 'failed')) {
      const priorPid = String(priorIdem.provider_id || '').trim();
      let priorPayloadPid = '';
      try {
        const p = JSON.parse(String(priorIdem.payload_json || '{}'));
        priorPayloadPid = String(p?.provider_id || p?.message_id || '').trim();
      } catch { /* */ }
      const knownPid = priorPid || priorPayloadPid;
      if (knownPid) {
        const reconciled = reconcileIdempotencyProviderAccepted({
          db,
          idemKey,
          scope: idemConfig?.scope || 'list',
          providerId: knownPid,
          payload: { reconciled_from: priorIdem.status, source: 'pre_claim_provider_id' },
        });
        if (reconciled.reconciled || reconciled.reason === 'already_sent') {
          return {
            ok: false,
            result: {
              status: 'skipped',
              reason: 'Already sent (reconciled provider acceptance).',
              provider_id: knownPid,
              auto_skipped_steps: [],
            },
          };
        }
      }
    }
    const claimed = claimIdempotency({
      db,
      idemKey,
      scope: idemConfig?.scope || 'list',
      payload: {
        stepNumber,
        step_id: sequenceStepId,
        intent,
        active_contact_id: activeContactId,
        channel: idemChannelPin,
      },
    });
    if (!claimed.claimed && claimed.status === 'sent') {
      return {
        ok: false,
        result: {
          status: 'skipped',
          reason: 'Already sent (idempotent).',
          provider_id: claimed.provider_id || '',
          auto_skipped_steps: [],
        },
      };
    }
    if (!claimed.claimed) {
      return {
        ok: false,
        result: {
          status: 'skipped',
          reason: `Idempotency claim held (${claimed.reason || 'lease_held'}).`,
          provider_id: claimed.provider_id || '',
          auto_skipped_steps: [],
        },
      };
    }
    (sendRecord as any).__idempotency_claim_id = claimed.claim_id || '';
    return { ok: true, claim_id: claimed.claim_id || '' };
  };

  try {
    // Manual tasks never auto-complete: the operator must mark them done.
    const stepKind = stepKindEarly;
    const taskType = taskTypeEarly;
    const channel = channelEarly;

    // Project policy (review_required_for, enforce_readiness, prohibited channels).
    // Loaded once for all gates below so removing a review_required_for token changes behavior.
    // External sends fail closed when config cannot be loaded — never send without policy.
    let projectConfig: any;
    let configLoadFailed = false;
    try {
      projectConfig = readConfig(listDir)?.config;
    } catch {
      projectConfig = undefined;
      configLoadFailed = true;
    }
    if (configLoadFailed) {
      const isLinkedinExternal = stepKind === 'linkedin_connect';
      const isEmailExternal =
        intent === 'send'
        && (
          stepKind === 'send_email'
          || String(channel || '').trim().toLowerCase() === 'email'
          || String(channelHint || '').trim().toLowerCase() === 'email'
        );
      if (isLinkedinExternal || isEmailExternal) {
        return {
          status: 'skipped',
          reason: 'Policy config unavailable; external send blocked (fail-closed).',
          provider_id: '',
          auto_skipped_steps: [],
        };
      }
    }

    const liveInteractionBudget = resolveLiveInteractionBudget(projectConfig);
    const reserveProviderInteraction = ({ providerChannel }: { providerChannel: 'email' | 'linkedin' }) => {
      const idempotencyClaim = claimExclusiveSend();
      if (idempotencyClaim.ok === false) return idempotencyClaim;
      if (!liveInteractionBudget) return { ok: true, mode: 'unlimited' as const };
      if (isSinkOrFixtureMode(providerChannel)) return { ok: true, mode: 'sink' as const };
      try {
        const reservation = reserveLiveInteraction({
          db,
          budget: liveInteractionBudget,
          recordId,
          contactId: activeContactId,
          channel: providerChannel,
          stepId: sequenceStepId,
          at: now,
        });
        if (reservation.allowed) return { ok: true, mode: 'live' as const };
        if (idemKey) {
          failIdempotency({
            db,
            idemKey,
            scope: idemConfig?.scope || 'list',
            claimId: String((sendRecord as any).__idempotency_claim_id || ''),
            payload: {
              error: reservation.reason,
              stepNumber,
              step_id: sequenceStepId,
            },
          });
        }
        return {
          ok: false,
          result: {
            status: 'skipped',
            reason: 'live_interaction_budget_exhausted',
            provider_id: '',
            auto_skipped_steps: [],
          },
        };
      } catch {
        if (idemKey) {
          failIdempotency({
            db,
            idemKey,
            scope: idemConfig?.scope || 'list',
            claimId: String((sendRecord as any).__idempotency_claim_id || ''),
            payload: {
              error: 'live_interaction_budget_ledger_unreadable',
              stepNumber,
              step_id: sequenceStepId,
            },
          });
        }
        return {
          ok: false,
          result: {
            status: 'skipped',
            reason: 'live_interaction_budget_ledger_unreadable',
            provider_id: '',
            auto_skipped_steps: [],
          },
        };
      }
    };
    const releaseProviderInteraction = ({ mode }: { mode: 'live' | 'sink' | 'unlimited' }) => {
      if (mode !== 'live') return;
      releaseLiveInteractionReservation({
        db,
        recordId,
        contactId: activeContactId,
        stepId: sequenceStepId,
        at: now,
      });
    };
    const commitProviderInteraction = ({
      mode,
      providerChannel,
      providerId,
    }: {
      mode: 'live' | 'sink' | 'unlimited';
      providerChannel: 'email' | 'linkedin';
      providerId: string;
    }) => {
      if (mode === 'unlimited') {
        recordUnbudgetedLiveInteraction({
          db,
          recordId,
          contactId: activeContactId,
          channel: providerChannel,
          stepId: sequenceStepId,
          providerId,
          at: now,
        });
        return;
      }
      if (mode === 'sink') {
        recordSinkInteraction({
          db,
          recordId,
          contactId: activeContactId,
          channel: providerChannel,
          stepId: sequenceStepId,
          providerId,
          at: now,
        });
        return;
      }
      commitLiveInteraction({
        db,
        recordId,
        contactId: activeContactId,
        channel: providerChannel,
        stepId: sequenceStepId,
        providerId,
        at: now,
      });
    };

    // Pipeline-declared prohibited channels/work cannot be created.
    // When policy.enforce_readiness === true, also hard-blocks non-ready external sends
    // (send_email intent=send, linkedin_connect) — not drafts, dryRun, or manual parks.
    // Hydrate real production spend into the record so enrichment ceilings are live.
    let guardRecord = sendRecord;
    try {
      const rowId = String(sendRecord?._row_id || sendRecord?.id || '');
      if (db && rowId) {
        const { hydrateRecordCostLedger } = await import('../policy/cost-ledger.js');
        const costHydrate = hydrateRecordCostLedger({ db, recordId: rowId, record: sendRecord });
        guardRecord = { ...sendRecord, ...costHydrate.patch };
      }
    } catch {
      guardRecord = sendRecord;
    }
    const guard = guardChannelExecution({
      config: projectConfig,
      record: guardRecord,
      stepKind,
      taskType,
      channel,
      stepId: sequenceStepId,
      intent,
      dryRun,
    });
    if (!guard.allowed) {
      return {
        status: 'skipped',
        reason: guard.reason || 'Forbidden by outbound policy',
        provider_id: '',
        auto_skipped_steps: [],
        ...(Array.isArray(guard.blockers) && guard.blockers.length
          ? { readiness_blockers: guard.blockers }
          : {}),
      };
    }
    try {
      assertWorkAllowed({ policy: projectConfig?.policy, kind: stepKind, taskType, channel });
    } catch (err) {
      return {
        status: 'skipped',
        reason: String((err as Error)?.message || err),
        provider_id: '',
        auto_skipped_steps: [],
      };
    }

    // Named channel actions may only target the campaign active contact.
    // Mail is account-level (assert checks mail_allocated). Skip assert on pure
    // drafts — no external send — but still use hydrated fields for templates.
    // Email/linkedin/phone: require campaign or active contact — empty contact_id
    // must not soft-pass (assertActionTarget enforces contact_id when campaign present).
    const assertChannel = namedAssertChannel({ channelHint, stepKind, taskType, channel });
    const shouldAssertTarget = Boolean(assertChannel)
      && intent !== 'draft'
      && !dryRun
      && stepKind !== 'manual_task';
    if (shouldAssertTarget && assertChannel) {
      const campaign = parseAccountCampaignFromRecord(sendRecord);
      const targetContactId = String(activeContactId || '').trim() || null;
      if (!campaign) {
        if (assertChannel !== 'mail' && !targetContactId) {
          return {
            status: 'skipped',
            reason: 'No campaign or active contact for named channel action',
            provider_id: '',
            auto_skipped_steps: [],
          };
        }
      } else {
        try {
          assertActionTarget({
            campaign,
            contact_id: targetContactId,
            channel: assertChannel,
          });
        } catch (err) {
          return {
            status: 'skipped',
            reason: String((err as Error)?.message || err),
            provider_id: '',
            auto_skipped_steps: [],
          };
        }
      }
    }

    if (stepKind === 'manual_task') {
      // Durable park: write pipeline_events so operator queues / completeManualTask see the work.
      // Exactly one open park per record+step — do not insert a second awaiting event.
      //
      // Mail product types (standard_postcard, golden_ticket): when automated send is
      // introduced, call evaluateExternalActionAuthorization / isReviewRequired with the
      // same policy.review_required_for tokens before any external mail side effect.
      // Manual parks remain awaiting_manual; they are not auto-sent here.
      if (db && !dryRun) {
        try {
          // Contact-cycle: an open park for a different contact must not block a new cycle.
          const parkContact = activeContactId || String(sendRecord.active_contact_id || '');
          const already = db.prepare(`
            SELECT event_id FROM pipeline_events
            WHERE record_id = ? AND step_id = ? AND kind = 'manual_task'
              AND passed = 0 AND reason = 'awaiting_manual'
              AND (COALESCE(contact_id, '') = '' OR contact_id = ?)
              AND NOT EXISTS (
                SELECT 1 FROM pipeline_events done
                WHERE done.record_id = pipeline_events.record_id
                  AND done.step_id = pipeline_events.step_id
                  AND done.kind = 'manual_task'
                  AND done.passed = 1
                  AND done.occurred_at > pipeline_events.occurred_at
                  AND (
                    COALESCE(done.contact_id, '') = ''
                    OR done.contact_id = pipeline_events.contact_id
                    OR done.contact_id = ?
                  )
              )
            LIMIT 1
          `).get(recordId, sequenceStepId, parkContact, parkContact);
          if (!already) {
            insertPipelineEvent({
              db,
              event: {
                event_id: randomUUID(),
                record_id: recordId,
                step_id: sequenceStepId,
                kind: 'manual_task',
                passed: false,
                reason: 'awaiting_manual',
                side_effecting: false,
                // Contact-cycle scope: parks belong to the active contact, not only account+step.
                contact_id: activeContactId || String(sendRecord.active_contact_id || ''),
                occurred_at: now,
              },
            });
          }
          // When review is required for this mail task type, open a pending stage review
          // so sequence state coordinates with A4 (paused_review) without auto-sending.
          if (
            isReviewRequired(projectConfig, stepKind, taskType)
            && (taskType === 'standard_postcard' || taskType === 'golden_ticket'
              || channel === 'mail' || sequenceStepId.toLowerCase().includes('mail')
              || sequenceStepId.toLowerCase().includes('postcard')
              || sequenceStepId.toLowerCase().includes('golden_ticket'))
          ) {
            const mailReviewPresentation = resolveReviewPresentation({ step, record: sendRecord });
            const mailBody = String(
              sendRecord.golden_ticket_copy
              || sendRecord.golden_ticket_body
              || sendRecord.mail_copy
              || sendRecord.mail_body
              || sendRecord.postcard_copy
              || sendRecord.postcard_body
              || sendRecord.preliminary_snapshot
              || '',
            );
            const mailAssetVersion = currentStageAssetVersion({
              record: sendRecord,
              stageId: sequenceStepId,
              assetForStep,
              policyVersion: projectConfig?.policy?.version,
              recipient: String(sendRecord.address || sendRecord.contact_email || ''),
              bodyText: mailBody,
              activeContactId,
              reviewPresentation: mailReviewPresentation,
            });
            const mailInvalidated = applyStageReviewMaterialInvalidation({
              db,
              record: sendRecord,
              stageId: sequenceStepId,
              currentAssetVersion: mailAssetVersion,
              channel: 'mail',
              actionType: taskType || stepKind || 'manual_task',
              contactId: activeContactId || null,
              presentation: mailReviewPresentation,
            });
            const mailRecord = mailInvalidated.record;
            const mailAuth = evaluateExternalActionAuthorization({
              config: projectConfig,
              record: mailRecord,
              stepKind,
              taskType,
              stageId: sequenceStepId,
              assetVersion: mailAssetVersion,
              channel: 'mail',
            });
            if (mailAuth.needsPendingReview) {
              applyStageReviewPause({
                db,
                record: mailRecord,
                stageId: sequenceStepId,
                assetVersion: mailAssetVersion,
                channel: 'mail',
                actionType: taskType || stepKind || 'manual_task',
                contactId: activeContactId || null,
                reason: `Stage review required before mail task ${taskType || sequenceStepId}`,
                presentation: mailReviewPresentation,
              });
            }
          }
        } catch {
          /* schema may lack pipeline_events in some harnesses — still return park */
        }
      }
      return {
        status: 'skipped',
        reason: 'awaiting_manual',
        provider_id: '',
        auto_skipped_steps: [],
        parked: true,
      };
    }

    // LinkedIn connect: not forbidden. Gate on Unipile readiness; live invite via unipileLiveInvite
    // (or AO_UNIPILE_FIXTURE harness). Own channel_events + succession — never invents email/mail state.
    // Lifecycle: invite_sent / accepted / declined / message_allowed + cooldown (see linkedin-lifecycle).
    if (stepKind === 'linkedin_connect') {
      // Lifecycle + cooldown + provider-ack gate (single place).
      if (!dryRun) {
        const liGate = evaluateLinkedinConnectGate(sendRecord, {
          contactPolicy: projectConfig?.contact_policy,
        });
        if (!liGate.allowed) {
          const priorProvider = String(
            sendRecord.linkedin_last_provider_id || sendRecord.linkedin_last_connect_provider_id || '',
          ).trim();
          const reason =
            liGate.reason === 'linkedin_invite_already_sent' || priorProvider
              ? (priorProvider
                ? 'Already sent (linkedin provider ack present).'
                : liGate.reason)
              : liGate.reason === 'cooldown'
                ? 'cooldown'
                : liGate.reason;
          return {
            status: 'skipped',
            reason,
            provider_id: priorProvider || '',
            auto_skipped_steps: [],
          };
        }
      }

      // policy.review_required_for: hard-block linkedin_connect without stage authorization.
      // No draft interim for LinkedIn — authorizeStageReview is the only gate.
      // Always evaluate when !dryRun regardless of intent (draft must not bypass review).
      // Recompute material asset_version from the asset about to execute; authorized
      // reviews bound to a different fingerprint are invalidated and re-paused (fail closed).
      if (!dryRun) {
        const liBody = linkedinBodyForReview({ record: sendRecord, step });
        const linkedinReviewPresentation = resolveReviewPresentation({ step, record: sendRecord });
        const linkedinAssetVersion = currentStageAssetVersion({
          record: sendRecord,
          stageId: sequenceStepId,
          assetForStep,
          policyVersion: projectConfig?.policy?.version,
          recipient: String(
            sendRecord.linkedin_url
            || sendRecord.contact_linkedin
            || sendRecord.contact_email
            || '',
          ),
          bodyText: liBody || null,
          activeContactId,
          reviewPresentation: linkedinReviewPresentation,
        });
        const liInvalidated = applyStageReviewMaterialInvalidation({
          db,
          record: sendRecord,
          stageId: sequenceStepId,
          currentAssetVersion: linkedinAssetVersion,
          channel: 'linkedin',
          actionType: 'linkedin_connect',
          contactId: activeContactId || null,
          presentation: linkedinReviewPresentation,
        });
        if (liInvalidated.blocked) {
          return {
            status: 'skipped',
            reason: liInvalidated.reason
              || 'Stage review invalidated: asset changed; re-paused for review.',
            provider_id: '',
            auto_skipped_steps: [],
          };
        }
        const linkedinAuth = evaluateExternalActionAuthorization({
          config: projectConfig,
          record: liInvalidated.record,
          stepKind: 'linkedin_connect',
          taskType,
          stageId: sequenceStepId,
          assetVersion: linkedinAssetVersion,
          channel: 'linkedin',
        });
        if (!linkedinAuth.allowed) {
          if (linkedinAuth.needsPendingReview) {
            applyStageReviewPause({
              db,
              record: liInvalidated.record,
              stageId: sequenceStepId,
              assetVersion: linkedinAssetVersion,
              channel: 'linkedin',
              actionType: 'linkedin_connect',
              contactId: activeContactId || null,
              reason: `Stage review required before linkedin_connect (${sequenceStepId})`,
              presentation: linkedinReviewPresentation,
            });
          }
          return {
            status: 'skipped',
            reason: linkedinAuth.reason === 'stage_review_required'
              ? 'Stage review required before linkedin_connect.'
              : linkedinAuth.reason,
            provider_id: '',
            auto_skipped_steps: [],
          };
        }
      }

      // LinkedIn has no draft interim artifact — never call Unipile on intent=draft.
      if (intent === 'draft') {
        return {
          status: 'skipped',
          reason: 'LinkedIn has no draft interim; authorize stage review then send.',
          provider_id: '',
          auto_skipped_steps: [],
        };
      }

      const linkedinSuppression = evaluateTransmitterSuppression({
        db,
        record: sendRecord,
        channel: 'linkedin',
      });
      if (linkedinSuppression.blocked) {
        return {
          status: 'skipped',
          reason: linkedinSuppression.reason,
          provider_id: '',
          auto_skipped_steps: [],
        };
      }

      const linkedinContent = resolveLinkedinInvitationMessage({ record: sendRecord, step });
      if ('reason' in linkedinContent) {
        return {
          status: 'failed',
          reason: linkedinContent.reason,
          provider_id: '',
          auto_skipped_steps: [],
        };
      }

      const liClaim = reserveProviderInteraction({ providerChannel: 'linkedin' });
      if (liClaim.ok === false) return liClaim.result as any;

      const { executeUnipileLinkedinConnect } = await import('./unipile.js');
      const channelConfig = projectConfig?.channels?.linkedin;
      const provider = String(
        channelConfig && typeof channelConfig === 'object' && !Array.isArray(channelConfig)
          ? channelConfig.provider || 'unipile'
          : 'unipile',
      ).trim().toLowerCase();
      const fixtureMode = isSinkOrFixtureMode('linkedin');
      const providerCredentials = fixtureMode
        ? null
        : resolveChannelProviderCredentials({
          listDir: String(listDir),
          config: projectConfig || {},
          channel: 'linkedin',
          provider,
          requiredKeys: ['UNIPILE_API_KEY', 'UNIPILE_DSN'],
        });
      if (providerCredentials && !providerCredentials.ready) {
        releaseProviderInteraction({ mode: liClaim.mode });
        if (idemKey) {
          failIdempotency({
            db,
            idemKey,
            scope: idemConfig?.scope || 'list',
            claimId: String((sendRecord as any).__idempotency_claim_id || ''),
            payload: {
              error: providerCredentials.reason,
              stepNumber,
              step_id: sequenceStepId,
            },
          });
        }
        return {
          status: 'failed',
          reason: providerCredentials.reason,
          provider_id: '',
          auto_skipped_steps: [],
        };
      }
      const linkedinResult = await executeUnipileLinkedinConnect({
        record: sendRecord,
        step,
        dryRun,
        env: fixtureMode
          ? { AO_UNIPILE_FIXTURE: '1' }
          : providerCredentials?.credentials,
      });
      const resolvedTargetProviderId = String(linkedinResult.target_provider_id || '').trim();
      const resolvedTargetPublicIdentifier = String(linkedinResult.target_public_identifier || '').trim();
      const resolvedTargetIdentity = resolvedTargetProviderId && resolvedTargetPublicIdentifier
        ? {
          linkedin_provider_id: resolvedTargetProviderId,
          linkedin_provider_public_id: resolvedTargetPublicIdentifier,
        }
        : {};
      if (!dryRun && resolvedTargetProviderId && resolvedTargetPublicIdentifier) {
        try {
          ensureRecordColumns({
            db,
            columns: ['linkedin_provider_id', 'linkedin_provider_public_id'],
          });
          upsertRecord({
            db,
            row: { ...sendRecord, ...resolvedTargetIdentity },
          });
        } catch {
          // A sent invitation must still complete its idempotency record if caching fails.
        }
      }
      if (linkedinResult.status !== 'sent') {
        releaseProviderInteraction({ mode: liClaim.mode });
        if (idemKey && linkedinResult.status === 'failed') {
          failIdempotency({
            db,
            idemKey,
            scope: idemConfig?.scope || 'list',
            claimId: String((sendRecord as any).__idempotency_claim_id || ''),
            payload: {
              error: linkedinResult.reason,
              ...(linkedinResult.outcome_unknown ? { provider_uncertain: true } : {}),
              stepNumber,
              step_id: sequenceStepId,
            },
          });
        }
        return {
          status: linkedinResult.status === 'failed' ? 'failed' : 'skipped',
          reason: linkedinResult.reason,
          provider_id: linkedinResult.provider_id || '',
          auto_skipped_steps: [],
        };
      }

      const providerId = String(linkedinResult.provider_id || '').trim();
      if (!providerId && !dryRun) {
        if (idemKey) {
          failIdempotency({
            db,
            idemKey,
            scope: idemConfig?.scope || 'list',
            claimId: String((sendRecord as any).__idempotency_claim_id || ''),
            payload: {
              error: 'linkedin_accepted_without_provider_id',
              provider_uncertain: true,
              stepNumber,
              step_id: sequenceStepId,
            },
          });
        }
        return {
          status: 'failed',
          reason: 'LinkedIn provider returned no provider_id; delivery uncertain.',
          provider_id: '',
          auto_skipped_steps: [],
        };
      }
      const liProviderId = providerId || `unipile_${randomUUID()}`;

      // CRITICAL: complete idempotency immediately after provider accept (before bookkeeping).
      (sendRecord as any).__provider_accept_attempted = true;
      commitProviderInteraction({
        mode: liClaim.mode,
        providerChannel: 'linkedin',
        providerId: liProviderId,
      });
      if (idemKey && !dryRun) {
        const completed = completeIdempotency({
          db,
          idemKey,
          scope: idemConfig?.scope || 'list',
          providerId: liProviderId,
          claimId: String((sendRecord as any).__idempotency_claim_id || ''),
          payload: {
            step: stepNumber,
            step_id: sequenceStepId,
            sequence: sequenceName,
            intent,
            accepted_before_bookkeeping: true,
            channel: 'linkedin',
          },
        });
        if (!completed?.completed && completed?.reason !== 'already_sent') {
          return {
            status: 'failed',
            reason: `Idempotency complete failed after LinkedIn accept (${completed?.reason || 'unknown'}).`,
            provider_id: liProviderId,
            auto_skipped_steps: [],
          };
        }
        (sendRecord as any).__idempotency_completed = true;
      }

      if (!dryRun) {
        insertChannelEvent({
          db,
          event: {
            id: randomUUID(),
            record_id: recordId,
            contact_id: activeContactId,
            channel: 'linkedin',
            action: 'executed',
            disposition: 'ok',
            sequence_step: stepNumber,
            notes: linkedinResult.reason,
            provider_message_id: liProviderId,
            provider_id: liProviderId,
            payload: {
              step: stepNumber,
              step_id: sequenceStepId,
              sequence: sequenceName,
              reason: linkedinResult.reason,
              readiness: linkedinResult.readiness,
              linkedin_lifecycle_state: 'invite_sent',
              ...(activeContactId ? { contact_id: activeContactId } : {}),
            },
            occurred_at: now,
          },
        });
      }

      const lifecyclePatch = applyLinkedinInviteSent({
        record: { ...sendRecord, ...resolvedTargetIdentity },
        providerId: liProviderId,
        at: now,
      });
      const updatedRecord: Record<string, unknown> = {
        ...lifecyclePatch.patch,
        last_outreach_at: now,
        sequence_step_attempts: Number(sendRecord.sequence_step_attempts || 0) + 1,
      };
      if (!dryRun) {
        try {
          const advanced = advanceAfterSuccessfulAction({
            record: updatedRecord,
            channel: 'linkedin',
            stepKind: 'linkedin_connect',
            stepId: sequenceStepId,
            sequenceCompleted: false,
            evidence: {
              reason: `linkedin_connect ${sequenceStepId} ${linkedinResult.reason}`,
              evidence_ids: [liProviderId, sequenceStepId].filter(Boolean),
            },
            contactPolicy: projectConfig?.contact_policy,
          });
          Object.assign(updatedRecord, advanced.patch);
          ensureRecordColumns({
            db,
            columns: [
              ...Object.keys(advanced.patch),
              'linkedin_last_provider_id',
              'linkedin_last_connect_at',
              'linkedin_lifecycle_state',
              'linkedin_relationship_state',
              'linkedin_invite_sent_at',
            ],
          });
        } catch (policyError) {
          updatedRecord.lifecycle_policy_error = String((policyError as Error)?.message || policyError);
          ensureRecordColumns({
            db,
            columns: [
              'lifecycle_policy_error',
              'linkedin_last_provider_id',
              'linkedin_last_connect_at',
              'linkedin_lifecycle_state',
              'linkedin_relationship_state',
              'linkedin_invite_sent_at',
            ],
          });
        }
        upsertRecord({ db, row: updatedRecord });
        // Project after upsert: upsertRecord locks primary contact_* against pipeline clobber.
        applyActiveContactProjection({
          db,
          recordId,
          updatedRecord,
          contactId: String(updatedRecord.active_contact_id || activeContactId || ''),
        });
      }

      return {
        status: 'sent',
        reason: linkedinResult.reason,
        provider_id: liProviderId,
        next_step: Number(stepNumber) + 1,
        auto_skipped_steps: [],
      };
    }

    let approvedDraft: any = null;
    // Bind email auth to stepKind send_email OR inferred/hinted email channel —
    // not only inferEventChannel (which can miss when stepKind is set but channelHint empty).
    const emailChannel = inferEventChannel({ description: step?.description, artifacts: {}, outputs: {}, channelHint }) === 'email';
    const isEmailSendPath =
      stepKind === 'send_email'
      || emailChannel
      || String(channel || '').trim().toLowerCase() === 'email'
      || String(channelHint || '').trim().toLowerCase() === 'email';
    if (!dryRun && intent === 'send' && isEmailSendPath) {
      const emailReviewPresentation = resolveReviewPresentation({ step, record: sendRecord });
      approvedDraft = db.prepare(`
        SELECT *
        FROM drafts
        WHERE row_id = ?
          AND sequence_name = ?
          AND step_number = ?
          AND status = 'ready'
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(recordId, String(sequenceName || 'default'), Number(stepNumber || 0));
      const pending = db.prepare(`
        SELECT COUNT(*) AS n
        FROM drafts
        WHERE row_id = ?
          AND sequence_name = ?
          AND step_number = ?
          AND status = 'pending_approval'
      `).get(recordId, String(sequenceName || 'default'), Number(stepNumber || 0));
      if (!approvedDraft && Number(pending?.n || 0) > 0) {
        return {
          status: 'skipped',
          reason: 'Draft pending approval.',
          provider_id: '',
          auto_skipped_steps: [],
        };
      }
      const approvalRequired = step?.draft_approval_required === true
        || Boolean((step?.config as any)?.draft_approval_required);
      if (approvalRequired && !approvedDraft) {
        return {
          status: 'skipped',
          reason: 'Draft approval required before send.',
          provider_id: '',
          auto_skipped_steps: [],
        };
      }

      // Resolve mailbox BEFORE fingerprint so mailbox_id + from are review-bound.
      const earlyMailbox = resolveSendMailbox({
        listDir,
        config: projectConfig || readConfig(listDir).config,
        db,
        record: sendRecord,
        stepConfig: (step?.config && typeof step.config === 'object') ? step.config as any : {},
      });
      const resolvedFrom = earlyMailbox
        ? String(earlyMailbox.credentials.SMTP_FROM || earlyMailbox.credentials.SMTP_USER || earlyMailbox.id || '').trim()
        : String(sendRecord.email_last_from || '').trim();
      const resolvedMailboxId = earlyMailbox
        ? String(earlyMailbox.id || '')
        : String(sendRecord.assigned_mailbox_id || '');
      (sendRecord as any).__resolved_send_mailbox = earlyMailbox;
      (sendRecord as any).__resolved_from = resolvedFrom;
      (sendRecord as any).assigned_mailbox_id = resolvedMailboxId || sendRecord.assigned_mailbox_id;
      (sendRecord as any).email_last_from = resolvedFrom || sendRecord.email_last_from;

      // Prefer the IMMUTABLE envelope the human approved (stored on the draft).
      // Never rebuild authorization solely from this send invocation.
      let draftEnvelope: Record<string, unknown> | null = null;
      if (approvedDraft) {
        try {
          const cb = typeof approvedDraft.content_binding_json === 'string'
            ? JSON.parse(approvedDraft.content_binding_json || '{}')
            : (approvedDraft.content_binding || {});
          if (cb?.provider_envelope && typeof cb.provider_envelope === 'object') {
            draftEnvelope = cb.provider_envelope as Record<string, unknown>;
          }
        } catch { /* */ }
      }

      const emailRecipient = resolveActiveContactEmailForSend({ record: sendRecord }).email
        || String(sendRecord.contact_email || sendRecord.email || '');
      const { composeOutboundReviewVersion: composeSendVersion } = await import('../../commands/drafts.js');
      const stepCfgEarly = (step?.config && typeof step.config === 'object') ? step.config as any : {};
      const argsEarly = resolveToolCallArguments({
        stepConfig: stepCfgEarly,
        record: sendRecord,
      });
      const tmplEarly = (stepCfgEarly.template_context && typeof stepCfgEarly.template_context === 'object')
        ? stepCfgEarly.template_context
        : {};
      const blankEarly = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
      if (approvedDraft && (blankEarly(approvedDraft.subject) || blankEarly(approvedDraft.body))) {
        return {
          status: 'failed',
          reason: 'Approved draft is incomplete; refusing to send unreviewable content.',
          provider_id: '',
          auto_skipped_steps: [],
        };
      }
      // Final provider content: draft envelope > approved draft > args > template.
      let emailSubject = '';
      let emailBody = '';
      if (draftEnvelope) {
        if (!blankEarly(draftEnvelope.subject)) emailSubject = String(draftEnvelope.subject);
        if (!blankEarly(draftEnvelope.body)) emailBody = String(draftEnvelope.body);
      }
      if (approvedDraft) {
        if (blankEarly(emailSubject) && !blankEarly(approvedDraft.subject)) emailSubject = String(approvedDraft.subject);
        if (blankEarly(emailBody) && !blankEarly(approvedDraft.body)) emailBody = String(approvedDraft.body);
      }
      if (blankEarly(emailSubject) && !blankEarly(argsEarly.subject)) emailSubject = String(argsEarly.subject);
      if (blankEarly(emailBody) && !blankEarly(argsEarly.body)) emailBody = String(argsEarly.body);
      if (blankEarly(emailSubject) && !blankEarly(tmplEarly.subject)) emailSubject = String(tmplEarly.subject);
      if (blankEarly(emailBody) && !blankEarly(tmplEarly.body)) emailBody = String(tmplEarly.body);

      const envelopeFrom = draftEnvelope?.from
        ? String(draftEnvelope.from)
        : resolvedFrom;
      const envelopeMailbox = draftEnvelope?.mailbox_id
        ? String(draftEnvelope.mailbox_id)
        : resolvedMailboxId;
      const envelopeRecipient = draftEnvelope?.recipient
        ? String(draftEnvelope.recipient).toLowerCase()
        : String(emailRecipient || '').trim().toLowerCase();

      const emailAssetVersion = composeSendVersion({
        record: sendRecord,
        draft: {
          draft_id: approvedDraft?.draft_id ? String(approvedDraft.draft_id) : '',
          step_id: sequenceStepId,
          subject: emailSubject,
          body: emailBody,
        },
        stageId: sequenceStepId,
        policyVersion: projectConfig?.policy?.version,
        sender: envelopeFrom || null,
        mailboxId: envelopeMailbox || null,
        reviewPresentation: emailReviewPresentation,
      });

      // Authorized envelope: prefer draft-persisted; else current resolved (no-draft path).
      const authorizedEnvelope = draftEnvelope || {
        mailbox_id: envelopeMailbox,
        from: envelopeFrom,
        recipient: envelopeRecipient,
        subject: emailSubject,
        body: emailBody,
        asset_version: emailAssetVersion,
        step_id: sequenceStepId,
      };
      (sendRecord as any).__authorized_provider_envelope = authorizedEnvelope;
      (sendRecord as any).__final_provider_args = {
        to: envelopeRecipient,
        from: envelopeFrom,
        subject: emailSubject,
        body: emailBody,
        mailbox_id: envelopeMailbox,
      };
      const emailInvalidated = applyStageReviewMaterialInvalidation({
        db,
        record: sendRecord,
        stageId: sequenceStepId,
        currentAssetVersion: emailAssetVersion,
        channel: 'email',
        actionType: 'send_email',
        contactId: activeContactId || null,
        presentation: emailReviewPresentation,
      });
      if (emailInvalidated.blocked) {
        return {
          status: 'skipped',
          reason: emailInvalidated.reason
            || 'Stage review invalidated: asset changed; re-paused for review.',
          provider_id: '',
          auto_skipped_steps: [],
        };
      }
      const emailAuth = evaluateExternalActionAuthorization({
        config: projectConfig,
        record: emailInvalidated.record,
        stepKind: stepKind || 'send_email',
        taskType,
        stageId: sequenceStepId,
        assetVersion: emailAssetVersion,
        hasReadyDraft: Boolean(approvedDraft),
        channel: 'email',
      });
      if (!emailAuth.allowed) {
        if (emailAuth.needsPendingReview) {
          applyStageReviewPause({
            db,
            record: emailInvalidated.record,
            stageId: sequenceStepId,
            assetVersion: emailAssetVersion,
            channel: 'email',
            actionType: 'send_email',
            contactId: activeContactId || null,
            reason: `Stage review or draft approval required before send_email (${sequenceStepId})`,
            presentation: emailReviewPresentation,
          });
        }
        return {
          status: 'skipped',
          reason: emailAuth.reason === 'stage_review_or_draft_approval_required'
            ? 'Stage review or draft approval required before send.'
            : emailAuth.reason,
          provider_id: '',
          auto_skipped_steps: [],
        };
      }
    }

    const preChannelHint = inferEventChannel({
      description: step?.description,
      artifacts: {},
      outputs: {},
      channelHint,
    });
    const stepConfig = (step?.config && typeof step.config === 'object') ? step.config as Record<string, unknown> : {};
    // Prefer explicit action. A pinned tool on any send_<channel> step is a
    // deterministic channel boundary; the configured tool owns that channel's
    // provider-specific work.
    const rawAction = String(stepConfig.action || '').trim().toLowerCase();
    const hasPinnedTool = Boolean(
      stepConfig.tool
      && typeof stepConfig.tool === 'object'
      && (
        (Array.isArray((stepConfig.tool as any).tools) && (stepConfig.tool as any).tools.length > 0)
        || String((stepConfig.tool as any).server || '').trim()
      ),
    );
    const actionName = rawAction
      || (intent === 'send' && stepKind.startsWith('send_') && hasPinnedTool
        ? 'tool_call'
        : '');
    const llmRole = (intent === 'draft' || preChannelHint === 'email') ? 'copywriting' : 'research';
    // Prefer mailbox resolved before review fingerprint; fall back to late resolve.
    const sendMailbox = !dryRun && actionName === 'tool_call' && intent === 'send' && preChannelHint === 'email'
      ? ((sendRecord as any).__resolved_send_mailbox
        || resolveSendMailbox({
          listDir,
          config: readConfig(listDir).config,
          db,
          record: sendRecord,
          stepConfig,
        }))
      : null;

    let stepResult: any;
    if (dryRun) {
      stepResult = { outputs: {}, artifacts: {}, summary: 'dry run', defer: false, reason: '' };
    } else if (actionName === 'tool_call' && intent === 'draft') {
      // Deterministic draft from template — no LLM, no SMTP. Operator approves then send.
      const templateCtx = (stepConfig.template_context && typeof stepConfig.template_context === 'object')
        ? stepConfig.template_context as Record<string, unknown>
        : {};
      const resolvedArgs = resolveToolCallArguments({ stepConfig, record: sendRecord });
      const subject = firstContentValue(resolvedArgs.subject, templateCtx.subject);
      const body = firstContentValue(resolvedArgs.body, templateCtx.body);
      const draftId = `draft_${randomUUID()}`;
      stepResult = {
        outputs: {
          draft_id: draftId,
          subject,
          body,
        },
        artifacts: {
          draft_id: draftId,
          subject,
          body,
        },
        summary: 'tool_call draft',
        defer: false,
        reason: 'Draft pending approval.',
        model: '',
        provider: 'tool_call',
        usage: null,
      };
    } else if (actionName === 'tool_call' && intent === 'send') {
      // Deterministic send path — no LLM. Used for SMTP / pinned tools.
      const { executeToolCallAction } = await import('../enrichment/actions/tool-call.js');
      // A selected mailbox's daily_cap is scoped to its own event payload and
      // takes precedence over the legacy step/global cap. The latter remains
      // the compatibility guard for lists without a capped mailbox.
      const dailyCap = Number(sendMailbox?.mailbox.daily_cap ?? stepConfig.daily_cap ?? process.env.AO_EMAIL_DAILY_CAP ?? 2);
      if (Number.isFinite(dailyCap) && dailyCap >= 0 && preChannelHint === 'email') {
        const dayStart = new Date(now);
        dayStart.setUTCHours(0, 0, 0, 0);
        const sentToday = sendMailbox?.mailbox.daily_cap !== undefined
          ? { n: countMailboxSendsToday(db, sendMailbox.id, now) }
          : db.prepare(`
              SELECT COUNT(*) AS n
              FROM channel_events
              WHERE channel = 'email'
                AND (action IN ('executed', 'sent') OR event_type IN ('executed', 'sent'))
                AND occurred_at >= ?
            `).get(dayStart.toISOString());
        if (Number(sentToday?.n || 0) >= dailyCap) {
          return {
            status: 'skipped',
            reason: `Daily email cap reached (${dailyCap}).`,
            provider_id: '',
            auto_skipped_steps: [],
          };
        }
      }
      // Construct FINAL provider arguments FIRST — apply args_map + fallbacks here,
      // fingerprint against the human-approved envelope, then pass frozen args with
      // args_map cleared so tool-call cannot rewrite after comparison.
      const baseArgs = resolveToolCallArguments({ stepConfig, record: sendRecord });
      const templateCtx = (stepConfig.template_context && typeof stepConfig.template_context === 'object')
        ? stepConfig.template_context as Record<string, unknown>
        : {};
      const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
      const finalPre = (sendRecord as any).__final_provider_args as
        | { to?: string; from?: string; subject?: string; body?: string; mailbox_id?: string }
        | undefined;
      // Force final content from authorized envelope / final pre-args — never
      // allow late SMTP fallbacks to swap an unreviewed from/body.
      if (finalPre) {
        if (!blank(finalPre.subject)) baseArgs.subject = finalPre.subject;
        if (!blank(finalPre.body)) baseArgs.body = finalPre.body;
        if (!blank(finalPre.from)) baseArgs.from = finalPre.from;
        if (!blank(finalPre.to)) baseArgs.to = finalPre.to;
      } else if (approvedDraft) {
        if (!blank(approvedDraft.subject)) baseArgs.subject = approvedDraft.subject;
        if (!blank(approvedDraft.body)) baseArgs.body = approvedDraft.body;
      } else {
        if (blank(baseArgs.subject) && !blank(templateCtx.subject)) baseArgs.subject = templateCtx.subject;
        if (blank(baseArgs.body) && !blank(templateCtx.body)) baseArgs.body = templateCtx.body;
      }
      if (sendMailbox && blank(baseArgs.from) && !blank(sendMailbox.credentials.SMTP_FROM)) {
        // Only fill from when no authorized from was bound — still subject to compare.
        if (!finalPre?.from) baseArgs.from = sendMailbox.credentials.SMTP_FROM;
      }
      // Resolve recipient for tools that read contact_email.
      if (blank(baseArgs.to)) {
        baseArgs.to = resolveActiveContactEmailForSend({ record: sendRecord }).email
          || String(sendRecord.contact_email || sendRecord.email || '');
      }

      const preSendFrom = String(baseArgs.from || '').trim();
      const preSendTo = String(baseArgs.to || '').trim().toLowerCase();
      const preSendSubject = String(baseArgs.subject || '');
      const preSendBody = String(baseArgs.body || '');
      if (preChannelHint === 'email') {
        const emailContent = assertOutboundContent({
          channel: 'email',
          stepId: sequenceStepId,
          required: {
            subject: preSendSubject,
            body: preSendBody,
          },
        });
        if ('reason' in emailContent) {
          return {
            status: 'failed',
            reason: emailContent.reason,
            provider_id: '',
            auto_skipped_steps: [],
          };
        }
      }
      const authEnv = (sendRecord as any).__authorized_provider_envelope as
        | { mailbox_id?: string; from?: string; recipient?: string; subject?: string; body?: string }
        | undefined;
      if (authEnv && (authEnv.from || authEnv.recipient || authEnv.subject || authEnv.body || authEnv.mailbox_id)) {
        const drift: string[] = [];
        if (authEnv.from && preSendFrom.toLowerCase() !== String(authEnv.from).toLowerCase()) {
          drift.push(`from:${authEnv.from}!=${preSendFrom}`);
        }
        if (authEnv.recipient && preSendTo !== String(authEnv.recipient).toLowerCase()) {
          drift.push(`to:${authEnv.recipient}!=${preSendTo}`);
        }
        if (authEnv.subject != null && String(authEnv.subject) !== preSendSubject) {
          drift.push('subject');
        }
        if (authEnv.body != null && String(authEnv.body) !== preSendBody) {
          drift.push('body');
        }
        if (authEnv.mailbox_id && sendMailbox?.id && String(authEnv.mailbox_id) !== String(sendMailbox.id)) {
          drift.push(`mailbox:${authEnv.mailbox_id}!=${sendMailbox.id}`);
        }
        if (authEnv.from && !preSendFrom) drift.push('from_blank_at_send');
        if (drift.length > 0) {
          // Durable invalidation: wipe draft envelope so send cannot retry without re-review.
          try {
            if (approvedDraft?.draft_id) {
              const prevBind = (() => {
                try {
                  return typeof approvedDraft.content_binding_json === 'string'
                    ? JSON.parse(approvedDraft.content_binding_json || '{}')
                    : (approvedDraft.content_binding || {});
                } catch { return {}; }
              })();
              updateDraft({
                db,
                draftId: String(approvedDraft.draft_id),
                patch: {
                  status: 'pending_approval',
                  content_binding: {
                    ...prevBind,
                    provider_envelope: null,
                    envelope_invalidated_at: now,
                    envelope_drift: drift.join(','),
                  },
                },
              });
            }
          } catch { /* still refuse send */ }
          return {
            status: 'skipped',
            reason: `Provider envelope drift after review (${drift.join(',')}); authorization invalidated; re-authorize required.`,
            provider_id: '',
            auto_skipped_steps: [],
            readiness_blockers: ['provider_envelope_drift'],
          };
        }
      } else if (!preSendFrom && !dryRun) {
        const reviewRequired = Array.isArray(projectConfig?.policy?.review_required_for)
          && projectConfig.policy.review_required_for.some(
            (t: string) => String(t).toLowerCase() === 'send_email',
          );
        if (reviewRequired) {
          return {
            status: 'skipped',
            reason: 'Mailbox/from not resolved before send; cannot ship unreviewed sender.',
            provider_id: '',
            auto_skipped_steps: [],
          };
        }
      }
      // Exclusive claim immediately before provider side-effect (after all gates).
      const emailSuppression = evaluateTransmitterSuppression({
        db,
        record: sendRecord,
        channel: 'email',
      });
      if (emailSuppression.blocked) {
        return {
          status: 'skipped',
          reason: emailSuppression.reason,
          provider_id: '',
          auto_skipped_steps: [],
        };
      }
      const emailClaim = reserveProviderInteraction({ providerChannel: 'email' });
      if (emailClaim.ok === false) return emailClaim.result as any;
      deliveryState.emailMode = emailClaim.mode;

      // Frozen args only — args_map already applied above; do not re-apply in tool-call.
      const toolResult = await executeToolCallAction({
        mcp,
        listDir,
        stepId: sequenceStepId,
        stepConfig: {
          ...stepConfig,
          args: baseArgs,
          args_map: {},
          external_send: true,
        },
        record: sendRecord,
        toolCatalog,
        env: sendMailbox ? smtpCredentialEnv(sendMailbox.credentials) : undefined,
      });
      const sendOutputs = (toolResult.outputs || {}) as Record<string, unknown>;
      // Provider rejection is NOT acceptance — never mark sent / invent provider id.
      const providerRejected =
        sendOutputs.ok === false
        || sendOutputs.success === false
        || (typeof sendOutputs.error === 'string' && String(sendOutputs.error).trim() !== '')
        || String(sendOutputs.status || '').toLowerCase() === 'failed'
        || String(sendOutputs.status || '').toLowerCase() === 'rejected';
      if (providerRejected) {
        releaseProviderInteraction({ mode: emailClaim.mode });
        if (idemKey && !dryRun) {
          failIdempotency({
            db,
            idemKey,
            scope: idemConfig?.scope || 'list',
            claimId: String((sendRecord as any).__idempotency_claim_id || ''),
            payload: {
              error: String(sendOutputs.error || sendOutputs.reason || 'provider rejected'),
              stepNumber,
              step_id: sequenceStepId,
            },
          });
        }
        return {
          status: 'failed',
          reason: String(sendOutputs.error || sendOutputs.reason || 'provider rejected'),
          provider_id: '',
          auto_skipped_steps: [],
        };
      }
      let sendMessageId = String(
        sendOutputs.message_id || sendOutputs.provider_id || sendOutputs.provider_message_id || '',
      ).trim();
      const sendThreadId = String(
        sendOutputs.thread_id || sendOutputs.provider_thread_id || '',
      ).trim();
      // Fixture / explicit ok:true may omit message_id — mint a durable id only then.
      // Never invent an id for ambiguous or rejected provider results.
      const explicitOk =
        sendOutputs.ok === true
        || sendOutputs.success === true
        || String(toolResult.provider || '') === 'fixture'
        || String(process.env.AO_PIPELINE_FIXTURE || process.env.AO_STEP_FIXTURE || '').trim() === '1';
      if (!sendMessageId && explicitOk && !dryRun) {
        sendMessageId = `accepted_fixture_${recordId}_${sequenceStepId}_${Date.now()}`;
      } else if (!sendMessageId && !dryRun) {
        // Ambiguous: tool returned without error but no id — mark uncertain, not sent/retryable failed.
        (sendRecord as any).__provider_accept_attempted = true;
        if (idemKey) {
          failIdempotency({
            db,
            idemKey,
            scope: idemConfig?.scope || 'list',
            claimId: String((sendRecord as any).__idempotency_claim_id || ''),
            payload: {
              error: 'provider_accepted_without_message_id',
              provider_uncertain: true,
              stepNumber,
              step_id: sequenceStepId,
            },
          });
        }
        return {
          status: 'failed',
          reason: 'Provider returned no message_id; delivery uncertain (not retrying as fresh send).',
          provider_id: '',
          auto_skipped_steps: [],
          readiness_blockers: ['provider_message_id_missing'],
        };
      }

      // CRITICAL: record provider acceptance immediately — before any bookkeeping
      // that can throw. A later SQLite failure must not leave the claim failed/retryable.
      (sendRecord as any).__provider_accept_attempted = true;
      commitProviderInteraction({
        mode: emailClaim.mode,
        providerChannel: 'email',
        providerId: sendMessageId,
      });
      if (idemKey && !dryRun) {
        const completed = completeIdempotency({
          db,
          idemKey,
          scope: idemConfig?.scope || 'list',
          providerId: sendMessageId,
          claimId: String((sendRecord as any).__idempotency_claim_id || ''),
          payload: {
            step: stepNumber,
            step_id: sequenceStepId,
            sequence: sequenceName,
            intent,
            accepted_before_bookkeeping: true,
          },
        });
        // Honor CAS result — missing/not_owner/race_lost is not success.
        if (!completed?.completed && completed?.reason !== 'already_sent') {
          return {
            status: 'failed',
            reason: `Idempotency complete failed after provider accept (${completed?.reason || 'unknown'}); not bookkeeping as fresh success.`,
            provider_id: sendMessageId,
            auto_skipped_steps: [],
            readiness_blockers: [`idempotency_complete_${completed?.reason || 'failed'}`],
          };
        }
        (sendRecord as any).__idempotency_completed = true;
      }

      stepResult = {
        outputs: {
          ...sendOutputs,
          ...(sendMessageId ? { message_id: sendMessageId, provider_id: sendMessageId } : {}),
          ...(sendThreadId ? { thread_id: sendThreadId } : {}),
        },
        artifacts: {
          ...sendOutputs,
          message_id: sendMessageId,
          provider_id: sendMessageId || String(sendOutputs.provider_id || ''),
          ...(sendThreadId ? { thread_id: sendThreadId } : {}),
        },
        summary: 'tool_call send',
        defer: false,
        reason: '',
        model: toolResult.model || '',
        provider: toolResult.provider || 'tool_call',
        usage: toolResult.usage || null,
      };
    } else {
      stepResult = await executeStepAction({
        mcp,
        listDir,
        stepId: sequenceStepId,
        description: String(step?.description || ''),
        stepConfig: step?.config || {},
        record: sendRecord,
        context: {
          phase: 'sequence',
          sequence_name: sequenceName,
          step_number: stepNumber,
          intent,
          approved_draft: approvedDraft
            ? {
              draft_id: approvedDraft.draft_id,
              subject: approvedDraft.subject,
              body: approvedDraft.body,
            }
            : null,
        },
        toolCatalog,
        aiConfig,
        role: llmRole,
      });
    }

    const stepArtifacts = (stepResult?.artifacts || {}) as any;
    const stepOutputs = (stepResult?.outputs || {}) as any;
    const draftAssetOverride = intent === 'draft' && assetForStep
      ? assetDraftOverride({ asset: assetForStep, usesAssetId, stepArtifacts, stepOutputs })
      : null;
    const draftTemplateContext = stepConfig.template_context && typeof stepConfig.template_context === 'object'
      ? stepConfig.template_context as Record<string, unknown>
      : {};
    const draftResolvedArgs = resolveToolCallArguments({ stepConfig, record: sendRecord });
    const draftSubject = draftAssetOverride
      ? String(draftAssetOverride.subject || '')
      : firstContentValue(
        stepArtifacts.subject,
        stepOutputs.subject,
        draftResolvedArgs.subject,
        draftTemplateContext.subject,
      );
    const draftBody = draftAssetOverride
      ? String(draftAssetOverride.body || '')
      : firstContentValue(
        stepArtifacts.body,
        stepOutputs.body,
        draftResolvedArgs.body,
        draftTemplateContext.body,
      );
    if (!dryRun && intent === 'draft' && (isBlankValue(draftSubject) || isBlankValue(draftBody))) {
      const missing = [
        ...(isBlankValue(draftSubject) ? ['subject'] : []),
        ...(isBlankValue(draftBody) ? ['body'] : []),
      ];
      throw new Error(`Draft content incomplete: missing ${missing.join(' and ')}; refusing to create pending approval draft.`);
    }
    if (!dryRun) {
      recordCostEvent({
        db,
        listDir,
        recordId,
        stepId: `sequence:${sequenceName}:${sequenceStepId}`,
        model: String((stepResult as any)?.model || ''),
        provider: String((stepResult as any)?.provider || ''),
        usage: (stepResult as any)?.usage || null,
      });
    }
    const eventChannel = inferEventChannel({
      description: step?.description,
      artifacts: stepArtifacts,
      outputs: stepOutputs,
      channelHint,
    });
    // Provider outcome ids from sink/send result (or prior email thread on record).
    // insertChannelEvent maps provider_* → provider_id/thread_id columns as well.
    const providerMessageId = String(
      stepArtifacts.provider_message_id
      || stepArtifacts.provider_id
      || stepArtifacts.message_id
      || stepArtifacts.piece_id
      || stepArtifacts.sms_message_id
      || stepOutputs.provider_message_id
      || stepOutputs.provider_id
      || stepOutputs.message_id
      || stepOutputs.piece_id
      || stepOutputs.sms_message_id
      || randomUUID()
    );
    const providerThreadId = String(
      stepArtifacts.provider_thread_id
      || stepArtifacts.thread_id
      || stepOutputs.provider_thread_id
      || stepOutputs.thread_id
      || (eventChannel === 'email'
        ? (sendRecord.email_thread_id || sendRecord.email_last_thread_id || '')
        : '')
      || ''
    ).trim();

    if (!dryRun) {
      insertChannelEvent({
        db,
        event: {
          id: randomUUID(),
          record_id: recordId,
          contact_id: activeContactId,
          channel: eventChannel,
          action: intent === 'draft' ? 'draft_created' : 'executed',
          disposition: stepResult.defer ? 'defer' : 'ok',
          sequence_step: stepNumber,
          notes: String(stepResult.summary || ''),
          provider_id: providerMessageId,
          provider_message_id: providerMessageId,
          // Email path: thread id from send result (sink/SMTP) or prior record thread.
          thread_id: providerThreadId,
          provider_thread_id: providerThreadId,
          payload: {
            step: stepNumber,
            step_id: sequenceStepId,
            step_description: step?.description || '',
            sequence: sequenceName,
            intent,
            summary: stepResult.summary,
            outputs: stepResult.outputs,
            artifacts: stepResult.artifacts,
            reason: stepResult.reason || '',
            ...(activeContactId ? { contact_id: activeContactId } : {}),
            ...(sendMailbox ? {
              mailbox_id: sendMailbox.id,
              smtp_from: String(sendMailbox.credentials.SMTP_FROM || sendMailbox.credentials.SMTP_USER || ''),
            } : {}),
          },
          occurred_at: now,
        },
      });
    }

    // When review is required for email, pause sequence on draft create so
    // account_sequence_state = paused_review (coordinates with A4 gate). Operator
    // drafts approve authorizes the pending stage review and resumes.
    let stageReviewPausePatch: Record<string, unknown> | null = null;

    if (!dryRun && intent === 'draft') {
      const draftId = String(stepArtifacts.draft_id || stepOutputs.draft_id || providerMessageId || '');
      if (draftId) {
        ensureDraftColumns({ db });
        const existing = db.prepare('SELECT draft_id FROM drafts WHERE draft_id = ? LIMIT 1').get(draftId);
        if (!existing) {
          const missingAssetArtifacts = usesAssetId && !assetForStep
            ? {
              uses_asset: usesAssetId,
              asset_missing: true,
              asset_missing_reason: `Asset not found for step ${usesAssetId}`,
            }
            : {};
          insertDraft({
            db,
            draft: {
              draft_id: draftId,
              row_id: recordId,
              sequence_name: sequenceName,
              step_number: Number(stepNumber || 0),
              step_id: sequenceStepId,
              channel: 'email',
              status: 'pending_approval',
              subject: draftSubject,
              body: draftBody,
              reason: String(stepResult.reason || (usesAssetId && !assetForStep ? `Asset not found for step ${usesAssetId}` : '')),
              content_binding: {},
              artifacts: {
                summary: stepResult.summary || '',
                outputs: stepOutputs,
                artifacts: stepArtifacts,
                ...(draftAssetOverride ? draftAssetOverride.artifacts : missingAssetArtifacts),
              },
            },
          });
        }

        if (
          isReviewRequired(projectConfig, stepKind || 'send_email', taskType)
          || isReviewRequired(projectConfig, 'send_email', taskType)
        ) {
          const draftReviewPresentation = resolveReviewPresentation({ step, record: sendRecord });
          const draftMailbox = resolveSendMailbox({
            listDir,
            config: projectConfig || readConfig(listDir).config,
            db,
            record: sendRecord,
            stepConfig: (step?.config && typeof step.config === 'object')
              ? step.config as any
              : {},
          });
          const draftFrom = draftMailbox
            ? String(
                draftMailbox.credentials.SMTP_FROM
                || draftMailbox.credentials.SMTP_USER
                || draftMailbox.id
                || '',
              ).trim()
            : String(sendRecord.email_last_from || '').trim();
          const draftMailboxId = draftMailbox
            ? String(draftMailbox.id || '').trim()
            : String(sendRecord.assigned_mailbox_id || '').trim();
          (sendRecord as any).assigned_mailbox_id =
            draftMailboxId || sendRecord.assigned_mailbox_id;
          (sendRecord as any).email_last_from =
            draftFrom || sendRecord.email_last_from;
          // Same composition as drafts.composeOutboundReviewVersion / send path:
          // account, contact, recipient, subject/body, draft id, step.
          const { composeOutboundReviewVersion } = await import('../../commands/drafts.js');
          const assetVersion = composeOutboundReviewVersion({
            record: sendRecord,
            draft: {
              draft_id: draftId,
              step_id: sequenceStepId,
              subject: draftSubject,
              body: draftBody,
            },
            stageId: sequenceStepId,
            policyVersion: projectConfig?.policy?.version,
            sender: draftFrom || null,
            mailboxId: draftMailboxId || null,
            reviewPresentation: draftReviewPresentation,
          });
          const draftAuth = evaluateExternalActionAuthorization({
            config: projectConfig,
            record: sendRecord,
            stepKind: stepKind || 'send_email',
            taskType,
            stageId: sequenceStepId,
            assetVersion,
            hasReadyDraft: false,
            channel: 'email',
          });
          if (draftAuth.needsPendingReview || !draftAuth.existing) {
            const accountId = String(sendRecord._row_id || sendRecord.id || '');
            const lifecycle = String(sendRecord.lifecycle_stage || 'contacted');
            const paused = pauseForStageReview({
              account_id: accountId,
              stage_id: sequenceStepId,
              asset_version: assetVersion,
              contact_id: activeContactId || null,
              channel: 'email',
              action_type: 'send_email',
              pending_action: {
                action_type: 'send_email',
                account_id: accountId,
                contact_id: activeContactId || null,
                lifecycle_stage: lifecycle,
                sequence_state: 'active',
                work_state: 'executing_external_action',
                reason: `resume after draft/stage review ${sequenceStepId}`,
                on_success: 'wait_or_followup',
                related_asset_id: draftId,
              },
              lifecycle_stage: lifecycle,
              reason: `Draft pending approval + stage review for ${sequenceStepId}`,
              presentation: draftReviewPresentation,
            });
            stageReviewPausePatch = {
              ...paused.patch,
              transition_audit_json: appendTransitionAudit(
                sendRecord.transition_audit_json,
                paused.audit,
              ),
            };
          }
        }
      }
    }

    const shouldAdvanceSequence = intent !== 'draft';
    // Persist hydrated active-contact fields so subsequent steps / templates
    // see the same recipient without re-running seniority primary projection.
    const mappedRecord = applyStepOutputs({
      record: sendRecord,
      step,
      outputs: stepOutputs,
    });
    const existingEmailLastMessageId = deliveryState.emailMode === 'sink'
      ? String(db.prepare('SELECT email_last_message_id FROM records WHERE _row_id = ?').get(recordId)?.email_last_message_id || '')
      : '';
    const artifactUpdatedRecord = applyArtifactUpdates({
      record: mappedRecord,
      artifacts: stepArtifacts,
      outputs: stepOutputs,
      intent,
      persistEmailMessageId: deliveryState.emailMode !== 'sink',
      existingEmailLastMessageId,
    });

    if (sendMailbox && intent === 'send' && eventChannel === 'email') {
      artifactUpdatedRecord.assigned_mailbox_id = sendMailbox.id;
      artifactUpdatedRecord.email_last_from = String(sendMailbox.credentials.SMTP_FROM || sendMailbox.credentials.SMTP_USER || '');
    }

    const launchedAt = shouldAdvanceSequence
      ? ((stepNumber === 1 && intent !== 'draft') ? now : String(sendRecord.launched_at || ''))
      : String(sendRecord.launched_at || '');
    const timing = resolveWorkingDayConfig({
      ...sequence,
      timezone: sequence?.timezone || projectConfig?.operations?.timezone,
    });
    const launchedAtDate = toIsoDate(launchedAt) || toZonedIsoDate(now, timing.timeZone);
    const progression = shouldAdvanceSequence
      ? computeNextScheduledAction({
          steps: Array.isArray(sequence?.steps) ? sequence.steps : [],
          completedStepNumber: Number(stepNumber || 0),
          launchedAtDate,
          workingDays: timing.workingDays,
          policy: timing.policy,
          timeZone: timing.timeZone,
        })
      : {
          sequenceStep: Number(sendRecord.sequence_step || 0),
          nextActionDate: String(sendRecord.next_action_date || ''),
          skippedStepNumbers: [],
          completed: false,
        };

    const updatedRecord: Record<string, unknown> = {
      ...artifactUpdatedRecord,
      sequence_name: sequenceName,
      sequence_step: shouldAdvanceSequence ? progression.sequenceStep : Number(sendRecord.sequence_step || 0),
      sequence_status: shouldAdvanceSequence
        ? (progression.completed ? 'completed' : 'active')
        : String(sendRecord.sequence_status || 'idle'),
      next_action_date: shouldAdvanceSequence ? progression.nextActionDate : String(sendRecord.next_action_date || ''),
      last_outreach_at: now,
      launched_at: launchedAt,
      sequence_step_attempts: shouldAdvanceSequence
        ? Number(sendRecord.sequence_step_attempts || 0) + 1
        : Number(sendRecord.sequence_step_attempts || 0),
    };

    if (intent === 'draft' && !updatedRecord.email_last_draft_id && providerMessageId) {
      updatedRecord.email_last_draft_id = providerMessageId;
    }

    // Merge pauseForStageReview patch after draft create (sequence paused_review).
    if (stageReviewPausePatch) {
      Object.assign(updatedRecord, stageReviewPausePatch);
      ensureRecordColumns({ db, columns: Object.keys(stageReviewPausePatch) });
    }

    // Lifecycle / next_action succession on successful non-draft external actions.
    // Uses completeActionAndCreateSuccessor when next_action matches; otherwise a safe successor.
    // On contact rotation, re-project denormalized contact_* from the new active contact.
    if (!dryRun && shouldAdvanceSequence) {
      try {
        const advanced = advanceAfterSuccessfulAction({
          record: updatedRecord,
          channel: eventChannel,
          stepKind,
          stepId: sequenceStepId,
          sequenceCompleted: Boolean(progression.completed),
          evidence: {
            reason: `channel ${eventChannel} step ${sequenceStepId} executed successfully`,
            evidence_ids: [providerMessageId, sequenceStepId].filter(Boolean),
          },
          contactPolicy: projectConfig?.contact_policy,
        });
        Object.assign(updatedRecord, advanced.patch);
        ensureRecordColumns({ db, columns: Object.keys(advanced.patch) });
      } catch (policyError) {
        // Do not fail a successful send on policy bookkeeping; surface for operator repair.
        updatedRecord.lifecycle_policy_error = String((policyError as Error)?.message || policyError);
        ensureRecordColumns({ db, columns: ['lifecycle_policy_error'] });
      }
    }

    if (!dryRun) {
      upsertRecord({ db, row: updatedRecord });
      // After rotation (or any send), re-project denormalized contact_* from active contact.
      // Must run after upsertRecord, which preserves seniority-primary projection columns.
      if (String(updatedRecord.active_contact_id || activeContactId || '').trim()) {
        applyActiveContactProjection({
          db,
          recordId,
          updatedRecord,
          contactId: String(updatedRecord.active_contact_id || activeContactId || ''),
        });
      }
    }

    if (!dryRun && intent === 'send' && inferEventChannel({ description: step?.description, artifacts: {}, outputs: {}, channelHint }) === 'email') {
      const readyDraft = db.prepare(`
        SELECT *
        FROM drafts
        WHERE row_id = ?
          AND sequence_name = ?
          AND step_number = ?
          AND status = 'ready'
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(recordId, String(sequenceName || 'default'), Number(stepNumber || 0));
      if (readyDraft) {
        updateDraft({ db, draftId: String(readyDraft.draft_id || ''), patch: { status: 'sent' } });
        db.prepare(`
          UPDATE drafts
          SET status = 'superseded', updated_at = ?
          WHERE row_id = ?
            AND sequence_name = ?
            AND step_number = ?
            AND status IN ('pending_approval', 'ready')
            AND draft_id != ?
        `).run(nowTimestamp(), recordId, String(sequenceName || 'default'), Number(stepNumber || 0), String(readyDraft.draft_id || ''));
      }
    }

    // idemKey is only claimed when !dryRun; never complete live scope on dry-run.
    if (idemKey && !dryRun) {
      completeIdempotency({
        db,
        idemKey,
        scope: idemConfig?.scope || 'list',
        providerId: providerMessageId,
        claimId: String((sendRecord as any).__idempotency_claim_id || ''),
        payload: { step: stepNumber, step_id: sequenceStepId, sequence: sequenceName, intent },
      });
    }

    return {
      status: intent === 'draft' ? 'drafted' : 'sent',
      provider_id: intent === 'draft' ? '' : providerMessageId,
      ...(intent === 'draft' ? { draft_id: providerMessageId } : {}),
      next_step: Number(stepNumber) + 1,
      deferred: Boolean(stepResult.defer),
      auto_skipped_steps: progression.skippedStepNumbers,
    };
  } catch (error) {
    if (isBudgetExceededError(error)) throw error;
    if (idemKey) {
      // If provider already accepted (completeIdempotency ran), never reclassify as failed.
      const prior = getIdempotencyRecord({
        db,
        idemKey,
        scope: idemConfig?.scope || 'list',
      });
      if (prior?.status === 'sent') {
        // Bookkeeping failed after accept — surface error but leave sent (no retry).
        throw error;
      }
      // Ambiguous provider outcomes must become uncertain, not failed.
      const errText = String((error as any)?.message || error || '');
      const providerUncertain = /timeout|ETIMEDOUT|ECONNRESET|ECONNABORTED|socket hang up|network|UND_ERR|fetch failed|aborted|uncertain|accepted.?unknown|after.?accept|bookkeep/i
        .test(errText);
      // Local persistence failures after a successful toolResult should also be uncertain
      // when we cannot prove the message was not accepted.
      const postAcceptBookkeeping = Boolean((sendRecord as any).__provider_accept_attempted);
      failIdempotency({
        db,
        idemKey,
        scope: idemConfig?.scope || 'list',
        claimId: String((sendRecord as any).__idempotency_claim_id || ''),
        payload: {
          error: errText,
          stepNumber,
          step_id: sequenceStepId,
          ...(providerUncertain || postAcceptBookkeeping ? { provider_uncertain: true } : {}),
        },
      });
    }

    const updatedRecord = {
      ...sendRecord,
      retry_count: Number(sendRecord.retry_count || 0) + 1,
      last_error: String(error?.message || error),
    };
    if (!dryRun) upsertRecord({ db, row: updatedRecord });

    if (!dryRun) {
      insertChannelEvent({
        db,
        event: {
          id: randomUUID(),
          record_id: recordId,
          contact_id: activeContactId,
          channel: 'manual',
          action: 'failed',
          disposition: 'error',
          sequence_step: stepNumber,
          payload: {
            error: String(error?.message || error),
            step: stepNumber,
            step_id: sequenceStepId,
            sequence: sequenceName,
            ...(activeContactId ? { contact_id: activeContactId } : {}),
          },
          occurred_at: now,
        },
      });
    }

    return { status: 'failed', reason: String(error?.message || error) };
  }
};
