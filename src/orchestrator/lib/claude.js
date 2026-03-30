/**
 * Claude CLI subprocess runner.
 * Spawns `claude` from $PATH with --print mode for LLM boundary actions.
 */
import { spawn } from 'node:child_process';
import { emitActivity, emitLive } from './activity.js';

/**
 * Run a Claude CLI prompt and return the output.
 *
 * @param {string} prompt - The prompt to send
 * @param {{ model?: string, timeout?: number }} options
 * @returns {Promise<{ output: string, exitCode: number, stderr: string, timedOut: boolean }>}
 */
export const runClaude = (prompt, { model, timeout } = {}) =>
  new Promise((res) => {
    const args = ['--print', '--dangerously-skip-permissions', '-p', '-'];
    if (model) args.push('--model', model);
    emitActivity({
      event: 'claude_start',
      model: String(model || ''),
      timeout_ms: Number(timeout || 0) || undefined,
    });

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    proc.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      emitLive({ event: 'claude_chunk', data: chunk });
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
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
      emitActivity({
        event: 'claude_complete',
        model: String(model || ''),
        exit_code: 1,
        timed_out: true,
        output_length: stdout.length,
        stderr_length: stderr.length,
        summary: stdout.trim().slice(0, 300),
        stderr_tail: stderr.trim().slice(-200) || undefined,
      });
      resolveOnce({
        output: stdout.trim(),
        exitCode: 1,
        stderr: stderr.trim() || `Claude CLI timed out after ${timeout}ms.`,
        timedOut: true,
      });
        }, 5000);
      }, timeout)
      : null;

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      const failed = (code ?? 1) !== 0;
      emitActivity({
        event: 'claude_complete',
        model: String(model || ''),
        exit_code: code ?? 1,
        timed_out: false,
        output_length: stdout.length,
        stderr_length: stderr.length,
        summary: stdout.trim().slice(0, 300),
        stderr_tail: failed ? (stderr.trim().slice(-200) || undefined) : undefined,
      });
      resolveOnce({ output: stdout.trim(), exitCode: code ?? 1, stderr: stderr.trim(), timedOut: false });
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      emitActivity({
        event: 'claude_complete',
        model: String(model || ''),
        exit_code: 1,
        timed_out: false,
        output_length: stdout.length,
        stderr_length: stderr.length,
        summary: String(err.message || '').slice(0, 300),
        stderr_tail: stderr.trim().slice(-200) || String(err.message || '').slice(0, 200) || undefined,
      });
      resolveOnce({ output: '', exitCode: 1, stderr: err.message, timedOut: false });
    });

    // Pipe prompt via stdin and close immediately
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
