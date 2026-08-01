#!/usr/bin/env node
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  countMailboxSendsToday,
  loadMailboxesCatalog,
  resolveMailboxCredentials,
  selectMailboxId,
} from '../../dist/orchestrator/lib/mailboxes.js';
import { readConfig } from '../../dist/orchestrator/lib/config.js';
import { insertChannelEvent, openListDb, upsertRecord } from '../../dist/orchestrator/runtime/db.js';
import { runPipelineDataflow } from '../../dist/orchestrator/pipeline/dataflow.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SMTP_SCRIPT = join(ROOT, 'scripts/smtp-send.mjs');
const root = mkdtempSync(join(tmpdir(), 'ao-mailboxes-'));
const listDir = join(root, 'list');
const boxesDir = join(root, 'mailboxes');
const credentialsDir = join(boxesDir, 'credentials');
const sinkDir = join(root, 'sink');
mkdirSync(credentialsDir, { recursive: true });
mkdirSync(sinkDir, { recursive: true });

const summary = { pass: 0 };
const failures = [];
const check = (name, fn) => {
  try {
    const failure = fn();
    if (failure) {
      failures.push([name, failure]);
      console.log(`  FAIL  ${name}\n          ${failure}`);
      return;
    }
    summary.pass += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    const failure = String(error?.message || error);
    failures.push([name, failure]);
    console.log(`  FAIL  ${name}\n          ${failure}`);
  }
};

const now = new Date().toISOString();
const config = { mailboxes: { dir: '../mailboxes' } };
writeFileSync(join(credentialsDir, 'path.env'), 'SMTP_HOST=path.example\nSMTP_USER=path-user\nSMTP_PASS=path-pass\nSMTP_FROM=path@example.com\n');
writeFileSync(join(credentialsDir, 'override.env'), 'SMTP_HOST=override.example\nSMTP_USER=override-user\nSMTP_PASS=override-pass\nSMTP_FROM=file@example.com\n');
writeFileSync(join(boxesDir, 'mailboxes.yaml'), `version: 1
selection:
  strategy: fixed
  default: path
  pool: [path, override, inline]
mailboxes:
  - id: path
    enabled: true
    credentials: ./credentials/path.env
  - id: override
    enabled: true
    daily_cap: 10
    credentials:
      path: ./credentials/override.env
      SMTP_FROM: yaml@example.com
  - id: inline
    enabled: true
    credentials:
      SMTP_HOST: inline.example
      SMTP_USER: inline-user
      SMTP_PASS: inline-pass
      SMTP_FROM: inline@example.com
`);

const catalog = loadMailboxesCatalog({ listDir, config });
const pathBox = catalog.mailboxes.find((mailbox) => mailbox.id === 'path');
const overrideBox = catalog.mailboxes.find((mailbox) => mailbox.id === 'override');
const inlineBox = catalog.mailboxes.find((mailbox) => mailbox.id === 'inline');
const pathCredentials = resolveMailboxCredentials(pathBox, catalog.yamlDir);
const overrideCredentials = resolveMailboxCredentials(overrideBox, catalog.yamlDir);
const inlineCredentials = resolveMailboxCredentials(inlineBox, catalog.yamlDir);

check('path-only credentials load', () => pathCredentials.credentials.SMTP_HOST === 'path.example' && pathCredentials.source === 'path' ? '' : JSON.stringify(pathCredentials));
check('path + YAML credentials override file values', () => overrideCredentials.credentials.SMTP_FROM === 'yaml@example.com' && overrideCredentials.credentials.SMTP_HOST === 'override.example' && overrideCredentials.source === 'merged' ? '' : JSON.stringify(overrideCredentials));
check('inline-only credentials load', () => inlineCredentials.credentials.SMTP_USER === 'inline-user' && inlineCredentials.source === 'inline' ? '' : JSON.stringify(inlineCredentials));

const selectionDb = openListDb({ listDir, readonly: false });
upsertRecord({ db: selectionDb, row: { _row_id: 'sticky-record', business_name: 'Sticky', assigned_mailbox_id: 'override', created_at: now, updated_at: now } });
upsertRecord({ db: selectionDb, row: { _row_id: 'r-path', business_name: 'Path', created_at: now, updated_at: now } });
upsertRecord({ db: selectionDb, row: { _row_id: 'r-inline', business_name: 'Inline', created_at: now, updated_at: now } });
check('fixed selection uses default', () => selectMailboxId({ catalog, db: selectionDb, record: {}, stepConfig: {}, listDefault: '' }) === 'path' ? '' : 'wrong fixed selection');

const stickyCatalog = { ...catalog, selection: { ...catalog.selection, strategy: 'sticky' } };
check('sticky selection uses assigned mailbox id', () => selectMailboxId({ catalog: stickyCatalog, db: selectionDb, record: { _row_id: 'sticky-record', assigned_mailbox_id: 'override' }, stepConfig: {}, listDefault: '' }) === 'override' ? '' : 'wrong sticky selection');

