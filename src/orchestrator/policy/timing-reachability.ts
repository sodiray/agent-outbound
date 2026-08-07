/**
 * Timing-signal registry (strength, freshness, decay, expiration) and
 * named channel reachability state vectors.
 */

export const TIMING_RULE_VERSION = 'tv-timing-v1';
export const REACHABILITY_RULE_VERSION = 'tv-reachability-v1';

export type TimingSignalId =
  | 'hiring_spike'
  | 'expansion_signal'
  | 'tech_change'
  | 'review_surge'
  | 'seasonal_peak'
  | 'explicit_timing_score'
  | 'stale_no_signal';

export type TimingSignal = {
  id: TimingSignalId | string;
  strength: number; // 0–100
  observed_at: string;
  half_life_days: number;
  expires_at?: string | null;
  evidence_ids?: string[];
};

export type TimingCalculation = {
  timing_score: number; // 0–100
  signals: Array<TimingSignal & { decayed_strength: number }>;
  missing_inputs: string[];
  calculation_rule_version: string;
  expires_at: string | null;
  generated_at: string;
};

export type ReachabilityState =
  | 'unknown'
  | 'missing'
  | 'unvalidated'
  | 'named_validated'
  | 'invite_ready'
  | 'connected'
  | 'suppressed'
  | 'bounced'
  | 'opted_out';

export type ChannelReachability = {
  channel: 'email' | 'phone' | 'linkedin' | 'mail';
  state: ReachabilityState;
  confidence: number;
  ready: boolean;
  reason?: string;
};

export type ReachabilityVector = {
  channels: ChannelReachability[];
  calculation_rule_version: string;
  generated_at: string;
};

const DEFAULT_HALF_LIFE: Record<string, number> = {
  hiring_spike: 45,
  expansion_signal: 60,
  tech_change: 90,
  review_surge: 30,
  seasonal_peak: 21,
  explicit_timing_score: 30,
  stale_no_signal: 7,
};

function daysBetween(isoA: string, isoB: string): number {
  const a = Date.parse(isoA);
  const b = Date.parse(isoB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, (b - a) / (1000 * 60 * 60 * 24));
}

/** Exponential decay: strength * 0.5^(age/half_life). */
export function decayStrength(signal: TimingSignal, asOf: string = new Date().toISOString()): number {
  if (signal.expires_at && Date.parse(signal.expires_at) < Date.parse(asOf)) return 0;
  const half = signal.half_life_days > 0 ? signal.half_life_days : 30;
  const age = daysBetween(signal.observed_at, asOf);
  const decayed = signal.strength * Math.pow(0.5, age / half);
  return Math.max(0, Math.min(100, Math.round(decayed)));
}

export function parseTimingSignals(record: Record<string, unknown>): TimingSignal[] {
  const signals: TimingSignal[] = [];
  const now = new Date().toISOString();
  try {
    const raw = record.timing_signals_json;
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
    if (Array.isArray(parsed)) {
      for (const s of parsed) {
        if (!s || typeof s !== 'object') continue;
        signals.push({
          id: String(s.id || 'unknown'),
          strength: Number(s.strength) || 0,
          observed_at: String(s.observed_at || now),
          half_life_days: Number(s.half_life_days) || DEFAULT_HALF_LIFE[String(s.id)] || 30,
          expires_at: s.expires_at ?? null,
          evidence_ids: Array.isArray(s.evidence_ids) ? s.evidence_ids.map(String) : [],
        });
      }
    }
  } catch {
    /* ignore */
  }
  // Scalar timing_score as explicit signal when present.
  const scalar = Number(record.timing_score);
  if (Number.isFinite(scalar) && scalar > 0) {
    signals.push({
      id: 'explicit_timing_score',
      strength: Math.max(0, Math.min(100, scalar)),
      observed_at: String(record.timing_score_at || record.updated_at || now),
      half_life_days: DEFAULT_HALF_LIFE.explicit_timing_score,
      evidence_ids: ['record.timing_score'],
    });
  }
  if (!signals.length) {
    signals.push({
      id: 'stale_no_signal',
      strength: 20,
      observed_at: now,
      half_life_days: DEFAULT_HALF_LIFE.stale_no_signal,
      evidence_ids: [],
    });
  }
  return signals;
}

