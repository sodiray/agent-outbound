import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { processAndInsertRows, runSourcing } from '../dist/orchestrator/sourcing/runner.js';
import { ensureRecordColumns, openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { buildDedupPayload, confirmDuplicate, createDedupRunState, upsertRecordEmbedding } from '../dist/orchestrator/sourcing/dedup.js';
import { normalizeConfig } from '../dist/schemas/config.js';
import { embed } from '../dist/orchestrator/runtime/embeddings.js';

const vector = Float32Array.from([1, 0]);

const addCandidates = (db, count) => {
  for (const index of Array.from({ length: count }, (_, value) => value)) {
    const rowId = `existing-${index}`;
    upsertRecord({ db, row: { _row_id: rowId, id: rowId, business_name: `Existing ${index}` } });
    upsertRecordEmbedding({ db, rowId, embedding: vector, identityHash: rowId });
  }
};

const withFakeJev = async (handler, callback) => {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    await handler({ request: JSON.parse(Buffer.concat(chunks).toString('utf8')), response });
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const address = server.address();
  const priorUrl = process.env.JEV_BASE_URL;
  const priorKey = process.env.TEST_JEV_KEY;
  process.env.JEV_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.TEST_JEV_KEY = 'fake-key';
  try {
    return await callback();
  } finally {
    if (priorUrl === undefined) delete process.env.JEV_BASE_URL; else process.env.JEV_BASE_URL = priorUrl;
    if (priorKey === undefined) delete process.env.TEST_JEV_KEY; else process.env.TEST_JEV_KEY = priorKey;
    await new Promise((resolve) => server.close(resolve));
  }
};

test('AI dedup caps confirmation calls and records non-matches', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'agent-outbound-ai-dedup-'));
  const db = openListDb({ listDir, readonly: false });
  try {
    addCandidates(db, 10);
    const runState = createDedupRunState({ maxCalls: 3 });
    const confirm = async () => ({
      same: false,
      confidence: 0,
      reasoning: 'not a match',
      usage: { input_tokens: 2, output_tokens: 1, usd_cost: 0.01 },
      model: 'counting-fixture',
      provider: 'fixture',
    });
    const result = await processAndInsertRows({
      db,
      rows: [
        { _row_id: 'incoming-1', business_name: 'Incoming one' },
        { _row_id: 'incoming-2', business_name: 'Incoming two' },
      ],
      identityFields: ['business_name'],
      listName: 'dedup fixture',
      listDir,
      aiConfig: {},
      dedupConfig: { aiDedup: 'on', fields: ['business_name'], maxCandidates: 2 },
      dedupRunState: runState,
      confirmDedup: confirm,
      embedDedupIdentity: async () => vector,
    });

    assert.equal(runState.calls, 3);
    assert.equal(result.errors.length, 0);
    const costs = db.prepare("SELECT * FROM cost_events WHERE step_id = 'sourcing:dedup'").all();
    assert.equal(costs.length, 3);
    assert.equal(db.prepare("SELECT duplicate_status FROM records WHERE _row_id = 'incoming-2'").get().duplicate_status, 'needs_review');
  } finally {
    db.close();
    rmSync(listDir, { recursive: true, force: true });
  }
});

test('source uses exact opaque dedup keys without AI dedup by default', async () => {
  const listDir = mkdtempSync(join(tmpdir(), 'agent-outbound-exact-dedup-'));
  const ids = Array.from({ length: 200 }, (_, index) => index.toString(16).padStart(24, '0'));
  writeFileSync(join(listDir, 'outbound.yaml'), JSON.stringify({
    list: { name: 'exact dedup fixture' },
    ai: { defaults: { research: 'anthropic/claude-haiku-4-5-20251001', evaluation: 'anthropic/claude-haiku-4-5-20251001' } },
    source: {
      identity: ['apollo_person_id'],
      dedup_key: 'apollo_person_id',
      searches: [{ id: 'fixture', manual_results: ids.map((apollo_person_id) => ({ apollo_person_id })) }],
    },
  }));
  const db = openListDb({ listDir, readonly: false });
  try {
    ensureRecordColumns({ db, columns: [{ name: 'apollo_person_id', type: 'TEXT' }] });
    for (const apollo_person_id of ids) {
      upsertRecord({ db, row: { _row_id: `existing-${apollo_person_id}`, id: `existing-${apollo_person_id}`, apollo_person_id } });
    }
  } finally {
    db.close();
  }
  try {
    const result = await runSourcing({ listDir });
    assert.equal(result.dedup_ai_calls, 0);
    assert.equal(result.inserted_total, 0);
    assert.equal(result.deduped_total, 200);
  } finally {
    rmSync(listDir, { recursive: true, force: true });
  }
});

