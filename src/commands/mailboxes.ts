import { fileURLToPath } from 'node:url';
import { resolveListDir } from '../orchestrator/runtime/paths.js';
import { readConfig } from '../orchestrator/lib/config.js';
import {
  loadMailboxesCatalog,
  redact,
  resolveMailboxCredentials,
  smtpCredentialEnv,
} from '../orchestrator/lib/mailboxes.js';
import { executeJsonCommand } from '../orchestrator/runtime/providers/command.js';

const smtpScript = fileURLToPath(new URL('../../scripts/smtp-send.mjs', import.meta.url));
const trim = (value: unknown) => String(value ?? '').trim();

const catalogForList = (list: string) => {
  const listDir = resolveListDir(list);
  const loaded = readConfig(listDir);
  if (loaded.errors.length > 0) throw new Error(`Invalid list config: ${loaded.errors.join('; ')}`);
  const catalog = loadMailboxesCatalog({ listDir, config: loaded.config });
  if (!catalog) throw new Error(`List "${list}" does not configure mailboxes.dir or mailboxes.file.`);
  return { listDir, catalog };
};

export const mailboxesListCommand = ({ list }: { list: string }) => {
  const { catalog } = catalogForList(list);
  return {
    catalog: catalog.path,
    selection: catalog.selection,
    mailboxes: catalog.mailboxes.map((mailbox) => {
      const resolved = resolveMailboxCredentials(mailbox, catalog.yamlDir);
      return {
        id: mailbox.id,
        label: mailbox.label,
        enabled: mailbox.enabled,
        email: redact(mailbox.email),
        from: redact(resolved.credentials.SMTP_FROM || resolved.credentials.SMTP_USER || ''),
        has_credentials: Object.keys(resolved.credentials).length > 0,
        daily_cap: mailbox.daily_cap,
        tags: mailbox.tags,
      };
    }),
    warnings: catalog.warnings,
  };
};

export const mailboxesShowCommand = ({ list, mailboxId }: { list: string; mailboxId: string }) => {
  const { catalog } = catalogForList(list);
  const mailbox = catalog.mailboxes.find((candidate) => candidate.id === trim(mailboxId));
  if (!mailbox) throw new Error(`Mailbox "${mailboxId}" was not found.`);
  const resolved = resolveMailboxCredentials(mailbox, catalog.yamlDir);
  return {
    id: mailbox.id,
    label: mailbox.label,
    enabled: mailbox.enabled,
    email: redact(mailbox.email),
    provider: mailbox.provider,
    daily_cap: mailbox.daily_cap,
    tags: mailbox.tags,
    credentials: {
      source: resolved.source,
      path: resolved.path || undefined,
      keys_present: Object.keys(resolved.credentials).sort(),
      values: redact(resolved.credentials),
    },
    warnings: catalog.warnings,
  };
};

export const mailboxesTestCommand = async ({
  list,
  mailboxId,
  to,
}: {
  list: string;
  mailboxId: string;
  to: string;
}) => {
  const { listDir, catalog } = catalogForList(list);
  const mailbox = catalog.mailboxes.find((candidate) => candidate.id === trim(mailboxId));
  if (!mailbox) throw new Error(`Mailbox "${mailboxId}" was not found.`);
  if (!mailbox.enabled) throw new Error(`Mailbox "${mailboxId}" is disabled.`);
  const resolved = resolveMailboxCredentials(mailbox, catalog.yamlDir);
  const result = await executeJsonCommand({
    command: process.execPath,
    argv: [smtpScript, 'send', '--to', trim(to), '--subject', 'Agent Outbound mailbox test', '--body', 'Mailbox credential test.', '--json'],
    cwd: listDir,
    env: smtpCredentialEnv(resolved.credentials),
    label: `Mailbox "${mailbox.id}" SMTP test`,
  });
  return {
    mailbox_id: mailbox.id,
    message_id: trim((result as Record<string, unknown>)?.message_id),
    mode: trim((result as Record<string, unknown>)?.mode),
  };
};
