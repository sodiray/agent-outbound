import { createConnection } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { resolveListDir } from './lib.js';
import { getActivityLogPath, getSocketPath } from './orchestrator/lib/activity.js';

const RETRY_MS = 2000;
const DEFAULT_HISTORY_LINES = 50;

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
};

const supportsColor = Boolean(process.stdout.isTTY);
const color = (value, style) =>
  (supportsColor && ANSI[style] ? `${ANSI[style]}${value}${ANSI.reset}` : value);

const formatTime = (timestamp) => {
  const text = String(timestamp || '');
  if (text.length >= 19 && text.includes('T')) {
    return text.slice(11, 19);
  }
  return '';
};

const tryParseLine = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const summarizeEventDetails = (event) => {
  const parts = [];
  if (event.step) parts.push(String(event.step));
  if (event.row) parts.push(String(event.row));
  if (event.progress) parts.push(String(event.progress));
  if (event.detail) parts.push(String(event.detail));
  if (event.rows != null && event.event === 'step_start') parts.push(`${event.rows} rows`);
  if (event.processed != null && event.event === 'step_complete') parts.push(`processed=${event.processed}`);
  if (event.failed != null && event.event === 'step_complete') parts.push(`failed=${event.failed}`);
  return parts.join(' | ');
};

const formatStructuredEvent = (event) => {
  const time = formatTime(event.ts);
  const phase = String(event.phase || '').trim();
  const name = String(event.event || '').trim();
  const detail = summarizeEventDetails(event);

  if (name === 'phase_start') {
    return `${color(`[${time}]`, 'dim')} ${color(`${phase} started`, 'bold')}${detail ? ` -- ${detail}` : ''}`;
  }
  if (name === 'phase_complete') {
    return `${color(`[${time}]`, 'dim')} ${color(`${phase} complete`, 'bold')}${detail ? ` -- ${detail}` : ''}`;
  }
  if (name === 'step_start') {
    return `${color(`[${time}]`, 'dim')} ${phase}: ${color('start', 'bold')}${detail ? ` -- ${detail}` : ''}`;
  }
  if (name === 'step_complete') {
    return `${color(`[${time}]`, 'dim')} ${phase}: ${color('complete', 'bold')}${detail ? ` -- ${detail}` : ''}`;
  }
  if (name === 'row_complete') {
    return `${color(`[${time}]`, 'dim')} ${phase}: ${detail || 'row complete'}`;
  }
  if (name === 'error') {
    return `${color(`[${time}]`, 'dim')} ${color(`${phase} error`, 'red')}${detail ? ` -- ${detail}` : ''}`;
  }
  if (name === 'claude_start') {
    const model = String(event.model || '').trim();
    return `${color(`[${time}]`, 'dim')} ${phase ? `${phase}: ` : ''}calling claude${model ? ` (${model})` : ''}`;
  }
  if (name === 'claude_complete') {
    const exitCode = event.exit_code != null ? `exit=${event.exit_code}` : '';
    const timedOut = event.timed_out ? 'timeout' : '';
    const extra = [exitCode, timedOut].filter(Boolean).join(', ');
    const stderrTail = event.stderr_tail ? `\n    ${color(event.stderr_tail, 'red')}` : '';
    return `${color(`[${time}]`, 'dim')} claude complete${extra ? ` (${extra})` : ''}${stderrTail}`;
  }
  if (name === 'log_outcome') {
    const prospect = String(event.prospect || '').trim();
    const action = String(event.action || '').trim();
    const transition = String(event.transition || '').trim();
    const parts = [prospect, action, transition].filter(Boolean).join(' | ');
    return `${color(`[${time}]`, 'dim')} ${phase}: ${color('outcome logged', 'bold')}${parts ? ` -- ${parts}` : ''}`;
  }

  return `${color(`[${time}]`, 'dim')} ${name}${detail ? ` -- ${detail}` : ''}`;
};

const formatLiveChunk = (event) => {
  const isStdErr = event.event === 'claude_stderr';
  const payload = String(event.data || '');
  const lines = payload.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) return '';
  return lines
    .map((line) => {
      const rendered = `  ${line}`;
      return isStdErr ? color(rendered, 'red') : color(rendered, 'dim');
    })
    .join('\n');
};

const readHistory = ({ listDir, showAll }) => {
  const filePath = getActivityLogPath(listDir);
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const selected = showAll ? lines : lines.slice(-DEFAULT_HISTORY_LINES);
  return selected
    .map((line) => tryParseLine(line))
    .filter(Boolean)
    .filter((event) => event.event !== 'claude_chunk' && event.event !== 'claude_stderr');
};

const renderHistory = (events) => {
  console.log('=== recent activity ===');
  if (events.length === 0) {
    console.log('(none)');
  } else {
    for (const event of events) {
      console.log(formatStructuredEvent(event));
    }
  }
  console.log('');
  console.log('=== live ===');
};

export const runWatch = async ({ listPath = '.', showAllHistory = false } = {}) => {
  const listDir = resolveListDir(listPath || '.');
  if (!existsSync(listDir)) {
    console.error(`Error: list directory does not exist: ${listDir}`);
    console.error('Create the list first with: npx agent-outbound init, then use the MCP to create a list.');
    process.exit(1);
  }
  const history = readHistory({ listDir, showAll: showAllHistory });
  renderHistory(history);

  let activeSocket = null;
  let reconnectTimer = null;
  let stopped = false;
  let waitingPrinted = false;

  const stop = () => {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (activeSocket) {
      try {
        activeSocket.destroy();
      } catch {
        // noop
      }
      activeSocket = null;
    }
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, RETRY_MS);
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
      console.log(color(`[watch] connected to ${listDir}`, 'dim'));
    });

    socket.on('data', (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
        if (!line.trim()) continue;
        const event = tryParseLine(line);
        if (!event) continue;
        if (event.event === 'claude_chunk' || event.event === 'claude_stderr') {
          const rendered = formatLiveChunk(event);
          if (rendered) console.log(rendered);
          continue;
        }
        console.log(formatStructuredEvent(event));
      }
    });

    socket.on('error', (error) => {
      const code = String(error?.code || '');
      if ((code === 'ENOENT' || code === 'ECONNREFUSED') && !waitingPrinted) {
        waitingPrinted = true;
        console.log(color('waiting for activity...', 'dim'));
      }
    });

    socket.on('close', () => {
      if (stopped) return;
      scheduleReconnect();
    });
  };

  await new Promise((resolve) => {
    const onSignal = () => {
      stop();
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    void connect();
  });
};
