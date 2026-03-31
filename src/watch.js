import { createConnection } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { resolveListDir } from './lib.js';
import { getActivityLogPath, getSocketPath } from './orchestrator/lib/activity.js';

const RETRY_MS = 2000;
const DEFAULT_HISTORY_LINES = 50;

const isTTY = Boolean(process.stdout.isTTY);
const A = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};
const c = (text, style) => (isTTY && A[style] ? `${A[style]}${text}${A.reset}` : text);

const ts = (isoString) => {
  const s = String(isoString || '');
  return s.length >= 19 && s.includes('T') ? s.slice(11, 19) : '';
};

const tryParse = (line) => {
  try { return JSON.parse(line); } catch { return null; }
};

const truncate = (text, max = 200) => {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}...` : s;
};

// ── Renderer ─────────────────────────────────────────────────────────────────

const render = (event) => {
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
    const msg = String(event.error || event.message || '');
    console.log(`${prefix} ${c('ERROR', 'red')} ${msg}`);
    return;
  }

  if (name === 'log_outcome') {
    const prospect = String(event.prospect || '');
    const action = String(event.action || '');
    console.log(`${prefix} ${c('outcome', 'magenta')} ${prospect} → ${action}`);
    return;
  }

  // ── Claude lifecycle events ──

  if (name === 'claude_start') {
    const model = String(event.model || 'unknown');
    console.log(`${prefix} ${c(`▶ claude (${model})`, 'yellow')}`);
    const prompt = String(event.prompt || '');
    if (prompt) {
      // Show first 3 lines of prompt, truncated
      const lines = prompt.split('\n').slice(0, 3).map((l) => truncate(l.trim(), 120));
      for (const line of lines) {
        if (line) console.log(`${c('  │ ', 'dim')}${c(line, 'dim')}`);
      }
      if (prompt.split('\n').length > 3) {
        console.log(`${c('  │ ', 'dim')}${c(`... (${prompt.length} chars total)`, 'dim')}`);
      }
    }
    return;
  }

  if (name === 'claude_complete') {
    const model = String(event.model || '');
    const exit = event.exit_code != null ? event.exit_code : '?';
    const timedOut = event.timed_out ? ' TIMEOUT' : '';
    const style = exit === 0 ? 'green' : 'red';
    console.log(`${prefix} ${c(`■ claude done`, style)} (exit=${exit}${timedOut})`);
    return;
  }

  // ── Claude stream events ──

  if (name === 'claude_event') {
    renderClaudeEvent(event, prefix);
    return;
  }

  if (name === 'claude_stderr') {
    const text = String(event.data || '').trim();
    if (text) console.log(`${c('  stderr:', 'red')} ${truncate(text, 300)}`);
    return;
  }

  if (name === 'claude_raw') {
    const text = String(event.data || '').trim();
    if (text) console.log(`${c('  raw:', 'dim')} ${truncate(text, 200)}`);
    return;
  }

  // Fallback: print event name
  console.log(`${prefix} ${c(name, 'dim')}`);
};

const renderClaudeEvent = (event, prefix) => {
  const type = String(event.type || '');
  const data = event.data || {};

  // ── assistant message: show tool calls with args, text blocks ──
  if (type === 'assistant') {
    const content = data.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === 'tool_use') {
        const tool = String(block.name || '');
        const input = block.input || {};
        const inputStr = JSON.stringify(input);
        const display = inputStr.length > 300 ? truncate(inputStr, 300) : inputStr;
        console.log(`${c('  → ', 'cyan')}${c(tool, 'bold')} ${c(display, 'dim')}`);
      }
      if (block.type === 'text' && block.text) {
        const text = String(block.text).trim();
        if (text) {
          for (const line of text.split('\n').slice(0, 5)) {
            console.log(`${c('  ', 'dim')}${line}`);
          }
          if (text.split('\n').length > 5) {
            console.log(`${c('  ...', 'dim')}`);
          }
        }
      }
      // Skip thinking blocks in assistant (shown via stream deltas)
    }
    return;
  }

  // ── user message: tool results ──
  if (type === 'user') {
    const content = data.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === 'tool_result') {
        const text = String(block.content || '');
        const isError = block.is_error === true;
        if (isError) {
          console.log(`${c('  ✗ ', 'red')}${c(truncate(text, 200), 'red')}`);
        } else if (text) {
          console.log(`${c('  ← ', 'dim')}${truncate(text, 200)}`);
        }
      }
    }
    // Also check tool_use_result at top level
    if (data.tool_use_result && typeof data.tool_use_result === 'string') {
      const isErr = data.tool_use_result.startsWith('Error:');
      if (isErr) {
        console.log(`${c('  ✗ ', 'red')}${c(truncate(data.tool_use_result, 200), 'red')}`);
      }
    }
    return;
  }

  // ── result ──
  if (type === 'result') {
    const result = String(data.result || '');
    if (result) {
      const lines = result.split('\n').slice(0, 8);
      for (const line of lines) {
        console.log(`${c('  ✓ ', 'green')}${line}`);
      }
      if (result.split('\n').length > 8) {
        console.log(`${c('  ...', 'dim')}`);
      }
    }
    return;
  }

  // ── stream_event: show thinking and text deltas, skip noise ──
  if (type === 'stream_event') {
    const inner = data.event;
    if (!inner) return;
    const innerType = String(inner.type || '');

    // Thinking deltas — accumulate and show
    if (innerType === 'content_block_delta') {
      const delta = inner.delta || {};
      if (delta.type === 'thinking_delta' && delta.thinking) {
        // Write thinking inline without newline for streaming effect
        process.stdout.write(c(delta.thinking, 'dim'));
        return;
      }
      if (delta.type === 'text_delta' && delta.text) {
        process.stdout.write(delta.text);
        return;
      }
      // input_json_delta and signature_delta — skip (noisy, shown in assistant message)
      return;
    }

    // Content block start — show tool_use starts
    if (innerType === 'content_block_start') {
      const block = inner.content_block || {};
      if (block.type === 'tool_use') {
        // Will be shown with full args in the assistant message
        return;
      }
      if (block.type === 'thinking') {
        process.stdout.write(c('\n  💭 ', 'dim'));
        return;
      }
      if (block.type === 'text') {
        process.stdout.write('\n  ');
        return;
      }
      return;
    }

    // Content block stop — newline after thinking/text streams
    if (innerType === 'content_block_stop') {
      process.stdout.write('\n');
      return;
    }

    // Skip: message_start, message_stop, message_delta (metadata)
    return;
  }

  // Skip rate_limit_event
};

// ── History + Live ───────────────────────────────────────────────────────────

const readHistory = ({ listDir, showAll }) => {
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
    // Show orchestrator events from history, skip noisy stream deltas
    for (const event of history) {
      const name = String(event.event || '');
      if (name === 'claude_event') {
        const type = String(event.type || '');
        // In history, only show assistant messages (tool calls), user results, and final results
        if (type === 'assistant' || type === 'user' || type === 'result') {
          render(event);
        }
        continue;
      }
      render(event);
    }
  }
  console.log('');
  console.log(c('=== live ===', 'bold'));

  let activeSocket = null;
  let reconnectTimer = null;
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

    socket.on('data', (chunk) => {
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

    socket.on('error', (error) => {
      const code = String(error?.code || '');
      if ((code === 'ENOENT' || code === 'ECONNREFUSED') && !waitingPrinted) {
        waitingPrinted = true;
        console.error(c('waiting for activity...', 'dim'));
      }
    });

    socket.on('close', () => { if (!stopped) scheduleReconnect(); });
  };

  await new Promise((resolve) => {
    const onSignal = () => { stop(); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); resolve(); };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    void connect();
  });
};
