import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UndeclaredStageInputError,
  inputTruncationReason,
  requiredInputNonExecutionReason,
  resolveStageInputs,
  stageInputDiagnosticMessages,
  stageInputRecord,
  truncateInputToMaxChars,
} from '../dist/orchestrator/lib/stage-inputs.js';
import { buildModelContext } from '../dist/orchestrator/lib/model-context.js';
import { normalizeConfig } from '../dist/schemas/config.js';

test('stage record denies reads outside the declared input capability', () => {
  const record = stageInputRecord({
    step: { id: 'scrape_site', kind: 'enrich', inputs: ['website'] },
    record: { _row_id: 'acct_1', website: 'https://example.test', site_text: 'private evidence' },
  });

  assert.equal(record.website, 'https://example.test');
  assert.equal(record._row_id, 'acct_1');
  assert.throws(() => record.site_text, (error) => (
    error instanceof UndeclaredStageInputError
    && error.message === 'Stage "scrape_site" attempted to read undeclared input "site_text".'
  ));
});

test('strict model context exposes declared aliases only', () => {
  const context = buildModelContext({
    record: {
      business_name: 'Acme HVAC',
      site_text: 'Only declared evidence reaches the model.',
      cost_ledger_json: '{"usd":99}',
    },
    inputs: {
      account: { from: 'business_name' },
      evidence: { from: 'site_text' },
    },
    strict: true,
  });

  assert.deepEqual(context.data, {
    account: 'Acme HVAC',
    evidence: 'Only declared evidence reaches the model.',
  });
  assert.equal(context.serialized.includes('cost_ledger_json'), false);
});

test('stage input diagnostics name every missing field and its read source', () => {
  const messages = stageInputDiagnosticMessages({
    pipeline: [{
      kind: 'enrich',
      id: 'site_scrape',
      action: 'tool_call',
      inputs: ['website', 'unused_input'],
      args_map: { url: 'website', city: 'city' },
      when: {
        match: 'all',
        conditions: [{ field: 'created_at', operator: 'is_not_empty' }],
      },
      outputs: {},
    }],
  });

  assert.deepEqual(messages.errors, [
    'pipeline.site_scrape (enrich) reads undeclared input fields: "created_at" (when), "city" (args_map.city).',
  ]);
  assert.deepEqual(messages.warnings, [
    'pipeline.site_scrape (enrich) declares unread inputs: "unused_input".',
  ]);
});

test('config validation makes under-declared stage reads an actionable error', () => {
  const normalized = normalizeConfig({
    pipeline: [{
      kind: 'filter',
      id: 'company_gate',
      type: 'field_check',
      conditions: [{ field: 'company_resolution', operator: 'eq', value: 'resolved' }],
      inputs: [],
    }],
  });

  assert.ok(normalized.errors.includes(
    'pipeline.company_gate (filter) reads undeclared input fields: "company_resolution" (conditions).',
  ));
});

test('config warns when a step reads a field with no current producer', () => {
  const normalized = normalizeConfig({
    pipeline: [{
      kind: 'filter',
      id: 'email_review_gate',
      type: 'field_check',
      inputs: ['email_body'],
      conditions: [{ field: 'email_body', operator: 'is_not_empty' }],
    }],
  });

  assert.ok(normalized.warnings.some((warning) => (
    warning.includes('pipeline.email_review_gate') && warning.includes('email_body')
  )));
});