export function calculateTimingScore(
  record: Record<string, unknown>,
  asOf: string = new Date().toISOString(),
): TimingCalculation {
  const signals = parseTimingSignals(record);
  const decayed = signals.map((s) => ({ ...s, decayed_strength: decayStrength(s, asOf) }));
  const maxStrength = decayed.reduce((m, s) => Math.max(m, s.decayed_strength), 0);
  const missing: string[] = [];
  if (signals.every((s) => s.id === 'stale_no_signal')) missing.push('timing_signals');
  const expiresCandidates = decayed
    .map((s) => s.expires_at)
    .filter(Boolean)
    .map((x) => Date.parse(String(x)))
    .filter(Number.isFinite);
  const expires_at =
    expiresCandidates.length > 0
      ? new Date(Math.min(...expiresCandidates)).toISOString()
      : new Date(Date.parse(asOf) + 30 * 86400000).toISOString();

  return {
    timing_score: Math.round(maxStrength),
    signals: decayed,
    missing_inputs: missing,
    calculation_rule_version: TIMING_RULE_VERSION,
    expires_at,
    generated_at: asOf,
  };
}

/** Parse optional confidence field — missing/NaN is null (never invent a passing default). */
function readConfidence(...values: unknown[]): number | null {
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
  }
  return null;
}

function emailState(record: Record<string, unknown>): ChannelReachability {
  if (record.email_opted_out || record.opted_out_email) {
    return { channel: 'email', state: 'opted_out', confidence: 100, ready: false, reason: 'opted_out' };
  }
  if (record.email_bounced || String(record.email_status || '').toLowerCase() === 'bounced') {
    return { channel: 'email', state: 'bounced', confidence: 100, ready: false, reason: 'bounced' };
  }
  const email = String(record.contact_email || record.email_primary || '').trim();
  if (!email) return { channel: 'email', state: 'missing', confidence: 0, ready: false };
  const verificationStatus = String(record.email_verification_status || '').trim().toLowerCase();
  const verificationConfidence = readConfidence(record.email_verification_confidence);
  const verificationAccepted = verificationStatus === 'valid' || verificationStatus === 'verified';
  if (verificationStatus && !verificationAccepted) {
    return {
      channel: 'email',
      state: 'unvalidated',
      confidence: verificationConfidence ?? 0,
      ready: false,
      reason: verificationStatus === 'invalid' ? 'invalid_verification' : `verification_${verificationStatus}`,
    };
  }
  const validatedFlag = Boolean(record.email_validated)
    || verificationAccepted
    // Legacy verifier results may predate the status field. This accepts only
    // the dedicated verification confidence, never discovery confidence.
    || (!verificationStatus && (verificationConfidence ?? 0) >= 70);
  if (!validatedFlag) {
    return {
      channel: 'email',
      state: 'unvalidated',
      confidence: verificationConfidence ?? 0,
      ready: false,
      reason: verificationStatus ? `verification_${verificationStatus}` : 'verification_missing',
    };
  }
  return {
    channel: 'email',
    state: 'named_validated',
    confidence: verificationConfidence ?? 0,
    ready: true,
    reason: 'validated_address',
  };
}

