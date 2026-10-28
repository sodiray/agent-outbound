import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sourceCommand } from '../dist/commands/index.js';
import { queryCommand } from '../dist/commands/data-access.js';
import { openListDb } from '../dist/orchestrator/runtime/db.js';

const createFixture = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'agent-outbound-keyword-matrix-'));
  const toolScript = join(listDir, 'search-stub.mjs');
  const callsPath = join(listDir, 'calls.log');
  writeFileSync(toolScript, `
    import { appendFileSync } from 'node:fs';
    const query = process.argv[2] || '';
    appendFileSync(${JSON.stringify(callsPath)}, query + '\\n');
    process.stdout.write(JSON.stringify({ results: [{
      placeId: query.replaceAll(' ', '_'), source_query: query,
      group: 'prospect', order: 'first', select: 'included',
    }] }));
  `);
  writeFileSync(join(listDir, 'matrix-keywords.json'), JSON.stringify(['a', 'b']));
  writeFileSync(join(listDir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      fixture: {
        type: 'command', command: process.execPath,
        tools: [{
          slug: 'FIXTURE_SEARCH',
          invoke: { argv: [toolScript, '{{query}}'], result: 'stdout_json' },
        }],
      },
    },
  }));
  writeFileSync(join(listDir, 'outbound.yaml'), JSON.stringify({
    list: { name: 'Keyword matrix fixture' },
    ai: { defaults: { evaluation: 'anthropic/claude-haiku-4-5-20251001' } },
    source: {
      identity: ['place_id'],
      strategies: [{
        id: 'matrix', kind: 'keyword_geo', keywords_from: 'matrix-keywords.json', geos: ['US'],
        max_results: 2, max_pages: 1,
        tool: { server: 'fixture', tools: ['FIXTURE_SEARCH'] },
        output_map: {
          place_id: 'placeId', source_query: 'source_query', group: 'group', order: 'order', select: 'select',
        },
      }],
      budget: { max_calls: 10 },
    },
    pipeline: [{
      kind: 'filter', id: 'has_group', type: 'field_check', match: 'all', on_fail: 'drop',
      conditions: [{ field: 'group', operator: 'eq', value: 'prospect' }], inputs: ['group'],
    }, {
      kind: 'review', id: 'check_reserved_fields', fields: ['group', 'order', 'select'], inputs: ['group', 'order', 'select'],
    }],
  }));
  return { callsPath, listDir };
};

const calls = (path) => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);

test('keyword_geo expands changed keywords_from and honors the call budget', async () => {
  const { callsPath, listDir } = createFixture();
  try {
    const initial = await sourceCommand({ list: listDir });
    assert.equal(initial.search_tasks_created, 2);
    assert.equal(initial.search_tasks_pending, 0);
    assert.deepEqual(calls(callsPath).sort(), ['a US', 'b US']);

    writeFileSync(join(listDir, 'matrix-keywords.json'), JSON.stringify(['a', 'b', 'c', 'd']));
    const config = JSON.parse(readFileSync(join(listDir, 'outbound.yaml'), 'utf8'));
    config.source.budget.max_calls = 1;
    writeFileSync(join(listDir, 'outbound.yaml'), JSON.stringify(config));

    const expanded = await sourceCommand({ list: listDir });
    assert.equal(expanded.search_tasks_created, 2);
    assert.equal(expanded.search_tasks_pending, 1);
    assert.deepEqual(calls(callsPath).slice(0, 2).sort(), ['a US', 'b US']);
    assert.ok(['c US', 'd US'].includes(calls(callsPath)[2]));

    const completed = await sourceCommand({ list: listDir });
    assert.equal(completed.search_tasks_created, 0);
    assert.equal(completed.search_tasks_pending, 0);
    assert.deepEqual(calls(callsPath).slice(2).sort(), ['c US', 'd US']);

    const dbAfter = openListDb({ listDir, readonly: true });
    try {
      const rows = dbAfter.prepare('SELECT source_query, "group", "order", "select" FROM records ORDER BY source_query').all();
      assert.deepEqual(rows.map((row) => row.source_query), ['a US', 'b US', 'c US', 'd US']);
      assert.ok(rows.every((row) => row.group === 'prospect' && row.order === 'first' && row.select === 'included'));
    } finally {
      dbAfter.close();
    }
    const queried = queryCommand({ list: listDir, sql: 'SELECT "group", "order", "select" FROM records WHERE "group" = \'prospect\' ORDER BY source_query' });
    assert.equal(queried.row_count, 4);
  } finally {
    rmSync(listDir, { recursive: true, force: true });
  }
});

test('keyword_geo runs newly expanded tasks before rearmed retries', async () => {
  const { callsPath, listDir } = createFixture();
  try {
    await sourceCommand({ list: listDir });
    const db = openListDb({ listDir, readonly: false });
    try {
      db.prepare("UPDATE search_tasks SET status = 'error', attempt_count = 1, last_run_at = '2026-01-01T00:00:00.000Z'").run();
    } finally {
      db.close();
    }
    writeFileSync(join(listDir, 'matrix-keywords.json'), JSON.stringify(['a', 'b', 'c', 'd']));
    const config = JSON.parse(readFileSync(join(listDir, 'outbound.yaml'), 'utf8'));
    config.source.budget.max_calls = 2;
    writeFileSync(join(listDir, 'outbound.yaml'), JSON.stringify(config));

    const result = await sourceCommand({ list: listDir });
    assert.equal(result.search_tasks_created, 2);
    assert.equal(result.search_tasks_pending, 2);
    assert.deepEqual(calls(callsPath).slice(2).sort(), ['c US', 'd US']);
  } finally {
    rmSync(listDir, { recursive: true, force: true });
  }
});
