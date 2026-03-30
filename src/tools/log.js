import { existsSync } from 'node:fs';
import { resolveListDir } from '../lib.js';
import { logOutcome } from '../orchestrator/sequencer/runner.js';
import { getCanonicalCsvPath } from '../orchestrator/lib/runtime.js';

export const logTool = {
  name: 'outbound_log',
  description:
    'Log an outcome for a prospect. Updates their CSV row with the outcome and adjusts sequence state (e.g., pause on engagement, close on opt-out).',
  inputSchema: {
    type: 'object',
    required: ['list', 'prospect', 'action'],
    properties: {
      list: { type: 'string', description: 'Path to the list directory (absolute or relative to cwd).' },
      prospect: {
        type: 'string',
        description: 'Business name (or partial match) to identify the prospect.',
      },
      action: {
        type: 'string',
        description: 'Freeform outcome label (for example: "meeting_booked", "call_notes", "operator_completed").',
      },
      transition: {
        type: 'string',
        enum: ['engaged', 'opted_out', 'bounced', 'completed', 'step_advanced'],
        description: 'Optional sequence-state transition to apply.',
      },
      note: {
        type: 'string',
        description: 'Free-form note about the outcome.',
      },
    },
  },
  run: async (args) => {
    const listDir = resolveListDir(args.list);
    const csvPath = getCanonicalCsvPath(listDir);
    if (!existsSync(csvPath)) {
      return { error: `No canonical prospects CSV found for list "${args.list}".` };
    }

    return logOutcome({
      listDir,
      prospect: args.prospect,
      action: args.action,
      transition: args.transition,
      note: args.note,
    });
  },
};
