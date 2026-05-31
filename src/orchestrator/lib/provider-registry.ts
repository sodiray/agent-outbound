import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { getEnv } from '../runtime/env.js';

const JsonObjectSchema = z.record(z.any());

const CommandToolSchema = z.object({
  slug: z.string().trim().min(1),
  description: z.string().default(''),
  input_schema: JsonObjectSchema.default({ type: 'object', properties: {} }),
  invoke: z.object({
    argv: z.array(z.string()).default([]),
    result: z.literal('stdout_json'),
  }),
}).passthrough();

const CommandServerSchema = z.object({
  type: z.literal('command'),
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  cwd: z.string().optional(),
  tools: z.array(CommandToolSchema).min(1),
}).passthrough();

const StdioServerSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().trim().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  cwd: z.string().optional(),
  tools: z.array(CommandToolSchema).optional(),
}).passthrough();

const HttpServerSchema = z.object({
  type: z.literal('http'),
  url: z.string().trim().optional(),
  env: z.record(z.string()).default({}),
  tools: z.array(CommandToolSchema).optional(),
}).passthrough();

const ServerSchema = z.discriminatedUnion('type', [
  CommandServerSchema,
  StdioServerSchema,
  HttpServerSchema,
]);

const ProviderRegistryFileSchema = z.object({
  mcpServers: z.record(ServerSchema).default({}),
}).default({ mcpServers: {} });

export type CommandToolDef = z.infer<typeof CommandToolSchema>;
export type CommandServerDef = z.infer<typeof CommandServerSchema>;
export type ServerDef = z.infer<typeof ServerSchema>;
export type ProviderRegistryFile = z.infer<typeof ProviderRegistryFileSchema>;

export const getProviderRegistryPath = (listDir: string) => join(listDir, 'mcp.json');

const formatZodIssues = (issues: z.ZodIssue[]) =>
  issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `${path}: ${issue.message}`;
  }).join('; ');

export const readProviderRegistry = (listDir: string): ProviderRegistryFile => {
  const path = getProviderRegistryPath(listDir);
  if (!existsSync(path)) return { mcpServers: {} };

  const rawText = readFileSync(path, 'utf8');
  const raw = (() => {
    try {
      return JSON.parse(rawText);
    } catch (error) {
      throw new Error(`Invalid provider registry ${path}: ${(error as Error).message}`);
    }
  })();
  const parsed = ProviderRegistryFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid provider registry ${path}: ${formatZodIssues(parsed.error.issues)}`);
  }
  return parsed.data;
};

export const expandRegistryEnv = (serverName: string, env: Record<string, string> = {}) => {
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(env || {})) {
    expanded[key] = String(value || '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const resolved = getEnv(name);
      if (!resolved) {
        throw new Error(`Provider "${serverName}" env "${key}" references unresolved variable \${${name}}.`);
      }
      return resolved;
    });
  }
  return expanded;
};
