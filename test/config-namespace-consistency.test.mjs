import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runEnrichment } from '../dist/orchestrator/enrichment/runner.js';
import { runGeneration } from '../dist/orchestrator/generate/runner.js';
import { runPipelineDataflow } from '../dist/orchestrator/pipeline/dataflow.js';
import { ensureRecordColumns, openListDb, upsertContact, upsertRecord } from '../dist/orchestrator/runtime/db.js';
import { getSequenceBoard } from '../dist/orchestrator/pipeline/sequences-board.js';
import { normalizeConfig } from '../dist/schemas/config.js';

const nestedConfig = `
list:
  name: nested-command-visibility
ai:
  default_model: test/model
pipeline:
  - kind: assign
    id: route_nested
    inputs: [sequence_status]
    target: pipeline_name
    fallback: nested
  - kind: pipeline
    id: nested
    manual: true
    steps:
      - kind: enrich
        id: lookup
        inputs: [business_name]
        outputs:
          lookup_result: { type: string, description: Lookup result }
      - kind: generate
        id: draft
        inputs: [business_name]
        outputs:
          draft_result: { type: string, description: Draft result }
sequences:
  default:
    steps: []
`;

const modelRoot = mkdtempSync(join(tmpdir(), 'ao-config-namespace-models-'));
writeFileSync(join(modelRoot, 'models.json'), JSON.stringify({
  schema_version: '1.0.0',
  providers: {
    test: { provider: 'test', models: ['model'], updated_at: '' },
  },
}));
process.env.AO_GLOBAL_ROOT = modelRoot;

const createList = (yaml = nestedConfig) => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-config-namespace-'));
  writeFileSync(join(listDir, 'outbound.yaml'), yaml);
  writeFileSync(join(listDir, 'operator.md'), 'test');
  return listDir;
};

test('nested enrich and generate steps validate and are visible to their direct runners', async () => {
  const listDir = createList();
  const db = openListDb({ listDir, readonly: false });
  db.close();

  const enrich = await runEnrichment({ listDir });
  const generate = await runGeneration({ listDir });

  assert.equal(enrich.steps, 1);
  assert.equal(generate.steps, 1);
});

test('pipeline execution parks nested-pipeline records without a reachable contact and re-enters them', async () => {
  const listDir = createList(`
list:
  name: nested-reachability
ai:
  default_model: test/model
pipeline:
  - kind: assign
    id: route_nested
    inputs: [sequence_status]
    target: pipeline_name
    fallback: nested
  - kind: pipeline
    id: nested
    manual: true
    steps:
      - kind: wait
        id: wait_one_day
        after: 1d
sequences:
  default:
    steps: []
`);
  const db = openListDb({ listDir, readonly: false });
  const now = new Date().toISOString();
  ensureRecordColumns({
    db,
    columns: ['pipeline_name', 'account_sequence_state', 'readiness_json'],
  });
  upsertRecord({
    db,
    row: {
      _row_id: 'nested_unreachable',
      business_name: 'Nested Unreachable',
      pipeline_name: 'nested',
      sequence_name: 'nested',
      sequence_status: 'active',
      account_sequence_state: 'active',
      readiness_json: JSON.stringify({ permitted_channels: ['email'] }),
      created_at: now,
      updated_at: now,
    },
  });
  db.close();

  await runPipelineDataflow({ listDir, clock: now });
  const parkedDb = openListDb({ listDir, readonly: false });
  const parked = parkedDb.prepare('SELECT * FROM records WHERE _row_id = ?').get('nested_unreachable');
  assert.equal(parked.account_sequence_state, 'unreachable');
  assert.equal(parked.sequence_status, 'unreachable');
  upsertContact({
    db: parkedDb,
    contact: {
      row_id: 'nested_unreachable',
      contact_id: 'reachable_contact',
      name: 'Reachable Contact',
      email: 'reachable@example.test',
    },
  });
  parkedDb.close();

  await runPipelineDataflow({ listDir, clock: now });
  const reenteredDb = openListDb({ listDir, readonly: true });
  const reentered = reenteredDb.prepare('SELECT * FROM records WHERE _row_id = ?').get('nested_unreachable');
  assert.equal(reentered.account_sequence_state, 'active');
  assert.equal(reentered.sequence_status, 'active');
  reenteredDb.close();
});

test('traditional sequencers explain why their pipeline board has no buckets', () => {
  const listDir = createList(`
list:
  name: sequencer-board
pipeline: []
sequences:
  default:
    steps:
      - kind: send_email
        id: email_1
        day: 0
`);
  const db = openListDb({ listDir, readonly: false });
  try {
    const board = getSequenceBoard({
      db,
      config: normalizeConfig({
        pipeline: [],
        sequences: { default: { steps: [{ kind: 'send_email', id: 'email_1', day: 0 }] } },
      }).config,
      sequence: 'default',
    });
    assert.deepEqual(board.buckets, []);
    assert.match(String(board.empty_reason), /traditional sequencer/i);
  } finally {
    db.close();
  }
});

test('enrichment idempotency is rejected instead of silently ignored', () => {
  const result = normalizeConfig({
    pipeline: [{
      kind: 'enrich',
      id: 'lookup',
      idempotency: { key_source: ['_row_id'], scope: 'list' },
      outputs: { lookup_result: { type: 'string', description: 'Lookup result' } },
    }],
  });

  assert.ok(result.errors.some((error) => /idempotency/i.test(error)));
});

test('unsupported traditional-sequencer step config is rejected instead of silently ignored', () => {
  const result = normalizeConfig({
    sequences: {
      default: {
        steps: [{
          id: 'manual_step',
          config: {
            disposition_options: ['continue'],
            model: 'test/model',
            step_budget: 4,
            concurrency: 2,
            cache: '1h',
          },
        }],
      },
    },
  });

  for (const name of ['disposition_options', 'model', 'step_budget', 'concurrency', 'cache']) {
    assert.ok(result.errors.some((error) => error.includes(`config.${name} is not supported`)));
  }
});

test('external pipeline steps reject model-only configuration instead of silently ignoring it', () => {
  const result = normalizeConfig({
    pipeline: [{
      kind: 'send_email',
      id: 'send',
      side_effecting: true,
      config: { model: 'test/model', concurrency: 2 },
    }],
  });

  assert.ok(result.errors.some((error) => /unrecognized key/i.test(error)));
});

test('unsupported scoring-criterion options are rejected instead of silently ignored', () => {
  const result = normalizeConfig({
    score: {
      criteria: [{
        id: 'criterion',
        description: 'Criterion',
        condition: 'record qualifies',
        anchor_column: 'updated_at',
        decay: { window_days: 30, floor: 0.5, mode: 'linear' },
        config: { model: 'test/model' },
      }],
    },
  });

  for (const name of ['condition', 'anchor_column', 'decay']) {
    assert.ok(result.errors.some((error) => error.includes(`score criterion ${name} is not supported`)));
  }
  assert.ok(result.errors.some((error) => /unrecognized key/i.test(error)));
});

test('source-search pagination is rejected instead of silently ignored', () => {
  const result = normalizeConfig({
    source: {
      searches: [{
        id: 'search',
        pagination: { cursor: 'old-page' },
      }],
    },
  });

  assert.ok(result.errors.some((error) => /pagination is runtime-managed/i.test(error)));
});
