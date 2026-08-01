#!/usr/bin/env node
/**
 * Deterministic SMTP send tool for Agent Outbound.
 *
 * Modes:
 *   1. Sink (default when SMTP_HOST unset or AO_SMTP_SINK=1): write the message
 *      to AO_SMTP_SINK_DIR (or .outbound/smtp-sink) and return a synthetic message_id.
 *   2. Real SMTP when SMTP_HOST + SMTP_USER + SMTP_PASS are set (Mailforge etc.).
 *      Prefer port 465 (implicit TLS). Port 587 uses STARTTLS.
 *
 * Usage (as MCP command tool):
 *   node scripts/smtp-send.mjs send --to ADDR --subject S --body B [--from ADDR] [--json]
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import tls from 'node:tls';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));

const help = `
smtp-send — send one email via SMTP or sink file.

  node smtp-send.mjs send --to <email> --subject <text> --body <text> [options]

Options:
  --from <email>       From address (default SMTP_FROM or SMTP_USER)
  --to-name <name>     Recipient display name
  --business-name <n>  Merge context (optional)
  --template-id <id>   Optional template marker for logs
  --subject-template   Used when --subject empty
  --json               JSON stdout (default)
  --help

Env (Mailforge / real SMTP):
  SMTP_HOST     e.g. smtp.mailforge.ai
  SMTP_PORT     465 (default, SMTPS) or 587 (STARTTLS)
  SMTP_SECURE   1 for implicit TLS (default on 465), 0 for plain then STARTTLS
  SMTP_USER     mailbox login
  SMTP_PASS     mailbox password
  SMTP_FROM     From header (defaults to SMTP_USER)
  AO_SMTP_SINK  set to 1 to force sink mode even if SMTP_HOST is set
  AO_SMTP_SINK_DIR  directory for sink JSON files
`.trim();

const b64 = (s) => Buffer.from(String(s || ''), 'utf8').toString('base64');
const crlf = (lines) => `${lines.join('\r\n')}\r\n`;

const readSmtpResponse = (socket) => new Promise((resolve, reject) => {
  let buf = '';
  const onData = (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\r\n').filter(Boolean);
    const last = lines[lines.length - 1] || '';
    // Complete response: last line is "### message" (not "###-continuation")
    if (/^\d{3}[ \t]/.test(last) || /^\d{3}$/.test(last)) {
      socket.off('data', onData);
      resolve(buf);
    }
  };
  socket.on('data', onData);
  socket.on('error', reject);
  setTimeout(() => {
    socket.off('data', onData);
    reject(new Error(`SMTP response timeout: ${buf.slice(0, 200)}`));
  }, 30_000);
});

const sendLine = (socket, line) => {
  socket.write(`${line}\r\n`);
};

const expectCode = (response, code, label) => {
  if (!new RegExp(`^${code}`).test(response)) {
    throw new Error(`${label} failed: ${response.trim().slice(0, 300)}`);
  }
};

const connectSocket = ({ host, port, secure }) => new Promise((resolve, reject) => {
  if (secure) {
    const socket = tls.connect({ host, port, servername: host }, () => resolve(socket));
    socket.on('error', reject);
    return;
  }
  const socket = net.connect({ host, port }, () => resolve(socket));
  socket.on('error', reject);
});

const upgradeToTls = (socket, host) => new Promise((resolve, reject) => {
  const upgraded = tls.connect({ socket, servername: host }, () => resolve(upgraded));
  upgraded.on('error', reject);
});

const smtpDialog = async (socket, { user, pass, from, to, subject, body }) => {
  const greet = await readSmtpResponse(socket);
  expectCode(greet, 220, 'SMTP greeting');

  sendLine(socket, 'EHLO agent-outbound');
  await readSmtpResponse(socket);

  sendLine(socket, `AUTH PLAIN ${b64(`\u0000${user}\u0000${pass}`)}`);
  const auth = await readSmtpResponse(socket);
  expectCode(auth, 235, 'SMTP AUTH');

  sendLine(socket, `MAIL FROM:<${from}>`);
  expectCode(await readSmtpResponse(socket), 250, 'MAIL FROM');

  sendLine(socket, `RCPT TO:<${to}>`);
  expectCode(await readSmtpResponse(socket), 250, 'RCPT TO');

  sendLine(socket, 'DATA');
  expectCode(await readSmtpResponse(socket), 354, 'DATA');

  const messageId = `<${randomUUID()}@agent-outbound.local>`;
  const payload = crlf([
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body.replace(/\r?\n/g, '\r\n'),
    '.',
  ]);
  socket.write(payload);
  expectCode(await readSmtpResponse(socket), 250, 'SMTP DATA');
  sendLine(socket, 'QUIT');
  try { socket.end(); } catch { /* */ }
  return { message_id: messageId, mode: 'smtp' };
};

