/**
 * Asset ↔ claim-packet binding for executed channel sends.
 *
 * Every external send (email / LinkedIn with commercial body / mail with copy)
 * and call disposition records which permitted claims and audit version rode
 * with the asset. Audit export reads `asset_claim_binding_json` from the
 * channel event payload (and optionally the record).
 */

import { stableHash } from '../lib/record.js';
import { CLAIM_AUDIT_VERSION } from './claim-audit.js';
import { isReviewRequired } from './stage-review-gate.js';

const nonBlank = (value: unknown) => String(value ?? '').trim();

/**
 * Hash of the exact assetText that was claim-audited.
 * Persist as claim_audit_asset_hash when audit runs; recompute body on send and
 * refuse when the stored hash is present and differs (copy changed after audit).
 */
export function claimAuditAssetHash(assetText: unknown): string {
  const raw = String(assetText ?? '');
  if (!raw) return '';
  return stableHash(raw);
}

/**
 * Hash of the final drafted email asset (subject + body) — the only artifact
 * that may authorize claim_audit for outbound email.
 */
export function draftAssetText(input: {
  subject?: string | null;
  body?: string | null;
}): string {
  const subject = nonBlank(input.subject);
  const body = nonBlank(input.body);
  if (!subject && !body) return '';
  return [subject, body].filter(Boolean).join('\n');
}

/**
 * Refuse send when:
 * - claim_audit_passed is true but claim_audit_asset_hash is missing (fail closed), or
 * - hash is present and the body about to send no longer matches.
 *
 * Missing hash with claim_audit_passed=1 previously allowed unrelated unsupported
 * email content through — that path is closed.
 */
export function claimAuditAssetHashMismatch(input: {
  record?: Record<string, unknown> | null;
  bodyText?: string | null;
  subjectText?: string | null;
  /** When true (default for commercial email), missing hash fails closed if audit passed. */
  requireHashWhenPassed?: boolean;
}): { blocked: boolean; reason?: string; expected?: string; actual?: string } {
  const stored = nonBlank(input.record?.claim_audit_asset_hash);
  const body = nonBlank(input.bodyText);
  const subject = nonBlank(input.subjectText);
  const sendText = draftAssetText({ subject, body: body || input.bodyText });
  const actual = sendText ? claimAuditAssetHash(sendText) : claimAuditAssetHash(input.bodyText ?? '');
  const passed = isClaimAuditPassed(input.record);
  const requireHash = input.requireHashWhenPassed !== false;

  // Fail closed: commercial pass without bound hash cannot authorize a send.
  if (requireHash && passed && !stored && (body || subject || nonBlank(input.bodyText))) {
    return {
      blocked: true,
      reason: 'claim_audit_asset_hash_missing: claim_audit_passed without bound draft asset hash',
      expected: '',
      actual: actual || '',
    };
  }

  if (!stored) return { blocked: false };

  if (!actual) {
    return {
      blocked: true,
      reason: 'claim_audit_asset_hash_mismatch: send body empty but audit hash present',
      expected: stored,
      actual: '',
    };
  }
  if (actual !== stored) {
    return {
      blocked: true,
      reason: 'claim_audit_asset_hash_mismatch: copy changed after claim audit',
      expected: stored,
      actual,
    };
  }
  return { blocked: false };
}

export type AssetClaimBinding = {
  claim_packet_hash: string;
  claim_audit_version: string;
  preliminary_snapshot_hash: string;
  claim_audit_passed: number;
  asset_id: string;
  channel: string;
  step_id: string;
  bound_at: string;
  /** Claim ids from the permitted packet (when parseable). */
  permitted_claim_ids: string[];
  family_id: string;
  withhold_reason: string;
};

export type ContentBinding = {
  claim_packet_hash: string;
  claim_audit_version: string;
  preliminary_snapshot_hash: string;
  claim_audit_passed: number;
};

