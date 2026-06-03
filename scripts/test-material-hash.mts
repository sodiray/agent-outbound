// Edge 1 proof: enrich staleness keyed on MATERIAL config only + cache_key + force.
// Run: npx tsx scripts/test-material-hash.mts <listDir>
import { randomUUID } from 'node:crypto';
import { openListDb } from '../src/orchestrator/runtime/db.js';
import { stableHash, getRecordRowId } from '../src/orchestrator/lib/record.js';
import { countEnrichWorkForStep, materialEnrichConfig } from '../src/orchestrator/enrichment/runner.js';

const listDir = process.argv[2];
const db = openListDb({ listDir, readonly: false });

const rows = db.prepare(
  `SELECT * FROM records WHERE (disqualified_at IS NULL OR disqualified_at='') AND (suppressed IS NULL OR suppressed=0) AND website IS NOT NULL AND website != '' LIMIT 5`
).all();

const stepId = 'mat_test_step';
const baseStep: any = {
  kind: 'enrich', id: stepId,
  tool: { server: 'firecrawl', tools: ['FIRECRAWL_EXTRACT'] },
  outputs: { services: { type: 'string', description: 'x' } },
  description: 'ORIGINAL description',
  concurrency: 6,
};

// Seed staleness rows as if this step had already run under the new code, with
// NO TTL (cache_ttl_seconds=0) to prove "no TTL = cache forever".
const seedStaleness = (hash: string, ttlSeconds: number) => {
  const now = new Date().toISOString();
  for (const r of rows) {
    db.prepare(`INSERT INTO staleness (id, record_id, step_id, dep_hash, cache_ttl, cache_ttl_seconds, updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(record_id, step_id) DO UPDATE SET dep_hash=excluded.dep_hash, cache_ttl_seconds=excluded.cache_ttl_seconds, updated_at=excluded.updated_at`)
      .run(randomUUID(), getRecordRowId(r), stepId, hash, '', ttlSeconds, now);
  }
};
const depHash = stableHash({ depValues: {}, config: materialEnrichConfig(baseStep) });
seedStaleness(depHash, 0);

const N = rows.length;
const check = (label: string, step: any, force = false) => {
  const w = countEnrichWorkForStep({ db, step, stepId, rows, force });
  console.log(`${label.padEnd(46)} would_enrich=${w.would_enrich} skip_fresh=${w.skip_fresh}`);
  return w;
};

let pass = true;
const assert = (cond: boolean, msg: string) => { if (!cond) { pass = false; console.log('  ✗ FAIL: ' + msg); } };

console.log(`seeded ${N} records, material hash, NO TTL\n`);

let w = check('1. baseline, no TTL (cache forever)', baseStep);
assert(w.skip_fresh === N && w.would_enrich === 0, 'no-TTL cache must skip all as fresh forever');

w = check('2. COSMETIC edit (description changed)', { ...baseStep, description: 'TOTALLY DIFFERENT prose' });
assert(w.skip_fresh === N && w.would_enrich === 0, 'cosmetic edit must NOT invalidate');

w = check('3. COSMETIC edit (concurrency/step_budget)', { ...baseStep, concurrency: 99, step_budget: 40 });
assert(w.skip_fresh === N && w.would_enrich === 0, 'concurrency/budget must NOT invalidate');

w = check('4. MATERIAL edit (outputs changed)', { ...baseStep, outputs: { services: { type: 'string' }, NEW: { type: 'boolean' } } });
assert(w.would_enrich === N && w.skip_fresh === 0, 'material (outputs) edit MUST re-run');

w = check('5. MATERIAL edit (tool args changed)', { ...baseStep, args: { foo: 'bar' } });
assert(w.would_enrich === N, 'material (args) edit MUST re-run');

w = check('6. cache_key set (new key)', { ...baseStep, cache_key: 'v2' });
assert(w.would_enrich === N, 'new cache_key MUST re-run');

w = check('7. --force on baseline', baseStep, true);
assert(w.would_enrich === N, '--force MUST re-run regardless of freshness');

// 8. Legacy full-config hash (written before material-hashing) must stay valid.
const legacyHash = stableHash({ depValues: {}, config: baseStep });
seedStaleness(legacyHash, 0);
w = check('8. legacy full-config hash (upgrade compat)', baseStep);
assert(w.skip_fresh === N && w.would_enrich === 0, 'legacy hash must be accepted (no upgrade re-enrich storm)');

db.close();
console.log('\n' + (pass ? '✅ ALL EDGE-1 ASSERTIONS PASSED' : '❌ SOME ASSERTIONS FAILED'));
process.exit(pass ? 0 : 1);
