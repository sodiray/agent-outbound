/**
 * Provider client errors must not be retried.
 *
 * - 400/401/403/404/422 → non-retryable (fail closed, record error, no re-attempt)
 * - 429 and 5xx → retryable (existing Retry-After / in-process retry preserved)
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  isNonRetryableProviderError,
  isRetryableHttpStatus,
  isRetryableProviderError,
  providerHttpStatus,
  providerRetryAfter,
} from '../dist/orchestrator/lib/provider-retry.js';
import { isRetryableToolError } from '../dist/orchestrator/enrichment/actions/tool-call.js';
import { executeStepBatch } from '../dist/orchestrator/pipeline/step-executor.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { emailVerificationProviderFailureError } from '../dist/orchestrator/runtime/providers/email-verification/types.js';
import { readStaleness } from '../dist/orchestrator/enrichment/runner.js';

const listDir = () => mkdtempSync(join(tmpdir(), 'agent-outbound-provider-retry-'));

// ---------------------------------------------------------------------------
// Pure classification
// ---------------------------------------------------------------------------

test('isRetryableHttpStatus: only 429 and 5xx', () => {
  assert.equal(isRetryableHttpStatus(429), true);
  assert.equal(isRetryableHttpStatus(500), true);
  assert.equal(isRetryableHttpStatus(502), true);
  assert.equal(isRetryableHttpStatus(503), true);
  assert.equal(isRetryableHttpStatus(504), true);
  assert.equal(isRetryableHttpStatus(400), false);
  assert.equal(isRetryableHttpStatus(401), false);
  assert.equal(isRetryableHttpStatus(403), false);
  assert.equal(isRetryableHttpStatus(404), false);
  assert.equal(isRetryableHttpStatus(422), false);
  assert.equal(isRetryableHttpStatus(200), false);
});

test('providerHttpStatus reads structured status (not message text)', () => {
  assert.equal(providerHttpStatus({ status: 400, message: 'HTTP 503' }), 400);
  assert.equal(providerHttpStatus({ statusCode: 429 }), 429);
  assert.equal(providerHttpStatus({ failure: { status: 503 } }), 503);
  assert.equal(providerHttpStatus(new Error('HTTP 400')), undefined);
});

test('isNonRetryableProviderError / isRetryableProviderError: structured 400 is never retried even if retryable flag or message says otherwise', () => {
  assert.equal(isNonRetryableProviderError({ status: 400, retryable: true, message: 'try again later' }), true);
  assert.equal(isRetryableProviderError({ status: 400, retryable: true, message: 'try again later' }), false);
  assert.equal(isRetryableProviderError({ status: 400, retryable: false }), false);
  assert.equal(isNonRetryableProviderError(emailVerificationProviderFailureError({
    provider: 'hunter',
    failure: {
      cause: 'provider',
      message: 'Hunter rejected the email-verification request.',
      retryable: false,
      status: 400,
    },
  })), true);
  assert.equal(isRetryableProviderError({ status: 422 }), false);
  assert.equal(isNonRetryableProviderError({ status: 401 }), true);
  // Unknown bare errors stay eligible for the historical in-process second attempt.
  assert.equal(isNonRetryableProviderError(new Error('provider_declined')), false);
});

test('isRetryableProviderError: 429 and 503 remain retryable; Retry-After preserved on error', () => {
  const rateLimited = emailVerificationProviderFailureError({
    provider: 'hunter',
    failure: {
      cause: 'quota',
      message: 'quota exhausted',
      retryable: true,
      status: 429,
      retry_after: '3600',
    },
  });
  assert.equal(isRetryableProviderError(rateLimited), true);
  assert.equal(providerRetryAfter(rateLimited), '3600');

  assert.equal(isRetryableProviderError({ status: 503, message: 'unavailable' }), true);
  assert.equal(isRetryableProviderError({ status: 500 }), true);
});

test('isRetryableToolError delegates to the same classifier', () => {
  assert.equal(isRetryableToolError({ status: 400 }), false);
  assert.equal(isRetryableToolError({ status: 429 }), true);
  assert.equal(isRetryableToolError({ status: 503 }), true);
  // Message-only path when no structured status (transport).
  assert.equal(isRetryableToolError(new Error('HTTP 429 rate limit')), true);
  assert.equal(isRetryableToolError(new Error('502 Bad Gateway')), true);
  assert.equal(isRetryableToolError(new Error('invalid_argument: bad domain')), false);
});

// ---------------------------------------------------------------------------
// Enrichment path: email-verification provider failures
// ---------------------------------------------------------------------------

const contactSourceStep = {
  kind: 'contact_source',
  id: 'published_email_contact',
  field: 'published_email',
  role: 'primary',
};

const verificationStep = {
  kind: 'enrich',
  id: 'verify_published_email',
  action: 'email_verification',
  provider: 'test-verifier',
  field: 'published_email',
  inputs: ['published_email'],
  unit_cost_usd: 0.05,
};

const failingProvider = (failure) => {
  const calls = [];
  return {
    id: 'test-verifier',
    calls,
    verify: async ({ email }) => {
      calls.push(email);
      return { kind: 'failure', failure };
    },
  };
};

const withDb = async (record, callback) => {
  const root = listDir();
  const db = openListDb({ listDir: root });
  ensureRecordColumns({ db, columns: Object.keys(record) });
  upsertRecord({
    db,
    row: {
      _row_id: 'provider_retry_record',
      business_name: 'Acme',
      candidate_tier: 'A',
      ...record,
    },
  });
  try {
    return await callback({ db, root });
  } finally {
    db.close();
  }
};

const currentRecord = (db) => db.prepare('SELECT * FROM records WHERE _row_id = ?')
  .get('provider_retry_record');

const execute = async ({ db, root, step, provider, force = false }) => (
  await executeStepBatch(
    {
      db,
      listDir: root,
      config: { ai: {} },
      mcp: null,
      toolCatalog: null,
      emailVerificationProvider: provider,
      force,
    },
    step,
    step.id,
    [currentRecord(db)],
  )
).get('provider_retry_record');

test('HTTP 400 provider failure is NOT retried in-process and is recorded as an error (not a pass)', async () => {
  const provider = failingProvider({
    cause: 'provider',
    message: 'Hunter rejected the email-verification request.',
    retryable: false,
    status: 400,
  });

  await withDb({ published_email: '**info@example.com' }, async ({ db, root }) => {
    await execute({ db, root, step: contactSourceStep, provider });
    const outcome = await execute({ db, root, step: verificationStep, provider });
    const record = currentRecord(db);

    assert.equal(outcome.passed, false, 'must not be recorded as a pass');
    assert.equal(outcome.errored, true, 'must surface as an error');
    assert.match(outcome.reason, /HTTP 400/);
    assert.match(outcome.reason, /provider "test-verifier" failed/);
    assert.equal(provider.calls.length, 1, 'must not re-call the provider in-process');
    assert.equal(provider.calls[0], '**info@example.com');
    assert.equal(record.verify_published_email__status, 'failed');
    assert.match(String(record.last_error || ''), /HTTP 400/);
    // Permanent failure writes staleness so subsequent runs do not re-burn quota.
    assert.ok(readStaleness({ db, recordId: 'provider_retry_record', stepId: 'verify_published_email' }));
  });
});

test('HTTP 400 permanent failure is NOT re-attempted on a subsequent run', async () => {
  const provider = failingProvider({
    cause: 'provider',
    message: 'Hunter rejected the email-verification request.',
    retryable: false,
    status: 400,
  });

  await withDb({ published_email: '**info@example.com' }, async ({ db, root }) => {
    await execute({ db, root, step: contactSourceStep, provider });
    const first = await execute({ db, root, step: verificationStep, provider });
    assert.equal(first.passed, false);
    assert.equal(provider.calls.length, 1);

    const second = await execute({ db, root, step: verificationStep, provider });
    assert.equal(provider.calls.length, 1, 'second pipeline run must not re-call the provider');
    // Fresh skip is a non-execution skip (passed=true with skipped:fresh), not a silent pass of the step work.
    assert.equal(second.passed, true);
    assert.match(String(second.reason || ''), /skipped:fresh/);
    const record = currentRecord(db);
    assert.equal(record.verify_published_email__status, 'failed');
    assert.match(String(record.last_error || ''), /HTTP 400/);
  });
});

test('HTTP 429 IS retried later: one call now, re-attempt on subsequent run (Retry-After preserved)', async () => {
  const provider = failingProvider({
    cause: 'quota',
    message: 'Hunter verification quota exhausted for this billing period.',
    retryable: true,
    status: 429,
    retry_after: '3600',
  });

  await withDb({ published_email: 'owner@acme.example' }, async ({ db, root }) => {
    await execute({ db, root, step: contactSourceStep, provider });
    const first = await execute({ db, root, step: verificationStep, provider });
    assert.equal(first.passed, false);
    assert.match(first.reason, /HTTP 429/);
    assert.match(first.reason, /Retry-After: 3600/);
    // Retry-After defers the in-process second attempt; still only one call this run.
    assert.equal(provider.calls.length, 1);
    assert.equal(
      readStaleness({ db, recordId: 'provider_retry_record', stepId: 'verify_published_email' }),
      undefined,
      'retryable failure must clear staleness so later runs re-attempt',
    );

    const second = await execute({ db, root, step: verificationStep, provider });
    assert.equal(second.passed, false);
    assert.equal(provider.calls.length, 2, '429 must be re-attempted on a subsequent run');
    assert.equal(currentRecord(db).verify_published_email__status, 'failed');
  });
});

test('HTTP 503 IS retried in-process (second attempt) when no Retry-After', async () => {
  const provider = failingProvider({
    cause: 'transport',
    message: 'Hunter is temporarily unavailable for email verification.',
    retryable: true,
    status: 503,
  });

  await withDb({ published_email: 'owner@acme.example' }, async ({ db, root }) => {
    await execute({ db, root, step: contactSourceStep, provider });
    const outcome = await execute({ db, root, step: verificationStep, provider });
    assert.equal(outcome.passed, false);
    assert.match(outcome.reason, /HTTP 503|temporarily unavailable/i);
    assert.equal(provider.calls.length, 2, '503 without Retry-After must get the in-process second attempt');
    assert.equal(currentRecord(db).verify_published_email__status, 'failed');
    assert.equal(
      readStaleness({ db, recordId: 'provider_retry_record', stepId: 'verify_published_email' }),
      undefined,
      'retryable 503 clears staleness for a later run',
    );
  });
});

test('non-retryable failure is never swallowed as a silent pass or empty success', async () => {
  const provider = failingProvider({
    cause: 'provider',
    message: 'malformed email',
    retryable: false,
    status: 400,
  });

  await withDb({ published_email: '**info@example.com' }, async ({ db, root }) => {
    await execute({ db, root, step: contactSourceStep, provider });
    const outcome = await execute({ db, root, step: verificationStep, provider });
    const record = currentRecord(db);
    const contact = db.prepare('SELECT * FROM contacts WHERE row_id = ?').get('provider_retry_record');

    assert.equal(outcome.passed, false);
    assert.equal(outcome.errored, true);
    assert.ok(String(outcome.reason || '').trim(), 'must record a clear error reason');
    assert.notEqual(record.verify_published_email__status, 'ok');
    assert.notEqual(record.verify_published_email__status, 'empty');
    assert.equal(record.verify_published_email__status, 'failed');
    // Must not invent a verification verdict from a provider failure.
    assert.equal(contact.email_verification_status, 'pipeline_supplied');
  });
});
