import { validateWhereSql } from '../orchestrator/lib/sql-safety.js';
import {
  listDrafts,
  openListDb,
  updateDraft,
  ensureRecordColumns,
  upsertRecord,
} from '../orchestrator/runtime/db.js';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';
import {
  authorizeStageReview,
  appendTransitionAudit,
  parseStageReviewJson,
} from '../orchestrator/policy/transition-audit.js';
import { resolveStageAssetVersion } from '../orchestrator/policy/stage-review-gate.js';
import { assertRecordAccessForMutation } from '../orchestrator/policy/canary-isolation.js';
import { readConfig } from '../orchestrator/lib/config.js';
import { resolveSendMailbox } from '../orchestrator/lib/mailboxes.js';

/**
 * Compose the same material asset_version send uses:
 * account + contact + recipient + subject/body + draft id + step.
 */
export const composeOutboundReviewVersion = (input: {
  record: Record<string, unknown>;
  draft: Record<string, unknown>;
  stageId?: string;
  policyVersion?: string | null;
  sender?: string | null;
  mailboxId?: string | null;
}): string => {
  const record = input.record || {};
  const draft = input.draft || {};
  const subject = String(draft.subject || '');
  const body = String(draft.body || '');
  const stepId = String(draft.step_id || input.stageId || '').trim();
  const sender = String(
    input.sender
    ?? record.email_last_from
    ?? record.from_email
    ?? '',
  ).trim() || null;
  const mailboxId = String(
    input.mailboxId
    ?? record.assigned_mailbox_id
    ?? '',
  ).trim() || null;
  return resolveStageAssetVersion({
    accountId: String(record._row_id || record.id || ''),
    activeContactId: String(record.active_contact_id || record.contact_id || ''),
    contactId: String(record.contact_id || '') || null,
    recipient: String(record.contact_email || record.email || ''),
    sender,
    mailboxId,
    stepId,
    stageId: stepId,
    draftId: String(draft.draft_id || ''),
    bodyText: body,
    subjectText: subject,
    policyVersion: input.policyVersion
      ?? String((record as any).policy_version || ''),
  });
};

/**
 * Build the record patch for draft approval WITHOUT writing.
 *
 * Version binding: expected_asset_version is the review's original bound version.
 * Current material state is boundVersion. Silent replace of expected→current is
 * forbidden — drift invalidates and refuses ready.
 */
const planDraftApproval = ({
  record,
  draft,
}: {
  record: Record<string, unknown>;
  draft: Record<string, unknown>;
}): {
  authorized: boolean;
  reason: string;
  asset_version: string;
  /** Fields to merge onto the record (only applied on full success, or failure stamp). */
  recordPatch: Record<string, unknown>;
  /** When true, caller may mark the draft ready. */
  markReady: boolean;
} => {
  const existing = parseStageReviewJson(record.stage_review_json);
  const stepId = String(draft.step_id || '').trim();
  const boundVersion = composeOutboundReviewVersion({
    record,
    draft,
    stageId: stepId || existing?.stage_id,
  });

  // A review that was REFUSED must not yield a sendable draft. This branch used
  // to treat "no review exists" and "a review exists but was rejected or
  // invalidated" identically, marking the draft ready either way — so a message
  // a human had rejected could still become a fully populated, sendable
  // provider envelope. It also returned an empty record patch, leaving the
  // account on `paused_review` while the draft said `ready`: approved and paused
  // at the same time, with no path out, because the only site that clears
  // `paused_review` refuses terminal reviews and the only site that opens a
  // replacement review sits behind that same gate.
  const refusedStatuses = new Set(['rejected', 'invalidated', 'superseded', 'expired']);
  if (existing && refusedStatuses.has(String(existing.status || '').trim().toLowerCase())) {
    return {
      authorized: false,
      reason: `stage_review_${String(existing.status).trim().toLowerCase()}`,
      asset_version: boundVersion,
      recordPatch: {},
      markReady: false,
    };
  }

  if (!existing || (existing.status !== 'pending' && existing.status !== 'edited')) {
    return {
      authorized: true,
      reason: 'ready_without_stage_review',
      asset_version: boundVersion,
      recordPatch: {},
      markReady: true,
    };
  }

  const stageMatch =
    !stepId
    || String(existing.stage_id || '').trim() === stepId
    || String(existing.action_type || '').trim().toLowerCase() === 'send_email';
  if (!stageMatch) {
    return {
      authorized: false,
      reason: 'stage_mismatch',
      asset_version: boundVersion,
      recordPatch: {},
      markReady: false,
    };
  }

  // Expected version is what the human was shown / bound at pause — NEVER
  // silently rewrite it to the current material version.
  const expectedVersion = String(existing.asset_version || '').trim();
  const authorized = authorizeStageReview({
    review_id: existing.review_id,
    stage_id: existing.stage_id,
    asset_version: boundVersion,
    expected_asset_version: expectedVersion || boundVersion,
    decision: 'authorize',
    account_id: String(record._row_id || record.id || existing.account_id || ''),
    contact_id: existing.contact_id ?? null,
    existing,
    lifecycle_stage: String(record.lifecycle_stage || 'contacted'),
    actor: 'drafts_approve',
    notes: `Authorized via draft approval ${String(draft.draft_id || '')}`,
  });
  if (!authorized || typeof authorized !== 'object' || !('allowed' in authorized) || !authorized.allowed) {
    const deniedReason = (authorized && typeof authorized === 'object' && 'reason' in authorized)
      ? String((authorized as any).reason || 'stage_review_denied')
      : 'stage_review_denied';
    // Persist denial / version-mismatch invalidation when authorizeStageReview returns a patch.
    const denyPatch = (authorized && typeof authorized === 'object' && 'patch' in authorized)
      ? ((authorized as any).patch || {})
      : {};
    const denyAudit = (authorized && typeof authorized === 'object' && 'audit' in authorized)
      ? (authorized as any).audit
      : null;
    return {
      authorized: false,
      reason: deniedReason === 'asset_version_mismatch' ? 'asset_version_mismatch' : 'stage_review_denied',
      asset_version: boundVersion,
      recordPatch: {
        ...denyPatch,
        ...(denyAudit
          ? { transition_audit_json: appendTransitionAudit(record.transition_audit_json, denyAudit) }
          : {}),
      },
      markReady: false,
    };
  }

  const patch = authorized.patch || {};
  return {
    authorized: true,
    reason: 'authorized',
    asset_version: boundVersion,
    recordPatch: {
      ...patch,
      transition_audit_json: appendTransitionAudit(record.transition_audit_json, authorized.audit),
    },
    markReady: true,
  };
};

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');

