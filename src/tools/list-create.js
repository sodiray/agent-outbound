import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveListDir } from '../lib.js';
import { withActivityContext, emitActivity } from '../orchestrator/lib/activity.js';

export const listCreateTool = {
  name: 'outbound_list_create',
  description:
    'Create a new outreach list at the given path. Creates the directory structure, empty CSV, and starter outbound config.',
  inputSchema: {
    type: 'object',
    required: ['list'],
    properties: {
      list: {
        type: 'string',
        description: 'Path where the list should be created (absolute or relative to cwd).',
      },
      description: {
        type: 'string',
        description: 'Brief description of what this list targets',
      },
    },
  },
  run: async (args) => {
    const listDir = resolveListDir(args.list);

    if (existsSync(join(listDir, 'outbound.yaml'))) {
      return { error: `List already exists at "${listDir}".` };
    }

    return withActivityContext({ listDir, listName: args.list }, async () => {
      mkdirSync(listDir, { recursive: true });
      mkdirSync(join(listDir, 'prompts'), { recursive: true });
      mkdirSync(join(listDir, '.outbound', '.cache'), { recursive: true });

      const name = args.list.split('/').pop();
      const outboundConfig = [
        `# Outbound config for ${name}`,
        args.description ? `# ${args.description}` : '',
        '',
        'source:',
        '  searches: []',
        '',
        'enrich: []',
        '',
        'rubric: []',
        '',
        'sequence:',
        '  steps: []',
      ].filter(Boolean).join('\n');

      writeFileSync(join(listDir, 'outbound.yaml'), outboundConfig + '\n');
      writeFileSync(join(listDir, '.outbound', 'prospects.csv'), '_row_id\n');
      writeFileSync(join(listDir, '.outbound', '.cache', 'hashes.json'), '{}');

      emitActivity({
        event: 'list_created',
        phase: 'setup',
        detail: `Created list at ${listDir}`,
      });

      return {
        status: 'created',
        list: listDir,
        files: ['outbound.yaml', '.outbound/prospects.csv', 'prompts/', '.outbound/.cache/'],
      };
    });
  },
};
