import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, createConnection } from 'node:net';
import { basename, join } from 'node:path';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

const INTERNAL_DIR_NAME = '.outbound';
const ACTIVITY_FILE_NAME = 'activity.ndjson';
const SOCKET_FILE_NAME = 'watch.sock';
const RING_MAX_LINES = 200;
const RING_TRIM_TO = 150;
const RING_TRIM_CHECK_EVERY = 50;

const activityContextStore = new AsyncLocalStorage();
const socketEntries = new Map();
const ringState = new Map();

const asString = (value) => String(value ?? '');
const nowIso = () => new Date().toISOString();
const getInternalDir = (listDir) => join(asString(listDir), INTERNAL_DIR_NAME);
const ensureInternalDir = (listDir) => {
  mkdirSync(getInternalDir(listDir), { recursive: true });
};

export const getActivityLogPath = (listDir) =>
  join(getInternalDir(listDir), ACTIVITY_FILE_NAME);

export const getSocketPath = (listDir) =>
  join(getInternalDir(listDir), SOCKET_FILE_NAME);

export const withActivityContext = (context, fn) => {
  const listDir = asString(context?.listDir || '').trim();
  if (!listDir) {
    return Promise.resolve().then(fn);
  }
  const listName = asString(context?.listName || basename(listDir)).trim();
  return activityContextStore.run({ listDir, listName }, fn);
};

const buildPayload = (event, context) => ({
  ts: nowIso(),
  list: asString(context?.listName || basename(context?.listDir || '')).trim(),
  ...event,
});

const appendRingLine = (listDir, line) => {
  try {
    ensureInternalDir(listDir);
    const filePath = getActivityLogPath(listDir);
    appendFileSync(filePath, `${line}\n`);

    const previous = Number(ringState.get(listDir) || 0);
    const next = previous + 1;
    if (next < RING_TRIM_CHECK_EVERY) {
      ringState.set(listDir, next);
      return;
    }
    ringState.set(listDir, 0);

    if (!existsSync(filePath)) return;
    const text = readFileSync(filePath, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    if (lines.length <= RING_MAX_LINES) return;
    const trimmed = lines.slice(-RING_TRIM_TO);
    writeFileSync(filePath, `${trimmed.join('\n')}\n`);
  } catch {
    // Activity logging should never break orchestration.
  }
};

const EARLY_QUEUE_LIMIT = 200;

const broadcastLine = (listDir, line) => {
  const entry = socketEntries.get(listDir);
  if (!entry) return;
  if (!entry.ready) {
    if (!entry.earlyQueue) entry.earlyQueue = [];
    if (entry.earlyQueue.length < EARLY_QUEUE_LIMIT) {
      entry.earlyQueue.push(line);
    }
    return;
  }
  for (const client of entry.clients) {
    if (!client || client.destroyed) continue;
    try {
      client.write(`${line}\n`);
    } catch {
      try {
        client.destroy();
      } catch {
        // noop
      }
    }
  }
};

const isSocketPathActive = (socketPath) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const client = createConnection(socketPath);
    const timer = setTimeout(() => {
      try {
        client.destroy();
      } catch {
        // noop
      }
      done(true);
    }, 250);

    client.once('connect', () => {
      clearTimeout(timer);
      try {
        client.end();
      } catch {
        // noop
      }
      done(true);
    });
    client.once('error', (error) => {
      clearTimeout(timer);
      const code = asString(error?.code || '').trim();
      if (code === 'ECONNREFUSED' || code === 'ENOENT') {
        done(false);
        return;
      }
      done(true);
    });
  });

const ensureSocketServer = (listDir) => {
  const existing = socketEntries.get(listDir);
  if (existing) {
    if (!existing.ready && !existing.starting && typeof existing.start === 'function') {
      void existing.start();
    }
    return;
  }

  ensureInternalDir(listDir);
  const socketPath = getSocketPath(listDir);
  const clients = new Set();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on('close', () => {
      clients.delete(socket);
    });
    socket.on('error', () => {
      clients.delete(socket);
      try {
        socket.destroy();
      } catch {
        // noop
      }
    });
  });

  const entry = {
    socketPath,
    server,
    clients,
    ready: false,
    starting: false,
    start: null,
    earlyQueue: [],
  };
  socketEntries.set(listDir, entry);

  const startListening = async () => {
    if (entry.starting || entry.ready) return;
    entry.starting = true;
    try {
      // Always remove existing socket file — the MCP server is the authoritative
      // socket owner. Watch clients reconnect automatically when the socket is replaced.
      if (existsSync(socketPath)) {
        try {
          unlinkSync(socketPath);
        } catch {
          // noop
        }
      }

      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(socketPath);
      });
      entry.ready = true;
      if (entry.earlyQueue?.length) {
        for (const queued of entry.earlyQueue) {
          broadcastLine(listDir, queued);
        }
        entry.earlyQueue = null;
      }
    } catch {
      entry.ready = false;
      for (const client of entry.clients) {
        try {
          client.destroy();
        } catch {
          // noop
        }
      }
      try {
        entry.server.close();
      } catch {
        // noop
      }
      socketEntries.delete(listDir);
    } finally {
      entry.starting = false;
    }
  };

  entry.start = startListening;
  void startListening();
};

export const emitActivity = (event) => {
  const context = activityContextStore.getStore();
  if (!context?.listDir) return;
  const payload = buildPayload(event, context);
  let line = '';
  try {
    line = JSON.stringify(payload);
  } catch {
    return;
  }

  appendRingLine(context.listDir, line);
  ensureSocketServer(context.listDir);
  broadcastLine(context.listDir, line);
};

export const emitLive = (event) => {
  const context = activityContextStore.getStore();
  if (!context?.listDir) return;
  const payload = buildPayload(event, context);
  let line = '';
  try {
    line = JSON.stringify(payload);
  } catch {
    return;
  }

  ensureSocketServer(context.listDir);
  broadcastLine(context.listDir, line);
};

export const cleanupSockets = () => {
  for (const [listDir, entry] of socketEntries.entries()) {
    for (const client of entry.clients) {
      try {
        client.destroy();
      } catch {
        // noop
      }
    }
    try {
      entry.server.close();
    } catch {
      // noop
    }
    try {
      if (existsSync(entry.socketPath)) unlinkSync(entry.socketPath);
    } catch {
      // noop
    }
    socketEntries.delete(listDir);
  }
};