const decodeCursor = (cursor: string) => {
  const raw = String(cursor || '').trim();
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return Math.max(0, Number(parsed?.offset || 0));
  } catch {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: 'Invalid cursor.',
      retryable: false,
    });
  }
};

export const draftsListCommand = ({ list, status = '', step = 0, cursor = '', limit = 100 }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    const clauses = ['1=1'];
    const params: any[] = [];
    if (status) {
      clauses.push('d.status = ?');
      params.push(String(status));
    }
    if (Number(step || 0) > 0) {
      clauses.push('d.step_number = ?');
      params.push(Number(step));
    }
    const offset = decodeCursor(cursor || '');
    const pageLimit = Math.max(1, Math.min(1000, Number(limit || 100)));
    const rows = listDrafts({
      db,
      whereSql: clauses.join(' AND '),
      params,
      limit: pageLimit + 1,
      offset,
    });
    const hasMore = rows.length > pageLimit;
    const pageRows = hasMore ? rows.slice(0, pageLimit) : rows;
    return {
      rows: pageRows,
      count: pageRows.length,
      next_cursor: hasMore ? encodeCursor(offset + pageLimit) : null,
    };
  } finally {
    db.close();
  }
};

export const draftsShowCommand = ({ list, draftId }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    const row = db.prepare(`
      SELECT d.*, r.business_name, r.sequence_status, COALESCE(r.fit_score, r.priority_rank) AS priority_rank
      FROM drafts d
      LEFT JOIN records r ON r._row_id = d.row_id
      WHERE d.draft_id = ?
      LIMIT 1
    `).get(String(draftId || '').trim());
    if (!row) {
      throw new AgentOutboundError({
        code: 'NOT_FOUND',
        message: `Draft not found: ${draftId}`,
        retryable: false,
      });
    }
    return { draft: row };
  } finally {
    db.close();
  }
};

const findDraftIdsByWhere = ({ db, where = '' }: { db: any; where?: string }) => {
  const whereSql = String(where || '').trim();
  if (!whereSql) return [];
  const check = validateWhereSql(whereSql);
  if (!check.ok) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: check.error || 'Invalid --where SQL fragment.',
      retryable: false,
    });
  }
  return db.prepare(`
    SELECT d.draft_id
    FROM drafts d
    LEFT JOIN records r ON r._row_id = d.row_id
    WHERE ${whereSql}
  `).all().map((item: any) => String(item.draft_id || '')).filter(Boolean);
};

