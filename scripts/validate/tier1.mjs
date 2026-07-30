#!/usr/bin/env node
/**
 * Tier 1 gating experiment for docs/technical/pipeline-centric-model.md.
 *
 *     GOOGLE_MAPS_API_KEY=... node scripts/validate/tier1.mjs [--offline]
 *
 * Question: does a company name parsed from a LinkedIn headline resolve to the
 * RIGHT business via Google Places, once the confirmation gate is applied?
 *
 * The first run of this experiment FAILED at 4/6 precision, and the two failures
 * were the reason the confirmation gate exists at all. This instrument re-measures
 * with the gate in place, using the SHIPPED parseCompanyFromHeadline and
 * confirmResolution rather than a reimplementation.
 *
 * Precision is weighted above recall, deliberately. A recall miss quarantines a
 * lead: visible, recoverable, a human can name the business. A precision miss
 * attaches some real company's primary_type, website and reviews to the wrong
 * person, after which every downstream gate evaluates confidently against the
 * wrong entity — a poisoned lead that reads as a clean pass.
 *
 * Google Places is called DIRECTLY so the spend lands on the GCP account, never
 * through Monid. The fixture is 10 harvestapi profiles already paid for, so the
 * only cost here is the Places calls.
 *
 * --offline re-grades the recorded ground truth without calling Places ($0).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseCompanyFromHeadline, confirmResolution } from '../../dist/orchestrator/sourcing/linkedin.js';

const here = dirname(fileURLToPath(import.meta.url));
const profiles = JSON.parse(readFileSync(join(here, 'fixtures', 'linkedin-sample-10.json'), 'utf8'));
const offline = process.argv.includes('--offline');

// Hand-verified ground truth from the first run, recorded in the design doc.
// Exhaustive over the sample, so there is no sampling error to argue about.
// `null` means the parsed company has no correct Places counterpart.
const TRUTH = {
  'Dwayne Denison': "Denison's Publishing Inc",
  'Rebecca Mills MC, LPC, CIRT': null,   // Places returns Mind Space Mental Wellness — a DIFFERENT business
  'Dave Lakhani': null,                  // Places returns Social Eyes Marketing — a DIFFERENT business
  'Rion Smyth': null,                    // Affordable Appliance is absent from Places entirely
  'Andrew Chapa': null,                  // AVA Media is absent from Places entirely
  'Judi Kieffer': 'Kieffer Design Group',
  'Juan Vicente Recendiz': null,         // headline names no company
  'Joanne Chauncey': 'Chauncey and Chauncey Bookkeeping',
  'Lucy Tirrell': null,                  // headline names a category, not a business
  'Sarah M Enright': 'Innerbloom Dental Studio',
};
const truthFor = (name) => {
  const key = Object.keys(TRUTH).find((k) => k.startsWith(String(name).slice(0, 12)));
  return key === undefined ? undefined : TRUTH[key];
};

// What Places ACTUALLY returned for the two poisoning cases, recorded live.
// Without these, --offline would feed the gate '__ABSENT__' and quarantine them
// as "not in Places" — the right outcome for the wrong reason, leaving the gate
// itself unexercised. Feeding the real wrong answer is what makes the offline
// re-grade a test of the gate rather than a test of the fixture.
const RECORDED_WRONG_CANDIDATE = {
  'Rebecca Mills': 'Mind Space Mental Wellness Counseling',
  'Dave Lakhani': 'Social Eyes Marketing',
};
// Businesses genuinely absent from Places, verified against a plain query and a
// 40km Boise location bias. These are a structural recall ceiling, not a defect.
const RECORDED_ABSENT = ['Rion Smyth', 'Andrew Chapa'];
const recordedCandidateFor = (name) => {
  if (RECORDED_ABSENT.some((n) => String(name).startsWith(n))) return '__ABSENT__';
  const key = Object.keys(RECORDED_WRONG_CANDIDATE).find((k) => String(name).startsWith(k));
  if (key !== undefined) return RECORDED_WRONG_CANDIDATE[key];
  return truthFor(name) ?? '__ABSENT__';
};

const KEY = process.env.GOOGLE_MAPS_API_KEY || '';
if (!offline && !KEY) {
  console.error('GOOGLE_MAPS_API_KEY is not set. Run with --offline to re-grade at $0.');
  process.exit(2);
}

const placesTextSearch = async (query) => {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.primaryType,places.websiteUri,places.userRatingCount',
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 3 }),
  });
  if (!res.ok) throw new Error(`Places ${res.status}: ${(await res.text()).slice(0, 140)}`);
  return (await res.json()).places || [];
};

let calls = 0;
const rows = [];

for (const p of profiles) {
  const city = String(p.location || 'Boise, ID').replace('Metropolitan Area', '').trim();
  const parsed = parseCompanyFromHeadline(p.position || '');

  if (!parsed.company) {
    rows.push({ person: p.name, verdict: 'quarantined_unparseable', reason: parsed.reason });
    continue;
  }

  // Offline mode grades the gate against the recorded counterpart rather than a live call.
  const candidateName = offline
    ? recordedCandidateFor(p.name)
    : await (async () => {
      const hits = await placesTextSearch(`${parsed.company} ${city}`);
      calls += 1;
      return hits.length ? (hits[0].displayName?.text || '') : '__ABSENT__';
    })();

  if (candidateName === '__ABSENT__') {
    rows.push({ person: p.name, company: parsed.company, verdict: 'quarantined_absent_from_places' });
    continue;
  }

  const gate = confirmResolution({ parsedCompany: parsed.company, candidateName });
  rows.push({
    person: p.name,
    company: parsed.company,
    candidate: candidateName,
    verdict: gate.confirmed ? 'confirmed' : 'quarantined_unconfirmed',
    headToken: gate.headToken,
    truth: truthFor(p.name),
  });
}

console.log(`\nTier 1 — resolution precision${offline ? ' (offline re-grade, $0)' : ''}`);
console.log('='.repeat(78));
for (const r of rows) {
  const tag = r.verdict === 'confirmed' ? 'CONFIRMED ' : 'quarantine';
  console.log(`  ${tag} ${String(r.person).slice(0, 22).padEnd(22)} ${String(r.company || '-').slice(0, 30).padEnd(30)} ${String(r.candidate || r.reason || '').slice(0, 30)}`);
}

// Comparing business names needs the same normalisation the gate uses. Places
// returns a typographic apostrophe (Denison’s) where the parsed value has a
// straight one (Denison's), and comparing them raw produced a FALSE poisoning
// report on a perfectly correct resolution. Normalisation is deliberately
// limited to punctuation, case, whitespace and legal suffixes — it must not be
// loose enough to make two genuinely different businesses compare equal.
const LEGAL = /\b(inc|llc|ltd|co|corp|company|pllc|pc)\b/g;
const sameBusiness = (a, b) => {
  const norm = (s) => String(s || '')
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(LEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return norm(a) === norm(b);
};

const confirmed = rows.filter((r) => r.verdict === 'confirmed');
// A confirmed resolution is CORRECT when it matches the hand-verified counterpart.
const correct = confirmed.filter((r) => r.truth && sameBusiness(r.truth, r.candidate));
const poisoned = confirmed.filter((r) => r.truth === null || (r.truth && !sameBusiness(r.truth, r.candidate)));
const quarantined = rows.filter((r) => r.verdict !== 'confirmed');

console.log('-'.repeat(78));
console.log(`  sample            : ${rows.length}`);
console.log(`  confirmed         : ${confirmed.length}`);
console.log(`  ...correct        : ${correct.length}`);
console.log(`  ...POISONED       : ${poisoned.length}${poisoned.length ? '  <-- ' + poisoned.map((r) => r.person).join(', ') : ''}`);
console.log(`  quarantined       : ${quarantined.length}`);
console.log(`  places calls      : ${calls}`);

// The bar. Precision is absolute: a single poisoned lead fails the tier, because
// a poisoned lead is indistinguishable from a good one downstream.
const precision = confirmed.length ? correct.length / confirmed.length : 1;
console.log(`\n  precision         : ${correct.length}/${confirmed.length}${confirmed.length ? ` (${(precision * 100).toFixed(0)}%)` : ''}`);

if (poisoned.length > 0) {
  console.log('\n  FAIL — a confirmed resolution points at the wrong business. Every downstream gate');
  console.log('         would evaluate against the wrong entity, and it reads as a clean pass.');
  process.exit(1);
}
if (confirmed.length === 0) {
  console.log('\n  ABSENT — nothing was confirmed, so precision is unmeasured. Not a pass.');
  process.exit(1);
}
console.log('\n  PASS — every confirmed resolution points at the right business.');
console.log(`         ${quarantined.length} lead(s) quarantined: visible and recoverable, not silently dropped.`);
