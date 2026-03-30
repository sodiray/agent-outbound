/**
 * Dependency hashing for enrichment staleness detection.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * Hash a set of dependency values into a single string.
 * Used to detect when a row's dependencies have changed.
 *
 * @param {Record<string, string>} row - The CSV row
 * @param {string[]} depColumns - Columns to hash (in order)
 * @param {string[]} [extraHashValues] - Additional stable values to include
 * @returns {string} SHA-256 hex hash
 */
export const hashDeps = (row, depColumns, extraHashValues = []) => {
  const values = depColumns.map((col) => String(row[col] ?? ''));
  const input = [...values, ...extraHashValues.map((value) => String(value ?? ''))].join('|');
  return createHash('sha256').update(input).digest('hex');
};

/**
 * Read the cache file for a list.
 * Returns a map of rowId -> sourceName -> { dep_hash, ran_at }
 */
export const readCache = (cachePath) => {
  if (!existsSync(cachePath)) return {};
  try {
    return JSON.parse(readFileSync(cachePath, 'utf-8'));
  } catch {
    return {};
  }
};

/**
 * Write the cache file for a list.
 */
export const writeCache = (cachePath, cache) => {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
};

/**
 * Check if a source needs to re-run for a specific row.
 *
 * @param {object} params
 * @param {Record<string, string>} params.row - The CSV row
 * @param {string} params.rowId - Stable row identifier
 * @param {string} params.sourceName - Name of the source
 * @param {string[]} params.dependsOn - Dependency columns
 * @param {string[]} params.outputColumns - Produced columns
 * @param {string[]} [params.extraHashValues] - Prompt/file content hash inputs
 * @param {string} params.cacheTTL - Cache TTL string (e.g. "7d", "30d", "never")
 * @param {object} params.cache - The full cache object
 * @returns {{ stale: boolean, reason: string }}
 */
export const checkStaleness = ({
  row,
  rowId,
  sourceName,
  dependsOn,
  outputColumns,
  extraHashValues = [],
  cacheTTL,
  cache,
}) => {
  // Check if we have a cache entry -- if not, this source has never run for this row
  const rowCache = cache[rowId];
  if (!rowCache || !rowCache[sourceName]) {
    return { stale: true, reason: 'no_cache_entry' };
  }

  const entry = rowCache[sourceName];

  // Check TTL
  if (cacheTTL && cacheTTL !== 'never') {
    const ttlMs = parseTTL(cacheTTL);
    const ranAt = new Date(entry.ran_at).getTime();
    if (Date.now() - ranAt > ttlMs) {
      return { stale: true, reason: 'cache_expired' };
    }
  }

  // Check dependency hash -- if inputs changed, re-run
  const currentHash = hashDeps(row, dependsOn, extraHashValues);
  if (currentHash !== entry.dep_hash) {
    return { stale: true, reason: 'deps_changed' };
  }

  // Cache exists, not expired, deps unchanged → fresh.
  // We intentionally do NOT check for empty output columns here.
  // If the source ran successfully and couldn't produce a value,
  // that's a legitimate result -- re-running won't help.
  return { stale: false, reason: 'fresh' };
};

/**
 * Record that a source ran for a row.
 */
export const recordRun = (cache, rowId, sourceName, depHash) => {
  if (!cache[rowId]) cache[rowId] = {};
  cache[rowId][sourceName] = {
    dep_hash: depHash,
    ran_at: new Date().toISOString(),
  };
};

const parseTTL = (ttl) => {
  const match = ttl.match(/^(\d+)(d|h|m)$/);
  if (!match) return Infinity;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { d: 86400000, h: 3600000, m: 60000 };
  return num * (multipliers[unit] || 0);
};
