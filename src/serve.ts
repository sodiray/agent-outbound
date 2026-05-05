import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import {
  aiUsageCommand,
  configAuthorCommand,
  configDiffCommand,
  configReadCommand,
  configUpdateCommand,
  configValidateCommand,
  crmSyncCommand,
  dashboardCommand,
  describeCommand,
  draftsApproveCommand,
  draftsEditCommand,
  draftsListCommand,
  draftsRejectCommand,
  draftsShowCommand,
  enrichCommand,
  exportCommand,
  followupSendCommand,
  launchDraftCommand,
  launchSendCommand,
  listCreateCommand,
  listInfoCommand,
  listsCommand,
  logCommand,
  modelsAddCommand,
  modelsListCommand,
  modelsRefreshCommand,
  modelsRemoveCommand,
  pipelineShowCommand,
  queryCommand,
  refreshToolsCommand,
  reconcileCommand,
  recordRevertScoreCommand,
  recordRevertSequenceCommand,
  recordRevertStepCommand,
  recordShowCommand,
  removeCommand,
  repliesShowCommand,
  routeShowCommand,
  runCommand,
  schemaCommand,
  suppressCommand,
  forgetCommand,
  scoreCommand,
  sequenceRunCommand,
  sequenceStatusCommand,
  sourceCommand,
  sourceMoreCommand,
  snapshotCreateCommand,
  snapshotDeleteCommand,
  snapshotListCommand,
  snapshotRestoreCommand,
  templatesCreateCommand,
  templatesListCommand,
  templatesShowCommand,
  templatesUpdateCommand,
  usageCommand,
  visitsTodayCommand,
  viewsSaveCommand,
  routePlanCommand,
} from './commands/index.js';
import { ensureListDirs, getServePidPath, getServePortPath, resolveListDir } from './orchestrator/runtime/paths.js';
import { getSocketPath } from './orchestrator/runtime/activity.js';
import { openGlobalSuppressionDb, openListDb } from './orchestrator/runtime/db.js';
import { closeMcpClient, getMcpClient } from './orchestrator/runtime/mcp.js';
import { startPollingScheduler, type PollingSchedulerHandle } from './orchestrator/runtime/polling.js';
import { readConfig } from './orchestrator/lib/config.js';
import { failureEnvelope, successEnvelope, toStructuredError } from './orchestrator/runtime/contract.js';
import { claimIdempotency, completeIdempotency, failIdempotency, getIdempotencyRecord } from './orchestrator/runtime/idempotency.js';

const app = new Hono();
let activeListDir = '';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const ACTIONS: Record<string, any> = {
  describe: describeCommand,
  query: queryCommand,
  schema: schemaCommand,
  export: exportCommand,
  views_save: viewsSaveCommand,
  record_show: recordShowCommand,
  pipeline_show: pipelineShowCommand,
  route_show: routeShowCommand,
  replies_show: repliesShowCommand,
  ai_usage: aiUsageCommand,
  usage: usageCommand,
  list_create: listCreateCommand,
  list_info: listInfoCommand,
  lists: listsCommand,
  models_list: modelsListCommand,
  models_add: modelsAddCommand,
  models_remove: modelsRemoveCommand,
  models_refresh: modelsRefreshCommand,
  config_read: configReadCommand,
  config_update: configUpdateCommand,
  config_validate: configValidateCommand,
  config_diff: configDiffCommand,
  config_author: configAuthorCommand,
  refresh_tools: refreshToolsCommand,
  source: sourceCommand,
  source_more: sourceMoreCommand,
  remove: removeCommand,
  enrich: enrichCommand,
  score: scoreCommand,
  run: runCommand,
  sequence_run: sequenceRunCommand,
  sequence_status: sequenceStatusCommand,
  launch_draft: launchDraftCommand,
  launch_send: launchSendCommand,
  followup_send: followupSendCommand,
  log: logCommand,
  dashboard: dashboardCommand,
  visits_today: visitsTodayCommand,
  route_plan: routePlanCommand,
  drafts_list: draftsListCommand,
  drafts_show: draftsShowCommand,
  drafts_approve: draftsApproveCommand,
  drafts_reject: draftsRejectCommand,
  drafts_edit: draftsEditCommand,
  templates_list: templatesListCommand,
  templates_show: templatesShowCommand,
  templates_create: templatesCreateCommand,
  templates_update: templatesUpdateCommand,
  snapshot_create: snapshotCreateCommand,
  snapshot_list: snapshotListCommand,
  snapshot_restore: snapshotRestoreCommand,
  snapshot_delete: snapshotDeleteCommand,
  record_revert: recordRevertStepCommand,
  record_revert_score: recordRevertScoreCommand,
  record_revert_sequence: recordRevertSequenceCommand,
  crm_sync: crmSyncCommand,
  reconcile: reconcileCommand,
  suppress: suppressCommand,
  forget: forgetCommand,
};

