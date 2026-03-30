/**
 * Claude CLI subprocess runner.
 * Spawns `claude` from $PATH with --print mode for LLM boundary actions.
 */
import { execFile } from 'node:child_process';

/**
 * Run a Claude CLI prompt and return the output.
 *
 * @param {string} prompt - The prompt to send
 * @param {{ model?: string, timeout?: number }} options
 * @returns {Promise<{ output: string, exitCode: number, stderr: string }>}
 */
export const runClaude = (prompt, { model, timeout } = {}) =>
  new Promise((resolve) => {
    const args = ['--print', '--dangerously-skip-permissions'];
    if (model) args.push('--model', model);
    args.push('-p', prompt);

    const child = execFile('claude', args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: timeout || 5 * 60 * 1000,
    }, (error, stdout, stderr) => {
      resolve({
        output: stdout || '',
        exitCode: error ? (error.code || 1) : 0,
        stderr: stderr || '',
      });
    });
  });
