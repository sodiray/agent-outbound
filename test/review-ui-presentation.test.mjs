import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../dist/schemas/config.js';
import {
  reviewIdentityAddsInformation,
  reviewLabelFor,
  reviewRecordName,
  shouldShowReviewIdentityColumn,
} from '../dist/viz/review-presentation.js';
import {
  resolveReviewDetail,
  reviewDetailHref,
  reviewDetailLinkText,
} from '../dist/viz/review-detail.js';

test('review record names use the declared title field and fall back only when it is absent or empty', () => {
  assert.equal(reviewRecordName({
    record: { _row_id: 'ChIJ8ZaI6nr5rIQRaE5N40BUWQc', venue_title: 'PALM TREE SPA' },
    titleField: 'venue_title',
  }), 'PALM TREE SPA');
  assert.equal(reviewRecordName({
    record: { _row_id: 'row-empty', venue_title: '   ' },
    titleField: 'venue_title',
  }), 'Record row-empty');
  assert.equal(reviewRecordName({
    record: { _row_id: 'row-undeclared', venue_title: 'PALM TREE SPA' },
  }), 'Record row-undeclared');
});

test('review identity column only appears for all stages when a declared title is not already visible', () => {
  const titleFieldForRecord = (record) => record._review_stage_id === 'review_venue'
    ? 'venue_title'
    : 'account_label';
  const identifiedRecords = [
    { _row_id: 'one', _review_stage_id: 'review_venue', venue_title: 'PALM TREE SPA' },
    { _row_id: 'two', _review_stage_id: 'review_account', account_label: 'Evergreen Co.' },
  ];

  assert.equal(shouldShowReviewIdentityColumn({
    isAllStages: false,
    records: identifiedRecords,
    titleFieldForRecord,
    visibleFields: ['venue_title', 'account_label'],
  }), false);
  assert.equal(shouldShowReviewIdentityColumn({
    isAllStages: true,
    records: identifiedRecords,
    titleFieldForRecord,
    visibleFields: ['venue_title', 'account_label'],
  }), false);

  const titleOnlyRecord = identifiedRecords[0];
  assert.equal(shouldShowReviewIdentityColumn({
    isAllStages: true,
    records: [titleOnlyRecord],
    titleFieldForRecord,
    visibleFields: ['priority'],
  }), true);
  assert.equal(reviewIdentityAddsInformation({
    record: titleOnlyRecord,
    titleField: 'venue_title',
    visibleFields: ['priority'],
  }), true);
  assert.equal(reviewRecordName({ record: titleOnlyRecord, titleField: 'venue_title' }), 'PALM TREE SPA');
});

test('review links use concise text, preserve their URL, and honor declared text and labels', () => {
  const url = 'https://maps.google.com/?cid=52954706886&g_mp=Cilnb29nbGUu';
  const normalized = normalizeConfig({
    pipeline: [{
      kind: 'review',
      id: 'review_venue',
      title_field: 'venue_title',
      detail: [{
        title: 'Overview',
        items: [{
          field: 'googleMapsUri',
          as: 'link',
          label: 'View on Google Maps',
          link_text: 'Open map',
        }],
      }],
    }],
  });
  const sections = resolveReviewDetail({
    detail: [{
      title: 'Overview',
      items: [{
        field: 'googleMapsUri',
        as: 'link',
        label: 'View on Google Maps',
        link_text: 'Open map',
      }],
    }],
    record: { googleMapsUri: url },
  });

  assert.deepEqual(normalized.errors, []);
  assert.equal(normalized.config.pipeline[0].title_field, 'venue_title');
  assert.equal(normalized.config.pipeline[0].detail[0].items[0].label, 'View on Google Maps');
  assert.equal(normalized.config.pipeline[0].detail[0].items[0].link_text, 'Open map');
  assert.deepEqual(sections, [{
    kind: 'fields',
    title: 'Overview',
    items: [{
      field: 'googleMapsUri',
      label: 'View on Google Maps',
      renderer: 'link',
      value: url,
      link_text: 'Open map',
    }],
  }]);
  assert.equal(reviewDetailHref({ renderer: 'link', value: url }), url);
  assert.equal(reviewDetailLinkText({ renderer: 'link', value: url }), 'maps.google.com');
  assert.equal(reviewDetailLinkText({ renderer: 'link', value: url, linkText: 'Open map' }), 'Open map');
  assert.equal(reviewLabelFor('googleMapsUri'), 'Google Maps Uri');
});
