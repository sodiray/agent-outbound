import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OVERRIDE_GATE,
  clearOverrides,
  getRecordById,
  insertOverride,
  listActiveOverrides,
  openListDb,
  overridesByRecordMap,
  reconcileOverrides,
  resolveRecordRef,
  upsertRecord,
} from '../src/orchestrator/runtime/db.ts';

const listDir = mkdtempSync(join(tmpdir(), 'ovr-test-'));
const db = openListDb({ listDir, readonly: false });

const seed = (rowId, name, extra = {}) => upsertRecord({ db, row: { _row_id: rowId, id: rowId, business_name: name, ...extra } });

try {
  seed('rec_alpha', 'Alpha Auto');
  seed('rec_beta', 'Beta Builders');
  seed('rec_beta2', 'Beta Builders'); // duplicate name → ambiguous
  seed('rec_gamma', 'Gamma Roofing', { disqualified_at: '2026-01-01T00:00:00Z', disqualified_gate: 'address_gate', disqualify_reason: 'residential' });

  // --- resolveRecordRef ---
  assert.equal(resolveRecordRef({ db, ref: 'rec_alpha' })._row_id, 'rec_alpha', 'resolve by id');
  assert.equal(resolveRecordRef({ db, ref: 'Alpha Auto' })._row_id, 'rec_alpha', 'resolve by exact name');
  assert.equal(resolveRecordRef({ db, ref: 'gamma roof' })._row_id, 'rec_gamma', 'resolve by substring (case-insensitive)');
  assert.throws(() => resolveRecordRef({ db, ref: 'Beta Builders' }), /Ambiguous/, 'ambiguous exact name throws');
  assert.throws(() => resolveRecordRef({ db, ref: 'nonexistent-xyz' }), /No record found/, 'no match throws');
  console.log('PASS resolveRecordRef');

  // --- keep override reconciles a disqualified record back into play ---
  insertOverride({ db, recordId: 'rec_gamma', kind: 'keep', stepId: 'address_gate', reason: 'verified commercial in person' });
  const keepSummary = reconcileOverrides({ db });
  assert.equal(keepSummary.keeps_restored, 1, 'one keep restored');
  const gamma = getRecordById({ db, id: 'rec_gamma' });
  assert.equal(String(gamma.disqualified_at || ''), '', 'gamma un-disqualified');
  assert.equal(String(gamma.disqualified_gate || ''), '', 'gamma gate cleared');
  console.log('PASS keep reconciliation (un-disqualify)');

  // --- keep map shape for scheduler ---
  const map1 = overridesByRecordMap({ db });
  assert.ok(map1.get('rec_gamma'), 'gamma in keep map');
  assert.equal(map1.get('rec_gamma').keepAll, false, 'scoped keep not keepAll');
  assert.ok(map1.get('rec_gamma').keepSteps.has('address_gate'), 'keepSteps has address_gate');
  console.log('PASS overridesByRecordMap (scoped)');

  // --- blanket keep ---
  insertOverride({ db, recordId: 'rec_alpha', kind: 'keep', stepId: '', reason: 'strategic account' });
  const map2 = overridesByRecordMap({ db });
  assert.equal(map2.get('rec_alpha').keepAll, true, 'blanket keep → keepAll');
  console.log('PASS blanket keep map');

  // --- drop override disqualifies a survivor ---
  insertOverride({ db, recordId: 'rec_beta', kind: 'drop', reason: 'not a real fit' });
  const dropSummary = reconcileOverrides({ db });
  assert.equal(dropSummary.drops_applied, 1, 'one drop applied');
  const beta = getRecordById({ db, id: 'rec_beta' });
  assert.equal(String(beta.disqualified_gate || ''), OVERRIDE_GATE, 'beta dropped by override gate');
  assert.ok(String(beta.disqualified_at || '').trim() !== '', 'beta has disqualified_at');
  // drop overrides are NOT keep directives
  assert.equal(overridesByRecordMap({ db }).get('rec_beta'), undefined, 'drop not in keep map');
  console.log('PASS drop reconciliation');

  // --- idempotency: reconcile again changes nothing ---
  const again = reconcileOverrides({ db });
  assert.equal(again.drops_applied, 0, 'idempotent drops');
  assert.equal(again.keeps_restored, 0, 'idempotent keeps');
  console.log('PASS reconcile idempotency');

  // --- listActiveOverrides ---
  assert.equal(listActiveOverrides({ db }).length, 3, 'three active overrides');

  // --- clear: removing a keep does NOT re-drop (state stays until next reapply) ---
  const cleared = clearOverrides({ db, recordId: 'rec_gamma' });
  assert.equal(cleared.length, 1, 'one cleared for gamma');
  reconcileOverrides({ db });
  const gammaAfter = getRecordById({ db, id: 'rec_gamma' });
  assert.equal(String(gammaAfter.disqualified_at || ''), '', 'gamma stays in play after clearing keep (re-evaluated only on reapply)');
  assert.equal(listActiveOverrides({ db }).length, 2, 'two active overrides after clear');
  assert.equal(overridesByRecordMap({ db }).get('rec_gamma'), undefined, 'gamma no longer in keep map');
  console.log('PASS clear override');

  // --- clear a drop restores the record ---
  clearOverrides({ db, recordId: 'rec_beta' });
  // clearing alone does not un-disqualify (override removed); but a fresh keep would.
  // Verify the drop override is gone from active set.
  assert.equal(listActiveOverrides({ db }).filter((o) => o.record_id === 'rec_beta').length, 0, 'beta drop cleared');
  console.log('PASS clear drop override');

  // --- multiple overrides on ONE lead: keep gate A, keep gate B, then drop ---
  // (the operator overrides one gate, the next gate fails and is overridden too,
  //  the lead scores, and is finally override-dropped — all three must persist.)
  seed('rec_multi', 'Multi Override Co');
  insertOverride({ db, recordId: 'rec_multi', kind: 'keep', stepId: 'gate_a', reason: 'bypass gate A' });
  insertOverride({ db, recordId: 'rec_multi', kind: 'keep', stepId: 'gate_b', reason: 'bypass gate B' });
  insertOverride({ db, recordId: 'rec_multi', kind: 'drop', reason: 'changed my mind after seeing score' });
  const multiActive = listActiveOverrides({ db }).filter((o) => o.record_id === 'rec_multi');
  assert.equal(multiActive.length, 3, 'three active overrides on one lead');
  const multiKeep = overridesByRecordMap({ db }).get('rec_multi');
  assert.ok(multiKeep.keepSteps.has('gate_a') && multiKeep.keepSteps.has('gate_b'), 'both kept gates merged');
  reconcileOverrides({ db });
  const multi = getRecordById({ db, id: 'rec_multi' });
  assert.equal(String(multi.disqualified_gate || ''), OVERRIDE_GATE, 'multi dropped by override despite keeps');
  console.log('PASS multiple overrides per lead (keep A + keep B + drop)');

  console.log('\nALL OVERRIDE VALIDATIONS PASSED');
} finally {
  db.close();
  rmSync(listDir, { recursive: true, force: true });
}
