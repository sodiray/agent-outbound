/**
 * Post-generation claim audit: bound authored content to permitted claim packets.
 *
 * Rules (fail-closed):
 * - Pure greeting / CTA / signature only may be soft-skipped.
 * - Factual subjects and operational statements require packet authorization.
 * - Empty permitted packet cannot authorize any factual content.
 * - One-way match: extracted ⊆ permitted (weaker restatement), with negation guard.
 * - Evidence IDs validated only for claims actually used in the draft.
 * - Production evidence envelopes ({ observations: [...] }) and namespaced
 *   family:/scenario:/proof:/offer: refs are resolvable.
 */

export type ClaimClass = 'observation' | 'hypothesis' | 'economic_scenario' | 'mission_proof' | 'prohibited';

export type PermittedClaim = {
  claim_id: string;
  claim_class: ClaimClass;
  text: string;
  evidence_ids?: string[];
  proof_id?: string | null;
  hypothesis_id?: string | null;
  scenario_id?: string | null;
};

export type ClaimPacket = {
  account_id: string;
  permitted_claims: PermittedClaim[];
  prohibited_patterns?: string[];
  policy_version: string;
};

export const CLAIM_AUDIT_VERSION = 'tv-claim-audit-v4';

export type ExtractedClaim = {
  text: string;
  claim_class_guess?: ClaimClass;
};

export type ClaimAuditResult = {
  passed: boolean;
  authorized: Array<{ text: string; claim_id: string; evidence_ids?: string[] }>;
  unauthorized: Array<{ text: string; reason: string }>;
  policy_version: string;
};

const DEFAULT_PROHIBITED = [
  /guaranteed?\s+results?/i,
  /we\s+increased\s+your\s+/i,
  /your\s+business\s+is\s+losing\s+\$[\d,]+/i,
  /hipaa\s+compliant\s+out\s+of\s+the\s+box/i,
  /as\s+your\s+(current\s+)?customer/i,
  /door[\s-]?to[\s-]?door/i,
  /i'?ll\s+stop\s+by\s+(your\s+)?(office|shop)/i,
];

export const CLAIM_MATCH_MIN_SUBSET_LEN = 12;

