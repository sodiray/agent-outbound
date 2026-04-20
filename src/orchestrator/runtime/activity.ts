import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { getActivityHistoryPath, getActivitySocketPath, getListName, ensureListDirs } from './paths.js';
import { insertActivityEvent, openListDb } from './db.js';

type ActivityContext = {
  listDir: string;
  listName: string;
};

type ActivityEventInput = Record<string, unknown> & {
  id?: string;
  event?: string;
  phase?: string;
  row?: string;
  row_id?: string;
};

type ActivityPayload = Record<string, unknown> & {
  id: string;
  ts: string;
  list: string;
  event?: string;
  phase?: string;
  row?: string;
  row_id?: string;
};

type SocketEntry = {
  socketPath: string;
  server: ReturnType<typeof createServer>;
  clients: Set<import('node:net').Socket>;
  ready: boolean;
  starting: boolean;
  start: (() => Promise<void>) | null;
  earlyQueue: string[];
};

const activityContextStore = new AsyncLocalStorage<ActivityContext>();
const socketEntries = new Map<string, SocketEntry>();
const ringState = new Map<string, number>();

const RING_MAX_LINES = 500;
const RING_TRIM_TO = 400;
const RING_TRIM_CHECK_EVERY = 100;
const EARLY_QUEUE_LIMIT = 500;

const nowIso = () => new Date().toISOString();

const safeJson = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
};

export const withActivityContext = <T>(context: { listDir?: string; listName?: string }, fn: () => Promise<T> | T) => {
  const listDir = String(context?.listDir || '').trim();
  if (!listDir) return Promise.resolve().then(fn);
  const listName = String(context?.listName || getListName(listDir) || basename(listDir));
  return activityContextStore.run({ listDir, listName }, fn);
};

export const getActivityLogPath = (listDir: string) => getActivityHistoryPath(listDir);
export const getSocketPath = (listDir: string) => getActivitySocketPath(listDir);

const appendRingLine = (listDir: string, line: string) => {
  const filePath = getActivityHistoryPath(listDir);
  ensureListDirs(listDir);
  appendFileSync(filePath, `${line}\n`);

  const next = Number(ringState.get(listDir) || 0) + 1;
  if (next < RING_TRIM_CHECK_EVERY) {
    ringState.set(listDir, next);
    return;
  }
  ringState.set(listDir, 0);

  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  if (lines.length <= RING_MAX_LINES) return;
  writeFileSync(filePath, `${lines.slice(-RING_TRIM_TO).join('\n')}\n`);
};

const broadcastLine = (listDir: string, line: string) => {
  const entry = socketEntries.get(listDir);
  if (!entry) return;

  if (!entry.ready) {
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
        // ignore
      }
    }
  }
};

const isSocketPathActive = (socketPath: string) => new Promise<boolean>((resolve) => {
  let settled = false;
  const done = (value: boolean) => {
    if (settled) return;
    settled = true;
    resolve(value);
  };

  const conn = createConnection(socketPath);
  const timer = setTimeout(() => {
    try {
      conn.destroy();
    } catch {
      // ignore
    }
    done(true);
  }, 250);

  conn.once('connect', () => {
    clearTimeout(timer);
    try {
      conn.end();
    } catch {
      // ignore
    }
    done(true);
  });
  conn.once('error', (error: NodeJS.ErrnoException) => {
    clearTimeout(timer);
    const code = String(error?.code || '');
    if (code === 'ENOENT' || code === 'ECONNREFUSED') {
      done(false);
      return;
    }
    done(true);
  });
});

const ensureSocketServer = (listDir: string) => {
  const existing = socketEntries.get(listDir);
  if (existing) {
    if (!existing.ready && !existing.starting && typeof existing.start === 'function') {
      void existing.start();
    }
    return;
  }

  ensureListDirs(listDir);
  const socketPath = getActivitySocketPath(listDir);
  const clients = new Set<import('node:net').Socket>();

  const server = createServer((socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {
      clients.delete(socket);
      try {
        socket.destroy();
      } catch {
        // ignore
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
      if (existsSync(socketPath)) {
        const active = await isSocketPathActive(socketPath);
        if (!active) {
          try {
            unlinkSync(socketPath);
          } catch {
            // ignore
          }
        }
      }

      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
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
      if (entry.earlyQueue.length > 0) {
        for (const line of entry.earlyQueue) {
          broadcastLine(listDir, line);
        }
        entry.earlyQueue = [];
      }
    } catch {
      entry.ready = false;
      for (const client of clients) {
        try {
          client.destroy();
        } catch {
          // ignore
        }
      }
      try {
        server.close();
      } catch {
        // ignore
      }
      socketEntries.delete(listDir);
    } finally {
      entry.starting = false;
    }
  };

  entry.start = startListening;
  void startListening();
};

const toPayload = (event: ActivityEventInput, context: ActivityContext): ActivityPayload => ({
  id: String(event?.id || randomUUID()),
  ts: nowIso(),
  list: context?.listName || '',
  ...event,
});

const persistActivity = ({
  listDir,
  payload,
  writeDb = true,
  writeFile = true,
}: {
  listDir: string;
  payload: ActivityPayload;
  writeDb?: boolean;
  writeFile?: boolean;
}) => {
  const line = safeJson(payload);
  if (writeFile) appendRingLine(listDir, line);
  ensureSocketServer(listDir);
  broadcastLine(listDir, line);

  if (!writeDb) return;
  try {
    const db = openListDb({ listDir, readonly: false });
    try {
      insertActivityEvent({
        db,
        event: {
          id: payload.id,
          event: String(payload.event || ''),
          phase: String(payload.phase || ''),
          row_id: String(payload.row || payload.row_id || ''),
          payload,
          occurred_at: String(payload.ts || nowIso()),
        },
      });
    } finally {
      db.close();
    }
  } catch {
    // Activity should not break main flow.
  }
};

export const emitActivity = (event: ActivityEventInput) => {
  const context = activityContextStore.getStore();
  if (!context?.listDir) return;
  const payload = toPayload(event, context);
  persistActivity({ listDir: context.listDir, payload, writeDb: true, writeFile: true });
};

export const emitLive = (event: ActivityEventInput) => {
  const context = activityContextStore.getStore();
  if (!context?.listDir) return;
  const payload = toPayload(event, context);
  persistActivity({ listDir: context.listDir, payload, writeDb: false, writeFile: false });
};

export const cleanupSockets = () => {
  for (const [listDir, entry] of socketEntries.entries()) {
    for (const client of entry.clients) {
      try {
        client.destroy();
      } catch {
        // ignore
      }
    }
    try {
      entry.server.close();
    } catch {
      // ignore
    }
    try {
      if (existsSync(entry.socketPath)) unlinkSync(entry.socketPath);
    } catch {
      // ignore
    }
    socketEntries.delete(listDir);
    ringState.delete(listDir);
  }
};
