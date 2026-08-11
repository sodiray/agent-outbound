import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { normalizeConfig } from '../dist/schemas/config.js';
import { buildMeta } from '../dist/viz/data.js';
import {
  canRenderReviewDetailMap,
  resolveReviewDetail,
  reviewDetailHref,
} from '../dist/viz/review-detail.js';
import { ensureRecordColumns, openListDb } from '../dist/orchestrator/runtime/db.js';

const declaredDetail = [
  {
    title: 'Overview',
    items: [
      'display_name',
      { field: 'public_url', as: 'link' },
      { field: 'contact_address', as: 'email' },
      { field: 'contact_number', as: 'phone' },
    ],
  },
  {
    title: 'Signals',
    from: 'signal_payload',
    as: 'list',
    item: { text: 'summary' },
  },
  {
    title: 'Participants',
    from: 'participant_payload',
    as: 'table',
    columns: ['full_name', 'role', { field: 'address', as: 'email' }],
  },
];

test('declared review detail resolves only configured sections and fields', () => {
  const sections = resolveReviewDetail({
    detail: declaredDetail,
    record: {
      display_name: 'Example record',
      public_url: 'example.test',
      contact_address: 'operator@example.test',
      contact_number: '+1 555 0100',
      noisy_internal_payload: '{"hidden":true}',
      signal_payload: JSON.stringify([{ summary: 'One' }, { summary: 'Two' }]),
      participant_payload: JSON.stringify([{ full_name: 'Avery', role: 'Owner', address: 'avery@example.test' }]),
    },
  });

  assert.deepEqual(sections, [
    {
      kind: 'fields',
      title: 'Overview',
      items: [
        { field: 'display_name', renderer: 'text', value: 'Example record' },
        { field: 'public_url', renderer: 'link', value: 'example.test' },
        { field: 'contact_address', renderer: 'email', value: 'operator@example.test' },
        { field: 'contact_number', renderer: 'phone', value: '+1 555 0100' },
      ],
    },
    {
      kind: 'list',
      title: 'Signals',
      renderer: 'text',
      items: ['One', 'Two'],
    },
    {
      kind: 'table',
      title: 'Participants',
      columns: [
        { field: 'full_name', renderer: 'text' },
        { field: 'role', renderer: 'text' },
        { field: 'address', renderer: 'email' },
      ],
      rows: [['Avery', 'Owner', 'avery@example.test']],
    },
  ]);
  assert.equal(JSON.stringify(sections).includes('noisy_internal_payload'), false);
  assert.equal(reviewDetailHref({ renderer: 'link', value: 'example.test' }), 'https://example.test');
  assert.equal(reviewDetailHref({ renderer: 'email', value: 'operator@example.test' }), 'mailto:operator@example.test');
  assert.equal(reviewDetailHref({ renderer: 'phone', value: '+1 555 0100' }), 'tel:+1 555 0100');
});

test('list detail plucks one configured property from each JSON array element', () => {
  const sections = resolveReviewDetail({
    detail: [{
      title: 'Signals',
      from: 'signals',
      as: 'list',
      item: { text: 'evidence.summary' },
    }],
    record: {
      signals: JSON.stringify([
        { evidence: { summary: 'First signal' } },
        { evidence: { summary: 'Second signal' } },
        { evidence: {} },
      ]),
    },
  });

  assert.deepEqual(sections, [{
    kind: 'list',
    title: 'Signals',
    renderer: 'text',
    items: ['First signal', 'Second signal'],
  }]);
});

test('table detail preserves partial entities and marks missing cells for display', () => {
  const sections = resolveReviewDetail({
    detail: [{
      title: 'Participants',
      from: 'participants',
      as: 'table',
      columns: ['name', 'role', { field: 'email', as: 'email' }],
    }],
    record: {
      participants: JSON.stringify([
        { name: 'Avery', role: 'Owner', email: 'avery@example.test' },
        { name: 'Blair', email: 'blair@example.test' },
        { ignored: true },
      ]),
    },
  });

  assert.deepEqual(sections, [{
    kind: 'table',
    title: 'Participants',
    columns: [
      { field: 'name', renderer: 'text' },
      { field: 'role', renderer: 'text' },
      { field: 'email', renderer: 'email' },
    ],
    rows: [
      ['Avery', 'Owner', 'avery@example.test'],
      ['Blair', null, 'blair@example.test'],
    ],
  }]);
});

test('malformed, absent, and non-array JSON omit the affected declared section', () => {
  const detail = [{
    title: 'Signals',
    from: 'signals',
    as: 'list',
    item: { text: 'summary' },
  }];

  assert.deepEqual(resolveReviewDetail({ detail, record: { signals: '{not json' } }), []);
  assert.deepEqual(resolveReviewDetail({ detail, record: { signals: '{"summary":"not an array"}' } }), []);
  assert.deepEqual(resolveReviewDetail({ detail, record: {} }), []);
});