test('config does not warn for sourced, manually overridden, or inbound fields', () => {
  const normalized = normalizeConfig({
    source: {
      searches: [{ manual_results: [{ sourced_note: 'Imported with the lead.' }] }],
    },
    pipeline: [
      {
        kind: 'filter',
        id: 'source_gate',
        type: 'field_check',
        inputs: ['sourced_note'],
        conditions: [{ field: 'sourced_note', operator: 'is_not_empty' }],
      },
      {
        kind: 'filter',
        id: 'manual_gate',
        type: 'field_check',
        inputs: ['human_note'],
        conditions: [{ field: 'human_note', operator: 'is_not_empty' }],
      },
      {
        kind: 'filter',
        id: 'inbound_gate',
        type: 'field_check',
        inputs: ['inbound_proposed_classification'],
        conditions: [{ field: 'inbound_proposed_classification', operator: 'is_not_empty' }],
      },
    ],
  }, { manualOverrideFields: ['human_note'] });

  assert.deepEqual(
    normalized.warnings.filter((warning) => warning.includes('no current pipeline step produces it')),
    [],
  );
});

test('config does not warn for engine-managed state or LinkedIn-resolved invitation copy', () => {
  const normalized = normalizeConfig({
    pipeline: [
      {
        kind: 'review',
        id: 'sourced_review',
        fields: ['duplicate_reason'],
      },
      {
        kind: 'filter',
        id: 'local_buying_autonomy_gate',
        type: 'semantic',
        inputs: ['fit_coverage'],
      },
      {
        kind: 'enrich',
        id: 'treatment_assignment',
        action: 'policy_apply',
        inputs: [
          'fit_breakdown_json', 'identity_confidence', 'phone_confidence',
          'buyer_confidence', 'mail_confidence', 'mail_address_ready', 'timing_score',
          'strong_signal_strength', 'strong_signal_count', 'enrichment_cost_usd',
        ],
      },
      {
        kind: 'linkedin_connect',
        id: 'linkedin_1',
        side_effecting: true,
        inputs: ['invite_message'],
        review: {
          present: [{ field: 'invite_message' }],
          require_non_empty: ['invite_message'],
        },
      },
      {
        kind: 'enrich',
        id: 'decision_maker_discovery',
        outputs: {
          decision_maker_discovery_name: { type: 'string', description: 'Provider-specific name.' },
          decision_maker_discovery_title: { type: 'string', description: 'Provider-specific title.' },
          fit_evidence_confidence: { type: 'number', description: 'Scoring confidence.' },
          classification_confidence: { type: 'number', description: 'Classification confidence.' },
          treatment_tier: { type: 'string', description: 'Existing treatment tier.' },
          candidate_tier: { type: 'string', description: 'Existing candidate tier.' },
        },
      },
      {
        kind: 'generate',
        id: 'account_intelligence',
        inputs: ['decision_maker_name', 'decision_maker_title'],
      },
    ],
  });

  const abandonedStateWarnings = normalized.warnings.filter((warning) => (
    warning.includes('no current pipeline step produces it')
  ));

  assert.deepEqual(abandonedStateWarnings, [
    'pipeline.account_intelligence (generate) reads field "decision_maker_name" (model context), but no current pipeline step produces it and no known non-pipeline source supplies it.',
    'pipeline.account_intelligence (generate) reads field "decision_maker_title" (model context), but no current pipeline step produces it and no known non-pipeline source supplies it.',
  ]);
});

test('a template placeholder counts as a read of the field it interpolates', () => {
  const sendStep = {
    kind: 'send_email',
    id: 'email_1',
    template: 'welcome',
    side_effecting: true,
    inputs: ['contact_email', 'contact_first_name'],
    config: {
      action: 'tool_call',
      args_map: { to: 'contact_email' },
    },
  };
  const templates = (body) => ({
    welcome: {
      id: 'welcome',
      versions: [
        { version: 1, subject: 'Hello', body: 'Hi {{contact_first_name | default: there}},' },
        { version: 2, subject: 'Hello', body },
      ],
    },
  });
  const unread = (config) => stageInputDiagnosticMessages(config).warnings
    .filter((warning) => warning.includes('unread'));

  // Interpolated by the newest version: declaring it is correct, not a dead declaration.
  assert.deepEqual(
    unread({ pipeline: [sendStep], templates: templates('Hi {{contact_first_name}},') }),
    [],
  );

  // Still interpolated by version 1, which `template_version` may select. Every version is
  // scanned, so dropping it from only the newest must not report the input as unread.
  assert.deepEqual(
    unread({ pipeline: [sendStep], templates: templates('Hi there,') }),
    [],
  );

  // Interpolated by no version at all: now it really is declared and never read.
  const gone = templates('Hi there,');
  gone.welcome.versions[0].body = 'Hi there,';
  assert.deepEqual(
    unread({ pipeline: [sendStep], templates: gone }),
    ['pipeline.email_1 (send_email) declares unread inputs: "contact_first_name".'],
  );

  // No catalog to consult — the check must not fail open and pass everything.
  assert.deepEqual(
    unread({ pipeline: [sendStep] }),
    ['pipeline.email_1 (send_email) declares unread inputs: "contact_first_name".'],
  );
});

