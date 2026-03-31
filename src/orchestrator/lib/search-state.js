/**
 * Persists per-search pagination state.
 * Stored at .outbound/search-state.json, keyed by search ID.
 *
 * Each entry stores the pagination object returned by the last
 * successful search execution. On subsequent runs, the orchestrator
 * passes this back to the execute-step action so the sourcer agent
 * can continue from where it left off.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INTERNAL_DIR_NAME = '.outbound';
const STATE_FILE_NAME = 'search-state.json';

const getStatePath = (listDir) =>
  join(String(listDir), INTERNAL_DIR_NAME, STATE_FILE_NAME);

const readState = (listDir) => {
  try {
    const filePath = getStatePath(listDir);
    if (!existsSync(filePath)) return {};
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
};

const writeState = (listDir, state) => {
  try {
    writeFileSync(getStatePath(listDir), JSON.stringify(state, null, 2));
  } catch {
    // State persistence should never break orchestration
  }
};

/**
 * Get the stored pagination for a search.
 * Returns the pagination object or null if none exists.
 */
export const getSearchPagination = (listDir, searchId) => {
  const state = readState(listDir);
  const entry = state[String(searchId)];
  if (!entry) return null;
  return entry.pagination ?? null;
};

/**
 * Store pagination state for a search.
 * Pass null to indicate the search is exhausted.
 */
export const setSearchPagination = (listDir, searchId, pagination) => {
  const state = readState(listDir);
  state[String(searchId)] = {
    pagination,
    updated_at: new Date().toISOString(),
  };
  writeState(listDir, state);
};

/**
 * Check if a search is marked as exhausted.
 */
export const isSearchExhausted = (listDir, searchId) => {
  const pagination = getSearchPagination(listDir, searchId);
  if (pagination === null) return false; // No state = never run = not exhausted
  if (pagination === false) return true; // Explicitly null from sourcer
  if (pagination?.exhausted === true) return true;
  return false;
};

/**
 * Reset pagination for a search (e.g., when config changes).
 */
export const resetSearchPagination = (listDir, searchId) => {
  const state = readState(listDir);
  delete state[String(searchId)];
  writeState(listDir, state);
};

/**
 * Reset all search pagination for a list.
 */
export const resetAllSearchPagination = (listDir) => {
  writeState(listDir, {});
};
