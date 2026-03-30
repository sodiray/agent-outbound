import { existsSync } from 'node:fs';
import { resolveListDir } from '../lib.js';
import { runLaunchDraft } from '../orchestrator/launch/runner.js';

export const launchDraftTool = {
  name: 'outbound_launch_draft',
  description:
    'Create launch previews for sequence step 1 for specified rows. Uses sequence step config in outbound.yaml and stores preview state in canonical CSV (with legacy draft aliases for compatibility).',
  inputSchema: {
    type: 'object',
    required: ['list'],
    properties: {
      list: { type: 'string', description: 'Path to the list directory (absolute or relative to cwd).' },
      filter: {
        type: 'object',
        description: 'Only draft rows matching this filter. E.g. {"status": "ready"}',
        additionalProperties: { type: 'string' },
      },
      rows: {
        type: 'string',
        description: 'Row range (e.g. "0-50"). Omit for all matching rows.',
      },
    },
  },
  run: async (args) => {
    const listDir = resolveListDir(args.list);
    if (!existsSync(listDir)) {
      return { error: `List "${args.list}" not found.` };
    }

    const summary = await runLaunchDraft({
      listDir,
      listName: args.list,
      filter: args.filter,
      rows: args.rows,
    });

    return {
      status: 'completed',
      list: args.list,
      ...summary,
    };
  },
};