// --- min_chars: minimum viable declared input --------------------------------
// Boundary: length === min_chars is viable (runs). length < min_chars does not.
// Absent min_chars: no minimum, byte-identical to prior behaviour.
// Non-strings: config rejects min_chars on non-string literals; at runtime a
// non-string present value fails a positive min_chars (fail closed).

const mapStep = (inputs) => ({
  kind: 'score',
  id: 'capability_read',
  inputs,
});

test('min_chars: input longer than the threshold resolves cleanly and may run', () => {
  const resolved = resolveStageInputs({
    step: mapStep({
      site_text: { from: 'site_text', required: true, min_chars: 40 },
    }),
    record: { site_text: 'x'.repeat(86) },
  });
  assert.deepEqual(resolved.missingRequired, []);
  assert.deepEqual(resolved.belowMinimum, []);
  assert.equal(requiredInputNonExecutionReason(resolved), null);
  assert.equal(resolved.values.site_text, 'x'.repeat(86));
});

test('min_chars: input shorter than the threshold is a non-execution naming the input', () => {
  const thin = 'x'.repeat(86);
  const resolved = resolveStageInputs({
    step: mapStep({
      site_text: { from: 'site_text', required: true, min_chars: 400 },
    }),
    record: { site_text: thin },
  });
  assert.deepEqual(resolved.missingRequired, []);
  assert.deepEqual(resolved.belowMinimum, ['site_text']);
  assert.equal(
    requiredInputNonExecutionReason(resolved),
    'skipped_required_input_below_minimum:site_text',
  );
});

test('min_chars: absent required input stays missing-required, distinguishable from below-minimum', () => {
  const absent = resolveStageInputs({
    step: mapStep({
      site_text: { from: 'site_text', required: true, min_chars: 400 },
    }),
    record: { site_text: '' },
  });
  assert.deepEqual(absent.missingRequired, ['site_text']);
  assert.deepEqual(absent.belowMinimum, []);
  assert.equal(
    requiredInputNonExecutionReason(absent),
    'skipped_required_input_missing:site_text',
  );

  const missingKey = resolveStageInputs({
    step: mapStep({
      site_text: { from: 'site_text', required: true, min_chars: 400 },
    }),
    record: {},
  });
  assert.deepEqual(missingKey.missingRequired, ['site_text']);
  assert.deepEqual(missingKey.belowMinimum, []);
  assert.equal(
    requiredInputNonExecutionReason(missingKey),
    'skipped_required_input_missing:site_text',
  );

  const below = resolveStageInputs({
    step: mapStep({
      site_text: { from: 'site_text', required: true, min_chars: 400 },
    }),
    record: { site_text: 'short' },
  });
  assert.notEqual(
    requiredInputNonExecutionReason(absent),
    requiredInputNonExecutionReason(below),
  );
  assert.match(requiredInputNonExecutionReason(below), /below_minimum/);
  assert.match(requiredInputNonExecutionReason(absent), /input_missing/);
});

