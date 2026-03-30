import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveListDir } from '../lib.js';

export const configReadTool = {
  name: 'outbound_config_read',
  description:
    'Read a list\'s outbound config.',
  inputSchema: {
    type: 'object',
    required: ['list', 'config'],
    properties: {
      list: { type: 'string', description: 'Path to the list directory (absolute or relative to cwd).' },
      config: {
        type: 'string',
        enum: ['outbound'],
        description: 'Which config to read.',
      },
    },
  },
  run: async (args) => {
    const listDir = resolveListDir(args.list);
    if (!existsSync(listDir)) {
      return { error: `List "${args.list}" not found.` };
    }

    const fileMap = {
      outbound: 'outbound.yaml',
    };

    const filePath = join(listDir, fileMap[args.config]);
    if (!existsSync(filePath)) {
      return { error: `Config file "${fileMap[args.config]}" not found for list "${args.list}".` };
    }

    return {
      list: args.list,
      config: args.config,
      file: fileMap[args.config],
      content: readFileSync(filePath, 'utf-8'),
    };
  },
};