const MUTATING_ACTIONS = new Set([
  'list_create',
  'models_add',
  'models_remove',
  'models_refresh',
  'config_update',
  'config_author',
  'refresh_tools',
  'source',
  'source_more',
  'remove',
  'enrich',
  'score',
  'run',
  'sequence_run',
  'launch_draft',
  'launch_send',
  'followup_send',
  'log',
  'route_plan',
  'drafts_approve',
  'drafts_reject',
  'drafts_edit',
  'templates_create',
  'templates_update',
  'snapshot_create',
  'snapshot_restore',
  'snapshot_delete',
  'record_revert',
  'record_revert_score',
  'record_revert_sequence',
  'crm_sync',
  'reconcile',
  'suppress',
  'forget',
]);

const nowIso = () => new Date().toISOString();

app.get('/health', (c) => c.json({ status: 'ok', started_at: nowIso() }));
app.get('/v1/health', (c) => c.json({ status: 'ok', started_at: nowIso() }));

const handleAction = async (c: any) => {
  const action = String(c.req.param('action') || '').trim();
  const fn = ACTIONS[action];
  let payload: any = {};
  if (!fn) {
    return c.json(failureEnvelope({
      command: action || 'unknown',
      error: {
        code: 'NOT_FOUND',
        message: `Unknown action: ${action}`,
        retryable: false,
        hint: 'Call describe to list available commands.',
        fields: { available: Object.keys(ACTIONS) },
      },
    }), 404);
  }

  try {
    payload = await c.req.json().catch(() => ({}));
    const idemKey = String(payload?.idem_key || '').trim();
    const hasList = String(payload?.list || '').trim();
    const mutating = MUTATING_ACTIONS.has(action);
    let idemScope = '';
    let idemDb: any = null;

    if (mutating && idemKey && hasList) {
      const listDir = resolveListDir(hasList);
      idemScope = `command:${action}`;
      idemDb = openListDb({ listDir, readonly: false });
      const existing = getIdempotencyRecord({ db: idemDb, idemKey, scope: idemScope });
      if (existing?.status === 'sent') {
        let prior: any = {};
        try { prior = JSON.parse(String(existing?.payload_json || '{}')); } catch { prior = {}; }
        if (idemDb) idemDb.close();
        return c.json(successEnvelope({
          command: action,
          list: hasList,
          result: prior?.result ?? {},
          idemKey,
          alreadyDone: true,
        }));
      }
      if (existing?.status === 'pending') {
        if (idemDb) idemDb.close();
        return c.json(failureEnvelope({
          command: action,
          list: hasList,
          error: {
            code: 'IDEMPOTENCY_KEY_CONFLICT',
            message: `Idempotency key is already pending for ${action}.`,
            retryable: true,
            hint: 'Retry later or use a new --idem-key.',
            fields: { idem_key: idemKey, action },
          },
        }), 409);
      }
      claimIdempotency({
        db: idemDb,
        idemKey,
        scope: idemScope,
        payload: { action, requested_at: nowIso() },
      });
    }

    const result = await fn(payload || {});
    if (idemDb && idemKey) {
      completeIdempotency({
        db: idemDb,
        idemKey,
        scope: idemScope,
        payload: { result, action, completed_at: nowIso() },
      });
      idemDb.close();
    }
    return c.json(successEnvelope({
      command: action,
      list: String((payload || {}).list || ''),
      result,
      idemKey: String(payload?.idem_key || ''),
    }));
  } catch (error) {
    try {
      const idemKey = String(payload?.idem_key || '').trim();
      const hasList = String(payload?.list || '').trim();
      if (MUTATING_ACTIONS.has(action) && idemKey && hasList) {
        const listDir = resolveListDir(hasList);
        const scope = `command:${action}`;
        const idemDb = openListDb({ listDir, readonly: false });
        failIdempotency({
          db: idemDb,
          idemKey,
          scope,
          payload: { action, error: String((error as any)?.message || error), failed_at: nowIso() },
        });
        idemDb.close();
      }
    } catch {
      // ignore idempotency cleanup failures
    }
    return c.json(failureEnvelope({
      command: action,
      list: String((payload || {}).list || ''),
      error: toStructuredError(error),
    }), 500);
  }
};
app.post('/actions/:action', handleAction);
app.post('/v1/actions/:action', handleAction);