test('min_chars: step with no min_chars declared is completely unaffected', () => {
  const thin = 'x'.repeat(10);
  const withMap = resolveStageInputs({
    step: mapStep({
      site_text: { from: 'site_text', required: true },
    }),
    record: { site_text: thin },
  });
  assert.deepEqual(withMap.missingRequired, []);
  assert.deepEqual(withMap.belowMinimum, []);
  assert.equal(requiredInputNonExecutionReason(withMap), null);
  assert.equal(withMap.values.site_text, thin);

  const arrayForm = resolveStageInputs({
    step: { kind: 'extract', id: 'e', inputs: ['site_text'] },
    record: { site_text: thin },
  });
  assert.deepEqual(arrayForm.missingRequired, []);
  assert.deepEqual(arrayForm.belowMinimum, []);
  assert.equal(requiredInputNonExecutionReason(arrayForm), null);
});

test('min_chars: zero and exact boundary — length >= min_chars is viable', () => {
  // min_chars: 0 never fails a present string (length < 0 is impossible).
  const zero = resolveStageInputs({
    step: mapStep({
      site_text: { from: 'site_text', required: true, min_chars: 0 },
    }),
    record: { site_text: 'a' },
  });
  assert.deepEqual(zero.belowMinimum, []);
  assert.equal(requiredInputNonExecutionReason(zero), null);

  // Exact equality is viable (not below).
  const exact = resolveStageInputs({
    step: mapStep({
      site_text: { from: 'site_text', required: true, min_chars: 5 },
    }),
    record: { site_text: '12345' },
  });
  assert.deepEqual(exact.belowMinimum, []);
  assert.equal(requiredInputNonExecutionReason(exact), null);

  // One under is below.
  const under = resolveStageInputs({
    step: mapStep({
      site_text: { from: 'site_text', required: true, min_chars: 5 },
    }),
    record: { site_text: '1234' },
  });
  assert.deepEqual(under.belowMinimum, ['site_text']);
  assert.equal(
    requiredInputNonExecutionReason(under),
    'skipped_required_input_below_minimum:site_text',
  );
});

test('min_chars: invalid declarations are rejected by config validation', () => {
  const scoreBase = {
    kind: 'score',
    id: 'score_fit',
    key: 'fit',
    model: 'openrouter/anthropic/claude-haiku-4.5',
    criteria: [{ id: 'c', weight: 1, description: 'criterion' }],
    outputs: {
      fit_score: { type: 'number' },
      fit_breakdown: { type: 'json' },
      fit_reasoning: { type: 'string' },
    },
  };

  const negative = normalizeConfig({
    pipeline: [{
      ...scoreBase,
      inputs: { evidence: { from: 'site_text', min_chars: -1 } },
    }],
  });
  assert.ok(negative.errors.length > 0, 'negative min_chars must error');
  assert.ok(
    negative.errors.some((error) => /min_chars|too_small|greater than or equal/i.test(error)),
    negative.errors.join('\n'),
  );

  const nonInteger = normalizeConfig({
    pipeline: [{
      ...scoreBase,
      inputs: { evidence: { from: 'site_text', min_chars: 3.5 } },
    }],
  });
  assert.ok(nonInteger.errors.length > 0, 'non-integer min_chars must error');

  const onNumberLiteral = normalizeConfig({
    pipeline: [{
      kind: 'generate',
      id: 'g',
      inputs: { count: { value: 42, min_chars: 2 } },
      outputs: { note: { type: 'string', description: 'n' } },
    }],
  });
  assert.ok(onNumberLiteral.errors.length > 0, 'min_chars on non-string value must error');
  assert.ok(
    onNumberLiteral.errors.some((error) => /min_chars|string/i.test(error)),
    onNumberLiteral.errors.join('\n'),
  );

  const valid = normalizeConfig({
    pipeline: [{
      ...scoreBase,
      inputs: { evidence: { from: 'site_text', required: true, min_chars: 400 } },
    }],
  });
  assert.deepEqual(valid.errors, []);
});

