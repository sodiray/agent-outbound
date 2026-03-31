/**
 * Claude CLI subprocess runner.
 * Spawns `claude` with --print --output-format stream-json --verbose --include-partial-messages.
 * Every stream-json event is emitted to the activity socket as raw JSON.
 */
import { spawn } from 'node:child_process';
import { emitActivity, emitLive } from './activity.js';

const tryParseJson = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/**
 * Run a Claude CLI prompt and return the output.
 *
 * @param {string} prompt - The prompt to send
 * @param {{ model?: string, timeout?: number }} options
 * @returns {Promise<{ output: string, exitCode: number, stderr: string, timedOut: boolean }>}
 */
export const runClaude = (prompt, { model, timeout } = {}) =>
  new Promise((res) => {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
      '-p', '-',
    ];
    if (model) args.push('--model', model);

    // Emit start event with the full prompt
    emitActivity({
      event: 'claude_start',
      model: String(model || ''),
      prompt,
    });

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let resultText = '';
    let stderr = '';
    let settled = false;
    let lineBuffer = '';

    proc.stdout.on('data', (d) => {
      lineBuffer += d.toString();
      let newlineIndex = lineBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = lineBuffer.slice(0, newlineIndex).trim();
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        newlineIndex = lineBuffer.indexOf('\n');

        if (!line) continue;
        const event = tryParseJson(line);

        if (!event) {
          // Non-JSON line — emit raw
          emitLive({ event: 'claude_raw', data: line });
          continue;
        }

        // Extract final result text
        if (event.type === 'result' && event.result) {
          resultText = String(event.result);
        }
        // Also capture text from full assistant messages
        if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) {
              resultText = String(block.text);
            }
          }
        }

        // Emit every stream-json event to the socket as-is
        emitLive({ event: 'claude_event', type: event.type, data: event });
      }
    });

    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      emitLive({ event: 'claude_stderr', data: chunk });
    });

    const resolveOnce = (payload) => {
      if (settled) return;
      settled = true;
      res(payload);
    };

    const timer = timeout
      ? setTimeout(() => {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (settled) return;
          if (!proc.killed) proc.kill('SIGKILL');
          emitActivity({ event: 'claude_complete', model: String(model || ''), exit_code: 1, timed_out: true });
          resolveOnce({ output: resultText.trim(), exitCode: 1, stderr: stderr.trim() || `Timed out after ${timeout}ms.`, timedOut: true });
        }, 5000);
      }, timeout)
      : null;

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      // Process remaining buffer
      if (lineBuffer.trim()) {
        const event = tryParseJson(lineBuffer.trim());
        if (event?.type === 'result' && event.result) resultText = String(event.result);
      }
      emitActivity({ event: 'claude_complete', model: String(model || ''), exit_code: code ?? 1, timed_out: false });
      resolveOnce({ output: resultText.trim(), exitCode: code ?? 1, stderr: stderr.trim(), timedOut: false });
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      emitActivity({ event: 'claude_complete', model: String(model || ''), exit_code: 1, timed_out: false });
      resolveOnce({ output: '', exitCode: 1, stderr: err.message, timedOut: false });
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
