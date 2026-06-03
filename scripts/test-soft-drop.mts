// Edge 2 proof: committed records are review-flagged not dropped; filters idempotent.
// Builds a throwaway list with a single field_check drop-filter (no LLM, free).
// Run: npx tsx scripts/test-soft-drop.mts
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openListDb, upsertRecord } from '../src/orchestrator/runtime/db.js';
import { runPipeline } from '../src/orchestrator/pipeline/runner.js';

const dir = mkdtempSync(join(tmpdir(), 'softdrop-'));
mkdirSync(join(dir, '.outbound'), { recursive: true });
writeFileSync(join(dir, 'outbound.yaml'), `list:
  name: softdrop-test
source:
  identity: [name]
  dedup_key: name
pipeline:
  - kind: filter
    id: strict_gate
    type: field_check
    match: all
    conditions:
      - { field: business_name, operator: contains, value: "pass" }
    on_fail: drop
score:
  fit: { description: x, criteria: [] }
  trigger: { description: x, criteria: [] }
ai:
  default_model: deepinfra/meta-llama/Meta-Llama-3.1-8B-Instruct
`);

const db = openListDb({ listDir: dir, readonly: false });
// A: idle + fails  → expect hard drop
// B: committed (launched_at) + fails → expect review flag, NOT dropped
// C: idle + passes → expect survive + passed event (then idempotent skip)
// D: committed via sequence_status=active + fails → expect review flag
const seed = [
  { _row_id: 'A', business_name: 'A idle-fail', name: 'A', sequence_status: 'idle' },
  { _row_id: 'B', business_name: 'B committed-fail', name: 'B', sequence_status: 'active', launched_at: '2026-06-01T00:00:00Z' },
  { _row_id: 'C', business_name: 'C idle-pass', name: 'C', sequence_status: 'idle' },
  { _row_id: 'D', business_name: 'D active-fail', name: 'D', sequence_status: 'active' },
];
for (const r of seed) upsertRecord({ db, row: r });
db.close();

const state = () => {
  const db2 = openListDb({ listDir: dir, readonly: true });
  const rows = db2.prepare('SELECT _row_id, disqualified_gate, needs_review, review_reason FROM records ORDER BY _row_id').all();
  const passes = db2.prepare("SELECT record_id FROM pipeline_events WHERE step_id='strict_gate' AND passed=1").all().map((r: any) => r.record_id);
  db2.close();
  return { rows, passes };
};

let pass = true;
const assert = (cond: boolean, msg: string) => { if (!cond) { pass = false; console.log('  ✗ FAIL: ' + msg); } else console.log('  ✓ ' + msg); };

const r1 = await runPipeline({ listDir: dir });
console.log('\nRUN 1:', JSON.stringify({ by_step: r1.by_step, review_flagged: r1.review_flagged, skipped_passed: r1.skipped_passed }));
let s = state();
const byId: any = Object.fromEntries(s.rows.map((r: any) => [r._row_id, r]));
assert(byId.A.disqualified_gate === 'strict_gate' && byId.A.needs_review === 0, 'A (idle+fail) hard-dropped');
assert(byId.B.disqualified_gate === '' && byId.B.needs_review === 1, 'B (committed+fail) review-flagged, NOT dropped');
assert(byId.D.disqualified_gate === '' && byId.D.needs_review === 1, 'D (active+fail) review-flagged, NOT dropped');
assert(byId.C.disqualified_gate === '' && s.passes.includes('C'), 'C (pass) survived with passed event');
assert(r1.review_flagged === 2 && r1.by_step.strict_gate === 1, 'summary: 2 review-flagged, 1 dropped');

const r2 = await runPipeline({ listDir: dir });
console.log('RUN 2 (no change):', JSON.stringify({ by_step: r2.by_step, review_flagged: r2.review_flagged, skipped_passed: r2.skipped_passed }));
assert(r2.skipped_passed === 1, 'idempotent: C skipped (already passed) on re-run');

const r3 = await runPipeline({ listDir: dir, reapply: true });
console.log('RUN 3 (--reapply):', JSON.stringify({ skipped_passed: r3.skipped_passed }));
assert(r3.skipped_passed === 0, '--reapply: C re-evaluated (not skipped)');

console.log('\n' + (pass ? '✅ ALL EDGE-2 ASSERTIONS PASSED' : '❌ SOME ASSERTIONS FAILED'));
process.exit(pass ? 0 : 1);