test('min_chars: non-string present values fail a positive threshold at resolve time', () => {
  const resolved = resolveStageInputs({
    step: mapStep({
      score: { from: 'fit_score', required: true, min_chars: 1 },
    }),
    record: { fit_score: 88 },
  });
  assert.deepEqual(resolved.missingRequired, []);
  assert.deepEqual(resolved.belowMinimum, ['score']);
  assert.equal(
    requiredInputNonExecutionReason(resolved),
    'skipped_required_input_below_minimum:score',
  );
});

// --- max_chars: ceiling on declared input (truncate, do not refuse) ----------
// Boundary: length === max_chars is untouched (no truncation). length > max_chars
// is clamped; the step may still run. Absent max_chars: byte-identical to today.
// max_chars: 0 yields the empty string and records the clamp.

test('max_chars: input longer than the threshold is truncated and the step may run', () => {
  const long = `${'word '.repeat(20)}tail`;
  const resolved = resolveStageInputs({
    step: mapStep({
      site_text: { from: 'site_text', required: true, max_chars: 40 },
    }),
    record: { site_text: long },
  });
  assert.ok(long.length > 40);
  assert.ok(typeof resolved.values.site_text === 'string');
  assert.ok(resolved.values.site_text.length <= 40);
  assert.deepEqual(resolved.missingRequired, []);
  assert.deepEqual(resolved.belowMinimum, []);
  // Truncation does not refuse execution.
  assert.equal(requiredInputNonExecutionReason(resolved), null);
  assert.equal(resolved.truncated.length, 1);
  assert.equal(resolved.truncated[0].name, 'site_text');
  assert.equal(resolved.truncated[0].originalChars, long.length);
  assert.equal(resolved.truncated[0].keptChars, resolved.values.site_text.length);
  assert.equal(
    inputTruncationReason(resolved),
    `input_truncated:site_text:${long.length}->${resolved.values.site_text.length}`,
  );
});

test('max_chars: truncation is recorded naming the input and the sizes', () => {
  const long = 'x'.repeat(100);
  const resolved = resolveStageInputs({
    step: mapStep({
      evidence: { from: 'site_text', required: true, max_chars: 25 },
    }),
    record: { site_text: long },
  });
  assert.deepEqual(resolved.truncated, [{
    name: 'evidence',
    originalChars: 100,
    keptChars: 25,
  }]);
  assert.equal(inputTruncationReason(resolved), 'input_truncated:evidence:100->25');
  assert.equal(resolved.values.evidence, 'x'.repeat(25));
});

test('max_chars: input under the limit is untouched (byte-identical value)', () => {
  const short = 'exact payload ✨';
  const resolved = resolveStageInputs({
    step: mapStep({
      site_text: { from: 'site_text', required: true, max_chars: 400 },
    }),
    record: { site_text: short },
  });
  assert.equal(resolved.values.site_text, short);
  assert.equal(resolved.values.site_text, 'exact payload ✨');
  assert.deepEqual(resolved.truncated, []);
  assert.equal(inputTruncationReason(resolved), null);
});

test('max_chars: step with no max_chars declared is completely unaffected', () => {
  const huge = 'z'.repeat(50_000);
  const withMap = resolveStageInputs({
    step: mapStep({
      site_text: { from: 'site_text', required: true },
    }),
    record: { site_text: huge },
  });
  assert.equal(withMap.values.site_text, huge);
  assert.deepEqual(withMap.truncated, []);
  assert.equal(requiredInputNonExecutionReason(withMap), null);

  const arrayForm = resolveStageInputs({
    step: { kind: 'filter', id: 'f', inputs: ['site_text'] },
    record: { site_text: huge },
  });
  assert.equal(arrayForm.values.site_text, huge);
  assert.deepEqual(arrayForm.truncated, []);
});

