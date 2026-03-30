#!/usr/bin/env node
import { readdirSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// List management
import { listCreateTool } from './tools/list-create.js';
import { listInfoTool } from './tools/list-info.js';
import { listsTool } from './tools/lists.js';

// Config
import { configReadTool } from './tools/config-read.js';
import { configUpdateTool } from './tools/config-update.js';
import { configAuthorTool } from './tools/config-author.js';

// Sourcing
import { sourceTool } from './tools/source.js';

// Enrichment
import { enrichTool } from './tools/enrich.js';
import { enrichStatusTool } from './tools/enrich-status.js';

// CSV
import { csvReadTool } from './tools/csv-read.js';
import { csvStatsTool } from './tools/csv-stats.js';

// Launch
import { launchDraftTool } from './tools/launch-draft.js';
import { launchSendTool } from './tools/launch-send.js';
import { launchStatusTool } from './tools/launch-status.js';
import { followupSendTool } from './tools/followup-send.js';

// Sequencer
import { sequenceRunTool } from './tools/sequence-run.js';
import { sequenceStatusTool } from './tools/sequence-status.js';

// Operator
import { logTool } from './tools/log.js';

const tools = new Map(
  [
    listCreateTool,
    listInfoTool,
    listsTool,
    configReadTool,
    configUpdateTool,
    configAuthorTool,
    sourceTool,
    enrichTool,
    enrichStatusTool,
    csvReadTool,
    csvStatsTool,
    launchDraftTool,
    launchSendTool,
    launchStatusTool,
    followupSendTool,
    sequenceRunTool,
    sequenceStatusTool,
    logTool,
  ].map((tool) => [tool.name, tool])
);

const serverStartedAt = Date.now();
const sourceRootDir = dirname(fileURLToPath(import.meta.url));
let staleWarningLogged = false;
let staleWarningReturned = false;
let lastStaleScanAt = 0;
let lastStaleScanResult = false;

const hasSourceChangesSinceStartup = () => {
  const now = Date.now();
  if (now - lastStaleScanAt < 5_000) {
    return lastStaleScanResult;
  }
  lastStaleScanAt = now;

  const queue = [sourceRootDir];
  while (queue.length > 0) {
    const current = queue.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (extname(entry.name) !== '.js') continue;

      try {
        if (statSync(fullPath).mtimeMs > serverStartedAt) {
          lastStaleScanResult = true;
          return true;
        }
      } catch {
        // Ignore transient file stat errors.
      }
    }
  }

  lastStaleScanResult = false;
  return false;
};

const maybeAddStaleWarning = (payload) => {
  if (!hasSourceChangesSinceStartup()) return payload;

  if (!staleWarningLogged) {
    staleWarningLogged = true;
    process.stderr.write(
      'outbound-mcp warning: source files changed after startup; restart MCP session to load latest code/tools.\n'
    );
  }

  if (staleWarningReturned) return payload;
  staleWarningReturned = true;

  return {
    ...payload,
    mcp_warning:
      'Outbound MCP process is stale relative to disk (source changed after startup). Restart MCP session to load latest code/tools.',
  };
};

const jsonTextResponse = (payload, isError = false) => ({
  isError,
  content: [{ type: 'text', text: JSON.stringify(maybeAddStaleWarning(payload)) }],
});

const server = new Server(
  { name: 'outbound-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...tools.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const tool = tools.get(toolName);

  if (!tool) {
    return jsonTextResponse(
      { error: `Unknown tool: ${toolName}`, available: [...tools.keys()] },
      true
    );
  }

  try {
    const result = await tool.run(request.params.arguments ?? {});
    return jsonTextResponse(result);
  } catch (error) {
    return jsonTextResponse(
      { error: error.message, code: error.code ?? 'UNKNOWN' },
      true
    );
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `outbound-mcp ready (tools=${tools.size}; started_at=${new Date(serverStartedAt).toISOString()})\n`
);
