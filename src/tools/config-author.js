import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveListDir } from '../lib.js';
import { authorConfig } from '../orchestrator/actions/author-config.js';
import { withActivityContext } from '../orchestrator/lib/activity.js';
import { readYaml, writeYaml } from '../orchestrator/lib/yaml.js';
import { readCSV } from '../orchestrator/lib/csv.js';
import { ensureCanonicalCsvExists, getCanonicalCsvPath } from '../orchestrator/lib/runtime.js';
import { resolveConfig } from '../orchestrator/enrichment/resolve.js';

const requestIncludesAny = (requestText, keywords) => {
  const lower = String(requestText || '').toLowerCase();
  return keywords.some((keyword) => lower.includes(String(keyword).toLowerCase()));
};

const countRubricCriteria = (config) =>
  (Array.isArray(config?.rubric) ? config.rubric : [])
    .filter((item) => String(item?.description || '').trim())
    .length;

export const configAuthorTool = {
  name: 'outbound_config_author',
  description:
    'Author or modify outbound config from a natural-language request. Uses the author-config action, writes outbound.yaml, then validates/normalizes structure.',
  inputSchema: {
    type: 'object',
    required: ['list', 'request'],
    properties: {
      list: { type: 'string', description: 'Path to the list directory (absolute or relative to cwd).' },
      request: {
        type: 'string',
        description: 'Natural-language config request (for example: "add a step that finds emails").',
      },
    },
  },
  run: async (args) => {
    const listDir = resolveListDir(args.list);
    if (!existsSync(listDir)) {
      return { error: `List "${args.list}" not found.` };
    }

    const outboundPath = join(listDir, 'outbound.yaml');
    if (!existsSync(outboundPath)) {
      return { error: `Config file "outbound.yaml" not found for list "${args.list}".` };
    }

    return withActivityContext({ listDir, listName: args.list }, async () => {
      const previousContent = readFileSync(outboundPath, 'utf-8');
      const currentConfig = readYaml(outboundPath);
      if (currentConfig._raw) {
        return { error: 'Could not parse outbound.yaml.' };
      }

      ensureCanonicalCsvExists(listDir);
      const csvPath = getCanonicalCsvPath(listDir);
      const { headers, rows } = readCSV(csvPath);
      const csvState = {
        headers,
        row_count: rows.length,
        sample_rows: rows.slice(0, 5),
      };

      try {
        const authored = await authorConfig({
          request: String(args.request || ''),
          currentConfig,
          csvState,
        });

        writeYaml(outboundPath, authored.updatedConfig || {});
        const resolveResult = await resolveConfig(listDir);
        const persistedConfig = readYaml(outboundPath);
        if (persistedConfig._raw) {
          throw new Error('Authored config was written but could not be parsed afterward.');
        }

        const previousSerialized = JSON.stringify(currentConfig || {});
        const persistedSerialized = JSON.stringify(persistedConfig || {});
        if (previousSerialized === persistedSerialized) {
          const reasons = Array.isArray(authored.warnings) && authored.warnings.length > 0
            ? authored.warnings.join('; ')
            : authored.summary || 'No explanation provided by author-config.';
          throw new Error(`Config authoring produced no changes. Reason: ${reasons}`);
        }

        if (requestIncludesAny(args.request, ['rubric', 'score'])) {
          const rubricCount = countRubricCriteria(persistedConfig);
          if (rubricCount === 0) {
            throw new Error('Rubric was requested but no rubric criteria were persisted to outbound.yaml.');
          }
        }

        return {
          status: 'authored',
          list: args.list,
          summary: authored.summary,
          warnings: authored.warnings,
          resolve_result: resolveResult,
        };
      } catch (error) {
        writeFileSync(outboundPath, previousContent);
        return {
          error: error.message,
        };
      }
    });
  },
};
