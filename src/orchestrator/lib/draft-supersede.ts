/**
 * Shared draft supersession: mark the old draft superseded and queue a fresh
 * pending_approval draft from the currently rendered content.
 *
 * Used by the send-time divergence gate and by `drafts refresh`. There must be
 * exactly one superseding path — callers must not re-implement this transaction.
 */
import { randomUUID } from 'node:crypto';
import { insertDraft, updateDraft } from '../runtime/db.js';

export type RenderedDraftContent = {
  subject: string;
  body: string;
  contentHash: string;
  templateId: string;
  templateVersion: number | null;
};

export const supersedeDraftWithRenderedContent = ({
  db,
  draft,
  rendered,
  changeReason,
  newDraftReason,
}: {
  db: any;
  draft: Record<string, unknown>;
  rendered: RenderedDraftContent;
  /** Reason stamped on the superseded draft (e.g. content-approval failure text). */
  changeReason: string;
  /** Optional reason stamped on the replacement draft. */
  newDraftReason?: string;
}): { superseded_draft_id: string; new_draft_id: string } => {
  const freshDraftId = `draft_${randomUUID()}`;
  const supersededId = String(draft.draft_id || '');
  const run = db.transaction(() => {
    updateDraft({
      db,
      draftId: supersededId,
      patch: {
        status: 'superseded',
        reason: `${changeReason} Superseded by ${freshDraftId}.`,
        content_binding: {},
      },
    });
    insertDraft({
      db,
      draft: {
        draft_id: freshDraftId,
        row_id: String(draft.row_id || ''),
        sequence_name: String(draft.sequence_name || 'default'),
        step_number: Number(draft.step_number || 0),
        step_id: String(draft.step_id || ''),
        channel: String(draft.channel || 'email'),
        status: 'pending_approval',
        subject: rendered.subject,
        body: rendered.body,
        reason: newDraftReason
          || `Supersedes ${supersededId} because rendered content changed.`,
        content_hash: rendered.contentHash,
        template_id: rendered.templateId,
        template_version: rendered.templateVersion,
        content_source: 'rendered',
        content_binding: {},
        artifacts: { supersedes_draft_id: supersededId },
      },
    });
  });
  run();
  return { superseded_draft_id: supersededId, new_draft_id: freshDraftId };
};
