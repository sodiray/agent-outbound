import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runGenerateStep } from '../dist/orchestrator/generate/runner.js';
import { ensureRecordColumns, openListDb } from '../dist/orchestrator/runtime/db.js';

const family = (familyId) => ({
  family_id: familyId,
  hypotheses: [
    { id: `${familyId}_one`, text: 'Operational follow-up can be reviewed.' },
    { id: `${familyId}_two`, text: 'Scheduling handoffs can be reviewed.' },
    { id: `${familyId}_three`, text: 'Administrative load can be reviewed.' },
    { id: `${familyId}_four`, text: 'Inquiry response flow can be reviewed.' },
  ],
  economic_calculators: ['admin_labor_leak', 'missed_lead_revenue'],
});

const diagnosticStep = {
  id: 'diagnostic_content_pack',
  kind: 'generate',
  depends_on: ['account_intelligence'],
  outputs: {
    preliminary_snapshot: { type: 'string' },
    permitted_claim_packet_json: { type: 'string' },
    catalog_evidence_json: { type: 'string' },
  },
};

test('generate refreshes declared dependencies and invalidates claim packets when classification changes', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-generate-current-state-'));
  mkdirSync(join(listDir, 'registries'));
  mkdirSync(join(listDir, 'assets'));
  writeFileSync(
    join(listDir, 'registries', 'diagnostic-families.json'),
    JSON.stringify({
      families: {
        fixture_vertical: family('fixture_vertical'),
        trades_field_services: family('trades_field_services'),
      },
    }),
  );
  writeFileSync(join(listDir, 'assets', 'proof-library.json'), JSON.stringify({ proofs: [] }));
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({
    db,
    columns: ['vertical', 'diagnostic_family', 'permitted_claim_packet_json', 'catalog_evidence_json'],
  });
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO records (
      _row_id, business_name, sequence_name, sequence_status,
      _created_at, _updated_at, created_at, updated_at
    ) VALUES (?, 'Current State HVAC', 'default', 'active', ?, ?, ?, ?)
  `).run('current_state_1', now, now, now, now);
  const staleRows = db.prepare('SELECT * FROM records WHERE _row_id = ?').all('current_state_1');
  const previousFixture = process.env.AO_STEP_FIXTURE;
  process.env.AO_STEP_FIXTURE = '1';

  try {
    const classification = await runGenerateStep({
      db,
      listDir,
      config: {},
      step: {
        id: 'account_intelligence',
        kind: 'generate',
        outputs: { vertical: { type: 'string' } },
      },
      rows: staleRows,
    });
    assert.equal(classification.processed, 1);
    const classified = db.prepare('SELECT vertical, extra_json FROM records WHERE _row_id = ?').get('current_state_1');
    assert.deepEqual(classified, { vertical: 'fixture_vertical', extra_json: '{}' });

    const first = await runGenerateStep({
      db,
      listDir,
      config: {},
      step: diagnosticStep,
      rows: staleRows,
    });
    assert.equal(first.processed, 1);
    const firstPacket = JSON.parse(
      db.prepare('SELECT permitted_claim_packet_json FROM records WHERE _row_id = ?').get('current_state_1').permitted_claim_packet_json,
    );
    assert.ok(firstPacket.permitted_claims.some((claim) => claim.claim_id === 'hyp_fixture_vertical_one'));
    assert.equal(firstPacket.permitted_claims.length, 8);

    db.prepare('UPDATE records SET vertical = ? WHERE _row_id = ?').run('trades_field_services', 'current_state_1');
    const second = await runGenerateStep({
      db,
      listDir,
      config: {},
      step: diagnosticStep,
      rows: staleRows,
    });
    assert.equal(second.updated, 1);
    const secondPacket = JSON.parse(
      db.prepare('SELECT permitted_claim_packet_json FROM records WHERE _row_id = ?').get('current_state_1').permitted_claim_packet_json,
    );
    assert.ok(secondPacket.permitted_claims.some((claim) => claim.claim_id === 'hyp_trades_field_services_one'));
    assert.equal(secondPacket.permitted_claims.length, 8);

    db.prepare(`
      INSERT INTO records (
        _row_id, business_name, sequence_name, sequence_status,
        _created_at, _updated_at, created_at, updated_at
      ) VALUES (?, 'Unclassified HVAC', 'default', 'active', ?, ?, ?, ?)
    `).run('withheld_packet_1', now, now, now, now);
    const withheld = await runGenerateStep({
      db,
      listDir,
      config: {},
      step: diagnosticStep,
      rows: db.prepare('SELECT * FROM records WHERE _row_id = ?').all('withheld_packet_1'),
    });
    assert.equal(withheld.failed, 1);
    const withheldAsset = db.prepare('SELECT status, reason FROM assets WHERE row_id = ? AND step_id = ?').get('withheld_packet_1', 'diagnostic_content_pack');
    assert.deepEqual(withheldAsset, {
      status: 'needs_repair',
      reason: 'withheld_claim_packet:missing_family_and_vertical',
    });
  } finally {
    if (previousFixture === undefined) delete process.env.AO_STEP_FIXTURE;
    else process.env.AO_STEP_FIXTURE = previousFixture;
    db.close();
  }
});
