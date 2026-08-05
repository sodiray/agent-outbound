/**
 * Deterministic permitted claim packet assembler + proof matching.
 * Model may propose hypotheses/scenarios; code authorizes claims from registry + proof library.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClaimPacket, PermittedClaim, ClaimClass } from './claim-audit.js';
import { calculateEconomicScenario } from './claim-audit.js';

export const CLAIM_PACKET_VERSION = 'tv-claim-packet-v1';

export type ProofRecord = {
  proof_id: string;
  category: string;
  approved_wording: string[];
  prohibited_wording?: string[];
  attribution?: string;
  provenance?: string;
  usage_restrictions?: string[];
};

export type DiagnosticFamily = {
  family_id: string;
  proof_categories?: string[];
  hypotheses?: Array<{ id: string; text: string; falsifiers?: string[] }>;
  calculator_ids?: string[];
  /** Optional vertical tags for explicit mapping (never used as implicit trades fallback). */
  verticals?: string[];
};

function loadJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Normalize registry family row (object map or array entry) into DiagnosticFamily. */
function normalizeFamily(id: string, fam: any): DiagnosticFamily {
  const hypsRaw = Array.isArray(fam?.hypotheses) ? fam.hypotheses : [];
  const hypotheses = hypsRaw.map((h: any) => ({
    id: String(h?.id || ''),
    // TV registry uses `mechanism`; accept `text` for alternate shapes.
    text: String(h?.text || h?.mechanism || ''),
    falsifiers: Array.isArray(h?.falsifiers) ? h.falsifiers.map(String) : [],
  })).filter((h: { id: string; text: string }) => h.id && h.text);

  const calculator_ids = Array.isArray(fam?.calculator_ids)
    ? fam.calculator_ids.map(String)
    : Array.isArray(fam?.economic_calculators)
      ? fam.economic_calculators.map(String)
      : [];

  const proof_categories = Array.isArray(fam?.proof_categories)
    ? fam.proof_categories.map(String)
    : [];

  const verticalsRaw = fam?.verticals ?? fam?.vertical;
  const verticals = Array.isArray(verticalsRaw)
    ? verticalsRaw.map(String).filter(Boolean)
    : verticalsRaw
      ? [String(verticalsRaw)]
      : [];

  return {
    family_id: String(fam?.family_id || fam?.id || id || ''),
    proof_categories,
    hypotheses,
    calculator_ids,
    verticals,
  };
}

/**
 * Resolve a diagnostic family strictly by family_id or explicit vertical tag.
 * NEVER falls back to families[0] (trades) — unsupported → null (fail-safe).
 */
export function resolveDiagnosticFamily(input: {
  family_id?: string;
  vertical?: string;
  listDir?: string;
  families?: DiagnosticFamily[];
}): { family: DiagnosticFamily | null; resolved: boolean; reason?: string } {
  const families = input.families || loadDiagnosticFamilies(input.listDir);
  const familyId = String(input.family_id || '').trim();
  const vertical = String(input.vertical || '').trim();

  if (familyId) {
    const byId = families.find(
      (f) => f.family_id === familyId || String((f as any).id || '') === familyId,
    );
    if (byId) return { family: byId, resolved: true };
  }

  if (vertical) {
    const v = vertical.toLowerCase();
    // Exact family_id match via vertical token (diagnostic_family often omitted).
    const byFamilyAsVertical = families.find(
      (f) => f.family_id.toLowerCase() === v || String((f as any).id || '').toLowerCase() === v,
    );
    if (byFamilyAsVertical) return { family: byFamilyAsVertical, resolved: true };

    const byVertical = families.find((f) =>
      (f.verticals || []).some((tag) => {
        const t = String(tag || '').toLowerCase();
        return t === v || t.includes(v) || v.includes(t);
      }),
    );
    if (byVertical) return { family: byVertical, resolved: true };
  }

  return {
    family: null,
    resolved: false,
    reason: familyId || vertical
      ? 'unsupported_vertical_or_family'
      : 'missing_family_and_vertical',
  };
}

/** Empty fail-safe packet: zero commercial claims; content must not send on this alone. */
export function emptyClaimPacket(input: {
  account_id: string;
  reason?: string;
}): ClaimPacket & { family_id: string; resolved_family: false; withhold_reason: string } {
  return {
    account_id: String(input.account_id || 'unknown'),
    family_id: 'unknown',
    resolved_family: false,
    withhold_reason: input.reason || 'unsupported_vertical_or_family',
    permitted_claims: [],
    prohibited_patterns: [
      'guaranteed results',
      'your business is losing \\$',
      'door-to-door',
      "I'll stop by",
    ],
    policy_version: CLAIM_PACKET_VERSION,
  };
}

