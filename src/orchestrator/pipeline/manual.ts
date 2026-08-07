import { randomUUID } from 'node:crypto';
import { flattenPipelineSteps } from '../lib/subpipelines.js';
import {
  insertPipelineEvent,
  insertChannelEvent,
  nowTimestamp,
  ensureRecordColumns,
  upsertRecord,
} from '../runtime/db.js';
import {
  allocateMail,
  applyContactRotation,
  parseAccountCampaignFromRecord,
} from '../policy/contact-campaign.js';
import {
  isAuthorizedForStep,
  isReviewRequired,
  reviewRequiredTokens,
  resolveStageAssetVersion,
} from '../policy/stage-review-gate.js';
import {
  appendTransitionAudit,
  invalidateStageReviewIfAssetChanged,
  parseStageReviewJson,
} from '../policy/transition-audit.js';
import {
  applyMailSubmitted,
  resolveMailProvider,
  type MailProvider,
  type MailSubmitRequest,
  type MailSubmitResult,
} from '../channels/mail-provider.js';
import {
  buildIdempotencyKey,
  claimIdempotency,
  completeIdempotency,
  failIdempotency,
  getIdempotencyRecord,
} from '../runtime/idempotency.js';
import { shouldExecuteSequenceOutbound } from '../policy/sequence-outbound.js';
import { NEXT_ACTION_POLICY_VERSION } from '../policy/lifecycle.js';
import { stableHash } from '../lib/record.js';

const text = (value: unknown) => String(value || '').trim();

/** Mail product types that completeManualTask may allocate / gate on stage review. */
const MAIL_PRODUCT_TYPES = new Set(['standard_postcard', 'golden_ticket', 'mail']);

/**
 * Resolve mail product type for a manual step from config task_type or step id heuristics.
 * Returns null when the step is not a mail manual task.
 */
const resolveMailProductType = ({
  stepId,
  configured,
}: {
  stepId: string;
  configured?: Record<string, unknown> | null;
}): string | null => {
  const cfg = configured?.config as Record<string, unknown> | undefined;
  const fromConfig = text(cfg?.task_type || cfg?.taskType).toLowerCase();
  if (MAIL_PRODUCT_TYPES.has(fromConfig)) return fromConfig;

  const channel = text(cfg?.channel || configured?.channel).toLowerCase();
  if (channel === 'mail' || fromConfig === 'postcard' || fromConfig === 'letter') {
    return fromConfig === 'golden_ticket' ? 'golden_ticket'
      : fromConfig === 'standard_postcard' ? 'standard_postcard'
      : 'mail';
  }

  const sid = stepId.toLowerCase();
  if (sid.includes('golden_ticket')) return 'golden_ticket';
  if (sid.includes('postcard') || sid.includes('standard_postcard')) return 'standard_postcard';
  if (sid.includes('mail') || sid.includes('letter')) return 'mail';
  return null;
};

