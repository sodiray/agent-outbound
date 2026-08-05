/**
 * Canary isolation — keep unscoped pipeline/sequence mutations off the dirty
 * production corpus unless an explicit allowlist or list-local canary marker
 * is present.
 *
 * Modes:
 * - off (default): no-op; normal production use
 * - canary: only allowlisted lists/records (or list-local canary markers)
 * - strict: same as canary, plus refuse any mutation when the record
 *   allowlist is empty
 *
 * Config sources (later overlays earlier):
 * 1. env: AO_CANARY_MODE, AO_CANARY_ALLOWLIST, AO_CANARY_LISTS, AO_CANARY_NAMESPACE
 * 2. list-local: .outbound/canary.json | .outbound/canary.yaml | canary.json | canary.yaml
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { AgentOutboundError } from '../runtime/contract.js';
import { getListName } from '../runtime/paths.js';
import { getRecordRowId } from '../lib/record.js';

export type CanaryMode = 'off' | 'canary' | 'strict';

export type CanaryIsolationConfig = {
  mode: CanaryMode;
  allowlist_record_ids: string[];
  allowlist_list_names: string[];
  namespace?: string;
};

const CANARY_FILE_CANDIDATES = [
  join('.outbound', 'canary.json'),
  join('.outbound', 'canary.yaml'),
  join('.outbound', 'canary.yml'),
  'canary.json',
  'canary.yaml',
  'canary.yml',
] as const;

const NAMESPACE_MARKER_CANDIDATES = [
  join('.outbound', 'canary-namespace'),
  join('.outbound', 'namespace'),
  'canary-namespace',
] as const;

const parseCsv = (raw: string | undefined | null): string[] =>
  String(raw || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const parseMode = (raw: unknown): CanaryMode => {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'canary' || value === 'strict' || value === 'off') return value;
  return 'off';
};

const unique = (values: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = String(value || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
};

const emptyConfig = (): CanaryIsolationConfig => ({
  mode: 'off',
  allowlist_record_ids: [],
  allowlist_list_names: [],
});

const MODE_RANK: Record<CanaryMode, number> = { off: 0, canary: 1, strict: 2 };

/**
 * Merge env (base) with list-local overlay.
 *
 * CRITICAL security properties:
 * 1. list-local MUST NOT downgrade env mode (strict→off was a bypass).
 * 2. When env owns a non-empty AO_CANARY_ALLOWLIST, it is AUTHORITATIVE —
 *    list-local may only further restrict (intersection), never expand.
 * 3. When env allowlist is empty, list-local may supply ids (local canary setup).
 */
const mergeConfigs = (
  base: CanaryIsolationConfig,
  overlay: Partial<CanaryIsolationConfig> | null | undefined,
): CanaryIsolationConfig => {
  if (!overlay || typeof overlay !== 'object') return base;
  const overlayMode = overlay.mode != null ? parseMode(overlay.mode) : base.mode;
  // Never lower mode below env/base.
  const mode = MODE_RANK[overlayMode] > MODE_RANK[base.mode] ? overlayMode : base.mode;

  const overlayIds = Array.isArray(overlay.allowlist_record_ids)
    ? overlay.allowlist_record_ids.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  let allowlist_record_ids: string[];
  if (base.allowlist_record_ids.length > 0) {
    // Env-owned authoritative allowlist: overlay can only intersect (restrict).
    if (overlayIds.length > 0) {
      const envSet = new Set(base.allowlist_record_ids);
      allowlist_record_ids = unique(overlayIds.filter((id) => envSet.has(id)));
    } else {
      allowlist_record_ids = [...base.allowlist_record_ids];
    }
  } else {
    // Env empty — list-local may define the canary set.
    allowlist_record_ids = unique(overlayIds);
  }

  const overlayLists = Array.isArray(overlay.allowlist_list_names)
    ? overlay.allowlist_list_names.map((n) => String(n || '').trim()).filter(Boolean)
    : [];
  let allowlist_list_names: string[];
  if (base.allowlist_list_names.length > 0) {
    if (overlayLists.length > 0) {
      const envSet = new Set(base.allowlist_list_names);
      allowlist_list_names = unique(overlayLists.filter((n) => envSet.has(n)));
    } else {
      allowlist_list_names = [...base.allowlist_list_names];
    }
  } else {
    allowlist_list_names = unique(overlayLists);
  }

  const namespace = overlay.namespace != null && String(overlay.namespace).trim()
    ? String(overlay.namespace).trim()
    : base.namespace;
  return {
    mode,
    allowlist_record_ids,
    allowlist_list_names,
    ...(namespace ? { namespace } : {}),
  };
};