test('max_chars: min_chars and max_chars together — floor refuses, ceiling clamps', () => {
  // Too thin for min_chars: refuse (below minimum), even with a ceiling declared.
  const thin = resolveStageInputs({
    step: mapStep({
      site_text: { from: 'site_text', required: true, min_chars: 40, max_chars: 100 },
    }),
    record: { site_text: 'short' },
  });
  assert.deepEqual(thin.belowMinimum, ['site_text']);
  assert.equal(
    requiredInputNonExecutionReason(thin),
    'skipped_required_input_below_minimum:site_text',
  );

  // Long enough for min, over max: clamp and may run.
  const long = 'a'.repeat(250);
  const clamped = resolveStageInputs({
    step: mapStep({
      site_text: { from: 'site_text', required: true, min_chars: 40, max_chars: 100 },
    }),
    record: { site_text: long },
  });
  assert.deepEqual(clamped.belowMinimum, []);
  assert.equal(requiredInputNonExecutionReason(clamped), null);
  assert.equal(clamped.values.site_text, 'a'.repeat(100));
  assert.deepEqual(clamped.truncated, [{
    name: 'site_text',
    originalChars: 250,
    keptChars: 100,
  }]);
});

test('max_chars: max_chars < min_chars is rejected at config validation', () => {
  const scoreBase = {
    kind: 'score',
    id: 'score_fit',
    key: 'fit',
    model: 'openrouter/anthropic/claude-haiku-4.5',
    criteria: [{ id: 'c', weight: 1, description: 'criterion' }],
    outputs: {
      fit_score: { type: 'number' },
      fit_breakdown: { type: 'json' },
      fit_reasoning: { type: 'string' },
    },
  };

  const inverted = normalizeConfig({
    pipeline: [{
      ...scoreBase,
      inputs: { evidence: { from: 'site_text', min_chars: 400, max_chars: 100 } },
    }],
  });
  assert.ok(inverted.errors.length > 0, 'max_chars < min_chars must error');
  assert.ok(
    inverted.errors.some((error) => /max_chars|min_chars/i.test(error)),
    inverted.errors.join('\n'),
  );

  const equal = normalizeConfig({
    pipeline: [{
      ...scoreBase,
      inputs: { evidence: { from: 'site_text', min_chars: 100, max_chars: 100 } },
    }],
  });
  assert.deepEqual(equal.errors, []);
});

test('max_chars: zero and exact boundary — length > max_chars clamps; length === max_chars untouched', () => {
  // max_chars: 0 → empty string, recorded, step may still run (not a below-minimum).
  const zero = resolveStageInputs({
    step: mapStep({
      site_text: { from: 'site_text', required: true, max_chars: 0 },
    }),
    record: { site_text: 'still present originally' },
  });
  assert.equal(zero.values.site_text, '');
  assert.deepEqual(zero.truncated, [{
    name: 'site_text',
    originalChars: 'still present originally'.length,
    keptChars: 0,
  }]);
  // Original was present, so required is satisfied; clamp does not invent absence.
  assert.deepEqual(zero.missingRequired, []);
  assert.equal(requiredInputNonExecutionReason(zero), null);
  assert.equal(
    inputTruncationReason(zero),
    `input_truncated:site_text:${'still present originally'.length}->0`,
  );

  // Exact equality is not truncated.
  const exact = resolveStageInputs({
    step: mapStep({
      site_text: { from: 'site_text', required: true, max_chars: 5 },
    }),
    record: { site_text: '12345' },
  });
  assert.equal(exact.values.site_text, '12345');
  assert.deepEqual(exact.truncated, []);
  assert.equal(inputTruncationReason(exact), null);

  // One over is truncated.
  const over = resolveStageInputs({
    step: mapStep({
      site_text: { from: 'site_text', required: true, max_chars: 5 },
    }),
    record: { site_text: '123456' },
  });
  assert.equal(over.values.site_text, '12345');
  assert.deepEqual(over.truncated, [{ name: 'site_text', originalChars: 6, keptChars: 5 }]);
});

