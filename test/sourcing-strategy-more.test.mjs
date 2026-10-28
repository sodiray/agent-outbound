import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sourceCommand, sourceMoreCommand } from '../dist/commands/index.js';
import { runSourcing } from '../dist/orchestrator/sourcing/runner.js';
import { openListDb } from '../dist/orchestrator/runtime/db.js';

const createList = ({ resultRows, source = {} }) => {
  const listDir = mkdtempSync(join(tmpdir(), 'agent-outbound-sourcing-more-'));
  const resultScript = `process.stdout.write(JSON.stringify({ results: ${JSON.stringify(resultRows)} }))`;
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      fixture: {
        type: 'command',
        command: process.execPath,
        args: ['-e', resultScript],
        tools: [{
          slug: 'FIXTURE_SEARCH',
          invoke: { argv: [], result: 'stdout_json' },
        }],
      },
    },
  }));
  writeFileSync(join(listDir, 'outbound.yaml'), JSON.stringify({
    list: { name: 'Sourcing strategy fixture' },
    ai: {
      defaults: {
        evaluation: 'anthropic/claude-haiku-4-5-20251001',
      },
    },
    source,
  }));
  return listDir;
};

const keywordGeoStrategy = () => ({
  strategies: [{
    id: 'fixture_keyword_geo',
    kind: 'keyword_geo',
    keywords: ['dentist'],
    geos: ['Boise, ID'],
    max_results: 1,
    max_pages: 1,
    tool: { server: 'fixture', tools: ['FIXTURE_SEARCH'] },
  }],
});

const geoTileStrategy = () => ({
  strategies: [{
    id: 'fixture_geo_tiles',
    kind: 'geo_tiles',
    tiles: [{ lat: 43.615, lng: -116.202, radius_m: 100 }],
    max_results: 1,
    tool: { server: 'fixture', tools: ['FIXTURE_SEARCH'] },
  }],
});

test('source --more runs declared strategy tasks', async () => {
  const listDir = createList({
    resultRows: [{ placeId: 'fixture-place-1', displayName: { text: 'Fixture Dental' } }],
    source: keywordGeoStrategy(),
  });
  try {
    const result = await sourceMoreCommand({ list: listDir, more: 1 });

    assert.equal(result.status, 'ok');
    assert.equal(result.searches_run, 0);
    assert.equal(result.search_tasks_run, 1);
    assert.equal(result.search_calls_made, 1);
    assert.equal(result.inserted_total, 1);
    assert.equal(result.zero_search_reason, undefined);
  } finally {
    rmSync(listDir, { recursive: true, force: true });
  }
});

test('source searches insert rows returned directly by a tool through output_map', async () => {
  const listDir = createList({
    resultRows: [],
    source: {
      searches: [{
        id: 'direct_tool_rows',
        query: 'ignored by fixture',
        model: 'anthropic/claude-haiku-4-5-20251001',
        tool: { server: 'fixture', tools: ['FIXTURE_SEARCH'] },
        output_map: { external_id: 'place_id', display_label: 'business_name' },
      }],
    },
  });
  try {
    const result = await runSourcing({
      listDir,
      executeAction: async () => ({
        artifacts: {},
        outputs: {},
        tool_results: [[
          { external_id: 'direct-1', display_label: 'Direct One' },
          { external_id: 'direct-2', display_label: 'Direct Two' },
        ]],
        usage: { tool_calls: [{ tool: 'FIXTURE_SEARCH' }] },
        model: 'fixture',
        provider: 'fixture',
      }),
    });
    const db = openListDb({ listDir, readonly: true });
    try {
      const inserted = db.prepare('SELECT place_id, business_name FROM records ORDER BY place_id').all();
      assert.equal(result.inserted_total, 2);
      assert.deepEqual(inserted, [
        { place_id: 'direct-1', business_name: 'Direct One' },
        { place_id: 'direct-2', business_name: 'Direct Two' },
      ]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(listDir, { recursive: true, force: true });
  }
});

test('source --more reports when no source work is declared', async () => {
  const listDir = createList({ resultRows: [], source: {} });
  try {
    const result = await sourceMoreCommand({ list: listDir, more: 1 });

    assert.equal(result.status, 'ok');
    assert.equal(result.searches_run, 0);
    assert.deepEqual(result.zero_search_reason, {
      code: 'no_source_work_declared',
      message: 'No source.searches or source.strategies are declared.',
    });
  } finally {
    rmSync(listDir, { recursive: true, force: true });
  }
});

test('source --more reports a strategy call budget that prevents execution', async () => {
  const listDir = createList({
    resultRows: [{ placeId: 'fixture-place-2', displayName: { text: 'Budgeted Dental' } }],
    source: {
      ...keywordGeoStrategy(),
      budget: { max_calls: 0 },
    },
  });
  try {
    const result = await sourceMoreCommand({ list: listDir, more: 1 });

    assert.equal(result.status, 'ok');
    assert.equal(result.searches_run, 0);
    assert.equal(result.search_tasks_run, 0);
    assert.equal(result.search_calls_made, 0);
    assert.deepEqual(result.zero_search_reason, {
      code: 'search_call_budget_reached',
      message: 'The source search-call budget was reached before a strategy task could run.',
    });
  } finally {
    rmSync(listDir, { recursive: true, force: true });
  }
});

test('source distinguishes exhausted strategy tiles from no declared work', async () => {
  const listDir = createList({ resultRows: [], source: geoTileStrategy() });
  try {
    const initial = await sourceCommand({ list: listDir });
    const resumed = await sourceMoreCommand({ list: listDir, more: 1 });

    assert.equal(initial.search_tasks_run, 1);
    assert.equal(resumed.status, 'ok');
    assert.equal(resumed.searches_run, 0);
    assert.deepEqual(resumed.zero_search_reason, {
      code: 'all_strategy_tasks_exhausted',
      message: 'All declared source strategy tasks are already complete, capped, or exhausted.',
    });
  } finally {
    rmSync(listDir, { recursive: true, force: true });
  }
});