const normalizeLocalFile = (raw: any): Partial<CanaryIsolationConfig> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const ids = raw.allowlist_record_ids
    ?? raw.allowlistRecordIds
    ?? raw.record_ids
    ?? raw.recordIds
    ?? raw.ids
    ?? [];
  const lists = raw.allowlist_list_names
    ?? raw.allowlistListNames
    ?? raw.list_names
    ?? raw.listNames
    ?? raw.lists
    ?? [];
  return {
    mode: raw.mode != null ? parseMode(raw.mode) : undefined,
    allowlist_record_ids: Array.isArray(ids)
      ? ids.map((id: unknown) => String(id || '').trim()).filter(Boolean)
      : parseCsv(ids),
    allowlist_list_names: Array.isArray(lists)
      ? lists.map((name: unknown) => String(name || '').trim()).filter(Boolean)
      : parseCsv(lists),
    namespace: raw.namespace != null ? String(raw.namespace).trim() : undefined,
  };
};

export const findCanaryConfigPath = (listDir: string): string => {
  const root = String(listDir || '').trim();
  if (!root) return '';
  for (const rel of CANARY_FILE_CANDIDATES) {
    const full = join(root, rel);
    if (existsSync(full)) return full;
  }
  return '';
};

export const hasCanaryMarker = (listDir: string): boolean => {
  if (findCanaryConfigPath(listDir)) return true;
  const root = String(listDir || '').trim();
  if (!root) return false;
  for (const rel of NAMESPACE_MARKER_CANDIDATES) {
    if (existsSync(join(root, rel))) return true;
  }
  return false;
};

const readNamespaceMarker = (listDir: string): string => {
  const root = String(listDir || '').trim();
  if (!root) return '';
  for (const rel of NAMESPACE_MARKER_CANDIDATES) {
    const full = join(root, rel);
    if (!existsSync(full)) continue;
    try {
      return String(readFileSync(full, 'utf8') || '').trim();
    } catch {
      return '';
    }
  }
  return '';
};

export const loadCanaryConfigFromFile = (listDir: string): Partial<CanaryIsolationConfig> | null => {
  const path = findCanaryConfigPath(listDir);
  if (!path) return null;
  try {
    const text = readFileSync(path, 'utf8');
    if (path.endsWith('.json')) {
      return normalizeLocalFile(JSON.parse(text));
    }
    return normalizeLocalFile(yaml.load(text) || {});
  } catch (error) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: `Failed to load canary config at ${path}: ${String((error as any)?.message || error)}`,
      retryable: false,
      hint: 'Fix .outbound/canary.json (or canary.yaml) syntax, or set AO_CANARY_MODE=off.',
      fields: { path },
      status: 400,
    });
  }
};

/**
 * Load canary isolation config from env (+ optional list-local overlay).
 */
