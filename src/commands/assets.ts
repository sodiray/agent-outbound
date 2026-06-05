import { spawn } from 'node:child_process';
import {
  type Asset,
  findAsset,
  getAssetsForRow,
  openListDb,
} from '../orchestrator/runtime/db.js';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';

const shortId = (value: unknown) => String(value || '').trim().slice(0, 12);

const preview = (value: unknown, max = 120) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
};

const parseJson = (value: unknown) => {
  try {
    return JSON.parse(String(value || '{}'));
  } catch {
    return {};
  }
};

const businessNameForRow = ({ db, rowId }: { db: unknown; rowId: string }) => {
  const row = (db as { prepare: (sql: string) => { get: (...params: unknown[]) => Record<string, unknown> | undefined } })
    .prepare('SELECT business_name FROM records WHERE _row_id = ? OR id = ? LIMIT 1')
    .get(rowId, rowId);
  return String(row?.business_name || '');
};

const assetForOutput = (asset: Asset, businessName = '') => ({
  asset_id: asset.asset_id,
  row_id: shortId(asset.row_id),
  full_row_id: asset.row_id,
  business_name: businessName,
  step_id: asset.step_id,
  label: asset.label,
  status: asset.status,
  is_reference: asset.is_reference,
  result: asset.result,
  outputs: parseJson(asset.outputs_json),
  outputs_pretty: JSON.stringify(parseJson(asset.outputs_json), null, 2),
  reason: asset.reason,
  created_at: asset.created_at,
  updated_at: asset.updated_at,
});

export const assetsListCommand = ({ list, label = '', step = '', row = '', status = '' }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    const clauses = ['1=1'];
    const params: unknown[] = [];
    if (label) {
      clauses.push('a.label = ?');
      params.push(String(label));
    }
    if (step) {
      clauses.push('a.step_id = ?');
      params.push(String(step));
    }
    if (row) {
      clauses.push('a.row_id = ?');
      params.push(String(row));
    }
    if (status) {
      clauses.push('a.status = ?');
      params.push(String(status));
    }
    const rows = db.prepare(`
      SELECT a.*, r.business_name
      FROM assets a
      LEFT JOIN records r ON r._row_id = a.row_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY a.created_at DESC, a.asset_id DESC
    `).all(...params);
    const items = rows.map((item: Record<string, unknown>) => ({
      row_id: shortId(item.row_id),
      business_name: String(item.business_name || ''),
      step_id: String(item.step_id || ''),
      label: String(item.label || ''),
      status: String(item.status || ''),
      is_reference: Boolean(item.is_reference),
      result: preview(item.result),
    }));
    return {
      rows: items,
      count: items.length,
    };
  } finally {
    db.close();
  }
};

export const assetsShowCommand = ({ list, rowId, step = '' }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    const businessName = businessNameForRow({ db, rowId: String(rowId || '').trim() });
    const assets = step
      ? [findAsset({ db, rowId, stepId: step })].filter(Boolean) as Asset[]
      : getAssetsForRow({ db, rowId });
    if (assets.length === 0) {
      throw new AgentOutboundError({
        code: 'NOT_FOUND',
        message: `Asset not found for row: ${rowId}`,
        retryable: false,
      });
    }
    return {
      row_id: String(rowId || ''),
      business_name: businessName,
      assets: assets.map((asset: Asset) => assetForOutput(asset, businessName)),
    };
  } finally {
    db.close();
  }
};

const openerCommand = (target: string) => {
  if (process.platform === 'darwin') return { command: 'open', args: [target] };
  if (process.platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', target] };
  return { command: 'xdg-open', args: [target] };
};

const openReference = (target: string) => new Promise<void>((resolve, reject) => {
  const opener = openerCommand(target);
  const child = spawn(opener.command, opener.args, { stdio: 'ignore', detached: true });
  child.once('error', reject);
  child.once('spawn', () => {
    child.unref();
    resolve();
  });
});

export const assetsOpenCommand = async ({ list, rowId, step }) => {
  if (!String(step || '').trim()) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: 'assets open requires --step ID.',
      retryable: false,
    });
  }
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: true });
  try {
    const asset = findAsset({ db, rowId, stepId: step });
    if (!asset) {
      throw new AgentOutboundError({
        code: 'NOT_FOUND',
        message: `Asset not found for row ${rowId} step ${step}`,
        retryable: false,
      });
    }
    if (!asset.is_reference) {
      return {
        opened: false,
        row_id: asset.row_id,
        step_id: asset.step_id,
        result: asset.result,
      };
    }
    const target = String(asset.result || '').trim();
    if (!target) {
      throw new AgentOutboundError({
        code: 'INVALID_ARGUMENT',
        message: `Reference asset has an empty result: ${asset.asset_id}`,
        retryable: false,
      });
    }
    await openReference(target);
    return {
      opened: true,
      row_id: asset.row_id,
      step_id: asset.step_id,
      reference: target,
    };
  } finally {
    db.close();
  }
};

export const assetsCommand = async ({ action, list, label = '', step = '', row = '', rowId = '', status = '' }) => {
  const sub = String(action || '').trim();
  if (sub === 'list') return assetsListCommand({ list, label, step, row, status });
  if (sub === 'show') return assetsShowCommand({ list, rowId: rowId || row, step });
  if (sub === 'open') return assetsOpenCommand({ list, rowId: rowId || row, step });
  throw new AgentOutboundError({
    code: 'INVALID_ARGUMENT',
    message: `Unknown assets subcommand: ${sub}`,
    retryable: false,
  });
};