export function resolveRegistryPaths(listDir?: string): {
  families: string | null;
  proofs: string | null;
} {
  const roots = [
    listDir,
    listDir ? resolve(listDir, 'build') : '',
    '/Users/rayepps/projects/mission/.outbound/treasure-valley',
    '/Users/rayepps/projects/mission/.outbound/treasure-valley/build',
  ].filter(Boolean) as string[];
  let families: string | null = null;
  let proofs: string | null = null;
  for (const root of roots) {
    const f = resolve(root, 'registries/diagnostic-families.json');
    const f2 = resolve(root, 'build/registries/diagnostic-families.json');
    const p = resolve(root, 'assets/proof-library.json');
    const p2 = resolve(root, 'build/assets/proof-library.json');
    if (!families && existsSync(f)) families = f;
    if (!families && existsSync(f2)) families = f2;
    if (!proofs && existsSync(p)) proofs = p;
    if (!proofs && existsSync(p2)) proofs = p2;
  }
  return { families, proofs };
}

export function loadDiagnosticFamilies(listDir?: string): DiagnosticFamily[] {
  const { families } = resolveRegistryPaths(listDir);
  if (!families) return [];
  const raw = loadJson<any>(families);
  if (!raw) return [];

  // Shape A: { families: { trades_field_services: {...}, ... } }  (TV registry)
  if (raw.families && typeof raw.families === 'object' && !Array.isArray(raw.families)) {
    return Object.entries(raw.families).map(([id, fam]) => normalizeFamily(id, fam));
  }
  // Shape B: { families: [ { family_id, ... }, ... ] }
  if (Array.isArray(raw.families)) {
    return raw.families.map((fam: any, i: number) =>
      normalizeFamily(String(fam?.family_id || fam?.id || `family_${i}`), fam),
    );
  }
  // Shape C: bare array
  if (Array.isArray(raw)) {
    return raw.map((fam: any, i: number) =>
      normalizeFamily(String(fam?.family_id || fam?.id || `family_${i}`), fam),
    );
  }
  return [];
}

export function loadProofLibrary(listDir?: string): ProofRecord[] {
  const { proofs } = resolveRegistryPaths(listDir);
  if (!proofs) return [];
  const raw = loadJson<any>(proofs);
  if (!raw) return [];
  const list = Array.isArray(raw.proofs) ? raw.proofs : Array.isArray(raw) ? raw : [];
  return list.map((p: any) => {
    const wording = Array.isArray(p.approved_wording)
      ? p.approved_wording
      : p.metrics?.approved_wording
        ? [String(p.metrics.approved_wording)]
        : [];
    const prohibited = Array.isArray(p.prohibited_wording)
      ? p.prohibited_wording
      : Array.isArray(p.metrics?.prohibited_wording)
        ? p.metrics.prohibited_wording
        : [];
    return {
      proof_id: String(p.proof_id || ''),
      category: String(p.category || ''),
      approved_wording: wording,
      prohibited_wording: prohibited,
      attribution: p.attribution,
      provenance: p.provenance,
      usage_restrictions: p.usage_restrictions,
    } as ProofRecord;
  });
}