/** Explicit claim_audit_passed failure (0/false), not merely missing. */
export function isClaimAuditFailed(
  record: Record<string, unknown> | null | undefined,
): boolean {
  const raw = record?.claim_audit_passed;
  if (raw === false || raw === 0 || raw === '0' || raw === 'false') return true;
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n === 0) return true;
    if (String(raw).trim().toLowerCase() === 'false') return true;
    if (String(raw).trim().toLowerCase() === 'failed') return true;
  }
  return false;
}

/** True when claim_audit_passed is an explicit pass (1 / true / "1" / "1.0"). */
export function isClaimAuditPassed(
  record: Record<string, unknown> | null | undefined,
): boolean {
  const raw = record?.claim_audit_passed;
  if (raw === true || raw === 1 || raw === '1') return true;
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n === 1) return true;
    const s = String(raw).trim().toLowerCase();
    if (s === 'true' || s === '1.0' || s === 'passed') return true;
  }
  return false;
}

/**
 * Content-version binding from the diagnostic record (packet / audit / snapshot hashes).
 * Used by drafts and channel events as the compact content_binding shape.
 */
export function contentBindingFromRecord(
  record: Record<string, unknown> | null | undefined,
): ContentBinding {
  const packetRaw = record?.permitted_claim_packet_json;
  const packetStr = packetRaw == null || packetRaw === ''
    ? ''
    : (typeof packetRaw === 'string' ? packetRaw : JSON.stringify(packetRaw));
  const snapshotRaw = record?.preliminary_snapshot;
  const snapshotStr = snapshotRaw == null || snapshotRaw === ''
    ? ''
    : String(snapshotRaw);

  let claimAuditVersion = '';
  const auditRaw = record?.claim_audit_json;
  if (auditRaw) {
    try {
      const parsed = typeof auditRaw === 'string' ? JSON.parse(String(auditRaw)) : auditRaw;
      claimAuditVersion = String((parsed as any)?.policy_version || CLAIM_AUDIT_VERSION || '');
    } catch {
      claimAuditVersion = CLAIM_AUDIT_VERSION;
    }
  } else if (packetStr || snapshotStr) {
    claimAuditVersion = CLAIM_AUDIT_VERSION;
  }

  return {
    claim_packet_hash: packetStr ? stableHash(packetStr) : '',
    claim_audit_version: claimAuditVersion,
    preliminary_snapshot_hash: snapshotStr ? stableHash(snapshotStr) : '',
    claim_audit_passed: isClaimAuditPassed(record) ? 1 : 0,
  };
}

function parsePacketMeta(record: Record<string, unknown> | null | undefined): {
  claim_ids: string[];
  family_id: string;
  withhold_reason: string;
} {
  const raw = record?.permitted_claim_packet_json;
  if (raw == null || raw === '') {
    return { claim_ids: [], family_id: '', withhold_reason: '' };
  }
  try {
    const packet = typeof raw === 'string' ? JSON.parse(String(raw)) : raw;
    const claims = Array.isArray(packet?.permitted_claims) ? packet.permitted_claims : [];
    const claim_ids = claims
      .map((c: any) => String(c?.claim_id || '').trim())
      .filter(Boolean);
    return {
      claim_ids,
      family_id: String(packet?.family_id || ''),
      withhold_reason: String(packet?.withhold_reason || ''),
    };
  } catch {
    return { claim_ids: [], family_id: '', withhold_reason: '' };
  }
}

/**
 * Full asset↔claim binding for audit export: which claims rode with which send.
 * Persist as `asset_claim_binding_json` on the channel event payload / record.
 */
export function buildAssetClaimBinding(input: {
  record: Record<string, unknown> | null | undefined;
  assetId?: string | null;
  channel?: string | null;
  stepId?: string | null;
  at?: string | null;
}): AssetClaimBinding {
  const content = contentBindingFromRecord(input.record);
  const meta = parsePacketMeta(input.record);
  return {
    ...content,
    asset_id: nonBlank(input.assetId),
    channel: nonBlank(input.channel),
    step_id: nonBlank(input.stepId),
    bound_at: nonBlank(input.at) || new Date().toISOString(),
    permitted_claim_ids: meta.claim_ids,
    family_id: meta.family_id,
    withhold_reason: meta.withhold_reason,
  };
}

