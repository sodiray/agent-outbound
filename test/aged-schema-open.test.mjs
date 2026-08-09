import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { openListDb } from '../dist/orchestrator/runtime/db.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

/**
 * A database written before a column existed must still open. `CREATE TABLE IF NOT EXISTS`
 * is a no-op on an existing table, so a column named only in that definition never appears
 * on an older database — and any index built on it in the same exec fails and takes the
 * whole schema setup down before a run can start.
 */
const agedList = (drop) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-aged-schema-'));
  mkdirSync(join(listDir, '.outbound'), { recursive: true });
  openListDb({ listDir, readonly: false }).close();

  const db = new Database(join(listDir, '.outbound', 'prospects.db'));
  for (const view of db.prepare("SELECT name FROM sqlite_master WHERE type='view'").all()) {
    db.exec(`DROP VIEW IF EXISTS ${view.name}`);
  }
  drop(db);
  db.close();
  return listDir;
};

test('a database written before pipeline_events.contact_id still opens', () => {
  const listDir = agedList((db) => {
    db.exec('DROP INDEX IF EXISTS idx_pipeline_events_contact');
    db.exec('ALTER TABLE pipeline_events DROP COLUMN contact_id');
  });

  const db = openListDb({ listDir, readonly: false });
  const columns = db.prepare('PRAGMA table_info(pipeline_events)').all().map((c) => c.name);
  assert.ok(columns.includes('contact_id'), 'contact_id restored by the compatibility ALTER');

  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pipeline_events'")
    .all().map((row) => row.name);
  assert.ok(
    indexes.includes('idx_pipeline_events_contact'),
    'the index is still created, just after the column is guaranteed',
  );
  db.close();
});

test('a database written before the suppression identifier columns still opens', () => {
  const listDir = agedList((db) => {
    db.exec('DROP INDEX IF EXISTS idx_suppression_value');
    db.exec('ALTER TABLE suppression DROP COLUMN identifier_type');
    db.exec('ALTER TABLE suppression DROP COLUMN identifier_value');
  });

  const db = openListDb({ listDir, readonly: false });
  const columns = db.prepare('PRAGMA table_info(suppression)').all().map((c) => c.name);
  assert.ok(columns.includes('identifier_type') && columns.includes('identifier_value'));
  db.close();
});
