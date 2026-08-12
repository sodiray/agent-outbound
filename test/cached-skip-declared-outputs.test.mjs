import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  declaredOutputWriteFailures,
  shouldGuardDeclaredOutputWrites,
} from '../dist/orchestrator/pipeline/step-executor.js';
import {
  declaredOutputWritesFor,
  executeEnrichmentStepOnRecords,
} from '../dist/orchestrator/enrichment/runner.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';

// A step declaring an output means it MAY write that field, never that every
// record must receive a value. A business with no Google reviews has no
// user_rating_count and a business with no site has no website; blank is the
// correct answer for both. These tests pin the path that used to turn those
// blanks into hard errors that stranded every dependent step.

const STEP_CONFIG = {
  outputs: {
    company_resolution: { type: 'string', description: 'resolved | unresolvable' },
    place_id: { type: 'string', description: 'places id when resolved' },
    website: { type: 'string', description: 'business website when resolved' },
    user_rating_count: { type: 'integer', description: 'review count when resolved' },
  },
};

const OUTPUT_NAMES = Object.keys(STEP_CONFIG.outputs);

// A resolved business that genuinely has no website and no reviews.
const RESOLVED_WITH_BLANK_OPTIONALS = {
  company_resolution: 'resolved',
  place_id: 'ChIJexample',
  website: '',
  user_rating_count: '',
};

test('a cached enrich skip claims nothing, so blank optional outputs are not failures', () => {
  // What the fresh/memoization branch now attaches: it executed nothing, so it
  // claims nothing, and every entry is provided:false.
  const writes = declaredOutputWritesFor({ stepConfig: STEP_CONFIG, outputs: {} });

  assert.deepEqual(Object.keys(writes).sort(), [...OUTPUT_NAMES].sort());
  assert.ok(
    Object.values(writes).every((write) => write.provided === false),
    'a step that did not execute must not claim it provided any output',
  );

  const failures = declaredOutputWriteFailures({
    outputNames: OUTPUT_NAMES,
    record: RESOLVED_WITH_BLANK_OPTIONALS,
    declaredOutputWrites: writes,
  });

  assert.deepEqual(failures, [], 'blank optional outputs on a cached skip are not write failures');
});

test('without write claims the guard demands every declared output — the defect being fixed', () => {
  // Regression pin, not endorsement: this is the strict fallback that fires
  // when an outcome carries no write map. It stays as a backstop for genuine
  // lost writes, which is exactly why cached paths must attach their claims
  // rather than leaving the map undefined.
  const failures = declaredOutputWriteFailures({
    outputNames: OUTPUT_NAMES,
    record: RESOLVED_WITH_BLANK_OPTIONALS,
    declaredOutputWrites: undefined,
  });

  assert.deepEqual(failures, ['website', 'user_rating_count']);
});

test('memoization_hit does not escape the declared-output guard by name', () => {
  // 'skipped:fresh' escapes the guard because it starts with "skipped".
  // 'memoization_hit' does not, and must not be given an exemption: generate
  // and compose emit the same reason on cache hits WITH real write claims,
  // and their check is meaningful. Cached paths earn safety by attaching
  // claims, not by renaming their outcome.
  assert.equal(shouldGuardDeclaredOutputWrites({ passed: true, reason: 'skipped:fresh' }), false);
  assert.equal(shouldGuardDeclaredOutputWrites({ passed: true, reason: 'memoization_hit' }), true);
  assert.equal(shouldGuardDeclaredOutputWrites({ passed: true, reason: '' }), true);
});

test('the real memoized enrich path attaches provided:false claims for blank optional outputs', async () => {
  // This is the test that bites. The three above pin the semantics of the pure
  // functions; this one drives executeEnrichmentStepOnRecords through its
  // fresh/memoization branch and fails if that branch stops attaching claims —
  // which is the exact regression that hard-errored 56 resolved businesses.
  const root = mkdtempSync(join(tmpdir(), 'agent-outbound-cached-skip-'));
  const db = openListDb({ listDir: root, readonly: false });
  try {
    ensureRecordColumns({ db, columns: ['website', 'resolution', 'rating_count'] });
    upsertRecord({ db, row: { _row_id: 'blank-optional-record', business_name: 'No Reviews LLC', website: 'https://one.example' } });

    const step = {
      kind: 'enrich',
      id: 'company_lookup',
      inputs: { subject: { from: 'website' } },
      outputs: {
        resolution: { type: 'string', description: 'Settled resolution.' },
        rating_count: { type: 'integer', description: 'Review count when the business has reviews.' },
      },
    };

    // The provider resolves the business but returns no rating_count — the
    // real shape for a business with no Google reviews.
    const executeAction = async () => ({ outputs: { resolution: 'resolved' }, usage: {} });
    const row = () => db.prepare('SELECT * FROM records WHERE _row_id = ?').get('blank-optional-record');
    const run = () => executeEnrichmentStepOnRecords({
      db, listDir: root, config: { ai: {} }, mcp: null, toolCatalog: null, step, rows: [row()], executeAction, force: false,
    });

    await run();
    const second = await run();

    assert.equal(second.memoization_hits, 1, 'second pass must be a cache hit');
    assert.equal(second.non_execution_reasons['blank-optional-record'], 'memoization_hit');

    const claims = second.declared_output_writes['blank-optional-record'];
    assert.ok(claims, 'a cached skip must still attach declared-output write claims');
    assert.ok(
      Object.values(claims).every((write) => write.provided === false),
      'a step that did not execute must claim nothing',
    );

    // The end-to-end assertion: the guard sees these claims and finds no failure,
    // so the blank optional output does not strand the record.
    assert.deepEqual(
      declaredOutputWriteFailures({
        outputNames: Object.keys(step.outputs),
        record: row(),
        declaredOutputWrites: claims,
      }),
      [],
    );
  } finally {
    db.close();
  }
});

test('a claimed value that did not persist is still a failure', () => {
  // The defect the guard actually exists for: the step produced a value and
  // the record does not reflect it. Attaching provided:false claims on cached
  // skips must not blind the guard to this.
  const failures = declaredOutputWriteFailures({
    outputNames: OUTPUT_NAMES,
    record: { ...RESOLVED_WITH_BLANK_OPTIONALS, website: '' },
    declaredOutputWrites: {
      company_resolution: { provided: true, value: 'resolved' },
      place_id: { provided: true, value: 'ChIJexample' },
      website: { provided: true, value: 'https://example.com' },
      user_rating_count: { provided: false, value: undefined },
    },
  });

  assert.deepEqual(failures, ['website'], 'a produced value missing from the record is a real failure');
});
