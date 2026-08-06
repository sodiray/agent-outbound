/**
 * Vertical taxonomy load + validation. Rejects unsupported labels at write time.
 *
 * Accepts both registry shapes:
 * - array: { verticals: [{ id, sub_verticals: [{ id }] }] }
 * - map (TV seed): { verticals: { trades_field_services: { sub_verticals: ["hvac"] } } }
 * Sub-verticals may be string ids or { id } objects.
 *
 * Fallback behavior (customer-vertical-taxonomy.md):
 * - Unknown top-level → other_local_smb / other_local_smb
 * - Known top-level, unknown leaf → that vertical's other_* leaf (never invent production ids)
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const TAXONOMY_VERSION_FALLBACK = 'tv-vertical-v1';

export type VerticalNode = {
  id: string;
  label?: string;
  sub_verticals?: Array<{ id: string; label?: string } | string>;
};

export type VerticalTaxonomy = {
  taxonomy_version: string;
  verticals:
    | VerticalNode[]
    | Record<string, { label?: string; sub_verticals?: Array<{ id: string; label?: string } | string> }>;
  fallbacks?: { vertical?: string; sub_vertical?: string };
  /** TV map-shaped registry uses top-level fallback_* keys */
  fallback_vertical?: string;
  fallback_sub_vertical?: string;
};

export type TaxonomyValidation = {
  ok: boolean;
  vertical: string;
  sub_vertical: string;
  taxonomy_version: string;
  fallback_applied: boolean;
  reasons: string[];
  /** Original unsupported leaf kept for registry extension (not a production id). */
  candidate_sub_vertical?: string;
};

type NormalizedVertical = {
  id: string;
  label?: string;
  sub_verticals: Array<{ id: string; label?: string }>;
};

let cached: { path: string; data: VerticalTaxonomy } | null = null;

