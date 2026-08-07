/**
 * RES-CLASSIFICATION-NORMAL-PATH: re-score on evidence mutation.
 *
 * When enrich success writes a material retrieval snapshot, clear score:*
 * staleness and set score_status=stale so the next scoring pass re-runs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  markScoringStale,
  evidencePatchIsMaterialRetrieval,
  scoringStaleRecordPatch,
} from '../dist/orchestrator/enrichment/runner.js';
import {
  buildEnrichEvidencePatch,
} from '../dist/orchestrator/policy/evidence.js';
import {
  openListDb,
  ensureRecordColumns,
} from '../dist/orchestrator/runtime/db.js';
import { executeStepBatch } from '../dist/orchestrator/pipeline/step-executor.js';

test('evidencePatchIsMaterialRetrieval: retrieval yes, tool_failure no', () => {
  const ok = buildEnrichEvidencePatch({
    record: { _row_id: 'r1', website: 'https://x.test' },
    step_id: 'site_scrape',
    step_config: {
      action: 'tool_call',
      tool: { server: 'firecrawl', tools: ['FIRECRAWL_SCRAPE'] },
      output_map: { site_text: 'data.markdown' },
    },
    outputs: { site_text: '# HVAC Boise\nAfter-hours emergency.' },
    provider: 'firecrawl',
    failed: false,
  });
  assert.equal(evidencePatchIsMaterialRetrieval(ok), true);

  const fail = buildEnrichEvidencePatch({
    record: { _row_id: 'r1' },
    step_id: 'site_scrape',
    step_config: { action: 'tool_call', tool: { server: 'firecrawl', tools: ['FIRECRAWL_SCRAPE'] } },
    error: 'timeout',
    failed: true,
  });
  assert.equal(evidencePatchIsMaterialRetrieval(fail), false);
});

test('declared but unwritten pipeline output fails instead of passing silently', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-output-guard-'));
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO records (
        _row_id, business_name, sequence_name, sequence_status,
        _created_at, _updated_at, created_at, updated_at
      ) VALUES ('acct_output_guard', 'Peak HVAC', 'default', 'idle', ?, ?, ?, ?)
    `).run(now, now, now, now);
    const record = db.prepare('SELECT * FROM records WHERE _row_id = ?').get('acct_output_guard');
    const outcomes = await executeStepBatch(
      { db, listDir, config: {}, aiConfig: {}, mcp: null, toolCatalog: null },
      {
        id: 'declared_output_wait',
        kind: 'wait',
        outputs: { preliminary_snapshot: { type: 'string' } },
      },
      'declared_output_wait',
      [record],
    );
    const outcome = outcomes.get('acct_output_guard');
    assert.equal(outcome?.passed, false);
    assert.equal(outcome?.errored, true);
    assert.equal(outcome?.reason, 'declared_outputs_unwritten:preliminary_snapshot');
  } finally {
    db.close();
  }
});

test('markScoringStale deletes score:* staleness rows and scoringStaleRecordPatch sets status', () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-rescore-'));
  const db = openListDb({ listDir });
  const now = new Date().toISOString();
  try {
    ensureRecordColumns({
      db,
      columns: [
        { name: 'score_status', type: 'TEXT' },
        { name: 'fit_score', type: 'REAL' },
      ],
    });
    db.prepare(`
      INSERT INTO records (
        _row_id, business_name, sequence_name, sequence_status, fit_score, score_status,
        _created_at, _updated_at, created_at, updated_at
      ) VALUES (
        'acct_rescore', 'Peak HVAC', 'default', 'idle', 70, 'fresh',
        ?, ?, ?, ?
      )
    `).run(now, now, now, now);

    // Seed score caches as if a prior score run completed.
    for (const stepId of ['score:score', 'score:fit', 'score:trigger', 'score:custom']) {
      db.prepare(`
        INSERT INTO staleness (id, record_id, step_id, dep_hash, cache_ttl, cache_ttl_seconds, updated_at)
        VALUES (?, ?, ?, ?, '', 0, ?)
      `).run(randomUUID(), 'acct_rescore', stepId, 'hash_prior', now);
    }
    // Unrelated enrich staleness must survive.
    db.prepare(`
      INSERT INTO staleness (id, record_id, step_id, dep_hash, cache_ttl, cache_ttl_seconds, updated_at)
      VALUES (?, ?, ?, ?, '', 0, ?)
    `).run(randomUUID(), 'acct_rescore', 'site_scrape', 'enrich_hash', now);

    const deleted = markScoringStale({ db, recordId: 'acct_rescore' });
    assert.ok(deleted >= 3, `expected ≥3 score rows deleted, got ${deleted}`);

    const remaining = db.prepare('SELECT step_id FROM staleness WHERE record_id = ?').all('acct_rescore');
    assert.deepEqual(remaining.map((r) => r.step_id).sort(), ['site_scrape']);

    const patch = scoringStaleRecordPatch();
    assert.equal(patch.score_status, 'stale');
    db.prepare(`UPDATE records SET score_status = ? WHERE _row_id = ?`).run(patch.score_status, 'acct_rescore');
    const row = db.prepare('SELECT score_status FROM records WHERE _row_id = ?').get('acct_rescore');
    assert.equal(row.score_status, 'stale');
  } finally {
    db.close();
  }
});

test('success evidence patch + markScoringStale mirrors enrich success wiring', () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-rescore2-'));
  const db = openListDb({ listDir });
  const now = new Date().toISOString();
  try {
    ensureRecordColumns({
      db,
      columns: [
        { name: 'score_status', type: 'TEXT' },
        { name: 'site_text', type: 'TEXT' },
        { name: 'observations_json', type: 'TEXT' },
      ],
    });
    db.prepare(`
      INSERT INTO records (
        _row_id, business_name, sequence_name, sequence_status,
        _created_at, _updated_at, created_at, updated_at
      ) VALUES (
        'acct_ev', 'Acme', 'default', 'idle',
        ?, ?, ?, ?
      )
    `).run(now, now, now, now);
    db.prepare(`
      INSERT INTO staleness (id, record_id, step_id, dep_hash, cache_ttl, cache_ttl_seconds, updated_at)
      VALUES (?, ?, 'score:score', 'old', '', 0, ?)
    `).run(randomUUID(), 'acct_ev', now);

    const evidence = buildEnrichEvidencePatch({
      record: { _row_id: 'acct_ev', website: 'https://acme.test' },
      step_id: 'site_scrape',
      step_config: {
        action: 'tool_call',
        tool: { server: 'firecrawl', tools: ['FIRECRAWL_SCRAPE'] },
        output_map: { site_text: 'markdown' },
      },
      outputs: { site_text: 'Acme Plumbing — emergency service Boise ID.' },
      provider: 'firecrawl',
    });
    assert.equal(evidencePatchIsMaterialRetrieval(evidence), true);
    markScoringStale({ db, recordId: 'acct_ev' });
    const scoreRows = db.prepare(
      `SELECT COUNT(*) AS n FROM staleness WHERE record_id = ? AND step_id LIKE 'score:%'`,
    ).get('acct_ev');
    assert.equal(Number(scoreRows.n), 0);

    const stalePatch = scoringStaleRecordPatch();
    db.prepare(`
      UPDATE records SET
        site_text = ?,
        observations_json = ?,
        score_status = ?
      WHERE _row_id = ?
    `).run(
      'Acme Plumbing — emergency service Boise ID.',
      String(evidence.observations_json || ''),
      stalePatch.score_status,
      'acct_ev',
    );
    const row = db.prepare('SELECT score_status, observations_json FROM records WHERE _row_id = ?').get('acct_ev');
    assert.equal(row.score_status, 'stale');
    const snap = JSON.parse(row.observations_json).snapshots.at(-1);
    assert.notEqual(snap.kind, 'tool_failure');
  } finally {
    db.close();
  }
});
