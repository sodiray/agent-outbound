#!/usr/bin/env node
/**
 * Tier 0 validation for docs/technical/pipeline-centric-model.md
 *
 * Deterministic, $0, no network. Run after `npm run build`:
 *     node scripts/validate/tier0.mjs
 *
 * Authored by the reviewer, not the implementer, deliberately: a check written
 * by whoever wrote the code under test tends to assert what the code does
 * rather than what it must do.
 *
 * Every check here is a bite-proof. Several carry an explicit twin that
 * DISABLES the mechanism and confirms the case then passes — otherwise a
 * green run only proves the case failed somewhere, not that the mechanism
 * under test is what stopped it.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openListDb, upsertContact, listContactsByRecord } from '../../dist/orchestrator/runtime/db.js';
import { evaluateFieldCheck } from '../../dist/orchestrator/lib/conditions.js';
import { readConfig } from '../../dist/orchestrator/lib/config.js';

let pass = 0;
const failures = [];
const skipped = [];

const check = (name, fn) => {
  try {
    const why = fn();
    if (why) { failures.push([name, why]); console.log(`  FAIL  ${name}\n          ${why}`); }
    else { pass += 1; console.log(`  ok    ${name}`); }
  } catch (err) {
    // An instrument limitation is never a score. A check that could not run is
    // reported as absent, never as a pass and never as a substantive failure.
    skipped.push([name, String(err?.message || err)]);
    console.log(`  ABSENT ${name}\n          harness could not run this: ${String(err?.message || err).slice(0, 160)}`);
  }
};

const section = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

// --- scratch list ---------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'ao-tier0-'));
writeFileSync(join(dir, 'outbound.yaml'), 'list:\n  name: tier0-scratch\n');
const db = openListDb({ listDir: dir, readonly: false });

const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
let seq = 0;
const mkRecord = (fields = {}) => {
  const id = `r${++seq}`;
  const cols = { _row_id: id, created_at: now, updated_at: now, ...fields };
  const keys = Object.keys(cols);
  db.prepare(
    `INSERT INTO records (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
  ).run(...keys.map((k) => cols[k]));
  return id;
};
const col = (id, name) => db.prepare(`SELECT "${name}" AS v FROM records WHERE _row_id = ?`).get(id)?.v;
const hasColumn = (table, name) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name);

// ==========================================================================
section('Item 1 — contacts identity');

check('contacts table carries the new identity/provenance columns', () => {
  const want = ['first_name', 'last_name', 'seniority', 'linkedin_urn', 'source', 'source_query', 'sourced_at', 'confidence'];
  const missing = want.filter((c) => !hasColumn('contacts', c));
  return missing.length ? `missing on contacts: ${missing.join(', ')}` : '';
});

check('an emailless contact attaches (the harvestapi case)', () => {
  const rec = mkRecord({ business_name: 'Innerbloom Dental Studio', google_place_id: 'p1' });
  const out = upsertContact({
    db,
    contact: {
      row_id: rec, full_name: 'Sarah M Enright', title: 'Owner',
      linkedin_urn: 'urn:li:fs_mini:ACoAAA_sarah', source: 'harvestapi',
    },
  });
  if (!out) return 'upsertContact returned falsy for a contact with no email — the email-only identity gate is still in place';
  const rows = listContactsByRecord({ db, recordId: rec });
  return rows.length === 1 ? '' : `expected 1 contact row, got ${rows.length}`;
});

check('TWO emailless contacts at one company both attach (unique-index collision)', () => {
  const rec = mkRecord({ business_name: 'Kieffer Design Group', google_place_id: 'p2' });
  upsertContact({ db, contact: { row_id: rec, full_name: 'Judi Kieffer', title: 'Owner', linkedin_urn: 'urn:a' } });
  upsertContact({ db, contact: { row_id: rec, full_name: 'Pat Second', title: 'Manager', linkedin_urn: 'urn:b' } });
  const rows = listContactsByRecord({ db, recordId: rec });
  return rows.length === 2
    ? ''
    : `expected 2 contact rows, got ${rows.length} — (row_id,email) unique index still collides on the empty string`;
});

check('re-upserting the same linkedin_urn updates rather than duplicating', () => {
  const rec = mkRecord({ business_name: 'Denisons Publishing', google_place_id: 'p3' });
  upsertContact({ db, contact: { row_id: rec, full_name: 'Dwayne Denison', title: 'Owner', linkedin_urn: 'urn:dd' } });
  upsertContact({ db, contact: { row_id: rec, full_name: 'Dwayne Denison', title: 'Founder', linkedin_urn: 'urn:dd' } });
  const rows = listContactsByRecord({ db, recordId: rec });
  if (rows.length !== 1) return `expected 1 contact row after re-upsert, got ${rows.length}`;
  return rows[0].title === 'Founder' ? '' : `expected the title to update to "Founder", got "${rows[0].title}"`;
});

check('exactly one is_primary per record, ranked by seniority not insertion order', () => {
  const rec = mkRecord({ business_name: 'Rank Test Co', google_place_id: 'p4' });
  upsertContact({ db, contact: { row_id: rec, full_name: 'Manager First', title: 'Office Manager', linkedin_urn: 'urn:m' } });
  upsertContact({ db, contact: { row_id: rec, full_name: 'Owner Second', title: 'Owner', linkedin_urn: 'urn:o' } });
  const rows = listContactsByRecord({ db, recordId: rec });
  const primaries = rows.filter((r) => Number(r.is_primary) === 1);
  if (primaries.length !== 1) return `expected exactly 1 primary, got ${primaries.length}`;
  return /owner/i.test(primaries[0].title)
    ? ''
    : `expected the Owner to be primary, got "${primaries[0].title}" — ranking is insertion-order, not seniority`;
});

// ==========================================================================
section('Item 1 — resolved-company invariant');

check('records carry company_resolution and resolution_source', () => {
  const missing = ['company_resolution', 'resolution_source'].filter((c) => !hasColumn('records', c));
  return missing.length ? `missing on records: ${missing.join(', ')}` : '';
});

check('company_resolution is FAIL-CLOSED for a stub (empty, not "resolved")', () => {
  const stub = mkRecord({ business_name: 'Affordable Appliance' }); // no google_place_id
  const v = String(col(stub, 'company_resolution') ?? '');
  return v === 'resolved'
    ? 'a stub company defaulted to "resolved" — the invariant fails open'
    : '';
});

check('the gate rejects a stub: company_resolution eq resolved FAILS on empty', () => {
  const r = evaluateFieldCheck({
    row: { company_resolution: '' },
    condition: { field: 'company_resolution', operator: 'eq', value: 'resolved' },
  });
  return r?.passed ? 'eq against an empty field PASSED — the gate cannot stop a stub' : '';
});

check('BITE-PROOF: with the gate absent, that same stub sails through vertical_gate', () => {
  // This is the twin. It proves company_resolved_gate is what stops a stub,
  // rather than the stub happening to fail some other gate. It asserts the
  // vacuous-pass hazard is REAL — if this check ever fails, the hazard is gone
  // and the invariant may be redundant.
  const r = evaluateFieldCheck({
    row: { primary_type: '' },
    condition: { field: 'primary_type', operator: 'not_in', value: ['health', 'school', 'lodging'] },
  });
  return r?.passed
    ? ''
    : 'not_in against an empty field now FAILS — the vacuous-pass hazard this invariant exists for is gone; re-derive whether the gate is still load-bearing';
});

check('a resolved company passes the gate', () => {
  const r = evaluateFieldCheck({
    row: { company_resolution: 'resolved' },
    condition: { field: 'company_resolution', operator: 'eq', value: 'resolved' },
  });
  return r?.passed ? '' : 'a resolved company was rejected by its own gate';
});

// ==========================================================================
section('Item 1 — primary-contact projection');

check('flattened contact fields are projected from the primary contact', () => {
  const rec = mkRecord({ business_name: 'Projection Co', google_place_id: 'p5' });
  upsertContact({
    db,
    contact: { row_id: rec, full_name: 'Rion Smyth', title: 'Owner', email: 'rion@example.com', linkedin_urn: 'urn:rs' },
  });
  const name = String(col(rec, 'contact_name') ?? '');
  const title = String(col(rec, 'contact_title') ?? '');
  if (!name) return 'contact_name was not projected — gates, briefs, CRM sync and the review UI all read it';
  if (name !== 'Rion Smyth') return `contact_name is "${name}", expected "Rion Smyth"`;
  return title === 'Owner' ? '' : `contact_title is "${title}", expected "Owner"`;
});

check('the projection follows a change of primary', () => {
  const rec = mkRecord({ business_name: 'Reproject Co', google_place_id: 'p6' });
  upsertContact({ db, contact: { row_id: rec, full_name: 'Manager Only', title: 'Manager', linkedin_urn: 'urn:mo' } });
  const before = String(col(rec, 'contact_name') ?? '');
  upsertContact({ db, contact: { row_id: rec, full_name: 'Real Owner', title: 'Owner', linkedin_urn: 'urn:ro' } });
  const after = String(col(rec, 'contact_name') ?? '');
  if (before !== 'Manager Only') return `expected the manager to be projected first, got "${before}"`;
  return after === 'Real Owner'
    ? ''
    : `projection did not follow the new primary: still "${after}" — it is being written once, not derived`;
});

// ==========================================================================
section('Item 2 — router validation (config must refuse to guess)');

// Each fixture is a whole outbound.yaml evaluated through the real
// readConfig/normalizeConfig path, so these assert the shipped validator
// rather than a reimplementation of it.
const cfgDirs = [];
const evalConfig = (yamlText) => {
  const d = mkdtempSync(join(tmpdir(), 'ao-cfg-'));
  cfgDirs.push(d);
  writeFileSync(join(d, 'outbound.yaml'), yamlText);
  const { errors, warnings } = readConfig(d);
  return {
    errors: (errors || []).map(String),
    warnings: (warnings || []).map(String),
    text: [...(errors || []), ...(warnings || [])].map(String).join(' | ').toLowerCase(),
  };
};

const BASE = `list:
  name: router-fixture
`;
const TWO_SEQS = `sequences:
  dental:
    steps:
      - id: d1
        day: 0
        description: email one
  cre:
    steps:
      - id: c1
        day: 0
        description: email one
`;

// POSITIVE CONTROL. Every negative check below asserts that a malformed
// assign step produces an error. But an unrecognised `kind: assign` ALSO
// produces an error, which would make all of them pass for the wrong reason
// before the feature exists at all. So we first prove a well-formed assign
// step validates cleanly; if it does not, the negatives report ABSENT rather
// than passing.
const ASSIGN_OK = `${BASE}sequences:
  dental:
    steps:
      - id: d1
        day: 0
        description: email one
  cre:
    steps:
      - id: c1
        day: 0
        description: email one
  unrouted:
    steps: []
pipeline:
  - kind: assign
    id: sequence_assign
    depends_on: []
    target: sequence_name
    fallback: unrouted
    rules:
      - sequence: dental
        conditions:
          - field: vertical
            operator: eq
            value: dental
      - sequence: cre
        conditions:
          - field: vertical
            operator: eq
            value: cre
`;
let assignSupported = false;
const requireAssign = () => {
  if (!assignSupported) {
    throw new Error('kind: assign is not supported by the config schema yet, so a generic '
      + '"unknown step kind" error would satisfy this check for the wrong reason');
  }
};

check('POSITIVE CONTROL: a well-formed assign step validates cleanly', () => {
  const r = evalConfig(ASSIGN_OK);
  assignSupported = r.errors.length === 0;
  return assignSupported ? '' : `kind: assign rejected by the validator: ${r.errors.join('; ').slice(0, 220)}`;
});

check('one sequence and no assign step stays silent (feature costs nothing unused)', () => {
  const r = evalConfig(`${BASE}sequences:\n  default:\n    steps: []\n`);
  return r.errors.length === 0
    ? ''
    : `a single-sequence config must not error, but got: ${r.errors.join('; ').slice(0, 200)}`;
});

check('TWO sequences with no assign step is an ERROR, not a silent pick', () => {
  const r = evalConfig(`${BASE}${TWO_SEQS}`);
  if (r.errors.length === 0) {
    return 'validate accepted two sequences with no router — the entire anti-ambiguity design is inert, '
      + 'and at runtime every record would be run through whichever sequence the caller named';
  }
  return /assign|rout/.test(r.text) ? '' : `errored, but not about routing: ${r.errors.join('; ').slice(0, 200)}`;
});

check('an assign rule naming an undefined sequence is an ERROR', () => {
  requireAssign();
  const r = evalConfig(`${BASE}${TWO_SEQS}pipeline:
  - kind: assign
    id: sequence_assign
    depends_on: []
    target: sequence_name
    fallback: unrouted
    rules:
      - sequence: does_not_exist
        conditions:
          - field: vertical
            operator: eq
            value: dental
`);
  if (!/undefined|not defined|unknown sequence|does_not_exist|no such sequence/.test(r.text)) {
    return `errored, but not about the undefined sequence target: ${r.errors.join('; ').slice(0, 200)}`;
  }
  return '';
});

check('a fallback that can SEND is an ERROR (a holding pen must be inert)', () => {
  requireAssign();
  const r = evalConfig(`${BASE}sequences:
  dental:
    steps:
      - id: d1
        day: 0
        description: email one
  unrouted:
    steps:
      - id: u1
        day: 0
        description: this fallback can send, which defeats its purpose
pipeline:
  - kind: assign
    id: sequence_assign
    depends_on: []
    target: sequence_name
    fallback: unrouted
    rules:
      - sequence: dental
        conditions:
          - field: vertical
            operator: eq
            value: dental
`);
  if (!/fallback|holding|inert|manual/.test(r.text)) {
    return `errored, but not about the sendable fallback: ${r.errors.join('; ').slice(0, 200)}`;
  }
  return '';
});

check('a rule reading a field no depends_on step produces is an ERROR', () => {
  requireAssign();
  // The highest-value check in the set. Routing on a field that is not yet
  // populated sends every lead to the fallback with no error at all — one
  // large silent pile that reads as a routing-logic problem.
  const r = evalConfig(`${BASE}${TWO_SEQS}pipeline:
  - kind: assign
    id: sequence_assign
    depends_on: []
    target: sequence_name
    fallback: unrouted
    rules:
      - sequence: dental
        conditions:
          - field: some_enriched_score
            operator: gte
            value: 80
      - sequence: cre
        conditions:
          - field: vertical
            operator: eq
            value: cre
`);
  if (!/some_enriched_score|depends_on|not produced|unknown field|no step produces/.test(r.text)) {
    return 'a rule read a field that no depends_on step produces and no source supplies. '
      + `Expected an error naming that field; got: ${r.errors.join('; ').slice(0, 200) || '(no errors at all)'}`;
  }
  return '';
});

check('a shadowed rule (narrower ordered after broader) WARNS', () => {
  const r = evalConfig(`${BASE}sequences:
  dental:
    steps:
      - id: d1
        day: 0
        description: email one
  dental_high:
    steps:
      - id: dh1
        day: 0
        description: email one
pipeline:
  - kind: assign
    id: sequence_assign
    depends_on: []
    target: sequence_name
    fallback: unrouted
    rules:
      - sequence: dental
        conditions:
          - field: vertical
            operator: eq
            value: dental
      - sequence: dental_high
        match: all
        conditions:
          - field: vertical
            operator: eq
            value: dental
          - field: fit_score
            operator: gte
            value: 80
`);
  return r.warnings.length || /shadow|unreachab/.test(r.text)
    ? ''
    : 'dental_high is unreachable behind dental (first match wins) and nothing warned';
});

check('a defined sequence no rule targets WARNS as unreachable', () => {
  const r = evalConfig(`${BASE}sequences:
  dental:
    steps:
      - id: d1
        day: 0
        description: email one
  orphan:
    steps:
      - id: o1
        day: 0
        description: nothing routes here
pipeline:
  - kind: assign
    id: sequence_assign
    depends_on: []
    target: sequence_name
    fallback: unrouted
    rules:
      - sequence: dental
        conditions:
          - field: vertical
            operator: eq
            value: dental
`);
  return r.warnings.length || /unreachab|orphan/.test(r.text)
    ? ''
    : 'a sequence that no rule can reach produced no warning';
});

// ==========================================================================
section('Item 3 — sequence steps as pipeline steps');

const SEQ_STEPS_OK = `${BASE}sequences:
  default:
    steps: []
pipeline:
  - kind: send_email
    id: touch_one
    depends_on: []
    side_effecting: true
    description: first touch
  - kind: wait
    id: hold_three_days
    depends_on: [touch_one]
    after: 3d
  - kind: filter
    id: requalify
    depends_on: [hold_three_days]
    type: field_check
    match: all
    conditions:
      - field: suppressed
        operator: neq
        value: '1'
  - kind: send_email
    id: touch_two
    depends_on: [requalify]
    side_effecting: true
    description: second touch
`;
let seqStepsSupported = false;

check('POSITIVE CONTROL: send_email / wait / filter interleave validates cleanly', () => {
  const r = evalConfig(SEQ_STEPS_OK);
  seqStepsSupported = r.errors.length === 0;
  return seqStepsSupported
    ? ''
    : `the sequence-flavored step kinds are not accepted yet: ${r.errors.join('; ').slice(0, 220)}`;
});

check('a wait step with no duration is an ERROR', () => {
  if (!seqStepsSupported) throw new Error('sequence-flavored step kinds not supported yet, so an "unknown kind" error would satisfy this for the wrong reason');
  const r = evalConfig(`${BASE}sequences:\n  default:\n    steps: []\npipeline:\n  - kind: wait\n    id: forever\n    depends_on: []\n`);
  return r.errors.length ? '' : 'a wait step with no `after` duration was accepted — it would never become ready';
});

check('a send step MUST be declared side_effecting', () => {
  if (!seqStepsSupported) throw new Error('sequence-flavored step kinds not supported yet');
  // A send that is not marked side-effecting is indistinguishable to the
  // re-run machinery from a filter, and the standard repair for a stuck
  // record (clearing pipeline_events + staleness) would re-send it.
  const r = evalConfig(`${BASE}sequences:\n  default:\n    steps: []\npipeline:\n  - kind: send_email\n    id: unguarded\n    depends_on: []\n    description: no side_effecting marker\n`);
  return r.errors.length || /side_effect/.test(r.text)
    ? ''
    : 'a send_email step without side_effecting was accepted — clearing events to repair a record would re-send it';
});

// ==========================================================================
section('Item 4 — LinkedIn headline parsing and resolution confirmation');

// These fixtures are the ten REAL harvestapi profiles already paid for, with
// the expected outcome taken from the Tier 1 run recorded in the design doc —
// not from anything the parser currently happens to do.
let li = null;
try { li = await import('../../dist/orchestrator/sourcing/linkedin.js'); } catch { /* not built yet */ }
const requireLinkedin = () => {
  if (!li?.parseCompanyFromHeadline || !li?.confirmResolution) {
    throw new Error('dist/orchestrator/sourcing/linkedin.js does not export '
      + 'parseCompanyFromHeadline + confirmResolution yet');
  }
};