/** Match proofs by family categories; rank by category hit. */
export function matchProofs(input: {
  family_id?: string;
  categories?: string[];
  listDir?: string;
}): ProofRecord[] {
  const families = loadDiagnosticFamilies(input.listDir);
  const proofs = loadProofLibrary(input.listDir);
  let cats = input.categories || [];
  if (input.family_id) {
    const fam = families.find((f) => f.family_id === input.family_id || (f as any).id === input.family_id);
    if (fam?.proof_categories?.length) cats = [...new Set([...cats, ...fam.proof_categories])];
  }
  // Fail closed: without explicit categories, never invent proofs from the library head.
  // Unknown / empty category sets return [] — callers must not fall back to proofs[0].
  if (!cats.length) return [];
  const ranked = proofs
    .map((p) => ({
      proof: p,
      score: cats.includes(p.category) ? 2 : cats.some((c) => p.category?.includes(c) || c.includes(p.category)) ? 1 : 0,
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.proof);
  // If family categories have no library rows, still return empty rather than inventing proof.
  return ranked;
}

export function assemblePermittedClaimPacket(input: {
  account_id: string;
  family_id?: string;
  vertical?: string;
  hypotheses?: Array<{ id: string; text: string }>;
  economic_inputs?: Record<string, number>;
  scenario_ids?: string[];
  listDir?: string;
  preliminary_snapshot?: string;
}): ClaimPacket {
  const accountId = String(input.account_id || 'unknown');
  const families = loadDiagnosticFamilies(input.listDir);
  const resolved = resolveDiagnosticFamily({
    family_id: input.family_id,
    vertical: input.vertical,
    families,
  });

  // Fail-safe: unsupported vertical/family MUST NOT inherit trades (families[0]).
  // Empty permitted_claims → claim audit fails any commercial authored content.
  if (!resolved.resolved || !resolved.family) {
    return emptyClaimPacket({
      account_id: accountId,
      reason: resolved.reason || 'unsupported_vertical_or_family',
    });
  }

  const fam = resolved.family;
  const claims: PermittedClaim[] = [];

  // Hypotheses from registry or input (observation/hypothesis class only).
  const hyps =
    input.hypotheses?.length
      ? input.hypotheses
      : (fam.hypotheses || []).slice(0, 4).map((h) => ({ id: h.id, text: h.text }));
  for (const h of hyps) {
    claims.push({
      claim_id: `hyp_${h.id}`,
      claim_class: 'hypothesis' as ClaimClass,
      text: h.text,
      hypothesis_id: h.id,
      evidence_ids: [`family:${fam.family_id}`],
    });
  }

  // Deterministic economics — never free-form model dollars.
  // Only use family calculators or explicit scenario_ids (no default trades calcs on miss).
  const scenarioIds = input.scenario_ids?.length
    ? input.scenario_ids
    : (fam.calculator_ids || []);
  const ei = input.economic_inputs || {};
  for (const sid of scenarioIds) {
    const calc = calculateEconomicScenario({
      scenario_id: sid,
      weekly_admin_hours: ei.weekly_admin_hours ?? ei.admin_hours_per_week,
      hourly_loaded_cost: ei.hourly_loaded_cost ?? ei.hourly_rate,
      missed_leads_per_month: ei.missed_leads_per_month,
      avg_job_value: ei.avg_job_value,
      close_rate: ei.close_rate,
    });
    if (calc.evidence_status === 'insufficient') {
      claims.push({
        claim_id: `econ_${sid}_qual`,
        claim_class: 'economic_scenario',
        text: `Operational load scenarios for ${sid.replace(/_/g, ' ')} require more public inputs before quantified ranges.`,
        scenario_id: sid,
        evidence_ids: [`scenario:${sid}:insufficient`],
      });
      continue;
    }
    const low = calc.annual_low_usd;
    const high = calc.annual_high_usd;
    claims.push({
      claim_id: `econ_${sid}`,
      claim_class: 'economic_scenario',
      text: `Public-signal scenario ${sid.replace(/_/g, ' ')} suggests an illustrative annual range (not a measured loss for this business).`,
      scenario_id: sid,
      evidence_ids: [`scenario:${sid}`, `range:${low}-${high}`],
    });
  }

  // Proof claims with proof_id required — only from resolved family categories.
  const proofs = matchProofs({
    family_id: fam.family_id,
    listDir: input.listDir,
  });
  for (const p of proofs.slice(0, 3)) {
    const wording = (p.approved_wording && p.approved_wording[0]) || `Mission has delivered related operational work (${p.proof_id}).`;
    claims.push({
      claim_id: `proof_${p.proof_id}`,
      claim_class: 'mission_proof',
      text: wording,
      proof_id: p.proof_id,
      evidence_ids: [`proof:${p.proof_id}`],
    });
  }

  if (input.preliminary_snapshot) {
    claims.push({
      claim_id: 'snap_preliminary',
      claim_class: 'observation',
      text: String(input.preliminary_snapshot).slice(0, 500),
      evidence_ids: ['preliminary_snapshot'],
    });
  }

  // Mapping-first CTA as authorized observation-class language (resolved family only).
  claims.push({
    claim_id: 'cta_mapping_first',
    claim_class: 'observation',
    text: 'We can share a free preliminary operational read and map whether a diagnostic conversation is useful.',
    evidence_ids: ['offer:diagnostic_partnership'],
  });

  return {
    account_id: accountId,
    permitted_claims: claims,
    prohibited_patterns: [
      'guaranteed results',
      'your business is losing \\$',
      'door-to-door',
      "I'll stop by",
    ],
    policy_version: CLAIM_PACKET_VERSION,
  };
}