export const loadCanaryConfig = (options?: {
  listDir?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): CanaryIsolationConfig => {
  const env = options?.env || process.env;
  let config: CanaryIsolationConfig = {
    mode: parseMode(env.AO_CANARY_MODE),
    allowlist_record_ids: parseCsv(env.AO_CANARY_ALLOWLIST),
    allowlist_list_names: parseCsv(env.AO_CANARY_LISTS),
    ...(String(env.AO_CANARY_NAMESPACE || '').trim()
      ? { namespace: String(env.AO_CANARY_NAMESPACE || '').trim() }
      : {}),
  };

  const listDir = String(options?.listDir || '').trim();
  if (listDir) {
    const local = loadCanaryConfigFromFile(listDir);
    if (local) config = mergeConfigs(config, local);
  }

  return config;
};

const isActive = (config: CanaryIsolationConfig): boolean =>
  config.mode === 'canary' || config.mode === 'strict';

const deny = (message: string, fields: Record<string, any> = {}) => {
  throw new AgentOutboundError({
    code: 'INVALID_ARGUMENT',
    message,
    retryable: false,
    hint: 'Enable canary isolation only for allowlisted records/lists, or set AO_CANARY_MODE=off for normal prod.',
    fields: { canary: true, ...fields },
    status: 403,
  });
};

/**
 * Strict mode with an empty record allowlist refuses every mutation.
 */
export const assertStrictAllowlistPresent = (config: CanaryIsolationConfig): void => {
  if (config.mode !== 'strict') return;
  if (config.allowlist_record_ids.length > 0) return;
  deny(
    'Canary strict mode refuses mutations when AO_CANARY_ALLOWLIST (record allowlist) is empty.',
    { mode: config.mode, allowlist_record_ids: [] },
  );
};

export const assertCanaryAllowsRecord = ({
  config,
  recordId,
  listName = '',
}: {
  config: CanaryIsolationConfig;
  recordId: string;
  listName?: string;
}): void => {
  if (!isActive(config)) return;
  assertStrictAllowlistPresent(config);

  const rid = String(recordId || '').trim();
  if (!rid) {
    deny('Canary isolation requires a record id.', { mode: config.mode, list: listName || undefined });
  }

  const allowed = new Set(config.allowlist_record_ids.map((id) => String(id).trim()).filter(Boolean));
  if (!allowed.has(rid)) {
    deny(
      `Canary isolation blocked record "${rid}" (not on allowlist).`,
      {
        mode: config.mode,
        record_id: rid,
        list: listName || undefined,
        allowlist_size: allowed.size,
      },
    );
  }
};

export const assertCanaryAllowsList = ({
  config,
  listName,
  listDir,
}: {
  config: CanaryIsolationConfig;
  listName: string;
  listDir: string;
}): void => {
  if (!isActive(config)) return;
  assertStrictAllowlistPresent(config);

  const name = String(listName || getListName(listDir) || '').trim();
  const allowedLists = new Set(
    config.allowlist_list_names.map((entry) => String(entry).trim()).filter(Boolean),
  );
  if (name && allowedLists.has(name)) return;

  // List-local canary.json / canary.yaml marks the corpus as a canary namespace.
  if (findCanaryConfigPath(listDir)) return;

  // Explicit namespace marker file under the list dir.
  if (config.namespace) {
    const marker = readNamespaceMarker(listDir);
    if (marker && marker === config.namespace) return;
  } else if (hasCanaryMarker(listDir)) {
    // Marker present without a required namespace — treat as canary list.
    return;
  }

  deny(
    `Canary isolation blocked list "${name || listDir}" (not allowlisted and no canary marker).`,
    {
      mode: config.mode,
      list: name || undefined,
      list_dir: listDir,
      allowlist_lists: [...allowedLists],
      namespace: config.namespace || undefined,
    },
  );
};

/**
 * Filter record rows to allowlisted ids when canary/strict is active.
 * Off mode returns the input unchanged. Strict + empty allowlist → [].
 */
export const filterRecordsForCanary = <T extends Record<string, any>>(
  rows: T[] | null | undefined,
  config: CanaryIsolationConfig,
): T[] => {
  const list = Array.isArray(rows) ? rows : [];
  if (!isActive(config)) return list;

  if (config.mode === 'strict' && config.allowlist_record_ids.length === 0) {
    return [];
  }

  const allowed = new Set(config.allowlist_record_ids.map((id) => String(id).trim()).filter(Boolean));
  if (allowed.size === 0) return [];

  return list.filter((row) => allowed.has(getRecordRowId(row)));
};

/**
 * List-level mutation gate. Call from pipeline/sequence/operator write paths.
 * No-op when mode is off.
 */
export const assertListAccessForMutation = (listDir: string): CanaryIsolationConfig => {
  const dir = String(listDir || '').trim();
  if (!dir) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: 'listDir is required for canary mutation gate.',
      retryable: false,
    });
  }
  const config = loadCanaryConfig({ listDir: dir });
  if (!isActive(config)) return config;
  assertCanaryAllowsList({
    config,
    listName: getListName(dir),
    listDir: dir,
  });
  return config;
};

/**
 * Combined list + record mutation gate for operator single-record writes.
 */
export const assertRecordAccessForMutation = ({
  listDir,
  recordId,
}: {
  listDir: string;
  recordId: string;
}): CanaryIsolationConfig => {
  const config = assertListAccessForMutation(listDir);
  if (!isActive(config)) return config;
  assertCanaryAllowsRecord({
    config,
    recordId,
    listName: getListName(listDir),
  });
  return config;
};

/** @internal test helper */
export const _test = {
  parseMode,
  parseCsv,
  emptyConfig,
  mergeConfigs,
};