// [headline, expected company or null]
const HEADLINES = [
  ["Owner / Denison's Publishing Inc.", "Denison's Publishing Inc."],
  ['LPC/Owner of Holding Space Counseling, LLC', 'Holding Space Counseling, LLC'],
  ['Founder - CEO at Growth Foundry', 'Growth Foundry'],
  ['Owner at Affordable Appliance', 'Affordable Appliance'],
  ['Owner at AVA Media', 'AVA Media'],
  ['Owner Kieffer Design Group Interior Design+Procurement', 'Kieffer Design Group Interior Design+Procurement'],
  ['Owner/Operator', null],
  ['Owner - Chauncey & Chauncey Bookkeeping LLC', 'Chauncey & Chauncey Bookkeeping LLC'],
  ['Business Owner | Professional Cleaning Services', null],
  ['Owner of Innerbloom Dental Studio', 'Innerbloom Dental Studio'],
];

check('headline parser: 8 of the 10 real profiles yield a company', () => {
  requireLinkedin();
  const got = HEADLINES.map(([h]) => li.parseCompanyFromHeadline(h)?.company || null);
  const n = got.filter(Boolean).length;
  return n === 8 ? '' : `expected 8 parseable of 10, got ${n}: ${JSON.stringify(got)}`;
});

check('headline parser: the two unparseable cases yield null, never a stub', () => {
  requireLinkedin();
  // "Owner/Operator" names no company. "Business Owner | Professional Cleaning
  // Services" names a category. Both must be quarantined rather than turned
  // into a stub company that then vacuously passes every gate.
  const bad = [];
  for (const [h, want] of HEADLINES) {
    if (want !== null) continue;
    const got = li.parseCompanyFromHeadline(h)?.company || null;
    if (got !== null) bad.push(`${JSON.stringify(h)} -> ${JSON.stringify(got)}`);
  }
  return bad.length ? `must be unparseable but produced a company: ${bad.join('; ')}` : '';
});

