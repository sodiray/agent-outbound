/**
 * Simple YAML reading/writing.
 * Uses js-yaml if available, falls back to JSON for resolved configs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';

/**
 * Read a YAML file. For now, delegates to a simple parser.
 * TODO: Add js-yaml dependency for full YAML support.
 * The resolved config is machine-generated so we control the format.
 */
export const readYaml = (filePath) => {
  const text = readFileSync(filePath, 'utf-8');
  const withoutLineComments = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('#'))
    .join('\n')
    .trim();
  // For resolved configs (which we generate), use JSON-compatible YAML
  // For human configs, we need a real YAML parser
  try {
    // Try JSON first (resolved configs can be JSON)
    return JSON.parse(withoutLineComments || text);
  } catch {
    try {
      const parsed = yaml.load(text);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return { _raw: text };
    }
  }
};

/**
 * Write a resolved config as JSON (which is valid YAML).
 * Adds a comment header noting it's auto-generated.
 */
export const writeResolvedConfig = (filePath, config) => {
  const header = `# Auto-generated from outbound.yaml (source + enrich + rubric + sequence). Do not edit directly.\n# Resolved at: ${new Date().toISOString()}\n`;
  writeFileSync(filePath, header + JSON.stringify(config, null, 2) + '\n');
};

/**
 * Write a YAML file.
 *
 * @param {string} filePath
 * @param {object} data
 */
export const writeYaml = (filePath, data) => {
  const serialized = yaml.dump(data, {
    lineWidth: 120,
    noRefs: true,
    quotingType: '"',
  });
  writeFileSync(filePath, serialized);
};
