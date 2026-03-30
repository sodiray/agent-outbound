import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveListDir } from '../lib.js';
import { withActivityContext } from '../orchestrator/lib/activity.js';
import { runEnrichment } from '../orchestrator/enrichment/runner.js';

export const enrichTool = {
  name: 'outbound_enrich',
  description:
    'Run enrichment for a list. Reads compiled config from outbound.yaml, checks staleness per row per source, runs adapters for stale/missing data, and writes columns to canonical CSV. Processes sources in dependency order with per-source concurrency.',
  inputSchema: {
    type: 'object',
    required: ['list'],
    properties: {
      list: { type: 'string', description: 'Path to the list directory (absolute or relative to cwd).' },
      source: {
        type: 'string',
        description: 'Run only a specific source ID from compiled config. Omit to run all.',
      },
      rows: {
        type: 'string',
        description: 'Row range to enrich (e.g. "0-50"). Omit to enrich all rows.',
      },
      concurrency: {
        type: 'number',
        description: 'Override the per-source concurrency setting.',
      },
    },
  },
  run: async (args) => {
    const listDir = resolveListDir(args.list);
    if (!existsSync(listDir)) {
      return { error: `List "${args.list}" not found.` };
    }

    return withActivityContext({ listDir, listName: args.list }, async () => {
      const summary = await runEnrichment({
        listDir,
        sourceName: args.source,
        rowRange: args.rows,
        concurrencyOverride: args.concurrency,
      });

      return {
        status: 'completed',
        list: args.list,
        ...summary,
      };
    });
  },
};