function phoneState(record: Record<string, unknown>): ChannelReachability {
  // dne_phone = structural invalidation (wrong number); phone_suppressed = channel block.
  // Neither is full-account DNC.
  if (
    record.phone_suppressed
    || record.dne_phone === true
    || record.dne_phone === 1
    || record.dne_phone === '1'
    || record.dne_phone === 'true'
  ) {
    return {
      channel: 'phone',
      state: 'suppressed',
      confidence: 100,
      ready: false,
      reason: record.dne_phone ? 'dne_phone' : 'phone_suppressed',
    };
  }
  const phone = String(record.phone || record.contact_phone || '').trim();
  if (!phone) return { channel: 'phone', state: 'missing', confidence: 0, ready: false };
  const conf = readConfidence(record.phone_confidence, record.confidence_phone);
  const validatedFlag = Boolean(record.phone_validated);
  if (conf == null && !validatedFlag) {
    return {
      channel: 'phone',
      state: 'unvalidated',
      confidence: 0,
      ready: false,
      reason: 'confidence_missing',
    };
  }
  // Never invent confidence=80 when only a validation flag is present.
  const confVal = conf ?? 0;
  const validated = validatedFlag || confVal >= 70;
  return {
    channel: 'phone',
    state: validated ? 'named_validated' : 'unvalidated',
    confidence: confVal,
    ready: validated || confVal >= 60,
    reason: validated ? 'validated_phone' : 'low_confidence',
  };
}

function linkedinState(record: Record<string, unknown>): ChannelReachability {
  const url = String(record.linkedin_url || record.contact_linkedin_url || '').trim();
  if (!url) return { channel: 'linkedin', state: 'missing', confidence: 0, ready: false };
  if (record.linkedin_connected) {
    return { channel: 'linkedin', state: 'connected', confidence: 90, ready: true };
  }
  const conf = readConfidence(record.linkedin_confidence, record.confidence_linkedin);
  // Raw LinkedIn URL alone is never ready without a confidence field.
  if (conf == null) {
    return {
      channel: 'linkedin',
      state: 'unvalidated',
      confidence: 0,
      ready: false,
      reason: 'confidence_missing',
    };
  }
  if (conf >= 60) {
    return { channel: 'linkedin', state: 'invite_ready', confidence: conf, ready: true };
  }
  return { channel: 'linkedin', state: 'unvalidated', confidence: conf, ready: false };
}

function mailState(record: Record<string, unknown>): ChannelReachability {
  const address = String(record.mailing_address || record.address || '').trim();
  if (!address) return { channel: 'mail', state: 'missing', confidence: 0, ready: false };
  const conf = readConfidence(record.mail_confidence, record.address_confidence);
  const addressReadyFlag = Boolean(
    record.mail_address_ready === true
    || record.mail_address_ready === 1
    || String(record.address_rdi || '').toLowerCase() === 'commercial',
  );
  // Raw street string alone is never ready — require confidence or CASS/RDI readiness.
  // Never invent mail_confidence from address_rdi alone (fail closed on the number).
  if (conf == null && !addressReadyFlag) {
    return {
      channel: 'mail',
      state: 'unvalidated',
      confidence: 0,
      ready: false,
      reason: 'confidence_missing',
    };
  }
  const confVal = conf ?? 0;
  return {
    channel: 'mail',
    state: confVal >= 60 || addressReadyFlag ? 'named_validated' : 'unvalidated',
    confidence: confVal,
    ready: confVal >= 60 || addressReadyFlag,
    reason: addressReadyFlag ? 'address_validated' : confVal >= 60 ? 'confidence_ok' : 'low_confidence',
  };
}

export function evaluateReachability(record: Record<string, unknown>): ReachabilityVector {
  return {
    channels: [emailState(record), phoneState(record), linkedinState(record), mailState(record)],
    calculation_rule_version: REACHABILITY_RULE_VERSION,
    generated_at: new Date().toISOString(),
  };
}

/** Map reachability vector to the boolean+confidence shape readiness already consumes. */
export function reachabilityToChannelFlags(vector: ReachabilityVector): {
  email?: { ready: boolean; confidence?: number };
  phone?: { ready: boolean; confidence?: number };
  linkedin?: { ready: boolean; confidence?: number };
  mail?: { ready: boolean; confidence?: number };
} {
  const out: Record<string, { ready: boolean; confidence?: number }> = {};
  for (const ch of vector.channels) {
    out[ch.channel] = { ready: ch.ready, confidence: ch.confidence };
  }
  return out as ReturnType<typeof reachabilityToChannelFlags>;
}
