import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ModelContextBudgetError,
  buildBusinessEvidenceModelContext,
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

test('business-evidence context excludes internal scoring and pipeline fields', () => {
  const context = buildBusinessEvidenceModelContext({
    record: {
      business_name: 'Brain Restore Centers',
      address: '123 Main St, Boise, ID',
      vertical: 'healthcare_clinical',
      services: 'Brain injury rehabilitation',
      site_text: 'Neurological rehabilitation and concussion support.',
      contact_name: 'Jordan Owner',
      contact_email: 'jordan@example.test',
      fit_score: 88,
      fit_evidence_confidence: 92,
      identity_confidence: 90,
      treatment_tier: 'A',
      candidate_tier: 'A',
      score_status: 'fresh',
      fit_coverage: 1,
      readiness: true,
      readiness_json: '{"ready":true}',
      taxonomy_validation_json: '{"fallback_applied":true}',
      next_action_json: '{"action_type":"send_email"}',
      work_state: 'active',
      observations_json: JSON.stringify({
        observations: [
          { predicate: 'services', value: 'Concussion support', evidence_id: 'obs_services', support_status: 'literal_support' },
          { predicate: 'fit_score', value: 88, evidence_id: 'obs_fit', support_status: 'inferred' },
          { predicate: 'tool_failure', value: 'site scrape failed', evidence_id: 'obs_failure', support_status: 'tool_failure' },
        ],
      }),
    },
  });

  const denied = [
    'fit_score',
    'fit_evidence_confidence',
    'identity_confidence',
    'treatment_tier',
    'candidate_tier',
    'score_status',
    'fit_coverage',
    'readiness',
    'taxonomy_validation_json',
    'next_action_json',
    'work_state',
    'site scrape failed',
  ];
  for (const field of denied) assert.equal(context.serialized.includes(field), false, `${field} must not reach business-evidence context`);
  assert.match(context.serialized, /Neurological rehabilitation/);
  assert.match(context.serialized, /Concussion support/);
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
