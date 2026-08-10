/**
 * deriveContactFirstName — safe first-name extraction for email personalisation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveContactFirstName } from '../dist/orchestrator/policy/contact-name.js';

test('deriveContactFirstName: plain given + family', () => {
  assert.equal(deriveContactFirstName('Kevin Aguilera'), 'Kevin');
  assert.equal(deriveContactFirstName('Alex Costa'), 'Alex');
});

test('deriveContactFirstName: middle word is fine; first token wins', () => {
  assert.equal(deriveContactFirstName('Juan Vicente Recendiz'), 'Juan');
  assert.equal(deriveContactFirstName('Mary Jo Watson'), 'Mary');
});

test('deriveContactFirstName: middle initial (with or without period) does not defeat first name', () => {
  assert.equal(deriveContactFirstName('Sarah M Enright'), 'Sarah');
  assert.equal(deriveContactFirstName('Sarah M. Enright'), 'Sarah');
  assert.equal(deriveContactFirstName('Jane A Smith'), 'Jane');
});

test('deriveContactFirstName: trailing professional credentials after comma', () => {
  assert.equal(deriveContactFirstName('Rebecca Mills MC, LPC, CISM'), 'Rebecca');
  assert.equal(deriveContactFirstName('Rebecca Mills, MC, LPC, CISM'), 'Rebecca');
  assert.equal(deriveContactFirstName('Dr. Shawn Stadlbauer, DC'), 'Shawn');
  assert.equal(deriveContactFirstName('Alex Rivera, LMFT'), 'Alex');
  assert.equal(deriveContactFirstName('Pat Lee, PT, DPT'), 'Pat');
  assert.equal(deriveContactFirstName('Sam Ortiz, DVM'), 'Sam');
  assert.equal(deriveContactFirstName('Jordan Kim, CPA'), 'Jordan');
});

test('deriveContactFirstName: honorific + middle initial + generational suffix', () => {
  assert.equal(deriveContactFirstName('Dr. Jane A Smith Jr.'), 'Jane');
  assert.equal(deriveContactFirstName('Ms. Alex Costa Jr., PhD'), 'Alex');
});

test('deriveContactFirstName: mononym is accepted', () => {
  assert.equal(deriveContactFirstName('Cher'), 'Cher');
});

test('deriveContactFirstName: initials-only first token is rejected (no usable greeting name)', () => {
  // "J K Rowling" has no multi-letter given name; "Hi J" is worse than "Hi there".
  assert.equal(deriveContactFirstName('J K Rowling'), '');
  assert.equal(deriveContactFirstName('M Enright'), '');
});

test('deriveContactFirstName: rejects email, handle-like symbols, and digits', () => {
  assert.equal(deriveContactFirstName('contact@example.test'), '');
  assert.equal(deriveContactFirstName('user@domain.com'), '');
  assert.equal(deriveContactFirstName('name/with/slashes'), '');
  assert.equal(deriveContactFirstName('Bob & Alice'), '');
  assert.equal(deriveContactFirstName('Agent 007'), '');
  assert.equal(deriveContactFirstName('Room 12 Smith'), '');
});

test('deriveContactFirstName: rejects organization-looking names', () => {
  assert.equal(deriveContactFirstName('Acme Plumbing LLC'), '');
  assert.equal(deriveContactFirstName('Acme Plumbing Inc'), '');
  assert.equal(deriveContactFirstName('Widgets Corp'), '');
});

test('deriveContactFirstName: rejects role/non-person tokens and inverted "Last, First"', () => {
  assert.equal(deriveContactFirstName('Sales Team'), '');
  assert.equal(deriveContactFirstName('Support'), '');
  // "Costa, Alex" is last-first; after-comma is not a known suffix/credential.
  assert.equal(deriveContactFirstName('Costa, Alex'), '');
});

test('deriveContactFirstName: blank and non-stringy empty', () => {
  assert.equal(deriveContactFirstName(''), '');
  assert.equal(deriveContactFirstName('   '), '');
  assert.equal(deriveContactFirstName(null), '');
  assert.equal(deriveContactFirstName(undefined), '');
});
