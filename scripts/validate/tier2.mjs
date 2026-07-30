#!/usr/bin/env node
/**
 * Tier 2 end-to-end assertions for docs/technical/pipeline-centric-model.md
 *
 *     node scripts/validate/tier2.mjs <listDir>
 *
 * This asserts POST-CONDITIONS on a list that has already been sourced from
 * both lanes and run through the pipeline. It deliberately does not drive the
 * CLI itself: separating "run it" from "judge it" keeps the judgement stable
 * while the commands are still moving, and lets the same assertions be re-run
 * against a list after a repair without re-spending.
 *
 * Run this against a SCRATCH list, never against treasure-valley.
 *
 * Two rules inherited from the design doc:
 *   - A check the harness cannot evaluate is reported ABSENT, never as a pass.
 *   - "Nothing was rejected" is not evidence a gate works. Several checks below
 *     demand a gate be seen REJECTING something, because a gate with nothing to
 *     check is indistinguishable from one that passes everything.
 */
import { openListDb } from '../../dist/orchestrator/runtime/db.js';

const listDir = process.argv[2];
if (!listDir) {
  console.error('usage: node scripts/validate/tier2.mjs <listDir>');
  process.exit(2);
}

const db = openListDb({ listDir, readonly: true });
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const cols = new Set(db.prepare('PRAGMA table_info(records)').all().map((c) => c.name));
const need = (...names) => {
  const missing = names.filter((n) => !cols.has(n));
  if (missing.length) throw new Error(`list is missing column(s): ${missing.join(', ')}`);
};

let pass = 0;
const failures = [];
const absent = [];
const check = (name, fn) => {
  try {
    const why = fn();
    if (why) { failures.push([name, why]); console.log(`  FAIL   ${name}\n           ${why}`); }
    else { pass += 1; console.log(`  ok     ${name}`); }
  } catch (err) {
    absent.push([name, String(err?.message || err)]);
    console.log(`  ABSENT ${name}\n           ${String(err?.message || err).slice(0, 170)}`);
  }
};

// Lanes are distinguished by records.source. The LinkedIn lane writes a source
// containing 'linkedin' or 'harvest'; the Places lane 'places' or 'google'.
const LI = "(lower(source) LIKE '%linkedin%' OR lower(source) LIKE '%harvest%')";
const GP = "(lower(source) LIKE '%place%' OR lower(source) LIKE '%google%' OR lower(source) LIKE '%maps%')";
const AWAITING = `_row_id IN (SELECT record_id FROM pipeline_events WHERE reason = 'awaiting_review')`;

console.log(`\nTier 2 — ${listDir}\n${'='.repeat(60)}`);

check('both lanes actually sourced something (otherwise the run proves nothing)', () => {
  const li = one(`SELECT COUNT(*) n FROM records WHERE ${LI}`).n;
  const gp = one(`SELECT COUNT(*) n FROM records WHERE ${GP}`).n;
  console.log(`           linkedin-sourced=${li}  places-sourced=${gp}`);
  if (!li) return 'no LinkedIn-sourced records — the whole point of the run is the second lane';
  if (!gp) return 'no Places-sourced records — there is nothing to compare the new lane against';
  return '';
});

check('ZERO stubs got past the resolution gate into review', () => {
  need('company_resolution');
  const bad = all(
    `SELECT _row_id, business_name, company_resolution FROM records
      WHERE ${AWAITING} AND company_resolution != 'resolved' LIMIT 5`,
  );
  return bad.length
    ? `${bad.length}+ unresolved companies reached review: ${bad.map((r) => `${r.business_name}(${r.company_resolution || 'empty'})`).join(', ')}`
    : '';
});

check('every LinkedIn-sourced lead in review carries at least one contact', () => {
  const bad = all(
    `SELECT r._row_id, r.business_name FROM records r
      WHERE ${LI.replace(/source/g, 'r.source')} AND r._row_id IN (SELECT record_id FROM pipeline_events WHERE reason='awaiting_review')
        AND (SELECT COUNT(*) FROM contacts c WHERE c.row_id = r._row_id) = 0 LIMIT 5`,
  );
  return bad.length
    ? `person-first leads with no attached person: ${bad.map((r) => r.business_name).join(', ')}`
    : '';
});