/** JSON string of the binding (for record columns / event payloads). */
export function assetClaimBindingJson(
  input: Parameters<typeof buildAssetClaimBinding>[0],
): string {
  return JSON.stringify(buildAssetClaimBinding(input));
}

/**
 * Detect commercial authored content that must be claim-audited before external send.
 *
 * - Explicit body/message/copy fields on the record or supplied opts
 * - Preliminary snapshot / claim packet bound on the account (diagnostic content)
 * - LinkedIn invite_message (not mere step description labels)
 */
export function recordHasCommercialContent(
  record: Record<string, unknown> | null | undefined,
  opts?: {
    channel?: string;
    /** Explicit authored body being sent (email body, LI invite message, mail copy). */
    bodyText?: string | null;
    /** When true, treat as commercial even without body fields (e.g. GT product). */
    forceCommercial?: boolean;
  },
): boolean {
  if (opts?.forceCommercial) return true;
  if (nonBlank(opts?.bodyText)) return true;

  const r = record || {};
  const copyFields = [
    r.preliminary_snapshot,
    r.permitted_claim_packet_json,
    r.mail_copy,
    r.mail_body,
    r.postcard_copy,
    r.postcard_body,
    r.golden_ticket_copy,
    r.golden_ticket_body,
    r.linkedin_message,
    r.linkedin_invite_message,
    r.linkedin_message_body,
    r.email_body,
    r.email_last_body,
  ];
  if (copyFields.some((v) => nonBlank(v))) return true;

  // Packet present with at least one permitted claim ⇒ commercial surface bound.
  try {
    const raw = r.permitted_claim_packet_json;
    if (raw) {
      const packet = typeof raw === 'string' ? JSON.parse(String(raw)) : raw;
      if (Array.isArray(packet?.permitted_claims) && packet.permitted_claims.length > 0) {
        return true;
      }
    }
  } catch {
    /* ignore parse errors — blank packet is not commercial */
  }
  return false;
}

/**
 * Detect commercial LinkedIn body from step config / record (not bare connect).
 * step.description alone is NOT commercial (often "Connect on LinkedIn").
 */
export function linkedinCommercialBody(input: {
  record?: Record<string, unknown> | null;
  step?: { config?: Record<string, unknown>; description?: string } | null;
}): string {
  const cfg = input.step?.config || {};
  const fromStep = nonBlank(
    cfg.invite_message
    || cfg.message
    || cfg.connection_note
    || cfg.body,
  );
  if (fromStep) return fromStep;
  const r = input.record || {};
  return nonBlank(
    r.linkedin_invite_message
    || r.linkedin_message
    || r.linkedin_message_body,
  );
}

/**
 * Refuse external send when claim audit failed and commercial content is present.
 *
 * Channel rules:
 * - email: block explicit audit fail under enforce_readiness / review / bound content
 *          (draft ready does not override claim audit)
 * - linkedin: block only when a commercial invite/message body is present
 * - mail: block when commercial copy / snapshot / packet is present
 * - call: never blocks (disposition is human logging; still stamp binding)
 */
