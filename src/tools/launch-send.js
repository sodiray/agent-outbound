import { existsSync } from 'node:fs';
import { resolveListDir } from '../lib.js';
import { withActivityContext } from '../orchestrator/lib/activity.js';
import { runLaunchSend } from '../orchestrator/launch/runner.js';

export const launchSendTool = {
  name: 'outbound_launch_send',
  description:
    'Execute approved launch previews for a list. Staggers execution, stores execution references, and initializes sequence state from sequence step timing in outbound.yaml.',
  inputSchema: {
    type: 'object',
    required: ['list'],
    properties: {
      list: { type: 'string', description: 'Path to the list directory (absolute or relative to cwd).' },
      stagger_seconds: {
        type: 'number',
        description: 'Seconds between sends. Defaults to 3 (20/minute).',
      },
      filter: {
        type: 'object',
        description: 'Only send rows matching this filter.',
        additionalProperties: { type: 'string' },
      },
    },
  },
  run: async (args) => {
    const listDir = resolveListDir(args.list);
    if (!existsSync(listDir)) {
      return { error: `List "${args.list}" not found.` };
    }

    return withActivityContext({ listDir, listName: args.list }, async () => {
      const summary = await runLaunchSend({
        listDir,
        filter: args.filter,
        staggerSeconds: Number(args.stagger_seconds ?? 3),
      });

      return {
        status: 'completed',
        list: args.list,
        ...summary,
      };
    });
  },
};
