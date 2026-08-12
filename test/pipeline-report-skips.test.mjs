import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { pipelineReportCommand } from '../dist/commands/index.js';

// A skip is not a verdict. `passed = 0` covers both "this step ran and said no"
// and "this step never ran at all", and reporting them together made a gate
// that decided nothing look like a gate that decided everything -- which is how
// an inert gate survived unnoticed while appearing maximally busy.

const CONFIG = `list:
  name: skip-report
record_title_field: business_name
pipeline:
  - kind: filter
    id: real_gate
    on_fail: drop
    condition: "always"
    description: A gate that genuinely decides.
  - kind: filter
    id: starved_gate
    on_fail: drop
    condition: "always"
    description: A gate whose upstream errored, so it never runs.
  - kind: filter
    id: settled_gate
    on_fail: drop
    condition: "always"
    description: A gate that already decided everybody on an earlier run.
  - kind: filter
    id: mixed_gate
    on_fail: drop
    condition: "always"
    description: A gate that is partly settled and partly blocked.
`;

const STARTED_AT = '2026-01-01T00:00:00.000Z';
const ENDED_AT = '2026-01-01T00:10:00.000Z';

const seedList = () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-outbound-report-skips-'));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'outbound.yaml'), CONFIG, 'utf8');

  const db = openListDb({ listDir: root, readonly: false });
  try {
    db.prepare(`INSERT INTO run_state (run_id, phase, status, started_at, updated_at, target_count)
      VALUES (?, 'pipeline', 'completed', ?, ?, ?)`).run('run-skips', STARTED_AT, ENDED_AT, 10);

    ['r1', 'r2', 'r3'].forEach((record) => upsertRecord({
      db,
      row: { _row_id: record, business_name: `Business ${record}` },
    }));

    const event = ({ step, record, passed, reason }) => db.prepare(
      `INSERT INTO pipeline_events (record_id, step_id, kind, passed, reason, occurred_at)
       VALUES (?, ?, 'filter', ?, ?, ?)`,
    ).run(record, step, passed, reason, '2026-01-01T00:01:00.000Z');

    // real_gate actually decided: one pass, one drop.
    event({ step: 'real_gate', record: 'r1', passed: 1, reason: '' });
    event({ step: 'real_gate', record: 'r2', passed: 0, reason: 'condition_false' });

    // starved_gate never ran for anybody -- its upstream errored.
    ['r1', 'r2', 'r3'].forEach((record) => event({
      step: 'starved_gate',
      record,
      passed: 0,
      reason: 'skipped:upstream_errored:some_enrich_step',
    }));

    // settled_gate decided everybody on an earlier run and skipped them now.
    // It looks identical to starved_gate in every count, and is healthy.
    ['r1', 'r2', 'r3'].forEach((record) => event({
      step: 'settled_gate',
      record,
      passed: 0,
      reason: 'skipped:already_resolved',
    }));

    // mixed_gate: two settled, one genuinely blocked.
    ['r1', 'r2'].forEach((record) => event({
      step: 'mixed_gate', record, passed: 0, reason: 'skipped:already_resolved',
    }));
    event({
      step: 'mixed_gate', record: 'r3', passed: 0, reason: 'skipped:upstream_errored:some_enrich_step',
    });
  } finally {
    db.close();
  }
  return root;
};

const reportFor = (root) => pipelineReportCommand({ list: root, run: 'latest' });
const stepIn = (report, id) => report.steps.find((step) => step.step_id === id);

test('a skipped record is not reported as a dropped record', () => {
  const starved = stepIn(reportFor(seedList()), 'starved_gate');

  assert.ok(starved, 'starved_gate must appear in the report');
  assert.equal(starved.skipped, 3, 'all three records were skipped');
  assert.equal(starved.dropped, 0, 'a step that never ran dropped nobody');
  assert.equal(starved.flagged, 0);
  assert.equal(starved.passed, 0);
});

test('a step that was reached and decided nothing is reported inert', () => {
  const report = reportFor(seedList());

  assert.equal(stepIn(report, 'starved_gate').health, 'inert');
  assert.equal(stepIn(report, 'real_gate').health, 'ok', 'a gate that actually decided is not inert');
  assert.ok(
    String(report.summary || '').includes('INERT starved_gate'),
    'the rendered summary must name the inert step, not bury it in a column',
  );
});

test('a step that already decided everybody is settled, not inert', () => {
  // The false positive this guards: settled_gate and starved_gate have
  // identical counts -- 3 skipped, nothing passed, dropped or flagged. Only the
  // skip REASON separates "already ran, verdict stands" from "never consulted".
  // Calling the first one inert would train an operator to ignore the alarm.
  const report = reportFor(seedList());
  const settled = stepIn(report, 'settled_gate');
  const starved = stepIn(report, 'starved_gate');

  assert.equal(settled.skipped, starved.skipped, 'both look identical by count');
  assert.equal(settled.passed + settled.dropped + settled.flagged, 0);

  assert.equal(settled.blocked, 0, 'already_resolved is not a blocked skip');
  assert.equal(starved.blocked, 3, 'upstream_errored is a blocked skip');
  assert.equal(settled.health, 'ok', 'a step that already decided is healthy');
  assert.ok(
    !String(report.summary || '').includes('INERT settled_gate'),
    'a settled step must not be reported as inert',
  );
});

test('a partly blocked step shows its blocked count without raising the alarm', () => {
  // mixed_gate is 2 settled + 1 blocked and decided nobody this run. Real, and
  // worth seeing in the `blocked` column -- but not the unambiguous "this gate
  // was never consulted" case. An alarm that fires here is one operators learn
  // to scroll past, which is how the last inert gate went unnoticed.
  const report = reportFor(seedList());
  const mixed = stepIn(report, 'mixed_gate');

  assert.equal(mixed.skipped, 3);
  assert.equal(mixed.blocked, 1, 'the blocked record is still counted and visible');
  assert.equal(mixed.health, 'ok', 'partial blockage is not the inert alarm');
  assert.ok(!String(report.summary || '').includes('INERT mixed_gate'));
});

test('real verdicts are still counted, and skips do not dilute them', () => {
  const real = stepIn(reportFor(seedList()), 'real_gate');

  assert.equal(real.passed, 1);
  assert.equal(real.dropped, 1);
  assert.equal(real.skipped, 0);
});
