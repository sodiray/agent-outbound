import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import yaml from 'js-yaml';
import {
  resolveCredentials,
  type Credentials,
} from './credentials.js';
import { nowIso } from './record.js';

export type MailboxCredentials = Credentials;

export { parseEnvFile } from './credentials.js';

export type Mailbox = {
  id: string;
  label: string;
  email: string;
  provider: string;
  enabled: boolean;
  daily_cap?: number;
  tags: string[];
  credentials: string | Record<string, unknown>;
};

export type MailboxesCatalog = {
  path: string;
  yamlDir: string;
  selection: {
    strategy: 'fixed' | 'sticky' | 'round_robin';
    default: string;
    pool: string[];
  };
  mailboxes: Mailbox[];
  warnings: string[];
};

const SMTP_ENV_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE'];

type Db = {
  prepare: (sql: string) => {
    get: (...params: unknown[]) => Record<string, unknown> | undefined;
  };
};

const nonBlank = (value: unknown) => String(value ?? '').trim();
const isObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);
const isSink = () => process.env.AO_SMTP_SINK === '1';

const normalizeMailbox = (raw: unknown): Mailbox => {
  const value = isObject(raw) ? raw : {};
  const credentials = typeof value.credentials === 'string'
    ? value.credentials
    : (isObject(value.credentials) ? value.credentials : {});
  return {
    id: nonBlank(value.id),
    label: nonBlank(value.label),
    email: nonBlank(value.email),
    provider: nonBlank(value.provider),
    enabled: value.enabled !== false,
    daily_cap: value.daily_cap === undefined ? undefined : Number(value.daily_cap),
    tags: Array.isArray(value.tags) ? value.tags.map(nonBlank).filter(Boolean) : [],
    credentials,
  };
};

const inlineSecretKeys = (credentials: Mailbox['credentials']) => {
  if (!isObject(credentials)) return [];
  return ['SMTP_USER', 'SMTP_PASS'].filter((key) => nonBlank(credentials[key]));
};

export const loadMailboxesCatalog = ({
  listDir,
  config,
}: {
  listDir: string;
  config: Record<string, unknown>;
}): MailboxesCatalog | null => {
  const listMailboxes = isObject(config?.mailboxes) ? config.mailboxes : null;
  const dir = nonBlank(listMailboxes?.dir);
  const file = nonBlank(listMailboxes?.file);
  if (!dir && !file) return null;
  const resolvedDir = dir ? (isAbsolute(dir) ? dir : join(listDir, dir)) : listDir;
  const path = file
    ? (isAbsolute(file) ? file : join(listDir, file))
    : join(resolvedDir, 'mailboxes.yaml');
  if (!existsSync(path)) throw new Error(`Mailboxes catalog not found: ${path}`);
  const parsed = yaml.load(readFileSync(path, 'utf8'));
  if (!isObject(parsed)) throw new Error(`Invalid mailboxes catalog: ${path}`);
  if (Number(parsed.version || 1) !== 1) throw new Error(`Unsupported mailboxes catalog version in ${path}`);
  const mailboxes = (Array.isArray(parsed.mailboxes) ? parsed.mailboxes : []).map(normalizeMailbox);
  const ids = new Set<string>();
  for (const mailbox of mailboxes) {
    if (!mailbox.id) throw new Error(`Mailbox in ${path} is missing id.`);
    if (ids.has(mailbox.id)) throw new Error(`Duplicate mailbox id "${mailbox.id}" in ${path}.`);
    ids.add(mailbox.id);
  }
  const selectionRaw = isObject(parsed.selection) ? parsed.selection : {};
  const strategy = nonBlank(selectionRaw.strategy || 'sticky');
  if (!['fixed', 'sticky', 'round_robin'].includes(strategy)) {
    throw new Error(`Invalid mailbox selection strategy "${strategy}" in ${path}.`);
  }
  const defaultId = nonBlank(selectionRaw.default);
  const pool = (Array.isArray(selectionRaw.pool) ? selectionRaw.pool : mailboxes.map((mailbox) => mailbox.id))
    .map(nonBlank)
    .filter((id, index, values) => Boolean(id) && values.indexOf(id) === index);
  const allowInline = listMailboxes?.allow_inline_secrets === true || process.env.AO_ALLOW_INLINE_SMTP_SECRETS === '1';
  const warnings = allowInline ? [] : mailboxes.flatMap((mailbox) => {
    const keys = inlineSecretKeys(mailbox.credentials);
    return keys.length > 0
      ? [`Mailbox "${mailbox.id}" has inline ${keys.join(', ')}; prefer a credentials dotenv file or set mailboxes.allow_inline_secrets: true.`]
      : [];
  });
  return {
    path,
    yamlDir: dirname(path),
    selection: { strategy: strategy as MailboxesCatalog['selection']['strategy'], default: defaultId, pool },
    mailboxes,
    warnings,
  };
};

export const resolveMailboxCredentials = (mailbox: Mailbox, yamlDir: string) => {
  return resolveCredentials({
    credentials: mailbox.credentials,
    yamlDir,
    subject: `mailbox "${mailbox.id}"`,
  });
};

