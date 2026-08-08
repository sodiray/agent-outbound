import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import { collectConfigToolRefs } from '../orchestrator/lib/tool-catalog.js';
import { getConfigPath, readConfig } from '../orchestrator/lib/config.js';
import { addIsoDays, computeStepSchedule, resolveWorkingDayConfig, toIsoDate, toZonedIsoDate } from '../orchestrator/lib/working-days.js';
import { getRecordById, openListDb, upsertRecord } from '../orchestrator/runtime/db.js';
import { listConnectedToolkits } from '../orchestrator/runtime/mcp.js';
import { getDbPath, getSnapshotsDir, resolveListDir } from '../orchestrator/runtime/paths.js';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';
import { assertConfigModelReferences } from '../orchestrator/lib/model-validation.js';
import { reviewStageFieldWarnings } from '../orchestrator/pipeline/review.js';
import { normalizeConfig } from '../schemas/config.js';
import { inspectFieldCheckValueFiles } from '../orchestrator/lib/field-check-values.js';
import { flattenPipelineSteps } from '../orchestrator/lib/subpipelines.js';

type SnapshotManifest = {
  id: string;
  label: string;
  created_at: string;
  db_file: string;
  config_file: string;
};

const nowIso = () => new Date().toISOString();

const getSnapshotManifestPath = (listDir: string, snapshotId: string) =>
  join(getSnapshotsDir(listDir), `${snapshotId}.json`);

