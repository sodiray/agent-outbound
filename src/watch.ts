import { createConnection } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { resolveListDir } from './orchestrator/runtime/paths.js';
import { getActivityLogPath, getSocketPath } from './orchestrator/runtime/activity.js';

const RETRY_MS = 2000;
const DEFAULT_HISTORY_LINES = 50;

const isTTY = Boolean(process.stdout.isTTY);
const A = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};
type ActivityEvent = Record<string, unknown> & {
  event?: string;
  ts?: string;
  type?: string;
};

const c = (text: string, style: keyof typeof A) => (isTTY && A[style] ? `${A[style]}${text}${A.reset}` : text);

const ts = (isoString: unknown) => {
  const s = String(isoString || '');
  return s.length >= 19 && s.includes('T') ? s.slice(11, 19) : '';
};

const tryParse = (line: string): ActivityEvent | null => {
  try { return JSON.parse(line); } catch { return null; }
};

const truncate = (text: unknown, max = 200) => {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}...` : s;
};

// ── Renderer ─────────────────────────────────────────────────────────────────

const render = (event: ActivityEvent | null) => {
  if (!event || typeof event !== 'object') return;
  const name = String(event.event || '');
  const time = ts(event.ts);
  const prefix = time ? c(`[${time}]`, 'dim') : '';

  // ── Orchestrator events ──

  if (name === 'phase_start' || name === 'phase_complete') {
    const phase = String(event.phase || '');
    const label = name === 'phase_start' ? 'started' : 'complete';
    const parts = [];
    if (event.steps != null) parts.push(`${event.steps} steps`);
    if (event.rows != null) parts.push(`${event.rows} rows`);
    if (event.processed != null) parts.push(`processed=${event.processed}`);
    if (event.failed != null) parts.push(`failed=${event.failed}`);
    if (event.skipped != null) parts.push(`skipped=${event.skipped}`);
    const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    console.log(`${prefix} ${c(`${phase} ${label}`, 'bold')}${detail}`);
    return;
  }

  if (name === 'step_start' || name === 'step_complete') {
    const phase = String(event.phase || '');
    const step = String(event.step || '');
    const label = name === 'step_start' ? 'start' : 'done';
    const parts = [];
    if (event.rows != null) parts.push(`${event.rows} rows`);
    if (event.skipped != null) parts.push(`${event.skipped} skipped`);
    if (event.processed != null) parts.push(`processed=${event.processed}`);
    if (event.failed != null) parts.push(`failed=${event.failed}`);
    const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    console.log(`${prefix} ${phase}: ${c(step, 'cyan')} ${label}${detail}`);
    return;
  }

  if (name === 'row_complete') {
    const row = String(event.row || event.row_label || '');
    const step = String(event.step || '');
    console.log(`${prefix}   ${c('✓', 'green')} ${row}${step ? ` (${step})` : ''}`);
    return;
  }

  if (name === 'error') {
    const msg = String(event.error || event.message || event.detail || '');
    console.log(`${prefix} ${c('ERROR', 'red')} ${msg}`);
    return;
  }

  if (name === 'log_outcome') {
    const prospect = String(event.prospect || '');
    const action = String(event.action || '');
    console.log(`${prefix} ${c('outcome', 'magenta')} ${prospect} → ${action}`);
    return;
  }

  if (name === 'llm_step_finish') {
    const phase = String(event.phase || '');
    const model = String(event.model || '');
    const toolCalls = Array.isArray(event.tool_calls) ? event.tool_calls.map((item) => String(item || '')).filter(Boolean) : [];
    const usage = event.usage && typeof event.usage === 'object' ? event.usage as Record<string, unknown> : {};
    const tokens = Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0);
    const toolsText = toolCalls.length > 0 ? ` tools=${toolCalls.join(',')}` : '';
    const tokenText = tokens > 0 ? ` tokens=${tokens}` : '';
    console.log(`${prefix} ${c('llm step', 'yellow')} ${phase} model=${model}${toolsText}${tokenText}`);
    return;
  }

  if (name === 'llm_step_complete') {
    const phase = String(event.phase || '');
    const model = String(event.model || '');
    console.log(`${prefix} ${c('llm complete', 'green')} ${phase} model=${model}`);
    return;
  }

  if (name === 'llm_step_error') {
    const phase = String(event.phase || '');
    const model = String(event.model || '');
    const error = truncate(event.error || event.message || '', 300);
    console.log(`${prefix} ${c('llm error', 'red')} ${phase} model=${model} ${error}`);
    return;
  }

  // Fallback: print event name
  console.log(`${prefix} ${c(name, 'dim')}`);
};

// ── History + Live ───────────────────────────────────────────────────────────

const readHistory = ({ listDir, showAll }: { listDir: string; showAll: boolean }) => {
  const filePath = getActivityLogPath(listDir);
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const selected = showAll ? lines : lines.slice(-DEFAULT_HISTORY_LINES);
  return selected.map((l) => tryParse(l)).filter(Boolean);
};

export const runWatch = async ({ listPath = '.', showAllHistory = false } = {}) => {
  const listDir = resolveListDir(listPath || '.');
  if (!existsSync(listDir)) {
    console.error(`Error: list directory does not exist: ${listDir}`);
    process.exit(1);
  }

  const history = readHistory({ listDir, showAll: showAllHistory });
  console.log(c('=== recent activity ===', 'bold'));
  if (history.length === 0) {
    console.log(c('(none)', 'dim'));
  } else {
    for (const event of history) {
      render(event);
    }
  }
  console.log('');
  console.log(c('=== live ===', 'bold'));

  let activeSocket: import('node:net').Socket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let waitingPrinted = false;

  const stop = () => {
    stopped = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (activeSocket) { try { activeSocket.destroy(); } catch { /* */ } activeSocket = null; }
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, RETRY_MS);
  };

  let buffer = '';
  const socketPath = getSocketPath(listDir);

  const connect = async () => {
    if (stopped) return;
    const socket = createConnection(socketPath);
    activeSocket = socket;
    socket.setEncoding('utf8');

    socket.on('connect', () => {
      waitingPrinted = false;
      console.error(c(`[watch] connected`, 'dim'));
    });

    socket.on('data', (chunk: string | Buffer) => {
      buffer += chunk;
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
        if (!line.trim()) continue;
        const event = tryParse(line);
        if (!event) continue;
        render(event);
      }
    });

    socket.on('error', (error: NodeJS.ErrnoException) => {
      const code = String(error?.code || '');
      if ((code === 'ENOENT' || code === 'ECONNREFUSED') && !waitingPrinted) {
        waitingPrinted = true;
        console.error(c('waiting for activity...', 'dim'));
      }
    });

    socket.on('close', () => { if (!stopped) scheduleReconnect(); });
  };

  await new Promise<void>((resolve) => {
    const onSignal = () => { stop(); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); resolve(); };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    void connect();
  });
};