export const smtpCredentialEnv = (credentials: MailboxCredentials) => ({
  ...credentials,
  ...Object.fromEntries(SMTP_ENV_KEYS.map((key) => [key, credentials[key] || ''])),
});

const eventMailboxId = (db: Db, rowId?: string) => {
  const scoped = rowId ? 'AND row_id = ?' : '';
  const row = db.prepare(`
    SELECT json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.mailbox_id') AS mailbox_id
    FROM channel_events
    WHERE channel = 'email'
      AND (action IN ('executed', 'sent') OR event_type IN ('executed', 'sent'))
      ${scoped}
    ORDER BY occurred_at DESC
    LIMIT 1
  `).get(...(rowId ? [rowId] : []));
  return nonBlank(row?.mailbox_id);
};

export const countMailboxSendsToday = (db: Db, mailboxId: string, asOf: string | Date = nowIso()) => {
  const dayStart = new Date(asOf);
  dayStart.setUTCHours(0, 0, 0, 0);
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM channel_events
    WHERE channel = 'email'
      AND (action IN ('executed', 'sent') OR event_type IN ('executed', 'sent'))
      AND occurred_at >= ?
      AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.mailbox_id') = ?
  `).get(dayStart.toISOString(), mailboxId);
  return Number(row?.n || 0);
};

export const selectMailboxId = ({
  catalog,
  db,
  record,
  stepConfig,
  listDefault = '',
}: {
  catalog: MailboxesCatalog;
  db: Db;
  record: Record<string, unknown>;
  stepConfig: Record<string, unknown>;
  listDefault?: string;
}) => {
  const direct = nonBlank(stepConfig.mailbox);
  if (direct) return direct;
  const mailboxFrom = nonBlank(stepConfig.mailbox_from);
  if (mailboxFrom && nonBlank(record[mailboxFrom])) return nonBlank(record[mailboxFrom]);
  const defaultId = nonBlank(listDefault) || catalog.selection.default;
  const assigned = nonBlank(record.assigned_mailbox_id);
  if (catalog.selection.strategy === 'sticky') {
    return assigned || eventMailboxId(db, nonBlank(record._row_id || record.id)) || defaultId;
  }
  if (catalog.selection.strategy === 'fixed') return defaultId;

  const pool = catalog.selection.pool.length > 0 ? catalog.selection.pool : catalog.mailboxes.map((mailbox) => mailbox.id);
  const previous = eventMailboxId(db);
  const start = previous && pool.includes(previous) ? (pool.indexOf(previous) + 1) % pool.length : 0;
  for (const offset of pool.map((_, index) => index)) {
    const id = pool[(start + offset) % pool.length];
    const mailbox = catalog.mailboxes.find((candidate) => candidate.id === id);
    if (!mailbox?.enabled) continue;
    if (Number.isFinite(mailbox.daily_cap) && Number(mailbox.daily_cap) >= 0 && countMailboxSendsToday(db, id) >= Number(mailbox.daily_cap)) continue;
    return id;
  }
  return '';
};

export const resolveSendMailbox = ({
  listDir,
  config,
  db,
  record,
  stepConfig,
}: {
  listDir: string;
  config: Record<string, unknown>;
  db: Db;
  record: Record<string, unknown>;
  stepConfig: Record<string, unknown>;
}) => {
  const catalog = loadMailboxesCatalog({ listDir, config });
  if (!catalog) return null;
  const listMailboxes = isObject(config.mailboxes) ? config.mailboxes : {};
  const id = selectMailboxId({ catalog, db, record, stepConfig, listDefault: nonBlank(listMailboxes.default) });
  if (!id) throw new Error('No enabled mailbox is available under its daily cap.');
  const mailbox = catalog.mailboxes.find((candidate) => candidate.id === id);
  if (!mailbox) throw new Error(`Selected mailbox "${id}" is not defined in ${catalog.path}.`);
  if (!mailbox.enabled) throw new Error(`Selected mailbox "${id}" is disabled.`);
  const resolved = resolveMailboxCredentials(mailbox, catalog.yamlDir);
  if (!isSink()) {
    const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'].filter((key) => !nonBlank(resolved.credentials[key]));
    if (missing.length > 0) throw new Error(`Mailbox "${id}" is missing ${missing.join(', ')} for live SMTP send.`);
  }
  return { mailbox, credentials: resolved.credentials, id, source: resolved.source, credentialsPath: resolved.path, catalog };
};

const redactValue = (value: unknown) => {
  const text = nonBlank(value);
  const at = text.indexOf('@');
  if (at > 0) return `${text.slice(0, 1)}***${text.slice(at)}`;
  return text ? '[redacted]' : '';
};

export const redact = (value: unknown): unknown => {
  if (typeof value === 'string') return redactValue(value);
  if (Array.isArray(value)) return value.map(redact);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    const upper = key.toUpperCase();
    if (upper.includes('PASS') || upper.includes('SECRET') || upper.includes('TOKEN') || upper === 'SMTP_USER') return [key, nonBlank(entry) ? '[redacted]' : ''];
    if (upper.includes('EMAIL') || upper.includes('FROM')) return [key, redactValue(entry)];
    return [key, redact(entry)];
  }));
};
