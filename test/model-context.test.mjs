import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ModelContextBudgetError,
  buildModelContext,
  withModelContextTelemetry,
} from '../dist/orchestrator/lib/model-context.js';

test('model context is default-deny for undeclared record columns', () => {
  const context = buildModelContext({
    record: {
      _row_id: 'acct_1',
      business_name: 'Acme HVAC',
      site_text: 'raw retrieval body that must never become model context',
      transition_audit_json: '{"internal":true}',
      cost_ledger_json: '{"spent":99}',
      next_year_enrichment_blob: 'new columns are invisible by default',
    },
  });

  assert.deepEqual(context.data, {
    _row_id: 'acct_1',
    business_name: 'Acme HVAC',
  });
  assert.equal(context.serialized.includes('next_year_enrichment_blob'), false);
  assert.equal(context.serialized.includes('transition_audit_json'), false);
  assert.equal(context.serialized.includes('cost_ledger_json'), false);
});

test('model context preserves compact observations and evidence ids', () => {
  const context = buildModelContext({
    record: {
      _row_id: 'acct_1',
      observations_json: JSON.stringify({
        snapshots: [{ body: 'raw snapshot body must not be projected' }],
        observations: [{
          predicate: 'services',
          value: 'Heating and cooling',
          evidence_id: 'obs_acct_1_site_profile_services',
          support_status: 'literal_support',
          source_id: 'ret_1',
          literal_support: 'Heating and cooling',
        }],
      }),
    },
  });

  assert.deepEqual(context.data.observations_json, [{
    predicate: 'services',
    value: 'Heating and cooling',
    evidence_id: 'obs_acct_1_site_profile_services',
    support_status: 'literal_support',
  }]);
  assert.match(context.serialized, /obs_acct_1_site_profile_services/);
  assert.doesNotMatch(context.serialized, /raw snapshot body/);
});

test('model context budget breach names its largest contributors', () => {
  assert.throws(() => buildModelContext({
    record: {
      _row_id: 'acct_1',
      declared_detail: 'x'.repeat(300),
    },
    inputs: ['declared_detail'],
    budget: { max_chars: 100, max_tokens: 100 },
  }), (error) => (
    error instanceof ModelContextBudgetError
    && /declared_detail \(.* chars\)/.test(error.message)
    && /Model context budget exceeded/.test(error.message)
  ));
});

test('model context telemetry travels with model usage', () => {
  const context = buildModelContext({ record: { _row_id: 'acct_1' } });
  const usage = withModelContextTelemetry({ input_tokens: 3 }, context.telemetry);
  assert.deepEqual(usage.model_context, context.telemetry);
});

test('all record-backed model prompt paths use the shared model-context builder', () => {
  const paths = [
    'src/orchestrator/scoring/runner.ts',
    'src/orchestrator/lib/conditions.ts',
    'src/orchestrator/automations/runner.ts',
    'src/orchestrator/briefs/runner.ts',
    'src/orchestrator/actions/evaluate-condition/index.ts',
    'src/orchestrator/actions/execute-step/index.ts',
    'src/orchestrator/actions/sync-crm/index.ts',
  ];
  for (const path of paths) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.match(source, /buildModelContext/);
    assert.match(source, /withModelContextTelemetry/);
  }
});
