import { existsSync } from 'node:fs';
import { resolveListDir } from '../lib.js';
import { withActivityContext } from '../orchestrator/lib/activity.js';
import { runSequencer } from '../orchestrator/sequencer/runner.js';

export const sequenceRunTool = {
  name: 'outbound_sequence_run',
  description:
    'Run the outreach sequencer. Reads CSV for prospects with due actions, checks for replies via Composio, generates follow-up drafts, and advances sequences. All state is in the CSV.',
  inputSchema: {
    type: 'object',
    required: ['list'],
    properties: {
      list: {
        type: 'string',
        description: 'The list to run the sequencer for.',
      },
      dry_run: {
        type: 'boolean',
        description: 'Show what would happen without making changes.',
      },
    },
  },
  run: async (args) => {
    const listDir = resolveListDir(args.list);
    if (!existsSync(listDir)) {
      return { error: `List "${args.list}" not found.` };
    }

    return withActivityContext({ listDir, listName: args.list }, async () => {
      const summary = await runSequencer({
        listDir,
        dryRun: Boolean(args.dry_run),
      });

      return {
        status: 'completed',
        list: args.list,
        ...summary,
      };
    });
  },
};