export const draftsApproveCommand = ({ list, draftId = '', all = false, where = '' }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    let ids: string[] = [];
    if (all) ids = findDraftIdsByWhere({ db, where });
    else if (draftId) ids = [String(draftId).trim()];
    if (ids.length === 0) {
      throw new AgentOutboundError({
        code: 'INVALID_ARGUMENT',
        message: 'Provide --id <draft_id> or --all --where "<sql>".',
        retryable: false,
      });
    }
    let updated = 0;
    const failures: Array<{ draft_id: string; reason: string }> = [];
    // Resolve mailbox catalog so approval freezes from/mailbox_id (not send-time).
    let projectConfig: Record<string, unknown> = {};
    try {
      projectConfig = (readConfig(listDir).config || {}) as Record<string, unknown>;
    } catch {
      projectConfig = {};
    }
    for (const id of ids) {
      const existing = db.prepare('SELECT * FROM drafts WHERE draft_id = ? LIMIT 1').get(id) as
        | Record<string, unknown>
        | undefined;
      if (!existing) {
        failures.push({ draft_id: id, reason: 'not_found' });
        continue;
      }
      const rowId = String(existing.row_id || '').trim();
      // Canary before any status flip.
      assertRecordAccessForMutation({ listDir, recordId: rowId });

      let record = db.prepare('SELECT * FROM records WHERE _row_id = ? LIMIT 1').get(rowId) as
        | Record<string, unknown>
        | undefined;
      if (!record) {
        failures.push({ draft_id: id, reason: 'record_missing' });
        continue;
      }

      // Resolve mailbox BEFORE human-approved envelope is frozen.
      let resolvedFrom = String(record.email_last_from || record.from_email || '').trim();
      let resolvedMailboxId = String(record.assigned_mailbox_id || '').trim();
      try {
        const mb = resolveSendMailbox({
          listDir,
          config: projectConfig,
          db,
          record,
          stepConfig: {},
        });
        if (mb) {
          resolvedMailboxId = String(mb.id || resolvedMailboxId || '');
          resolvedFrom = String(
            mb.credentials?.SMTP_FROM || mb.credentials?.SMTP_USER || resolvedFrom || '',
          ).trim();
          record = {
            ...record,
            assigned_mailbox_id: resolvedMailboxId,
            email_last_from: resolvedFrom,
          };
        }
      } catch {
        // No mailbox catalog in harness — still refuse blank envelope below.
      }

      const hasSubject = String(existing.subject || '').trim() !== '';
      const hasBody = String(existing.body || '').trim() !== '';
      if (!hasSubject || !hasBody) {
        const missing = [
          ...(!hasSubject ? ['subject'] : []),
          ...(!hasBody ? ['body'] : []),
        ];
        failures.push({
          draft_id: id,
          reason: `draft_content_incomplete:missing_${missing.join('_and_')}`,
        });
        continue;
      }

      const recipient = String(record.contact_email || record.email || '').trim().toLowerCase();
      // Refuse approval when the immutable envelope would be incomplete.
      // Human review must bind exact recipient + from + mailbox_id.
      if (!recipient || !resolvedFrom || !resolvedMailboxId) {
        failures.push({
          draft_id: id,
          reason: `provider_envelope_incomplete:recipient=${recipient ? 'ok' : 'blank'},from=${resolvedFrom ? 'ok' : 'blank'},mailbox_id=${resolvedMailboxId ? 'ok' : 'blank'}`,
        });
        continue;
      }

      // Plan authorize + patches (pure; no writes).
      const plan = planDraftApproval({
        record,
        draft: existing,
      });

      // Hard failures that must not mark ready (including stage_mismatch).
      if (!plan.markReady) {
        // Persist a review failure or version-drift patch without marking ready.
        try {
          const failTx = db.transaction(() => {
            ensureRecordColumns({
              db,
              columns: [
                ...Object.keys(plan.recordPatch),
                'transition_audit_json',
                'stage_review_json',
                'account_sequence_state',
                'work_state',
                'next_action_json',
              ],
            });
            upsertRecord({ db, row: { ...record, ...plan.recordPatch } });
          });
          failTx();
        } catch { /* leave pending even if stamp fails */ }
        failures.push({ draft_id: id, reason: String(plan.reason) });
        continue;
      }

      // 3) Atomic success: record patch + draft ready + immutable provider envelope
      // stored on the draft (not only the record — record upserts can wipe it later).
      try {
        const successTx = db.transaction(() => {
          ensureRecordColumns({
            db,
            columns: [
              ...Object.keys(plan.recordPatch),
              'transition_audit_json',
              'stage_review_json',
              'account_sequence_state',
              'work_state',
              'next_action_json',
              'related_review_id',
              'assigned_mailbox_id',
              'email_last_from',
            ],
          });
          // Immutable envelope the human approved — reloaded at send, never rebuilt from send-time state alone.
          const envelope = {
            draft_id: id,
            row_id: rowId,
            subject: String(existing.subject || ''),
            body: String(existing.body || ''),
            recipient,
            from: resolvedFrom,
            mailbox_id: resolvedMailboxId,
            asset_version: plan.asset_version || '',
            approved_at: new Date().toISOString(),
          };
          upsertRecord({
            db,
            row: {
              ...record,
              ...plan.recordPatch,
              assigned_mailbox_id: resolvedMailboxId,
              email_last_from: resolvedFrom,
            },
          });
          const next = updateDraft({
            db,
            draftId: id,
            patch: {
              status: 'ready',
              content_binding: {
                provider_envelope: envelope,
              },
            },
          });
          if (!next) {
            throw new Error('update_failed');
          }
        });
        successTx();
        updated += 1;
      } catch (err) {
        failures.push({
          draft_id: id,
          reason: String((err as any)?.message || err || 'update_failed'),
        });
      }
    }
    if (updated === 0 && failures.length > 0 && ids.length === 1) {
      throw new AgentOutboundError({
        code: 'INVALID_ARGUMENT',
        message: `Draft approval failed: ${failures[0].reason}`,
        retryable: false,
        fields: { draft_id: failures[0].draft_id, reason: failures[0].reason },
      });
    }
    return { approved: updated, requested: ids.length, failures };
  } finally {
    db.close();
  }
};

