import {
  completeFollowUp,
  getInteraction,
  insertInteraction,
  listInteractionsForRecord,
  listOpenFollowUps,
  openListDb,
  resolveRecordRef,
  softDeleteInteraction,
  updateInteraction,
} from '../orchestrator/runtime/db.js';
import { leadStatus } from '../orchestrator/runtime/status.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';
import { assertRecordAccessForMutation } from '../orchestrator/policy/canary-isolation.js';

const interactionView = (row: any) => ({
  interaction_id: String(row.interaction_id || ''),
  record_id: String(row.record_id || ''),
  kind: String(row.kind || ''),
  contact: String(row.contact || ''),
  summary: String(row.summary || ''),
  body: String(row.body || ''),
  objections: String(row.objections || ''),
  follow_up_at: String(row.follow_up_at || ''),
  follow_up_done_at: String(row.follow_up_done_at || ''),
  follow_up_note: String(row.follow_up_note || ''),
  occurred_at: String(row.occurred_at || ''),
  created_by: String(row.created_by || ''),
  ...(String(row.deleted_at || '').trim() ? { deleted_at: String(row.deleted_at) } : {}),
});

const recordLabel = (record: any) => ({
  row_id: String(record._row_id || record.id || ''),
  business_name: String(record.business_name || record.name || ''),
});

export const interactionAddCommand = ({ list, ref, kind = 'note', summary, body = '', objections = '', contact = '', followUp = '', followUpNote = '', occurredAt = '', createdBy = '' }: { list: string; ref: string; kind?: string; summary: string; body?: string; objections?: string; contact?: string; followUp?: string; followUpNote?: string; occurredAt?: string; createdBy?: string }) => {
  if (!String(summary || '').trim()) throw new AgentOutboundError({ code: 'INVALID_ARGUMENT', message: 'interaction add requires --summary.', retryable: false });
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const record = resolveRecordRef({ db, ref });
    // Strict canary gate before any interaction write.
    assertRecordAccessForMutation({ listDir, recordId: String(record._row_id || '') });
    const interaction = insertInteraction({
      db,
      recordId: String(record._row_id),
      kind,
      summary,
      body,
      objections,
      contact,
      followUpAt: followUp,
      followUpNote,
      occurredAt,
      createdBy,
    });
    return {
      status: 'interaction_logged',
      record: recordLabel(record),
      lead_status: leadStatus(record),
      interaction: interactionView(interaction),
      ...(String(followUp || '').trim() ? { note: `Follow-up set for ${followUp}; it will appear in \`followups\` until completed with \`interaction done\`.` } : {}),
    };
  } finally {
    db.close();
  }
};

export const interactionListCommand = ({ list, ref = '', kind = '', due = false, overdue = false }: { list: string; ref?: string; kind?: string; due?: boolean; overdue?: boolean }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows = (() => {
      if (String(ref || '').trim()) {
        const record = resolveRecordRef({ db, ref });
        return listInteractionsForRecord({ db, recordId: String(record._row_id) })
          .map((row: any) => ({ ...row, business_name: record.business_name }));
      }
      if (due || overdue) return listOpenFollowUps({ db, dueBy: today });
      return db.prepare(`
        SELECT i.*, r.business_name FROM interactions i
        LEFT JOIN records r ON r._row_id = i.record_id
        WHERE COALESCE(i.deleted_at, '') = ''
        ORDER BY i.occurred_at DESC LIMIT 200
      `).all();
    })();
    const filtered = rows
      .filter((row: any) => !kind || String(row.kind) === String(kind).trim().toLowerCase())
      .filter((row: any) => !overdue || String(row.follow_up_at || '').slice(0, 10) < today);
    return {
      count: filtered.length,
      interactions: filtered.map((row: any) => ({ ...interactionView(row), business_name: String(row.business_name || '') })),
    };
  } finally {
    db.close();
  }
};

export const interactionShowCommand = ({ list, interactionId }: { list: string; interactionId: string }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    const interaction = getInteraction({ db, interactionId });
    if (!interaction) throw new AgentOutboundError({ code: 'NOT_FOUND', message: `Interaction not found: ${interactionId}`, retryable: false });
    return { interaction: interactionView(interaction) };
  } finally {
    db.close();
  }
};

export const interactionEditCommand = ({ list, interactionId, patch }: { list: string; interactionId: string; patch: Record<string, any> }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const interaction = updateInteraction({ db, interactionId, patch });
    return { status: 'interaction_updated', interaction: interactionView(interaction) };
  } finally {
    db.close();
  }
};

export const interactionDoneCommand = ({ list, interactionId, note = '' }: { list: string; interactionId: string; note?: string }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const interaction = completeFollowUp({ db, interactionId, note });
    return { status: 'follow_up_completed', interaction: interactionView(interaction) };
  } finally {
    db.close();
  }
};

export const interactionRemoveCommand = ({ list, interactionId }: { list: string; interactionId: string }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const interaction = softDeleteInteraction({ db, interactionId });
    return { status: 'interaction_removed', interaction: interactionView(interaction) };
  } finally {
    db.close();
  }
};

export const followupsCommand = ({ list, dueBy = '' }: { list: string; dueBy?: string }) => {
  // Note: visit/door-to-door follow-ups are filtered from operator noise (forbidden motion).
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows = listOpenFollowUps({ db, dueBy }).filter((row: any) => {
      const kind = String(row.kind || row.channel || '').toLowerCase();
      // Forbidden motion: never surface visit / door-to-door as operator follow-up work.
      if (kind.includes('visit') || kind.includes('door') || kind.includes('field')) return false;
      return true;
    });
    const followups = rows.map((row: any) => {
      const dueDate = String(row.follow_up_at || '').slice(0, 10);
      return {
        ...interactionView(row),
        business_name: String(row.business_name || ''),
        phone: String(row.phone || ''),
        address: String(row.address || ''),
        due: dueDate,
        state: dueDate < today ? 'overdue' : dueDate === today ? 'due_today' : 'upcoming',
      };
    });
    return {
      count: followups.length,
      overdue: followups.filter((f: any) => f.state === 'overdue').length,
      due_today: followups.filter((f: any) => f.state === 'due_today').length,
      followups,
    };
  } finally {
    db.close();
  }
};
