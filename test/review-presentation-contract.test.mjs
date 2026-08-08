import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../dist/schemas/config.js';
import {
  authorizeStageReview,
  pauseForStageReview,
} from '../dist/orchestrator/policy/transition-audit.js';
import {
  isReviewFieldAvailable,
  missingRequiredReviewFields,
  resolveReviewPresentation,
} from '../dist/orchestrator/policy/review-presentation.js';

const review = {
  purpose: 'Confirm the outbound message and its supporting evidence.',
  present: [
    { field: 'invite_message', label: 'Message to be sent' },
    { field: 'preliminary_snapshot', label: 'Evidence this rests on' },
  ],
  require_non_empty: ['invite_message'],
};

test('review presentation snapshots labeled record and upstream-output values for authorization', () => {
  const presentation = resolveReviewPresentation({
    step: { review },
    record: {
      invite_message: 'Hello Ada — would you be open to connecting?',
      preliminary_snapshot: 'Recent service expansion noted.',
    },
  });
  const paused = pauseForStageReview({
    account_id: 'review-presentation-1',
    stage_id: 'linkedin_1',
    asset_version: 'asset-review-1',
    presentation,
  });

  assert.deepEqual(paused.authorization.presentation, {
    ...review,
    present: [
      { ...review.present[0], value: 'Hello Ada — would you be open to connecting?' },
      { ...review.present[1], value: 'Recent service expansion noted.' },
    ],
  });
  const authorized = authorizeStageReview({
    review_id: paused.authorization.review_id,
    stage_id: paused.authorization.stage_id,
    asset_version: paused.authorization.asset_version,
    expected_asset_version: paused.authorization.asset_version,
    decision: 'authorize',
    account_id: 'review-presentation-1',
    existing: paused.authorization,
  });
  assert.deepEqual(authorized.authorization.presentation, paused.authorization.presentation);
});

test('review presentation resolves a field declared only in the step config', () => {
  const presentation = resolveReviewPresentation({
    step: {
      config: { invite_message: 'Configured fallback message.' },
      review: {
        present: [{ field: 'invite_message', label: 'Message' }],
        require_non_empty: ['invite_message'],
      },
    },
    record: {},
  });

  assert.equal(presentation?.present[0]?.value, 'Configured fallback message.');
  assert.deepEqual(missingRequiredReviewFields(presentation), []);
});

test('review presentation prefers an upstream produced value over a static step config value', () => {
  const presentation = resolveReviewPresentation({
    step: {
      config: { invite_message: 'Configured fallback message.' },
      review: { present: [{ field: 'invite_message', label: 'Message' }] },
    },
    producedValues: { invite_message: 'Composed for this record.' },
    record: {},
  });

  assert.equal(presentation?.present[0]?.value, 'Composed for this record.');
});

test('review presentation resolves a field declared only on the record', () => {
  const presentation = resolveReviewPresentation({
    step: { review: { present: [{ field: 'record_note', label: 'Record note' }] } },
    record: { record_note: 'Record-only value.' },
  });

  assert.equal(presentation?.present[0]?.value, 'Record-only value.');
});

test('review presentation fails closed when a required field has no value in any source', () => {
  const presentation = resolveReviewPresentation({
    step: {
      review: {
        present: [{ field: 'missing_value', label: 'Missing value' }],
        require_non_empty: ['missing_value'],
      },
    },
    record: {},
  });

  assert.deepEqual(missingRequiredReviewFields(presentation), ['missing_value']);
});

