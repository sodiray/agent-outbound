import { existsSync } from 'node:fs';
import { resolveListDir } from '../lib.js';
import { getEnrichmentStatus } from '../orchestrator/enrichment/runner.js';

export const enrichStatusTool = {
  name: 'outbound_enrich_status',
  description:
    'Show enrichment status for a list: source progress plus rubric scoring staleness/pending status.',
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

    try {
      const status = getEnrichmentStatus({ listDir });
      return {
        list: args.list,
        ...status,
      };
    } catch (error) {
      return { error: error.message };
    }
  },
};
