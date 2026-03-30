import { existsSync } from 'node:fs';
import { resolveListDir } from '../lib.js';
import { getLaunchStatus } from '../orchestrator/launch/runner.js';

export const launchStatusTool = {
  name: 'outbound_launch_status',
  description:
    'Show launch status for a list: how many rows have drafts, how many have been sent, how many are pending.',
  inputSchema: {
    type: 'object',
    required: ['list'],
    properties: {
      list: { type: 'string', description: 'Path to the list directory (absolute or relative to cwd).' },
    },
  },
  run: async (args) => {
    const listDir = resolveListDir(args.list);
    if (!existsSync(listDir)) {
      return { error: `List "${args.list}" not found.` };
    }

    const summary = getLaunchStatus({ listDir });
    return {
      list: args.list,
      ...summary,
    };
  },
};
