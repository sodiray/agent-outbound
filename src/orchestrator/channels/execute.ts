import { randomUUID } from 'node:crypto';
import { buildIdempotencyKey, claimIdempotency, completeIdempotency, failIdempotency } from '../runtime/idempotency.js';
import { insertChannelEvent, nowTimestamp, upsertRecord } from '../runtime/db.js';
import { getRecordRowId } from '../lib/record.js';
import { executeStepAction } from '../actions/execute-step/index.js';

const nextStepDate = ({ fromDate, dayOffset }) => {
  const base = new Date(`${fromDate}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + Number(dayOffset || 0));
  return base.toISOString().slice(0, 10);
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

const applyArtifactUpdates = ({ record, artifacts, outputs, intent }) => {
  const next = { ...(record || {}) };
  const data = { ...(artifacts || {}), ...(outputs || {}) };

  if (data.thread_id) {
    next.email_thread_id = String(data.thread_id);
    next.email_last_thread_id = String(data.thread_id);
  }
  if (data.draft_id) {
    next.email_last_draft_id = String(data.draft_id);
  }
  if (intent !== 'draft' && data.message_id) {
    next.email_last_message_id = String(data.message_id);
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
  dryRun = false,
  intent = 'send',
  channelHint = '',
}: any) => {
  const now = nowTimestamp();
  const recordId = getRecordRowId(record);
  const sequenceStepId = String(step?.id || `step_${stepNumber}`);

  const idemConfig = step?.config?.idempotency;
  let idemKey = '';
  if (idemConfig?.key_source?.length) {
    idemKey = buildIdempotencyKey({ keySource: idemConfig.key_source, record, scope: idemConfig.scope || 'list' });
    const claimed = claimIdempotency({
      db,
      idemKey,
      scope: idemConfig.scope || 'list',
      payload: { stepNumber, step_id: sequenceStepId, intent },
    });
    if (!claimed.claimed && claimed.status === 'sent') {
      return { status: 'skipped', reason: 'Already sent (idempotent).', provider_id: claimed.provider_id };
    }
  }

  try {
    const stepResult = dryRun
      ? { outputs: {}, artifacts: {}, summary: 'dry run', defer: false, reason: '' }
      : await executeStepAction({
          mcp,
          listDir,
          stepId: sequenceStepId,
          description: String(step?.description || ''),
          stepConfig: step?.config || {},
          record,
          context: {
            phase: 'sequence',
            sequence_name: sequenceName,
            step_number: stepNumber,
            intent,
          },
          toolCatalog,
        });

    const stepArtifacts = (stepResult?.artifacts || {}) as any;
    const stepOutputs = (stepResult?.outputs || {}) as any;
    const eventChannel = inferEventChannel({
      description: step?.description,
      artifacts: stepArtifacts,
      outputs: stepOutputs,
      channelHint,
    });
    const providerMessageId = String(
      stepArtifacts.provider_id
      || stepArtifacts.message_id
      || stepArtifacts.piece_id
      || stepArtifacts.sms_message_id
      || stepOutputs.provider_id
      || stepOutputs.message_id
      || stepOutputs.piece_id
      || stepOutputs.sms_message_id
      || randomUUID()
    );
    const providerThreadId = String(stepArtifacts.thread_id || stepOutputs.thread_id || '');

    if (!dryRun) {
      insertChannelEvent({
        db,
        event: {
          id: randomUUID(),
          record_id: recordId,
          channel: eventChannel,
          action: intent === 'draft' ? 'draft_created' : 'executed',
          disposition: stepResult.defer ? 'defer' : 'ok',
          sequence_step: stepNumber,
          notes: String(stepResult.summary || ''),
          provider_message_id: providerMessageId,
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
          },
          occurred_at: now,
        },
      });
    }

    const dayOffset = Number(step?.day ?? 0);
    const sequenceDate = new Date().toISOString().slice(0, 10);
    const mappedRecord = applyStepOutputs({
      record,
      step,
      outputs: stepOutputs,
    });
    const artifactUpdatedRecord = applyArtifactUpdates({
      record: mappedRecord,
      artifacts: stepArtifacts,
      outputs: stepOutputs,
      intent,
    });

    const updatedRecord = {
      ...artifactUpdatedRecord,
      sequence_name: sequenceName,
      sequence_step: stepNumber,
      sequence_status: 'active',
      next_action_date: nextStepDate({ fromDate: sequenceDate, dayOffset }),
      last_outreach_at: now,
      launched_at: stepNumber === 1 && intent !== 'draft' ? now : record.launched_at,
      sequence_step_attempts: Number(record.sequence_step_attempts || 0) + 1,
    };

    if (intent === 'draft' && !updatedRecord.email_last_draft_id && providerMessageId) {
      updatedRecord.email_last_draft_id = providerMessageId;
    }

    if (!dryRun) upsertRecord({ db, row: updatedRecord });

    if (idemKey) {
      completeIdempotency({
        db,
        idemKey,
        scope: idemConfig?.scope || 'list',
        providerId: providerMessageId,
        payload: { step: stepNumber, step_id: sequenceStepId, sequence: sequenceName, intent },
      });
    }

    return {
      status: 'sent',
      provider_id: providerMessageId,
      next_step: Number(stepNumber) + 1,
      deferred: Boolean(stepResult.defer),
    };
  } catch (error) {
    if (idemKey) {
      failIdempotency({
        db,
        idemKey,
        scope: idemConfig?.scope || 'list',
        payload: { error: String(error?.message || error), stepNumber, step_id: sequenceStepId },
      });
    }

    const updatedRecord = {
      ...record,
      retry_count: Number(record.retry_count || 0) + 1,
      last_error: String(error?.message || error),
    };
    if (!dryRun) upsertRecord({ db, row: updatedRecord });

    if (!dryRun) {
      insertChannelEvent({
        db,
        event: {
          id: randomUUID(),
          record_id: recordId,
          channel: 'manual',
          action: 'failed',
          disposition: 'error',
          sequence_step: stepNumber,
          payload: {
            error: String(error?.message || error),
            step: stepNumber,
            step_id: sequenceStepId,
            sequence: sequenceName,
          },
          occurred_at: now,
        },
      });
    }

    return { status: 'failed', reason: String(error?.message || error) };
  }
};
