import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const INTERNAL_DIR_NAME = '.outbound';
export const INTERNAL_DB_NAME = 'prospects.db';

export const getGlobalRoot = () => join(homedir(), '.agent-outbound');
export const getGlobalEnvPath = () => join(getGlobalRoot(), 'env');
export const getGlobalSuppressionDbPath = () => join(getGlobalRoot(), 'suppression.db');
export const getGlobalSettingsPath = () => join(getGlobalRoot(), 'settings.yaml');
export const getGlobalModelsPath = () => join(getGlobalRoot(), 'models.json');

export const resolveListDir = (listPath) => {
  const raw = String(listPath || '').trim();
  if (!raw) throw new Error('List path is required.');
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
};

export const getListName = (listDir) => basename(String(listDir || '').replace(/\/$/, ''));
export const getInternalDir = (listDir) => join(listDir, INTERNAL_DIR_NAME);
export const getDbPath = (listDir) => join(getInternalDir(listDir), INTERNAL_DB_NAME);
export const getActivityDir = (listDir) => join(getInternalDir(listDir), '.activity');
export const getActivityHistoryPath = (listDir) => join(getActivityDir(listDir), 'history.jsonl');
export const getActivitySocketPath = (listDir) => join(getActivityDir(listDir), 'current.sock');
export const getServeDir = (listDir) => join(getInternalDir(listDir), '.serve');
export const getServePidPath = (listDir) => join(getServeDir(listDir), 'pid');
export const getServePortPath = (listDir) => join(getServeDir(listDir), 'port');
export const getLogsDir = (listDir) => join(getInternalDir(listDir), 'logs');
export const getSnapshotsDir = (listDir) => join(getInternalDir(listDir), 'snapshots');
export const getSourcingLogPath = (listDir) => join(getLogsDir(listDir), 'sourcing.log');
export const getComplianceLogPath = (listDir) => join(getLogsDir(listDir), 'compliance.log');
export const getCrmLogPath = (listDir) => join(getLogsDir(listDir), 'crm.log');
export const getCostsLogPath = (listDir) => join(getLogsDir(listDir), 'costs.jsonl');

export const ensureGlobalDirs = () => {
  mkdirSync(getGlobalRoot(), { recursive: true, mode: 0o700 });
};

export const ensureListDirs = (listDir) => {
  mkdirSync(listDir, { recursive: true });
  mkdirSync(getInternalDir(listDir), { recursive: true });
  mkdirSync(getActivityDir(listDir), { recursive: true });
  mkdirSync(getServeDir(listDir), { recursive: true });
  mkdirSync(getLogsDir(listDir), { recursive: true });
  mkdirSync(getSnapshotsDir(listDir), { recursive: true });
};

export const resolveListPath = ({ listDir, filePath, allowRelative = false }) => {
  const ref = String(filePath || '').trim();
  if (!ref) return '';
  if (isAbsolute(ref)) return ref;
  if (allowRelative) return join(listDir, ref);
  throw new Error(`Path "${ref}" must be relative to the list directory.`);
};

export const ensureListScaffold = ({ listDir, description = '' }) => {
  ensureListDirs(listDir);

  const outboundPath = join(listDir, 'outbound.yaml');
  if (!existsSync(outboundPath)) {
    const name = getListName(listDir);
    const lines = [
      `# Outbound config for ${name}`,
      description ? `# ${description}` : '',
      '',
      'list:',
      `  name: ${name}`,
      '  territory: {}',
      '',
      'source:',
      '  identity: [business_name, address]',
      '  searches: []',
      '  filters: []',
      '',
      'enrich: []',
      '',
      'score:',
      '  fit:',
      '    description: ""',
      '  trigger:',
      '    description: ""',
      '  priority:',
      '    weight: { fit: 0.6, trigger: 0.4 }',
      '',
      'ai:',
      '  default_model: anthropic/claude-sonnet-4-6',
      '  defaults:',
      '    evaluation: anthropic/claude-haiku-4-5-20251001',
      '    copywriting: anthropic/claude-opus-4-6',
      '    research: anthropic/claude-sonnet-4-6',
      '',
      'sequences:',
      '  default:',
      '    steps: []',
      '',
      'channels: {}',
    ].filter(Boolean);
    writeFileSync(outboundPath, `${lines.join('\n')}\n`);
  }

  return { outboundPath };
};