/** Resolve taxonomy JSON path: env override, TV project default, or relative. */
export function resolveTaxonomyPath(listDir?: string): string | null {
  if (process.env.AO_VERTICAL_TAXONOMY_PATH && existsSync(process.env.AO_VERTICAL_TAXONOMY_PATH)) {
    return process.env.AO_VERTICAL_TAXONOMY_PATH;
  }
  const candidates = [
    listDir ? resolve(listDir, 'build/registries/vertical-taxonomy.json') : '',
    listDir ? resolve(listDir, 'registries/vertical-taxonomy.json') : '',
    // Common Mission TV project path when list is treasure-valley
    listDir ? resolve(listDir, '../build/registries/vertical-taxonomy.json') : '',
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadVerticalTaxonomy(listDirOrPath?: string): VerticalTaxonomy | null {
  let path = listDirOrPath && existsSync(listDirOrPath) && listDirOrPath.endsWith('.json')
    ? listDirOrPath
    : resolveTaxonomyPath(listDirOrPath);
  if (!path) {
    // Hard-coded Mission TV path as last resort for production wiring tests.
    const tv = '/Users/rayepps/projects/mission/.outbound/treasure-valley/build/registries/vertical-taxonomy.json';
    if (existsSync(tv)) path = tv;
  }
  if (!path || !existsSync(path)) return null;
  if (cached?.path === path) return cached.data;
  const data = JSON.parse(readFileSync(path, 'utf8')) as VerticalTaxonomy;
  cached = { path, data };
  return data;
}

/** Normalize map- or array-shaped verticals; string or object sub_verticals. */
export function normalizeVerticals(taxonomy: VerticalTaxonomy | null | undefined): NormalizedVertical[] {
  if (!taxonomy?.verticals) return [];
  const raw = taxonomy.verticals;
  if (Array.isArray(raw)) {
    return raw.map((v) => ({
      id: String(v.id),
      label: v.label,
      sub_verticals: (v.sub_verticals || []).map((s) =>
        typeof s === 'string' ? { id: s } : { id: String(s.id), label: s.label },
      ),
    }));
  }
  if (typeof raw === 'object') {
    return Object.entries(raw).map(([id, entry]) => ({
      id,
      label: entry?.label,
      sub_verticals: (entry?.sub_verticals || []).map((s) =>
        typeof s === 'string' ? { id: s } : { id: String(s.id), label: s.label },
      ),
    }));
  }
  return [];
}

function fallbackPair(taxonomy: VerticalTaxonomy): { vertical: string; sub_vertical: string } {
  return {
    vertical:
      taxonomy.fallbacks?.vertical ||
      taxonomy.fallback_vertical ||
      'other_local_smb',
    sub_vertical:
      taxonomy.fallbacks?.sub_vertical ||
      taxonomy.fallback_sub_vertical ||
      'other_local_smb',
  };
}

/**
 * Prefer the vertical's own other_* leaf so the final pair is always a controlled
 * (vertical, sub_vertical) under the same top-level node.
 */
function pickLeafFallback(
  subs: Array<{ id: string }>,
  globalFallbackS: string,
): string {
  const other = subs.find((s) => s.id.startsWith('other_'));
  if (other) return other.id;
  if (subs.some((s) => s.id === globalFallbackS)) return globalFallbackS;
  return subs[0]?.id || globalFallbackS;
}

function isControlledPair(
  verts: NormalizedVertical[],
  vertical: string,
  sub: string,
): boolean {
  const node = verts.find((v) => v.id === vertical);
  if (!node) return false;
  if (!sub) return false;
  return node.sub_verticals.some((s) => s.id === sub);
}

/** Validate vertical/sub_vertical against registry; apply safe fallbacks. */
export function validateTaxonomyLabels(input: {
  vertical?: string | null;
  sub_vertical?: string | null;
  taxonomy?: VerticalTaxonomy | null;
  listDir?: string;
}): TaxonomyValidation {
  const taxonomy = input.taxonomy ?? loadVerticalTaxonomy(input.listDir);
  const reasons: string[] = [];
  if (!taxonomy) {
    return {
      ok: false,
      vertical: String(input.vertical || ''),
      sub_vertical: String(input.sub_vertical || ''),
      taxonomy_version: TAXONOMY_VERSION_FALLBACK,
      fallback_applied: false,
      reasons: ['taxonomy_not_loaded'],
    };
  }
  const version = taxonomy.taxonomy_version || TAXONOMY_VERSION_FALLBACK;
  const verts = normalizeVerticals(taxonomy);
  const fb = fallbackPair(taxonomy);
  const fallbackV = fb.vertical;
  const fallbackS = fb.sub_vertical;

  let vertical = String(input.vertical || '').trim();
  let sub = String(input.sub_vertical || '').trim();
  let fallback_applied = false;
  let candidate_sub_vertical: string | undefined;

  const originalVertical = vertical;
  const originalSub = sub;

  // Match ids and labels without punctuation or case getting in the way:
  // a model that answers "HVAC" means the `hvac` leaf, and rejecting that
  // sends a correctly classified account to the fallback vertical, which
  // permits no outreach at all.
  //
  // This deliberately normalizes FORM only. It never guesses meaning — a
  // model answering "Construction" for an HVAC contractor stays unsupported,
  // because construction_project_services is a different family from
  // trades_field_services and quietly picking one would attach the wrong
  // diagnostics to the account. Fail closed on meaning, forgive formatting.
  const canonical = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const matches = (candidate: string, value: string) => (
    Boolean(candidate) && canonical(candidate) === canonical(value)
  );

  const vHit = verts.find((v) => matches(v.id, vertical) || matches(v.label, vertical));
  if (!vertical) {
    vertical = fallbackV;
    fallback_applied = true;
    reasons.push('vertical_empty_fallback');
  } else if (!vHit) {
    reasons.push(`unsupported_vertical:${vertical}`);
    vertical = fallbackV;
    fallback_applied = true;
  } else {
    vertical = vHit.id;
  }

  const vertNode = verts.find((v) => v.id === vertical);
  const subs = vertNode?.sub_verticals || [];

  if (sub) {
    const sHit = subs.find((s) => matches(s.id, sub) || matches(s.label, sub));
    if (!sHit && subs.length > 0) {
      reasons.push(`unsupported_sub_vertical:${originalSub || sub}`);
      if (originalSub) candidate_sub_vertical = originalSub;
      sub = pickLeafFallback(subs, fallbackS);
      fallback_applied = true;
    } else if (sHit) {
      sub = sHit.id;
    }
  } else if (subs.length > 0) {
    sub = pickLeafFallback(subs, fallbackS);
    fallback_applied = true;
    reasons.push('sub_vertical_empty_fallback');
  }

  // Final safety: never emit a pair that is not controlled in the registry.
  if (subs.length > 0 && !isControlledPair(verts, vertical, sub)) {
    if (originalSub && !candidate_sub_vertical) candidate_sub_vertical = originalSub;
    sub = pickLeafFallback(subs, fallbackS);
    fallback_applied = true;
    if (!reasons.some((r) => r.startsWith('unsupported_sub_vertical') || r === 'sub_vertical_empty_fallback')) {
      reasons.push('sub_vertical_not_in_vertical_fallback');
    }
  }

  // If top-level vertical itself is missing from registry (corrupt fallbacks), force global pair.
  if (verts.length > 0 && !verts.some((v) => v.id === vertical)) {
    reasons.push(`unsupported_vertical_after_fallback:${vertical}`);
    vertical = fallbackV;
    const fbNode = verts.find((v) => v.id === fallbackV);
    sub = pickLeafFallback(fbNode?.sub_verticals || [], fallbackS);
    fallback_applied = true;
  }

  const controlled = isControlledPair(verts, vertical, sub);
  const ok = controlled && !fallback_applied && reasons.length === 0;

  // When only vertical fell back, keep candidate from original labels for extension.
  if (fallback_applied && originalVertical && !vHit && !candidate_sub_vertical) {
    candidate_sub_vertical = originalSub || originalVertical;
  }

  const result: TaxonomyValidation = {
    ok,
    vertical,
    sub_vertical: sub,
    taxonomy_version: version,
    fallback_applied,
    reasons,
  };
  if (candidate_sub_vertical) result.candidate_sub_vertical = candidate_sub_vertical;
  return result;
}

/** True if label is in the controlled set (no fallback). */
export function isSupportedVertical(vertical: string, taxonomy?: VerticalTaxonomy | null): boolean {
  const t = taxonomy ?? loadVerticalTaxonomy();
  if (!t) return false;
  return normalizeVerticals(t).some((v) => v.id === vertical);
}

/** True if (vertical, sub_vertical) is a controlled pair in the registry. */
export function isControlledVerticalPair(
  vertical: string,
  subVertical: string,
  taxonomy?: VerticalTaxonomy | null,
): boolean {
  const t = taxonomy ?? loadVerticalTaxonomy();
  if (!t) return false;
  return isControlledPair(normalizeVerticals(t), vertical, subVertical);
}
