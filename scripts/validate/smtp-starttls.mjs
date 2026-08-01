#!/usr/bin/env node
/**
 * Proves the SHIPPED smtp-send STARTTLS dialog (RFC 3207):
 * after STARTTLS + TLS upgrade, expectGreeting must be false so the client
 * EHLO immediately and never re-waits for a 220 greeting.
 *
 * 1. Unit: drive exported smtpSession against a Duplex mock (no network/TLS).
 * 2. CLI: drive real smtp-send.mjs against a local STARTTLS TCP+TLS mock.
 * 3. Source guard: post-STARTTLS path sets expectGreeting: false.
 */
import { createServer as createNetServer } from 'node:net';
import { TLSSocket } from 'node:tls';
import { spawn, execSync } from 'node:child_process';
import { Duplex } from 'node:stream';
import {
  mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smtpSession } from '../smtp-send.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SMTP = join(ROOT, 'scripts/smtp-send.mjs');
const SCRATCH = process.env.GOAL_SCRATCH
  || '/var/folders/rh/cpfkb8bd3b79n9zcs5s7zk_c0000gn/T/grok-goal-0a1a977e5bad/implementer';
mkdirSync(SCRATCH, { recursive: true });

const results = { pass: 0, failures: [] };
const check = (name, fn) => {
  try {
    const why = fn();
    if (why) {
      results.failures.push([name, why]);
      console.log(`  FAIL  ${name}\n          ${why}`);
    } else {
      results.pass += 1;
      console.log(`  ok    ${name}`);
    }
  } catch (err) {
    results.failures.push([name, String(err?.message || err)]);
    console.log(`  FAIL  ${name}\n          ${String(err?.message || err).slice(0, 400)}`);
  }
};

/** Mock socket: records client writes; responds to SMTP commands. Never auto-greets. */
const makeMockSocket = () => {
  const clientLines = [];
  const state = { buffer: '', dataMode: false, destroyed: false };

  const socket = new Duplex({
    write(chunk, _enc, cb) {
      if (state.destroyed) return cb();
      state.buffer += chunk.toString('utf8');
      const consume = () => {
        const index = state.buffer.indexOf('\r\n');
        if (index < 0) return;
        const line = state.buffer.slice(0, index);
        state.buffer = state.buffer.slice(index + 2);
        if (state.dataMode) {
          if (line === '.') {
            state.dataMode = false;
            clientLines.push('.');
            queueMicrotask(() => {
              if (!state.destroyed) socket.push('250 OK queued\r\n');
            });
          }
          consume();
          return;
        }
        clientLines.push(line);
        const upper = line.toUpperCase();
        queueMicrotask(() => {
          if (state.destroyed) return;
          if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
            socket.push('250-mock.local\r\n250 AUTH PLAIN\r\n');
          } else if (upper.startsWith('AUTH')) {
            socket.push('235 Authentication successful\r\n');
          } else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) {
            socket.push('250 OK\r\n');
          } else if (upper === 'DATA') {
            state.dataMode = true;
            socket.push('354 End data\r\n');
          } else if (upper === 'QUIT') {
            socket.push('221 Bye\r\n');
            socket.push(null);
          } else {
            socket.push(`500 unknown ${line.slice(0, 40)}\r\n`);
          }
        });
        consume();
      };
      consume();
      cb();
    },
    read() { /* push-driven */ },
  });
  socket.destroy = () => {
    state.destroyed = true;
    try { Duplex.prototype.destroy.call(socket); } catch { /* */ }
  };
  return { socket, clientLines };
};

// --- 1. smtpSession expectGreeting:false (post-STARTTLS) ---
const postTls = makeMockSocket();
// Deliberately do NOT push a 220. If smtpSession waits for greeting, this hangs.
const postTlsPromise = smtpSession(postTls.socket, {
  user: 'u',
  pass: 'p',
  from: 'from@example.com',
  to: 'to@example.com',
  subject: 'hi',
  body: 'body',
  expectGreeting: false,
});
const postTlsResult = await Promise.race([
  postTlsPromise.then((r) => ({ ok: true, r, elapsed: 0 })),
  new Promise((resolve) => setTimeout(() => resolve({ ok: false, hang: true }), 2000)),
]);

// --- 2. smtpSession expectGreeting:true (implicit TLS / open) ---
const withGreet = makeMockSocket();
// Must push greeting first or client hangs — prove it waits then succeeds
queueMicrotask(() => withGreet.socket.push('220 mock.local ready\r\n'));
const greetResult = await smtpSession(withGreet.socket, {
  user: 'u',
  pass: 'p',
  from: 'from@example.com',
  to: 'to@example.com',
  subject: 'hi',
  body: 'body',
  expectGreeting: true,
});

