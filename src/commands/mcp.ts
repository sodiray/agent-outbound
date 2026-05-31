import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolveListDir } from '../orchestrator/runtime/paths.js';
import {
  getProviderRegistryPath,
  readProviderRegistry,
  type CommandToolDef,
  type ProviderRegistryFile,
} from '../orchestrator/lib/provider-registry.js';
import { getProvider } from '../orchestrator/runtime/providers/registry.js';

const writeProviderRegistry = (listDir: string, registry: ProviderRegistryFile) => {
  const path = getProviderRegistryPath(listDir);
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`);
  return path;
};

const parseCsv = (value: string) =>
  String(value || '').split(',').map((item) => item.trim()).filter(Boolean);

const parseEnvPairs = (pairs: string[]) => {
  const env: Record<string, string> = {};
  for (const pair of pairs || []) {
    const idx = String(pair || '').indexOf('=');
    if (idx <= 0) {
      throw new Error(`Invalid --env value "${pair}". Expected K=V.`);
    }
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    env[key] = value;
  }
  return env;
};

const readToolsFile = (path: string): CommandToolDef[] => {
  if (!path) return [];
  if (!existsSync(path)) throw new Error(`Tools file not found: ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`Tools file must contain a JSON array: ${path}`);
  return parsed as CommandToolDef[];
};

export const mcpListCommand = ({ list }: { list: string }) => {
  const listDir = resolveListDir(list);
  const registry = readProviderRegistry(listDir);
  const servers = Object.entries(registry.mcpServers || {}).map(([name, server]) => ({
    name,
    type: server.type,
    command: server.type === 'command' || server.type === 'stdio' ? server.command || '' : '',
    url: server.type === 'http' ? server.url || '' : '',
    cwd: server.type === 'command' || server.type === 'stdio' ? server.cwd || '' : '',
    tools: Array.isArray((server as any).tools)
      ? (server as any).tools.map((tool: any) => ({
        slug: String(tool?.slug || ''),
        description: String(tool?.description || ''),
      }))
      : [],
  }));
  return {
    list: listDir,
    path: getProviderRegistryPath(listDir),
    count: servers.length,
    servers,
  };
};

export const mcpAddCommand = ({
  list,
  name,
  type,
  command,
  args = '',
  env = [],
  cwd = '',
  toolsFile = '',
}: {
  list: string;
  name: string;
  type: string;
  command: string;
  args?: string;
  env?: string[];
  cwd?: string;
  toolsFile?: string;
}) => {
  const listDir = resolveListDir(list);
  const normalizedName = String(name || '').trim().toLowerCase();
  if (!normalizedName) throw new Error('--name is required.');
  if (type !== 'command') throw new Error('P2 supports `mcp add` for --type command only.');
  if (!String(command || '').trim()) throw new Error('--command is required for --type command.');

  const registry = readProviderRegistry(listDir);
  const tools = readToolsFile(toolsFile);
  if (tools.length === 0) throw new Error('--tools-file is required for --type command and must contain at least one tool.');
  registry.mcpServers[normalizedName] = {
    type: 'command',
    command: String(command || '').trim(),
    args: parseCsv(args),
    env: parseEnvPairs(env),
    ...(cwd ? { cwd } : {}),
    tools,
  };
  const path = writeProviderRegistry(listDir, registry);
  return {
    status: 'saved',
    list: listDir,
    path,
    server: normalizedName,
    type: 'command',
    tool_count: tools.length,
  };
};

export const mcpRemoveCommand = ({ list, name }: { list: string; name: string }) => {
  const listDir = resolveListDir(list);
  const normalizedName = String(name || '').trim().toLowerCase();
  if (!normalizedName) throw new Error('--name is required.');
  const registry = readProviderRegistry(listDir);
  const existed = Boolean(registry.mcpServers[normalizedName]);
  delete registry.mcpServers[normalizedName];
  const path = writeProviderRegistry(listDir, registry);
  return {
    status: existed ? 'removed' : 'not_found',
    list: listDir,
    path,
    server: normalizedName,
  };
};

export const mcpTestCommand = async ({ list, name }: { list: string; name: string }) => {
  const listDir = resolveListDir(list);
  const normalizedName = String(name || '').trim().toLowerCase();
  if (!normalizedName) throw new Error('--name is required.');
  const provider = getProvider(normalizedName, { listDir });
  const tools = await provider.searchTools([], 1000);
  return {
    status: 'ok',
    list: listDir,
    server: normalizedName,
    type: 'command',
    tool_count: tools.length,
    tools: tools.map((tool) => ({
      slug: tool.slug,
      server: tool.server,
      description: tool.description || '',
    })),
  };
};
