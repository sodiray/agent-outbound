import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveListDir } from '../lib.js';
import { withActivityContext } from '../orchestrator/lib/activity.js';
import { runSourcing } from '../orchestrator/sourcing/runner.js';

export const sourceTool = {
  name: 'outbound_source',
  description:
    'Run sourcing for a list. Executes search + filter phases from outbound config: search sources add/dedupe rows, then filters run adapters on new rows and write pass/fail columns.',
  inputSchema: {
    type: 'object',
    required: ['list'],
    properties: {
      list: { type: 'string', description: 'Path to the list directory (absolute or relative to cwd).' },
      limit: {
        type: 'number',
        description: 'Maximum number of new prospects to source. Omit for no limit.',
      },
      search_index: {
        type: 'number',
        description: 'Run only a specific search from the config (zero-based index). Omit to run all.',
      },
    },
  },
  run: async (args) => {
    const listDir = resolveListDir(args.list);
    if (!existsSync(listDir)) {
      return { error: `List "${args.list}" not found.` };
    }

    return withActivityContext({ listDir, listName: args.list }, async () => {
      const summary = await runSourcing({
        listDir,
        limit: args.limit,
        searchIndex: args.search_index,
      });

      return {
        status: 'completed',
        list: args.list,
        ...summary,
      };
    });
  },
};