const smtpSend = async ({
  host,
  port,
  secure,
  user,
  pass,
  from,
  to,
  subject,
  body,
}) => {
  if (!host) throw new Error('SMTP_HOST is required for real SMTP mode');
  if (!user || !pass) throw new Error('SMTP_USER and SMTP_PASS are required for real SMTP mode');

  let socket = await connectSocket({ host, port, secure });
  try {
    if (!secure) {
      // STARTTLS path (typical Mailforge port 587)
      const greet = await readSmtpResponse(socket);
      expectCode(greet, 220, 'SMTP greeting');
      sendLine(socket, 'EHLO agent-outbound');
      await readSmtpResponse(socket);
      sendLine(socket, 'STARTTLS');
      expectCode(await readSmtpResponse(socket), 220, 'STARTTLS');
      socket = await upgradeToTls(socket, host);
      // Fresh EHLO on TLS socket happens inside smtpDialog
    }
    return await smtpDialog(socket, { user, pass, from, to, subject, body });
  } catch (err) {
    try { socket.destroy(); } catch { /* */ }
    throw err;
  }
};

const sinkSend = ({ from, to, subject, body, toName, businessName, templateId }) => {
  const sinkDir = process.env.AO_SMTP_SINK_DIR
    || join(process.cwd(), '.outbound', 'smtp-sink');
  mkdirSync(sinkDir, { recursive: true });
  const messageId = `sink_${createHash('sha256')
    .update([from, to, subject, body, Date.now()].join('|'))
    .digest('hex')
    .slice(0, 24)}`;
  const file = join(sinkDir, `${messageId}.json`);
  const payload = {
    message_id: messageId,
    mode: 'sink',
    from,
    to,
    to_name: toName || '',
    business_name: businessName || '',
    template_id: templateId || '',
    subject,
    body,
    sent_at: new Date().toISOString(),
  };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
};

const main = async () => {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      to: { type: 'string' },
      from: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
      'to-name': { type: 'string' },
      'business-name': { type: 'string' },
      'template-id': { type: 'string' },
      'subject-template': { type: 'string' },
      json: { type: 'boolean', default: true },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals[0] === 'help') {
    process.stdout.write(`${help}\n`);
    process.exit(0);
  }

  const cmd = positionals[0] || 'send';
  if (cmd !== 'send') {
    process.stderr.write(`Unknown command: ${cmd}\n`);
    process.exit(2);
  }

  const to = String(values.to || '').trim();
  if (!to) {
    process.stderr.write('Error: --to is required\n');
    process.exit(2);
  }

  let subject = String(values.subject || '').trim();
  if (!subject) {
    const tmpl = String(values['subject-template'] || 'Hello').trim();
    const biz = String(values['business-name'] || '').trim();
    subject = tmpl.replace(/\{\{\s*business_name\s*\}\}/g, biz || 'your business');
  }
  let body = String(values.body || '').trim();
  if (!body) {
    const name = String(values['to-name'] || '').trim() || 'there';
    const biz = String(values['business-name'] || '').trim() || 'your business';
    body = `Hi ${name},\n\nQuick note regarding ${biz}.\n\n— Agent Outbound\n`;
  }

  const from = String(values.from || process.env.SMTP_FROM || process.env.SMTP_USER || 'outbound@localhost').trim();
  const host = String(process.env.SMTP_HOST || '').trim();
  const useSink = process.env.AO_SMTP_SINK === '1' || !host;

  let result;
  if (useSink) {
    result = sinkSend({
      from,
      to,
      subject,
      body,
      toName: values['to-name'],
      businessName: values['business-name'],
      templateId: values['template-id'],
    });
  } else {
    const port = Number(process.env.SMTP_PORT || 465);
    const secureEnv = process.env.SMTP_SECURE;
    const secure = secureEnv === undefined || secureEnv === ''
      ? port === 465
      : String(secureEnv) !== '0';
    result = await smtpSend({
      host,
      port,
      secure,
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      from,
      to,
      subject,
      body,
    });
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    message_id: result.message_id,
    provider_id: result.message_id,
    mode: result.mode,
    to,
    from,
    subject,
  })}\n`);
};

main().catch((err) => {
  process.stderr.write(`Error: ${err?.message || err}\n`);
  process.exit(1);
});