check('confirmation gate ACCEPTS the four correct Tier 1 resolutions', () => {
  requireLinkedin();
  const ok = [
    ["Denison's Publishing Inc.", "Denison's Publishing Inc"],
    ['Kieffer Design Group Interior Design+Procurement', 'Kieffer Design Group'],
    ['Chauncey & Chauncey Bookkeeping LLC', 'Chauncey and Chauncey Bookkeeping'],
    ['Innerbloom Dental Studio', 'Innerbloom Dental Studio'],
  ];
  const wrong = ok.filter(([p, c]) => !li.confirmResolution({ parsedCompany: p, candidateName: c })?.confirmed);
  return wrong.length ? `rejected correct resolutions: ${JSON.stringify(wrong)}` : '';
});

check('confirmation gate REJECTS both poisoning resolutions from Tier 1', () => {
  requireLinkedin();
  // The whole reason the gate exists. Google Places returns the nearest
  // plausible business rather than nothing, so these came back with a
  // confident place_id, primary_type, website and review count for a
  // DIFFERENT company. Token-overlap scoring does not separate them (the
  // first scored 0.67 while a correct resolution scored 0.33).
  const poison = [
    ['Holding Space Counseling, LLC', 'Mind Space Mental Wellness Counseling'],
    ['Growth Foundry', 'Social Eyes Marketing'],
  ];
  const leaked = poison.filter(([p, c]) => li.confirmResolution({ parsedCompany: p, candidateName: c })?.confirmed);
  return leaked.length
    ? `accepted a resolution to the WRONG business: ${JSON.stringify(leaked)} — `
      + 'every downstream gate would then evaluate against the wrong entity'
    : '';
});

// ==========================================================================
db.close();
for (const d of cfgDirs) rmSync(d, { recursive: true, force: true });
rmSync(dir, { recursive: true, force: true });

console.log(`\n${'='.repeat(64)}`);
console.log(`passed ${pass}   failed ${failures.length}   absent ${skipped.length}`);
if (failures.length) {
  console.log('\nfailures:');
  for (const [n, w] of failures) console.log(`  - ${n}\n      ${w}`);
}
if (skipped.length) {
  console.log('\nabsent (harness limitation — NOT a pass):');
  for (const [n, w] of skipped) console.log(`  - ${n}\n      ${w}`);
}
process.exit(failures.length || skipped.length ? 1 : 0);
