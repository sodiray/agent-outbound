import { assignTerritories } from '../orchestrator/territories/assign.js';
import { polygonAreaKm2 } from '../orchestrator/lib/geo.js';
import { readConfig } from '../orchestrator/lib/config.js';
import {
  getTerritoryMembership,
  getTerritoryNotes,
  insertTerritoryNote,
  openListDb,
} from '../orchestrator/runtime/db.js';
import { leadStatus, leadStatusCaseSql } from '../orchestrator/runtime/status.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';

const territoryById = (config: any, territoryId: string) => {
  const territory = (Array.isArray(config?.territories) ? config.territories : [])
    .find((item: any) => String(item?.id || '') === String(territoryId || ''));
  if (!territory) throw new Error(`Territory not found: ${territoryId}`);
  return territory;
};

const territoryCounts = ({ db, territoryId }: { db: any; territoryId: string }) => {
  const row = db.prepare(`
    SELECT COUNT(*) AS lead_count,
      SUM(CASE WHEN ${leadStatusCaseSql({ alias: 'r' })} = 'qualified' THEN 1 ELSE 0 END) AS qualified_count
    FROM lead_territories lt
    JOIN records r ON r._row_id = lt.row_id
    WHERE lt.territory_id = ?
  `).get(String(territoryId));
  return {
    lead_count: Number(row?.lead_count || 0),
    qualified_count: Number(row?.qualified_count || 0),
  };
};

const territoryView = ({ db, territory }: { db: any; territory: any }) => {
  const counts = territoryCounts({ db, territoryId: String(territory.id || '') });
  return {
    id: String(territory.id || ''),
    name: String(territory.name || ''),
    description: String(territory.description || ''),
    color: String(territory.color || ''),
    lead_count: counts.lead_count,
    qualified_count: counts.qualified_count,
    area_km2: polygonAreaKm2(territory.polygon || []),
  };
};

export const territoriesListCommand = ({ list }: { list: string }) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const db = openListDb({ listDir, readonly: false });
  try {
    return {
      territories: (Array.isArray(config?.territories) ? config.territories : []).map((territory: any) => territoryView({ db, territory })),
    };
  } finally {
    db.close();
  }
};

export const territoriesAssignCommand = ({ list }: { list: string }) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const db = openListDb({ listDir, readonly: false });
  try {
    return assignTerritories({ listDir, config, db });
  } finally {
    db.close();
  }
};

export const territoriesNoteCommand = ({ list, territoryId, body, by = '' }: { list: string; territoryId: string; body: string; by?: string }) => {
  if (!String(body || '').trim()) throw new Error('territories note requires --body.');
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  territoryById(config, territoryId);
  const db = openListDb({ listDir, readonly: false });
  try {
    return { note: insertTerritoryNote({ db, territoryId, body, createdBy: by }) };
  } finally {
    db.close();
  }
};

export const territoriesShowCommand = ({ list, territoryId }: { list: string; territoryId: string }) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const territory = territoryById(config, territoryId);
  const db = openListDb({ listDir, readonly: false });
  try {
    const membership = getTerritoryMembership({ db }).get(String(territoryId)) || new Set();
    const records = db.prepare(`
      SELECT _row_id, business_name, address, priority_rank, disqualified_at, suppressed
      FROM records
      WHERE _row_id IN (${[...membership].map(() => '?').join(',') || "''"})
      ORDER BY priority_rank DESC, business_name COLLATE NOCASE
    `).all(...[...membership]);
    return {
      territory: territoryView({ db, territory }),
      notes: getTerritoryNotes({ db, territoryId }),
      lead_count: membership.size,
      leads: records.map((record: any) => ({
        row_id: String(record._row_id || ''),
        business_name: String(record.business_name || ''),
        address: String(record.address || ''),
        priority_rank: Number(record.priority_rank || 0),
        lead_status: leadStatus(record),
      })),
    };
  } finally {
    db.close();
  }
};
