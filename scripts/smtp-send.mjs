#!/usr/bin/env node
/**
 * Deterministic SMTP send tool for Agent Outbound.
 *
 * Modes:
 *   1. Sink (default when SMTP_HOST unset or AO_SMTP_SINK=1): write the message
 *      to AO_SMTP_SINK_DIR (or .outbound/smtp-sink) and return a synthetic message_id.
 *   2. Real SMTP when SMTP_HOST + SMTP_USER + SMTP_PASS are set (Mailforge etc.).
 *
 * Usage (as MCP command tool):
 *   node scripts/smtp-send.mjs send --to ADDR --subject S --body B [--from ADDR] [--json]
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
`.trim();

const encode = (s) => Buffer.from(String(s || ''), 'utf8');

const b64 = (s) => Buffer.from(String(s || ''), 'utf8').toString('base64');

const crlf = (lines) => lines.join('\r\n') + '\r\n';

const readSmtpResponse = (socket) => new Promise((resolve, reject) => {
  let buf = '';
  const onData = (chunk) => {
    buf += chunk.toString('utf8');
    if (/\r\n$/.test(buf) && !/^\d{3}-/m.test(buf.split('\r\n').filter(Boolean).slice(-1)[0] || '')) {
      // complete if last line is not a continuation (###-)
      const lines = buf.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (/^\d{3} /.test(last) || /^\d{3}$/.test(last)) {
        socket.off('data', onData);
        resolve(buf);
      }
    }
  };
  socket.on('data', onData);
  socket.on('error', reject);
  setTimeout(() => reject(new Error('SMTP response timeout')), 30_000);
});

const sendLine = (socket, line) => {
  socket.write(line + '\r\n');
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
  const connect = () => new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host }, () => resolve(socket))
      : net.connect({ host, port }, () => resolve(socket));
    socket.on('error', reject);
  });

  const socket = await connect();
  const greet = await readSmtpResponse(socket);
  if (!/^220/.test(greet)) throw new Error(`SMTP greeting failed: ${greet.trim()}`);

  sendLine(socket, `EHLO agent-outbound`);
  await readSmtpResponse(socket);

  if (!secure && port === 587) {
    sendLine(socket, 'STARTTLS');
    const startTls = await readSmtpResponse(socket);
    if (!/^220/.test(startTls)) throw new Error(`STARTTLS failed: ${startTls.trim()}`);
    await new Promise((resolve, reject) => {
      const upgraded = tls.connect({ socket, servername: host }, () => {
        Object.assign(socket, upgraded);
        resolve(null);
      });
      upgraded.on('error', reject);
    });
    // After STARTTLS we need a fresh EHLO on the TLS socket — re-open simply for reliability.
  }

  // Prefer AUTH PLAIN over a fresh TLS connection for simplicity when secure or after STARTTLS.
  // For STARTTLS complexity, fall back to sink unless SMTP_FORCE=1.
  if (!secure && process.env.SMTP_FORCE !== '1') {
    socket.destroy();
    throw new Error('Non-TLS SMTP without SMTP_FORCE=1; use port 465 (SMTPS) or set AO_SMTP_SINK=1 for sink mode.');
  }

  sendLine(socket, 'AUTH PLAIN ' + b64(`\u0000${user}\u0000${pass}`));
  const auth = await readSmtpResponse(socket);
  if (!/^235/.test(auth)) throw new Error(`SMTP AUTH failed: ${auth.trim()}`);

  sendLine(socket, `MAIL FROM:<${from}>`);
  await readSmtpResponse(socket);
  sendLine(socket, `RCPT TO:<${to}>`);
  await readSmtpResponse(socket);
  sendLine(socket, 'DATA');
  await readSmtpResponse(socket);

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
  const dataResp = await readSmtpResponse(socket);
  if (!/^250/.test(dataResp)) throw new Error(`SMTP DATA failed: ${dataResp.trim()}`);
  sendLine(socket, 'QUIT');
  socket.end();
  return { message_id: messageId, mode: 'smtp' };
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
    result = await smtpSend({
      host,
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE || '1') !== '0',
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
