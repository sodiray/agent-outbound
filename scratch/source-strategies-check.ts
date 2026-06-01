import { strict as assert } from 'node:assert';
import { expandSourceStrategies, dedupRowsByKey } from '../src/orchestrator/sourcing/runner.js';

const listDir = process.cwd();

const keywordGeoTasks = expandSourceStrategies({
  listDir,
  strategies: [{
    kind: 'keyword_geo',
    tool: { server: 'maps', tools: ['MAPS_TEXT_SEARCH'] },
    keywords: ['ice cream shop', 'soda fountain'],
    geos: ['Los Angeles CA', 'Santa Monica CA', 'Pasadena CA'],
    max_results: 2,
    output_map: { business_name: 'name' },
  }],
});

assert.equal(keywordGeoTasks.length, 6);

const geoTileTasks = expandSourceStrategies({
  listDir,
  strategies: [{
    kind: 'geo_tiles',
    tool: { server: 'maps', tools: ['MAPS_NEARBY_SEARCH'] },
    tiles: [
      { lat: 43.6150, lng: -116.2023, radius_m: 300 },
      { lat: 43.6007, lng: -116.1996, radius_m: 300 },
      { lat: 43.6629, lng: -116.2890, radius_m: 300 },
    ],
    max_results: 1,
    output_map: { business_name: 'name' },
  }],
});

assert.equal(geoTileTasks.length, 3);

const deduped = dedupRowsByKey({
  dedupKey: 'place_id',
  rows: [
    { placeId: 'abc', name: 'First' },
    { placeId: 'abc', name: 'Duplicate' },
    { placeId: 'def', name: 'Second' },
  ],
});

assert.equal(deduped.unique.length, 2);
assert.equal(deduped.duplicates, 1);

console.log(JSON.stringify({
  keyword_geo_tasks: keywordGeoTasks.length,
  geo_tile_tasks: geoTileTasks.length,
  dedup_unique: deduped.unique.length,
  dedup_duplicates: deduped.duplicates,
}, null, 2));