// --- 3. Full CLI STARTTLS against local mock (TCP + TLSSocket upgrade) ---
const certDir = mkdtempSync(join(tmpdir(), 'ao-smtp-cert-'));
const keyPath = join(certDir, 'key.pem');
const certPath = join(certDir, 'cert.pem');
execSync(
  `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost" 2>/dev/null`,
  { stdio: 'pipe' },
);
const key = readFileSync(keyPath);
const cert = readFileSync(certPath);

const startStarttlsMock = () => new Promise((resolve) => {
  const state = {
    transcript: [],
    receivedMail: false,
    receivedData: false,
    postTlsEhlo: false,
  };

  const handleTls = (socket) => {
    const tlsState = { buffer: '', dataMode: false };
    socket.on('data', (chunk) => {
      tlsState.buffer += chunk.toString('utf8');
      const consume = () => {
        const index = tlsState.buffer.indexOf('\r\n');
        if (index < 0) return;
        const line = tlsState.buffer.slice(0, index);
        tlsState.buffer = tlsState.buffer.slice(index + 2);
        if (tlsState.dataMode) {
          if (line === '.') {
            tlsState.dataMode = false;
            state.receivedData = true;
            socket.write('250 OK queued\r\n');
          }
          consume();
          return;
        }
        state.transcript.push({ phase: 'tls', line });
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          state.postTlsEhlo = true;
          socket.write('250-mock\r\n250 AUTH PLAIN\r\n');
        } else if (upper.startsWith('AUTH')) {
          socket.write('235 ok\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          state.receivedMail = true;
          socket.write('250 OK\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          socket.write('250 OK\r\n');
        } else if (upper === 'DATA') {
          tlsState.dataMode = true;
          socket.write('354 go\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else if (
          line.startsWith('From:') || line.startsWith('To:') || line.startsWith('Subject:')
          || line.startsWith('Message-ID:') || line.startsWith('MIME-')
          || line.startsWith('Content-') || line === ''
        ) {
          // headers
        } else {
          socket.write('500 no\r\n');
        }
        consume();
      };
      consume();
    });
  };

  const server = createNetServer((plain) => {
    plain.write('220 mock.local ESMTP ready\r\n');
    const plainState = { buffer: '', upgrading: false };
    plain.on('data', (chunk) => {
      if (plainState.upgrading) return;
      plainState.buffer += chunk.toString('utf8');
      const consume = () => {
        const index = plainState.buffer.indexOf('\r\n');
        if (index < 0) return;
        const line = plainState.buffer.slice(0, index);
        plainState.buffer = plainState.buffer.slice(index + 2);
        state.transcript.push({ phase: 'plain', line });
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          plain.write('250-mock\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n');
        } else if (upper === 'STARTTLS') {
          plain.write('220 Ready to start TLS\r\n');
          plainState.upgrading = true;
          plain.removeAllListeners('data');
          // No second 220 after TLS (RFC 3207).
          const secure = new TLSSocket(plain, {
            isServer: true,
            key,
            cert,
            rejectUnauthorized: false,
          });
          secure.on('error', () => { /* */ });
          handleTls(secure);
          return;
        } else {
          plain.write('500 expected STARTTLS\r\n');
        }
        consume();
      };
      consume();
    });
  });

  server.listen(0, '127.0.0.1', () => {
    resolve({
      port: server.address().port,
      close: () => new Promise((r) => server.close(() => r())),
      stats: () => state,
    });
  });
});

const runCli = ({ command, args, env, timeoutMs }) => new Promise((resolve) => {
  const stdout = [];
  const stderr = [];
  const child = spawn(command, args, { env });
  const timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.once('error', (error) => {
    clearTimeout(timeout);
    resolve({
      status: null,
      signal: null,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      error: String(error?.message || error),
    });
  });
  child.once('close', (status, signal) => {
    clearTimeout(timeout);
    resolve({
      status,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      error: '',
    });
  });
});

const mock = await startStarttlsMock();
const started = Date.now();
const cli = await runCli({
  command: process.execPath,
  args: [
    SMTP, 'send',
    '--to', 'buyer@example.com',
    '--from', 'outbound@example.com',
    '--subject', 'STARTTLS probe',
    '--body', 'Hello',
    '--json',
  ],
  timeoutMs: 10000,
  env: {
    ...process.env,
    AO_SMTP_SINK: '0',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(mock.port),
    SMTP_SECURE: '0',
    SMTP_USER: 'user',
    SMTP_PASS: 'pass',
    SMTP_FROM: 'outbound@example.com',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    NODE_OPTIONS: '',
  },
});
const cliElapsed = Date.now() - started;
const cliStats = mock.stats();
await mock.close();

const src = readFileSync(SMTP, 'utf8');

const evidence = {
  postTlsSession: {
    completed: Boolean(postTlsResult.ok && !postTlsResult.hang),
    hang: Boolean(postTlsResult.hang),
    firstClientLine: postTls.clientLines[0] || null,
    clientLines: postTls.clientLines,
    result: postTlsResult.ok ? postTlsResult.r : null,
  },
  greetSession: {
    message_id: greetResult?.message_id,
    firstClientLine: withGreet.clientLines[0] || null,
    clientLines: withGreet.clientLines,
  },
  cliStarttls: {
    status: cli.status,
    signal: cli.signal,
    elapsedMs: cliElapsed,
    stdout: (cli.stdout || '').slice(0, 500),
    stderr: (cli.stderr || '').slice(0, 500),
    stats: cliStats,
  },
  source: {
    expectGreeting_false: /expectGreeting:\s*false/.test(src),
    rfc3207: /RFC 3207/.test(src),
  },
};
writeFileSync(join(SCRATCH, 'smtp-starttls.txt'), `${JSON.stringify(evidence, null, 2)}\n`);

check('post-STARTTLS smtpSession (expectGreeting:false) EHLO without waiting for 220', () => {
  if (postTlsResult.hang) {
    return 'hung 2s waiting for 220 — expectGreeting:false is broken';
  }
  if (!postTlsResult.ok) return 'session failed';
  if (postTls.clientLines[0] !== 'EHLO agent-outbound') {
    return `first line should be EHLO, got: ${JSON.stringify(postTls.clientLines)}`;
  }
  if (!postTlsResult.r?.message_id) return 'no message_id';
  return '';
});

check('implicit/open smtpSession (expectGreeting:true) still consumes 220 then EHLO', () => {
  if (withGreet.clientLines[0] !== 'EHLO agent-outbound') {
    return `first line: ${JSON.stringify(withGreet.clientLines)}`;
  }
  if (!greetResult?.message_id) return 'no message_id after greeting path';
  return '';
});

check('CLI smtp-send.mjs STARTTLS against mock completes without re-greeting hang', () => {
  if (cli.status !== 0) {
    return `exit=${cli.status} signal=${cli.signal} stderr=${(cli.stderr || '').slice(0, 300)} stdout=${(cli.stdout || '').slice(0, 200)}`;
  }
  const parsed = (() => {
    try {
      return JSON.parse((cli.stdout || '').trim().split('\n').filter(Boolean).pop());
    } catch {
      return null;
    }
  })();
  if (!parsed) {
    return `stdout not JSON: ${cli.stdout}`;
  }
  if (!parsed.ok || parsed.mode !== 'smtp') return `bad: ${JSON.stringify(parsed)}`;
  if (cliElapsed > 5000) return `too slow ${cliElapsed}ms — re-greeting hang?`;
  if (!cliStats.postTlsEhlo) {
    return `no post-TLS EHLO; transcript=${JSON.stringify(cliStats.transcript)}`;
  }
  if (!cliStats.receivedMail || !cliStats.receivedData) {
    return `incomplete: mail=${cliStats.receivedMail} data=${cliStats.receivedData}`;
  }
  return '';
});

check('smtp-send.mjs post-STARTTLS uses expectGreeting: false (RFC 3207)', () => {
  if (!/expectGreeting:\s*false/.test(src)) return 'missing expectGreeting: false';
  if (!/RFC 3207/.test(src)) return 'missing RFC 3207 note';
  // Ensure the non-secure branch returns with expectGreeting false
  const starttlsBlock = src.slice(src.indexOf('if (!secure)'));
  const sessionCall = starttlsBlock.slice(0, starttlsBlock.indexOf('return await smtpSession') + 200);
  if (!/expectGreeting:\s*false/.test(sessionCall)) {
    return 'STARTTLS branch does not pass expectGreeting: false to smtpSession';
  }
  return '';
});

try { rmSync(certDir, { recursive: true, force: true }); } catch { /* */ }

console.log(`\n${'='.repeat(60)}\npassed ${results.pass}   failed ${results.failures.length}`);
if (results.failures.length) {
  for (const [n, w] of results.failures) console.log(` - ${n}: ${w}`);
  process.exit(1);
}
process.exit(0);
