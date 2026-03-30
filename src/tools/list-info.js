import { existsSync } from 'node:fs';
import { resolveListDir } from '../lib.js';
import { getListSummary } from '../orchestrator/lib/list-status.js';

export const listInfoTool = {
  name: 'outbound_list_info',
  description:
    'Get detailed status for a specific list using current outbound state (sourcing, enrichment, and sequence aggregates).',
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
    const summary = getListSummary({ listDir });

    return {
      list: args.list,
      ...summary,
    };
  },
};
