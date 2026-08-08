/**
 * Vertical taxonomy load + validation. Rejects unsupported labels at write time.
 *
 * Accepts both registry shapes:
 * - array: { verticals: [{ id, sub_verticals: [{ id }] }] }
 * - map: { verticals: { services: { sub_verticals: ["maintenance"] } } }
 * Sub-verticals may be string ids or { id } objects.
 *
 * Fallback behavior (customer-vertical-taxonomy.md):
 * - Unknown top-level → the taxonomy-declared global fallback pair
 * - Known top-level, unknown leaf → that vertical's declared fallback leaf
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Marker for a failed taxonomy resolution; never a pipeline taxonomy version. */
export const TAXONOMY_VERSION_UNRESOLVED = 'unresolved';

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
  /** Map-shaped registries may use top-level fallback_* keys. */
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

let cached: { path: string; content: string; data: VerticalTaxonomy } | null = null;

/** Resolve taxonomy JSON path: env override or a conventional list-relative registry location. */
export function resolveTaxonomyPath(listDir?: string): string | null {
  if (process.env.AO_VERTICAL_TAXONOMY_PATH && existsSync(process.env.AO_VERTICAL_TAXONOMY_PATH)) {
    return process.env.AO_VERTICAL_TAXONOMY_PATH;
  }
  const candidates = [
    listDir ? resolve(listDir, 'build/registries/vertical-taxonomy.json') : '',
    listDir ? resolve(listDir, 'registries/vertical-taxonomy.json') : '',
    // A workspace may build shared registries next to its list directories.
    listDir ? resolve(listDir, '../build/registries/vertical-taxonomy.json') : '',
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadVerticalTaxonomy(listDirOrPath?: string): VerticalTaxonomy | null {
  const path = listDirOrPath && existsSync(listDirOrPath) && listDirOrPath.endsWith('.json')
    ? listDirOrPath
    : resolveTaxonomyPath(listDirOrPath);
  if (!path || !existsSync(path)) return null;
  const content = readFileSync(path, 'utf8');
  if (cached?.path === path && cached.content === content) return cached.data;
  const data = JSON.parse(content) as VerticalTaxonomy;
  cached = { path, content, data };
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
      String(taxonomy.fallbacks?.vertical || taxonomy.fallback_vertical || '').trim(),
    sub_vertical:
      String(taxonomy.fallbacks?.sub_vertical || taxonomy.fallback_sub_vertical || '').trim(),
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
      taxonomy_version: TAXONOMY_VERSION_UNRESOLVED,
      fallback_applied: false,
      reasons: ['taxonomy_not_loaded'],
    };
  }
  const version = String(taxonomy.taxonomy_version || '').trim();
  if (!version) {
    return {
      ok: false,
      vertical: String(input.vertical || ''),
      sub_vertical: String(input.sub_vertical || ''),
      taxonomy_version: TAXONOMY_VERSION_UNRESOLVED,
      fallback_applied: false,
      reasons: ['taxonomy_version_missing'],
    };
  }
  const verts = normalizeVerticals(taxonomy);
  const fb = fallbackPair(taxonomy);
  if (!fb.vertical || !fb.sub_vertical) {
    return {
      ok: false,
      vertical: String(input.vertical || ''),
      sub_vertical: String(input.sub_vertical || ''),
      taxonomy_version: version,
      fallback_applied: false,
      reasons: ['taxonomy_fallback_missing'],
    };
  }
  const fallbackV = fb.vertical;
  const fallbackS = fb.sub_vertical;

  let vertical = String(input.vertical || '').trim();
  let sub = String(input.sub_vertical || '').trim();
  let fallback_applied = false;
  let candidate_sub_vertical: string | undefined;

  const originalVertical = vertical;
  const originalSub = sub;

  // Normalize form only. Semantic matches must be explicit in the taxonomy.
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
