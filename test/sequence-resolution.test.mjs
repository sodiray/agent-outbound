import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { sequenceRunCommand } from '../dist/commands/index.js';
import { sequencesListCommand } from '../dist/commands/sequences-board.js';
import { openListDb, upsertRecord } from '../dist/orchestrator/runtime/db.js';

const fixtureYaml = `
list:
  name: sequence-resolution
ai:
  default_model: test/model
pipeline:
  - kind: assign
    id: route_campaign
    target: pipeline_name
    fallback: tier_a
  - kind: pipeline
    id: tier_a
    manual: true
    steps:
      - kind: wait
        id: wait_a
        after: 1d
  - kind: pipeline
    id: tier_b
    manual: true
    steps:
      - kind: wait
        id: wait_b
        after: 1d
  - kind: pipeline
    id: tier_c
    manual: true
    steps:
      - kind: wait
        id: wait_c
        after: 1d
sequences:
  default:
    steps: []
`;

const modelRoot = mkdtempSync(join(tmpdir(), 'ao-sequence-resolution-models-'));
writeFileSync(join(modelRoot, 'models.json'), JSON.stringify({
  schema_version: '1.0.0',
  providers: {
    test: { provider: 'test', models: ['model'], updated_at: '' },
  },
}));
process.env.AO_GLOBAL_ROOT = modelRoot;

const createFixtureList = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-sequence-resolution-'));
  writeFileSync(join(listDir, 'outbound.yaml'), fixtureYaml);
  writeFileSync(join(listDir, 'operator.md'), 'test');
  const db = openListDb({ listDir, readonly: false });
  const timestamp = new Date().toISOString();
  for (const pipelineName of ['tier_a', 'tier_b', 'tier_c']) {
    upsertRecord({
      db,
      row: {
        _row_id: `record_${pipelineName}`,
        business_name: `Business ${pipelineName}`,
        pipeline_name: pipelineName === 'tier_b' ? 'default' : pipelineName,
        sequence_name: pipelineName,
        sequence_status: 'active',
        account_sequence_state: 'active',
        next_action_json: '',
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
  }
  db.close();
  return listDir;
};

test('every name listed by sequence list resolves through sequence run', async () => {
  const listDir = createFixtureList();
  const { sequences } = sequencesListCommand({ list: listDir });
  assert.deepEqual(sequences, ['default', 'tier_a', 'tier_b', 'tier_c']);

  for (const sequenceName of sequences) {
    const result = await sequenceRunCommand({
      list: listDir,
      sequenceName,
      dryRun: true,
    });
    if (sequenceName === 'default') {
      assert.equal(result.dry_run, true);
      continue;
    }
    assert.equal(result.records_in_scope, 1, sequenceName);
  }
});

test('nested pipeline definitions execute through the sequence command path', async () => {
  const listDir = createFixtureList();
  const result = await sequenceRunCommand({
    list: listDir,
    sequenceName: 'tier_b',
    dryRun: true,
  });

  assert.equal(result.records_in_scope, 1);
  assert.ok(result.steps.some((step) => step.id === 'tier_b.wait_b'));
});

test('unknown sequence names return a user-facing error with valid options', () => {
  const listDir = createFixtureList();
  const run = spawnSync(process.execPath, [
    'dist/cli.js',
    'sequence',
    'run',
    listDir,
    '--sequence',
    'not_configured',
    '--dry-run',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(run.status, 1);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'NOT_FOUND');
  assert.match(payload.error.message, /Unknown sequence "not_configured"/);
  assert.match(payload.error.message, /Available sequences: default, tier_a, tier_b, tier_c/);
});
