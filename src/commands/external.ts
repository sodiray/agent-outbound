import { readFileSync } from 'node:fs';
import { resolveListDir } from '../orchestrator/runtime/paths.js';
import { openListDb } from '../orchestrator/runtime/db.js';
import { readConfig } from '../orchestrator/lib/config.js';
import { ingestExternalEvents, listExternalEvents, resolveExternalEvent } from '../orchestrator/runtime/external-events.js';
import { listExternalOperations, reconcileExternalOperation } from '../orchestrator/runtime/external-operations.js';
import { listEventTurns } from '../orchestrator/pipeline/on-event-turns.js';

export const externalCommand = ({ list, group, action, file = '', source = '', id = '', recordId = '', status = '' }: {
  list: string; group: string; action: string; file?: string; source?: string; id?: string; recordId?: string; status?: string;
}) => {
  if ((group === 'events' && !['ingest','list','resolve'].includes(action)) || (group === 'operations' && !['list','reconcile'].includes(action))) throw new Error('Unknown external command action.');
  const listDir = resolveListDir(list);
  const loaded = readConfig(listDir);
  if (loaded.errors.length) throw new Error(`Invalid config: ${loaded.errors.join('; ')}`);
  const input = file ? JSON.parse(readFileSync(file, 'utf8')) : null;
  if (['ingest','reconcile'].includes(action) && !file) throw new Error('--file is required.');
  const db = openListDb({ listDir, readonly: action === 'list' });
  try {
    if (group === 'operations') return action === 'list' ? { items: listExternalOperations(db) } : reconcileExternalOperation({ db, config: loaded.config, listDir, receipt: input });
    if (action === 'list') return { items: listExternalEvents(db, status) };
    if (action === 'resolve') return resolveExternalEvent({ db, config: loaded.config, listDir, source, id, recordId });
    return ingestExternalEvents({ db, config: loaded.config, listDir, events: Array.isArray(input) ? input : [input] });
  } finally { db.close(); }
};

export const turnsCommand = ({ list, recordId = '', blockId = '' }: { list: string; recordId?: string; blockId?: string }) => {
  const listDir = resolveListDir(list);
  const db = openListDb({ listDir, readonly: false });
  try {
    const turns = listEventTurns({ db, recordId, blockId });
    return { count: turns.length, turns };
  } finally { db.close(); }
};