check('the two lanes are STRUCTURALLY INDISTINGUISHABLE in review', () => {
  // The central claim of the whole design: a unified view of a lead. Both
  // lanes must arrive carrying the same Places-shaped fields.
  need('company_resolution', 'website');
  const shape = (where) => one(
    `SELECT COUNT(*) n,
            SUM(CASE WHEN website != '' THEN 1 ELSE 0 END) w,
            SUM(CASE WHEN company_resolution = 'resolved' THEN 1 ELSE 0 END) res
       FROM records WHERE ${AWAITING} AND ${where}`,
  );
  const a = shape(LI);
  const b = shape(GP);
  if (!a.n) return 'no LinkedIn-sourced leads reached review at all';
  if (!b.n) return 'no Places-sourced leads reached review at all';
  console.log(`           linkedin: n=${a.n} website=${a.w} resolved=${a.res} | places: n=${b.n} website=${b.w} resolved=${b.res}`);
  if (a.res !== a.n) return `${a.n - a.res} LinkedIn leads in review are not marked resolved`;
  if (b.res !== b.n) return `${b.n - b.res} Places leads in review are not marked resolved`;
  return '';
});

check('vertical_gate was SEEN REJECTING a LinkedIn-sourced lead (proves it is not inert)', () => {
  need('disqualified_gate');
  const n = one(
    `SELECT COUNT(*) n FROM records WHERE ${LI} AND disqualified_gate = 'vertical_gate'`,
  ).n;
  return n > 0
    ? ''
    : 'vertical_gate never rejected a LinkedIn-sourced lead. Because not_in passes vacuously on an '
      + 'empty field, an inert gate and a working gate look identical from the outside — so this run '
      + 'is INCONCLUSIVE on whether the lane is actually being vertical-vetted, not a pass.';
});

check('routing split the queue across at least two sequences', () => {
  need('sequence_name');
  const rows = all(
    `SELECT sequence_name, COUNT(*) n FROM records WHERE ${AWAITING} GROUP BY 1 ORDER BY 2 DESC`,
  );
  console.log(`           ${rows.map((r) => `${r.sequence_name || '(empty)'}=${r.n}`).join('  ')}`);
  return rows.length >= 2 ? '' : `only ${rows.length} distinct sequence(s) — routing did not split anything`;
});

check('every routed lead names the rule that routed it', () => {
  need('routed_by', 'sequence_name');
  const bad = one(
    `SELECT COUNT(*) n FROM records
      WHERE ${AWAITING} AND sequence_name != '' AND COALESCE(routed_by,'') = ''`,
  ).n;
  return bad
    ? `${bad} routed leads have no routed_by attribution — a lead routed correctly by the wrong rule `
      + 'is undiagnosable without it'
    : '';
});

check('the unrouted pen is either non-empty or provably unnecessary', () => {
  need('sequence_name', 'routed_by');
  const penned = one(`SELECT COUNT(*) n FROM records WHERE ${AWAITING} AND sequence_name = 'unrouted'`).n;
  const routed = one(`SELECT COUNT(*) n FROM records WHERE ${AWAITING} AND COALESCE(routed_by,'') != ''`).n;
  const total = one(`SELECT COUNT(*) n FROM records WHERE ${AWAITING}`).n;
  console.log(`           penned=${penned} routed=${routed} total=${total}`);
  if (penned > 0) return '';
  return routed === total
    ? ''
    : `the pen is empty but only ${routed}/${total} leads carry attribution — an empty pen is not `
      + 'evidence of success unless every lead was demonstrably matched by a rule';
});

check('a dry run emitted nothing: zero drafts, zero channel events', () => {
  const d = one('SELECT COUNT(*) n FROM drafts').n;
  const c = one("SELECT COUNT(*) n FROM channel_events WHERE lower(event_type) LIKE '%sent%' OR lower(action) LIKE '%sent%'").n;
  return d === 0 && c === 0 ? '' : `dry run produced drafts=${d} sent-channel-events=${c}`;
});

db.close();

console.log(`\n${'='.repeat(60)}`);
console.log(`passed ${pass}   failed ${failures.length}   absent ${absent.length}`);
if (failures.length) { console.log('\nfailures:'); for (const [n, w] of failures) console.log(`  - ${n}\n      ${w}`); }
if (absent.length) { console.log('\nabsent (harness limitation — NOT a pass):'); for (const [n, w] of absent) console.log(`  - ${n}\n      ${w}`); }
process.exit(failures.length || absent.length ? 1 : 0);
