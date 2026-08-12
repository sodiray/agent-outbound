import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { normalizeConfig } from '../dist/schemas/config.js';
import {
  declaredOutputWriteFailures,
  executeStepBatch,
  shouldGuardDeclaredOutputWrites,
} from '../dist/orchestrator/pipeline/step-executor.js';
import { runDataflowCore } from '../dist/orchestrator/pipeline/dataflow.js';
import { openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';

test('config rejects two steps that declare the same record column', () => {
  const { errors } = normalizeConfig({
    pipeline: [
      {
        kind: 'enrich',
        id: 'first_producer',
        outputs: { shared_column: { type: 'string', description: 'first value' } },
      },
      {
        kind: 'generate',
        id: 'second_producer',
        outputs: { shared_column: { type: 'string', description: 'second value' } },
      },
    ],
  });

  assert.ok(errors.some((error) => (
    error.includes('record column "shared_column"')
    && error.includes('"first_producer"')
    && error.includes('"second_producer"')
  )));
});

test('config rejects two nested steps that declare the same record column', () => {
  const { errors } = normalizeConfig({
    pipeline: [
      {
        kind: 'assign',
        id: 'route_nested',
        target: 'pipeline_name',
        fallback: 'nested',
      },
      {
        kind: 'pipeline',
        id: 'nested',
        manual: true,
        steps: [
          {
            kind: 'enrich',
            id: 'first_producer',
            outputs: { shared_column: { type: 'string', description: 'first value' } },
          },
          {
            kind: 'enrich',
            id: 'second_producer',
            outputs: { shared_column: { type: 'string', description: 'second value' } },
          },
        ],
      },
    ],
  });

  assert.ok(errors.some((error) => (
    error.includes('record column "shared_column"')
    && error.includes('"nested.first_producer"')
    && error.includes('"nested.second_producer"')
  )));
});

test('declared-output guard catches a partial output drop', () => {
  const failures = declaredOutputWriteFailures({
    outputNames: ['kept_output', 'dropped_output'],
    record: { kept_output: 'kept', dropped_output: '' },
    declaredOutputWrites: {
      kept_output: { provided: true, value: 'kept' },
      dropped_output: { provided: true, value: 'expected' },
    },
  });

  assert.deepEqual(failures, ['dropped_output']);
});

test('declared-output guard permits an intentionally blank output', () => {
  const failures = declaredOutputWriteFailures({
    outputNames: ['franchise_brand', 'ownership_type'],
    record: { franchise_brand: '', ownership_type: 'independent' },
    declaredOutputWrites: {
      franchise_brand: { provided: true, value: '' },
      ownership_type: { provided: true, value: 'independent' },
    },
  });

  assert.deepEqual(failures, []);
});

test('declared-output guard permits a columns-remapped output', () => {
  const failures = declaredOutputWriteFailures({
    outputNames: ['email_last_message_id'],
    record: { email_last_message_id: 'provider-message-id' },
    declaredOutputWrites: {
      email_last_message_id: { provided: true, value: 'provider-message-id' },
    },
  });

  assert.deepEqual(failures, []);
});

test('masked provider fields are not claimed or cascaded, including output_fields targets', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-masked-output-'));
  const db = openListDb({ listDir, readonly: false });
  const discoveryStep = {
    id: 'contact_discovery',
    kind: 'enrich',
    output_fields: {
      decision_maker_exists: 'discovery_exists',
      decision_maker_name: 'discovery_name',
      decision_maker_title: 'discovery_title',
      decision_maker_email: 'discovery_email',
    },
    outputs: {
      decision_maker_exists: { type: 'boolean' },
      decision_maker_name: { type: 'string' },
      decision_maker_title: { type: 'string' },
      decision_maker_email: { type: 'string' },
    },
    config: {
      action: 'tool_call',
      tool: {
        server: 'masked-provider',
        tools: ['DISCOVER_CONTACT'],
        effect: { class: 'data_lookup' },
      },
      output_map: {
        decision_maker_exists: 'exists',
        decision_maker_name: 'person.name',
        decision_maker_title: 'person.title',
        decision_maker_email: 'person.email',
      },
    },
    __tryTool: async () => ({
      result: { exists: true, provider_note: 'identity deliberately masked' },
      provider: 'masked-provider',
    }),
  };
  const downstreamStep = {
    id: 'downstream',
    kind: 'assign',
    target: 'sequence_name',
    fallback: 'default',
    rules: [],
  };
  const scheduled = [];
  const outcomes = [];
  try {
    upsertRecord({
      db,
      row: { _row_id: 'masked-record', business_name: 'Masked Co', sequence_status: 'active' },
    });
    const steps = [
      { id: discoveryStep.id, index: 0, step: discoveryStep, kind: 'enrich', tier: 2, cost: 0, dropGate: false, deps: [], executable: true },
      { id: downstreamStep.id, index: 1, step: downstreamStep, kind: 'assign', tier: 3, cost: 0, dropGate: false, deps: [discoveryStep.id], executable: true },
    ];
    const context = { db, listDir, config: {}, aiConfig: {}, mcp: null, toolCatalog: null, force: true };
    await runDataflowCore({
      records: [db.prepare('SELECT * FROM records WHERE _row_id = ?').get('masked-record')],
      steps,
      concurrency: 1,
      isTimeReady: () => true,
      loadStep: async (step, record) => {
        scheduled.push(step.id);
        if (step.id === discoveryStep.id) {
          return (await executeStepBatch(context, discoveryStep, discoveryStep.id, [record])).get('masked-record');
        }
        return { passed: true, reason: 'downstream_ran' };
      },
      onStepOutcome: async (_recordState, step, outcome) => {
        outcomes.push({ step: step.id, outcome });
        return { errored: Boolean(outcome.errored) };
      },
    });

    const persisted = db.prepare(`
      SELECT discovery_exists, discovery_name, discovery_title, discovery_email
      FROM records WHERE _row_id = ?
    `).get('masked-record');
    assert.deepEqual(persisted, {
      discovery_exists: 1,
      discovery_name: '',
      discovery_title: '',
      discovery_email: '',
    });
    assert.deepEqual(outcomes[0].outcome.declaredOutputWrites, {
      discovery_exists: { provided: true, value: 1 },
      discovery_name: { provided: false, value: undefined },
      discovery_title: { provided: false, value: undefined },
      discovery_email: { provided: false, value: undefined },
    });
    assert.deepEqual(scheduled, ['contact_discovery', 'downstream']);
  } finally {
    db.close();
  }
});