test('review availability and runtime resolution agree across representative sources', () => {
  const cases = [
    {
      field: 'produced_value',
      producedFields: ['produced_value'],
      recordFields: [],
      stepConfig: {},
      producedValues: { produced_value: 'Produced value.' },
      record: {},
    },
    {
      field: 'record_value',
      producedFields: [],
      recordFields: ['record_value'],
      stepConfig: {},
      producedValues: {},
      record: { record_value: 'Record value.' },
    },
    {
      field: 'configured_value',
      producedFields: [],
      recordFields: [],
      stepConfig: { configured_value: 'Configured value.' },
      producedValues: {},
      record: {},
    },
    {
      field: 'missing_value',
      producedFields: [],
      recordFields: [],
      stepConfig: {},
      producedValues: {},
      record: {},
    },
  ];

  for (const entry of cases) {
    const available = isReviewFieldAvailable(entry);
    const presentation = resolveReviewPresentation({
      step: {
        config: entry.stepConfig,
        review: { present: [{ field: entry.field, label: entry.field }] },
      },
      producedValues: entry.producedValues,
      record: entry.record,
    });
    const resolved = presentation?.present[0]?.value !== undefined;
    assert.equal(resolved, available, entry.field);
  }
});

test('stage authorization refuses a review whose required presented field is empty', () => {
  const paused = pauseForStageReview({
    account_id: 'review-presentation-2',
    stage_id: 'linkedin_1',
    asset_version: 'asset-review-2',
    presentation: {
      ...review,
      present: [
        { ...review.present[0], value: '' },
        { ...review.present[1], value: 'Evidence exists.' },
      ],
    },
  });

  const result = authorizeStageReview({
    review_id: paused.authorization.review_id,
    stage_id: paused.authorization.stage_id,
    asset_version: paused.authorization.asset_version,
    expected_asset_version: paused.authorization.asset_version,
    decision: 'authorize',
    account_id: 'review-presentation-2',
    existing: paused.authorization,
  });

  assert.equal(result.allowed, false);
  assert.match(result.reason, /required review field "invite_message" is empty/i);
});

test('config warns when a review-gated step omits review.present', () => {
  const normalized = normalizeConfig({
    pipeline: [{
      kind: 'linkedin_connect',
      id: 'linkedin_1',
      side_effecting: true,
    }],
    policy: { review_required_for: ['linkedin_connect'] },
  });

  assert.ok(normalized.warnings.some((warning) => (
    warning.includes('linkedin_1') && warning.includes('review.present')
  )));
});

test('config rejects a review presentation field with no record or upstream producer', () => {
  const normalized = normalizeConfig({
    pipeline: [{
      kind: 'linkedin_connect',
      id: 'linkedin_1',
      side_effecting: true,
      review: {
        present: [{ field: 'not_produced_anywhere', label: 'Missing' }],
      },
    }],
    policy: { review_required_for: ['linkedin_connect'] },
  });

  assert.ok(normalized.errors.some((error) => (
    error.includes('linkedin_1') && error.includes('not_produced_anywhere')
  )));
});

test('config resolves review fields from records, flattened upstream outputs, and local step config', () => {
  const normalized = normalizeConfig({
    pipeline: [
      {
        kind: 'compose',
        id: 'compose_email',
        model: 'test/model',
        structure: { composed_subject: 'A concise subject.' },
        inputs: { account: { from: 'business_name', required: true } },
        length: { max_words: 12, max_sentences: 2 },
        outputs: {
          composed_subject: { type: 'string', description: 'Composed subject' },
        },
      },
      {
        kind: 'pipeline',
        id: 'tier_a',
        steps: [{
          kind: 'linkedin_connect',
          id: 'send',
          side_effecting: true,
          config: { invite_message: 'Hello from the configured message.' },
          review: {
            present: [
              { field: 'record_column', label: 'Record column' },
              { field: 'composed_subject', label: 'Top-level output' },
              { field: 'invite_message', label: 'Local config value' },
              { field: 'emial_subject', label: 'Genuine typo' },
            ],
          },
        }],
      },
    ],
    policy: { review_required_for: ['linkedin_connect'] },
  }, { recordFields: ['record_column'] });

  const reviewErrors = normalized.errors.filter((error) => error.includes('review.present field'));
  assert.deepEqual(reviewErrors, [
    'pipeline.tier_a.send review.present field "emial_subject" is unavailable: no record field or upstream step produces it.',
  ]);
});
