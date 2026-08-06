import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildEnrichEvidencePatch,
  contentHashFromBody,
} from '../dist/orchestrator/policy/evidence.js';
import {
  ensureRecordColumns,
  openListDb,
  resolveRawContentBody,
  storeRawContent,
} from '../dist/orchestrator/runtime/db.js';

const insertRecord = ({ db, id }) => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, 'Acme', 'default', 'idle', ?, ?, ?, ?)
  `).run(id, now, now, now, now);
};

test('content-addressed evidence stores repeated bodies once and keeps snapshots compact', () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-content-addressed-'));
  const db = openListDb({ listDir });
  const body = 'Acme has after-hours dispatch. '.repeat(120);
  try {
    const makePatch = () => buildEnrichEvidencePatch({
      record: { _row_id: 'acct_raw', website: 'https://acme.example' },
      step_id: 'site_scrape',
      step_config: { output_map: { site_text: 'markdown' } },
      outputs: { site_text: body },
      provider: 'firecrawl',
      storeRawContent: (content) => storeRawContent({ db, content }),
    });
    const first = makePatch();
    const second = makePatch();
    const hash = contentHashFromBody(body);
    const count = db.prepare('SELECT COUNT(*) AS count FROM raw_content WHERE content_hash = ?').get(hash);
    assert.equal(Number(count.count), 1);
    assert.equal(resolveRawContentBody({ db, contentHash: hash }), body);

    for (const patch of [first, second]) {
      const snapshot = JSON.parse(String(patch.observations_json)).snapshots.at(-1);
      assert.equal(snapshot.content_hash, hash);
      assert.equal(Object.hasOwn(snapshot, 'body'), false);
      assert.ok(snapshot.excerpt.length < body.length);
      assert.ok(snapshot.excerpt.length <= 2001);
      assert.equal(patch.source_snapshots_json, '');
      assert.equal(patch.retrieval_snapshots_json, '');
      assert.equal(patch.last_retrieval_snapshot_json, '');
    }
  } finally {
    db.close();
  }
});

test('openListDb migrates legacy four-column snapshots into raw_content', () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-content-migration-'));
  const body = 'Legacy full retrieval body. '.repeat(150);
  const hash = contentHashFromBody(body);
  const legacySnapshot = {
    source_id: 'ret_legacy',
    provider: 'firecrawl',
    retrieved_at: '2026-08-01T00:00:00.000Z',
    raw_ref: 'https://acme.example',
    content_hash: hash,
    body,
    excerpt: body,
    kind: 'retrieval',
  };
  const initial = openListDb({ listDir });
  try {
    ensureRecordColumns({
      db: initial,
      columns: [
        'source_snapshots_json',
        'retrieval_snapshots_json',
        'last_retrieval_snapshot_json',
      ],
    });
    insertRecord({ db: initial, id: 'acct_legacy' });
    initial.prepare(`
      UPDATE records SET
        observations_json = ?,
        source_snapshots_json = ?,
        retrieval_snapshots_json = ?,
        last_retrieval_snapshot_json = ?
      WHERE _row_id = ?
    `).run(
      JSON.stringify({ observations: [], snapshots: [legacySnapshot] }),
      JSON.stringify([legacySnapshot]),
      JSON.stringify([legacySnapshot]),
      JSON.stringify(legacySnapshot),
      'acct_legacy',
    );
  } finally {
    initial.close();
  }

  const migrated = openListDb({ listDir });
  try {
    const row = migrated.prepare(`
      SELECT observations_json, source_snapshots_json, retrieval_snapshots_json, last_retrieval_snapshot_json
      FROM records WHERE _row_id = ?
    `).get('acct_legacy');
    const snapshots = JSON.parse(row.observations_json).snapshots;
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].content_hash, hash);
    assert.equal(Object.hasOwn(snapshots[0], 'body'), false);
    assert.ok(snapshots[0].excerpt.length <= 2001);
    assert.equal(row.source_snapshots_json, '');
    assert.equal(row.retrieval_snapshots_json, '');
    assert.equal(row.last_retrieval_snapshot_json, '');
    assert.equal(resolveRawContentBody({ db: migrated, contentHash: hash }), body);
  } finally {
    migrated.close();
  }
});