export function claimAuditBlocksExternalSend(input: {
  config?: any;
  record: Record<string, unknown>;
  channel: 'email' | 'linkedin' | 'mail' | 'call' | string;
  stepKind?: string;
  taskType?: string;
  /** Explicit commercial body when known (LI invite message, mail merge copy, email body). */
  commercialBody?: string | null;
  forceCommercial?: boolean;
}): { blocked: boolean; reason?: string } {
  const channel = String(input.channel || '').trim().toLowerCase();
  const commercial = recordHasCommercialContent(input.record, {
    channel,
    bodyText: input.commercialBody,
    forceCommercial: input.forceCommercial,
  });

  if (channel === 'call') {
    return { blocked: false };
  }

  // RES-CONTENT: hash the channel's final outbound copy only — never use
  // preliminary_snapshot as a stand-in for the draft/mail/LI body (that caused
  // false hash mismatches and false missing-hash blocks).
  const bodyForHash = (() => {
    if (nonBlank(input.commercialBody)) return nonBlank(input.commercialBody);
    if (channel === 'email') {
      return nonBlank(input.record?.email_last_body)
        || nonBlank(input.record?.email_body)
        || '';
    }
    if (channel === 'mail') {
      return nonBlank(input.record?.mail_copy)
        || nonBlank(input.record?.mail_body)
        || nonBlank(input.record?.postcard_copy)
        || nonBlank(input.record?.golden_ticket_copy)
        || nonBlank(input.record?.golden_ticket_body)
        || '';
    }
    if (channel === 'linkedin') {
      return nonBlank(input.record?.linkedin_invite_message)
        || nonBlank(input.record?.linkedin_message)
        || nonBlank(input.record?.linkedin_message_body)
        || '';
    }
    return '';
  })();
  if (channel === 'linkedin' || channel === 'mail' || channel === 'email') {
    // Enforce draft-asset hash when a concrete channel body is about to leave.
    // Bare LinkedIn connect (no commercial body) skips this gate.
    if (nonBlank(bodyForHash)) {
      const hashBlock = claimAuditAssetHashMismatch({
        record: input.record,
        bodyText: bodyForHash,
        requireHashWhenPassed: true,
      });
      if (hashBlock.blocked) {
        return { blocked: true, reason: hashBlock.reason };
      }
    } else if (channel === 'email' && isClaimAuditPassed(input.record) && commercial) {
      // Email commercial path without a resolvable draft body cannot pass on flag alone.
      return {
        blocked: true,
        reason: 'claim_audit_asset_hash_missing: email commercial send requires bound draft asset hash',
      };
    }
  }

  if (channel === 'linkedin') {
    // Bare connect without commercial body: always OK on claim-audit grounds.
    if (!commercial && !nonBlank(input.commercialBody)) {
      return { blocked: false };
    }
    if (isClaimAuditFailed(input.record) || !isClaimAuditPassed(input.record)) {
      return {
        blocked: true,
        reason:
          'claim_audit_failed: linkedin commercial message blocked (invite/message body requires claim audit pass)',
      };
    }
    return { blocked: false };
  }

  if (channel === 'mail') {
    if (!commercial) return { blocked: false };
    if (isClaimAuditFailed(input.record) || !isClaimAuditPassed(input.record)) {
      return {
        blocked: true,
        reason:
          'claim_audit_failed: mail copy blocked (golden ticket / postcard commercial content requires claim audit pass)',
      };
    }
    return { blocked: false };
  }

  // email (default for send_email path)
  if (!isClaimAuditFailed(input.record)) return { blocked: false };

  const enforce = input.config?.policy?.enforce_readiness === true;
  const review = isReviewRequired(input.config, input.stepKind || 'send_email', input.taskType)
    || isReviewRequired(input.config, 'send_email', input.taskType);
  const hasContent = Boolean(
    input.record.permitted_claim_packet_json
    || input.record.preliminary_snapshot
    || commercial,
  );

  if (enforce || review || hasContent) {
    return {
      blocked: true,
      reason: 'claim_audit_failed: email send blocked (draft ready does not override claim audit)',
    };
  }
  return { blocked: false };
}

/** @deprecated Prefer claimAuditBlocksExternalSend — kept as email-shaped alias. */
export function claimAuditBlocksEmailSend(input: {
  config?: any;
  record: Record<string, unknown>;
  stepKind?: string;
  taskType?: string;
  /** Explicit email body being sent (draft body) for asset-hash match. */
  commercialBody?: string | null;
}): { blocked: boolean; reason?: string } {
  return claimAuditBlocksExternalSend({
    ...input,
    channel: 'email',
    commercialBody: input.commercialBody,
  });
}