test('AI dedup uses Jev with compact state and records every decision cost', async () => {
  const requests = [];
  const answers = [0.9, 0.5, 0.1];
  await withFakeJev(async ({ request, response }) => {
    requests.push(request);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      answers: { same_entity: { type: 'noul', noul: answers.shift() } },
      usage: { input_tokens: 3, output_tokens: 1, usd_cost: 0.01 },
    }));
  }, async () => {
    const listDir = mkdtempSync(join(tmpdir(), 'agent-outbound-ai-dedup-jev-'));
    const db = openListDb({ listDir, readonly: false });
    try {
      addCandidates(db, 1);
      const config = { decide: { model: 'jev-1.13.0', api_key_env: 'TEST_JEV_KEY' } };
      const results = [];
      for (const index of [0, 1, 2]) {
        results.push(await processAndInsertRows({
          db,
          rows: [{
            _row_id: `incoming-${index}`,
            name: 'Avery Example',
            company: 'Example Co',
            title: 'Owner',
            scraped_site_text: 'x'.repeat(20_000),
          }],
          identityFields: ['name', 'company'],
          listName: 'dedup fixture',
          listDir,
          aiConfig: config,
          dedupConfig: { aiDedup: 'on', fields: ['name', 'company', 'title'], maxCandidates: 1 },
          dedupRunState: createDedupRunState({ maxCalls: 3 }),
          embedDedupIdentity: async () => vector,
        }));
      }
      assert.equal(results[0].deduped, 1);
      assert.equal(db.prepare("SELECT duplicate_status FROM records WHERE _row_id = 'incoming-0'").get().duplicate_status, 'confirmed');
      assert.equal(db.prepare("SELECT duplicate_status FROM records WHERE _row_id = 'incoming-1'").get().duplicate_status, 'needs_review');
      assert.equal(db.prepare("SELECT duplicate_of FROM records WHERE _row_id = 'incoming-2'").get().duplicate_of, '');
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM cost_events WHERE step_id = 'sourcing:dedup' AND provider = 'jev'").get().count, 3);
    } finally {
      db.close();
      rmSync(listDir, { recursive: true, force: true });
    }
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[0].questions.same_entity.instructions, 'Do records A and B refer to the same real-world entity (the same person or the same business)?');
  assert.equal(requests[0].state.record_a, 'name: Avery Example\ncompany: Example Co\ntitle: Owner');
  assert.equal(JSON.stringify(requests[0]).includes('scraped_site_text'), false);
});

test('AI dedup fallback asks the generic question with compact state', async () => {
  const calls = [];
  const result = await confirmDuplicate({
    incoming: { name: 'Avery Example', company: 'Example Co', scraped_site_text: 'x'.repeat(20_000) },
    candidate: { name: 'Avery Example', company: 'Example Co', scraped_site_text: 'y'.repeat(20_000) },
    identityFields: ['name', 'company'],
    fields: ['name', 'company'],
    aiConfig: {},
    generateObject: async (request) => {
      calls.push(request);
      return { object: { same: false, confidence: 0.9, reasoning: 'different' }, usage: {}, model: 'fixture', provider: 'fixture' };
    },
  });
  assert.equal(result.same, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /same real-world entity \(the same person or the same business\)/);
  assert.equal(calls[0].prompt.includes('scraped_site_text'), false);
});

test('sourcing run sends a near-identical pair to Jev instead of the LLM fallback', async () => {
  const requests = [];
  await withFakeJev(async ({ request, response }) => {
    requests.push(request);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      answers: { same_entity: { type: 'noul', noul: 0.9 } },
      usage: { input_tokens: 3, output_tokens: 1 },
    }));
  }, async () => {
    const listDir = mkdtempSync(join(tmpdir(), 'agent-outbound-ai-dedup-sourcing-'));
    writeFileSync(join(listDir, 'outbound.yaml'), `
ai:
  defaults: { research: openai/gpt-4o-mini }
  decide: { model: jev-1.13.0, api_key_env: TEST_JEV_KEY }
source:
  identity: [name, company]
  ai_dedup: on
  ai_dedup_fields: [name, company]
  searches:
    - id: fixture
      manual_results:
        - { name: Avery Example, company: Example Co, scraped_site_text: large-record }
`);
    try {
      const db = openListDb({ listDir, readonly: false });
      try {
        upsertRecord({ db, row: { _row_id: 'existing', id: 'existing', name: 'Avery Example', company: 'Example Co' } });
        upsertRecordEmbedding({ db, rowId: 'existing', embedding: await embed('Avery Example, Example Co'), identityHash: 'fixture' });
      } finally {
        db.close();
      }
      const result = await runSourcing({ listDir });
      assert.equal(result.dedup_ai_calls, 1);
    } finally {
      rmSync(listDir, { recursive: true, force: true });
    }
  });
  assert.equal(requests.length, 1);
  assert.equal(JSON.stringify(requests[0]).includes('scraped_site_text'), false);
});

test('AI dedup payload uses only the configured labels, dotted JSON paths, truncation, and non-empty values', () => {
  const fields = [
    { field: 'first_name', label: 'First name' },
    { field: 'company', label: 'Firm' },
    { field: 'extra_json.headline', label: 'Headline' },
    'missing',
  ];
  assert.equal(buildDedupPayload({
    row: {
      first_name: 'Avery',
      company: 'Example Co',
      extra_json: JSON.stringify({ headline: 'Independent consulting founder' }),
    },
    fields,
    maxCharsPerField: 11,
  }), 'First name: Avery\nFirm: Example Co\nHeadline: Independent');
});

test('AI dedup on requires an explicit payload specification', () => {
  const invalid = normalizeConfig({ source: { ai_dedup: 'on' } });
  assert.ok(invalid.errors.some((error) => error.includes('source.ai_dedup_fields must declare the exact payload fields')));

  const valid = normalizeConfig({ source: { ai_dedup: 'on', ai_dedup_fields: ['name'] } });
  assert.deepEqual(valid.errors, []);
});
