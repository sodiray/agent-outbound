import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateFieldCheckGroup } from '../dist/orchestrator/lib/conditions.js';
import { normalizeConfig } from '../dist/schemas/config.js';

const containsQuote = {
  field: 'source_text',
  operator: 'contains',
  value_field: 'quoted_text',
};

test('field_check contains compares one declared field against another', () => {
  const passed = evaluateFieldCheckGroup({
    row: { source_text: 'A source says the weather is clear.', quoted_text: 'weather is clear' },
    conditions: [containsQuote],
  });
  const failed = evaluateFieldCheckGroup({
    row: { source_text: 'A source says the weather is clear.', quoted_text: 'weather is stormy' },
    conditions: [containsQuote],
  });

  assert.equal(passed.passed, true);
  assert.equal(failed.passed, false);
  assert.match(failed.reason, /does not contain/i);
});

test('field_check value_field fails closed when the referenced field is missing or blank', () => {
  const missing = evaluateFieldCheckGroup({
    row: { source_text: 'A source says the weather is clear.' },
    conditions: [containsQuote],
  });
  const blank = evaluateFieldCheckGroup({
    row: { source_text: 'A source says the weather is clear.', quoted_text: ' ' },
    conditions: [containsQuote],
  });

  assert.equal(missing.passed, false);
  assert.equal(blank.passed, false);
  assert.match(missing.reason, /quoted text is empty/i);
  assert.match(blank.reason, /quoted text is empty/i);
});

test('field_check literal values remain literal, including braces', () => {
  const result = evaluateFieldCheckGroup({
    row: { status: '{other_field}', other_field: 'different' },
    conditions: [{ field: 'status', operator: 'eq', value: '{other_field}' }],
  });

  assert.equal(result.passed, true);
});

test('field_check validates field references and unsupported value_field operators', () => {
  const produced = normalizeConfig({
    pipeline: [
      {
        kind: 'generate',
        id: 'produce_quote',
        inputs: ['source_text'],
        outputs: { quoted_text: { type: 'string', description: 'A verbatim quotation.' } },
      },
      {
        kind: 'filter',
        id: 'quote_gate',
        type: 'field_check',
        depends_on: ['produce_quote'],
        inputs: ['source_text', 'quoted_text'],
        conditions: [containsQuote],
      },
    ],
    source: { identity: ['source_text'] },
  });
  const unproduced = normalizeConfig({
    pipeline: [{
      kind: 'filter',
      id: 'quote_gate',
      type: 'field_check',
      inputs: ['source_text', 'quoted_text'],
      conditions: [containsQuote],
    }],
    source: { identity: ['source_text'] },
  });
  const unsupported = normalizeConfig({
    pipeline: [{
      kind: 'filter',
      id: 'empty_gate',
      type: 'field_check',
      inputs: ['source_text', 'quoted_text'],
      conditions: [{ field: 'source_text', operator: 'is_empty', value_field: 'quoted_text' }],
    }],
  });

  assert.deepEqual(produced.errors, []);
  assert.ok(unproduced.errors.some((error) => /value_field references "quoted_text"/i.test(error)));
  assert.ok(unsupported.errors.some((error) => /value_field does not support operator/i.test(error)));
});
