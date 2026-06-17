import { pointInPolygon } from '../lib/geo.js';
import { readConfig } from '../lib/config.js';
import { openListDb, setLeadTerritories } from '../runtime/db.js';

const finiteNumber = (value: any) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const locatedRecords = ({ db, rowIds = null }: { db: any; rowIds?: string[] | null }) => {
  if (Array.isArray(rowIds)) {
    const ids = [...new Set(rowIds.map((id) => String(id || '').trim()).filter(Boolean))];
    if (ids.length === 0) return [];
    return db.prepare(`
      SELECT _row_id, latitude, longitude
      FROM records
      WHERE _row_id IN (${ids.map(() => '?').join(',')})
    `).all(...ids);
  }
  return db.prepare(`
    SELECT _row_id, latitude, longitude
    FROM records
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL
  `).all();
};

const countAssignments = ({ rows, territories, activeDb, at }: { rows: any[]; territories: any[]; activeDb: any; at: string }) => rows.reduce((summary, row) => {
  const lat = finiteNumber(row.latitude);
  const lng = finiteNumber(row.longitude);
  if (lat === null || lng === null) return summary;
  const point = { lat, lng };
  const territoryIds = territories
    .filter((territory: any) => pointInPolygon(point, territory.polygon || []))
    .map((territory: any) => String(territory.id || '').trim())
    .filter(Boolean);
  setLeadTerritories({ db: activeDb, rowId: String(row._row_id), territoryIds, at });
  territoryIds.forEach((territoryId) => {
    summary.byTerritory[territoryId] = Number(summary.byTerritory[territoryId] || 0) + 1;
  });
  return {
    assigned: summary.assigned + (territoryIds.length > 0 ? 1 : 0),
    byTerritory: summary.byTerritory,
  };
}, {
  assigned: 0,
  byTerritory: Object.fromEntries(territories.map((territory: any) => [String(territory.id || ''), 0])),
});

export const assignTerritories = ({ listDir, config = null, db = null, rowIds = null }: { listDir: string; config?: any; db?: any; rowIds?: string[] | null }) => {
  const ownsDb = !db;
  const activeDb = db || openListDb({ listDir, readonly: false });
  try {
    const activeConfig = config || readConfig(listDir).config;
    const territories = Array.isArray(activeConfig?.territories) ? activeConfig.territories : [];
    const rows = locatedRecords({ db: activeDb, rowIds });
    const at = new Date().toISOString();
    return countAssignments({ rows, territories, activeDb, at });
  } finally {
    if (ownsDb) activeDb.close();
  }
};