function norm(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Hedges / modalities / attribution / numeric qualifiers that must not be
 * dropped when matching. Stripping these upgrades a weaker permitted claim into
 * a stronger unauthorized assertion (e.g. "approximately 12" → "12",
 * "according to an unverified directory" → bare ownership).
 */
const HEDGE_TOKEN_RE = /\b(may|might|could|possibly|perhaps|allegedly|reportedly|hypothetically|illustrative|hypothetical|only|merely|scenario|not|no|never|without|neither|don't|dont|isn't|isnt|aren't|arent|it may be|it might be|it could be|may be the case|might be the case|according to|unverified|if|unless|approximately|approx|about|around|roughly|up to|at least|at most|estimated|estimate|provisional|subject to|assuming|older|outdated|stale|as of|circa|~)\b/gi;

/** Extra multi-word qualifier phrases that must survive extract ⊆ permitted. */
const HEDGE_PHRASE_RES: RegExp[] = [
  /\baccording to\b/i,
  /\bunverified\b/i,
  /\bif the directory is current\b/i,
  /\bif .{0,40} is current\b/i,
  /\bin this (illustrative|hypothetical) scenario\b/i,
  /\bonly in this\b/i,
  /\bas of\s+\d{4}\b/i,
  /\bfrom an? (older|unverified|outdated)\b/i,
];

/**
 * True when the extracted claim is authorized by a permitted claim.
 *
 * Authorization rules (semantic-preserving, fail-closed):
 * 1. Exact normalized equality.
 * 2. Draft elaborates around the *full* permitted phrase (extracted includes permitted).
 * 3. Extract is a near-restatement of permitted (permitted includes extract) ONLY when:
 *    - no negation particle immediately before the match in permitted, AND
 *    - every hedge/qualifier present in permitted also appears in extract
 *      (prevents "may own" → "owns", "loses money only in scenario" → "loses money"), AND
 *    - quantities in extract appear in permitted.
 */
export function claimTextAuthorizedByPermitted(
  extractedText: string,
  permittedText: string,
  minSubsetLen: number = CLAIM_MATCH_MIN_SUBSET_LEN,
): boolean {
  const n = norm(extractedText);
  const pn = norm(permittedText);
  if (!n || !pn) return false;
  if (n === pn) return true;

  // Draft may elaborate around a fully approved claim text — but a short permitted
  // fragment must not authorize a longer, stronger commercial claim that merely
  // contains it ("delayed callbacks" ↛ "hemorrhaging revenue … delayed callbacks").
  if (pn.length >= minSubsetLen && n.includes(pn)) {
    if (n.length > pn.length + 24) {
      const remainder = n.replace(pn, ' ').replace(/\s+/g, ' ').trim();
      if (remainder && !isSoftOrBoilerplateFragment(remainder)) {
        // Remainder is substantive: only OK if it does not introduce stronger commercial language.
        if (hasCommercialClaimLanguage(remainder) || hasCommercialClaimLanguage(n) && !hasCommercialClaimLanguage(pn)) {
          return false;
        }
      }
    }
    return true;
  }

  // Extract as substring of permitted — only with semantic preservation.
  if (n.length >= minSubsetLen && pn.includes(n)) {
    const idx = pn.indexOf(n);
    const beforeWindow = pn.slice(Math.max(0, idx - 28), idx);
    if (/\b(not|no|never|without|isn't|isnt|aren't|arent|neither|don't|dont|do not)\b/i.test(beforeWindow)) {
      return false;
    }
    // All hedges/qualifiers in permitted must survive in the extract.
    const permittedHedges = [...pn.matchAll(HEDGE_TOKEN_RE)].map((m) => norm(m[0]));
    for (const h of permittedHedges) {
      if (h && !n.includes(h)) return false;
    }
    for (const re of HEDGE_PHRASE_RES) {
      if (re.test(pn) && !re.test(n)) return false;
    }
    // Modality wrappers on the whole permitted claim cannot be stripped.
    if (
      /\b(it may be|it might be|it could be|may be the case|might be the case)\b/i.test(pn)
      && !/\b(may|might|could|possibly|perhaps|case)\b/i.test(n)
    ) {
      return false;
    }
    // "only in this … scenario" / "illustrative" restrictions cannot be dropped.
    if (/\b(only|illustrative|hypothetical)\b/i.test(pn) && !/\b(only|illustrative|hypothetical|scenario)\b/i.test(n)) {
      return false;
    }
    // Attribution / directory hedges cannot be stripped into bare fact.
    if (/\b(according to|unverified|directory)\b/i.test(pn) && !/\b(according to|unverified|directory)\b/i.test(n)) {
      return false;
    }
    // Numeric qualifiers (approximately / up to / ~) cannot be stripped.
    if (/\b(approximately|approx|about|around|roughly|up to|at least|at most|~)\b/i.test(pn)
      && !/\b(approximately|approx|about|around|roughly|up to|at least|at most|~)\b/i.test(n)) {
      return false;
    }
    const extractNums = n.match(/\$?[\d,]+(?:\.\d+)?%?/g) || [];
    for (const num of extractNums) {
      if (!pn.includes(num)) return false;
    }
    return true;
  }
  return false;
}

/**
 * Pure soft fragments only — greetings, bare CTAs, signatures, delimiters.
 * MUST NOT match factual subjects ("A quick operational snapshot…") or
 * operational/business statements. Those require packet authorization.
 */
const PURE_SOFT_PATTERNS: RegExp[] = [
  /^(hi|hello|hey|dear|good\s+(morning|afternoon|evening))(\s+[\w.'-]+)?[,!]?\s*$/i,
  /^(thanks|thank you|best|regards|sincerely|cheers|best regards)[,.]?\s*$/i,
  /^(looking forward to (hearing|your reply))[.!]?\s*$/i,
  /^(let me know( if .+)?|reply to this|click here)[.!]?\s*$/i,
  /^(from|to|re|fwd)\s*:/i,
  /^(--|\u2014)\s*$/,
  /^[\w.+-]+@[\w.-]+\.\w+\s*$/,
  /^\+?\d[\d\s\-().]{6,}$/,
  /^(worth a\s+(quick\s+)?(call|chat|conversation)\??)\s*$/i,
  /^(ray|mission|thanks,?\s*ray)\s*$/i,
  /^(book a (call|time)|hope this helps)\.?$/i,
];

/**
 * True only for pure soft/boilerplate (greeting/CTA/signature).
 * Factual content returns false even if it starts with soft language.
 */
/**
 * Business / operational vocabulary — short fragments containing these are
 * factual claims, never soft-skippable (empty packets used to authorize them).
 */
const FACTUAL_SHORT_CLAIM_RE = /\b(customer|customers|staff|employee|employees|owner|owns|owned|owner of|hipaa|compliant|compliance|medicaid|medicare|growth|revenue|profit|loss|lose|loses|losing|lost|money|leads?|ignored|overwhelmed|accepts?|accepted|guarantee|guaranteed|cost|costs|burden|friction|snapshot|preliminary|admin|hours?|%|percent|scale|team|clinic|practice|office|shop|hvac|plumb|dental|medical|trades?)\b/i;

export function isSoftOrBoilerplateFragment(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return true;
  // Factual / operational short phrases must never soft-skip (empty-packet bypass).
  // e.g. "Customers ignored", "HIPAA compliant", "10% growth", "12 employees".
  if (FACTUAL_SHORT_CLAIM_RE.test(t) || /\d/.test(t) || /%/.test(t)) {
    return PURE_SOFT_PATTERNS.some((re) => re.test(t));
  }
  // Pure personal-name fragments only (letters/apostrophe/hyphen, ≤2 tokens).
  // Must not contain punctuation that looks like a claim clause.
  if (
    t.split(/\s+/).length <= 2
    && t.length < 28
    && !/[.!?:;,]/.test(t)
    && /^[\p{L}' -]+$/u.test(t)
    && !hasCommercialClaimLanguage(t)
  ) {
    return true;
  }
  // Entire fragment must match a pure soft pattern — not "contains soft words".
  return PURE_SOFT_PATTERNS.some((re) => re.test(t));
}

/** @deprecated alias — kept for test imports */
export function hasCommercialClaimLanguage(text: string): boolean {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  return [
    /\b(guarantee[sd]?|guaranteed)\b/i,
    /\b(measured\s+loss|losing\s+\$|\$[\d,]+|roi|revenue\s+increase)\b/i,
    /\b(we\s+increased|your\s+business\s+is\s+losing)\b/i,
    /\b(hipaa\s+compliant|out of the box)\b/i,
    /\b(save[sd]?\s+you|cut\s+your\s+costs?|reduce[sd]?\s+your)\b/i,
    /\b(\d{1,3}\s*%\s*(increase|decrease|growth|reduction|more|less))\b/i,
    /\b(annual|monthly)\s+(loss|savings|cost|leak)\b/i,
    /\b(missed\s+leads?\s+per|admin\s+hours?\s+per)\b/i,
    /\b(proof|case study|our customers? (saw|gained|saved))\b/i,
    /\b(operational\s+(friction|snapshot|burden)|public-evidence|preliminary\s+read)\b/i,
    /\b(missed inquiry|quote chase|scheduling coordination)\b/i,
    /\b(hemorrhag|losing|lost|owns?|owner of|revenue|profit|cost|burden)\b/i,
  ].some((re) => re.test(raw));
}

/**
 * Extract claim candidates — every non-pure-soft clause is a claim requiring auth.
 */
export function extractCommercialClaimFragments(assetText: string): ExtractedClaim[] {
  const raw = String(assetText || '');
  if (!raw.trim()) return [];
  // Paragraph-aware: blank lines and subject/body boundaries stay separate.
  // Soft-wrap only joins a line that does not end a sentence with the next line.
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const paragraphs: string[] = [];
  let buf = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (buf) {
        paragraphs.push(buf);
        buf = '';
      }
      continue;
    }
    // Soft greeting/sign-off lines never soft-wrap into prior content (subject/body).
    if (isSoftOrBoilerplateFragment(trimmed)) {
      if (buf) {
        paragraphs.push(buf);
        buf = '';
      }
      paragraphs.push(trimmed);
      continue;
    }
    if (!buf) {
      buf = trimmed;
    } else if (/[.!?]$/.test(buf)) {
      // Prior line was a full sentence — start a new paragraph unit.
      paragraphs.push(buf);
      buf = trimmed;
    } else {
      // Soft-wrap only mid-sentence continuations (lowercase start, no new claim).
      if (/^[a-z]/.test(trimmed)) {
        buf = `${buf} ${trimmed}`;
      } else {
        paragraphs.push(buf);
        buf = trimmed;
      }
    }
  }
  if (buf) paragraphs.push(buf);

  const parts: string[] = [];
  for (const para of paragraphs) {
    for (const clause of para.split(/[.!?]+/)) {
      const t = clause.trim().replace(/\s+/g, ' ');
      if (t.length >= 8) parts.push(t);
    }
  }
  const out: ExtractedClaim[] = [];
  for (const text of parts) {
    if (isSoftOrBoilerplateFragment(text)) continue;
    out.push({ text });
  }
  return out;
}

/**
 * Collect durable evidence IDs from a production record envelope.
 * Recognizes:
 * - observations_json as array OR { observations: [...] }
 * - retrieval/source snapshots
 * - namespaced refs family:*, scenario:*, proof:*, offer:*, obs:*, src:*
 * - field-level place / identity evidence columns
 */
export function collectKnownEvidenceIds(record: Record<string, unknown>): Set<string> {
  const known = new Set<string>();
  const accountId = String(record._row_id || record.id || record.account_id || '').trim();
  const push = (v: unknown) => {
    const s = String(v || '').trim();
    if (s) known.add(s);
  };

  const asArray = (raw: unknown): unknown[] => {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>;
      if (Array.isArray(o.observations)) return o.observations;
      if (Array.isArray(o.items)) return o.items;
      if (Array.isArray(o.entries)) return o.entries;
      if (Array.isArray(o.evidence)) return o.evidence;
      if (Array.isArray(o.snapshots)) return o.snapshots;
    }
    if (typeof raw === 'string' && raw.trim()) {
      try {
        return asArray(JSON.parse(raw));
      } catch {
        return [];
      }
    }
    return [];
  };

  for (const o of asArray(record.observations_json)) {
    const row = o as Record<string, unknown>;
    if (!isAdmissibleEvidenceRow(row, { accountId })) continue;
    push(row?.observation_id);
    push(row?.source_id);
    push(row?.id);
    push(row?.evidence_id);
    for (const k of ['family_id', 'scenario_id', 'proof_id', 'offer_id', 'hypothesis_id']) {
      const v = row?.[k];
      if (v) {
        push(v);
        const prefix = String(k).replace(/_id$/, '');
        push(`${prefix}:${v}`);
      }
    }
  }

  for (const key of [
    'retrieval_snapshots_json',
    'source_snapshots_json',
    'evidence_resolution_json',
    'claim_evidence_json',
  ]) {
    for (const s of asArray(record[key])) {
      const row = s as Record<string, unknown>;
      if (!isAdmissibleEvidenceRow(row, { accountId })) continue;
      push(row?.source_id);
      push(row?.snapshot_id);
      push(row?.id);
      push(row?.evidence_id);
      push(row?.observation_id);
    }
  }

  if (record.last_retrieval_snapshot_json) {
    try {
      const s = typeof record.last_retrieval_snapshot_json === 'string'
        ? JSON.parse(String(record.last_retrieval_snapshot_json))
        : record.last_retrieval_snapshot_json;
      if (isAdmissibleEvidenceRow(s as any, { accountId })) {
        push((s as any)?.source_id);
        push((s as any)?.snapshot_id);
      }
    } catch { /* */ }
  }

  // Record-level identity / catalog pins (independent of claim packets — do NOT
  // accept proof_id/scenario_id declared only on the claim itself; that self-authorized).
  for (const key of [
    'family_id', 'place_id', 'google_place_id', 'places_source_id', 'source_id',
    'identity_evidence_id', 'classification_evidence_id',
  ]) {
    const v = record[key];
    if (v != null && String(v).trim()) {
      push(v);
      if (key === 'family_id') push(`family:${v}`);
    }
  }

  // Independent registry / seed catalogs on the record (not claim self-declaration).
  for (const key of [
    'family_registry_json', 'scenario_registry_json', 'proof_library_json',
    'offer_registry_json', 'catalog_evidence_json',
  ]) {
    for (const entry of asArray(record[key])) {
      const row = entry as Record<string, unknown>;
      // Skip inadmissible registry rows (stale / tool_failure / contradicted).
      const status = String(row?.status || row?.evidence_status || row?.quality || '').toLowerCase();
      if (status && /stale|tool_failure|failed|contradict|provisional|invalid|missing/.test(status)) {
        continue;
      }
      push(row?.id);
      push(row?.family_id);
      push(row?.scenario_id);
      push(row?.proof_id);
      push(row?.offer_id);
      if (row?.id && row?.kind) push(`${row.kind}:${row.id}`);
      if (row?.scenario_id) push(`scenario:${row.scenario_id}`);
      if (row?.proof_id) push(`proof:${row.proof_id}`);
      if (row?.offer_id) push(`offer:${row.offer_id}`);
      if (row?.family_id) push(`family:${row.family_id}`);
    }
  }

  return known;
}

/**
 * Whether an observation/source row is admissible evidence for claim binding.
 *
 * Production observations use `support_status` (not only `support_type`).
 * Stale, conflicted, provisional, tool_failure, missing, and cross-account rows
 * are never admissible.
 */
export function isAdmissibleEvidenceRow(
  row: Record<string, unknown> | null | undefined,
  opts?: { accountId?: string | null },
): boolean {
  if (!row || typeof row !== 'object') return false;
  // Canonical production field is support_status; also accept legacy aliases.
  const status = String(
    row.support_status
    || row.status
    || row.evidence_status
    || row.quality
    || row.support_type
    || row.freshness
    || '',
  ).toLowerCase();
  if (
    /tool_failure|failed|error|stale|expired|contradict|conflict|invalid|missing|provisional|unknown|rejected|superseded/.test(
      status,
    )
  ) {
    return false;
  }
  if (row.contradicted === true || row.is_contradicted === true || row.stale === true) return false;
  if (row.open_contradiction === true || row.has_open_contradiction === true) return false;
  if (row.tool_failure === true || String(row.kind || '').toLowerCase() === 'tool_failure') return false;
  if (String(row.support_type || '').toLowerCase() === 'tool_failure') return false;
  if (String(row.provisional || '').toLowerCase() === 'true' || row.provisional === true) return false;
  // Account ownership: cross-account observations cannot authorize this account's claims.
  const wantAcct = String(opts?.accountId || '').trim();
  if (wantAcct) {
    const rowAcct = String(
      row.account_id || row.record_id || row.row_id || row._row_id || '',
    ).trim();
    if (rowAcct && rowAcct !== wantAcct) return false;
  }
  // Explicit source existence: empty observation_id/source_id with failed markers already handled;
  // require at least one identity field for non-registry rows that declare support_status.
  if (
    row.support_status != null
    && !String(row.observation_id || row.source_id || row.id || row.evidence_id || '').trim()
  ) {
    return false;
  }
  return true;
}

/**
 * Collect admissible evidence IDs only (filters out tool_failure / stale / contradicted).
 */
export function collectAdmissibleEvidenceIds(record: Record<string, unknown>): Set<string> {
  const known = new Set<string>();
  const accountId = String(record._row_id || record.id || record.account_id || '').trim();
  const push = (v: unknown) => {
    const s = String(v || '').trim();
    if (s) known.add(s);
  };
  const asArray = (raw: unknown): unknown[] => {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>;
      if (Array.isArray(o.observations)) return o.observations;
      if (Array.isArray(o.items)) return o.items;
      if (Array.isArray(o.snapshots)) return o.snapshots;
      if (Array.isArray(o.evidence)) return o.evidence;
    }
    if (typeof raw === 'string' && raw.trim()) {
      try { return asArray(JSON.parse(raw)); } catch { return []; }
    }
    return [];
  };
  for (const o of asArray(record.observations_json)) {
    const row = o as Record<string, unknown>;
    if (!isAdmissibleEvidenceRow(row, { accountId })) continue;
    push(row?.observation_id);
    push(row?.source_id);
    push(row?.id);
    push(row?.evidence_id);
  }
  for (const key of ['retrieval_snapshots_json', 'source_snapshots_json', 'catalog_evidence_json',
    'proof_library_json', 'scenario_registry_json', 'family_registry_json', 'offer_registry_json']) {
    for (const s of asArray(record[key])) {
      const row = s as Record<string, unknown>;
      if (!isAdmissibleEvidenceRow(row, { accountId })) continue;
      push(row?.source_id);
      push(row?.snapshot_id);
      push(row?.id);
      push(row?.proof_id);
      push(row?.scenario_id);
      push(row?.offer_id);
      push(row?.family_id);
      if (row?.proof_id) push(`proof:${row.proof_id}`);
      if (row?.scenario_id) push(`scenario:${row.scenario_id}`);
      if (row?.offer_id) push(`offer:${row.offer_id}`);
      if (row?.family_id) push(`family:${row.family_id}`);
      if (row?.id && row?.kind) push(`${row.kind}:${row.id}`);
    }
  }
  // Record-level family pin only (not claim-declared scenario/proof).
  if (record.family_id) {
    push(record.family_id);
    push(`family:${record.family_id}`);
  }
  return known;
}

/**
 * Resolve whether an evidence id is known. Supports exact match and
 * namespaced catalog forms (family:x, scenario:x, …).
 */
export function evidenceIdResolves(id: string, known: Set<string>): boolean {
  const eid = String(id || '').trim();
  if (!eid) return false;
  if (known.has(eid)) return true;
  // Bare id matches namespaced form and vice versa.
  const m = eid.match(/^(family|scenario|proof|offer|hypothesis|obs|src|snapshot):(.+)$/i);
  if (m) {
    if (known.has(m[2])) return true;
    if (known.has(`${m[1].toLowerCase()}:${m[2]}`)) return true;
  }
  for (const prefix of ['family', 'scenario', 'proof', 'offer', 'hypothesis', 'obs', 'src', 'snapshot']) {
    if (known.has(`${prefix}:${eid}`)) return true;
  }
  return false;
}

/**
 * Audit extracted claims against the permitted packet.
 */
export function auditClaims(input: {
  packet: ClaimPacket;
  extracted: ExtractedClaim[];
  assetText?: string;
}): ClaimAuditResult {
  const prohibited = [
    ...(input.packet.prohibited_patterns || []).map((p) => new RegExp(p, 'i')),
    ...DEFAULT_PROHIBITED,
  ];
  const authorized: ClaimAuditResult['authorized'] = [];
  const unauthorized: ClaimAuditResult['unauthorized'] = [];

  const assetText = String(input.assetText || '');
  const fullText = assetText || input.extracted.map((e) => e.text).join('\n');
  for (const re of prohibited) {
    if (re.test(fullText)) {
      unauthorized.push({ text: re.source, reason: `prohibited_pattern:${re.source}` });
    }
  }

  // Prefer caller-supplied extract; if empty with non-empty asset, re-extract so
  // callers cannot pass "examined nothing" and green-pass factual copy.
  let substantive = (input.extracted || []).filter((c) => Boolean(norm(c.text)));
  const assetNonEmpty = Boolean(norm(assetText));
  if (assetNonEmpty && substantive.length === 0) {
    substantive = extractCommercialClaimFragments(assetText).filter((c) => Boolean(norm(c.text)));
  }
  const permitted = Array.isArray(input.packet.permitted_claims) ? input.packet.permitted_claims : [];

  // Empty packet cannot authorize factual content.
  if (assetNonEmpty && permitted.length === 0 && substantive.length > 0) {
    for (const claim of substantive) {
      unauthorized.push({ text: claim.text, reason: 'empty_permitted_claim_packet' });
    }
    return {
      passed: false,
      authorized,
      unauthorized,
      policy_version: CLAIM_AUDIT_VERSION,
    };
  }

  // Still empty after re-extract: only pure soft copy may pass.
  if (assetNonEmpty && substantive.length === 0) {
    const clauses = assetText
      .replace(/\r\n/g, '\n')
      .split(/\n+/)
      .flatMap((line) => line.split(/[.!?]+/))
      .map((t) => t.trim().replace(/\s+/g, ' '))
      .filter((t) => t.length >= 8);
    const onlySoft = clauses.length === 0 || clauses.every((p) => isSoftOrBoilerplateFragment(p));
    if (!onlySoft) {
      unauthorized.push({
        text: assetText.slice(0, 120),
        reason: 'no_claims_extracted',
      });
    }
  }

  for (const claim of substantive) {
    const match = permitted.find((p) => claimTextAuthorizedByPermitted(claim.text, p.text));
    if (!match) {
      unauthorized.push({ text: claim.text, reason: 'not_in_permitted_claim_packet' });
      continue;
    }
    if (match.claim_class === 'prohibited') {
      unauthorized.push({ text: claim.text, reason: 'claim_class_prohibited' });
      continue;
    }
    if (match.claim_class === 'mission_proof' && !match.proof_id) {
      unauthorized.push({ text: claim.text, reason: 'proof_claim_missing_proof_id' });
      continue;
    }
    authorized.push({
      text: claim.text,
      claim_id: match.claim_id,
      evidence_ids: Array.isArray(match.evidence_ids) ? match.evidence_ids.map(String) : [],
    });
  }

  return {
    passed: unauthorized.length === 0,
    authorized,
    unauthorized,
    policy_version: CLAIM_AUDIT_VERSION,
  };
}

/**
 * Economic scenario calculator stubs — deterministic ranges, no false precision.
 */
export type EconomicScenarioInput = {
  scenario_id: string;
  weekly_admin_hours?: number | null;
  hourly_loaded_cost?: number | null;
  missed_leads_per_month?: number | null;
  avg_job_value?: number | null;
  close_rate?: number | null;
};

export type EconomicScenarioResult = {
  scenario_id: string;
  annual_low_usd: number | null;
  annual_high_usd: number | null;
  assumptions: string[];
  missing_inputs: string[];
  evidence_status: 'calculated' | 'insufficient';
  calculation_rule_version: string;
};

export const ECONOMIC_RULE_VERSION = 'tv-economics-v1';

export function calculateEconomicScenario(input: EconomicScenarioInput): EconomicScenarioResult {
  const assumptions: string[] = [];
  const missing: string[] = [];

  if (input.scenario_id === 'admin_labor_leak') {
    const hours = input.weekly_admin_hours;
    const rate = input.hourly_loaded_cost ?? 35;
    if (hours == null) {
      missing.push('weekly_admin_hours');
      return {
        scenario_id: input.scenario_id,
        annual_low_usd: null,
        annual_high_usd: null,
        assumptions,
        missing_inputs: missing,
        evidence_status: 'insufficient',
        calculation_rule_version: ECONOMIC_RULE_VERSION,
      };
    }
    assumptions.push(`hourly_loaded_cost_default_or_input=${rate}`);
    assumptions.push('weeks_per_year=48');
    const mid = hours * rate * 48;
    return {
      scenario_id: input.scenario_id,
      annual_low_usd: Math.round(mid * 0.7),
      annual_high_usd: Math.round(mid * 1.3),
      assumptions,
      missing_inputs: missing,
      evidence_status: 'calculated',
      calculation_rule_version: ECONOMIC_RULE_VERSION,
    };
  }

  if (input.scenario_id === 'missed_lead_revenue') {
    const leads = input.missed_leads_per_month;
    const job = input.avg_job_value;
    const close = input.close_rate ?? 0.25;
    if (leads == null || job == null) {
      if (leads == null) missing.push('missed_leads_per_month');
      if (job == null) missing.push('avg_job_value');
      return {
        scenario_id: input.scenario_id,
        annual_low_usd: null,
        annual_high_usd: null,
        assumptions,
        missing_inputs: missing,
        evidence_status: 'insufficient',
        calculation_rule_version: ECONOMIC_RULE_VERSION,
      };
    }
    assumptions.push(`close_rate=${close}`);
    const mid = leads * 12 * job * close;
    return {
      scenario_id: input.scenario_id,
      annual_low_usd: Math.round(mid * 0.6),
      annual_high_usd: Math.round(mid * 1.4),
      assumptions,
      missing_inputs: missing,
      evidence_status: 'calculated',
      calculation_rule_version: ECONOMIC_RULE_VERSION,
    };
  }

  missing.push('unknown_scenario_id');
  return {
    scenario_id: input.scenario_id,
    annual_low_usd: null,
    annual_high_usd: null,
    assumptions,
    missing_inputs: missing,
    evidence_status: 'insufficient',
    calculation_rule_version: ECONOMIC_RULE_VERSION,
  };
}