app.get('/v1/activity', async (c) => {
  const list = String(c.req.query('list') || activeListDir || '').trim();
  if (!list) return c.json({ ok: false, error: 'Missing list.' }, 400);
  const listDir = resolveListDir(list);
  const socketPath = getSocketPath(listDir);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const socket = createConnection(socketPath);
      let buffer = '';

      const cleanup = () => {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      };

      socket.setEncoding('utf8');
      socket.on('connect', () => controller.enqueue(encoder.encode(`event: ready\ndata: {"list":"${listDir}"}\n\n`)));
      socket.on('data', (chunk) => {
        buffer += String(chunk || '');
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf('\n');
          if (!line) continue;
          controller.enqueue(encoder.encode(`data: ${line}\n\n`));
        }
      });
      socket.on('error', () => {
        controller.enqueue(encoder.encode('event: error\ndata: {"message":"activity socket unavailable"}\n\n'));
        controller.close();
        cleanup();
      });
      socket.on('close', () => {
        controller.close();
        cleanup();
      });
      c.req.raw.signal.addEventListener('abort', () => {
        try {
          controller.close();
        } catch {
          // ignore
        }
        cleanup();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
});

const wsAccept = (key: string) =>
  createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');

const wsTextFrame = (text: string) => {
  const payload = Buffer.from(String(text || ''), 'utf8');
  const len = payload.length;
  if (len < 126) {
    const header = Buffer.from([0x81, len]);
    return Buffer.concat([header, payload]);
  }
  if (len < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([header, payload]);
};

const wsPongFrame = (payload: Buffer) => {
  const len = payload.length;
  if (len < 126) return Buffer.concat([Buffer.from([0x8a, len]), payload]);
  if (len < 65536) {
    const h = Buffer.alloc(4);
    h[0] = 0x8a;
    h[1] = 126;
    h.writeUInt16BE(len, 2);
    return Buffer.concat([h, payload]);
  }
  return Buffer.from([0x8a, 0x00]);
};

const parseWsFrames = (buffer: Buffer) => {
  const out: Array<{ opcode: number; payload: Buffer }> = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let headerLen = 2;
    if (len === 126) {
      if (offset + 4 > buffer.length) break;
      len = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (len === 127) {
      if (offset + 10 > buffer.length) break;
      const big = Number(buffer.readBigUInt64BE(offset + 2));
      len = Number.isFinite(big) ? big : 0;
      headerLen = 10;
    }

    const maskLen = masked ? 4 : 0;
    const total = headerLen + maskLen + len;
    if (offset + total > buffer.length) break;
    let payload = buffer.subarray(offset + headerLen + maskLen, offset + total);
    if (masked) {
      const mask = buffer.subarray(offset + headerLen, offset + headerLen + 4);
      payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
    }
    out.push({ opcode, payload });
    offset += total;
  }
  return { frames: out, rest: buffer.subarray(offset) };
};

export const startServeMode = ({ list = '.', port = 49391 } = {}) => {
  const listDir = resolveListDir(list);
  activeListDir = listDir;
  ensureListDirs(listDir);

  const pidPath = getServePidPath(listDir);
  const portPath = getServePortPath(listDir);
  writeFileSync(pidPath, `${process.pid}\n`);
  writeFileSync(portPath, `${port}\n`);

  const server = serve({ fetch: app.fetch, port: Number(port) });
  server.on('upgrade', (req: any, socket: any) => {
    try {
      const host = String(req?.headers?.host || '127.0.0.1');
      const url = new URL(String(req?.url || '/'), `http://${host}`);
      if (url.pathname !== '/v1/activity') return socket.destroy();
      const key = String(req?.headers?.['sec-websocket-key'] || '');
      if (!key) return socket.destroy();

      const listParam = String(url.searchParams.get('list') || activeListDir || '').trim();
      if (!listParam) return socket.destroy();
      const listDirForWs = resolveListDir(listParam);

      const accept = wsAccept(key);
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );

      const activitySocket = createConnection(getSocketPath(listDirForWs));
      let activityBuffer = '';
      activitySocket.setEncoding('utf8');
      activitySocket.on('data', (chunk) => {
        activityBuffer += String(chunk || '');
        let idx = activityBuffer.indexOf('\n');
        while (idx >= 0) {
          const line = activityBuffer.slice(0, idx).trim();
          activityBuffer = activityBuffer.slice(idx + 1);
          idx = activityBuffer.indexOf('\n');
          if (!line) continue;
          socket.write(wsTextFrame(line));
        }
      });
      activitySocket.on('error', () => {
        try {
          socket.end();
        } catch {
          // ignore
        }
      });
      socket.on('close', () => {
        try {
          activitySocket.destroy();
        } catch {
          // ignore
        }
      });
      socket.on('error', () => {
        try {
          activitySocket.destroy();
        } catch {
          // ignore
        }
      });

      let incoming = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        incoming = Buffer.concat([incoming, chunk]);
        const parsed = parseWsFrames(incoming);
        incoming = parsed.rest as any;
        for (const frame of parsed.frames) {
          if (frame.opcode === 0x8) {
            try {
              socket.end();
            } catch {
              // ignore
            }
          } else if (frame.opcode === 0x9) {
            socket.write(wsPongFrame(frame.payload));
          }
        }
      });
    } catch {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
  });

  let pollingHandle: PollingSchedulerHandle | null = null;
  let pollingDb: any = null;
  let pollingGlobalDb: any = null;

  (async () => {
    try {
      const { config } = readConfig(listDir);
      const mcp = await getMcpClient();
      pollingDb = openListDb({ listDir, readonly: false });
      pollingGlobalDb = openGlobalSuppressionDb({ readonly: false });
      pollingHandle = startPollingScheduler({
        mcp,
        listDir,
        db: pollingDb,
        globalSuppressionDb: pollingGlobalDb,
        config,
      });
    } catch (error) {
      process.stderr.write(`Polling scheduler failed to start: ${String((error as any)?.message || error)}\n`);
    }
  })();

  const shutdown = async () => {
    try {
      if (pollingHandle) await pollingHandle.stop();
    } catch {
      // ignore
    }
    try {
      pollingDb?.close();
    } catch {
      // ignore
    }
    try {
      pollingGlobalDb?.close();
    } catch {
      // ignore
    }
    try {
      await closeMcpClient();
    } catch {
      // ignore
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', shutdown);

  return server;
};
