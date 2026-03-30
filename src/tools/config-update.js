import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveListDir } from '../lib.js';
import { resolveConfig } from '../orchestrator/enrichment/resolve.js';

export const configUpdateTool = {
  name: 'outbound_config_update',
  description:
    'Update a list\'s outbound config. Writes outbound.yaml and automatically compiles nested config for source.filters, enrich, rubric, and sequence in place.',
  inputSchema: {
    type: 'object',
    required: ['list', 'config', 'content'],
    properties: {
      list: { type: 'string', description: 'Path to the list directory (absolute or relative to cwd).' },
      config: {
        type: 'string',
        enum: ['outbound'],
        description: 'Which config to update.',
      },
      content: {
        type: 'string',
        description: 'The full new content for the config file (YAML).',
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
    const previousContent = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
    writeFileSync(filePath, args.content);

    const result = {
      status: 'updated',
      list: args.list,
      config: args.config,
      file: fileMap[args.config],
    };

    try {
      const resolveResult = await resolveConfig(listDir);
      result.resolve = 'completed';
      result.resolve_result = resolveResult;
    } catch (error) {
      if (previousContent != null) {
        writeFileSync(filePath, previousContent);
      }
      result.resolve = 'failed';
      result.resolve_error = error.message;
    }

    return result;
  },
};
