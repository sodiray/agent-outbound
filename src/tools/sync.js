import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveListDir } from '../lib.js';
import { withActivityContext } from '../orchestrator/lib/activity.js';
import { readYaml } from '../orchestrator/lib/yaml.js';
import { readCSV } from '../orchestrator/lib/csv.js';
import {
  ensureCanonicalCsvExists,
  getCanonicalCsvPath,
  syncDestinations,
} from '../orchestrator/lib/runtime.js';

export const syncTool = {
  name: 'outbound_sync',
  description:
    'Sync a list\'s current CSV data to configured destinations (Google Sheets, CSV file, etc.). Reads the canonical CSV and pushes to all destinations in the config. Use this to retry a failed sync or force an update.',
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

    const outboundPath = join(listDir, 'outbound.yaml');
    if (!existsSync(outboundPath)) {
      return { error: `No outbound.yaml found for list "${args.list}".` };
    }

    return withActivityContext({ listDir, listName: args.list }, async () => {
      const outboundConfig = readYaml(outboundPath);
      if (outboundConfig._raw) {
        return { error: 'Could not parse outbound.yaml.' };
      }

      ensureCanonicalCsvExists(listDir);
      const csvPath = getCanonicalCsvPath(listDir);
      const { headers, rows } = readCSV(csvPath);

      try {
        const result = await syncDestinations({
          listDir,
          outboundConfig,
          headers,
          rows,
        });

        return {
          status: 'completed',
          list: args.list,
          row_count: rows.length,
          ...result,
        };
      } catch (error) {
        return {
          status: 'failed',
          list: args.list,
          error: error.message,
        };
      }
    });
  },
};