test('declared maps support separate fields and combined coordinate values, while invalid maps stay hidden', () => {
  const separateFields = [{
    title: 'Location',
    as: 'map',
    latitude_field: 'source_latitude',
    longitude_field: 'source_longitude',
  }];
  const combinedField = [{
    title: 'Location',
    as: 'map',
    coordinates_field: 'source_coordinates',
  }];

  assert.deepEqual(resolveReviewDetail({
    detail: separateFields,
    record: { source_latitude: '43.615', source_longitude: '-116.2023' },
  }), [{ kind: 'map', title: 'Location', coordinates: { lat: 43.615, lng: -116.2023 } }]);
  assert.deepEqual(resolveReviewDetail({
    detail: combinedField,
    record: { source_coordinates: '[43.615, -116.2023]' },
  }), [{ kind: 'map', title: 'Location', coordinates: { lat: 43.615, lng: -116.2023 } }]);
  assert.deepEqual(resolveReviewDetail({
    detail: combinedField,
    record: { source_coordinates: '{"latitude":43.615,"longitude":-116.2023}' },
  }), [{ kind: 'map', title: 'Location', coordinates: { lat: 43.615, lng: -116.2023 } }]);

  assert.equal(canRenderReviewDetailMap({ mapsApiKey: '', coordinates: { lat: 43.615, lng: -116.2023 } }), false);
  assert.deepEqual(resolveReviewDetail({ detail: separateFields, record: {} }), []);
  assert.deepEqual(resolveReviewDetail({ detail: combinedField, record: { source_coordinates: 'not coordinates' } }), []);
  assert.deepEqual(resolveReviewDetail({ detail: combinedField, record: { source_coordinates: '91, -116.2023' } }), []);
});

test('declared website embeds resolve safe URLs and disclose their external-preview safeguards', () => {
  const detail = [{ title: 'Website', as: 'embed', from: 'prospect_site' }];
  const sections = resolveReviewDetail({ detail, record: { prospect_site: 'example.test/about' } });

  assert.deepEqual(sections, [{ kind: 'embed', title: 'Website', url: 'https://example.test/about' }]);
  assert.deepEqual(resolveReviewDetail({ detail, record: {} }), []);
  assert.deepEqual(resolveReviewDetail({ detail, record: { prospect_site: 'javascript:alert(1)' } }), []);

  const reviewRoute = readFileSync(new URL('../src/viz/ui/src/ReviewRoute.tsx', import.meta.url), 'utf8');
  assert.match(reviewRoute, /loading="lazy"/);
  assert.match(reviewRoute, /sandbox=""/);
  assert.match(reviewRoute, /referrerPolicy="no-referrer"/);
  assert.match(reviewRoute, /rel="noopener noreferrer"/);
  assert.match(reviewRoute, /Preview may be blocked by the site/);
});

test('declared fields can retain empty values when explicitly requested', () => {
  const detail = [{
    title: 'Website signal',
    items: [
      { field: 'prospect_site', label: 'Website', show_when_empty: true },
      { field: 'secondary_site', label: 'Secondary website' },
    ],
  }];

  assert.deepEqual(resolveReviewDetail({ detail, record: { prospect_site: '  ', secondary_site: '' } }), [{
    kind: 'fields',
    title: 'Website signal',
    items: [{ field: 'prospect_site', label: 'Website', renderer: 'text', value: '—' }],
  }]);
  assert.deepEqual(resolveReviewDetail({
    detail: [{ title: 'No signals', items: ['prospect_site', 'secondary_site'] }],
    record: { prospect_site: '', secondary_site: null },
  }), []);
});

test('review detail validates its closed renderer vocabulary and warns when absent', () => {
  const unknownRenderer = normalizeConfig({
    pipeline: [{
      kind: 'review',
      id: 'review_unknown_renderer',
      detail: [{ title: 'Overview', items: [{ field: 'display_name', as: 'badge' }] }],
    }],
  });
  assert.ok(unknownRenderer.errors.length > 0);
  assert.match(unknownRenderer.error, /badge/);

  const declaredMedia = normalizeConfig({
    pipeline: [{
      kind: 'review',
      id: 'review_media',
      detail: [
        { title: 'Location', as: 'map', latitude_field: 'source_latitude', longitude_field: 'source_longitude' },
        { title: 'Website', as: 'embed', from: 'prospect_site' },
        { title: 'Signals', items: [{ field: 'prospect_site', show_when_empty: true }] },
      ],
    }],
  });
  assert.deepEqual(declaredMedia.errors, []);
  assert.deepEqual(declaredMedia.config.pipeline[0].detail[0], {
    title: 'Location',
    as: 'map',
    latitude_field: 'source_latitude',
    longitude_field: 'source_longitude',
  });
  assert.deepEqual(declaredMedia.config.pipeline[0].detail[1], {
    title: 'Website',
    as: 'embed',
    from: 'prospect_site',
  });
  assert.equal(declaredMedia.config.pipeline[0].detail[2].items[0].show_when_empty, true);

  const noDetail = normalizeConfig({
    pipeline: [{ kind: 'review', id: 'review_without_detail' }],
  });
  assert.deepEqual(noDetail.errors, []);
  assert.ok(noDetail.warnings.includes('Review step "review_without_detail" should declare detail for the review panel.'));
  assert.equal(resolveReviewDetail({ detail: undefined, record: { display_name: 'Fallback record' } }), null);
});

test('metadata returns each review stage detail declaration', () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-review-detail-meta-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
pipeline:
  - kind: review
    id: review_detail
    label: Detail review
    fields: [display_name]
    detail:
      - title: Overview
        items:
          - field: display_name
`);
  const db = openListDb({ listDir, readonly: false });
  try {
    ensureRecordColumns({ db, columns: ['display_name'] });
  } finally {
    db.close();
  }

  const meta = buildMeta(listDir);
  assert.deepEqual(meta.review_stages[0].detail, [{
    title: 'Overview',
    items: [{ field: 'display_name', as: 'text' }],
  }]);
});
