/**
 * LinkedIn relationship lifecycle for connect → accept/decline → message gates.
 *
 * States (record.linkedin_lifecycle_state / linkedin_relationship_state):
 *   none            — no invite sent
 *   invite_sent     — connection invite acknowledged by provider
 *   accepted        — invite accepted (connection exists)
 *   declined        — invite declined / withdrawn / ignored terminal
 *   message_allowed — accepted and messaging is permitted
 *
 * Execute path (linkedin_connect) honors:
 *   - cooldown after invite_sent (default 24h; config override)
 *   - no second invite when invite_sent / accepted / message_allowed
 *   - declined is terminal for connect (skip)
 * Stage review for connect remains owned by stage-review-gate / execute.ts.
 */

import {
  DEFAULT_CONTACT_POLICY,
  resolveContactPolicy,
  type ContactPolicyConfigInput,
} from '../../schemas/config.js';
import { nowIso } from '../lib/record.js';

export const LINKEDIN_LIFECYCLE_STATES = [
  'none',
  'invite_sent',
  'accepted',
  'declined',
  'message_allowed',
] as const;

export type LinkedinLifecycleState = (typeof LINKEDIN_LIFECYCLE_STATES)[number];

export const LINKEDIN_CONNECT_COOLDOWN_HOURS_DEFAULT = 0;

const text = (value: unknown) => String(value ?? '').trim();

export function parseLinkedinLifecycleState(
  record: Record<string, unknown> | null | undefined,
): LinkedinLifecycleState {
  const raw = text(
    record?.linkedin_lifecycle_state
    || record?.linkedin_relationship_state
    || '',
  ).toLowerCase();
  if ((LINKEDIN_LIFECYCLE_STATES as readonly string[]).includes(raw)) {
    return raw as LinkedinLifecycleState;
  }
  // Infer from provider ack when explicit state missing.
  const provider = text(
    record?.linkedin_last_provider_id || record?.linkedin_last_connect_provider_id || '',
  );
  if (provider) return 'invite_sent';
  return 'none';
}

export type LinkedinConnectGate = {
  allowed: boolean;
  reason: string;
  state: LinkedinLifecycleState;
  cooldown_remaining_ms?: number;
};

/**
 * Whether linkedin_connect may fire for this record.
 * Does not evaluate Unipile readiness or stage review — only lifecycle + cooldown.
 */
export function evaluateLinkedinConnectGate(
  record: Record<string, unknown> | null | undefined,
  opts: {
    cooldownHours?: number;
    contactPolicy?: ContactPolicyConfigInput;
    nowMs?: number;
    /** When true, skip cooldown check (dry-run / admin). */
    ignoreCooldown?: boolean;
  } = {},
): LinkedinConnectGate {
  const state = parseLinkedinLifecycleState(record);
  const nowMs = opts.nowMs ?? Date.parse(nowIso());
  const configuredCooldown = resolveContactPolicy(opts.contactPolicy).linkedin.invite_cooldown_hours;
  const hours = Number.isFinite(Number(opts.cooldownHours)) && Number(opts.cooldownHours) >= 0
    ? Number(opts.cooldownHours)
    : (configuredCooldown ?? LINKEDIN_CONNECT_COOLDOWN_HOURS_DEFAULT);

  if (state === 'declined') {
    return {
      allowed: false,
      reason: 'linkedin_lifecycle_declined',
      state,
    };
  }
  if (state === 'accepted' || state === 'message_allowed') {
    return {
      allowed: false,
      reason: 'linkedin_already_connected',
      state,
    };
  }
  if (state === 'invite_sent') {
    // Provider ack present — do not re-invite (idempotent).
    const provider = text(
      record?.linkedin_last_provider_id || record?.linkedin_last_connect_provider_id || '',
    );
    if (provider) {
      return {
        allowed: false,
        reason: 'linkedin_invite_already_sent',
        state,
      };
    }
    // invite_sent without provider id: still honor cooldown on last_connect_at.
    if (!opts.ignoreCooldown) {
      const lastAt = text(record?.linkedin_last_connect_at);
      if (lastAt) {
        const lastMs = Date.parse(lastAt);
        if (Number.isFinite(lastMs)) {
          const windowMs = hours * 60 * 60 * 1000;
          const elapsed = nowMs - lastMs;
          if (elapsed >= 0 && elapsed < windowMs) {
            return {
              allowed: false,
              reason: 'cooldown',
              state,
              cooldown_remaining_ms: windowMs - elapsed,
            };
          }
        }
      }
    }
  }

  // none — check cooldown if a previous attempt left last_connect_at without state.
  if (!opts.ignoreCooldown) {
    const lastAt = text(record?.linkedin_last_connect_at);
    if (lastAt) {
      const lastMs = Date.parse(lastAt);
      if (Number.isFinite(lastMs)) {
        const windowMs = hours * 60 * 60 * 1000;
        const elapsed = nowMs - lastMs;
        if (elapsed >= 0 && elapsed < windowMs) {
          return {
            allowed: false,
            reason: 'cooldown',
            state,
            cooldown_remaining_ms: windowMs - elapsed,
          };
        }
      }
    }
  }

  return { allowed: true, reason: 'ok', state };
}

