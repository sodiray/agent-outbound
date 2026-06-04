import { spawn } from 'node:child_process';
import type { CommandServerDef, CommandToolDef } from '../../lib/provider-registry.js';
import { expandRegistryEnv } from '../../lib/provider-registry.js';
import type { ProviderToolSchema, ToolProvider } from './types.js';
import { formatErrorMessage } from '../../lib/error-format.js';

const DEFAULT_TIMEOUT_MS = 60_000;

const normalizeSlug = (value: unknown) => String(value || '').trim();

const stringifyArgValue = (value: unknown) => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
};

const placeholdersFor = (token: string) =>
  [...String(token || '').matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((match) => match[1]);

export const renderCommandArgv = (template: string[], args: Record<string, unknown>) => {
  const argv: string[] = [];
  for (const token of template || []) {
    const names = placeholdersFor(token);
    const missing = names.some((name) => args?.[name] === null || args?.[name] === undefined);
    if (missing) {
      if (argv.length > 0 && String(argv[argv.length - 1]).startsWith('--')) {
        argv.pop();
      }
      continue;
    }
    const rendered = names.reduce(
      (current, name) => current.replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'g'), stringifyArgValue(args[name])),
      token,
    );
    argv.push(rendered);
  }
  return argv;
};

const schemaFromTool = (serverName: string, tool: CommandToolDef): ProviderToolSchema => ({
  slug: normalizeSlug(tool.slug),
  server: serverName,
  name: normalizeSlug(tool.slug),
  description: String(tool.description || ''),
  input_schema: tool.input_schema && typeof tool.input_schema === 'object'
    ? tool.input_schema
    : { type: 'object', properties: {} },
});

const stderrTail = (stderr: string) => {
  const trimmed = String(stderr || '').trim();
  if (!trimmed) return '';
  return trimmed.length > 4000 ? trimmed.slice(-4000) : trimmed;
};

const appendOptionalFlag = (argv: string[], flag: string, value: unknown) => {
  if (value === null || value === undefined || String(value).trim() === '') return argv;
  if (argv.includes(flag)) return argv;
  const jsonIndex = argv.lastIndexOf('--json');
  const extra = [flag, stringifyArgValue(value)];
  if (jsonIndex < 0) return [...argv, ...extra];
  return [...argv.slice(0, jsonIndex), ...extra, ...argv.slice(jsonIndex)];
};

const appendOptionalBooleanFlag = (argv: string[], flag: string, value: unknown) => {
  if (!value || argv.includes(flag)) return argv;
  const jsonIndex = argv.lastIndexOf('--json');
  if (jsonIndex < 0) return [...argv, flag];
  return [...argv.slice(0, jsonIndex), flag, ...argv.slice(jsonIndex)];
};

export class CommandProvider implements ToolProvider {
  id: string;
  private server: CommandServerDef;
  private env: Record<string, string>;

  constructor(serverName: string, server: CommandServerDef) {
    this.id = serverName;
    this.server = server;
    this.env = expandRegistryEnv(serverName, server.env || {});
  }

  async searchTools(queries: Array<string | Record<string, unknown>> = [], limit = 20): Promise<ProviderToolSchema[]> {
    const normalizedQueries = queries
      .map((query) => typeof query === 'string' ? query : JSON.stringify(query || {}))
      .map((query) => query.trim().toLowerCase())
      .filter(Boolean);
    const schemas = (this.server.tools || []).map((toolDef) => schemaFromTool(this.id, toolDef));
    const matched = normalizedQueries.length === 0
      ? schemas
      : schemas.filter((schema) => {
        const haystack = [schema.slug, schema.description || ''].join(' ').toLowerCase();
        return normalizedQueries.some((query) => haystack.includes(query));
      });
    return matched.slice(0, Math.max(1, Number(limit || 20)));
  }

  async getSchemas(slugs: string[]): Promise<ProviderToolSchema[]> {
    const wanted = new Set((slugs || []).map((slug) => normalizeSlug(slug).toUpperCase()).filter(Boolean));
    return (this.server.tools || [])
      .filter((toolDef) => wanted.has(normalizeSlug(toolDef.slug).toUpperCase()))
      .map((toolDef) => schemaFromTool(this.id, toolDef));
  }

  async executeTool(slug: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const normalized = normalizeSlug(slug).toUpperCase();
    const toolDef = (this.server.tools || []).find((tool) => normalizeSlug(tool.slug).toUpperCase() === normalized);
    if (!toolDef) {
      throw new Error(`Provider "${this.id}" does not declare tool "${slug}".`);
    }

    const renderedArgv = renderCommandArgv(toolDef.invoke.argv || [], args || {});
    const invokeArgv = appendOptionalBooleanFlag(
      appendOptionalFlag(renderedArgv, '--fields', args?.fields),
      '--raw',
      args?.raw,
    );
    const argv = [...(this.server.args || []), ...invokeArgv];
    const output = await new Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const child = spawn(this.server.command, argv, {
        cwd: this.server.cwd || undefined,
        env: { ...process.env, ...this.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Command provider "${this.id}" tool "${slug}" timed out after ${DEFAULT_TIMEOUT_MS}ms.`));
      }, DEFAULT_TIMEOUT_MS);

      child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`Command provider "${this.id}" tool "${slug}" failed to start: ${formatErrorMessage(error)}`));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          code,
          signal,
        });
      });
    });

    if (output.code !== 0) {
      const tail = stderrTail(output.stderr);
      throw new Error(`Command provider "${this.id}" tool "${slug}" exited with ${output.code ?? output.signal}.${tail ? ` stderr: ${tail}` : ''}`);
    }
    if (toolDef.invoke.result === 'stdout_json') {
      try {
        return JSON.parse(output.stdout);
      } catch (error) {
        const tail = stderrTail(output.stderr);
        throw new Error(`Command provider "${this.id}" tool "${slug}" did not return valid JSON on stdout: ${formatErrorMessage(error)}.${tail ? ` stderr: ${tail}` : ''}`);
      }
    }
    throw new Error(`Command provider "${this.id}" tool "${slug}" has unsupported result mode "${String((toolDef.invoke as any).result || '')}".`);
  }

  async listToolkits(): Promise<string[]> {
    return [];
  }

  async resolveToolkitToolSlugs(): Promise<string[]> {
    return [];
  }
}
