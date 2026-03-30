import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveListDir } from '../lib.js';
import { getListSummary } from '../orchestrator/lib/list-status.js';

export const listsTool = {
  name: 'outbound_lists',
  description:
    'Scan a directory for outreach lists (subdirectories containing outbound.yaml) and return status for each.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory to scan for lists (absolute or relative to cwd). Defaults to cwd.',
      },
    },
  },
  run: async (args) => {
    const scanDir = resolveListDir(args.path || '.');

    if (!existsSync(scanDir)) {
      return { lists: [], message: `Directory not found: ${scanDir}` };
    }

    const entries = readdirSync(scanDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .filter((entry) => existsSync(join(scanDir, entry.name, 'outbound.yaml')));

    const lists = entries.map((entry) => {
      const listDir = join(scanDir, entry.name);
      const summary = getListSummary({ listDir });
      return { name: entry.name, path: listDir, ...summary };
    });

    return { lists };
  },
};
