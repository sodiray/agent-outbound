#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const command = args[0];

const COMMAND_FILE_NAME = 'outbound.md';

const getCommandFileContent = () => {
  const commandPath = join(__dirname, '..', 'command.md');
  if (existsSync(commandPath)) {
    return readFileSync(commandPath, 'utf-8');
  }
  throw new Error('command.md not found in package. This is a packaging error.');
};

const getMcpEntry = () => ({
  outbound: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'agent-outbound', 'serve'],
  },
});

const mergeIntoMcpJson = (mcpJsonPath) => {
  let existing = { mcpServers: {} };
  if (existsSync(mcpJsonPath)) {
    try {
      existing = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    } catch {
      existing = { mcpServers: {} };
    }
  }
  if (!existing.mcpServers) existing.mcpServers = {};

  const entry = getMcpEntry();
  existing.mcpServers = { ...existing.mcpServers, ...entry };

  mkdirSync(dirname(mcpJsonPath), { recursive: true });
  writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + '\n');
  return mcpJsonPath;
};

const init = () => {
  const cwd = process.cwd();
  console.log('Initializing outbound in', cwd);
  console.log();

  // 1. Install Claude Code command
  const claudeCommandsDir = join(cwd, '.claude', 'commands');
  const commandDest = join(claudeCommandsDir, COMMAND_FILE_NAME);
  mkdirSync(claudeCommandsDir, { recursive: true });
  writeFileSync(commandDest, getCommandFileContent());
  console.log('  Installed .claude/commands/outbound.md');

  // 2. Add MCP server to .mcp.json
  const mcpJsonPath = join(cwd, '.mcp.json');
  mergeIntoMcpJson(mcpJsonPath);
  console.log('  Added outbound MCP server to .mcp.json');

  console.log();
  console.log('Done! Open Claude Code in this directory and type:');
  console.log();
  console.log('  /outbound');
  console.log();
  console.log('To get started, try:');
  console.log('  "Create a list called my-first-list"');
  console.log();
  console.log('The outbound system will discover your connected MCP tools');
  console.log('and use them to source, enrich, and sequence outreach.');
};

const serve = async () => {
  // Import and run the MCP server
  await import('./server.js');
};

const watch = async () => {
  const watchArgs = args.slice(1);
  const showAllHistory = watchArgs.includes('--history');
  const listPath = watchArgs.find((item) => !String(item || '').startsWith('-')) || '.';
  const { runWatch } = await import('./watch.js');
  await runWatch({ listPath, showAllHistory });
};

const kill = async () => {
  const { getTrackedPids, killAll } = await import('./orchestrator/lib/pids.js');
  const alive = getTrackedPids();
  if (alive.length === 0) {
    console.log('No tracked processes.');
    return;
  }
  console.log(`Killing ${alive.length} tracked process(es)...`);
  const results = killAll();
  for (const r of results) {
    console.log(`  PID ${r.pid}: ${r.status}`);
  }
  console.log('Done.');
};

const printHelp = () => {
  console.log('agent-outbound - AI-powered outbound pipeline for Claude Code');
  console.log();
  console.log('Commands:');
  console.log('  init     Set up outbound in the current directory');
  console.log('           Installs the /outbound command and adds the MCP server to .mcp.json');
  console.log();
  console.log('  serve    Start the MCP server (used by Claude Code, not typically run directly)');
  console.log();
  console.log('  watch    Stream live activity for a list');
  console.log('           Usage: npx agent-outbound watch <list-path> [--history]');
  console.log('           Each watch session is scoped to a single list.');
  console.log();
  console.log('  kill     Kill all tracked Claude subprocesses');
  console.log('           Use when the MCP server has lingering processes after exiting Claude.');
  console.log();
  console.log('Usage:');
  console.log('  npx agent-outbound init');
  console.log('  npx agent-outbound serve');
  console.log('  npx agent-outbound watch ./my-list');
  console.log('  npx agent-outbound kill');
};

if (command === 'init') {
  init();
} else if (command === 'serve') {
  await serve();
} else if (command === 'watch') {
  await watch();
} else if (command === 'kill') {
  await kill();
} else if (command === 'help' || command === '--help' || command === '-h') {
  printHelp();
} else {
  printHelp();
  process.exit(command ? 1 : 0);
}