/** Whether LinkedIn messaging is allowed (accepted → message_allowed). */
export function evaluateLinkedinMessageGate(
  record: Record<string, unknown> | null | undefined,
): { allowed: boolean; reason: string; state: LinkedinLifecycleState } {
  const state = parseLinkedinLifecycleState(record);
  if (state === 'message_allowed') {
    return { allowed: true, reason: 'ok', state };
  }
  if (state === 'accepted') {
    // Accepted implies message_allowed for product path.
    return { allowed: true, reason: 'ok_accepted', state };
  }
  if (state === 'declined') {
    return { allowed: false, reason: 'linkedin_lifecycle_declined', state };
  }
  if (state === 'invite_sent') {
    return { allowed: false, reason: 'linkedin_invite_pending', state };
  }
  return { allowed: false, reason: 'linkedin_not_connected', state };
}

export function applyLinkedinInviteSent(input: {
  record: Record<string, unknown>;
  providerId: string;
  at?: string;
}): { patch: Record<string, unknown>; state: LinkedinLifecycleState } {
  const at = String(input.at || nowIso());
  const providerId = text(input.providerId);
  return {
    state: 'invite_sent',
    patch: {
      ...input.record,
      linkedin_lifecycle_state: 'invite_sent',
      linkedin_relationship_state: 'invite_sent',
      linkedin_last_provider_id: providerId || input.record.linkedin_last_provider_id,
      linkedin_last_connect_at: at,
      linkedin_invite_sent_at: at,
    },
  };
}

export function applyLinkedinInviteAccepted(input: {
  record: Record<string, unknown>;
  at?: string;
  allowMessage?: boolean;
}): { patch: Record<string, unknown>; state: LinkedinLifecycleState } {
  const at = String(input.at || nowIso());
  const allowMessage = input.allowMessage !== false;
  const state: LinkedinLifecycleState = allowMessage ? 'message_allowed' : 'accepted';
  return {
    state,
    patch: {
      ...input.record,
      linkedin_lifecycle_state: state,
      linkedin_relationship_state: state,
      linkedin_accepted_at: at,
      ...(allowMessage ? { linkedin_message_allowed_at: at } : {}),
    },
  };
}

export function applyLinkedinInviteDeclined(input: {
  record: Record<string, unknown>;
  at?: string;
  reason?: string;
}): { patch: Record<string, unknown>; state: LinkedinLifecycleState } {
  const at = String(input.at || nowIso());
  return {
    state: 'declined',
    patch: {
      ...input.record,
      linkedin_lifecycle_state: 'declined',
      linkedin_relationship_state: 'declined',
      linkedin_declined_at: at,
      linkedin_decline_reason: String(input.reason || 'declined'),
    },
  };
}

/** Legal transitions for explicit lifecycle updates (accept/decline from none only via invite_sent). */
export function canTransitionLinkedinLifecycle(
  from: LinkedinLifecycleState,
  to: LinkedinLifecycleState,
): boolean {
  if (from === to) return true;
  const edges: Record<LinkedinLifecycleState, LinkedinLifecycleState[]> = {
    none: ['invite_sent'],
    invite_sent: ['accepted', 'declined', 'message_allowed'],
    accepted: ['message_allowed', 'declined'],
    message_allowed: ['declined'],
    declined: [], // terminal for connect path
  };
  return (edges[from] || []).includes(to);
}