const roundCatalog = {
  ...catalog,
  selection: { ...catalog.selection, strategy: 'round_robin', pool: ['path', 'override', 'inline'] },
  mailboxes: catalog.mailboxes.map((mailbox) => mailbox.id === 'path' ? { ...mailbox, daily_cap: 1 } : mailbox),
};
insertChannelEvent({ db: selectionDb, event: { id: 'cap-path', record_id: 'r-path', channel: 'email', action: 'executed', payload: { mailbox_id: 'path' }, occurred_at: new Date(Date.now() - 2_000).toISOString() } });
insertChannelEvent({ db: selectionDb, event: { id: 'latest-inline', record_id: 'r-inline', channel: 'email', action: 'executed', payload: { mailbox_id: 'inline' }, occurred_at: new Date(Date.now() - 1_000).toISOString() } });
check('round_robin skips over-cap mailbox', () => countMailboxSendsToday(selectionDb, 'path') === 1 && selectMailboxId({ catalog: roundCatalog, db: selectionDb, record: {}, stepConfig: {}, listDefault: '' }) === 'override' ? '' : 'round robin did not skip path');
selectionDb.close();

mkdirSync(listDir, { recursive: true });
writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({
  mcpServers: {
    smtp: {
      type: 'command',
      command: process.execPath,
      args: [SMTP_SCRIPT],
      env: {
        AO_SMTP_SINK: '1',
        AO_SMTP_SINK_DIR: sinkDir,
        SMTP_HOST: '${SMTP_HOST}',
        SMTP_USER: '${SMTP_USER}',
        SMTP_PASS: '${SMTP_PASS}',
      },
      tools: [{
        slug: 'SMTP_SEND',
        input_schema: { type: 'object', properties: { to: { type: 'string' }, from: { type: 'string' } } },
        invoke: { argv: ['send', '--to', '{{to}}', '--subject', '{{subject}}', '--body', '{{body}}', '--from', '{{from}}', '--json'], result: 'stdout_json' },
      }],
    },
  },
}, null, 2));
writeFileSync(join(listDir, 'outbound.yaml'), `list: {name: mailbox-e2e}
ai: {default_model: anthropic/claude-sonnet-4-6}
mailboxes: {dir: ../mailboxes}
sequences: {default: {steps: []}}
pipeline:
  - kind: send_email
    id: send
    side_effecting: true
    draft_approval_required: false
    config:
      action: tool_call
      tool: {server: smtp, tools: [SMTP_SEND]}
      args: {subject: mailbox test, body: mailbox body}
      args_map: {to: contact_email}
      output_map: {message_id: message_id}
      mailbox: override
`);
const e2eDb = openListDb({ listDir, readonly: false });
upsertRecord({ db: e2eDb, row: { _row_id: 'e2e', business_name: 'Mailbox Co', created_at: now, updated_at: now } });
e2eDb.prepare('UPDATE records SET contact_email = ? WHERE _row_id = ?').run('buyer@example.com', 'e2e');
const e2eResult = await runPipelineDataflow({ listDir, where: "_row_id = 'e2e'", concurrency: 10 });
const sinkFile = readdirSync(sinkDir).find((name) => name.endsWith('.json'));
const sinkPayload = sinkFile ? JSON.parse(readFileSync(join(sinkDir, sinkFile), 'utf8')) : null;
const e2eEvent = e2eDb.prepare("SELECT payload_json FROM channel_events WHERE row_id = 'e2e' AND channel = 'email' ORDER BY occurred_at DESC LIMIT 1").get();
const e2eRow = e2eDb.prepare("SELECT assigned_mailbox_id, email_last_from FROM records WHERE _row_id = 'e2e'").get();
check('end-to-end SMTP overlay uses mailbox FROM and persists mailbox state', () => {
  const payload = e2eEvent ? JSON.parse(e2eEvent.payload_json) : {};
  if (e2eResult.failed || !sinkPayload) return JSON.stringify({ result: e2eResult, sinkPayload });
  if (sinkPayload.from !== 'yaml@example.com') return `sink from=${sinkPayload.from}`;
  if (payload.mailbox_id !== 'override' || payload.smtp_from !== 'yaml@example.com') return JSON.stringify(payload);
  if (e2eRow.assigned_mailbox_id !== 'override' || e2eRow.email_last_from !== 'yaml@example.com') return JSON.stringify(e2eRow);
  return '';
});
e2eDb.close();

try { rmSync(root, { recursive: true, force: true }); } catch { /* validation cleanup */ }
console.log(`\npassed ${summary.pass} failed ${failures.length}`);
if (failures.length > 0) {
  failures.forEach(([name, why]) => console.log(` - ${name}: ${why}`));
  process.exit(1);
}
