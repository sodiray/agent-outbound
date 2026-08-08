import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../dist/schemas/config.js';
import {
  declaredOutputWriteFailures,
  shouldGuardDeclaredOutputWrites,
} from '../dist/orchestrator/pipeline/step-executor.js';

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

test('declared-output guard permits a channel refusal', () => {
  assert.equal(shouldGuardDeclaredOutputWrites({
    passed: true,
    reason: 'channel_not_permitted:readiness_not_ready',
  }), false);
});

test('declared-output guard permits a non-executed step', () => {
  assert.equal(shouldGuardDeclaredOutputWrites({
    passed: true,
    reason: 'skipped_when_not_matched',
  }), false);
});