test('declared-output guard still errors for a meaningful claimed write absent from storage', () => {
  const failures = declaredOutputWriteFailures({
    outputNames: ['primary_type'],
    record: { primary_type: '' },
    declaredOutputWrites: {
      primary_type: { provided: true, value: 'electrician' },
    },
  });

  assert.deepEqual(failures, ['primary_type']);
});

test('declared-output guard permits a channel refusal', () => {
  // The exemption is the `executed: false` statement, not the reason spelling.
  assert.equal(shouldGuardDeclaredOutputWrites({
    passed: true,
    executed: false,
    reason: 'channel_not_permitted:readiness_not_ready',
  }), false);
});

test('declared-output guard permits a non-executed step', () => {
  assert.equal(shouldGuardDeclaredOutputWrites({
    passed: true,
    executed: false,
    reason: 'skipped_when_not_matched',
  }), false);
});

test('the reason string no longer grants an exemption on its own', () => {
  // The defect class this replaced: a reason that LOOKS like a skip escaped the
  // guard, and a new spelling of the same branch silently did not. Neither the
  // familiar spelling nor a novel one exempts anything now.
  assert.equal(shouldGuardDeclaredOutputWrites({
    passed: true,
    reason: 'skipped_when_not_matched',
  }), true);
  assert.equal(shouldGuardDeclaredOutputWrites({
    passed: true,
    reason: 'memoization_hit',
  }), true);
});