const parseJsonObject = (raw: unknown): Record<string, unknown> => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const ensureMailIdempotencyTable = (db: any) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS idempotency (
      id TEXT PRIMARY KEY,
      idem_key TEXT NOT NULL,
      scope TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_id TEXT DEFAULT '',
      payload_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(idem_key, scope)
    )
  `);
};

export const submitMailWithIdempotency = async ({
  db,
  provider,
  request,
  record,
  stepId,
  contentVersion,
  nowMs = Date.now(),
}: {
  db: any;
  provider: MailProvider;
  request: MailSubmitRequest;
  record: Record<string, unknown>;
  stepId: string;
  contentVersion: string;
  nowMs?: number;
}): Promise<MailSubmitResult> => {
  ensureMailIdempotencyTable(db);
  const recipient = JSON.stringify(request.to || {});
  const idemKey = buildIdempotencyKey({
    keySource: ['_row_id'],
    record,
    context: {
      step_id: stepId,
      active_contact_id: record.active_contact_id || record.contact_id || '',
      channel: 'mail',
      recipient,
      content_version: contentVersion,
    },
  });
  const claimPayload = {
    channel: 'mail',
    provider: provider.name,
    request,
    recipient: request.to,
    treatment: request.treatment,
    content_version: contentVersion,
  };
  const claim = claimIdempotency({
    db,
    idemKey,
    payload: claimPayload,
    nowMs,
  });

  if (!claim.claimed && claim.status === 'sent') {
    const existing = getIdempotencyRecord({ db, idemKey });
    const payload = parseJsonObject(existing?.payload_json);
    const storedResult = parseJsonObject(payload.provider_result);
    return {
      ok: true,
      piece_id: String(existing?.provider_id || storedResult.piece_id || ''),
      status: 'submitted',
      reason: 'already_submitted',
      cost_cents: Number(storedResult.cost_cents || 0),
      expected_delivery_date: String(storedResult.expected_delivery_date || ''),
      provider: String(storedResult.provider || payload.provider || provider.name),
      raw: {
        idempotent_replay: true,
        idem_key: idemKey,
      },
    };
  }

  if (!claim.claimed) {
    throw new Error(
      `Mail submit blocked for ${request.recordId} step ${stepId}: ${claim.reason}`,
    );
  }

  const submitResult = await provider.submit(request).catch((error: unknown) => {
    failIdempotency({
      db,
      idemKey,
      claimId: claim.claim_id,
      payload: {
        ...claimPayload,
        provider_uncertain: true,
        error: String((error as Error)?.message || error),
      },
    });
    throw error;
  });

  if (!submitResult?.ok || submitResult.status === 'failed') {
    failIdempotency({
      db,
      idemKey,
      claimId: claim.claim_id,
      payload: {
        ...claimPayload,
        provider_result: submitResult,
      },
    });
    return submitResult;
  }

  const completion = completeIdempotency({
    db,
    idemKey,
    providerId: submitResult.piece_id,
    claimId: claim.claim_id,
    payload: {
      ...claimPayload,
      provider_result: submitResult,
    },
  });
  if (!completion.completed && completion.reason !== 'already_sent') {
    throw new Error(
      `Mail provider accepted ${submitResult.piece_id || '(missing piece id)'} `
      + `but idempotency completion failed: ${completion.reason}`,
    );
  }
  return submitResult;
};

/**
 * Fail-closed: mail manual complete requires stage_review authorization when
 * policy.review_required_for lists that mail product type (or generic "mail").
 * Operator must stage_review_authorize first.
 *
 * Recomputes material asset_version (account / contact / recipient / content / step).
 * Authorized reviews bound to a different fingerprint are invalidated + re-paused;
 * complete is refused.
 */
const assertMailStageReviewAuthorized = ({
  db,
  config,
  recordId,
  stepId,
  productType,
}: {
  db: any;
  config: any;
  recordId: string;
  stepId: string;
  productType: string;
}) => {
  const tokens = reviewRequiredTokens(config);
  if (tokens.size === 0) return;

  // Match product type, manual_task+taskType, or generic "mail" token for any mail product.
  const reviewRequired =
    isReviewRequired(config, 'manual_task', productType)
    || isReviewRequired(config, productType, productType)
    || tokens.has(productType)
    || tokens.has('mail');
  if (!reviewRequired) return;

  let row = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(recordId) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    throw new Error(
      `Stage review required before completing mail task "${productType}" `
      + `(record ${recordId} not found; fail-closed).`,
    );
  }

  const mailBody = text(
    row.golden_ticket_copy
    || row.golden_ticket_body
    || row.mail_copy
    || row.mail_body
    || row.postcard_copy
    || row.postcard_body
    || row.preliminary_snapshot,
  );
  const currentAssetVersion = resolveStageAssetVersion({
    accountId: String(row._row_id || row.id || recordId),
    activeContactId: text(row.active_contact_id) || null,
    contactId: text(row.contact_id) || null,
    recipient: text(row.address || row.contact_email || row.email) || null,
    stepId,
    stageId: stepId,
    bodyText: mailBody || null,
    policyVersion: config?.policy?.version ?? null,
  });

  const invalidation = invalidateStageReviewIfAssetChanged({
    record: row,
    stage_id: stepId,
    current_asset_version: currentAssetVersion,
    account_id: String(row._row_id || row.id || recordId),
    contact_id: text(row.active_contact_id || row.contact_id) || null,
    channel: 'mail',
    action_type: productType,
    lifecycle_stage: text(row.lifecycle_stage) || 'contacted',
    re_pause: true,
  });
  if (invalidation.invalidated && invalidation.patch) {
    let auditJson = row.transition_audit_json;
    for (const audit of invalidation.audits) {
      auditJson = appendTransitionAudit(auditJson, audit);
    }
    const next = {
      ...row,
      ...invalidation.patch,
      transition_audit_json: auditJson,
    };
    ensureRecordColumns({
      db,
      columns: [
        ...Object.keys(invalidation.patch),
        'transition_audit_json',
        'related_review_id',
      ],
    });
    upsertRecord({ db, row: next });
    throw new Error(
      `Stage review invalidated: asset changed for mail task "${productType}" `
      + `record ${recordId} step ${stepId} (bound version no longer matches current asset). `
      + 'Re-authorize after reviewing the updated asset (fail-closed).',
    );
  }

  // Accept authorization bound to sequence step id, product type, or generic mail,
  // with exact current material asset_version.
  const authorized =
    isAuthorizedForStep(row, stepId, currentAssetVersion)
    || isAuthorizedForStep(row, productType, currentAssetVersion)
    || isAuthorizedForStep(row, 'mail', currentAssetVersion)
    || isAuthorizedForStep(row, 'manual_task', currentAssetVersion);
  if (authorized) return;

  // Surface when a review exists but is pending / wrong version.
  const existing = parseStageReviewJson(row.stage_review_json);
  if (existing?.status === 'authorized') {
    throw new Error(
      `Stage review asset_version mismatch for mail task "${productType}" `
      + `record ${recordId} step ${stepId} (fail-closed).`,
    );
  }

  throw new Error(
    `Stage review required before completing mail task "${productType}" `
    + `for record ${recordId} step ${stepId}. `
    + 'Authorize with stage_review_authorize first (fail-closed).',
  );
};

export type ManualTaskRow = {
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

/** Records currently parked on a manual_task step (reason awaiting_manual). */
export const listAwaitingManualTasks = ({
  db,
  taskType = '',
  limit = 100,
  offset = 0,
}: {
  db: any;
  taskType?: string;
  limit?: number;
  offset?: number;
}): { total: number; tasks: ManualTaskRow[] } => {
  const typeFilter = text(taskType);
  const rows = db.prepare(`
    SELECT
      e.record_id AS record_id,
      e.step_id AS step_id,
      e.occurred_at AS parked_at,
      e.reason AS reason,
      COALESCE(r.business_name, '') AS business_name,
      COALESCE(r.address, '') AS address,
      COALESCE(r.contact_name, '') AS contact_name,
      COALESCE(r.contact_email, '') AS contact_email,
      COALESCE(r.sequence_name, 'default') AS sequence_name,
      COALESCE(r.pipeline_name, 'default') AS pipeline_name
    FROM pipeline_events e
    JOIN records r ON r._row_id = e.record_id
    WHERE e.kind = 'manual_task'
      AND e.passed = 0
      AND e.reason = 'awaiting_manual'
      AND NOT EXISTS (
        SELECT 1 FROM pipeline_events done
        WHERE done.record_id = e.record_id
          AND done.step_id = e.step_id
          AND done.kind = 'manual_task'
          AND done.passed = 1
          AND done.occurred_at > e.occurred_at
      )
    ORDER BY e.occurred_at ASC
    LIMIT ? OFFSET ?
  `).all(Math.max(1, Number(limit) || 100), Math.max(0, Number(offset) || 0));

  const tasks: ManualTaskRow[] = rows.map((row: any) => {
    const stepId = text(row.step_id);
    const taskTypeFromId = stepId.includes('visit')
      ? 'visit'
      : stepId.includes('mail') || stepId.includes('letter')
        ? 'mail'
        : stepId.includes('linkedin')
          ? 'linkedin'
          : 'manual';
    return {
      record_id: text(row.record_id),
      step_id: stepId,
      task_type: taskTypeFromId,
      business_name: text(row.business_name),
      address: text(row.address),
      contact_name: text(row.contact_name),
      contact_email: text(row.contact_email),
      sequence_name: text(row.sequence_name),
      pipeline_name: text(row.pipeline_name),
      parked_at: text(row.parked_at),
      reason: text(row.reason),
    };
  }).filter((task) => !typeFilter || task.task_type === typeFilter);

  const totalRow = db.prepare(`
    SELECT COUNT(*) AS n
    FROM pipeline_events e
    WHERE e.kind = 'manual_task'
      AND e.passed = 0
      AND e.reason = 'awaiting_manual'
      AND NOT EXISTS (
        SELECT 1 FROM pipeline_events done
        WHERE done.record_id = e.record_id
          AND done.step_id = e.step_id
          AND done.kind = 'manual_task'
          AND done.passed = 1
          AND done.occurred_at > e.occurred_at
      )
  `).get();

  return {
    total: Number(totalRow?.n || tasks.length),
    tasks,
  };
};

/** Mark a parked manual_task complete so the pipeline can advance past it. */
export const completeManualTask = async ({
  db,
  config,
  recordId,
  stepId,
  note = '',
  skip = false,
  listDir = '',
  now: suppliedNow,
  /** Inject provider for tests; otherwise resolveMailProvider(env/config). */
  mailProvider,
}: {
  db: any;
  config?: any;
  recordId: string;
  stepId: string;
  note?: string;
  skip?: boolean;
  listDir?: string;
  now?: string | number | Date;
  mailProvider?: MailProvider | null;
}) => {
  const rid = text(recordId);
  const sid = text(stepId);
  if (!rid || !sid) throw new Error('recordId and stepId are required.');
  const suppliedDate = suppliedNow instanceof Date
    ? suppliedNow
    : suppliedNow != null
      ? new Date(suppliedNow)
      : null;
  const effectiveNowMs = suppliedDate && !Number.isNaN(suppliedDate.getTime())
    ? suppliedDate.getTime()
    : Date.now();

  // Campaign pause / cancel / inbound: refuse outbound manual complete (mail allocate,
  // phone close-out). Residual RES-CAMPAIGN-ORCHESTRATION — sequencer + channel execute
  // + manual complete must all honor account_sequence_state blocks.
  let recordRow: Record<string, unknown> | undefined;
  try {
    recordRow = db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rid) as
      | Record<string, unknown>
      | undefined;
  } catch {
    recordRow = undefined;
  }

  // Contact-cycle scope: completion/park lookups include active contact_id so
  // contact 1 completing a step does not block contact 2.
  const activeContactId = text(recordRow?.active_contact_id || recordRow?.contact_id || '');
  // Ensure contact_id column exists (in-memory harnesses / older DBs).
  try {
    db.exec("ALTER TABLE pipeline_events ADD COLUMN contact_id TEXT DEFAULT ''");
  } catch { /* already present */ }

  // Idempotency: refuse if THIS contact already completed this step.
  // Exact contact match only — empty contact_id must not block a later contact.
  const alreadyDone = activeContactId
    ? db.prepare(`
        SELECT event_id FROM pipeline_events
        WHERE record_id = ? AND step_id = ? AND kind = 'manual_task' AND passed = 1
          AND contact_id = ?
        ORDER BY occurred_at DESC LIMIT 1
      `).get(rid, sid, activeContactId)
    : db.prepare(`
        SELECT event_id FROM pipeline_events
        WHERE record_id = ? AND step_id = ? AND kind = 'manual_task' AND passed = 1
        ORDER BY occurred_at DESC LIMIT 1
      `).get(rid, sid);
  if (alreadyDone) {
    throw new Error(
      `Manual task already completed for record ${rid} step ${sid}`
      + (activeContactId ? ` contact ${activeContactId}` : '')
      + '.',
    );
  }

  // Prefer exact contact park; fall back to unscoped legacy park only when no contact-scoped row.
  const parked = activeContactId
    ? (db.prepare(`
        SELECT event_id FROM pipeline_events
        WHERE record_id = ? AND step_id = ? AND kind = 'manual_task'
          AND passed = 0 AND reason = 'awaiting_manual'
          AND contact_id = ?
        ORDER BY occurred_at DESC LIMIT 1
      `).get(rid, sid, activeContactId)
      || db.prepare(`
        SELECT event_id FROM pipeline_events
        WHERE record_id = ? AND step_id = ? AND kind = 'manual_task'
          AND passed = 0 AND reason = 'awaiting_manual'
          AND (contact_id IS NULL OR contact_id = '')
        ORDER BY occurred_at DESC LIMIT 1
      `).get(rid, sid))
    : db.prepare(`
        SELECT event_id FROM pipeline_events
        WHERE record_id = ? AND step_id = ? AND kind = 'manual_task'
          AND passed = 0 AND reason = 'awaiting_manual'
        ORDER BY occurred_at DESC LIMIT 1
      `).get(rid, sid);
  if (!parked) {
    throw new Error(
      `No awaiting manual task for record ${rid} step ${sid}`
      + (activeContactId ? ` contact ${activeContactId}` : '')
      + '.',
    );
  }
  if (recordRow) {
    const mailProductPreview = resolveMailProductType({ stepId: sid, configured: null });
    const channelHint =
      mailProductPreview
        ? 'mail'
        : (sid.toLowerCase().includes('phone') || sid.toLowerCase().includes('call')
          ? 'phone'
          : sid.toLowerCase().includes('linkedin')
            ? 'linkedin'
            : 'manual');
    const gate = shouldExecuteSequenceOutbound(recordRow, new Date(effectiveNowMs), {
      channel: channelHint,
      stepKind: 'manual_task',
      taskType: mailProductPreview || channelHint,
    });
    if (!gate.execute) {
      throw new Error(
        `Cannot complete outbound manual task for record ${rid} step ${sid}: ${gate.reason}`,
      );
    }
  }

  // Guard: only complete steps that are configured as manual_task when config is present.
  let configuredStep: Record<string, unknown> | undefined;
  if (config) {
    const steps = flattenPipelineSteps(config);
    configuredStep = steps.find((step: any) => text(step?.id) === sid) as
      | Record<string, unknown>
      | undefined;
    if (configuredStep && text(configuredStep.kind) !== 'manual_task') {
      throw new Error(`Step "${sid}" is not a manual_task (kind=${text(configuredStep.kind)}).`);
    }

    // Mail product types: refuse complete without stage_review authorization when
    // policy.review_required_for includes that type (fail closed).
    const mailProduct = resolveMailProductType({ stepId: sid, configured: configuredStep || null });
    if (mailProduct) {
      assertMailStageReviewAuthorized({
        db,
        config,
        recordId: rid,
        stepId: sid,
        productType: mailProduct,
      });
    }
  }

  const isMailStep =
    sid.toLowerCase().includes('mail')
    || sid.toLowerCase().includes('postcard')
    || sid.toLowerCase().includes('golden_ticket')
    || sid.toLowerCase().includes('letter');

  // Completion timestamps must be strictly after the park event so
  // listAwaitingManualTasks (done.occurred_at > park.occurred_at) closes the park.
  const parkAt = String(
    db.prepare(`
      SELECT occurred_at FROM pipeline_events WHERE event_id = ?
    `).get(parked.event_id)?.occurred_at || '',
  );
  const parkMs = Date.parse(parkAt);
  const completeMs = Number.isFinite(parkMs)
    ? Math.max(effectiveNowMs, parkMs + 1)
    : effectiveNowMs + 1;
  const now = new Date(completeMs).toISOString();

  // Mail: allocate (+ optional provider submit) BEFORE writing the completion
  // event. Failures throw and leave the task parked (awaiting_manual) — never
  // mark complete then swallow allocate/submit errors.
  let mail_allocated: boolean | undefined;
  let mail_provider_status: string | undefined;
  let mail_piece_id: string | undefined;
  if (!skip && isMailStep) {
    const row = (db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rid)
      || recordRow) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Cannot complete mail task: record ${rid} not found.`);
    }
    const campaign = parseAccountCampaignFromRecord(row);
    if (!campaign) {
      throw new Error(`Cannot complete mail task: no account campaign plan for ${rid}.`);
    }
    // Never invent mail permission when campaign.mail_treatment is none.
    if (campaign.mail_treatment === 'none') {
      throw new Error(
        `Cannot complete mail task for ${rid}: campaign mail_treatment is none (no mail permission).`,
      );
    }
    const treatmentRaw = String(row.mail_treatment || campaign.mail_treatment || '').trim();
    const mail_treatment: 'golden_ticket' | 'standard_postcard' =
      treatmentRaw === 'golden_ticket' || campaign.mail_treatment === 'golden_ticket'
        ? 'golden_ticket'
        : 'standard_postcard';
    if (
      campaign.mail_treatment !== 'golden_ticket'
      && campaign.mail_treatment !== 'standard_postcard'
    ) {
      throw new Error(
        `Cannot complete mail task for ${rid}: invalid campaign mail_treatment=${campaign.mail_treatment}`,
      );
    }

    let next;
    try {
      next = allocateMail({
        campaign,
        mail_treatment:
          campaign.mail_treatment === 'golden_ticket' ? 'golden_ticket' : 'standard_postcard',
      });
    } catch (err) {
      throw new Error(
        `Mail allocate failed for ${rid} step ${sid}: ${String((err as Error)?.message || err)}`,
      );
    }

    let patched: Record<string, unknown> = {
      ...row,
      account_contact_plan_json: JSON.stringify(next),
      mail_allocated: 1,
      mail_allocated_at: now,
      mail_provider_status: 'allocated',
    };
    ensureRecordColumns({
      db,
      columns: [
        'account_contact_plan_json',
        'mail_allocated',
        'mail_allocated_at',
        'mail_provider_status',
        'mail_last_piece_id',
        'mail_last_submitted_at',
        'mail_last_provider',
        'mail_last_cost_cents',
        'mail_last_expected_delivery',
        'mail_last_failed_at',
        'mail_last_failure_reason',
      ],
    });
    mail_allocated = true;
    mail_provider_status = 'allocated';

    const provider = mailProvider !== undefined
      ? mailProvider
      : resolveMailProvider({
        listDir: listDir || undefined,
        providerName: config?.channels?.mail?.provider,
      });
    if (provider) {
      const submitRequest: MailSubmitRequest = {
        recordId: rid,
        treatment: mail_treatment,
        to: {
          name: text(row.contact_name || row.business_name),
          address_line_1: text(row.address || row.address_line_1),
          address_city: text(row.city),
          address_state: text(row.state),
          address_zip: text(row.zip || row.postal_code),
        },
        template_id: text(config?.channels?.mail?.template_id),
        metadata: { step_id: sid },
      };
      const contentVersion = stableHash({
        request: submitRequest,
        mail_copy: text(
          row.golden_ticket_copy
          || row.golden_ticket_body
          || row.mail_copy
          || row.mail_body
          || row.postcard_copy
          || row.postcard_body,
        ),
      });
      const submitResult = await submitMailWithIdempotency({
        db,
        provider,
        request: submitRequest,
        record: row,
        stepId: sid,
        contentVersion,
        nowMs: completeMs,
      });
      if (!submitResult?.ok) {
        // Persist failure markers but DO NOT complete the manual task.
        try {
          const failed = applyMailSubmitted({ record: patched, result: submitResult, at: now });
          upsertRecord({ db, row: failed.patch });
        } catch {
          /* best-effort failure stamp */
        }
        throw new Error(
          `Mail provider submit failed for ${rid} step ${sid}: ${String(submitResult?.reason || 'submit_failed')}`,
        );
      }
      const submitted = applyMailSubmitted({ record: patched, result: submitResult, at: now });
      patched = submitted.patch;
      mail_provider_status = submitted.status;
      mail_piece_id = submitResult.piece_id || undefined;
      try {
        insertChannelEvent({
          db,
          event: {
            id: `mail_submitted_${stableHash(`${rid}|${sid}|${submitResult.piece_id}`).slice(0, 24)}`,
            row_id: rid,
            channel: 'mail',
            event_type: 'submitted',
            action: 'mail_submitted',
            disposition: submitted.status,
            provider_id: submitResult.piece_id || '',
            provider_message_id: submitResult.piece_id || '',
            payload: {
              provider: submitResult.provider,
              treatment: mail_treatment,
              step_id: sid,
            },
            occurred_at: now,
          },
        });
      } catch {
        /* harness without channel_events */
      }
    } else {
      try {
        insertChannelEvent({
          db,
          event: {
            id: randomUUID(),
            row_id: rid,
            channel: 'mail',
            event_type: 'allocated',
            action: 'mail_allocated',
            disposition: 'allocated',
            payload: {
              treatment: mail_treatment,
              step_id: sid,
            },
            occurred_at: now,
          },
        });
      } catch {
        /* harness without channel_events */
      }
    }

    upsertRecord({ db, row: patched });
  }

  // Contact-cycle scope: completion closes the park for the active contact.
  const activeContactAtComplete = text(
    recordRow?.active_contact_id || recordRow?.contact_id || '',
  );

  // Only after mail allocate/submit (or non-mail skip/complete) write the
  // passed completion event that closes the park.
  insertPipelineEvent({
    db,
    event: {
      event_id: randomUUID(),
      record_id: rid,
      step_id: sid,
      kind: 'manual_task',
      passed: true,
      reason: skip ? `skipped:${text(note) || 'operator'}` : (text(note) || 'completed'),
      contact_id: activeContactAtComplete,
      occurred_at: now,
    },
  });

  // Manual-tail completion (phone / call / visit): complete the contact cycle and
  // rotate to the next held contact when the campaign plan has one. Reset sequence
  // so the successor does not inherit completed steps and receive no sequence.
  const sidLower = sid.toLowerCase();
  const isManualTail =
    sidLower.includes('phone')
    || sidLower.includes('call')
    || sidLower.includes('visit')
    || sidLower.includes('manual_tail')
    || sidLower.endsWith('_tail');
  let rotated = false;
  let nextContactId: string | null = null;
  if (!skip && isManualTail && recordRow) {
    const rotation = applyContactRotation(recordRow, {
      reason: `manual_tail_complete:${sid}`,
    });
    if (rotation.rotated && rotation.active_contact_id) {
      rotated = true;
      nextContactId = rotation.active_contact_id;
      // 3-business-day quiet period before successor contact cycle starts.
      const quietDate = (() => {
        const d = new Date(now.slice(0, 10) + 'T12:00:00Z');
        let added = 0;
        while (added < 3) {
          d.setUTCDate(d.getUTCDate() + 1);
          const day = d.getUTCDay();
          if (day !== 0 && day !== 6) added += 1;
        }
        return d.toISOString().slice(0, 10);
      })();
      const patched: Record<string, unknown> = {
        ...recordRow,
        active_contact_id: rotation.active_contact_id,
        contact_id: rotation.active_contact_id,
        // Reset sequence for the successor contact cycle — do not inherit completed steps.
        sequence_step: 0,
        sequence_status: 'idle',
        next_action_date: quietDate,
        account_sequence_state: 'waiting',
        work_state: 'waiting_time_or_event',
        next_action_json: JSON.stringify({
          action_id: `na_rotate_${rid}_${rotation.active_contact_id}`,
          action_type: 'wait',
          account_id: rid,
          contact_id: rotation.active_contact_id,
          lifecycle_stage: String(recordRow.lifecycle_stage || 'contacted'),
          sequence_state: 'waiting',
          work_state: 'waiting_time_or_event',
          due_at: quietDate,
          reason: `manual_tail_complete:${sid}`,
          on_success: 'start_rotated_contact_cycle',
          related_asset_id: rotation.previous_contact_id || null,
          policy_version: NEXT_ACTION_POLICY_VERSION,
        }),
        call_claim_status: 'open',
        call_claimed_by: '',
        call_claimed_at: '',
        call_claim_expires_at: '',
        call_claim_contact_id: '',
        last_error: '',
      };
      if (rotation.account_contact_plan_json) {
        patched.account_contact_plan_json = rotation.account_contact_plan_json;
      }
      ensureRecordColumns({
        db,
        columns: [
          'active_contact_id',
          'contact_id',
          'account_contact_plan_json',
          'sequence_step',
          'sequence_status',
          'next_action_date',
          'account_sequence_state',
          'work_state',
          'next_action_json',
          'call_claim_status',
          'call_claimed_by',
          'call_claimed_at',
          'call_claim_expires_at',
          'call_claim_contact_id',
          'last_error',
        ],
      });
      upsertRecord({ db, row: patched });
    } else if (!rotation.rotated) {
      // No held contact left — mark account sequence completed for this campaign.
      try {
        ensureRecordColumns({ db, columns: ['sequence_status', 'contact_campaign_status'] });
        upsertRecord({
          db,
          row: {
            ...recordRow,
            sequence_status: 'completed',
            contact_campaign_status: 'exhausted',
          },
        });
      } catch { /* best-effort */ }
    }
  }

  return {
    status: skip ? 'manual_skipped' : 'manual_completed',
    record_id: rid,
    step_id: sid,
    note: text(note),
    completed_at: now,
    contact_id: activeContactAtComplete || undefined,
    ...(rotated ? { rotated: true, active_contact_id: nextContactId } : {}),
    ...(mail_allocated != null ? { mail_allocated } : {}),
    ...(mail_provider_status ? { mail_provider_status } : {}),
    ...(mail_piece_id ? { mail_piece_id } : {}),
  };
};