const loadSnapshotManifest = (listDir: string, snapshotId: string): SnapshotManifest | null => {
  const path = getSnapshotManifestPath(listDir, snapshotId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const listSnapshotManifests = (listDir: string): SnapshotManifest[] => {
  const dir = getSnapshotsDir(listDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(dir, name), 'utf8')) as SnapshotManifest;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as SnapshotManifest[];
};

export const snapshotCreateCommand = ({ list, label = '' }: { list: string; label?: string }) => {
  const listDir = resolveListDir(list);
  const snapshotsDir = getSnapshotsDir(listDir);
  mkdirSync(snapshotsDir, { recursive: true });

  const createdAt = nowIso();
  const id = `snap_${createdAt.slice(0, 10).replace(/-/g, '')}_${randomUUID().slice(0, 8)}`;
  const dbFile = `${id}.db`;
  const configFile = `${id}.yaml`;
  const dbPath = getDbPath(listDir);
  const configPath = getConfigPath(listDir);
  if (!existsSync(dbPath) || !existsSync(configPath)) {
    throw new AgentOutboundError({
      code: 'NOT_FOUND',
      message: 'List database or config file not found for snapshot creation.',
      retryable: false,
      fields: { list: listDir },
    });
  }

  copyFileSync(dbPath, join(snapshotsDir, dbFile));
  copyFileSync(configPath, join(snapshotsDir, configFile));

  const manifest: SnapshotManifest = {
    id,
    label: String(label || id),
    created_at: createdAt,
    db_file: dbFile,
    config_file: configFile,
  };
  writeFileSync(getSnapshotManifestPath(listDir, id), `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    status: 'created',
    snapshot: manifest,
  };
};

export const snapshotListCommand = ({ list }: { list: string }) => {
  const listDir = resolveListDir(list);
  const snapshots = listSnapshotManifests(listDir)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return {
    count: snapshots.length,
    snapshots,
  };
};

export const snapshotRestoreCommand = ({ list, snapshotId }: { list: string; snapshotId: string }) => {
  const listDir = resolveListDir(list);
  const manifest = loadSnapshotManifest(listDir, snapshotId);
  if (!manifest) {
    throw new AgentOutboundError({
      code: 'SNAPSHOT_NOT_FOUND',
      message: `Snapshot not found: ${snapshotId}`,
      retryable: false,
      fields: { snapshot_id: snapshotId, list: listDir },
    });
  }
  const snapshotsDir = getSnapshotsDir(listDir);
  const snapshotDbPath = join(snapshotsDir, manifest.db_file);
  const snapshotConfigPath = join(snapshotsDir, manifest.config_file);
  if (!existsSync(snapshotDbPath) || !existsSync(snapshotConfigPath)) {
    throw new AgentOutboundError({
      code: 'SNAPSHOT_NOT_FOUND',
      message: `Snapshot files are missing for ${snapshotId}.`,
      retryable: false,
      fields: { snapshot_id: snapshotId, list: listDir },
    });
  }
  copyFileSync(snapshotDbPath, getDbPath(listDir));
  copyFileSync(snapshotConfigPath, getConfigPath(listDir));
  return {
    status: 'restored',
    snapshot: manifest,
  };
};

export const snapshotDeleteCommand = ({ list, snapshotId }: { list: string; snapshotId: string }) => {
  const listDir = resolveListDir(list);
  const manifest = loadSnapshotManifest(listDir, snapshotId);
  if (!manifest) {
    throw new AgentOutboundError({
      code: 'SNAPSHOT_NOT_FOUND',
      message: `Snapshot not found: ${snapshotId}`,
      retryable: false,
      fields: { snapshot_id: snapshotId, list: listDir },
    });
  }
  const snapshotsDir = getSnapshotsDir(listDir);
  const files = [
    join(snapshotsDir, manifest.db_file),
    join(snapshotsDir, manifest.config_file),
    getSnapshotManifestPath(listDir, snapshotId),
  ];
  for (const file of files) {
    if (existsSync(file)) rmSync(file, { force: true });
  }
  return {
    status: 'deleted',
    snapshot_id: snapshotId,
  };
};

const diffObjects = (before: any, after: any, basePath = ''): Array<{ path: string; kind: 'added' | 'removed' | 'changed'; before: any; after: any }> => {
  const output: Array<{ path: string; kind: 'added' | 'removed' | 'changed'; before: any; after: any }> = [];
  const beforeObj = before && typeof before === 'object' ? before : {};
  const afterObj = after && typeof after === 'object' ? after : {};
  const keys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
  for (const key of [...keys].sort()) {
    const path = basePath ? `${basePath}.${key}` : key;
    const left = (beforeObj as any)[key];
    const right = (afterObj as any)[key];
    const leftExists = Object.prototype.hasOwnProperty.call(beforeObj, key);
    const rightExists = Object.prototype.hasOwnProperty.call(afterObj, key);
    if (!leftExists && rightExists) {
      output.push({ path, kind: 'added', before: undefined, after: right });
      continue;
    }
    if (leftExists && !rightExists) {
      output.push({ path, kind: 'removed', before: left, after: undefined });
      continue;
    }
    if (
      left && typeof left === 'object' && !Array.isArray(left)
      && right && typeof right === 'object' && !Array.isArray(right)
    ) {
      output.push(...diffObjects(left, right, path));
      continue;
    }
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      output.push({ path, kind: 'changed', before: left, after: right });
    }
  }
  return output;
};

export const configDiffCommand = ({ list, filePath = '', snapshotId = '' }: { list: string; filePath?: string; snapshotId?: string }) => {
  const listDir = resolveListDir(list);
  const current = readConfig(listDir).config;
  let compared = current;
  let source = 'current';

  if (snapshotId) {
    const manifest = loadSnapshotManifest(listDir, snapshotId);
    if (!manifest) {
      throw new AgentOutboundError({
        code: 'SNAPSHOT_NOT_FOUND',
        message: `Snapshot not found: ${snapshotId}`,
        retryable: false,
      });
    }
    const raw = readFileSync(join(getSnapshotsDir(listDir), manifest.config_file), 'utf8');
    compared = yaml.load(raw) || {};
    source = `snapshot:${snapshotId}`;
  } else if (filePath) {
    const raw = readFileSync(filePath, 'utf8');
    compared = yaml.load(raw) || {};
    source = filePath;
  }

  const changes = diffObjects(current, compared);
  return {
    source,
    changes,
    change_count: changes.length,
  };
};

export const configValidateCommand = async ({ list, filePath = '' }: { list: string; filePath?: string }) => {
  const listDir = resolveListDir(list);
  const loaded: any = filePath
    ? (() => {
      const raw = readFileSync(filePath, 'utf8');
      const parsed = yaml.load(raw) || {};
      return normalizeConfig(parsed, { listDir });
    })()
    : readConfig(listDir);
  const errors = [...(Array.isArray(loaded?.errors) ? loaded.errors : [])];
  const warnings: string[] = [...(Array.isArray(loaded?.warnings) ? loaded.warnings : [])];
  const config = loaded?.config || {};
  const valueFiles = inspectFieldCheckValueFiles({ config, listDir });
  errors.push(...valueFiles.map((valueFile) => valueFile.error).filter(Boolean));
  try {
    assertConfigModelReferences(config);
  } catch (error) {
    errors.push(String((error as any)?.message || error));
  }

  const scoreDescription = String(config?.score?.description || '').trim();
  const scoreCriteria = Array.isArray(config?.score?.criteria) ? config.score.criteria : [];
  if (!scoreDescription && scoreCriteria.length === 0) errors.push('score.description or score.criteria must be provided.');

  const db = openListDb({ listDir, readonly: true });
  try {
    warnings.push(...reviewStageFieldWarnings({ db, config }));
  } finally {
    db.close();
  }

  const outputOwners = new Map<string, string>();
  const enrichSteps = flattenPipelineSteps(config).filter((step: any) => String(step?.kind || '') === 'enrich');
  for (const step of enrichSteps) {
    const stepId = String(step?.id || '').trim();
    const outputs = step?.outputs && typeof step.outputs === 'object' ? step.outputs : {};
    for (const field of Object.keys(outputs)) {
      if (outputOwners.has(field) && outputOwners.get(field) !== stepId) {
        errors.push(`Output collision on "${field}" between steps "${outputOwners.get(field)}" and "${stepId}".`);
      } else {
        outputOwners.set(field, stepId);
      }
    }
  }

  const refs = collectConfigToolRefs(config || {});
  const connected = new Set((await listConnectedToolkits().catch(() => [] as string[])).map((item) => String(item || '').toUpperCase()));
  for (const ref of refs) {
    const toolkits = Array.isArray(ref?.spec?.toolkits) ? ref.spec.toolkits : [];
    for (const toolkit of toolkits) {
      const normalized = String(toolkit || '').toUpperCase();
      if (!normalized) continue;
      if (!connected.has(normalized)) {
        warnings.push(`Toolkit "${normalized}" referenced by ${ref.path} is not connected.`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    value_files: valueFiles,
  };
};

export const recordRevertStepCommand = ({ list, rowId, stepId }: { list: string; rowId: string; stepId: string }) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const step: any = flattenPipelineSteps(config).find((item: any) => String(item?.id || '').trim() === String(stepId || '').trim() && String(item?.kind || '') === 'enrich');
  if (!step) {
    throw new AgentOutboundError({
      code: 'NOT_FOUND',
      message: `Enrichment step not found: ${stepId}`,
      retryable: false,
    });
  }
  const outputs = step?.outputs && typeof step.outputs === 'object' ? Object.keys(step.outputs) : [];
  const legacyColumns = step?.columns && typeof step.columns === 'object'
    ? Object.values(step.columns).map((name) => String(name || '').trim()).filter(Boolean)
    : [];
  const targetColumns = [...new Set([...outputs, ...legacyColumns])];
  const db = openListDb({ listDir, readonly: false });
  try {
    const row = getRecordById({ db, id: rowId });
    if (!row) {
      throw new AgentOutboundError({ code: 'NOT_FOUND', message: `Record not found: ${rowId}`, retryable: false });
    }
    const patch: Record<string, any> = { ...row, last_error: '' };
    for (const column of targetColumns) patch[column] = '';
    upsertRecord({ db, row: patch });
    db.prepare('DELETE FROM staleness WHERE record_id = ? AND step_id = ?').run(String(row._row_id || row.id || ''), String(stepId || ''));
    return {
      status: 'reverted',
      row_id: String(row._row_id || row.id || ''),
      step_id: String(stepId || ''),
      cleared_columns: targetColumns,
    };
  } finally {
    db.close();
  }
};

export const recordRevertScoreCommand = ({ list, rowId }: { list: string; rowId: string }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const row = getRecordById({ db, id: rowId });
    if (!row) {
      throw new AgentOutboundError({ code: 'NOT_FOUND', message: `Record not found: ${rowId}`, retryable: false });
    }
    const updated = {
      ...row,
      fit_score: 0,
      trigger_score: 0,
      priority_rank: 0,
      fit_reasoning: '',
      trigger_reasoning: '',
      fit_updated_at: '',
      trigger_updated_at: '',
      fit_score_updated_at: '',
      trigger_score_updated_at: '',
      trigger_score_peak: 0,
    };
    upsertRecord({ db, row: updated });
    db.prepare('DELETE FROM score_events WHERE row_id = ?').run(String(row._row_id || row.id || ''));
    db.prepare('DELETE FROM staleness WHERE record_id = ? AND step_id IN (?, ?)').run(String(row._row_id || row.id || ''), 'score:fit', 'score:trigger');
    return {
      status: 'reverted',
      row_id: String(row._row_id || row.id || ''),
      type: 'score',
    };
  } finally {
    db.close();
  }
};

export const recordRevertSequenceCommand = ({ list, rowId, toStep }: { list: string; rowId: string; toStep: number }) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const db = openListDb({ listDir, readonly: false });
  try {
    const row = getRecordById({ db, id: rowId });
    if (!row) throw new AgentOutboundError({ code: 'NOT_FOUND', message: `Record not found: ${rowId}`, retryable: false });
    const sequenceName = String(row.sequence_name || 'default');
    const sequence = config?.sequences?.[sequenceName] || config?.sequences?.default || { steps: [] };
    const steps = Array.isArray(sequence?.steps) ? sequence.steps : [];
    const targetStep = Math.max(1, Number(toStep || 1));
    const step = steps[targetStep - 1];
    if (!step) {
      throw new AgentOutboundError({
        code: 'INVALID_ARGUMENT',
        message: `Sequence step ${targetStep} does not exist in sequence "${sequenceName}".`,
        retryable: false,
      });
    }
    const timing = resolveWorkingDayConfig({
      ...sequence,
      timezone: sequence?.timezone || config?.operations?.timezone,
    });
    const launchedAtDate = toIsoDate(String(row.launched_at || ''))
      || addIsoDays(toZonedIsoDate(nowIso(), timing.timeZone), 0);
    const scheduled = computeStepSchedule({
      launchedAtDate,
      dayOffset: Number(step?.day || 0),
      workingDays: timing.workingDays,
      policy: timing.policy,
      timeZone: timing.timeZone,
    });
    const nextActionDate = 'date' in scheduled ? scheduled.date : '';
    const updated = {
      ...row,
      sequence_step: targetStep - 1,
      sequence_status: nextActionDate ? 'active' : 'completed',
      next_action_date: nextActionDate,
      last_error: '',
    };
    upsertRecord({ db, row: updated });
    return {
      status: 'reverted',
      row_id: String(row._row_id || row.id || ''),
      sequence_name: sequenceName,
      to_step: targetStep,
      next_action_date: nextActionDate,
    };
  } finally {
    db.close();
  }
};
