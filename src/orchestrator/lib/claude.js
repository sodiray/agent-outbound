/**
 * Claude CLI subprocess runner.
 * Spawns `claude` from $PATH with --print mode for LLM boundary actions.
 */
import { spawn } from 'node:child_process';

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

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const resolveOnce = (payload) => {
      if (settled) return;
      settled = true;
      res(payload);
    };

    const timer = timeout
      ? setTimeout(() => {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
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
      resolveOnce({ output: stdout.trim(), exitCode: code ?? 1, stderr: stderr.trim(), timedOut: false });
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolveOnce({ output: '', exitCode: 1, stderr: err.message, timedOut: false });
    });

    // Pipe prompt via stdin and close immediately
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
