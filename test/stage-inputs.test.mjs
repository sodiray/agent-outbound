import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UndeclaredStageInputError,
  stageInputDiagnosticMessages,
  stageInputRecord,
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