test('max_chars: invalid declarations are rejected by config validation', () => {
  const scoreBase = {
    kind: 'score',
    id: 'score_fit',
    key: 'fit',
    model: 'openrouter/anthropic/claude-haiku-4.5',
    criteria: [{ id: 'c', weight: 1, description: 'criterion' }],
    outputs: {
      fit_score: { type: 'number' },
      fit_breakdown: { type: 'json' },
      fit_reasoning: { type: 'string' },
    },
  };

  const negative = normalizeConfig({
    pipeline: [{
      ...scoreBase,
      inputs: { evidence: { from: 'site_text', max_chars: -1 } },
    }],
  });
  assert.ok(negative.errors.length > 0, 'negative max_chars must error');

  const nonInteger = normalizeConfig({
    pipeline: [{
      ...scoreBase,
      inputs: { evidence: { from: 'site_text', max_chars: 3.5 } },
    }],
  });
  assert.ok(nonInteger.errors.length > 0, 'non-integer max_chars must error');

  const onNumberLiteral = normalizeConfig({
    pipeline: [{
      kind: 'generate',
      id: 'g',
      inputs: { count: { value: 42, max_chars: 2 } },
      outputs: { note: { type: 'string', description: 'n' } },
    }],
  });
  assert.ok(onNumberLiteral.errors.length > 0, 'max_chars on non-string value must error');
  assert.ok(
    onNumberLiteral.errors.some((error) => /max_chars|string/i.test(error)),
    onNumberLiteral.errors.join('\n'),
  );

  const valid = normalizeConfig({
    pipeline: [{
      ...scoreBase,
      inputs: { evidence: { from: 'site_text', required: true, max_chars: 50_000 } },
    }],
  });
  assert.deepEqual(valid.errors, []);
});

test('max_chars: prefers a whitespace boundary over a mid-word cut', () => {
  // "hello world" max 8 → hard cut "hello wo" → back up to "hello"
  assert.equal(truncateInputToMaxChars('hello world', 8), 'hello');
  // Already on a boundary (next char is space): keep hard cut.
  assert.equal(truncateInputToMaxChars('hello world', 5), 'hello');
  // No whitespace in window: hard cut.
  assert.equal(truncateInputToMaxChars('abcdefghij', 4), 'abcd');
  // Exact and under: byte-identical.
  assert.equal(truncateInputToMaxChars('hello', 5), 'hello');
  assert.equal(truncateInputToMaxChars('hi', 5), 'hi');
  assert.equal(truncateInputToMaxChars('anything', 0), '');
});

test('max_chars: map-form model context clamps before the assembled budget check', () => {
  // Live failure mode: a ~100k+ site_text blows the default assembled budget.
  // Per-input max_chars on the declared map reduces the contributor so assembly
  // succeeds — the ceiling is per input, the budget is on the assembled payload.
  const huge = 'x'.repeat(120_000);
  assert.throws(() => buildModelContext({
    record: { site_text: huge, business_name: 'Acme' },
    inputs: {
      site_text: { from: 'site_text' },
      business_name: { from: 'business_name' },
    },
    strict: true,
    budget: { max_chars: 100_000, max_tokens: 25_000 },
  }), /Model context budget exceeded/);

  const context = buildModelContext({
    record: { site_text: huge, business_name: 'Acme' },
    inputs: {
      site_text: { from: 'site_text', max_chars: 40_000 },
      business_name: { from: 'business_name' },
    },
    strict: true,
    budget: { max_chars: 100_000, max_tokens: 25_000 },
  });
  assert.equal(typeof context.data.site_text, 'string');
  assert.ok(context.data.site_text.length <= 40_000);
  assert.equal(context.data.business_name, 'Acme');
  assert.ok(context.telemetry.truncated_inputs?.length === 1);
  assert.equal(context.telemetry.truncated_inputs[0].name, 'site_text');
  assert.equal(context.telemetry.truncated_inputs[0].originalChars, 120_000);
  assert.ok(context.telemetry.chars <= 100_000);
});
