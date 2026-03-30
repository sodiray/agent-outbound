import { existsSync } from 'node:fs';
import { resolveListDir } from '../lib.js';
import { getSequenceStatus } from '../orchestrator/sequencer/runner.js';
import { getCanonicalCsvPath } from '../orchestrator/lib/runtime.js';

export const sequenceStatusTool = {
  name: 'outbound_sequence_status',
  description:
    'Show sequence pipeline status from the CSV: active/engaged/completed/opted_out/bounced counts, calls/manuals/follow-ups due today.',
  inputSchema: {
    type: 'object',
    required: ['list'],
    properties: {
      list: { type: 'string', description: 'Path to the list directory (absolute or relative to cwd).' },
    },
  },
  run: async (args) => {
    const listDir = resolveListDir(args.list);
    const csvPath = getCanonicalCsvPath(listDir);
    if (!existsSync(csvPath)) {
      return { error: `No canonical prospects CSV found for list "${args.list}".` };
    }

    const status = getSequenceStatus({ listDir });
    return {
      list: args.list,
      ...status,
    };
  },
};
