import { existsSync } from 'node:fs';
import { resolveListDir } from '../lib.js';
import { runFollowupSend } from '../orchestrator/sequencer/runner.js';

export const followupSendTool = {
  name: 'outbound_followup_send',
  description:
    'Execute drafted follow-up previews/messages (step 2+) from orchestrator follow-up state columns, then advance sequence state in canonical CSV.',
  inputSchema: {
    type: 'object',
    required: ['list'],
    properties: {
      list: { type: 'string', description: 'Path to the list directory (absolute or relative to cwd).' },
      stagger_seconds: {
        type: 'number',
        description: 'Seconds between sends. Defaults to 3.',
      },
      rows: {
        type: 'string',
        description: 'Row range (e.g. "0-50"). Omit for all matching rows.',
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

    const summary = await runFollowupSend({
      listDir,
      filter: args.filter,
      rowRange: args.rows,
      staggerSeconds: Number(args.stagger_seconds ?? 3),
    });

    return {
      status: 'completed',
      list: args.list,
      ...summary,
    };
  },
};