export const draftsRejectCommand = ({ list, draftId, reason = '' }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const next = updateDraft({
      db,
      draftId: String(draftId || '').trim(),
      patch: {
        status: 'rejected',
        reason: String(reason || ''),
      },
    });
    if (!next) {
      throw new AgentOutboundError({
        code: 'NOT_FOUND',
        message: `Draft not found: ${draftId}`,
        retryable: false,
      });
    }
    return { status: 'rejected', draft_id: next.draft_id };
  } finally {
    db.close();
  }
};

export const draftsEditCommand = ({ list, draftId, subject = '', body = '' }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const patch: Record<string, any> = {};
    if (subject) patch.subject = String(subject);
    if (body) patch.body = String(body);
    if (Object.keys(patch).length === 0) {
      throw new AgentOutboundError({
        code: 'INVALID_ARGUMENT',
        message: 'Provide at least one of --subject or --body.',
        retryable: false,
      });
    }
    patch.status = 'pending_approval';
    patch.content_binding = {};

    const existingDraft = db.prepare('SELECT * FROM drafts WHERE draft_id = ? LIMIT 1')
      .get(String(draftId || '').trim()) as Record<string, unknown> | undefined;
    if (!existingDraft) {
      throw new AgentOutboundError({
        code: 'NOT_FOUND',
        message: `Draft not found: ${draftId}`,
        retryable: false,
      });
    }
    const rowId = String(existingDraft.row_id || '').trim();
    assertRecordAccessForMutation({ listDir, recordId: rowId });

    // Atomic: draft content edit + invalidate stage authorization.
    const editTx = db.transaction(() => {
      const next = updateDraft({ db, draftId: String(draftId || '').trim(), patch });
      if (!next) throw new Error('update_failed');

      if (rowId) {
        const record = db.prepare('SELECT * FROM records WHERE _row_id = ? LIMIT 1').get(rowId) as
          | Record<string, unknown>
          | undefined;
        if (record) {
          const existingReview = parseStageReviewJson(record.stage_review_json);
          let stagePatch: Record<string, unknown> = {};
          if (existingReview && (existingReview.status === 'authorized'
            || existingReview.status === 'pending'
            || existingReview.status === 'edited')) {
            const invalidated = authorizeStageReview({
              review_id: existingReview.review_id,
              stage_id: existingReview.stage_id,
              asset_version: existingReview.asset_version,
              expected_asset_version: existingReview.asset_version,
              decision: 'invalidate',
              account_id: String(record._row_id || record.id || existingReview.account_id || ''),
              contact_id: existingReview.contact_id ?? null,
              existing: existingReview,
              lifecycle_stage: String(record.lifecycle_stage || 'contacted'),
              actor: 'drafts_edit',
              notes: `Invalidated by draft edit ${String(draftId || '')}`,
            });
            if (invalidated && typeof invalidated === 'object' && 'patch' in invalidated) {
              stagePatch = {
                ...stagePatch,
                ...(invalidated as any).patch,
                transition_audit_json: appendTransitionAudit(
                  record.transition_audit_json,
                  (invalidated as any).audit,
                ),
              };
            }
          }
          ensureRecordColumns({
            db,
            columns: [
              ...Object.keys(stagePatch),
              'stage_review_json',
              'transition_audit_json',
            ],
          });
          upsertRecord({ db, row: { ...record, ...stagePatch } });
        }
      }
      return next;
    });
    const next = editTx();
    return {
      status: 'edited',
      draft_id: next.draft_id,
      authorization_invalidated: true,
    };
  } finally {
    db.close();
  }
};
